import { expect, test } from "bun:test";
import { Effect, Option, Result } from "effect";
import { openBridge } from "../desktop/src/bun/machine";
import { fastForward } from "./support/effect";

test("a living bridge that never becomes ready fails with a bounded startup diagnosis", () =>
  Effect.runPromise(
    fastForward(
      Effect.gen(function* () {
        const opened = yield* openBridge([
          process.execPath,
          "-e",
          "setInterval(() => {}, 10000)",
        ]).pipe(Effect.result, Effect.timeoutOption("3 minutes"));
        expect(Option.isSome(opened)).toBe(true);
        if (Option.isNone(opened)) return;
        expect(Result.isFailure(opened.value)).toBe(true);
        if (Result.isFailure(opened.value)) {
          expect(opened.value.failure.state).toBe("unreachable");
          expect(opened.value.failure.reason).toContain("ready");
          expect(opened.value.failure.reason).toContain("2 minutes");
        }
      }),
      1000,
    ),
  ));
