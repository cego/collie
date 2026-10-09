// A command in a terminal of its own, for one that only asks or logs in when it has one.
// Bun's terminal, not `script`: util-linux and BSD `script` take different flags, and
// macOS's refuses the socket Bun gives a child for its stdin.

import { type Cause, Effect, Queue, type Scope, Stream } from "effect";

export interface InTerminal {
  /** All it prints, stdout and stderr as one, as the terminal shows it. */
  readonly output: Stream.Stream<Uint8Array>;
  /** Types `text` at it. */
  readonly type: (text: string) => Effect.Effect<void>;
  readonly exitCode: Effect.Effect<number>;
}

/** Puts `start`'s child down when the scope closes; Desktop passes its own, which also tracks it. */
const killed = <C extends Bun.Subprocess>(start: () => C) =>
  Effect.acquireRelease(Effect.sync(start), (child) => Effect.sync(() => child.kill()));

/**
 * Starts `argv` in a terminal Bun gives it, on Linux and macOS alike. `env`, where given, is
 * the child's whole environment; without one it gets this process's own.
 */
export const inTerminal = Effect.fn("inTerminal")(function* (
  argv: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly env?: Record<string, string | undefined> } = {},
  own: <C extends Bun.Subprocess>(start: () => C) => Effect.Effect<C, never, Scope.Scope> = killed,
) {
  const output = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const child = yield* own(() =>
    Bun.spawn([...argv], {
      ...options,
      env: options.env ?? Bun.env,
      terminal: {
        data: (_, bytes) => Queue.offerUnsafe(output, bytes),
        exit: () => Queue.endUnsafe(output),
      },
    }),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => child.terminal?.close()));
  return {
    output: Stream.fromQueue(output),
    type: (text) => Effect.sync(() => void child.terminal?.write(text)),
    exitCode: Effect.promise(() => child.exited),
  } satisfies InTerminal;
});
