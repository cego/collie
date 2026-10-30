// A command a test runs to its end. Never with `Bun.spawnSync`: under load it can lose its
// child's exit and spin the worker forever (oven-sh/bun#34069), so every later test in that
// worker times out.

import * as Str from "effect/String";
import { Effect } from "effect";

const signal = (child: Bun.Subprocess, name: NodeJS.Signals) => {
  try {
    if (process.platform === "win32") child.kill(name);
    else process.kill(-child.pid, name);
  } catch {
    // The process group exited already.
  }
};

const terminate = Effect.fn("test.command.terminate")(function* (child: Bun.Subprocess) {
  signal(child, "SIGTERM");
  yield* Effect.promise(() => child.exited).pipe(
    Effect.timeoutOrElse({
      duration: "5 seconds",
      orElse: () =>
        Effect.sync(() => signal(child, "SIGKILL")).pipe(
          Effect.andThen(Effect.promise(() => child.exited)),
        ),
    }),
  );
  // A fixture's descendants must not outlive their leader, even if they ignore SIGTERM.
  signal(child, "SIGKILL");
});

export interface Ran {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExecOptions {
  readonly cwd?: string;
  /** Replaces the test's environment; without it the command inherits that. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export const exec = Effect.fn("test.exec")(
  function* (argv: ReadonlyArray<string>, options: ExecOptions = {}) {
    const handle = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.spawn([...argv], {
          cwd: options.cwd,
          env: options.env === undefined ? process.env : { ...options.env },
          detached: process.platform !== "win32",
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        }),
      ),
      terminate,
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        Effect.promise(() => new Response(handle.stdout).text()),
        Effect.promise(() => new Response(handle.stderr).text()),
        Effect.promise(() => handle.exited).pipe(Effect.tap(() => terminate(handle))),
      ],
      { concurrency: "unbounded" },
    );
    if (handle.signalCode !== null) throw new Error(`command ended by ${handle.signalCode}`);
    return { exitCode: Number(exitCode), stdout, stderr } satisfies Ran;
  },
  Effect.scoped,
  Effect.orDie,
);

/**
 * Starts `argv` as nobody's child, in a session of its own, and gives back its pid once it
 * leads that session: `exec` ends the whole group its command leaves behind.
 */
export const startDetached = (argv: ReadonlyArray<string>) =>
  exec([
    "sh",
    "-c",
    'setsid "$@" >/dev/null 2>&1 </dev/null & while [ "$(ps -o sid= -p $!)" -ne $! ] 2>/dev/null; do :; done; echo $!',
    "sh",
    ...argv,
  ]).pipe(Effect.map((ran) => Number(Str.trim(ran.stdout))));
