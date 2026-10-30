import { Cache, Context, Effect, FileSystem, Layer } from "effect";

/** Disk inputs only: clocks, engine status and rendered views are never memoized here. */
export const makeReadModel = Effect.fn("ReadModel.make")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  let revision = 0;
  let enabled = true;
  const groupOf = (path: string) => {
    if (!path.startsWith(`${dir}/`)) return null;
    const [top, run] = path.slice(dir.length + 1).split("/");
    if (top === "runs" || top === "agents" || top === "evidence")
      return run === undefined ? "shared" : `run/${run}`;
    return top === "tasks" ||
      top === "steering" ||
      top === "installation" ||
      top === "step-durations.json" ||
      top === "forge.json" ||
      top === "seen-since"
      ? "shared"
      : null;
  };
  const memo = <A, E>(read: (path: string) => Effect.Effect<A, E>) =>
    Cache.make({ capacity: 128, lookup: read });
  const groups = yield* Cache.make({
    capacity: 2_048,
    lookup: (_group: string) =>
      Effect.gen(function* () {
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
      revision++;
      if (
        path === dir ||
        path === `${dir}/runs` ||
        path === `${dir}/agents` ||
        path === `${dir}/evidence`
      )
        yield* Cache.invalidateAll(groups);
      else {
        yield* Cache.invalidate(groups, group);
        if (group !== "shared") yield* Cache.invalidate(groups, "shared");
      }
    });
  const disable = Effect.gen(function* () {
    enabled = false;
    revision++;
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
        const before = revision;
        const found = yield* cached(yield* Cache.get(groups, group)).pipe(Effect.result);
        if (before === revision) return yield* Effect.fromResult(found);
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
  return { reading, writing, invalidate, disable };
});

export class ReadModel extends Context.Service<
  ReadModel,
  Effect.Success<ReturnType<typeof makeReadModel>>
>()("collie/ReadModel") {}

export type ReadModelApi = Effect.Success<ReturnType<typeof makeReadModel>>;

export const readModelLayer = (dir: string) =>
  Layer.unwrap(
    makeReadModel(dir).pipe(
      Effect.map((model) =>
        Layer.merge(
          Layer.succeed(ReadModel, model),
          Layer.succeed(FileSystem.FileSystem, model.writing),
        ),
      ),
    ),
  );
