import { expect, test } from "bun:test";
import { offersOf, shownAs } from "../desktop/src/shared/definitions-view";

test("a module's follow-ups and actions are its offers, each saying what it starts", () => {
  expect(
    offersOf({
      hints: {},
      followUps: [{ id: "build", title: "Build it", workflow: "implement", when: "succeeded" }],
      actions: [
        { id: "retro", title: "Look back", workflow: "self-improve", arguments: {}, limits: [] },
      ],
    }),
  ).toEqual([
    { id: "build", title: "Build it", workflow: "implement", when: "after it succeeds" },
    { id: "retro", title: "Look back", workflow: "self-improve", when: "on its card" },
  ]);
});

test("metadata without offers, or not shaped as the host draws it, offers nothing", () => {
  expect(offersOf({ hints: {}, followUps: [], actions: [] })).toEqual([]);
  expect(offersOf({})).toEqual([]);
  expect(offersOf(null)).toEqual([]);
  expect(offersOf({ followUps: "garbled" })).toEqual([]);
});

test("a module's Markdown is rendered and its code is highlighted", () => {
  expect(shownAs("/x/workflows/plan.md")).toBe("markdown");
  expect(shownAs("/x/workflows/renovate.github.md")).toBe("markdown");
  expect(shownAs("/x/workflows/plan.workflow.ts")).toBe("code");
});
