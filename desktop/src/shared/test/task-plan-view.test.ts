import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import type { ComparedTicket } from "../task-plan-view";
import type { ActivityPost } from "../activity-view";
import { comparisonLines, ticketsOfRevision } from "../task-plan-view";
import { activityLines, withOlderPage } from "../activity-view";

const one: ComparedTicket = {
  id: "1",
  title: "Refund a duplicate request",
  blockedBy: [],
};
const two: ComparedTicket = { id: "2", title: "Show the refund", blockedBy: ["1"] };
const three: ComparedTicket = {
  id: "3",
  title: "Refund two concurrent requests",
  blockedBy: ["1"],
};

const comparison = {
  from: 1,
  to: 2,
  rationale: "Refunds can arrive at the same time.",
  sections: [
    {
      heading: "Requirements",
      added: ["Two concurrent refund requests must settle once."],
      removed: [],
    },
    {
      heading: "Done when",
      added: ["Two simultaneous refund requests leave the order refunded once."],
      removed: ["A repeated refund request leaves the order refunded once."],
    },
  ],
  addedTickets: [three],
  removedTickets: [],
};

test("the Plan's comparison names what revision 2 added and the reason it was recorded", () => {
  const lines = comparisonLines(comparison);
  expect(lines).toContain("Revision 1 → 2");
  expect(lines).toContain("Why: Refunds can arrive at the same time.");
  expect(lines).toContain("+ Two concurrent refund requests must settle once.");
  expect(lines).toContain("+ 03 Refund two concurrent requests (blocked by 01)");
  expect(lines).toContain("- A repeated refund request leaves the order refunded once.");
});

test("selecting revision 1 shows revision 1's own two tickets", () => {
  const revisions = [
    { revision: 1, tickets: [one, two] },
    { revision: 2, tickets: [one, two, three] },
  ];
  expect(Arr.map(ticketsOfRevision(revisions, 1), (ticket) => ticket.id)).toEqual(["1", "2"]);
  expect(ticketsOfRevision(revisions, 9)).toEqual([]);
});

const post = (seq: number, text: string) => {
  const returned: ActivityPost = {
    seq,
    id: `post-${seq}`,
    kind: "comment",
    at: `2026-09-0${seq}T00:00:00.000Z`,
    actor: { by: "mk", kind: "human" },
    text,
    about: [],
    source: null,
  };
  return returned;
};

test("Activity reads in order with its author, and an older page goes above what is shown", () => {
  expect(activityLines([post(1, "early")])).toEqual([
    "2026-09-01T00:00:00.000Z · mk · comment: early (post-1)",
  ]);
  const shown = withOlderPage([post(3, "late")], [post(2, "middle")]);
  expect(Arr.map(shown, (one) => one.text)).toEqual(["middle", "late"]);
  expect(Arr.map(withOlderPage(shown, [post(1, "early")]), (one) => one.text)).toEqual([
    "early",
    "middle",
    "late",
  ]);
  expect(Arr.map(withOlderPage(shown, shown), (one) => one.text)).toEqual(["middle", "late"]);
});
