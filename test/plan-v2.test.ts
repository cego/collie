import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Rig } from "./support/recorder";
import { FakeBin } from "./support/bin";
import { installBaseline, runWorkflow, scriptedPrompts } from "./support/engine";
import { writeDef } from "./support/defs";
import { FALLBACK_DEFAULTS } from "../src/config";
import { layers, loadDefinitions, resolveWorkflow, validateWorkflow } from "../src/definitions";
import { RunStore } from "../src/run";

let rig: Rig;
let bin: FakeBin;

beforeEach(async () => {
  rig = new Rig();
  await rig.startSocket();
  installBaseline(rig);
  bin = new FakeBin(join(rig.root, "bin"));
  bin.add("glab", `exit 1`);
  bin.add("git", `echo main`);
});

afterEach(async () => {
  bin.restore();
  await rig.close();
});

const CLEAN = { verdict: "clean", findings: [] };
const PLAN_FINDING = {
  verdict: "findings",
  findings: [{ severity: "major", title: "no ticket for the migration", detail: "SPEC has one, issues/ does not" }],
};

function plan() {
  const env = rig.pluginEnv();
  const defs = loadDefinitions(layers(env));
  return { defs, wf: resolveWorkflow("plan", defs, FALLBACK_DEFAULTS) };
}

test("plan is one agent through grill, spec and tickets, then a menu", () => {
  const { defs, wf } = plan();

  expect(wf.steps.map((s) => s.id)).toEqual(["grill", "spec", "tickets", "next"]);
  expect(wf.steps.map((s) => s.agent)).toEqual([undefined, "grill", "grill", undefined]);
  expect(wf.steps.map((s) => s.persona)).toEqual(["planner", "planner", "planner", undefined]);
  expect(validateWorkflow(wf, defs, FALLBACK_DEFAULTS)).toEqual([]);

  const choices = wf.steps[3]!.choices!;
  expect(choices.map((c) => c.title)).toEqual([
    "Implement now",
    "Second opinion",
    "Offload to Linear",
    "Refine",
  ]);
  expect(choices[0]!.run).toBe("implement");
  expect(choices[0]!.inputs).toEqual({ plan: "{{run.dir}}/plan" });
  expect(choices[1]).toMatchObject({
    max: 2,
    round: { persona: "reviewer", model: "opus", effort: "xhigh", fresh: true },
    followUp: { agent: "grill" },
  });
  expect(choices[2]!.config).toEqual({
    key: "linear.team",
    question: "Which Linear team do new issues go to",
  });
  expect(choices[3]!.round!.agent).toBe("grill");
  expect(choices[3]!.max).toBeUndefined();
});

test("plan writes into the run dir, keeps one agent, and chains implement", async () => {
  rig.queueOutputs([CLEAN, CLEAN, CLEAN]);
  const prompts = scriptedPrompts(["Implement now"]);

  const { run, status } = await runWorkflow(rig, "plan", { goal: "Add a version flag" }, { prompts });

  expect(status).toBe("done");
  const planner = run.step("grill").variants[0]!.agent;
  expect(rig.calls().filter((c) => c.cmd === "agent start")).toHaveLength(1);
  expect(rig.calls().filter((c) => c.cmd === "agent prompt").map((c) => c.argv![2])).toEqual([
    planner,
    planner,
    planner,
  ]);

  for (const [step, mentions] of [
    ["grill", "/grill-with-docs"],
    ["spec", "/to-spec"],
    ["tickets", "/to-tickets"],
  ] as const) {
    const prompt = readFileSync(join(run.dir, "steps", step, "prompt-1.md"), "utf8");
    expect(prompt).toContain(mentions);
    expect(prompt).toContain("Add a version flag");
  }
  expect(readFileSync(join(run.dir, "steps", "spec", "prompt-1.md"), "utf8")).toContain(
    `${run.dir}/plan/SPEC.md`,
  );

  const child = new RunStore(rig.stateDir).load(run.record.children[0]!);
  expect(child.record.workflow).toBe("implement");
  expect(child.record.slug).toBe("implement-add-a-version-flag");
  expect(child.record.inputs.plan).toBe(`${run.dir}/plan`);
});

test("a second opinion is a fresh opus reviewer whose findings go back to the planner, twice at most", async () => {
  rig.queueOutputs([CLEAN, CLEAN, CLEAN, PLAN_FINDING, CLEAN, CLEAN]);
  const prompts = scriptedPrompts(["Second opinion", "Second opinion", "Implement now"]);

  const { run, status } = await runWorkflow(rig, "plan", { goal: "g" }, { prompts });

  expect(status).toBe("done");
  expect(prompts.offered.at(-1)).toEqual(["Implement now", "Offload to Linear", "Refine"]);

  const reviewers = rig.calls().filter((c) => c.cmd === "agent start").slice(1);
  expect(reviewers.map((c) => c.argv!.slice(8))).toEqual([
    ["--model", "opus", "--effort", "xhigh", "--append-system-prompt-file", join(run.dir, "personas", "reviewer.md")],
    ["--model", "opus", "--effort", "xhigh", "--append-system-prompt-file", join(run.dir, "personas", "reviewer.md")],
  ]);
  const opinion = readFileSync(join(run.dir, "steps", "next", "second-opinion-1", "prompt-1.md"), "utf8");
  expect(opinion).toContain("Review the plan, not the code");

  const revise = readFileSync(join(run.dir, "steps", "next", "second-opinion-1-then", "prompt-1.md"), "utf8");
  expect(revise).toContain("- [major] no ticket for the migration");
  const planner = run.step("grill").variants[0]!.agent;
  expect(rig.calls().filter((c) => c.cmd === "agent prompt").map((c) => c.argv![2]).at(-2)).toBe(planner);
});

test("offloading to Linear asks for the team once and keeps it in config.json", async () => {
  rig.queueOutputs([CLEAN, CLEAN, CLEAN, CLEAN]);
  const prompts = scriptedPrompts(["Offload to Linear", "Implement now"], ["ENG"]);

  const { run, status } = await runWorkflow(rig, "plan", { goal: "g" }, { prompts });

  expect(status).toBe("done");
  expect(prompts.asked).toEqual(["Which Linear team do new issues go to"]);
  expect(JSON.parse(readFileSync(join(rig.configDir, "config.json"), "utf8")).linear).toEqual({ team: "ENG" });

  const offload = readFileSync(join(run.dir, "steps", "next", "offload-to-linear-1", "prompt-1.md"), "utf8");
  expect(offload).toContain("`ENG` team's board");
  expect(offload).toContain("ONE issue");
});

test("a workflow embedding plan gets the same steps with the references rebased", () => {
  const env = rig.pluginEnv();
  // The baseline no longer embeds `plan`, but a user layer still may.
  writeDef(
    join(env.cwd, ".herdr"),
    "workflows",
    "embeds-plan",
    `---
name: embeds-plan
title: embeds-plan — plan, embedded
inputs:
  goal: goal
steps:
  - id: plan
    use: plan
---
`,
  );
  const defs = loadDefinitions(layers(env));
  const wf = resolveWorkflow("embeds-plan", defs, FALLBACK_DEFAULTS);

  expect(wf.inputs).toEqual({ goal: "goal", ticket: "ticket" });
  expect(wf.steps.map((s) => s.id)).toEqual([
    "plan.grill",
    "plan.spec",
    "plan.tickets",
    "plan.next",
  ]);
  expect(wf.steps.map((s) => s.agent)).toEqual([undefined, "plan.grill", "plan.grill", undefined]);
  expect(wf.steps[3]!.choices!.map((c) => c.round?.agent)).toEqual([
    undefined,
    undefined,
    "plan.grill",
    "plan.grill",
  ]);
  expect(wf.steps[3]!.choices![1]!.followUp!.agent).toBe("plan.grill");
  expect(wf.steps[0]!.prompt).toContain("Linear issue id");
  expect(validateWorkflow(wf, defs, FALLBACK_DEFAULTS)).toEqual([]);
});
