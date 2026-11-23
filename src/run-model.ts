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
import type { TaskView } from "./board-model";
import type { RunFacts } from "./runs";
import { StoreWrites, TaskWrites } from "./store-writes";
import { workSourceOf } from "./strategies";

const OWN_DIR = /^(?:runs|agents|evidence)\/([^/]*)/;
// WARNING: NUL cannot appear in a path, so this key never collides with one.
const RECURSIVE = "\0recursive";

const fingerprint = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);

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

// WARNING: keep a failure as its reason's data, not an Error: a held Error slows every heap collection.
const kept = <A>(
  capacity: number,
  lookup: (key: string) => Effect.Effect<A, PlatformError.PlatformError>,
) => {
  type Read =
    | { readonly value: A }
    | { readonly failed: Parameters<typeof PlatformError.systemError>[0] };
  const reads = new Map<string, Read>();
  return (key: string) =>
    Effect.suspend(() => {
      const hit = reads.get(key);
      if (hit !== undefined) {
        return "value" in hit
          ? Effect.succeed(hit.value)
          : Effect.fail(PlatformError.systemError(hit.failed));
      }
      const keep = (read: Read) =>
        Effect.sync(() => {
          if (reads.size >= capacity) {
            reads.delete(reads.keys().next().value!);
          }
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

// WARNING: both models draw revisions from one shared counter, and each is told what the other moved.
export interface ModelLink {
  readonly counter: Int32Array;
  readonly epoch: string;
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
  const epoch =
    link?.epoch ?? `${installation}.${yield* (yield* SecureRandom.SecureRandom).uuidV4()}`;
  let seq = 0;
  const next = () => (link === undefined ? ++seq : Atomics.add(link.counter, 0, 1) + 1);
  let enabled = true;
  // WARNING: bumped by every invalidation, so a read it overtook is read again.
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
  const factual = new Map<string, number>();
  const touch = (run: string, facts = false) => {
    const at = next();
    revisions.set(run, at);
    if (facts) {
      factual.set(run, at);
    }
    link?.touched(run, at, facts);
    return at;
  };
  const touchFacts = (run: string) => touch(run, true);
  const changes = yield* PubSub.sliding<void>(1);
  const wrote = (runs: ReadonlyArray<string>) => {
    for (const run of runs) {
      touchFacts(run);
    }
    PubSub.publishUnsafe(changes, undefined);
  };
  // WARNING: a Task's records are its Runs' as much as its own rows, so both are invalidated.
  const wroteTasks = (tasks: ReadonlyArray<string>) => {
    for (const task of tasks) {
      for (const run of indexes.byTask.get(task) ?? []) {
        touchFacts(run);
      }
    }
    PubSub.publishUnsafe(changes, undefined);
  };
  const heard = (run: string, at: number, facts: boolean) => {
    if (at > (revisions.get(run) ?? 0)) {
      revisions.set(run, at);
    }
    if (facts && at > (factual.get(run) ?? 0)) {
      factual.set(run, at);
    }
  };

  const underDir = Str.startsWith(`${dir}/`);
  const below = Str.slice(dir.length + 1);
  const groupOf = (path: string) => {
    if (!underDir(path)) {
      return null;
    }
    const rest = below(path);
    const own = OWN_DIR.exec(rest);
    return own !== null ? `run/${own[1]}` : "shared";
  };
  const groups = new Map<string, ReturnType<typeof readsOf>>();
  const readsOf = (group: string) => {
    // WARNING: the shared group holds a file per Task, so it needs the larger bound.
    const capacity = group === "shared" ? 65_536 : 1024;
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
    if (found !== undefined) {
      return found;
    }
    const made = readsOf(group);
    groups.set(group, made);
    return made;
  };
  const drop = (path: string, moving: (run: string) => void) => {
    const group = path === dir ? "shared" : groupOf(path);
    if (group === null) {
      return;
    }
    generation++;
    const inside = below(path);
    if (path === dir || inside === "runs" || inside === "agents" || inside === "evidence") {
      groups.clear();
      for (const run of revisions.keys()) {
        moving(run);
      }
      return;
    }
    groups.delete(group);
    if (group === "shared") {
      return;
    }
    moving(Str.slice(4)(group));
    // WARNING: a Run's directory or control file coming or going changes the listing above it.
    if (Str.split(inside, "/").length <= 2) {
      groups.delete("shared");
    }
  };
  const invalidate = (path: string) =>
    Effect.sync(() => {
      link?.invalidated(path);
      drop(path, touchFacts);
      PubSub.publishUnsafe(changes, undefined);
    });
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
    const attempt: () => Effect.Effect<A, E> = () => {
      const group = groupOf(path);
      if (!enabled || group === null) {
        return direct;
      }
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
  const sharedRead = new Set<string>();
  const sharedListed = new Set<string>();
  const sharedTrees = new Set<string>();
  const noted = (path: string, into: Set<string>) => {
    if (groupOf(path) === "shared") {
      into.add(path);
    }
  };
  const wasRead = (path: string) => {
    if (!enabled || groupOf(path) !== "shared") {
      return true;
    }
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
      if (was === now) {
        continue;
      }
      if (was !== null) {
        const under = indexes[name].get(was);
        under?.delete(run);
        if (under?.size === 0) {
          indexes[name].delete(was);
        }
      }
      if (now !== null) {
        indexes[name].set(now, (indexes[name].get(now) ?? new Set()).add(run));
      }
    }
    if (next === undefined) {
      keys.delete(run);
    } else {
      keys.set(run, next);
    }
  };

  const last = new Map<string, RunFacts>();
  const seen = (run: RunFacts) => {
    if (last.get(run.id) === run) {
      return;
    }
    last.set(run.id, run);
    const text = fingerprint(run);
    if (facts.get(run.id)?.text !== text) {
      facts.set(run.id, { text, revision: touch(run.id) });
    }
    index(run.id, keysOf(run));
  };
  const mirror = (runs: ReadonlyArray<RunFacts>) => {
    for (const run of runs) {
      index(run.id, keysOf(run));
    }
  };
  const gone = (runs: ReadonlyArray<string>) => {
    for (const run of runs) {
      revisions.delete(run);
      factual.delete(run);
      index(run, undefined);
    }
  };
  const note = (runs: ReadonlyArray<RunFacts>) => Effect.sync(() => Arr.forEach(runs, seen));

  const observe = (runs: ReadonlyArray<RunFacts>) =>
    Effect.sync(() => {
      Arr.forEach(runs, seen);
      const present = new Set(Arr.map(runs, (run) => run.id));
      for (const run of facts.keys()) {
        if (!present.has(run)) {
          facts.delete(run);
          hashes.delete(run);
          last.delete(run);
          revisions.delete(run);
          factual.delete(run);
          index(run, undefined);
        }
      }
    });

  const planned = (run: string) => {
    const plan = keys.get(run)?.byPlan ?? `${dir}/runs/${run}/plan`;
    const owner = /^runs\/([^/]+)\/plan$/.exec(Str.slice(dir.length + 1)(plan))?.[1];
    return [...(indexes.byPlan.get(plan) ?? []), ...(owner === undefined ? [] : [owner])];
  };

  // WARNING: unwatched, nothing says what moved, so every read is a revision no reader has seen.
  const revision = (run: string) => ({
    epoch,
    seq: enabled ? (revisions.get(run) ?? 0) : next(),
  });
  const factsAt = (run: string) => (enabled ? (factual.get(run) ?? 0) : next());
  const highest = (runs: ReadonlyArray<string>) =>
    enabled ? Math.max(0, ...Arr.map(runs, (run) => revisions.get(run) ?? 0)) : next();
  const inputsAt = (runs: ReadonlyArray<string>) =>
    enabled
      ? Math.max(
          0,
          ...Arr.map(runs, (run) => Math.max(factual.get(run) ?? 0, facts.get(run)?.revision ?? 0)),
        )
      : next();

  const hashes = new Map<string, { readonly text: string; readonly hash: string }>();
  // WARNING: by content, not revision, so a later host can compare.
  const content = (runs: ReadonlyArray<string>) =>
    Arr.join(
      Arr.map(runs, (run) => {
        const text = facts.get(run)?.text;
        if (text === undefined) {
          return "";
        }
        const known = hashes.get(run);
        if (known?.text === text) {
          return known.hash;
        }
        const hash = Bun.hash(text).toString(36);
        hashes.set(run, { text, hash });
        return hash;
      }),
      ",",
    );

  const records = new Map<string, { readonly text: string; readonly seq: number }>();
  // WARNING: a record that moved while none of its Runs did moves its own Run, as an agent's or merge request's does.
  const stampRecord = (key: string, run: string, runs: ReadonlyArray<string>, text: string) => {
    const was = records.get(key);
    if (was !== undefined && was.text !== text && highest([run, ...runs]) === was.seq) {
      touch(run);
    }
    const seq = highest([run, ...runs]);
    records.set(key, { text, seq });
    return { epoch, seq };
  };

  const stamp = (views: ReadonlyArray<TaskView>) =>
    Arr.map(views, (view) => {
      const was = cards.get(view.id);
      if (was?.from === view && highest(view.runs) === was.seq) {
        return was.to;
      }
      const { revision: _, ...card } = view;
      const text = fingerprint(card);
      if (was !== undefined && was.text !== text && highest(view.runs) === was.seq) {
        touch(view.run);
      }
      const at = highest(view.runs);
      const to = { ...card, revision: { epoch, seq: at } };
      cards.set(view.id, { text, seq: at, from: view, to });
      return to;
    });

  const finishes = new Map<string, number>();
  const finishedAt = (run: string, step: string, seq: number) => {
    const key = `${run}\0${step}`;
    const was = finishes.get(key);
    if (was !== undefined) {
      return was;
    }
    finishes.set(key, seq);
    return seq;
  };
  const unfinished = (run: string, step: string) => finishes.delete(`${run}\0${step}`);

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
    content,
    highest,
    stamp,
    stampRecord,
    finishedAt,
    unfinished,
    planned,
    indexes: () => indexes,
    changed: Stream.fromPubSub(changes),
  };
});

export type RunModelApi = Effect.Success<ReturnType<typeof makeRunModel>>;

export class RunModel extends Context.Service<RunModel, RunModelApi>()("collie/RunModel") {}

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
