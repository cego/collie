// What a finished Run offers to do next, and why each offer is there.
//
// Every answer here comes from facts the Run left behind. None of it reads a workflow's
// name: an offer exists because the work earned it, so a fork that renames every shipped
// workflow keeps what its Runs offer, and a workflow nobody shipped gets the same.

import { expect, test } from "bun:test";
import { SELF, offersFrom, type Declared } from "../src/offers";
import type { ActionFacts } from "../src/sdk";

const facts = (over: Partial<ActionFacts> = {}): ActionFacts => ({
  outcome: "feature",
  succeeded: true,
  branch: "mk/thing",
  mrUrl: null,
  planIssues: 0,
  disposed: false,
  openFindings: 0,
  diffTarget: null,
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

test("an offer whose facts are met is offered, with the first eligible one as the primary", () => {
  const offers = offersFrom(
    [offer({ id: "one" }), offer({ id: "two" }), offer({ id: "three", eligible: () => false })],
    facts(),
  );
  expect(offers.map((one) => [one.id, one.primary])).toEqual([
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
  expect(offers.map((one) => one.id)).toEqual(["look"]);
});

test("an offer whose eligibility throws is not offered, and says why", () => {
  const broken = offer({
    id: "broken",
    eligible: () => {
      throw new Error("no facts here");
    },
  });
  const offers = offersFrom([broken, offer({ id: "fine" })], facts());
  expect(offers.map((one) => one.id)).toEqual(["fine"]);
  expect(offersFrom([broken], facts(), { keepUnavailable: true })[0]).toMatchObject({
    id: "broken",
    unavailable: "no facts here",
  });
});

test("an offer that names no workflow of its own starts the one that declared it", () => {
  const again = offer({ id: "run-again", workflow: SELF });
  expect(offersFrom([again], facts(), { self: "look-over" })[0]?.workflow).toBe("look-over");
});
