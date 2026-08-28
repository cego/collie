import { afterEach, beforeEach, expect, test } from "bun:test";
import { join, relative } from "node:path";
import { readFileSync } from "node:fs";
import { Rig } from "./support/recorder";
import { FakeBin } from "./support/bin";
import { installBaseline, plannedRun, runWorkflow } from "./support/engine";
import { writeDef } from "./support/defs";
import { FALLBACK_DEFAULTS } from "../src/config";
import { layers, loadDefinitions, resolveWorkflow, validateWorkflow } from "../src/definitions";

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

/** Which step each prompt went to, in order — i.e. the path the run took. */
function promptOrder(rig: Rig, runDir: string): string[] {
  return rig
    .calls()
    .filter((c) => c.cmd === "agent prompt")
    .map((c) => relative(runDir, /is in (\S+)/.exec(c.argv![3]!)![1]!));
}

test("implement is build, architecture, simplify, review, fix — and no commit step", () => {
  const defs = loadDefinitions(layers(rig.pluginEnv()));
  const wf = resolveWorkflow("implement", defs, FALLBACK_DEFAULTS);

  expect(wf.steps.map((s) => s.id)).toEqual(["build", "architecture", "simplify", "review", "fix"]);
  expect(wf.steps.map((s) => s.agent)).toEqual([undefined, "build", "build", undefined, "build"]);
  expect(wf.steps[4]!.repeat).toEqual({ from: "review", back_to: "simplify" });
  expect(wf.maxIterations).toBe(5);
  expect(validateWorkflow(wf, defs, FALLBACK_DEFAULTS)).toEqual([]);

  const build = wf.steps[0]!.prompt;
  expect(build).toContain("Branch off the default branch");
  expect(build).toContain("one commit per ticket");
  expect(build).toContain("/tdd");
  expect(wf.steps.some((s) => /commit the work|commit step/i.test(s.prompt) && s.id !== "build")).toBe(false);
});

test("findings loop fix → simplify → review, and architecture stays out of the loop", async () => {
  rig.queueOutputs([
    CLEAN, // build
    CLEAN, // architecture
    CLEAN, // simplify
    FINDING, // review/claude-opus
    OTHER_FINDING, // review/claude-sonnet
    { ...CLEAN, disputed: [{ file: "cli.js", severity: "minor", title: "loose equality", detail: "== is fine here" }] }, // fix
    CLEAN, // simplify, iteration 2
    CLEAN, // review/claude-opus
    CLEAN, // review/claude-sonnet
  ]);

  const { run, status, lines } = await runWorkflow(rig, "implement", {});

  expect(status).toBe("done");
  expect(run.record.iteration).toBe(2);
  expect(promptOrder(rig, run.dir)).toEqual([
    "steps/build/prompt-1.md",
    "steps/architecture/prompt-1.md",
    "steps/simplify/prompt-1.md",
    "steps/review/claude-opus/prompt-1.md",
    "steps/review/claude-sonnet/prompt-1.md",
    "steps/fix/prompt-1.md",
    "steps/simplify/prompt-2.md",
    "steps/review/claude-opus/prompt-2.md",
    "steps/review/claude-sonnet/prompt-2.md",
  ]);
  expect(run.record.steps.map((s) => [s.id, s.status, s.note])).toEqual([
    ["build", "done", null],
    ["architecture", "done", null],
    ["simplify", "done", null],
    ["review", "done", null],
    ["fix", "done", "skipped: reviews clean"],
  ]);
  expect(lines).toContain("  2 finding(s) to fix");
  expect(lines).toContain("  looping back to simplify (iteration 2)");
  expect(lines).toContain("  reviews clean — skipping fix");

  // The union of both reviewers reaches the implementer.
  const fix = readFileSync(join(run.dir, "steps", "fix", "prompt-1.md"), "utf8");
  expect(fix).toContain("- [blocker] no exit code (cli.js:4)");
  expect(fix).toContain("- [minor] loose equality (cli.js:2)");
  expect(fix).toContain("Iteration 1 of at most 5");
  expect(run.record.summary).toContain("Disputed findings");
}, 20_000);

test("the loop stops at max_iterations and blocks with the findings still open", async () => {
  writeDef(
    join(rig.projectDir, ".herdr"),
    "workflows",
    "implement",
    readFileSync(join(rig.baselineDir, "workflows", "implement.md"), "utf8").replace(
      "max_iterations: 5",
      "max_iterations: 2",
    ),
  );
  rig.queueOutputs([CLEAN, CLEAN, CLEAN, FINDING, FINDING, CLEAN, CLEAN, FINDING, FINDING, CLEAN]);

  const { run, status, lines } = await runWorkflow(rig, "implement", {});

  expect(status).toBe("blocked");
  expect(run.record.iteration).toBe(2);
  expect(run.step("fix").note).toBe("stopped at max_iterations 2 with 1 finding(s)");
  expect(lines).toContain("  max_iterations (2) reached with 1 finding(s)");
  expect(run.record.summary).toContain("Findings still open:");
  expect(run.record.summary).toContain("- [blocker] no exit code (cli.js:4)");
}, 20_000);

test("the reviewers are one persona at two models, in a tab each, restarted every round", async () => {
  rig.queueOutputs([CLEAN, CLEAN, CLEAN, FINDING, FINDING, CLEAN, CLEAN, CLEAN, CLEAN]);

  const { run } = await runWorkflow(rig, "implement", {});

  expect(rig.calls().filter((c) => c.cmd === "tab create").map((c) => c.argv!.at(-2))).toEqual([
    "implement-add-picker/review/claude-opus",
    "implement-add-picker/review/claude-sonnet",
  ]);

  const reviewer = join(run.dir, "personas", "reviewer.md");
  const starts = rig.calls().filter((c) => c.cmd === "agent start");
  expect(starts.map((c) => c.argv!.slice(7))).toEqual([
    ["--", "--model", "sonnet", "--append-system-prompt-file", join(run.dir, "personas", "implementer.md")],
    ["--", "--model", "opus", "--effort", "xhigh", "--append-system-prompt-file", reviewer],
    ["--", "--model", "sonnet", "--effort", "xhigh", "--append-system-prompt-file", reviewer],
    ["--", "--model", "opus", "--effort", "xhigh", "--append-system-prompt-file", reviewer],
    ["--", "--model", "sonnet", "--effort", "xhigh", "--append-system-prompt-file", reviewer],
  ]);
  expect(run.step("review").variants.map((v) => [v.model, v.effort])).toEqual([
    ["opus", "xhigh"],
    ["sonnet", "xhigh"],
  ]);

  // One implementer throughout: build, architecture, simplify and fix share its agent.
  const implementer = run.step("build").variants[0]!.agent;
  for (const step of ["architecture", "simplify", "fix"]) {
    expect(run.step(step).variants[0]!.agent).toBe(implementer);
  }
  expect(rig.cmds().filter((c) => c === "pane close")).toHaveLength(2);
}, 20_000);

test("review standalone is the same two variants, and says so when it has no spec", async () => {
  rig.queueOutputs([CLEAN, CLEAN]);

  const { run, status } = await runWorkflow(rig, "review", {});

  expect(status).toBe("done");
  expect(run.record.steps[0]!.variants.map((v) => [v.harness, v.model, v.effort])).toEqual([
    ["claude", "opus", "xhigh"],
    ["claude", "sonnet", "xhigh"],
  ]);
  const prompt = readFileSync(join(run.dir, "steps", "review", "claude-opus", "prompt-1.md"), "utf8");
  expect(prompt).toContain("Review target: worktree");
  expect(prompt).toContain("Spec: \n");
  expect(prompt).toContain("there is no spec");
  expect(readFileSync(join(run.dir, "log.txt"), "utf8")).toContain("unknown template keys in review: inputs.plan");
});

test("review inside implement is held to the plan the run was given", async () => {
  rig.queueOutputs([CLEAN, CLEAN, CLEAN, CLEAN, CLEAN]);

  const { run } = await runWorkflow(rig, "implement", {});

  const prompt = readFileSync(join(run.dir, "steps", "review", "claude-opus", "prompt-1.md"), "utf8");
  expect(prompt).toContain(`Spec: ${run.record.inputs.plan}`);
  expect(run.record.inputs.plan).toContain("/plan");
});

const DISPUTED_REASON = { file: "cli.js", severity: "minor", title: "no exit code", detail: "the spec asks for this" };

test("a finding the implementer disputed stops driving the loop, so the run converges", async () => {
  rig.queueOutputs([
    CLEAN, // build
    CLEAN, // architecture
    CLEAN, // simplify
    FINDING, // review/claude-opus
    FINDING, // review/claude-sonnet
    { ...CLEAN, disputed: [DISPUTED_REASON] }, // fix: applies nothing, disputes it
    CLEAN, // simplify, iteration 2
    FINDING, // review/claude-opus, raises it again
    FINDING, // review/claude-sonnet, raises it again
  ]);

  const { run, status, lines } = await runWorkflow(rig, "implement", {});

  expect(status).toBe("done");
  expect(run.record.iteration).toBe(2);
  expect(run.step("fix").note).toBe("skipped: reviews clean");
  expect(lines).toContain("  1 finding(s) already disputed — your call, not the loop's");
  expect(run.record.summary).toContain("Disputed findings");
  expect(run.record.summary).toContain("- [minor] no exit code (cli.js)");

  // The reviewers were told what had already been argued.
  const second = readFileSync(join(run.dir, "steps", "review", "claude-opus", "prompt-2.md"), "utf8");
  expect(second).toContain("Already disputed");
  expect(second).toContain("- [minor] no exit code (cli.js)");
  expect(second).toContain("the spec asks for this");
}, 20_000);

test("a reviewer that answers the dispute puts the finding back in front of the implementer", async () => {
  const rebutted = {
    verdict: "findings",
    findings: [{ ...FINDING.findings[0], rebuttal: "the spec's own out-of-scope line says otherwise" }],
  };
  rig.queueOutputs([
    CLEAN, // build
    CLEAN, // architecture
    CLEAN, // simplify
    FINDING, // review/claude-opus
    FINDING, // review/claude-sonnet
    { ...CLEAN, disputed: [DISPUTED_REASON] }, // fix disputes it
    CLEAN, // simplify, iteration 2
    rebutted, // review/claude-opus answers the dispute
    CLEAN, // review/claude-sonnet
    CLEAN, // fix applies it
    CLEAN, // simplify, iteration 3
    CLEAN, // review/claude-opus
    CLEAN, // review/claude-sonnet
  ]);

  const { run, status, lines } = await runWorkflow(rig, "implement", {});

  expect(status).toBe("done");
  expect(run.record.iteration).toBe(3);
  expect(lines).toContain("  1 disputed finding(s) answered by a reviewer");
  // The argument moved on, so the dispute is no longer standing.
  expect(run.record.disputed).toEqual([]);

  const fix = readFileSync(join(run.dir, "steps", "fix", "prompt-2.md"), "utf8");
  expect(fix).toContain("- [blocker] no exit code (cli.js:4)");
  expect(fix).toContain("answers your dispute: the spec's own out-of-scope line says otherwise");
  // Three iterations of a five-step workflow is a lot of fake agents.
}, 20_000);

test("the build prompt is told which kind of work source it got, and nothing renders empty", async () => {
  rig.queueOutputs([CLEAN, CLEAN, CLEAN, CLEAN, CLEAN]);

  const { run } = await runWorkflow(rig, "implement", {});

  const build = readFileSync(join(run.dir, "steps", "build", "prompt-1.md"), "utf8");
  expect(build).toContain("Work source (plan-dir):");
  // The three branches have to survive templating, or the implementer cannot choose one.
  for (const kind of ["**plan-dir**", "**linear**", "**text**"]) expect(build).toContain(kind);
  // A key the run never set renders empty and is only visible in the log.
  expect(readFileSync(join(run.dir, "log.txt"), "utf8")).not.toContain("unknown template keys");
}, 20_000);
