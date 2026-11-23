import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { homedir } from "node:os";
import { Config, Effect, Option, Path } from "effect";
import type { Duration } from "effect";
import { withoutHerdrOne, withoutLauncher } from "../../../src/env";

const BIN = Effect.runSync(
  Path.Path.pipe(
    Effect.map((path) => path.dirname(process.execPath)),
    Effect.provide(Path.layer),
  ),
);

const BEGIN = "<<collie-env-begin-7f3a9c>>";
const END = "<<collie-env-end-7f3a9c>>";

const LIMIT = "5 seconds";

// WARNING: rc files print around the markers; only what lies between them is read.
export const parseLoginEnv = (output: string) => {
  const start = Option.getOrElse(pipe_(output, Str.indexOf(BEGIN)), () => -1);
  const found = new Map<string, string>();
  if (start < 0) {
    return found;
  }
  const remaining = pipe_(output, Str.slice(start + BEGIN.length));
  const end = Option.getOrElse(pipe_(remaining, Str.indexOf(END)), () => -1);
  if (end < 0) {
    return found;
  }
  for (const entry of Str.split(pipe_(remaining, Str.slice(0, end)), "\0")) {
    const eq = Option.getOrElse(pipe_(entry, Str.indexOf("=")), () => -1);
    if (eq > 0) {
      found.set(
        pipe_(entry, Str.slice(0, eq), Str.replace(/^\n/, "")),
        pipe_(entry, Str.slice(eq + 1)),
      );
    }
  }
  return found;
};

export const CHILD_CWD = homedir();

// WARNING: Bun ignores environment changes made after it started, so children get a copy.
export const childEnv = () => withoutLauncher(withoutHerdrOne(desktopEnv()), BIN);

// WARNING: children inherit the process environment, not an Effect Config.
const desktopEnv = () => process.env;

// WARNING: Bun's own lookup uses the PATH it started with.
export const which = (command: string) => Bun.which(command, { PATH: childEnv().PATH });

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

export type AgentState = "holds" | "empty" | "gone" | "unknown";

const AGENT_LIMIT = "2 seconds";

export const agentState = (
  socket: string,
  sshAdd = "ssh-add",
  limit: Duration.Input = AGENT_LIMIT,
) =>
  Effect.gen(function* () {
    const child = yield* Effect.try(() =>
      Bun.spawn([sshAdd, "-l"], {
        cwd: CHILD_CWD,
        env: { ...childEnv(), SSH_AUTH_SOCK: socket },
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    const code = yield* Effect.promise(() => child.exited).pipe(
      Effect.timeoutOption(limit),
      Effect.ensuring(Effect.sync(() => child.kill())),
    );
    if (Option.isNone(code)) {
      return "unknown" as const;
    }
    return code.value === 0
      ? "holds"
      : code.value === 1
        ? "empty"
        : code.value === 2
          ? "gone"
          : "unknown";
  }).pipe(
    Effect.orElseSucceed(() => {
      const returned: AgentState = "unknown";
      return returned;
    }),
  );

// WARNING: an rc file's agent may hold a key only after a terminal asks, so the agent holding keys wins.
export const takesLoginAgent = Effect.fn("Desktop.takesLoginAgent")(function* (
  session: string | undefined,
  login: string | undefined,
  stateOf: (socket: string) => Effect.Effect<AgentState>,
) {
  if (login === undefined || session === undefined || login === session) {
    return true;
  }
  const theirs = yield* stateOf(login);
  if (theirs === "holds") {
    return true;
  }
  const ours = yield* stateOf(session);
  if (ours === "holds") {
    return false;
  }
  if (theirs === "empty") {
    return true;
  }
  return ours !== "empty";
});

const AGENT_VARIABLES = new Set(["SSH_AUTH_SOCK", "SSH_AGENT_PID"]);

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
  const session = env.SSH_AUTH_SOCK;
  const login = taken.get("SSH_AUTH_SOCK");
  const keepsAgent = !(yield* takesLoginAgent(session, login, (socket) => agentState(socket)));
  if (keepsAgent) {
    yield* Effect.logInfo(
      `Keeping the SSH agent at ${session}: the login shell's at ${login} holds no keys`,
    );
  }
  for (const [name, value] of taken) {
    if (!(keepsAgent && AGENT_VARIABLES.has(name))) {
      env[name] = value;
    }
  }
  return true;
}).pipe(Effect.orElseSucceed(() => false));

// WARNING: a plain shell preserves the resolved PATH; login profiles may reset it.
export const localShell = (tookLoginEnv: boolean) =>
  tookLoginEnv
    ? Config.succeed(["/bin/sh", "-c"])
    : Config.String("SHELL").pipe(
        Config.withDefault("/bin/sh"),
        Config.map((shell) => [shell, "-lc"]),
      );
