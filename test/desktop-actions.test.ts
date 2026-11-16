// A gesture's try as the record hears it: a refusal over a finished Step names that Step.

import { expect, test } from "bun:test";
import * as Arr from "effect/Array";
import { Effect, Exit } from "effect";
import {
  actionRunner,
  chosenOffer,
  invokeOf,
  offerKey,
  offeringOf,
} from "../desktop/src/shared/actions";
import { type OfferView, primaryAction, cardActions } from "../src/board-model";
import { ActionFailed } from "../desktop/src/shared/flock";
import { runEffect } from "./support/effect";
import { task, taskMr } from "./support/task";

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

test("Merge loads and selects the Release offer from the single merge request's owner", () => {
  const release: OfferView = {
    id: "release",
    title: "Release",
    workflow: "release",
    arguments: null,
    kind: "follow-up",
    primary: true,
    unavailable: null,
  };
  const view = task({
    run: "r-plan",
    state: "done",
    landed: false,
    shipping: "merge",
    mrs: [taskMr("app", 12, { run: "r-implementation", ready: true })],
    offer: { id: release.id, title: release.title, run: "r-implementation" },
  });
  const action = primaryAction(view);
  expect(action?.kind).toBe("offer");
  if (action?.kind !== "offer") throw new Error("expected the Merge offer");

  const dialog = offeringOf(view.run, action.offer);
  const offersByRun = new Map<string, ReadonlyArray<OfferView>>([
    ["r-plan", []],
    ["r-implementation", [release]],
  ]);
  const chosen = chosenOffer(offersByRun.get(dialog.runId) ?? [], dialog.offer);
  expect(chosen).toBeDefined();
  if (chosen === undefined) throw new Error("the advertised Release could not be selected");
  expect(invokeOf(dialog.runId, chosen, {})).toEqual({
    _tag: "Invoke",
    runId: "r-implementation",
    offer: "release",
    input: {},
  });
  expect(offeringOf("r-plan", release)).toEqual({ runId: "r-plan", offer: "release" });
  expect(offeringOf("r-plan", null)).toEqual({ runId: "r-plan", offer: null });
});

test("every named card Offer opens and invokes on its Change's Run", () => {
  const view = task({
    run: "r-fan",
    state: "done",
    landed: false,
    shipping: "merge",
    offer: { id: "release", title: "Release", run: "r-api" },
    offers: [
      { id: "release", title: "Release api!7", run: "r-api" },
      { id: "stage", title: "Stage api!7", run: "r-api" },
      { id: "release", title: "Release web!8", run: "r-web" },
      { id: "stage", title: "Stage web!8", run: "r-web", unavailable: "not connected" },
    ],
  });
  const actions = Arr.filter(cardActions(view), (action) => action.kind === "offer");
  expect(Arr.map(actions, (action) => offeringOf(view.run, action.offer))).toEqual([
    { runId: "r-api", offer: "release" },
    { runId: "r-api", offer: "stage" },
    { runId: "r-web", offer: "release" },
    { runId: "r-web", offer: "stage" },
  ]);
  const primary = primaryAction(view);
  expect(primary?.kind === "offer" ? offeringOf(view.run, primary.offer) : null).toEqual({
    runId: "r-api",
    offer: "release",
  });
});
