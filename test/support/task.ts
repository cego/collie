// The TaskView a test starts from. Shared rather than copied per file, for the reason
// `focus.ts` gives: one fixture that grows every time a card learns to say something new.

import type { TaskView } from "../../src/board";

/** One Task, with the parts a test does not care about at rest. */
export function task(over: Partial<TaskView> = {}): TaskView {
  return {
    id: "t1",
    name: "Strapi prod seeder",
    project: "content",
    state: "active",
    steps: [
      { name: "build", state: "done" },
      { name: "review", state: "active" },
      { name: "mr", state: "todo" },
    ],
    sentence: "Fixing the review findings, round 2 of 5.",
    age: "58m",
    drift: null,
    held: null,
    heldBy: null,
    decision: null,
    agents: [],
    children: [],
    mr: null,
    branch: "mk/strapi-seed",
    disposition: null,
    // A finished fixture has landed unless the test says otherwise: most tests are about
    // the other sections, and an unlanded done Task is its own case.
    landed: (over.state ?? "active") === "done",
    ended: null,
    mrState: null,
    planReady: false,
    offer: null,
    run: "r1",
    runs: ["r1"],
    at: Date.parse("2026-09-16T12:00:00.000Z"),
    ...over,
  };
}
