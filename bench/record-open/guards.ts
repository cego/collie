// What keeps the benchmark off the human's own host and out of another Measurement's way.

import { Effect, FileSystem, Option, Path } from "effect";
import * as Str from "effect/String";
import { ensureLockDir, lockHolder, withLock } from "../../src/lock";

/** The state directory a host uses when nothing names another. */
export const userStateDir = (home: string, env: Readonly<Record<string, string | undefined>>) =>
  env.HERDR_PLUGIN_STATE_DIR ?? `${home}/.local/state/herdr/plugins/cego.collie`;

/** Why the benchmark may not run its host there, or null where it may. */
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

// ponytail: reads /proc, so a Measurement is recognised on Linux only.
const parentOf = (pid: number) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(`/proc/${pid}/stat`)).pipe(
    // The fields after the command's closing parenthesis: state, then the parent's pid.
    Effect.map((stat) =>
      Number(
        Str.split(
          Str.slice(Option.getOrElse(Str.lastIndexOf(")")(stat), () => -2) + 2)(stat),
          " ",
        )[1],
      ),
    ),
    Effect.orElseSucceed(() => 0),
  );

const ancestorsOf = Effect.fnUntraced(function* (pid: number) {
  const found: number[] = [];
  for (let at = yield* parentOf(pid); at > 1; at = yield* parentOf(at)) found.push(at);
  return found;
});

/**
 * Runs `effect` holding the Machine Measurement `lock`, waiting while another process holds
 * it. Inside a Measurement the host that started this process holds it, and it is left so.
 */
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
