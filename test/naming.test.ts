import { expect, test } from "bun:test";
import {
  agentName,
  disambiguate,
  displayName,
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

test("a tab is a glyph and one Capitalized word: the workflow, or the step", () => {
  expect(tabLabel(GLYPH.running, "implement")).toBe("⚙ Implement");
  expect(tabLabel(GLYPH.running, "review")).toBe("⚙ Review");
  expect(tabLabel(GLYPH.waiting, "plan")).toBe("⚠ Plan");
  expect(tabLabel(GLYPH.done, "review")).toBe("✓ Review");
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

  // The workflow is Capitalized; the target stays whatever it actually is, because
  // a branch prettied up is no longer the branch's name.
  expect(tabLabel(GLYPH.running, disambiguate("review", "!123"))).toBe("⚙ Review · !123");
  expect(tabLabel(GLYPH.done, disambiguate("implement", "add-picker"))).toBe("✓ Implement · add-picker");

  // A collision is judged on the name, so the glyph a tab is wearing cannot hide one.
  expect(tabNameOf("⚙ Review")).toBe("Review");
  expect(tabNameOf("✓ Review · !123")).toBe("Review · !123");
  expect(tabNameOf("Workflows")).toBe("Workflows");
});

test("a display name Capitalizes a word and leaves an id that is not one alone", () => {
  expect(displayName("implement")).toBe("Implement");
  expect(displayName("code-review")).toBe("Code-review");
  expect(displayName("gpt-5.6-sol")).toBe("gpt-5.6-sol");
  expect(displayName("Workflows")).toBe("Workflows");
  expect(displayName("")).toBe("");
});

test("a pane names the model, or the step, or nothing at all", () => {
  const opus = { harness: "claude", model: "opus" };
  const pi = { harness: "pi", model: "openai-codex/gpt-5.6-sol" };

  // Parallel variants: the model alone, with the provider stripped off it. A model
  // id that is not a word keeps its own casing.
  expect(paneLabel(opus, "review", 2, false)).toBe("Opus");
  expect(paneLabel(pi, "review", 2, false)).toBe("gpt-5.6-sol");
  // The harness names the pane only where there is no model to name.
  expect(paneLabel({ harness: "claude", model: "default" }, "review", 2, false)).toBe("Claude");
  expect(paneLabel({ harness: "pi", model: "default" }, "review", 2, false)).toBe("Pi");

  // Alone in a tab, the tab has already said it.
  expect(paneLabel(opus, "build", 1, false)).toBeNull();
  // Sharing a tab with the panes it came from, it says which step it is — and the
  // prefix `use:` gave that step's id is bookkeeping, not part of the name.
  expect(paneLabel(opus, "synthesize", 1, true)).toBe("Synthesize");
  expect(paneLabel(opus, "review.synthesize", 1, true)).toBe("Synthesize");
});

test("even splits leave every one of N panes the same width", () => {
  // Two variants: the first split halves the tab.
  expect(evenRatio(1, 2)).toBeCloseTo(1 / 2);
  // Three: 1/3 off the whole, then half of what is left.
  expect(evenRatio(1, 3)).toBeCloseTo(1 / 3);
  expect(evenRatio(2, 3)).toBeCloseTo(1 / 2);
});

test("a long model never truncates away the number that makes a name unique", () => {
  // The live failure: two runs, different seq, same 32-character name, and herdr
  // refused the second with `agent_name_taken`.
  const a = agentName("review-smoke-tab-16", "review", "pi-openai-codex/gpt-5.6-sol", 23);
  const b = agentName("review-smoke-tab-16", "review", "pi-openai-codex/gpt-5.6-sol", 24);

  expect(a).not.toBe(b);
  for (const name of [a, b]) {
    expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    expect(name.length).toBeLessThanOrEqual(32);
  }
  expect(a.endsWith("-r23")).toBe(true);
  expect(b.endsWith("-r24")).toBe(true);
  // A three-digit run number still fits, and still ends the name.
  expect(agentName("review-smoke-tab-16", "review", "pi-openai-codex/gpt-5.6-sol", 1234).endsWith("-r1234")).toBe(true);
  // A short variant still gets its slug prefix, as before.
  expect(agentName("review-x", "review", "claude-opus", 12)).toBe("review-x-review-claude-opus-r12");
});

test("agent names stay herdr-legal and are never what a label shows", () => {
  const name = agentName("review-branch-b5571dc-head", "review", "claude-opus", 12);
  expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  expect(tabLabel(GLYPH.running, "review")).not.toContain(name);
  // stepLabel is still what the run record carries for a variant.
  expect(stepLabel("review-x", "review", "claude-opus")).toBe("review-x/review/claude-opus");
});
