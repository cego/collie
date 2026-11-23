// WARNING: Herdr 1 is gone from Collie: any call to it is recorded and fails the test, naming the call.
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { Effect, FileSystem } from "effect";

export interface Tripwire {
  readonly binDir: string;
  readonly bin: string;
  readonly socketPath: string;
  readonly tripped: Effect.Effect<ReadonlyArray<string>, never, FileSystem.FileSystem>;
  readonly stop: Effect.Effect<void>;
}

export const armTripwire = Effect.fn("Tripwire.arm")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const binDir = `${dir}/tripwire`;
  const log = `${binDir}/herdr-calls`;
  const bin = `${binDir}/herdr`;
  yield* fs.makeDirectory(binDir, { recursive: true }).pipe(Effect.orDie);
  yield* fs
    .writeFileString(
      bin,
      `#!/bin/sh\nprintf 'herdr %s\\n' "$*" >> '${log}'\necho 'herdr is gone: Collie must not call it' >&2\nexit 127\n`,
      { mode: 0o755 },
    )
    .pipe(Effect.orDie);
  const socketPath = `${dir}/herdr.sock`;
  const used: Array<string> = [];
  const listener = Bun.listen({
    unix: socketPath,
    socket: {
      open: () => void used.push("herdr socket opened"),
      data: (_, chunk) => void used.push(`herdr socket: ${Str.trim(String(chunk))}`),
    },
  });
  const tripped = fs.readFileString(log).pipe(
    Effect.map((text) => Arr.filter(Str.split(text, "\n"), (line) => line !== "")),
    Effect.orElseSucceed(() => []),
    Effect.map((calls) => [...calls, ...used]),
  );
  return {
    binDir,
    bin,
    socketPath,
    tripped,
    stop: Effect.sync(() => listener.stop(true)),
  } satisfies Tripwire;
});

export const untripped = (tripwire: Tripwire) =>
  Effect.flatMap(tripwire.tripped, (calls) =>
    calls.length === 0
      ? Effect.void
      : Effect.die(new Error(`Herdr 1 was called:\n${Arr.join(calls, "\n")}`)),
  );
