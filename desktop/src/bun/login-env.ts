// What a Mac app launched from Finder or the Dock is missing: the shell's environment.
// launchd gives it a minimal PATH and none of `~/.zshrc`, so every local tool Desktop
// starts would look uninstalled. Desktop reads what the login shell has once, as it starts.

import { Config, Effect, Option } from "effect";

const BEGIN = "<<collie-env-begin-7f3a9c>>";
const END = "<<collie-env-end-7f3a9c>>";

/** How long the shell gets to start, rc files included. */
const LIMIT = "5 seconds";

/** The variables between the markers, `env -0` output; whatever the rc files printed around them is ignored. */
export const parseLoginEnv = (output: string) => {
  const start = output.indexOf(BEGIN);
  const end = output.indexOf(END, start + BEGIN.length);
  const found = new Map<string, string>();
  if (start < 0 || end < 0) return found;
  for (const entry of output.slice(start + BEGIN.length, end).split("\0")) {
    const eq = entry.indexOf("=");
    if (eq > 0) found.set(entry.slice(0, eq).replace(/^\n/, ""), entry.slice(eq + 1));
  }
  return found;
};

/**
 * The environment every child Desktop starts is given, the login shell's merged in on macOS.
 * Bun gives a child the environment it started with unless one is passed, whatever
 * `process.env` says since, so every spawn passes this.
 */
// Children inherit the process environment, not an Effect Config.
// oxlint-disable-next-line effecttsgo/process-env
export const childEnv = () => process.env;

/** Where a bare command is found on `childEnv`'s PATH; Bun's own lookup uses the PATH it started with. */
export const which = (command: string) => Bun.which(command, { PATH: childEnv().PATH });

/** On macOS, merges the login shell's environment into `childEnv`; any failure keeps the one it has. */
export const takeLoginEnv = Effect.gen(function* () {
  if (process.platform !== "darwin") return;
  const shell = yield* Config.String("SHELL").pipe(Config.withDefault("/bin/zsh"));
  const child = Bun.spawn([shell, "-ilc", `printf '%s' '${BEGIN}'; env -0; printf '%s' '${END}'`], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = yield* Effect.promise(() => new Response(child.stdout).text()).pipe(
    Effect.timeoutOption(LIMIT),
    Effect.ensuring(Effect.sync(() => child.kill())),
  );
  const taken = Option.isSome(output) ? parseLoginEnv(output.value) : new Map<string, string>();
  if (taken.size === 0) {
    return yield* Effect.logWarning(`Login shell environment not taken from ${shell}`);
  }
  const env = childEnv();
  for (const [name, value] of taken) env[name] = value;
}).pipe(
  Effect.catchCause((cause) => Effect.logWarning("Login shell environment not taken", cause)),
);
