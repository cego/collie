import { expect, test } from "bun:test";
import {
  agentName,
  COLLIE_TAB,
  disambiguate,
  displayName,
  evenRatio,
  GLYPH,
  insertIndexFor,
  isCollieTab,
  LEGACY_TABS,
  rankOf,
  paneLabel,
  stepLabel,
  tabLabel,
  tabNameOf,
  targetLabel,
  runTabLabel,
  tabGlyph,
  tabLabelsFor,
  type LabelledRun,
} from "../src/naming";

test("a review's target is short and human, and never a sha", () => {
  expect(targetLabel("review", "review-x", { target: "mr:123" })).toBe("!123");
  expect(targetLabel("review", "review-x", { target: "worktree" })).toBe("worktree");
  expect(targetLabel("review", "review-x", { target: "branch:main...add-picker" })).toBe(
    "add-picker",
  );

  // The case that produced `review-branch-b5571dc-head` as a run name.
  const opaque = targetLabel("review", "review-branch-b5571dc-head", {
    target: "branch:b5571dc...HEAD",
  });
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
  expect(tabLabel(GLYPH.done, disambiguate("implement", "add-picker"))).toBe(
    "✓ Implement · add-picker",
  );

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
  expect(
    agentName("review-smoke-tab-16", "review", "pi-openai-codex/gpt-5.6-sol", 1234).endsWith(
      "-r1234",
    ),
  ).toBe(true);
  // A short variant still gets its slug prefix, as before.
  expect(agentName("review-x", "review", "claude-opus", 12)).toBe(
    "review-x-review-claude-opus-r12",
  );
});

test("agent names stay herdr-legal and are never what a label shows", () => {
  const name = agentName("review-branch-b5571dc-head", "review", "claude-opus", 12);
  expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  expect(tabLabel(GLYPH.running, "review")).not.toContain(name);
  // stepLabel is still what the run record carries for a variant.
  expect(stepLabel("review-x", "review", "claude-opus")).toBe("review-x/review/claude-opus");
});

test("a new tab lands after the last Collie tab it does not outrank", () => {
  expect(rankOf("plan")).toBeLessThan(rankOf("implement"));
  expect(rankOf("implement")).toBeLessThan(rankOf("review"));
  // A fork, or a workflow nobody ordered, comes after all of them.
  expect(rankOf("architecture")).toBeGreaterThan(rankOf("review"));

  const board = { rank: null, board: true };
  const foreign = { rank: null, board: false };
  const tab = (workflow: string) => ({ rank: rankOf(workflow), board: false });

  expect(insertIndexFor([board], rankOf("review"))).toBe(1);
  // The case this exists for: review started first, implement still comes first.
  expect(insertIndexFor([board, tab("plan"), tab("review")], rankOf("implement"))).toBe(2);
  // Ties keep start order: the second implement run's tab goes after the first's.
  expect(insertIndexFor([board, tab("implement"), tab("implement")], rankOf("implement"))).toBe(3);
  // A tab Collie does not own is never an anchor, and never moves.
  expect(insertIndexFor([board, foreign, tab("review"), foreign], rankOf("plan"))).toBe(1);
  // Two unknown workflows keep the order they started in.
  expect(insertIndexFor([board, tab("architecture")], rankOf("architecture"))).toBe(2);
  // The pin failed, so there is no board: the tab still lands ahead of lower ranks.
  expect(insertIndexFor([foreign, tab("review")], rankOf("plan"))).toBe(0);
  expect(insertIndexFor([], rankOf("plan"))).toBe(0);
});

test("the Collie tab's label survives its own helpers", () => {
  expect(COLLIE_TAB).toBe("🐕 Collie");
  const name = tabNameOf(COLLIE_TAB);
  expect(name).toBe("Collie");
  // Without the u flag the dog enters the character class as two surrogate halves
  // and stripping matches one of them, leaving a lone surrogate in the name.
  expect(Array.from(name)).toHaveLength(6);
  // A run tab keeps its status glyph and gains no dog.
  expect(tabNameOf(tabLabel(GLYPH.running, "implement"))).toBe("Implement");
  // Every name this tab has worn is still matched, or a rename duplicates the tab.
  expect(LEGACY_TABS).toContain("Control Plane");
  expect(isCollieTab("Control Plane")).toBe(true);
  expect(isCollieTab(COLLIE_TAB)).toBe(true);
  expect(isCollieTab("Implement")).toBe(false);
});

/** A run record, as much of one as a tab label is made of. */
function labelled(over: Partial<LabelledRun> = {}): LabelledRun {
  return {
    workflow: "implement",
    slug: "implement-control-plane-glass",
    inputs: { target: "branch:master...control-plane-glass" },
    target_label: "control-plane-glass",
    status: "running",
    max_iterations: 5,
    steps: [{ id: "fix", status: "running", iteration: 3, variants: [] }],
    ...over,
  };
}

test("a run's tab says which step it is on, and how far into its loop", () => {
  expect(runTabLabel(GLYPH.running, labelled(), false)).toBe(
    "⚙ Implement · control-plane-glass · fix 3/5",
  );
  // A step that has not looped has no round to report, only its own name — which is
  // every step of a workflow with no fix loop in it, and every step before one.
  expect(
    runTabLabel(
      GLYPH.running,
      labelled({
        workflow: "plan",
        steps: [{ id: "draft", status: "running", iteration: 1, variants: [] }],
      }),
      false,
    ),
  ).toBe("⚙ Plan · control-plane-glass · draft");
  // A question is the one thing worth saying instead of the step it is asked from.
  expect(runTabLabel(GLYPH.waiting, labelled(), true)).toBe(
    "⚠ Implement · control-plane-glass · asks you",
  );
  // A run that is over is what it was, and no step.
  expect(runTabLabel(GLYPH.done, labelled({ status: "done" }), false)).toBe(
    "✓ Implement · control-plane-glass",
  );
  expect(runTabLabel(GLYPH.failed, labelled({ status: "failed" }), false)).toBe(
    "✗ Implement · control-plane-glass",
  );
  // Between steps there is no step to name, and the run is not over either.
  expect(
    runTabLabel(
      GLYPH.running,
      labelled({ steps: [{ id: "fix", status: "done", iteration: 3, variants: [] }] }),
      false,
    ),
  ).toBe("⚙ Implement · control-plane-glass");
  // A record written before targets were kept still names what it was pointed at.
  expect(runTabLabel(GLYPH.running, labelled({ target_label: null }), false)).toBe(
    "⚙ Implement · control-plane-glass · fix 3/5",
  );
});

test("a tab's glyph is the state of what is in it, not of the last step that ran", () => {
  const run = labelled();
  // Anything working means work is happening in there, whatever the run last recorded.
  expect(tabGlyph(["idle", "working"], run, false)).toBe(GLYPH.running);
  expect(tabGlyph(["working"], labelled({ status: "done" }), false)).toBe(GLYPH.running);
  // A human is needed: herdr's own word for it, and Collie's own question.
  expect(tabGlyph(["blocked", "idle"], run, false)).toBe(GLYPH.waiting);
  expect(tabGlyph(["idle"], run, true)).toBe(GLYPH.waiting);
  // Nothing working: the run's own state, so a finished run's idle agent reads ✓ and
  // an unfinished one's reads ⚙ — which is what a hand-off leaves behind.
  expect(tabGlyph(["idle", "done"], labelled({ status: "done" }), false)).toBe(GLYPH.done);
  expect(tabGlyph(["idle", "done"], run, false)).toBe(GLYPH.running);
  expect(tabGlyph(["done"], labelled({ status: "failed" }), false)).toBe(GLYPH.failed);
  expect(tabGlyph(["done"], labelled({ status: "blocked" }), false)).toBe(GLYPH.waiting);
  // An agent herdr no longer has says nothing either way.
  expect(tabGlyph([], labelled({ status: "done" }), false)).toBe(GLYPH.done);
});

test("every tab of a run wears the run's sentence and its own glyph", () => {
  const run = labelled({
    steps: [
      { id: "build", status: "done", iteration: 1, variants: [{ agent: "build-r1", tabId: "t1" }] },
      {
        id: "fix",
        status: "running",
        iteration: 3,
        variants: [
          { agent: "fix-r1", tabId: "t2" },
          { agent: "fix-r2", tabId: "t2" },
        ],
      },
    ],
  });
  const statuses = new Map([
    ["build-r1", "idle"],
    ["fix-r1", "idle"],
    ["fix-r2", "working"],
  ]);
  const live = (agent: string) => statuses.get(agent);
  expect(tabLabelsFor(run, live, false)).toEqual(
    new Map([
      // Nothing working in the first tab, and the run is not over: still ⚙.
      ["t1", "⚙ Implement · control-plane-glass · fix 3/5"],
      ["t2", "⚙ Implement · control-plane-glass · fix 3/5"],
    ]),
  );
  // The glyph is per tab: the one with the working agent keeps ⚙ once the run is done.
  expect(tabLabelsFor({ ...run, status: "done" }, live, false)).toEqual(
    new Map([
      ["t1", "✓ Implement · control-plane-glass"],
      ["t2", "⚙ Implement · control-plane-glass"],
    ]),
  );
  // A variant that never opened a tab is not a tab.
  expect(
    tabLabelsFor(
      labelled({
        steps: [
          { id: "fix", status: "running", iteration: 1, variants: [{ agent: "a", tabId: null }] },
        ],
      }),
      () => "idle",
      false,
    ).size,
  ).toBe(0);
});
