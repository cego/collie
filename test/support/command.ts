// A command a test runs to its end. Never with `Bun.spawnSync`: under load it can lose its
// child's exit and spin the worker forever (oven-sh/bun#34069), so every later test in that
// worker times out.

import { Effect, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

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

const text = (stream: ChildProcessSpawner.ChildProcessHandle["stdout"]) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (out, chunk) => out + chunk,
    ),
  );

export const exec = Effect.fn("test.exec")(
  function* (argv: ReadonlyArray<string>, options: ExecOptions = {}) {
    const [cmd = "", ...args] = argv;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make(cmd, args, {
        cwd: options.cwd,
        env: options.env === undefined ? undefined : { ...options.env },
        extendEnv: options.env === undefined,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }),
    );
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [text(handle.stdout), text(handle.stderr), handle.exitCode],
      { concurrency: "unbounded" },
    );
    return { exitCode: Number(exitCode), stdout, stderr } satisfies Ran;
  },
  Effect.scoped,
  Effect.orDie,
);
