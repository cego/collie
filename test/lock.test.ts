import { expect, test } from "bun:test";
import { Deferred, Duration, Effect, Fiber, FileSystem, Schema, flow, Result } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { processStartTime, withLock } from "../src/lock";
import { runEffect } from "./support/effect";

const encodeClaim = flow(
  Schema.encodeResult(
    Schema.fromJsonString(
      Schema.Struct({ pid: Schema.Finite, start: Schema.NullOr(Schema.String) }),
    ),
  ),
  Result.getOrThrow,
);

test("a withLock interrupted just after its claim is written leaves no lock behind", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-lock-claimed-" });
      const lock = `${dir}/held.lock`;
      const claimed = yield* Deferred.make<void>();
      const slowClaim: FileSystem.FileSystem = {
        ...fs,
        writeFileString: (path, data, options) =>
          fs
            .writeFileString(path, data, options)
            .pipe(
              Effect.tap(() =>
                path === lock
                  ? Deferred.succeed(claimed, undefined).pipe(
                      Effect.andThen(Effect.sleep("50 millis")),
                    )
                  : Effect.void,
              ),
            ),
      };

      const holding = yield* Effect.forkChild(
        withLock(lock, Effect.void, Effect.never).pipe(
          Effect.provideService(FileSystem.FileSystem, slowClaim),
        ),
      );
      yield* Deferred.await(claimed);
      yield* Fiber.interrupt(holding);

      expect(yield* fs.exists(lock)).toBe(false);
    }),
  ));

test("a withLock waiting minutes on a live holder ends within a second of being interrupted", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-lock-waiting-" });
      const lock = `${dir}/held.lock`;
      const holder = yield* spawner.spawn(
        ChildProcess.make("sleep", ["30"], { stdout: "ignore", stderr: "ignore" }),
      );
      const start = yield* processStartTime(holder.pid);
      yield* fs.writeFileString(lock, `${encodeClaim({ pid: holder.pid, start })}\n`);

      const waiting = yield* Effect.forkChild(
        withLock(lock, Effect.void, Effect.void, Duration.minutes(5)),
      );
      yield* Effect.sleep("200 millis");
      const ended = yield* Fiber.interrupt(waiting).pipe(Effect.timeoutOption("1 second"));

      expect(ended._tag).toBe("Some");
      expect(yield* fs.readFileString(lock)).toContain(`"pid":${holder.pid}`);
    }),
  ));
