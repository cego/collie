import { Effect, Option, Path, pipe } from "effect";
import * as Str from "effect/String";
import { ensureLockDir, lockHolder, withLock } from "../../src/lock";
import { processOf } from "../../src/processes";

export const userStateDir = (home: string, env: Readonly<Record<string, string | undefined>>) =>
  env.COLLIE_STATE_DIR ?? `${home}/.local/state/herdr/plugins/cego.collie`;

export const refusal = Effect.fnUntraced(function* (
  ours: { readonly state: string; readonly socket: string },
  user: { readonly home: string; readonly env: Readonly<Record<string, string | undefined>> },
) {
  const { resolve } = yield* Path.Path;
  const state = resolve(userStateDir(user.home, user.env));
  if (resolve(ours.state) === state)
    return `${ours.state} is the user's own state directory; the benchmark runs a host of its own`;
  if (resolve(ours.socket) === resolve(`${state}/host.sock`))
    return `${ours.socket} is the user's own host socket; the benchmark runs a host of its own`;
  return null;
});

const parentOf = (pid: number) => Effect.map(processOf(pid), (one) => one?.parent ?? 0);

const ancestorsOf = Effect.fnUntraced(function* (pid: number) {
  const found: number[] = [];
  for (let at = yield* parentOf(pid); at > 1; at = yield* parentOf(at)) found.push(at);
  return found;
});

export const measuring = <A, E, R>(
  lock: string,
  say: (line: string) => Effect.Effect<void>,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const holder = yield* lockHolder(lock);
    if (holder !== null && (yield* ancestorsOf(process.pid)).includes(holder.pid))
      return yield* effect;
    yield* Effect.orDie(ensureLockDir(lock));
    let told = false;
    for (;;) {
      const done = yield* withLock(lock, Effect.succeedNone, Effect.asSome(effect), 1).pipe(
        Effect.catchTag("PlatformError", Effect.die),
      );
      if (Option.isSome(done)) return done.value;
      if (!told) {
        told = true;
        const other = yield* lockHolder(lock);
        yield* say(
          `waiting: process ${other?.pid ?? "unknown"} holds the Machine Measurement lock ${lock}`,
        );
      }
      yield* Effect.sleep("1 second");
    }
  });

export const filledSinceStart = (log: string) =>
  Option.match(pipe(log, Str.lastIndexOf(" host started, pid ")), {
    onNone: () => false,
    onSome: (since) => pipe(log, Str.slice(since), Str.includes("the Run model holds")),
  });
