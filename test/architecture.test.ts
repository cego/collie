import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Rig } from "./support/recorder";
import { FakeBin } from "./support/bin";
import { installBaseline, runWorkflow, scriptedPrompts } from "./support/engine";
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
});

afterEach(async () => {
  bin.restore();
  await rig.close();
});

const DEFERRED = {
  verdict: "clean",
  findings: [],
  report: "plan/ARCHITECTURE.md",
  applied: ["collapsed the two loaders into one"],
  deferred: [
    { file: "src/engine.ts", severity: "moderate", title: "split the run loop", detail: "big, but not this branch's job" },
    { file: "src/yaml.ts", severity: "weak", title: "drop the flow parser", detail: "nothing uses flow maps yet" },
  ],
};

function defsOf() {
  const env = rig.pluginEnv();
  return loadDefinitions(layers(env));
}

test("architecture is attended when it runs on its own, and ends with a menu", () => {
  const defs = defsOf();
  const wf = resolveWorkflow("architecture", defs, FALLBACK_DEFAULTS);

  expect(wf.steps.map((s) => s.id)).toEqual(["architecture", "next"]);
  expect(wf.steps[0]!.persona).toBe("architect");
  expect(wf.steps[0]!.prompt).toContain("with the real grill");
  expect(wf.steps[0]!.prompt).not.toContain("Nobody is watching");
  expect(wf.steps[1]!.choices!.map((c) => c.title)).toEqual(["Implement now", "Stop here"]);
  expect(wf.steps[1]!.choices![1]!.stop).toBe(true);
  expect(validateWorkflow(wf, defs, FALLBACK_DEFAULTS)).toEqual([]);
});

test("an embedder gets the unattended body and no menu", () => {
  writeDef(
    rig.baselineDir,
    "workflows",
    "outer",
    `---
name: outer
steps:
  - id: build
    persona: implementer
    output: build.json
  - id: architecture
    use: architecture
    prompt: unattended
    persona: implementer
    agent: build
---
## build
build it
`,
  );

  const defs = defsOf();
  const wf = resolveWorkflow("outer", defs, FALLBACK_DEFAULTS);

  // The Choice step is dropped: a menu needs the human, and the embedder decides
  // what comes next.
  expect(wf.steps.map((s) => s.id)).toEqual(["build", "architecture"]);
  expect(wf.steps[1]!.prompt).toContain("Nobody is watching");
  expect(wf.steps[1]!.prompt).toContain("Strong");
  expect(wf.steps[1]!.persona).toBe("implementer");
  expect(wf.steps[1]!.agent).toBe("build");
  expect(wf.steps[1]!.output).toBe("architecture.json");
  expect(validateWorkflow(wf, defs, FALLBACK_DEFAULTS)).toEqual([]);
});

test("the deferred list reaches the run record and the summary", async () => {
  rig.queueOutputs([DEFERRED]);
  const prompts = scriptedPrompts(["Stop here"]);

  const { run, status } = await runWorkflow(rig, "architecture", {}, { prompts });

  expect(status).toBe("done");
  expect(run.record.deferred.map((f) => f.title)).toEqual(["split the run loop", "drop the flow parser"]);
  expect(run.record.summary).toContain("Deferred (the architect did not apply these):");
  expect(run.record.summary).toContain("- [moderate] split the run loop (src/engine.ts)");
  expect(run.record.summary).toContain("Choices:\n  next: Stop here");

  const prompt = readFileSync(join(run.dir, "steps", "architecture", "prompt-1.md"), "utf8");
  expect(prompt).toContain(`${run.dir}/plan/ARCHITECTURE.md`);
  expect(existsSync(join(run.dir, "personas", "architect.md"))).toBe(true);
});

test("Implement now chains implement with the plan the grill wrote", async () => {
  rig.queueOutputs([DEFERRED]);
  const prompts = scriptedPrompts(["Implement now"]);

  const { run, status } = await runWorkflow(rig, "architecture", {}, { prompts });

  expect(status).toBe("done");
  expect(run.record.children).toHaveLength(1);
  const { RunStore } = await import("../src/run");
  const child = new RunStore(rig.stateDir).load(run.record.children[0]!);
  expect(child.record.workflow).toBe("implement");
  expect(child.record.inputs.plan).toBe(`${run.dir}/plan`);
});
