import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { Rig } from "./support/recorder";
import { FakeBin } from "./support/bin";
import { installBaseline, plannedRun, runWorkflow } from "./support/engine";
import { writeDef } from "./support/defs";

let rig: Rig;
let bin: FakeBin;

beforeEach(async () => {
  rig = new Rig();
  await rig.startSocket();
  installBaseline(rig);
  bin = new FakeBin(join(rig.root, "bin"));
  bin.add("glab", `exit 1`);
  bin.add("git", `echo main`);
  plannedRun(rig, "add-picker");
});

afterEach(async () => {
  bin.restore();
  await rig.close();
});

const CLEAN = { verdict: "clean", findings: [] };
const FINDING = {
  verdict: "findings",
  findings: [{ file: "cli.js", line: 4, severity: "blocker", title: "no exit code" }],
};
const OTHER_FINDING = {
  verdict: "findings",
  findings: [{ file: "cli.js", line: 2, severity: "minor", title: "loose equality" }],
};

test("the loop stops when every reviewer is clean, and skips the fix step", async () => {
  rig.queueOutputs([
    CLEAN, // build
    FINDING, // review/claude-sonnet, iteration 1
    OTHER_FINDING, // review/codex-gpt-5-codex, iteration 1
    { ...CLEAN, disputed: [{ file: "cli.js", severity: "minor", title: "loose equality", detail: "== is fine here" }] }, // fix
    CLEAN, // review/claude-sonnet, iteration 2
    CLEAN, // review/codex-gpt-5-codex, iteration 2
    CLEAN, // commit
    CLEAN, // verify
  ]);

  const { run, status, lines } = await runWorkflow(rig, "implement", {});

  expect(status).toBe("done");
  expect(run.record.iteration).toBe(2);
  expect(run.record.steps.map((s) => [s.id, s.status, s.note])).toEqual([
    ["build", "done", null],
    ["review", "done", null],
    ["fix", "done", "skipped: reviews clean"],
    ["commit", "done", null],
    ["verify", "done", null],
  ]);
  expect(lines).toContain("  reviews clean — skipping fix");
  expect(lines).toContain("  2 finding(s) to fix");

  // The union of both reviewers reaches the implementer.
  const fixPrompt = readFileSync(join(run.dir, "steps", "fix", "prompt-1.md"), "utf8");
  expect(fixPrompt).toContain("- [blocker] no exit code (cli.js:4)");
  expect(fixPrompt).toContain("- [minor] loose equality (cli.js:2)");
  expect(fixPrompt).toContain("Iteration 1 of at most 5");

  expect(run.record.summary).toContain("Disputed findings");
  expect(run.record.summary).toContain("- [minor] loose equality");
});

test("the loop stops at max_iterations and blocks rather than committing", async () => {
  // A project-layer override changes the cap without touching the baseline.
  writeDef(
    join(rig.projectDir, ".herdr"),
    "workflows",
    "implement",
    readFileSync(join(rig.baselineDir, "workflows", "implement.md"), "utf8").replace(
      "max_iterations: 5",
      "max_iterations: 2",
    ),
  );
  rig.queueOutputs([CLEAN, FINDING, FINDING, CLEAN, FINDING, FINDING, CLEAN, CLEAN, CLEAN]);

  const { run, status, lines } = await runWorkflow(rig, "implement", {});

  expect(status).toBe("blocked");
  expect(run.record.iteration).toBe(2);
  expect(run.step("fix").note).toBe("stopped at max_iterations 2 with 1 finding(s)");
  expect(run.step("commit").status).toBe("pending");
  expect(lines).toContain("  max_iterations (2) reached with 1 finding(s)");
  expect(run.record.summary).toContain("Findings still open:");
  expect(run.record.summary).toContain("- [blocker] no exit code (cli.js:4)");
  const toast = rig.calls().filter((c) => c.cmd === "notification show").at(-1)!.argv!;
  expect(toast).toContain("max_iterations reached with findings");
});

test("parallel reviewers get one tab each, named after step, harness and model", async () => {
  rig.queueOutputs([CLEAN, CLEAN, CLEAN, CLEAN, CLEAN]);

  const { run } = await runWorkflow(rig, "implement", {});

  const labels = rig
    .calls()
    .filter((c) => c.cmd === "tab create")
    .map((c) => c.argv!.at(-2));
  expect(labels).toEqual([
    "implement-add-picker/review/claude-opus",
    "implement-add-picker/review/claude-sonnet",
    "implement-add-picker/verify",
  ]);

  const reviewer = join(run.dir, "personas", "reviewer.md");
  const starts = rig.calls().filter((c) => c.cmd === "agent start");
  expect(starts.map((c) => c.argv!.slice(7))).toEqual([
    ["--", "--model", "sonnet", "--append-system-prompt-file", join(run.dir, "personas", "implementer.md")],
    ["--", "--model", "opus", "--effort", "xhigh", "--append-system-prompt-file", reviewer],
    ["--", "--model", "sonnet", "--effort", "xhigh", "--append-system-prompt-file", reviewer],
    ["--", "--model", "sonnet", "--append-system-prompt-file", reviewer],
  ]);
  expect(run.step("review").variants.map((v) => [v.model, v.effort])).toEqual([
    ["opus", "xhigh"],
    ["sonnet", "xhigh"],
  ]);

  const marks = rig.calls().filter((c) => c.cmd === "tab rename");
  expect(marks.map((c) => c.argv![3]).filter((l) => l!.startsWith("✓"))).toEqual([
    "✓ implement-add-picker/review/claude-opus",
    "✓ implement-add-picker/review/claude-sonnet",
    "✓ implement-add-picker/verify",
  ]);
});

test("fresh: true restarts the agent in a new pane; the default re-prompts the same one", async () => {
  rig.queueOutputs([CLEAN, FINDING, FINDING, CLEAN, CLEAN, CLEAN, CLEAN, CLEAN]);

  const { run } = await runWorkflow(rig, "implement", {});

  const cmds = rig.cmds();
  // Two reviewers started twice (fresh), the implementer once for four prompts.
  expect(cmds.filter((c) => c === "agent start")).toHaveLength(6);
  expect(cmds.filter((c) => c === "pane close")).toHaveLength(2);

  const implementer = run.step("build").variants[0]!.agent;
  expect(run.step("fix").variants[0]!.agent).toBe(implementer);
  expect(run.step("commit").variants[0]!.agent).toBe(implementer);

  const prompted = rig
    .calls()
    .filter((c) => c.cmd === "agent prompt")
    .map((c) => c.argv![2]);
  expect(prompted.filter((a) => a === implementer)).toHaveLength(3);
});

test("the implementer keeps its pane across iterations while reviewers get new ones", async () => {
  rig.queueOutputs([CLEAN, FINDING, FINDING, CLEAN, CLEAN, CLEAN, CLEAN, CLEAN]);

  const { run } = await runWorkflow(rig, "implement", {});

  const reviewPanes = run.step("review").variants.map((v) => v.paneId);
  const closed = rig
    .calls()
    .filter((c) => c.cmd === "pane close")
    .map((c) => c.argv![2]);
  expect(closed).not.toContain(run.step("build").variants[0]!.paneId);
  expect(reviewPanes).not.toContain(closed[0]);
  expect(run.step("review").variants.every((v) => v.tabId !== null)).toBe(true);
});

test("the sidebar filter grows to every pane the run owns and is cleared at the end", async () => {
  rig.queueOutputs([CLEAN, CLEAN, CLEAN, CLEAN, CLEAN]);

  const { run } = await runWorkflow(rig, "implement", {});

  const views = rig.calls().filter((c) => c.cmd === "agent.view.set");
  const last = views.at(-1)!.params as { filter: { values: string[] }; label: string };
  expect(last.label).toBe(run.record.slug);
  expect(last.filter.values).toEqual(["1-1", "1-2", "1-3", "1-4"]);
  expect(views.map((v) => (v.params as { filter: { values: string[] } }).filter.values.length)).toEqual([1, 2, 3, 4]);
  expect(rig.cmds().at(-2)).toBe("agent.view.clear");
});
