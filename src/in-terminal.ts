import { type Cause, Effect, Queue, type Scope, Stream } from "effect";

export interface InTerminal {
  readonly output: Stream.Stream<Uint8Array>;
  readonly type: (text: string) => Effect.Effect<void>;
  readonly exitCode: Effect.Effect<number>;
}

const killed = <C extends Bun.Subprocess>(start: () => C) =>
  Effect.acquireRelease(Effect.sync(start), (child) => Effect.sync(() => child.kill()));

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
