// How the Flow's workspace shares the record between the rail, the Step's context and its work.

import { expect, test } from "bun:test";
import {
  contextStepped,
  contextWidth,
  railCap,
  railHeight,
  railStepped,
  stacks,
  workspaceKey,
} from "../desktop/src/shared/flow-layout";
import { quietWork } from "../desktop/src/shared/step-inspector";
import { flowNode } from "./support/flow";

test("the context column starts at about a quarter of the workspace, between 240 and 384 px", () => {
  expect(contextWidth(null, 1600)).toBe(384);
  expect(contextWidth(null, 1100)).toBe(308);
  expect(contextWidth(null, 721)).toBe(240);
});

test("a chosen context width holds within 240 px and under half the workspace", () => {
  expect(contextWidth(500, 1600)).toBe(500);
  expect(contextWidth(900, 1600)).toBe(720);
  expect(contextWidth(120, 1600)).toBe(240);
  expect(contextWidth(400, 500)).toBe(240);
});

test("arrows step the context column from its drawn width, and stop at its limits", () => {
  expect(contextStepped(384, 1600, 1)).toBe(400);
  expect(contextStepped(384, 1600, -1)).toBe(368);
  expect(contextStepped(720, 1600, 1)).toBe(720);
  expect(contextStepped(240, 1600, -1)).toBe(240);
});

test("the rail sizes itself until a height is chosen, which holds between 56 px and 60% of the Flow", () => {
  expect(railHeight(null, 900)).toBeNull();
  expect(railHeight(200, 900)).toBe(200);
  expect(railHeight(800, 900)).toBe(540);
  expect(railHeight(10, 900)).toBe(56);
});

test("a rail left to its Runs takes at most a quarter of a short Flow, and 192 px of a tall one", () => {
  expect(railCap(900)).toBe(192);
  expect(railCap(480)).toBe(120);
  expect(railCap(160)).toBe(56);
});

test("arrows step the rail from its drawn height", () => {
  expect(railStepped(120, 900, 1)).toBe(144);
  expect(railStepped(120, 900, -1)).toBe(96);
  expect(railStepped(56, 900, -1)).toBe(56);
});

test("a workspace under 672 px stacks the Step's context over its work, and a wider one sets them side by side", () => {
  expect(stacks(671)).toBe(true);
  expect(stacks(672)).toBe(false);
  expect(stacks(881)).toBe(false);
});

const key = (pressed: string, held: { ctrl?: true; meta?: true; shift?: true } = {}) => ({
  key: pressed,
  ctrlKey: held.ctrl === true,
  metaKey: held.meta === true,
  shiftKey: held.shift === true,
});

test("Ctrl or Cmd+Shift+F focuses the work and restores it; Escape only restores", () => {
  expect(workspaceKey(key("F", { ctrl: true, shift: true }), false)).toBe("focus");
  expect(workspaceKey(key("F", { meta: true, shift: true }), true)).toBe("restore");
  expect(workspaceKey(key("Escape"), true)).toBe("restore");
  expect(workspaceKey(key("Escape"), false)).toBeNull();
  expect(workspaceKey(key("f"), false)).toBeNull();
});

test("a Step with nothing to show says whether it has yet to start", () => {
  expect(quietWork(flowNode("review", { state: "expected" }))).toBe(
    "This Step has not started yet.",
  );
  expect(quietWork(flowNode("grill", { state: "done" }))).toBe(
    "This Step left no terminal, log or evidence to show here.",
  );
});
