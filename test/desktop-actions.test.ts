// A gesture's try as the record hears it: a refusal over a finished Step names that Step.

import { expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { actionRunner, chosenOffer, invokeOf, offerKey } from "../desktop/src/shared/actions";
import type { OfferView } from "../src/board-model";
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

test("an offer a Task's other merge request makes is chosen apart from the Run's own, and invoked on its owner", () => {
  const offer = (over: Partial<OfferView>): OfferView => ({
    id: "release",
    title: "Release",
    workflow: "release",
    arguments: null,
    kind: "follow-up",
    primary: false,
    unavailable: null,
    ...over,
  });
  const own = offer({ title: "Release app!12" });
  const api = offer({ title: "Release api!7", run: "r-api" });
  const offers = [own, api];

  expect(chosenOffer(offers, offerKey(api))).toBe(api);
  expect(chosenOffer(offers, offerKey(own))).toBe(own);
  expect(offerKey(own)).not.toBe(offerKey(api));
  expect(invokeOf("r-app", api, {})).toEqual({
    _tag: "Invoke",
    runId: "r-api",
    offer: "release",
    input: {},
  });
  expect(invokeOf("r-app", own, {}).runId).toBe("r-app");
});
