import { expect, test } from "bun:test";
import { Effect, Stream } from "effect";
import { runEffect } from "./support/effect";
import { waitForTerminal } from "../src/wait";

test("wait rechecks terminal state even when the filesystem emits no event", () =>
  runEffect(
    Effect.gen(function* () {
      let terminal = false;
      const never: Stream.Stream<never, never, never> = Stream.never;
      yield* Effect.forkChild(
        Effect.sleep("10 millis").pipe(Effect.tap(() => Effect.sync(() => (terminal = true)))),
      );

      yield* waitForTerminal(never, () => terminal, "5 millis");

      expect(terminal).toBe(true);
    }),
  ));
