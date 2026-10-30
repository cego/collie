import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { homedir } from "node:os";
import { Config, type Duration, Effect, Option, Path } from "effect";
import { withoutLauncher } from "../../../src/env";

const BIN = Effect.runSync(
  Path.Path.pipe(
    Effect.map((path) => path.dirname(process.execPath)),
    Effect.provide(Path.layer),
  ),
);

const BEGIN = "<<collie-env-begin-7f3a9c>>";
const END = "<<collie-env-end-7f3a9c>>";

/** How long the shell gets to start, rc files included. */
const LIMIT = "5 seconds";

/** The variables between the markers, `env -0` output; whatever the rc files printed around them is ignored. */
export const parseLoginEnv = (output: string) => {
  const start = Option.getOrElse(pipe_(output, Str.indexOf(BEGIN)), () => -1);
  const found = new Map<string, string>();
  if (start < 0) return found;
  const remaining = pipe_(output, Str.slice(start + BEGIN.length));
  const end = Option.getOrElse(pipe_(remaining, Str.indexOf(END)), () => -1);
  if (end < 0) return found;
  for (const entry of Str.split(pipe_(remaining, Str.slice(0, end)), "\0")) {
    const eq = Option.getOrElse(pipe_(entry, Str.indexOf("=")), () => -1);
    if (eq > 0)
      found.set(
        pipe_(entry, Str.slice(0, eq), Str.replace(/^\n/, "")),
        pipe_(entry, Str.slice(eq + 1)),
      );
  }
  return found;
};

/** Where children start: Desktop's own folder goes when an update replaces it. */
export const CHILD_CWD = homedir();

/** Gives children the cleaned environment; Bun otherwise ignores changes made since it started. */
export const childEnv = () => withoutLauncher(desktopEnv(), BIN);

// Children inherit the process environment, not an Effect Config.
// oxlint-disable-next-line effecttsgo/process-env
const desktopEnv = () => process.env;

/** Where a bare command is found on `childEnv`'s PATH; Bun's own lookup uses the PATH it started with. */
export const which = (command: string) => Bun.which(command, { PATH: childEnv().PATH });

/** The variables `shell -ilc` exports; empty where it fails, prints none, or outlasts `limit`. */
export const readLoginEnv = (shell: string, limit: Duration.Input = LIMIT) =>
  Effect.gen(function* () {
    const child = Bun.spawn(
      [shell, "-ilc", `printf '%s' '${BEGIN}'; env -0; printf '%s' '${END}'`],
      {
        cwd: CHILD_CWD,
        env: childEnv(),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      },
    );
    const output = yield* Effect.promise(() =>
      Promise.all([new Response(child.stdout).text(), child.exited]),
    ).pipe(Effect.timeoutOption(limit), Effect.ensuring(Effect.sync(() => child.kill())));
    return Option.isSome(output) && output.value[1] === 0
      ? parseLoginEnv(output.value[0])
      : new Map<string, string>();
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`Login shell environment not read from ${shell}`, cause).pipe(
        Effect.as(new Map<string, string>()),
      ),
    ),
  );

/** Merges the interactive login environment into Desktop's; true where it was taken. */
export const takeLoginEnv = Effect.gen(function* () {
  const shell = yield* Config.String("SHELL").pipe(
    Config.withDefault(process.platform === "darwin" ? "/bin/zsh" : "/bin/sh"),
  );
  const taken = yield* readLoginEnv(shell);
  if (taken.size === 0) {
    yield* Effect.logWarning(`Login shell environment not taken from ${shell}`);
    return false;
  }
  const env = desktopEnv();
  for (const [name, value] of taken) env[name] = value;
  return true;
}).pipe(Effect.orElseSucceed(() => false));

/** A plain shell preserves the resolved PATH; login profiles may reset it. */
export const localShell = (tookLoginEnv: boolean) =>
  tookLoginEnv
    ? Config.succeed(["/bin/sh", "-c"])
    : Config.String("SHELL").pipe(
        Config.withDefault("/bin/sh"),
        Config.map((shell) => [shell, "-lc"]),
      );
