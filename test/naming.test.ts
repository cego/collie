import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import {
  agentTabLabel,
  agentName,
  COLLIE_TAB,
  disambiguate,
  displayName,
  evenRatio,
  GLYPH,
  paneLabel,
  stepLabel,
  tabLabel,
  tabNameOf,
  targetLabel,
  taskWorkspaceLabel,
} from "../src/naming";

test("a review's target is short and human, and never a sha", () => {
  expect(targetLabel("review", "review-x", "mr:123")).toBe("!123");
  expect(targetLabel("review", "review-x", "worktree")).toBe("worktree");
  expect(targetLabel("review", "review-x", "branch:main...add-picker")).toBe("add-picker");

  const opaque = targetLabel("review", "review-branch-b5571dc-head", "branch:b5571dc...HEAD");
  expect(opaque).toBe("diff");
  expect(opaque).not.toMatch(/[0-9a-f]{7}/i);
  expect(targetLabel("review", "r", "branch:b5571dc...add-picker")).toBe("add-picker");
  expect(targetLabel("review", "r", "branch:main...HEAD")).toBe("main");
});

test("workflows with no target are named by their slug, without repeating the workflow", () => {
  expect(targetLabel("implement", "implement-add-picker", "")).toBe("add-picker");
  expect(targetLabel("plan", "plan-add-picker", "")).toBe("add-picker");
  expect(targetLabel("architecture", "architecture-run", "")).toBe("run");
  expect(targetLabel("implement", "something-else", "")).toBe("something-else");
});

test("a tab is a glyph and one Capitalized word: the workflow, or the step", () => {
  expect(tabLabel(GLYPH.running, "implement")).toBe("⚙ Implement");
  expect(tabLabel(GLYPH.running, "review")).toBe("⚙ Review");
  expect(tabLabel(GLYPH.waiting, "plan")).toBe("⚠ Plan");
  expect(tabLabel(GLYPH.done, "review")).toBe("✓ Review");
  for (const label of [tabLabel(GLYPH.running, "review"), tabLabel(GLYPH.done, "implement")]) {
    expect(label).not.toMatch(/\d{8}-\d{6}/);
    expect(label).not.toContain("claude");
    expect(label).not.toContain("·");
  }
});

test("the target is appended only to break a collision, and read back off the label", () => {
  expect(disambiguate("review", "!123")).toBe("review · !123");
  expect(disambiguate("implement", "add-picker")).toBe("implement · add-picker");
  expect(disambiguate("plan", "")).toBe("plan");

  expect(tabLabel(GLYPH.running, disambiguate("review", "!123"))).toBe("⚙ Review · !123");
  expect(tabLabel(GLYPH.done, disambiguate("implement", "add-picker"))).toBe(
    "✓ Implement · add-picker",
  );

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

  expect(paneLabel(opus, "review", 2, false)).toBe("Opus");
  expect(paneLabel(pi, "review", 2, false)).toBe("gpt-5.6-sol");
  expect(paneLabel({ harness: "claude", model: "default" }, "review", 2, false)).toBe("Claude");
  expect(paneLabel({ harness: "pi", model: "default" }, "review", 2, false)).toBe("Pi");

  expect(paneLabel(opus, "build", 1, false)).toBeNull();
  expect(paneLabel(opus, "synthesize", 1, true)).toBe("Synthesize");
  expect(paneLabel(opus, "review.synthesize", 1, true)).toBe("Synthesize");
});

test("even splits leave every one of N panes the same width", () => {
  expect(evenRatio(1, 2)).toBeCloseTo(1 / 2);
  expect(evenRatio(1, 3)).toBeCloseTo(1 / 3);
  expect(evenRatio(2, 3)).toBeCloseTo(1 / 2);
});

test("a long model never truncates away the number that makes a name unique", () => {
  const a = agentName("review-smoke-tab-16", "review", "pi-openai-codex/gpt-5.6-sol", 23);
  const b = agentName("review-smoke-tab-16", "review", "pi-openai-codex/gpt-5.6-sol", 24);

  expect(a).not.toBe(b);
  for (const name of [a, b]) {
    expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    expect(name.length).toBeLessThanOrEqual(32);
  }
  expect(pipe(a, Str.endsWith("-r23"))).toBe(true);
  expect(pipe(b, Str.endsWith("-r24"))).toBe(true);
  expect(
    pipe(
      agentName("review-smoke-tab-16", "review", "pi-openai-codex/gpt-5.6-sol", 1234),
      Str.endsWith("-r1234"),
    ),
  ).toBe(true);
  expect(agentName("review-x", "review", "claude-opus", 12)).toBe(
    "review-x-review-claude-opus-r12",
  );
});

test("long numeric steps keep every generation suffix when the legal name needs a letter prefix", () => {
  const generations = [1, 2, 10, 11];
  const names = Arr.map(generations, (sequence) =>
    agentName(
      "run-71558ed9.implement.implement-.",
      "01-public-text-is-checked-and-marked-hidden.md.review-2-1",
      null,
      sequence,
    ),
  );
  expect(new Set(names).size).toBe(generations.length);
  for (let index = 0; index < names.length; index++) {
    expect(names[index]).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    expect(names[index]).toEndWith(`-r${generations[index]}`);
  }
});

test("sibling children that share a long prefix get agents of their own", () => {
  const nuxt = agentName(
    "run-053c5b9d.implement.implement-gitlab.cego.dk-cego-ci-modules-nuxt",
    "build",
    null,
    1,
  );
  const gateway = agentName(
    "run-053c5b9d.implement.implement-gitlab.cego.dk-spilnu-gateway",
    "build",
    null,
    1,
  );

  expect(nuxt).not.toBe(gateway);
  for (const name of [nuxt, gateway]) {
    expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
    expect(name).toStartWith("run-053c5b9d");
    expect(name).toContain("-build-");
    expect(name).toEndWith("-r1");
  }
  const step = "a-very-long-operation-name-here";
  const crowded = Arr.map(["a", "b"], (repo) =>
    agentName(`run-053c5b9d.implement.implement-gitlab.cego.dk-${repo}`, step, null, 1),
  );
  expect(crowded[0]).not.toBe(crowded[1]);
  for (const name of crowded) expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  expect(agentName("run-053c5b9d", "build", null, 1)).toBe("run-053c5b9d-build-r1");
});

test("two steps of one Run that differ only where the name is cut get agents of their own", () => {
  const seats = Arr.map(["review-2-correctness-a", "review-2-correctness-b"], (step) =>
    agentName("run-053c5b9d", step, null, 1),
  );
  expect(seats[0]).not.toBe(seats[1]);
  for (const name of seats) expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  const panel = Arr.map(["security", "standards"], (seat) =>
    agentName("run-053c5b9d", "review", `claude-opus-${seat}`, 1),
  );
  expect(panel[0]).not.toBe(panel[1]);
});

test("agent names stay herdr-legal and are never what a label shows", () => {
  const name = agentName("review-branch-b5571dc-head", "review", "claude-opus", 12);
  expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
  expect(stepLabel("review-x", "review", "claude-opus")).toBe("review-x/review/claude-opus");
});

test("the Collie tab's label survives its own helpers", () => {
  expect(tabNameOf(COLLIE_TAB)).toBe("Collie");
  expect(Array.from(tabNameOf("🐕 Collie"))).toHaveLength(6);
  expect(tabNameOf(tabLabel(GLYPH.running, "implement"))).toBe("Implement");
});

test("a task workspace is named for its project and what the task is", () => {
  expect(taskWorkspaceLabel({ project: "Collie", title: "Task workspaces" })).toBe(
    "Collie | Task workspaces",
  );
  expect(taskWorkspaceLabel({ project: " Collie \n", title: "Task\tworkspaces " })).toBe(
    "Collie | Task workspaces",
  );
  expect(taskWorkspaceLabel({ project: "", title: "Task workspaces" })).toBe("Task workspaces");
  expect(taskWorkspaceLabel({ project: "Collie", title: "" })).toBe("Collie");
  expect(taskWorkspaceLabel({ project: " monorepo ", title: "FRO-343" })).toBe(
    "Monorepo | FRO-343",
  );
});

test("an agent's tab names its role, and the one piece of work an agent of its own does", () => {
  expect(agentTabLabel({ role: "implementer", operation: "build", agent: "builder" })).toBe(
    "Implementer",
  );
  expect(agentTabLabel({ role: "reviewer", operation: "review-1", agent: null })).toBe(
    "Reviewer · review-1",
  );
  expect(agentTabLabel({ role: "reviewer", operation: "use:review.synthesize", agent: null })).toBe(
    "Reviewer · synthesize",
  );
});
