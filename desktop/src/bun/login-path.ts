import * as Str from "effect/String";
import { type Duration, Effect } from "effect";
import { spawned } from "./machine";
import { CHILD_CWD } from "./login-env";

export const MARK = "__COLLIE_PATH__";

export const pathIn = (printed: string) => {
  const parts = Str.split(printed, MARK);
  return (parts.length > 2 && parts[1]) || null;
};

export const loginPath = Effect.fn("Desktop.loginPath")(function* (
  platform: NodeJS.Platform,
  shell: string,
  limit: Duration.Input = "5 seconds",
) {
  if (platform !== "darwin") return null;
  return yield* Effect.gen(function* () {
    const child = yield* spawned(() =>
      Bun.spawn([shell, "-ilc", `printf '${MARK}%s${MARK}' "$PATH"`], {
        cwd: CHILD_CWD,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      }),
    );
    const path = pathIn(yield* Effect.promise(() => new Response(child.stdout).text()));
    return path ?? (yield* Effect.fail("it printed no PATH"));
  }).pipe(
    Effect.scoped,
    Effect.timeout(limit),
    Effect.catchDefect((cause) => Effect.fail(String(cause))),
    Effect.catch((why) =>
      Effect.logWarning(`keeping the inherited PATH: ${shell} -ilc: ${String(why)}`).pipe(
        Effect.as(null),
      ),
    ),
  );
});
