import { expect, test } from "bun:test";
import {
  agentName,
  disambiguate,
  evenRatio,
  GLYPH,
  paneLabel,
  stepLabel,
  tabLabel,
  tabNameOf,
  targetLabel,
} from "../src/naming";

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

test("a tab is a glyph and one word: the workflow, or the step", () => {
  expect(tabLabel(GLYPH.running, "implement")).toBe("⚙ implement");
  expect(tabLabel(GLYPH.running, "review")).toBe("⚙ review");
  expect(tabLabel(GLYPH.waiting, "plan")).toBe("⚠ plan");
  expect(tabLabel(GLYPH.done, "review")).toBe("✓ review");
  for (const label of [tabLabel(GLYPH.running, "review"), tabLabel(GLYPH.done, "implement")]) {
    expect(label).not.toMatch(/\d{8}-\d{6}/); // no run-id stamp
    expect(label).not.toContain("claude");
    expect(label).not.toContain("·");
  }
});

test("the target is appended only to break a collision, and read back off the label", () => {
  expect(disambiguate("review", "!123")).toBe("review · !123");
  expect(disambiguate("implement", "add-picker")).toBe("implement · add-picker");
  // Nothing to disambiguate with is still the plain name, never a dangling separator.
  expect(disambiguate("plan", "")).toBe("plan");

  // A collision is judged on the name, so the glyph a tab is wearing cannot hide one.
  expect(tabNameOf("⚙ review")).toBe("review");
  expect(tabNameOf("✓ review · !123")).toBe("review · !123");
  expect(tabNameOf("workflows")).toBe("workflows");
});

test("a pane names the model, or the step, or nothing at all", () => {
  const opus = { harness: "claude", model: "opus" };
  const pi = { harness: "pi", model: "openai-codex/gpt-5.6-sol" };

  // Parallel variants: the model alone, with the provider stripped off it.
  expect(paneLabel(opus, "review", 2, false)).toBe("opus");
  expect(paneLabel(pi, "review", 2, false)).toBe("gpt-5.6-sol");
  // The harness names the pane only where there is no model to name.
  expect(paneLabel({ harness: "claude", model: "default" }, "review", 2, false)).toBe("claude");
  expect(paneLabel({ harness: "pi", model: "default" }, "review", 2, false)).toBe("pi");

  // Alone in a tab, the tab has already said it.
  expect(paneLabel(opus, "build", 1, false)).toBeNull();
  // Sharing a tab with the panes it came from, it says which step it is.
  expect(paneLabel(opus, "synthesize", 1, true)).toBe("synthesize");
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
  expect(tabLabel(GLYPH.running, "review")).not.toContain(name);
  // stepLabel is still what the run record carries for a variant.
  expect(stepLabel("review-x", "review", "claude-opus")).toBe("review-x/review/claude-opus");
});
