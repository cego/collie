import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { Rig } from "./support/recorder";
import { FakeBin } from "./support/bin";
import { installBaseline, runWorkflow, scriptedPrompts } from "./support/engine";
import { layerSet, writeDef } from "./support/defs";
import { FALLBACK_DEFAULTS } from "../src/config";
import { loadDefinitions, resolveWorkflow, validateWorkflow } from "../src/definitions";
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
  writeDef(rig.baselineDir, "workflows", "parent", PARENT);
  writeDef(rig.baselineDir, "workflows", "child", CHILD);
  writeDef(rig.baselineDir, "workflows", "asker", ASKER);
});

afterEach(async () => {
  bin.restore();
  await rig.close();
});

const PARENT = `---
name: parent
inputs:
  goal: goal
steps:
  - id: draft
    persona: planner
    output: draft.json
  - id: next
    choices:
      - title: Build it now
        run: child
        inputs:
          plan: "{{run.dir}}/plan"
      - title: Ask me
        run: asker
      - title: Stop here
        stop: true
  - id: after
    persona: planner
    output: after.json
---
## draft
Draft into {{run.dir}}/plan/SPEC.md

## after
Never reached once a child takes over.
`;

const CHILD = `---
name: child
inputs:
  plan: plan-dir
  post: flag
steps:
  - id: build
    persona: implementer
    output: build.json
---
## build
Build {{inputs.plan}} (post: {{inputs.post}})
`;

const ASKER = `---
name: asker
inputs:
  goal: goal
steps:
  - id: build
    persona: implementer
    output: build.json
---
## build
Build {{inputs.goal}}
`;

const CLEAN = { verdict: "clean", findings: [] };

test("a run: choice starts a child run with the forwarded inputs and the parent finishes", async () => {
  rig.queueOutputs([CLEAN]);
  const prompts = scriptedPrompts(["Build it now"]);

  const { run, status } = await runWorkflow(rig, "parent", { goal: "Add a picker" }, { prompts });

  expect(status).toBe("done");
  expect(run.record.slug).toBe("parent-add-a-picker");
  expect(run.record.children).toHaveLength(1);

  const child = new RunStore(rig.stateDir).load(run.record.children[0]!);
  expect(child.record.workflow).toBe("child");
  expect(child.record.slug).toBe("child-add-a-picker");
  expect(child.record.parent).toBe(run.id);
  expect(child.record.cwd).toBe(run.record.cwd);
  expect(child.record.inputs).toEqual({ plan: `${run.dir}/plan`, post: "false" });
  expect(child.record.input_sources).toEqual({
    plan: `chained from ${run.id}`,
    post: "default",
  });
  expect(child.record.steps.map((s) => s.status)).toEqual(["pending"]);

  // The child gets its own runner pane, in the same workspace.
  const opened = rig.calls().find((c) => c.cmd === "plugin pane")!.argv!;
  expect(opened).toContain("--entrypoint");
  expect(opened).toContain("runner");
  expect(opened).toContain(`HERDR_WORKFLOWS_RUN=${child.id}`);
  expect(opened).toContain("--workspace");

  expect(run.step("next").note).toBe(`chose "Build it now" → child run ${child.id}`);
  expect(run.step("after").status).toBe("pending");
  expect(run.step("after").note).toContain("not run");
  expect(run.record.summary).toContain(`Chained: ${child.id}`);
});

test("resume lists the child on its own and not the finished parent", async () => {
  rig.queueOutputs([CLEAN]);

  const { run } = await runWorkflow(rig, "parent", { goal: "g" }, { prompts: scriptedPrompts(["Build it now"]) });

  expect(new RunStore(rig.stateDir).resumable().map((r) => r.id)).toEqual(run.record.children);
});

test("a chained input nobody forwarded is asked for in the runner pane", async () => {
  rig.queueOutputs([CLEAN]);
  const prompts = scriptedPrompts(["Ask me"], ["build the picker"]);

  const { run, status } = await runWorkflow(rig, "parent", { goal: "g" }, { prompts });

  expect(status).toBe("done");
  expect(prompts.asked).toEqual(["What is the goal?"]);
  const child = new RunStore(rig.stateDir).load(run.record.children[0]!);
  expect(child.record.inputs).toEqual({ goal: "build the picker" });
  expect(child.record.input_sources).toEqual({ goal: "asked" });
});

test("cancelling that question abandons the chain and offers the menu again", async () => {
  // Two Outputs: the draft, then `after`, which Stop here does not skip.
  rig.queueOutputs([CLEAN, CLEAN]);
  const prompts = scriptedPrompts(["Ask me", "Stop here"], []);

  const { run, status } = await runWorkflow(rig, "parent", { goal: "g" }, { prompts });

  expect(status).toBe("done");
  expect(run.record.children).toEqual([]);
  expect(run.step("after").status).toBe("done");
  expect(prompts.offered).toHaveLength(2);
  expect(run.record.choices.map((c) => c.title)).toEqual(["Ask me", "Stop here"]);
  expect(rig.cmds()).not.toContain("plugin pane");
});

test("an unknown chained workflow or input fails validation before anything opens", () => {
  writeDef(
    rig.baselineDir,
    "workflows",
    "broken-chain",
    `---
name: broken-chain
steps:
  - id: next
    choices:
      - title: Nowhere
        run: nope
      - title: Wrong input
        run: child
        inputs:
          plan: ok
          spec: "{{run.dir}}/plan"
---
## next
menu
`,
  );

  const defs = loadDefinitions(layerSet(rig.baselineDir, rig.configDir, join(rig.projectDir, ".herdr")));
  const errors = validateWorkflow(
    resolveWorkflow("broken-chain", defs, FALLBACK_DEFAULTS),
    defs,
    FALLBACK_DEFAULTS,
  );

  expect(errors).toEqual([
    'workflow "broken-chain" step "next" choice "Nowhere": unknown workflow "nope" (known: asker, broken-chain, child, implement, parent, plan, review, ticket)',
    'workflow "broken-chain" step "next" choice "Wrong input": workflow "child" has no input(s) spec (known: plan, post)',
  ]);
});
