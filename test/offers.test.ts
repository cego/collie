// What a finished Run offers to do next, and why each offer is there.
//
// Every answer here comes from facts the Run left behind. None of it reads a workflow's
// name: an offer exists because the work earned it, so a fork that renames every shipped
// workflow keeps what its Runs offer, and a workflow nobody shipped gets the same.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { expect, test } from "bun:test";
import { SELF, inputsFor, offersFrom, taskOffers, type Declared } from "../src/offers";
import type { ActionFacts } from "../src/sdk";
import reviewWorkflow from "../workflows/review.workflow";
import { declaredByModule } from "../src/engine";

const facts = (over: Partial<ActionFacts> = {}): ActionFacts => ({
  outcome: "feature",
  succeeded: true,
  branch: "mk/thing",
  mrUrl: null,
  planIssues: 0,
  disposed: false,
  openFindings: 0,
  diffTarget: null,
  claim: null,
  ...over,
});

const offer = (over: Partial<Declared> = {}): Declared => ({
  id: "fix-open",
  title: "Fix what is open",
  workflow: "implement",
  arguments: null,
  kind: "action",
  inputs: {},
  eligible: () => true,
  ...over,
});

test("Improve is available only for owned merge requests with open findings at their current head", () => {
  const declared = declaredByModule(reviewWorkflow);
  const reading = (over: Partial<ActionFacts>) =>
    Option.getOrUndefined(
      Arr.findFirst(
        offersFrom(
          declared,
          facts({
            openFindings: 1,
            diffTarget: "mr:gitlab.cego.dk/mk/collie!7",
            review: { head: "H1", reviewed: "H1", owned: true },
            ...over,
          }),
          { keepUnavailable: true },
        ),
        (one) => one.id === "improve",
      ),
    );
  expect(reading({})?.unavailable).toBeNull();
  expect(reading({ review: { head: "H1", reviewed: "H1", owned: false } })?.unavailable).toBe(
    "Collie never pushes to someone else's branch",
  );
  expect(reading({ openFindings: 0 })?.unavailable).toBe("no finding is open at the current head");
  expect(reading({ review: { head: "H2", reviewed: "H1", owned: true } })?.unavailable).toBe(
    "no finding is open at the current head",
  );
});

test("an offer whose facts are met is offered, with the first eligible one as the primary", () => {
  const offers = offersFrom(
    [offer({ id: "one" }), offer({ id: "two" }), offer({ id: "three", eligible: () => false })],
    facts(),
  );
  expect(Arr.map(offers, (one) => [one.id, one.primary])).toEqual([
    ["one", true],
    ["two", false],
  ]);
});

test("an offer decides on the facts, so the same declaration answers differently", () => {
  const onlyMerged = offer({ eligible: (f) => f.mrUrl !== null });
  expect(offersFrom([onlyMerged], facts())).toEqual([]);
  expect(offersFrom([onlyMerged], facts({ mrUrl: "mk/collie!65" }))).toHaveLength(1);
});

test("a disposition hides the follow-ups, and leaves the actions to their own facts", () => {
  const offers = offersFrom(
    [
      offer({ id: "next", kind: "follow-up" }),
      offer({ id: "look", kind: "action", eligible: (f) => f.branch !== null }),
    ],
    facts({ disposed: true }),
  );
  expect(Arr.map(offers, (one) => one.id)).toEqual(["look"]);
});

test("an offer whose eligibility throws is not offered, and says why", () => {
  const broken = offer({
    id: "broken",
    eligible: () => {
      throw new Error("no facts here");
    },
  });
  const offers = offersFrom([broken, offer({ id: "fine" })], facts());
  expect(Arr.map(offers, (one) => one.id)).toEqual(["fine"]);
  expect(offersFrom([broken], facts(), { keepUnavailable: true })[0]).toMatchObject({
    id: "broken",
    unavailable: "no facts here",
  });
});

test("an offer that names no workflow of its own starts the one that declared it", () => {
  const again = offer({ id: "run-again", workflow: SELF });
  expect(offersFrom([again], facts(), { self: "look-over" })[0]?.workflow).toBe("look-over");
});

test("a value the Run was started with is passed on as it was, null included", () => {
  const passed = inputsFor(
    { inputs: { value: "started-with", missing: "started-with", mr: "merge-request" } },
    { runId: "r", runDir: "/r", facts: facts(), input: { value: null } },
  );
  // An explicit null is a value; a field nobody gave, and a fact the Run lacks, are not.
  expect(passed).toEqual({ value: null });
});

test("a Task of several merge requests offers each owning Run's own, by its merge request, and none acts on both", () => {
  const release = offer({
    id: "release",
    title: "Release",
    workflow: "release",
    inputs: { release: "merge-request" },
    eligible: (one) => one.mrUrl !== null,
  });
  const ownedBy = (run: string, named: string) => ({
    run,
    named,
    offers: offersFrom([release], facts({ mrUrl: `https://gitlab.cego.dk/cego/${run}` })),
  });
  // The fan-out parent opened no merge request, so its own release is not on offer.
  const own = offersFrom([release], facts(), { keepUnavailable: true });

  const listed = taskOffers("r-fan", own, [ownedBy("app", "app!12"), ownedBy("api", "api!7")]);

  expect(
    Arr.map(
      Arr.filter(listed, (one) => one.unavailable === null),
      (one) => [one.title, one.run],
    ),
  ).toEqual([
    ["Release app!12", "app"],
    ["Release api!7", "api"],
  ]);
  expect(Arr.filter(listed, (one) => one.primary)).toHaveLength(1);
  expect(Arr.map(listed, (one) => one.run)).toEqual([undefined, "app", "api"]);
});

test("an owning Run asked for a Task's offers lists its own once, by its merge request", () => {
  const own = offersFrom([offer()], facts());
  const listed = taskOffers("app", own, [
    { run: "app", named: "app!12", offers: own },
    { run: "api", named: "api!7", offers: own },
  ]);
  expect(Arr.map(listed, (one) => [one.title, one.run])).toEqual([
    ["Fix what is open app!12", undefined],
    ["Fix what is open api!7", "api"],
  ]);
});
