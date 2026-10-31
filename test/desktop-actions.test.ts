// A gesture's try as the record hears it: a refusal over a finished Step names that Step.

import { expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { actionRunner } from "../desktop/src/shared/actions";
import { ActionFailed } from "../desktop/src/shared/flock";
import { runEffect } from "./support/effect";

test("a try refused over a Step that finished since tells its caller which Step", () =>
  runEffect(
    Effect.gen(function* () {
      const heard: Array<readonly [boolean | null, string | undefined]> = [];
      const run = actionRunner(
        () =>
          Promise.resolve(
            Exit.fail(new ActionFailed({ reason: "Wrap up has finished", step: "wrap" })),
          ),
        () => {},
      );

      const done = yield* Effect.promise(() =>
        run(
          "here",
          { _tag: "Control", runId: "r1", control: "hold", set: true, before: "wrap" },
          undefined,
          undefined,
          undefined,
          (outcome, failed) => heard.push([outcome, failed?.step]),
        ),
      );

      expect(done).toBe(false);
      expect(heard).toEqual([
        [null, undefined],
        [false, "wrap"],
      ]);
    }),
  ));
