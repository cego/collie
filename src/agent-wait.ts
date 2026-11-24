import { Clock, Effect, Option, Schedule } from "effect";

export type WaitEnd = "clear" | "stopped" | "overrun";

type ReadLine =
  | { readonly _tag: "read"; readonly working: ReadonlyArray<string> | null }
  | { readonly _tag: "stopped" };

const untilTrue: <R>(
  on: Effect.Effect<boolean, never, R>,
  every: number,
) => Effect.Effect<boolean, never, R> = (on, every) =>
  on.pipe(Effect.repeat({ until: (ready) => ready, schedule: Schedule.spaced(every) }));

type WaitOptions<R> = {
  readonly budget: number;
  readonly poll: number;
  readonly rosterBudget: number;
  readonly working: Effect.Effect<ReadonlyArray<string> | null, never, R>;
  readonly stopped: Effect.Effect<boolean, never, R>;
  readonly tell: (
    working: ReadonlyArray<string>,
    unknown: boolean,
  ) => Effect.Effect<void, never, R>;
};

type WaitFor = <R>(opts: WaitOptions<R>) => Effect.Effect<WaitEnd, never, R>;

export const waitForAgents: WaitFor = (opts) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + opts.budget;
    let told = false;
    for (;;) {
      const left = Math.max(0, deadline - (yield* Clock.currentTimeMillis));
      const line = yield* Effect.raceFirst(
        opts.working.pipe(
          Effect.timeoutOption(Math.min(opts.rosterBudget, left)),
          Effect.map((found) => {
            const returned: ReadLine = { _tag: "read", working: Option.getOrNull(found) };
            return returned;
          }),
        ),
        untilTrue(opts.stopped, opts.poll).pipe(Effect.as({ _tag: "stopped" } as const)),
      );
      if (line._tag === "stopped" || (yield* opts.stopped)) {
        return "stopped" as const;
      }
      const names = line.working;
      if (names !== null && names.length === 0) {
        return "clear" as const;
      }
      if (!told) {
        told = true;
        yield* opts.tell(names ?? [], names === null);
      }
      const remaining = deadline - (yield* Clock.currentTimeMillis);
      if (remaining <= 0) {
        return "overrun" as const;
      }
      yield* Effect.sleep(Math.min(opts.poll, remaining));
    }
  });
