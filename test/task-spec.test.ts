import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { compareSpecs, doneIn, objectiveIn, ticketsInSpec } from "../src/task-spec";
import { FIRST_SPEC, SECOND_RATIONALE, SECOND_SPEC } from "./task-context.fixture";

const revision = (text: string, n: number, rationale: string | null = null) => ({
  task: "task-1",
  revision: n,
  at: "2026-09-01T00:00:00.000Z",
  actor: "human",
  rationale,
  text,
  tickets: ticketsInSpec(text),
});

test("a spec's objective and Done when are what Overview reads from it", () => {
  expect(objectiveIn(FIRST_SPEC)).toBe("Refund a duplicate charge once per order.");
  expect(doneIn(FIRST_SPEC)).toBe("A repeated refund request leaves the order refunded once.");
  expect(doneIn("# A Task\n\n## Objective\n\nSay it.\n")).toBeNull();
});

test("a spec's tickets keep the id, blockers, criteria and after-merge observations they were written with", () => {
  const tickets = ticketsInSpec(FIRST_SPEC);
  expect(Arr.map(tickets, (one) => one.id)).toEqual(["1", "2"]);
  expect(tickets[1]?.blockedBy).toEqual(["1"]);
  expect(tickets[0]?.criteria).toEqual(["A second refund of one order refunds once."]);
  expect(tickets[0]?.afterMerge).toEqual(["Observe a duplicate refund on a canary account."]);
  expect(tickets[0]?.checks).toEqual(["check"]);
  expect(tickets[1]?.title).toBe("Show the refund in the order's history");
});

test("comparing two revisions names the requirement and the dependent ticket one added, with its rationale", () => {
  const compared = compareSpecs(revision(FIRST_SPEC, 1), {
    ...revision(SECOND_SPEC, 2, SECOND_RATIONALE),
  });
  expect(compared.rationale).toBe(SECOND_RATIONALE);
  expect(Arr.some(compared.sections, (one) => one.heading === "Requirements")).toBe(true);
  expect(Arr.flatMap(compared.sections, (one) => one.added)).toContain(
    "- Two concurrent refund requests must settle once.",
  );
  expect(Arr.map(compared.addedTickets, (one) => one.id)).toEqual(["3"]);
  expect(compared.addedTickets[0]?.blockedBy).toEqual(["1"]);
  expect(compared.removedTickets).toEqual([]);
  expect(Arr.map(revision(FIRST_SPEC, 1).tickets, (one) => one.id)).toEqual(["1", "2"]);
});
