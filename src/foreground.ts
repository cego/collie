// WARNING: a held pass waits no longer than the background work it ran since its last hold, so answers cannot starve it.
import { Channel, Clock, Context, Effect, Fiber, FileSystem, Latch, Layer, Stream } from "effect";

export const PATIENCE = "250 millis";
const PATIENCE_MS = 250;
const SLICE_MS = 10;

export interface ForegroundApi {
  readonly serve: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly wait: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly boundary: Effect.Effect<void>;
}

export const Foreground = Context.Reference<ForegroundApi>("collie/Foreground", {
  defaultValue: () => ({
    serve: (effect) => effect,
    wait: (effect) => effect,
    boundary: Effect.yieldNow,
  }),
});

const active = new WeakSet<ForegroundApi>();
const held = new WeakSet<ForegroundApi>();
const live = new WeakSet<ForegroundApi>();

interface ServingLease extends ForegroundApi {
  readonly io: ForegroundApi["wait"];
}

// WARNING: a captured host context must not replace a live lease.
const Serving = Context.Reference<ServingLease | null>("collie/ForegroundLease", {
  defaultValue: () => null,
});

export const servedNow = () => {
  const foreground = Fiber.getCurrent()?.getRef(Serving);
  return foreground ? active.has(foreground) : false;
};

export const waitingForIO: ForegroundApi["wait"] = (effect) =>
  Effect.flatMap(Serving, (lease) =>
    lease !== null && live.has(lease) ? lease.io(effect) : effect,
  );

// WARNING: wrap the file system before any host component captures it.
export const foregroundFileSystem = (fs: FileSystem.FileSystem) => {
  const operation =
    <Self, Args extends Array<unknown>, A, E, R>(
      self: Self,
      method: (this: Self, ...args: Args) => Effect.Effect<A, E, R>,
    ) =>
    (...args: Args) =>
      waitingForIO(method.apply(self, args));
  const file: (handle: FileSystem.File) => FileSystem.File = (handle) => ({
    [FileSystem.FileTypeId]: FileSystem.FileTypeId,
    stat: waitingForIO(handle.stat),
    sync: waitingForIO(handle.sync),
    seek: operation(handle, handle.seek),
    read: operation(handle, handle.read),
    readAlloc: operation(handle, handle.readAlloc),
    truncate: operation(handle, handle.truncate),
    write: operation(handle, handle.write),
    writeAll: operation(handle, handle.writeAll),
  });
  const physical = FileSystem.make({
    access: operation(fs, fs.access),
    copy: operation(fs, fs.copy),
    copyFile: operation(fs, fs.copyFile),
    chmod: operation(fs, fs.chmod),
    chown: operation(fs, fs.chown),
    link: operation(fs, fs.link),
    lstat: operation(fs, fs.lstat),
    makeDirectory: operation(fs, fs.makeDirectory),
    makeTempDirectory: operation(fs, fs.makeTempDirectory),
    makeTempDirectoryScoped: operation(fs, fs.makeTempDirectoryScoped),
    makeTempFile: operation(fs, fs.makeTempFile),
    makeTempFileScoped: operation(fs, fs.makeTempFileScoped),
    open: (...args) => waitingForIO(Effect.map(fs.open(...args), file)),
    readDirectory: operation(fs, fs.readDirectory),
    readDirectoryEntries: operation(fs, fs.readDirectoryEntries),
    readFile: operation(fs, fs.readFile),
    readLink: operation(fs, fs.readLink),
    realPath: operation(fs, fs.realPath),
    remove: operation(fs, fs.remove),
    rename: operation(fs, fs.rename),
    stat: operation(fs, fs.stat),
    symlink: operation(fs, fs.symlink),
    truncate: operation(fs, fs.truncate),
    utimes: operation(fs, fs.utimes),
    watch: (...args) =>
      Stream.fromChannel(
        Channel.fromTransform((_, scope) =>
          waitingForIO(
            Effect.map(Channel.toPullScoped(fs.watch(...args).channel, scope), waitingForIO),
          ),
        ),
      ),
    writeFile: operation(fs, fs.writeFile),
  });
  return {
    ...physical,
    exists: operation(fs, fs.exists),
    glob: operation(fs, fs.glob),
    readFileString: operation(fs, fs.readFileString),
    writeFileString: operation(fs, fs.writeFileString),
  };
};

export const makeForeground = Effect.gen(function* () {
  const idle = yield* Latch.make(true);
  let serving = 0;
  let resumed = -Infinity;
  const hold = (lease: ForegroundApi) => {
    if (!live.has(lease) || held.has(lease)) {
      return Effect.void;
    }
    held.add(lease);
    return ++serving === 1 ? idle.close : Effect.void;
  };
  const release = (lease: ForegroundApi) => {
    if (!held.delete(lease)) {
      return Effect.void;
    }
    return --serving === 0 ? idle.open : Effect.void;
  };
  const foreground: ForegroundApi = {
    serve: (effect) =>
      Effect.flatMap(Serving, (lease) =>
        lease !== null && live.has(lease)
          ? effect
          : Effect.acquireUseRelease(
              Effect.suspend(() => {
                let waiting = 0;
                let dependencies = 0;
                const pause = <A, E, R>(effect: Effect.Effect<A, E, R>, priority = true) =>
                  Effect.acquireUseRelease(
                    Effect.suspend(() => {
                      waiting++;
                      if (!priority) {
                        dependencies++;
                        active.delete(served);
                      }
                      return release(served);
                    }),
                    () => effect,
                    () =>
                      Effect.suspend(() => {
                        if (!priority && --dependencies === 0 && live.has(served)) {
                          active.add(served);
                        }
                        return --waiting === 0 ? hold(served) : Effect.void;
                      }),
                  );
                const served: ServingLease = {
                  serve: (effect) => (live.has(served) ? effect : foreground.serve(effect)),
                  wait: (effect) => pause(Effect.provideService(effect, Serving, null), false),
                  io: pause,
                  boundary: Effect.suspend(() =>
                    active.has(served) ? Effect.void : foreground.boundary,
                  ),
                };
                live.add(served);
                active.add(served);
                return hold(served).pipe(Effect.as(served));
              }),
              (served) =>
                effect.pipe(
                  Effect.provideService(Foreground, served),
                  Effect.provideService(Serving, served),
                ),
              (served) =>
                Effect.suspend(() => {
                  live.delete(served);
                  active.delete(served);
                  return release(served);
                }),
            ),
      ),
    wait: (effect) =>
      Effect.flatMap(Serving, (lease) =>
        lease !== null && live.has(lease) ? lease.wait(effect) : effect,
      ),
    boundary: Effect.suspend(() => {
      if (servedNow()) {
        return Effect.void;
      }
      if (serving === 0) {
        return Effect.yieldNow;
      }
      return Effect.flatMap(Clock.currentTimeMillis, (now) => {
        const worked = now - resumed;
        if (worked < SLICE_MS) {
          return Effect.yieldNow;
        }
        const share = Math.min(PATIENCE_MS, worked);
        return Effect.andThen(
          Effect.yieldNow,
          idle.await.pipe(
            Effect.timeoutOption(share),
            Effect.andThen(Clock.currentTimeMillis),
            Effect.map((at) => {
              resumed = at;
            }),
          ),
        );
      });
    }),
  };
  return foreground;
});

export const foregroundLayer = Layer.effect(Foreground, makeForeground);
