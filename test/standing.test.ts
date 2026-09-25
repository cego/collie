// What became of a Run's work, decided from what it left behind.
//
// The rule these hold is that no workflow's name appears in the answer. Two Runs that
// left the same things behind are the same card whatever they were called, and a fork
// that renames every shipped workflow gets the classification its work earns.

import { expect, test } from "bun:test";
import { filed, standingOf, type WorkFacts } from "../src/standing";

const facts = (over: Partial<WorkFacts> = {}): WorkFacts => ({
  settled: true,
  succeeded: true,
  branch: null,
  mr: null,
  mrLanded: false,
  planIssues: 0,
  disposed: false,
  asking: false,
  ...over,
});

test("work with a branch, a merge request or tickets is work somebody has to file", () => {
  expect(filed(facts({ branch: "mk/thing" }))).toBe(true);
  expect(filed(facts({ mr: "mk/collie!65" }))).toBe(true);
  expect(filed(facts({ planIssues: 3 }))).toBe(true);
  expect(filed(facts())).toBe(false);
});

test("succeeded work that left nothing to file is landed, whatever ran it", () => {
  const standing = standingOf(facts());
  expect(standing).toEqual({ unfiled: true, planReady: false, landed: true });
});

test("succeeded work with tickets and nothing else is a plan ready to implement", () => {
  const standing = standingOf(facts({ planIssues: 4 }));
  expect(standing).toEqual({ unfiled: false, planReady: true, landed: false });
});

test("a branch nobody has answered for is not landed, and is not a plan either", () => {
  expect(standingOf(facts({ branch: "mk/thing" }))).toEqual({
    unfiled: false,
    planReady: false,
    landed: false,
  });
});

test("tickets beside a branch are work in progress, not a plan to hand on", () => {
  // Both were left behind, so the question is what to do with the branch — which is the
  // human's, and not "start building from this plan".
  expect(standingOf(facts({ planIssues: 2, branch: "mk/thing" })).planReady).toBe(false);
  expect(standingOf(facts({ planIssues: 2, mr: "mk/collie!65" })).planReady).toBe(false);
});

test("a disposition is the answer: the work landed and the plan is no longer offered", () => {
  expect(standingOf(facts({ planIssues: 2, disposed: true })).planReady).toBe(false);
  expect(standingOf(facts({ branch: "mk/thing", disposed: true })).landed).toBe(true);
});

test("a merge request the host says has landed lands the work", () => {
  expect(standingOf(facts({ mr: "mk/collie!65", mrLanded: true })).landed).toBe(true);
  expect(standingOf(facts({ mr: "mk/collie!66", mrLanded: false })).landed).toBe(false);
});

test("an open question is something to file, so work waiting on one is not landed", () => {
  expect(standingOf(facts({ asking: true })).landed).toBe(false);
});

test("work that has not finished has landed nothing, however little it left", () => {
  expect(standingOf(facts({ settled: false, succeeded: false })).landed).toBe(false);
});

test("work that failed with tickets is not a plan anyone should build from", () => {
  expect(standingOf(facts({ succeeded: false, planIssues: 3 })).planReady).toBe(false);
});
