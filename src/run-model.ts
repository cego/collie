// The host's Run model (ADR-draft-a-runs-record-is-read-from-its-hosts-run-model): each
// Run's disk inputs and facts held in memory, dirtied per Run, each change numbered.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import {
  Cache,
  Context,
  Effect,
  FileSystem,
  Layer,
  PubSub,
  Result,
  Schema,
  Stream,
  flow,
} from "effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import type { ChildProcessSpawner } from "effect/process";
import type { RunRevision, TaskView } from "./board-model";
import { readBranchHead } from "./board";
import { shell } from "./mr";
import type { RunFacts } from "./runs";
import { workSourceOf } from "./strategies";

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

export const makeRunModel = Effect.fn("RunModel.make")(function* (
  dir: string,
  installation: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const scope = yield* Effect.scope;
  const spawning = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
  const epoch = `${installation}.${yield* (yield* SecureRandom.SecureRandom).uuidV4()}`;
  let seq = 0;
  let enabled = true;
  /** Bumped by every invalidation, so a read it overtook is read again. */
  let generation = 0;
  const revisions = new Map<string, number>();
  const facts = new Map<string, string>();
  const cards = new Map<string, { readonly text: string; readonly seq: number }>();
  const indexes: Indexes = {
    byTask: new Map(),
    byParent: new Map(),
    byRequester: new Map(),
    byPlan: new Map(),
  };
  const keys = new Map<string, ReturnType<typeof keysOf>>();
  const touch = (run: string) => revisions.set(run, ++seq);

  /** `run/<id>` for a path under a Run's own directories, `shared` for the rest of the state directory. */
  const groupOf = (path: string) => {
    if (!Str.startsWith(`${dir}/`)(path)) return null;
    const [top, run] = Str.split(Str.slice(dir.length + 1)(path), "/");
    return (top === "runs" || top === "agents" || top === "evidence") && run !== undefined
      ? `run/${run}`
      : "shared";
  };
  const groups = yield* Cache.make({
    capacity: 4_096,
    lookup: (group: string) =>
      Effect.gen(function* () {
        // Every Task's record is shared, so the shared group holds a file per Task.
        const capacity = group === "shared" ? 65_536 : 1_024;
        const memo = <A, E>(lookup: (path: string) => Effect.Effect<A, E>) =>
          Cache.make({ capacity, lookup });
        return {
          text: yield* memo(fs.readFileString),
          names: yield* memo(fs.readDirectory),
          exists: yield* memo(fs.exists),
          stat: yield* memo(fs.stat),
        };
      }),
  });
  const invalidate = (path: string) =>
    Effect.gen(function* () {
      const group = path === dir ? "shared" : groupOf(path);
      if (group === null) return;
      generation++;
      const below = Str.slice(dir.length + 1)(path);
      if (path === dir || below === "runs" || below === "agents" || below === "evidence") {
        yield* Cache.invalidateAll(groups);
        for (const run of revisions.keys()) touch(run);
        return;
      }
      yield* Cache.invalidate(groups, group);
      if (group === "shared") {
        // A Task's record is its Runs' as much as their own files are.
        const [top, name] = Str.split(below, "/");
        const task = top === "tasks" ? Str.replace(/\.json$/, "")(name ?? "") : "";
        for (const run of indexes.byTask.get(task) ?? []) touch(run);
        return;
      }
      const run = Str.slice(4)(group);
      touch(run);
      // A Run's directory coming or going changes the listing its parent directory gives.
      if (Str.split(below, "/").length === 2) yield* Cache.invalidate(groups, "shared");
    });
  const disable = Effect.gen(function* () {
    enabled = false;
    generation++;
    yield* Cache.invalidateAll(groups);
  });
  const read = <A, E>(
    path: string,
    direct: Effect.Effect<A, E>,
    cached: (group: Effect.Success<ReturnType<typeof groups.lookup>>) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const group = groupOf(path);
      if (!enabled || group === null) return yield* direct;
      for (;;) {
        const before = generation;
        const found = yield* cached(yield* Cache.get(groups, group)).pipe(Effect.result);
        if (before === generation) return yield* Effect.fromResult(found);
        if (!enabled) return yield* direct;
      }
    });
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
  const reading: FileSystem.FileSystem = {
    ...writing,
    readFileString: (path, encoding) =>
      encoding === undefined
        ? read(path, fs.readFileString(path), (group) => Cache.get(group.text, path))
        : fs.readFileString(path, encoding),
    readDirectory: (path, options) =>
      options === undefined
        ? read(path, fs.readDirectory(path), (group) => Cache.get(group.names, path))
        : fs.readDirectory(path, options),
    exists: (path) => read(path, fs.exists(path), (group) => Cache.get(group.exists, path)),
    stat: (path) => read(path, fs.stat(path), (group) => Cache.get(group.stat, path)),
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

  /** Each Run as a build read it: one whose facts moved takes the next number, and one gone is dropped. */
  const observe = (runs: ReadonlyArray<RunFacts>) =>
    Effect.sync(() => {
      const present = new Set<string>();
      for (const run of runs) {
        present.add(run.id);
        const text = fingerprint(run);
        if (facts.get(run.id) !== text) {
          facts.set(run.id, text);
          touch(run.id);
        }
        index(run.id, keysOf(run));
      }
      for (const run of facts.keys())
        if (!present.has(run)) {
          facts.delete(run);
          revisions.delete(run);
          index(run, undefined);
        }
    });

  const revision = (run: string): RunRevision => ({ epoch, seq: revisions.get(run) ?? 0 });

  /** Each card with the highest revision of its Runs; a card that moved while none of them did moves its leading Run. */
  const stamp = (views: ReadonlyArray<TaskView>): ReadonlyArray<TaskView> =>
    Arr.map(views, (view) => {
      const { revision: _, ...card } = view;
      const highest = () => Math.max(0, ...Arr.map(view.runs, (run) => revisions.get(run) ?? 0));
      const text = fingerprint(card);
      const was = cards.get(view.id);
      if (was !== undefined && was.text !== text && highest() === was.seq) touch(view.run);
      const at = highest();
      cards.set(view.id, { text, seq: at });
      return { ...card, revision: { epoch, seq: at } };
    });

  const heads = new Map<string, string | null>();
  /** Each watched checkout, and the Runs whose heads were read in it. */
  const readers = new Map<string, Set<string>>();
  const moves = yield* PubSub.unbounded<void>();
  /** The checkout moved: every head read in it is read again, and its Runs take the next number. */
  const moved = (cwd: string) =>
    Effect.gen(function* () {
      for (const key of heads.keys()) if (Str.startsWith(`${cwd}\0`)(key)) heads.delete(key);
      for (const run of readers.get(cwd) ?? []) touch(run);
      yield* PubSub.publish(moves, undefined);
    });
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
      yield* Stream.mergeAll(
        [fs.watch(own), fs.watch(shared), fs.watch(`${shared}/refs`, { recursive: true })],
        { concurrency: "unbounded" },
      ).pipe(Stream.runForEach(() => moved(cwd)));
    }).pipe(
      Effect.ignore,
      Effect.ensuring(Effect.sync(() => readers.delete(cwd))),
      Effect.provideContext(spawning),
    );
  const head = (run: RunFacts) =>
    Effect.gen(function* () {
      const key = `${run.cwd}\0${run.branch}`;
      const watched = readers.get(run.cwd);
      if (watched === undefined) {
        readers.set(run.cwd, new Set([run.id]));
        // ponytail: watched for the host's life once read; drop on retirement if checkouts pile up.
        yield* Effect.forkIn(watchCheckout(run.cwd), scope);
      } else watched.add(run.id);
      if (heads.has(key)) return heads.get(key) ?? null;
      const read = yield* readBranchHead(run).pipe(Effect.orElseSucceed(() => null));
      heads.set(key, read);
      return read;
    }).pipe(Effect.provideContext(spawning));

  return {
    epoch,
    reading,
    writing,
    invalidate,
    disable,
    observe,
    revision,
    stamp,
    head,
    /** Each time a watched checkout moved. */
    moved: Stream.fromPubSub(moves),
    indexes: (): Indexes => indexes,
  };
});

export type RunModelApi = Effect.Success<ReturnType<typeof makeRunModel>>;

export class RunModel extends Context.Service<RunModel, RunModelApi>()("collie/RunModel") {}

/** The model, and every write under the state directory made through it. */
export const runModelLayer = (dir: string, installation: string) =>
  Layer.unwrap(
    makeRunModel(dir, installation).pipe(
      Effect.map((model) =>
        Layer.merge(
          Layer.succeed(RunModel, model),
          Layer.succeed(FileSystem.FileSystem, model.writing),
        ),
      ),
    ),
  );
