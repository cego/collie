import { Context, Effect, FileSystem, Layer, PlatformError } from "effect";

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
  // Plain maps: an Effect Cache entry keeps the fiber that filled it.
  const recent = <A>(capacity: number) => {
    const kept = new Map<string, A>();
    return {
      get: (key: string) => {
        const found = kept.get(key);
        if (found === undefined) return undefined;
        kept.delete(key);
        kept.set(key, found);
        return found;
      },
      set: (key: string, value: A) => {
        kept.delete(key);
        kept.set(key, value);
        if (kept.size > capacity) kept.delete(kept.keys().next().value!);
      },
      delete: (key: string) => kept.delete(key),
      clear: () => kept.clear(),
    };
  };
  // A failed read keeps its fields, not the error: that carries the stack of the native one.
  const stackless = (failed: Parameters<typeof PlatformError.systemError>[0]) => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 0;
    try {
      return PlatformError.systemError(failed);
    } finally {
      Error.stackTraceLimit = limit;
    }
  };
  const memo = <A>(read: (path: string) => Effect.Effect<A, PlatformError.PlatformError>) => {
    const kept = recent<
      { readonly value: A } | { readonly failed: Parameters<typeof PlatformError.systemError>[0] }
    >(128);
    return {
      hit: (path: string): Effect.Effect<A, PlatformError.PlatformError> | undefined => {
        const found = kept.get(path);
        if (found === undefined) return undefined;
        return "value" in found
          ? Effect.succeed(found.value)
          : Effect.fail(stackless(found.failed));
      },
      fill: (path: string) =>
        read(path).pipe(
          Effect.tap((value) => Effect.sync(() => kept.set(path, { value }))),
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (error.reason._tag === "BadArgument") return;
              const { _tag, module, method, description, syscall, pathOrDescriptor } = error.reason;
              kept.set(path, {
                failed: { _tag, module, method, description, syscall, pathOrDescriptor },
              });
            }),
          ),
        ),
    };
  };
  const groupFor = () => ({
    text: memo(fs.readFileString),
    names: memo(fs.readDirectory),
    exists: memo(fs.exists),
    stat: memo(fs.stat),
  });
  const groups = recent<ReturnType<typeof groupFor>>(2_048);
  const groupOfKey = (group: string) => {
    const found = groups.get(group);
    if (found !== undefined) return found;
    const made = groupFor();
    groups.set(group, made);
    return made;
  };
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
        groups.clear();
      else {
        groups.delete(group);
        if (group !== "shared") groups.delete("shared");
      }
    });
  const disable = Effect.gen(function* () {
    enabled = false;
    revision++;
    groups.clear();
  });
  const read = <A>(
    path: string,
    direct: Effect.Effect<A, PlatformError.PlatformError>,
    kind: (group: ReturnType<typeof groupFor>) => ReturnType<typeof memo<A>>,
  ): Effect.Effect<A, PlatformError.PlatformError> =>
    Effect.suspend(() => {
      const group = enabled ? groupOf(path) : null;
      if (group === null) return direct;
      const memo = kind(groupOfKey(group));
      const before = revision;
      return (
        memo.hit(path) ??
        memo.fill(path).pipe(
          Effect.result,
          Effect.flatMap((found) =>
            before === revision ? Effect.fromResult(found) : read(path, direct, kind),
          ),
        )
      );
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
        ? read(path, fs.readFileString(path), (group) => group.text)
        : fs.readFileString(path, encoding),
    readDirectory: (path, options) =>
      options === undefined
        ? read(path, fs.readDirectory(path), (group) => group.names)
        : fs.readDirectory(path, options),
    exists: (path) => read(path, fs.exists(path), (group) => group.exists),
    stat: (path) => read(path, fs.stat(path), (group) => group.stat),
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
