// A command a test runs to its end. Never with `Bun.spawnSync`: under load it can lose its
// child's exit and spin the worker forever (oven-sh/bun#34069), so every later test in that
// worker times out.

import { Effect } from "effect";

export interface Ran {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExecOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export const exec = (argv: ReadonlyArray<string>, options: ExecOptions = {}): Effect.Effect<Ran> =>
  Effect.promise(() => {
    const child = Bun.spawn([...argv], {
      cwd: options.cwd,
      env: options.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    return Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]).then(([stdout, stderr, exitCode]) => ({ exitCode, stdout, stderr }));
  });
