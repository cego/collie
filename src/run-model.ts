// The host's Run model (ADR-draft-a-runs-record-is-read-from-its-hosts-run-model): each
// Run's disk inputs and facts held in memory, dirtied per Run, each change numbered.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import {
  Context,
  Effect,
  FileSystem,
  Layer,
  PubSub,
  Result,
  Schema,
  Stream,
  flow,
  pipe,
} from "effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as PlatformError from "effect/PlatformError";
import type { ChildProcessSpawner } from "effect/process";
import type { RunRevision, TaskView } from "./board-model";
import { readBranchHead } from "./board";
import { shell } from "./mr";
import type { RunFacts } from "./runs";
import { StoreWrites, TaskWrites } from "./store-writes";
import { workSourceOf } from "./strategies";

/** A path under a Run's own directories, by its Run. */
const OWN_DIR = /^(?:runs|agents|evidence)\/([^/]*)/;
/** A control file beside them, `<control>.<id>`, by what follows its first dot. */
const CONTROL_FILE = /^[^/.]*\.([^/]*)$/;
/** Marks a recursive listing's key in the cache of directory listings. */
const RECURSIVE = "\0recursive";

const fingerprint = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);

/** What a Run's Task, parent, requester and plan are, each to the Runs under it. */
interface Indexes {
  readonly byTask: Map<string, Set<string>>;
  readonly byParent: Map<string, Set<string>>;
  readonly byRequester: Map<string, Set<string>>;
  readonly byPlan: Map<string, Set<string>>;
}

const keysOf = (run: RunFacts) => {
  const work = workSourceOf(run.settled);
  return {
    byTask: run.task,
    byParent: run.parent,
    byRequester: run.requestedBy?.run ?? null,
    byPlan: work?.kind === "plan-dir" ? work.value : null,
  };
};

/**
 * Reads by key, up to `capacity`, the oldest dropped first. A failure is kept as its reason's
 * data and made again when read: an Error held makes every collection of the heap slower.
 */
const kept = <A>(
  capacity: number,
  lookup: (key: string) => Effect.Effect<A, PlatformError.PlatformError>,
) => {
  type Read =
    | { readonly value: A }
    | { readonly failed: Parameters<typeof PlatformError.systemError>[0] };
  const reads = new Map<string, Read>();
  return (key: string): Effect.Effect<A, PlatformError.PlatformError> =>
    Effect.suspend(() => {
      const hit = reads.get(key);
      if (hit !== undefined)
        return "value" in hit
          ? Effect.succeed(hit.value)
          : Effect.fail(PlatformError.systemError(hit.failed));
      const keep = (read: Read) =>
        Effect.sync(() => {
          if (reads.size >= capacity) reads.delete(reads.keys().next().value!);
          reads.set(key, read);
        });
      return lookup(key).pipe(
        Effect.tap((value) => keep({ value })),
        Effect.tapError(({ reason }) =>
          reason._tag === "BadArgument"
            ? Effect.void
            : keep({
                failed: {
                  _tag: reason._tag,
                  module: reason.module,
                  method: reason.method,
                  description: reason.description,
                  syscall: reason.syscall,
                  pathOrDescriptor: reason.pathOrDescriptor,
                },
              }),
        ),
      );
    });
};

/**
 * Another model of the same state directory, on another thread: both draw revisions from
 * `counter`, in shared memory, and each is told what the other moved.
 */
export interface ModelLink {
  readonly counter: Int32Array;
  readonly epoch: string;
  /** `facts` where what moved it was the Run's files or its row. */
  readonly touched: (run: string, seq: number, facts: boolean) => void;
  readonly invalidated: (path: string) => void;
  readonly disabled: () => void;
}

export const makeRunModel = Effect.fn("RunModel.make")(function* (
  dir: string,
  installation: string,
  link?: ModelLink,
) {
  const fs = yield* FileSystem.FileSystem;
  const scope = yield* Effect.scope;
  const spawning = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
  const epoch =
    link?.epoch ?? `${installation}.${yield* (yield* SecureRandom.SecureRandom).uuidV4()}`;
  let seq = 0;
  const next = () => (link === undefined ? ++seq : Atomics.add(link.counter, 0, 1) + 1);
  let enabled = true;
  /** Bumped by every invalidation, so a read it overtook is read again. */
  let generation = 0;
  const revisions = new Map<string, number>();
  const facts = new Map<string, { readonly text: string; readonly revision: number }>();
  const cards = new Map<
    string,
    { readonly text: string; readonly seq: number; readonly from: TaskView; readonly to: TaskView }
  >();
  const indexes: Indexes = {
    byTask: new Map(),
    byParent: new Map(),
    byRequester: new Map(),
    byPlan: new Map(),
  };
  const keys = new Map<string, ReturnType<typeof keysOf>>();
  /** The revision each Run's files or row last moved at: what its facts are read at. */
  const factual = new Map<string, number>();
  const touch = (run: string, facts = false) => {
    const at = next();
    revisions.set(run, at);
    if (facts) factual.set(run, at);
    link?.touched(run, at, facts);
    return at;
  };
  const touchFacts = (run: string) => touch(run, true);
  /** The Runs whose rows were written. */
  const wrote = (runs: ReadonlyArray<string>) => {
    for (const run of runs) touchFacts(run);
  };
  /** The Tasks whose records were written, which are their Runs' as much as their own rows. */
  const wroteTasks = (tasks: ReadonlyArray<string>) => {
    for (const task of tasks) for (const run of indexes.byTask.get(task) ?? []) touchFacts(run);
  };
  /** The other model moved the Run. */
  const heard = (run: string, at: number, facts: boolean) => {
    if (at > (revisions.get(run) ?? 0)) revisions.set(run, at);
    if (facts && at > (factual.get(run) ?? 0)) factual.set(run, at);
  };

  /**
   * `run/<id>` for a path under a Run's own directories or one of its control files,
   * `<control>.<id>` beside them; `shared` for the rest of the state directory.
   */
  const underDir = Str.startsWith(`${dir}/`);
  const below = Str.slice(dir.length + 1);
  const groupOf = (path: string) => {
    if (!underDir(path)) return null;
    const rest = below(path);
    const own = OWN_DIR.exec(rest);
    if (own !== null) return `run/${own[1]}`;
    const control = CONTROL_FILE.exec(rest);
    return control !== null && revisions.has(control[1]!) ? `run/${control[1]}` : "shared";
  };
  /** Each group's reads, built when the group is first read. */
  const groups = new Map<string, ReturnType<typeof readsOf>>();
  const readsOf = (group: string) => {
    // Every Task's record is shared, so the shared group holds a file per Task.
    const capacity = group === "shared" ? 65_536 : 1_024;
    const memo = <A>(lookup: (key: string) => Effect.Effect<A, PlatformError.PlatformError>) =>
      kept(capacity, lookup);
    return {
      text: memo(fs.readFileString),
      names: memo((key: string) =>
        Str.endsWith(RECURSIVE)(key)
          ? fs.readDirectory(Str.slice(0, -RECURSIVE.length)(key), { recursive: true })
          : fs.readDirectory(key),
      ),
      exists: memo(fs.exists),
      stat: memo(fs.stat),
    };
  };
  const groupReads = (group: string) => {
    const found = groups.get(group);
    if (found !== undefined) return found;
    const made = readsOf(group);
    groups.set(group, made);
    return made;
  };
  /** Drops what is read of `path`, and moves what it moved where `moving`. */
  const drop = (path: string, moving: (run: string) => void) => {
    const group = path === dir ? "shared" : groupOf(path);
    if (group === null) return;
    generation++;
    const inside = below(path);
    if (path === dir || inside === "runs" || inside === "agents" || inside === "evidence") {
      groups.clear();
      for (const run of revisions.keys()) moving(run);
      return;
    }
    groups.delete(group);
    if (group === "shared") return;
    moving(Str.slice(4)(group));
    // A Run's directory or control file coming or going changes the listing above it.
    if (Str.split(inside, "/").length <= 2) groups.delete("shared");
  };
  const invalidate = (path: string) =>
    Effect.sync(() => {
      link?.invalidated(path);
      drop(path, touchFacts);
    });
  /** The other model invalidated `path`: what it moved, it numbered and told. */
  const forget = (path: string) => Effect.sync(() => drop(path, () => {}));
  const disable = Effect.sync(() => {
    link?.disabled();
    enabled = false;
    generation++;
    groups.clear();
  });
  const read = <A, E>(
    path: string,
    direct: Effect.Effect<A, E>,
    cached: (group: ReturnType<typeof readsOf>) => Effect.Effect<A, E>,
  ) => {
    const attempt = (): Effect.Effect<A, E> => {
      const group = groupOf(path);
      if (!enabled || group === null) return direct;
      const before = generation;
      return Effect.flatMap(Effect.exit(cached(groupReads(group))), (exit) =>
        before === generation ? exit : Effect.suspend(attempt),
      );
    };
    return Effect.suspend(attempt);
  };
  const changed = <A, E, R>(effect: Effect.Effect<A, E, R>, ...paths: ReadonlyArray<string>) => {
    const forget = Effect.forEach(paths, invalidate, { discard: true });
    return forget.pipe(Effect.andThen(effect), Effect.ensuring(forget));
  };
  const writing: FileSystem.FileSystem = {
    ...fs,
    writeFileString: (path, text, options) =>
      changed(fs.writeFileString(path, text, options), path),
    writeFile: (path, bytes, options) => changed(fs.writeFile(path, bytes, options), path),
    makeDirectory: (path, options) => changed(fs.makeDirectory(path, options), path),
    remove: (path, options) => changed(fs.remove(path, options), path),
    rename: (from, to) => changed(fs.rename(from, to), from, to),
    copy: (from, to, options) => changed(fs.copy(from, to, options), to),
    copyFile: (from, to) => changed(fs.copyFile(from, to), to),
    link: (from, to) => changed(fs.link(from, to), to),
    symlink: (from, to) => changed(fs.symlink(from, to), to),
    truncate: (path, length) => changed(fs.truncate(path, length), path),
    utimes: (path, atime, mtime) => changed(fs.utimes(path, atime, mtime), path),
    chmod: (path, mode) => changed(fs.chmod(path, mode), path),
    chown: (path, uid, gid) => changed(fs.chown(path, uid, gid), path),
    open: (path, options) =>
      options?.flag === undefined || options.flag === "r"
        ? fs.open(path, options)
        : disable.pipe(Effect.andThen(fs.open(path, options))),
  };
  /** What was read outside every Run's own directories: each path, and each directory listed. */
  const sharedRead = new Set<string>();
  const sharedListed = new Set<string>();
  const sharedTrees = new Set<string>();
  const noted = (path: string, into: Set<string>) => {
    if (groupOf(path) === "shared") into.add(path);
  };
  /** Whether a write to `path` may change what a read through `reading` found. */
  const wasRead = (path: string) => {
    if (!enabled || groupOf(path) !== "shared") return true;
    const parent = pipe(path, Str.split("/"), Arr.dropRight(1), Arr.join("/"));
    return (
      sharedRead.has(path) ||
      sharedRead.has(parent) ||
      sharedListed.has(parent) ||
      Arr.some([...sharedTrees], (tree) => Str.startsWith(`${tree}/`)(path))
    );
  };
  const reading: FileSystem.FileSystem = {
    ...writing,
    readFileString: (path, encoding) => {
      noted(path, sharedRead);
      return encoding === undefined
        ? read(path, fs.readFileString(path), (group) => group.text(path))
        : fs.readFileString(path, encoding);
    },
    readDirectory: (path, options) => {
      const recursive = options?.recursive === true;
      noted(path, recursive ? sharedTrees : sharedListed);
      const key = recursive ? `${path}${RECURSIVE}` : path;
      return read(path, fs.readDirectory(path, options), (group) => group.names(key));
    },
    exists: (path) => {
      noted(path, sharedRead);
      return read(path, fs.exists(path), (group) => group.exists(path));
    },
    stat: (path) => {
      noted(path, sharedRead);
      return read(path, fs.stat(path), (group) => group.stat(path));
    },
  };

  const index = (run: string, next: ReturnType<typeof keysOf> | undefined) => {
    const before = keys.get(run);
    for (const name of ["byTask", "byParent", "byRequester", "byPlan"] as const) {
      const was = before?.[name] ?? null;
      const now = next?.[name] ?? null;
      if (was === now) continue;
      if (was !== null) {
        const under = indexes[name].get(was);
        under?.delete(run);
        if (under?.size === 0) indexes[name].delete(was);
      }
      if (now !== null) indexes[name].set(now, (indexes[name].get(now) ?? new Set()).add(run));
    }
    if (next === undefined) keys.delete(run);
    else keys.set(run, next);
  };

  /** The facts each Run was last seen with, so the same object is not fingerprinted again. */
  const last = new Map<string, RunFacts>();
  const seen = (run: RunFacts) => {
    if (last.get(run.id) === run) return;
    last.set(run.id, run);
    const text = fingerprint(run);
    if (facts.get(run.id)?.text !== text) facts.set(run.id, { text, revision: touch(run.id) });
    index(run.id, keysOf(run));
  };
  /** Runs another model observed, indexed here without numbering them again. */
  const mirror = (runs: ReadonlyArray<RunFacts>) => {
    for (const run of runs) index(run.id, keysOf(run));
  };
  /** Runs another model observed gone. */
  const gone = (runs: ReadonlyArray<string>) => {
    for (const run of runs) {
      revisions.delete(run);
      factual.delete(run);
      index(run, undefined);
    }
  };
  /** These Runs as a read found them, the rest left as they were. */
  const note = (runs: ReadonlyArray<RunFacts>) => Effect.sync(() => Arr.forEach(runs, seen));

  /** Each Run as a build read it: one whose facts moved takes the next number, and one gone is dropped. */
  const observe = (runs: ReadonlyArray<RunFacts>) =>
    Effect.sync(() => {
      Arr.forEach(runs, seen);
      const present = new Set(Arr.map(runs, (run) => run.id));
      for (const run of facts.keys())
        if (!present.has(run)) {
          facts.delete(run);
          last.delete(run);
          revisions.delete(run);
          factual.delete(run);
          index(run, undefined);
        }
    });

  /** The Runs that share a plan with this one: the one that wrote it, and those built from it. */
  const planned = (run: string): ReadonlyArray<string> => {
    const plan = keys.get(run)?.byPlan ?? `${dir}/runs/${run}/plan`;
    const owner = /^runs\/([^/]+)\/plan$/.exec(Str.slice(dir.length + 1)(plan))?.[1];
    return [...(indexes.byPlan.get(plan) ?? []), ...(owner === undefined ? [] : [owner])];
  };

  // Unwatched, nothing says what moved: every read is a revision no reader has seen.
  const revision = (run: string): RunRevision => ({
    epoch,
    seq: enabled ? (revisions.get(run) ?? 0) : next(),
  });
  /** The revision the Run's facts read now are at; a card or a record moving it leaves this. */
  const factsAt = (run: string) => (enabled ? (factual.get(run) ?? 0) : next());
  const highest = (runs: ReadonlyArray<string>) =>
    enabled ? Math.max(0, ...Arr.map(runs, (run) => revisions.get(run) ?? 0)) : next();
  /** Source facts and files, excluding the revisions a derived card or record adds. */
  const inputsAt = (runs: ReadonlyArray<string>) =>
    enabled
      ? Math.max(
          0,
          ...Arr.map(runs, (run) => Math.max(factual.get(run) ?? 0, facts.get(run)?.revision ?? 0)),
        )
      : next();

  const records = new Map<string, { readonly text: string; readonly seq: number }>();
  /**
   * A Run's record at the highest revision of the Runs it reads. A record that moved while
   * none of them did, as one an agent or a merge request moves does, moves its own Run.
   */
  const stampRecord = (
    key: string,
    run: string,
    runs: ReadonlyArray<string>,
    text: string,
  ): RunRevision => {
    const was = records.get(key);
    if (was !== undefined && was.text !== text && highest([run, ...runs]) === was.seq) touch(run);
    const seq = highest([run, ...runs]);
    records.set(key, { text, seq });
    return { epoch, seq };
  };

  /** Each card with the highest revision of its Runs; a card that moved while none of them did moves its leading Run. */
  const stamp = (views: ReadonlyArray<TaskView>): ReadonlyArray<TaskView> =>
    Arr.map(views, (view) => {
      const was = cards.get(view.id);
      if (was?.from === view && highest(view.runs) === was.seq) return was.to;
      const { revision: _, ...card } = view;
      const text = fingerprint(card);
      if (was !== undefined && was.text !== text && highest(view.runs) === was.seq) touch(view.run);
      const at = highest(view.runs);
      const to = { ...card, revision: { epoch, seq: at } };
      cards.set(view.id, { text, seq: at, from: view, to });
      return to;
    });

  const finishes = new Map<string, number>();
  /** The revision a record first showed the Step finished at: the one given, if none before. */
  const finishedAt = (run: string, step: string, seq: number) => {
    const key = `${run}\0${step}`;
    const was = finishes.get(key);
    if (was !== undefined) return was;
    finishes.set(key, seq);
    return seq;
  };
  const unfinished = (run: string, step: string) => finishes.delete(`${run}\0${step}`);

  const heads = new Map<string, string | null>();
  /** Each watched checkout, and the Runs whose heads were read in it. */
  const readers = new Map<string, Set<string>>();
  /** The checkouts whose every watch is in place, so a head read in one stands until it moves. */
  const watching = new Set<string>();
  // The first build may read a head before the board subscribes to its changes.
  const moves = yield* PubSub.unbounded<void>({ replay: 1 });
  /** How often each watched checkout has moved. */
  const checkouts = new Map<string, number>();
  /** The checkout moved: every head read in it is read again, and its Runs take the next number. */
  const moved = (cwd: string) => {
    checkouts.set(cwd, (checkouts.get(cwd) ?? 0) + 1);
    for (const key of heads.keys()) if (Str.startsWith(`${cwd}\0`)(key)) heads.delete(key);
    for (const run of readers.get(cwd) ?? []) {
      const revision = touch(run);
      const observed = facts.get(run);
      if (observed !== undefined) facts.set(run, { ...observed, revision });
    }
    PubSub.publishUnsafe(moves, undefined);
  };
  /** The checkout's git directories, watched for its HEAD and its branches moving. */
  const watchCheckout = (cwd: string) =>
    Effect.gen(function* () {
      const said = yield* shell(
        "git",
        ["rev-parse", "--absolute-git-dir", "--git-common-dir"],
        cwd,
      );
      const [own, common] = Str.split(Str.trim(said.stdout), "\n");
      if (said.code !== 0 || own === undefined || common === undefined) return;
      const shared = Str.startsWith("/")(common) ? common : `${cwd}/${common}`;
      let ready = 0;
      const onReady = () => {
        if (++ready === 3) {
          watching.add(cwd);
          // A commit between the first head read and watch registration produced no event.
          moved(cwd);
        }
      };
      yield* Stream.mergeAll(
        [
          fs.watch(own, { onReady }),
          fs.watch(shared, { onReady }),
          fs.watch(`${shared}/refs`, { recursive: true, onReady }),
        ],
        { concurrency: "unbounded" },
      ).pipe(Stream.runForEach(() => Effect.sync(() => moved(cwd))));
    }).pipe(
      Effect.ignore,
      Effect.ensuring(
        Effect.sync(() => {
          readers.delete(cwd);
          watching.delete(cwd);
        }),
      ),
      Effect.provideContext(spawning),
    );
  const watch = (run: RunFacts) =>
    Effect.gen(function* () {
      const watched = readers.get(run.cwd);
      if (watched === undefined) {
        readers.set(run.cwd, new Set([run.id]));
        // ponytail: watched for the host's life once read; drop on retirement if checkouts pile up.
        yield* Effect.forkIn(watchCheckout(run.cwd), scope);
      } else watched.add(run.id);
    });
  /** How often the Run's checkout has moved since it was first watched. */
  const checkout = (run: RunFacts) => Effect.map(watch(run), () => checkouts.get(run.cwd) ?? 0);
  const head = (run: RunFacts) =>
    Effect.gen(function* () {
      const key = `${run.cwd}\0${run.branch}`;
      yield* watch(run);
      if (heads.has(key)) return heads.get(key) ?? null;
      const watched = watching.has(run.cwd);
      const at = checkouts.get(run.cwd) ?? 0;
      const read = yield* readBranchHead(run).pipe(Effect.orElseSucceed(() => null));
      // A checkout that moved while its head was read may have moved after git read it: kept,
      // that head would stand until the next move, and the board would never show this one.
      if (watched && (checkouts.get(run.cwd) ?? 0) === at) heads.set(key, read);
      return read;
    }).pipe(Effect.provideContext(spawning));

  return {
    epoch,
    reading,
    writing,
    invalidate,
    wasRead,
    forget,
    heard,
    wrote,
    wroteTasks,
    disable,
    observe,
    note,
    mirror,
    gone,
    revision,
    factsAt,
    inputsAt,
    highest,
    stamp,
    stampRecord,
    finishedAt,
    unfinished,
    planned,
    head,
    checkout,
    /** Each time a watched checkout moved. */
    moved: Stream.fromPubSub(moves),
    indexes: (): Indexes => indexes,
  };
});

export type RunModelApi = Effect.Success<ReturnType<typeof makeRunModel>>;

export class RunModel extends Context.Service<RunModel, RunModelApi>()("collie/RunModel") {}

/** The model, and every write under the state directory made through it. */
export const runModelLayer = (dir: string, installation: string, link?: ModelLink) =>
  Layer.unwrap(
    makeRunModel(dir, installation, link).pipe(
      Effect.map((model) =>
        Layer.mergeAll(
          Layer.succeed(RunModel, model),
          Layer.succeed(FileSystem.FileSystem, model.writing),
          Layer.succeed(StoreWrites, model.wrote),
          Layer.succeed(TaskWrites, model.wroteTasks),
        ),
      ),
    ),
  );
