import { type Duration, Effect } from "effect";
import { spawned } from "./machine";

export const MARK = "__COLLIE_PATH__";

/** The PATH a shell printed between the markers, or null where it printed none. */
export const pathIn = (printed: string): string | null => {
  const parts = printed.split(MARK);
  return (parts.length > 2 && parts[1]) || null;
};

/** PATH as the user's interactive login shell sets it on macOS; null elsewhere or where it cannot be read. */
export const loginPath = Effect.fn("Desktop.loginPath")(function* (
  platform: NodeJS.Platform,
  shell: string,
  limit: Duration.Input = "5 seconds",
) {
  if (platform !== "darwin") return null;
  return yield* Effect.gen(function* () {
    const child = yield* spawned(() =>
      Bun.spawn([shell, "-ilc", `printf '${MARK}%s${MARK}' "$PATH"`], {
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
