import { afterEach, beforeEach, expect, test } from "bun:test";
import { join, relative } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
/** What the synthesiser writes: one review, and the summary a human reads first. */
const SUMMARY = "Adds a --version flag to the CLI. ";
const SYNTH = { ...CLEAN, summary: `${SUMMARY}Nothing wrong with it.` };
const synthesized = (...raw: { findings: unknown[] }[]) => ({
  verdict: "findings",
  summary: `${SUMMARY}The reviewers found something.`,
  findings: raw.flatMap((r) => r.findings),
});

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

  expect(wf.steps.map((s) => s.id)).toEqual([
    "build",
    "architecture",
    "simplify",
    "review",
    "review.synthesize",
    "fix",
    "mr",
  ]);
  expect(wf.steps.map((s) => s.agent)).toEqual([
    undefined,
    "build",
    "build",
    undefined,
    undefined,
    "build",
    "build",
  ]);
  // The gate is the one synthesised review, not the reviewers' raw union.
  expect(wf.steps[4]!.fanIn).toBe("review");
  expect(wf.steps[5]!.repeat).toEqual({ from: "review.synthesize", back_to: "simplify" });
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
    synthesized(FINDING, OTHER_FINDING), // review.synthesize
    { ...CLEAN, disputed: [{ file: "cli.js", severity: "minor", title: "loose equality", detail: "== is fine here" }] }, // fix
    CLEAN, // simplify, iteration 2
    CLEAN, // review/claude-opus
    CLEAN, // review/claude-sonnet
    SYNTH, // review.synthesize
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
    "steps/review.synthesize/prompt-1.md",
    "steps/fix/prompt-1.md",
    "steps/simplify/prompt-2.md",
    "steps/review/claude-opus/prompt-2.md",
    "steps/review/claude-sonnet/prompt-2.md",
    "steps/review.synthesize/prompt-2.md",
  ]);
  expect(run.record.steps.map((s) => [s.id, s.status, s.note])).toEqual([
    ["build", "done", null],
    ["architecture", "done", null],
    ["simplify", "done", null],
    ["review", "done", null],
    ["review.synthesize", "done", null],
    ["fix", "done", "skipped: reviews clean"],
    // No glab in the rig, so the MR step is skipped rather than failing the run.
    ["mr", "done", "skipped: glab is not installed"],
  ]);
  expect(lines).toContain("  2 finding(s) to fix");
  expect(lines).toContain("  looping back to simplify (iteration 2)");
  expect(lines).toContain("  reviews clean — skipping fix");

  // One synthesised review reaches the implementer, carrying both reviewers' findings.
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
  rig.queueOutputs([
    CLEAN, CLEAN, CLEAN, FINDING, FINDING, synthesized(FINDING),
    CLEAN, CLEAN, FINDING, FINDING, synthesized(FINDING), CLEAN,
  ]);

  const { run, status, lines } = await runWorkflow(rig, "implement", {});

  expect(status).toBe("blocked");
  expect(run.record.iteration).toBe(2);
  expect(run.step("fix").note).toBe("stopped at max_iterations 2 with 1 finding(s)");
  expect(lines).toContain("  max_iterations (2) reached with 1 finding(s)");
  expect(run.record.summary).toContain("Findings still open:");
  expect(run.record.summary).toContain("- [blocker] no exit code (cli.js:4)");
}, 20_000);

test("the reviewers are one persona at two models, side by side in one tab, restarted every round", async () => {
  rig.queueOutputs([
    CLEAN, CLEAN, CLEAN, FINDING, FINDING, synthesized(FINDING),
    CLEAN, CLEAN, CLEAN, CLEAN, SYNTH,
  ]);

  const { run } = await runWorkflow(rig, "implement", {});

  // Two tabs, each one word: the run's own takes the workflow, the review step's
  // takes the step. No target, no slug, no model — and the review step keeps its
  // tab across both iterations.
  const created = rig.calls().filter((c) => c.cmd === "tab create");
  expect(created.map((c) => c.argv!.at(-2))).toEqual(["⚙ Implement", "⚙ Review"]);
  expect(new Set(run.step("review").variants.map((v) => v.tabId)).size).toBe(1);

  // The second variant sits beside the first, each taking half the tab. A restart
  // splits without a ratio and closes the old pane, so it lands in the same slot.
  const rightSplits = rig.calls().filter((c) => c.cmd === "pane split" && c.argv!.includes("right"));
  const sideBySide = rightSplits.filter((c) => c.argv!.includes("--ratio"));
  expect(sideBySide).toHaveLength(1);
  for (const split of sideBySide) {
    expect(split.argv![split.argv!.indexOf("--ratio") + 1]).toBe("0.5");
  }
  // The two reviewers and the synthesiser, all restarted for the second round.
  expect(rightSplits.length - sideBySide.length).toBe(3);
  // Parallel panes say which model they are, and nothing else does: the run's own
  // pane on the board says the workflow, and no pane anywhere names the run.
  const renames = rig.calls().filter((c) => c.cmd === "pane rename");
  const agentPanes = renames.filter((c) => c.argv![2] !== "1-0").map((c) => c.argv!.at(-1));
  expect(agentPanes).toContain("Opus");
  expect(agentPanes).toContain("Sonnet");
  expect(agentPanes).toContain("Synthesize");
  expect(renames.some((c) => c.argv!.at(-1)!.includes("add-picker"))).toBe(false);
  expect(renames.find((c) => c.argv![2] === "1-0")!.argv!.at(-1)).toBe("Implement");

  const reviewer = join(run.dir, "personas", "reviewer.md");
  const starts = rig.calls().filter((c) => c.cmd === "agent start");
  // The implementer and the synthesiser take the harness's own model at medium: no
  // `--model` flag at all. The reviewers name their own models and efforts and keep them.
  expect(starts.map((c) => c.argv!.slice(7))).toEqual([
    ["--", "--effort", "medium", "--append-system-prompt-file", join(run.dir, "personas", "implementer.md")],
    ["--", "--model", "opus", "--effort", "medium", "--append-system-prompt-file", reviewer],
    ["--", "--model", "sonnet", "--effort", "xhigh", "--append-system-prompt-file", reviewer],
    ["--", "--effort", "medium", "--append-system-prompt-file", reviewer],
    ["--", "--model", "opus", "--effort", "medium", "--append-system-prompt-file", reviewer],
    ["--", "--model", "sonnet", "--effort", "xhigh", "--append-system-prompt-file", reviewer],
    ["--", "--effort", "medium", "--append-system-prompt-file", reviewer],
  ]);
  expect(starts.flatMap((c) => c.argv!).filter((a) => a === "--model")).toHaveLength(4);

  // Every step that keeps the implementer's agent records the model it is actually on.
  for (const step of ["build", "architecture", "simplify", "fix"]) {
    expect(run.step(step).variants[0]!.model).toBe("default");
    expect(run.step(step).variants[0]!.effort).toBe("medium");
  }
  expect(run.step("review").variants.map((v) => [v.model, v.effort])).toEqual([
    ["opus", "medium"],
    ["sonnet", "xhigh"],
  ]);

  // One implementer throughout: build, architecture, simplify and fix share its agent.
  const implementer = run.step("build").variants[0]!.agent;
  for (const step of ["architecture", "simplify", "fix"]) {
    expect(run.step(step).variants[0]!.agent).toBe(implementer);
  }
  expect(rig.cmds().filter((c) => c === "pane close")).toHaveLength(3);
}, 20_000);

test("review standalone is the same two variants, and says so when it has no spec", async () => {
  rig.queueOutputs([CLEAN, CLEAN, SYNTH]);

  const { run, status } = await runWorkflow(rig, "review", {});

  expect(status).toBe("done");
  expect(run.record.steps[0]!.variants.map((v) => [v.harness, v.model, v.effort])).toEqual([
    ["claude", "opus", "medium"],
    ["claude", "sonnet", "xhigh"],
  ]);
  const prompt = readFileSync(join(run.dir, "steps", "review", "claude-opus", "prompt-1.md"), "utf8");
  expect(prompt).toContain("Review target: worktree");
  expect(prompt).toContain("Spec: \n");
  expect(prompt).toContain("there is no spec");
  expect(readFileSync(join(run.dir, "log.txt"), "utf8")).toContain("unknown template keys in review: inputs.plan");
});

test("review inside implement is held to the plan the run was given", async () => {
  rig.queueOutputs([CLEAN, CLEAN, CLEAN, CLEAN, CLEAN, SYNTH]);

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
    synthesized(FINDING), // review.synthesize
    { ...CLEAN, disputed: [DISPUTED_REASON] }, // fix: applies nothing, disputes it
    CLEAN, // simplify, iteration 2
    FINDING, // review/claude-opus, raises it again
    FINDING, // review/claude-sonnet, raises it again
    synthesized(FINDING), // review.synthesize carries it through
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
    synthesized(FINDING), // review.synthesize
    { ...CLEAN, disputed: [DISPUTED_REASON] }, // fix disputes it
    CLEAN, // simplify, iteration 2
    rebutted, // review/claude-opus answers the dispute
    CLEAN, // review/claude-sonnet
    synthesized(rebutted), // the synthesis carries the rebuttal through
    CLEAN, // fix applies it
    CLEAN, // simplify, iteration 3
    CLEAN, // review/claude-opus
    CLEAN, // review/claude-sonnet
    SYNTH, // review.synthesize
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
  rig.queueOutputs([CLEAN, CLEAN, CLEAN, CLEAN, CLEAN, SYNTH]);

  const { run } = await runWorkflow(rig, "implement", {});

  const build = readFileSync(join(run.dir, "steps", "build", "prompt-1.md"), "utf8");
  expect(build).toContain("Work source (plan-dir):");
  // The three branches have to survive templating, or the implementer cannot choose one.
  for (const kind of ["**plan-dir**", "**linear**", "**text**"]) expect(build).toContain(kind);
  // A key the run never set renders empty and is only visible in the log.
  expect(readFileSync(join(run.dir, "log.txt"), "utf8")).not.toContain("unknown template keys");
}, 20_000);

test("review's inputs are the embedder's when it is embedded, so implement never asks for them", () => {
  const defs = loadDefinitions(layers(rig.pluginEnv()));

  const implement = resolveWorkflow("implement", defs, FALLBACK_DEFAULTS);
  // `target` reaches implement only through `use: review`, so its picker must infer
  // it silently; `plan` is implement's own and is chosen normally.
  expect(implement.inputs.plan).toBe("work-source");
  expect(implement.inputs.target).toBe("diff-target");
  expect(implement.embeddedInputs).toEqual(["target"]);
  // The post choice is standalone, so embedding review drops it.
  expect(implement.steps.some((s) => s.id.endsWith("post"))).toBe(false);
  expect(resolveWorkflow("review", defs, FALLBACK_DEFAULTS).steps.at(-1)!.id).toBe("post");

  // Standalone, the same input belongs to review itself, so the menu is shown.
  const review = resolveWorkflow("review", defs, FALLBACK_DEFAULTS);
  expect(review.inputs.target).toBe("diff-target");
  expect(review.embeddedInputs).toEqual([]);
});

/** glab and git as they look in a repo that really is on GitLab. */
function onGitLab(branch: string) {
  bin.add(
    "glab",
    `case "$1 $2" in
      "--version ") echo "glab 1.40.0" ;;
      "api user") echo '{"username": "mk"}' ;;
      *) exit 1 ;;
    esac`,
  );
  bin.add(
    "git",
    `case "$1 $2" in
      "remote -v") echo "origin\tgit@gitlab.cego.dk:cego/herdr-plugin.git (fetch)" ;;
      "rev-parse --abbrev-ref") echo ${branch} ;;
      "status --porcelain") echo "" ;;
      *) echo main ;;
    esac`,
  );
}

test("the mr step is skipped, not failed, when this repo cannot have a merge request", async () => {
  bin.add("glab", `echo "glab 1.40.0"`);
  bin.add("git", `case "$1 $2" in "remote -v") echo "origin\tgit@github.com:me/x.git (fetch)" ;; *) echo main ;; esac`);
  rig.queueOutputs([CLEAN, CLEAN, CLEAN, CLEAN, CLEAN, SYNTH]);

  const { run, status, lines } = await runWorkflow(rig, "implement", {});

  expect(status).toBe("done");
  expect(run.step("mr").status).toBe("done");
  expect(run.step("mr").note).toBe("skipped: no GitLab remote");
  expect(lines).toContain("◦ mr — skipped: no GitLab remote");
  expect(run.record.mr_url).toBeNull();
});

test("on GitLab the mr step gets the assignee, the tickets and a short CIATF brief", async () => {
  onGitLab("FRO-149-modal");
  rig.queueOutputs([
    CLEAN,
    CLEAN,
    CLEAN,
    CLEAN,
    CLEAN,
    SYNTH,
    { verdict: "clean", findings: [], mr_url: "https://gitlab.cego.dk/x/-/merge_requests/7", linear_issues: ["FRO-149"] },
  ]);

  const { run, status } = await runWorkflow(rig, "implement", {});

  expect(status).toBe("done");
  const prompt = readFileSync(join(run.dir, "steps", "mr", "prompt-1.md"), "utf8");
  expect(prompt).toContain("Assignee: `mk`");
  // The branch names the ticket, so the MR has something to link.
  expect(prompt).toContain("Linear tickets: `FRO-149`");
  // Short by instruction, in the words mk asked for.
  expect(prompt).toContain("One or two ordinary sentences per section");
  expect(prompt).toContain("`No impact.`");
  expect(prompt).toContain("no tables, no");
  expect(prompt).toContain("Never merge the MR");
  expect(prompt).toContain("Where the template asks for a Trello card");
  // Nothing in a prompt or a description may carry the scope with a leading at-sign.
  // Built rather than written, so the literal is absent from the repo too.
  expect(prompt).not.toContain(`@${"cego"}`);

  // What it reported reaches the run record and the summary.
  expect(run.record.mr_url).toBe("https://gitlab.cego.dk/x/-/merge_requests/7");
  expect(run.record.linear_issues).toEqual(["FRO-149"]);
  expect(run.record.summary).toContain("Merge request: https://gitlab.cego.dk/x/-/merge_requests/7 (FRO-149)");
}, 20_000);

test("with a template in the repo the prompt points at it instead of the plain fallback", async () => {
  onGitLab("add-a-picker");
  mkdirSync(join(rig.projectDir, ".gitlab", "merge_request_templates"), { recursive: true });
  writeFileSync(join(rig.projectDir, ".gitlab", "merge_request_templates", "default.md"), "## Description\n");
  rig.queueOutputs([CLEAN, CLEAN, CLEAN, CLEAN, CLEAN, SYNTH, { verdict: "clean", findings: [] }]);

  const { run } = await runWorkflow(rig, "implement", {});

  const prompt = readFileSync(join(run.dir, "steps", "mr", "prompt-1.md"), "utf8");
  expect(prompt).toContain("MR template: `.gitlab/merge_request_templates/default.md`");
  // No ticket anywhere this time, so the prompt says so rather than inventing one.
  expect(prompt).toContain("Linear tickets: ``");
}, 20_000);

test("build, architecture, simplify and fix are one unlabelled pane in one tab", async () => {
  rig.queueOutputs([
    CLEAN, CLEAN, CLEAN, FINDING, FINDING, synthesized(FINDING),
    CLEAN, CLEAN, CLEAN, CLEAN, SYNTH,
  ]);

  const { run } = await runWorkflow(rig, "implement", {});

  // One pane, in the implementer's own tab, for every step that reuses the agent.
  const panes = ["build", "architecture", "simplify", "fix"].map((id) => run.step(id).variants[0]!.paneId);
  expect(new Set(panes).size).toBe(1);

  // It is never labelled: it is alone in its tab, and the tab says `implement`.
  // Nothing else opens for it either.
  const onThatPane = rig
    .calls()
    .filter((c) => c.cmd === "pane rename" && c.argv![2] === panes[0])
    .map((c) => c.argv!.at(-1));
  expect(onThatPane).toEqual([]);
  const itsTab = run.step("build").variants[0]!.tabId;
  const tabNames = rig
    .calls()
    .filter((c) => c.cmd === "tab rename" && c.argv![2] === itsTab)
    .map((c) => c.argv!.at(-1));
  expect(new Set(tabNames)).toEqual(new Set(["⚙ Implement", "✓ Implement"]));

  // Two tabs for the whole run: the implementer's and the reviewers'.
  expect(rig.cmds().filter((c) => c === "tab create")).toHaveLength(2);

  // The runner's own pane is on the board, and never becomes an agent's pane.
  const moved = rig.calls().filter((c) => c.cmd === "pane move");
  expect(moved).toHaveLength(1);
  expect(moved[0]!.argv![2]).toBe("1-0");
  expect(panes[0]).not.toBe("1-0");
  expect(
    rig.calls().filter((c) => c.cmd === "pane rename").map((c) => c.argv!.at(-1)),
  ).not.toContain("status");
}, 20_000);
