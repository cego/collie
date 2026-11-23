import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import type { Duration } from "effect";
import { Clock, Effect, Fiber, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { lockHolder, withLock } from "../src/lock";

export const described = (pid: number) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make("ps", ["-o", "lstart=", "-o", "args=", "-p", String(pid)], {
        stdout: "pipe",
        stderr: "ignore",
        // WARNING: lstart's width is fixed only in the C locale.
        env: { LC_ALL: "C" },
        extendEnv: true,
      }),
    );
    const out = yield* handle.stdout.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (all, chunk) => all + chunk,
      ),
    );
    const line = Str.trim(out);
    return line === ""
      ? null
      : { start: pipe_(line, Str.slice(0, 24)), command: Str.trim(pipe_(line, Str.slice(24))) };
  }).pipe(
    Effect.scoped,
    Effect.orElseSucceed(() => null),
  );

const holderLine = (lock: string) =>
  Effect.gen(function* () {
    const holder = yield* lockHolder(lock);
    if (holder === null) return "test: waiting for the suite that holds the lock to finish";
    const ps = yield* described(holder.pid);
    return ps === null
      ? `test: waiting for the suite in process ${holder.pid} to finish`
      : `test: waiting for the suite in process ${holder.pid} (${ps.command}), running since ${ps.start}`;
  });

export const elapsed = (ms: number) => {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds % 60}s`;
};

export const inTurn = <A, E, R>(
  lock: string,
  run: Effect.Effect<A, E, R>,
  say: (line: string) => Effect.Effect<void>,
  every: Duration.Input = "30 seconds",
) =>
  Effect.gen(function* () {
    const ran = run.pipe(Effect.asSome);
    const now = yield* withLock(lock, Effect.succeedNone, ran, 1);
    if (Option.isSome(now)) return now.value;
    yield* say(yield* holderLine(lock));
    const began = yield* Clock.currentTimeMillis;
    const telling = yield* Clock.currentTimeMillis.pipe(
      Effect.flatMap((at) => say(`test: still waiting, ${elapsed(at - began)} so far`)),
      Effect.delay(every),
      Effect.forever,
      Effect.forkScoped,
    );
    const quietly = Fiber.interrupt(telling).pipe(Effect.andThen(ran));
    const later = yield* withLock(lock, Effect.succeedNone, quietly, Number.MAX_SAFE_INTEGER);
    if (Option.isSome(later)) return later.value;
    return yield* Effect.die(new Error(`${lock} was never given up`));
  }).pipe(Effect.scoped);
