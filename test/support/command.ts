// WARNING: Never Bun.spawnSync: under load it can lose the child's exit and spin the worker forever (oven-sh/bun#34069).
import * as Str from "effect/String";
import { Effect } from "effect";

const signal = (child: Bun.Subprocess, name: NodeJS.Signals) => {
  try {
    if (process.platform === "win32") {
      child.kill(name);
    } else {
      process.kill(-child.pid, name);
    }
  } catch {}
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
  // WARNING: Descendants may ignore SIGTERM, so the group is SIGKILLed and must not outlive its leader.
  signal(child, "SIGKILL");
});

export interface Ran {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ExecOptions {
  readonly cwd?: string;
  readonly stdin?: Uint8Array;
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
          stdin: options.stdin ?? "ignore",
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
    if (handle.signalCode !== null) {
      throw new Error(`command ended by ${handle.signalCode}`);
    }
    return { exitCode: Number(exitCode), stdout, stderr } satisfies Ran;
  },
  Effect.scoped,
  Effect.orDie,
);

// WARNING: exec ends the whole process group a command leaves, so a detached command must lead its own session.
export const startDetached = (argv: ReadonlyArray<string>) =>
  exec([
    "sh",
    "-c",
    'setsid "$@" >/dev/null 2>&1 </dev/null & while [ "$(ps -o sid= -p $!)" -ne $! ] 2>/dev/null; do :; done; echo $!',
    "sh",
    ...argv,
  ]).pipe(Effect.map((ran) => Number(Str.trim(ran.stdout))));
