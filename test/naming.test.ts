import { expect, test } from "bun:test";
import { agentName, evenRatio, GLYPH, stepLabel, tabLabel, targetLabel, variantLabel } from "../src/naming";

test("a review's target is short and human, and never a sha", () => {
  expect(targetLabel("review", "review-x", { target: "mr:123" })).toBe("!123");
  expect(targetLabel("review", "review-x", { target: "worktree" })).toBe("worktree");
  expect(targetLabel("review", "review-x", { target: "branch:main...add-picker" })).toBe("add-picker");

  // The case that produced `review-branch-b5571dc-head` as a run name.
  const opaque = targetLabel("review", "review-branch-b5571dc-head", { target: "branch:b5571dc...HEAD" });
  expect(opaque).toBe("diff");
  expect(opaque).not.toMatch(/[0-9a-f]{7}/i);
  // A sha base with a real head still shows the head.
  expect(targetLabel("review", "r", { target: "branch:b5571dc...add-picker" })).toBe("add-picker");
  // A real base with an opaque head falls back to the base rather than a sha.
  expect(targetLabel("review", "r", { target: "branch:main...HEAD" })).toBe("main");
});

test("workflows with no target are named by their slug, without repeating the workflow", () => {
  expect(targetLabel("implement", "implement-add-picker", {})).toBe("add-picker");
  expect(targetLabel("plan", "plan-add-picker", {})).toBe("add-picker");
  expect(targetLabel("architecture", "architecture-run", {})).toBe("run");
  // A slug that does not carry the prefix is left alone.
  expect(targetLabel("implement", "something-else", {})).toBe("something-else");
});

test("a tab is a glyph, the workflow and the target — no run id, no model", () => {
  expect(tabLabel(GLYPH.running, "review", "!123")).toBe("⚙ review · !123");
  expect(tabLabel(GLYPH.done, "implement", "add-picker")).toBe("✓ implement · add-picker");
  expect(tabLabel(GLYPH.waiting, "plan", "")).toBe("⚠ plan");
  expect(tabLabel(GLYPH.failed, "review", "worktree")).toBe("✗ review · worktree");
  for (const label of [tabLabel(GLYPH.running, "review", "!123"), tabLabel(GLYPH.done, "implement", "add-picker")]) {
    expect(label).not.toMatch(/\d{8}-\d{6}/); // no run-id stamp
    expect(label).not.toContain("claude");
  }
});

test("a pane names the model when the harness is the default one, and the step when it is alone", () => {
  const opus = { harness: "claude", model: "opus" };
  const codex = { harness: "codex", model: "gpt-5" };

  expect(variantLabel(opus, "claude", "review", 2)).toBe("opus");
  expect(variantLabel(codex, "claude", "review", 2)).toBe("codex gpt-5");
  // Alone in its step, a variant has nothing to distinguish it from.
  expect(variantLabel(opus, "claude", "build", 1)).toBe("build");
  expect(variantLabel(codex, "claude", "build", 1)).toBe("build");

  // On the harness's own default there is no model to name, so the harness is the name.
  expect(variantLabel({ harness: "claude", model: "default" }, "claude", "review", 2)).toBe("claude");
  expect(variantLabel({ harness: "codex", model: "default" }, "claude", "review", 2)).toBe("codex");
});

test("even splits leave every one of N panes the same width", () => {
  // Two variants: the first split halves the tab.
  expect(evenRatio(1, 2)).toBeCloseTo(1 / 2);
  // Three: 1/3 off the whole, then half of what is left.
  expect(evenRatio(1, 3)).toBeCloseTo(1 / 3);
  expect(evenRatio(2, 3)).toBeCloseTo(1 / 2);
});

test("agent names stay herdr-legal and are never what a label shows", () => {
  const name = agentName("review-branch-b5571dc-head", "review", "claude-opus", 12);
  expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  expect(tabLabel(GLYPH.running, "review", "diff")).not.toContain(name);
  // stepLabel is still what the run record carries for a variant.
  expect(stepLabel("review-x", "review", "claude-opus")).toBe("review-x/review/claude-opus");
});
