import { afterEach, beforeEach, expect, test } from "bun:test";
import { ConfigProvider, Effect, FileSystem, Layer, Path } from "effect";
import { Rig, TEST_LOGIN } from "./support/recorder";
import { FakeBin } from "./support/bin";
import { runEffect } from "./support/effect";
import { installBaseline, runWorkflow, scriptedPrompts } from "./support/engine";
import { layerSet, writeDef } from "./support/defs";
import { FALLBACK_DEFAULTS } from "../src/config";
import { loadDefinitions, resolveWorkflow, validateWorkflow } from "../src/definitions";
import { RunStore } from "../src/run";
import { readIntent, seedIntent, writeIntent } from "../src/intent";

let rig: Rig;
let bin: FakeBin;
let driverLog: string;
let driverLayer: Layer.Layer<never>;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      rig = yield* Rig.make();
      yield* rig.startSocket();
      yield* installBaseline(rig);
      bin = yield* FakeBin.make(path.join(rig.root, "bin"));
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", `echo main`);
      yield* writeDef(rig.baselineDir, "workflows", "parent", PARENT);
      yield* writeDef(rig.baselineDir, "workflows", "child", CHILD);
      yield* writeDef(rig.baselineDir, "workflows", "asker", ASKER);
      // A chained child is handed to a detached Driver, so there has to be one to hand
      // it to; this records the Run ids it is started for.
      const fs = yield* FileSystem.FileSystem;
      driverLog = path.join(rig.root, "drivers");
      const driver = path.join(rig.root, "fake-driver");
      yield* fs.writeFileString(
        driver,
        `#!/bin/sh\nprintf '%s\\n' "$COLLIE_RUN" >> "${driverLog}"\n`,
        {
          mode: 0o755,
        },
      );
      driverLayer = ConfigProvider.layer(ConfigProvider.fromUnknown({ COLLIE_DRIVER: driver }));
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.restore();
      yield* rig.close();
    }),
  ),
);

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

/** `architecture`'s shape: nothing that names the work, so nothing names a branch. */
const NAMELESS_PARENT = `---
name: nameless-parent
inputs:
  workspace: optional
steps:
  - id: draft
    persona: planner
    output: draft.json
  - id: next
    choices:
      - title: Build it now
        run: implement
        inputs:
          plan: "{{run.dir}}/plan"
---
## draft
Draft into {{run.dir}}/plan/SPEC.md
`;

/** A mutating child, so the chain has to settle a branch before it can start one. */
const MUTATING_PARENT = `---
name: mutating-parent
inputs:
  goal: goal
steps:
  - id: draft
    persona: planner
    output: draft.json
  - id: next
    choices:
      - title: Build it now
        run: implement
        inputs:
          plan: "{{run.dir}}/plan"
---
## draft
Draft into {{run.dir}}/plan/SPEC.md
`;

/** `plan`'s shape: its own Output settles the short name the work is called. */
const TASKED_PARENT = `---
name: tasked-parent
inputs:
  goal: goal
steps:
  - id: draft
    persona: planner
    output: draft.json
  - id: next
    choices:
      - title: Build it now
        run: implement
        inputs:
          plan: "{{run.dir}}/plan"
          task: "{{outputs.draft.slug}}"
---
## draft
Draft into {{run.dir}}/plan/SPEC.md
`;

const IMPLEMENT = `---
name: implement
inputs:
  plan: plan-dir
  task: optional
steps:
  - id: build
    persona: implementer
    output: build.json
---
## build
Build {{inputs.plan}}
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

/** Every run in this suite may chain, and a chained child is spawned, not paned. */
function runWorkflowEffect(...args: Parameters<typeof runWorkflow>) {
  return runWorkflow(...args).pipe(Effect.provide(driverLayer));
}

/** The branch a chained child was refused a checkout for, from the parent's own log. */
function refusedBranch(lines: string[]): string {
  const line = lines.find((text) => text.includes("no worktree for")) ?? "";
  return /no worktree for ([^\s:]+)/.exec(line)?.[1] ?? "";
}

test("a parent with nothing to name it after still hands its child a branch of its own", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(rig.baselineDir, "workflows", "nameless-parent", NAMELESS_PARENT);
      yield* writeDef(rig.baselineDir, "workflows", "implement", IMPLEMENT);
      yield* rig.queueOutputs([CLEAN, CLEAN]);
      // `architecture` declares only `workspace`, so there is no input to be named
      // after and the name falls back to the literal "run". Two of these would build one
      // branch and share one checkout, index and stash stack — so the plan directory
      // each was pointed at, which is its own parent's, is what tells them apart.
      const prompts = scriptedPrompts(["Build it now"]);

      const one = yield* runWorkflowEffect(rig, "nameless-parent", {}, { prompts });
      const two = yield* runWorkflowEffect(
        rig,
        "nameless-parent",
        {},
        { prompts: scriptedPrompts(["Build it now"]) },
      );

      // Nothing was asked: a branch is worked out, not requested.
      expect(prompts.asked).toEqual([]);
      // This fixture's git makes no checkouts, so the refusal names the branch decided.
      const first = refusedBranch(one.lines);
      expect(first.startsWith(`${TEST_LOGIN}/`)).toBe(true);
      expect(first).not.toBe(`${TEST_LOGIN}/run`);
      expect(refusedBranch(two.lines)).not.toBe(first);
    }),
  ));

test("a chained run whose parent's own name was clipped still gets a branch of its own", () =>
  runEffect(
    Effect.gen(function* () {
      // Written here rather than in the fixture set: this one overrides the baseline's
      // own `implement`, and every other test in this file should see the real one.
      yield* writeDef(rig.baselineDir, "workflows", "mutating-parent", MUTATING_PARENT);
      yield* writeDef(rig.baselineDir, "workflows", "implement", IMPLEMENT);
      yield* rig.queueOutputs([CLEAN, CLEAN]);
      // Two parents whose goals agree for the first 40 characters slug to one name, and
      // that name is what a chained run is called after — so both children would build
      // one branch and share one checkout.
      const goals = [
        "Make the exporter handle a missing column without failing",
        "Make the exporter handle a missing column by warning instead",
      ];
      const branches = new Set<string>();
      for (const goal of goals) {
        const prompts = scriptedPrompts(["Build it now"]);
        const { lines } = yield* runWorkflowEffect(rig, "mutating-parent", { goal }, { prompts });
        expect(prompts.asked).toEqual([]);
        branches.add(refusedBranch(lines));
      }

      expect(branches.size).toBe(2);
      for (const branch of branches) expect(branch.startsWith(`${TEST_LOGIN}/`)).toBe(true);
    }),
  ));

test("the task a parent settled is what its child's branch is named after", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(rig.baselineDir, "workflows", "tasked-parent", TASKED_PARENT);
      yield* writeDef(rig.baselineDir, "workflows", "implement", IMPLEMENT);
      // The slug the planner and the human agreed on, in the parent's own Output.
      yield* rig.queueOutputs([{ ...CLEAN, slug: "exporter-missing-column" }]);

      const goal = "Make the exporter handle a missing column without failing";
      const prompts = scriptedPrompts(["Build it now"]);
      const { lines } = yield* runWorkflowEffect(rig, "tasked-parent", { goal }, { prompts });

      // Not the plan directory Collie chained, and not the whole goal the parent was
      // named after: the name the work was given.
      expect(refusedBranch(lines)).toBe(`${TEST_LOGIN}/exporter-missing-column`);
    }),
  ));

test("a run: choice starts a child run with the forwarded inputs and the parent finishes", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([CLEAN]);
      const prompts = scriptedPrompts(["Build it now"]);

      const { run, status } = yield* runWorkflowEffect(
        rig,
        "parent",
        { goal: "Add a picker" },
        { prompts },
      );

      expect(status).toBe("done");
      expect(run.record.slug).toBe("parent-add-a-picker");
      expect(run.record.children).toHaveLength(1);

      const child = yield* new RunStore(rig.stateDir).load(run.record.children[0]!);
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

      // The child is handed to a detached Driver, the same way `run start` hands over.
      // It used to be given a `runner` pane instead, which the manifest has never
      // declared, so nothing ever advanced it.
      const fs = yield* FileSystem.FileSystem;
      expect((yield* fs.readFileString(driverLog)).trim().split("\n")).toContain(child.id);
      expect(
        (yield* rig.calls()).some((c) => c.cmd === "plugin pane" && c.argv?.includes("runner")),
      ).toBe(false);

      expect(run.step("next").note).toBe(`chose "Build it now" → child run ${child.id}`);
      expect(run.step("after").status).toBe("pending");
      expect(run.step("after").note).toContain("not run");
      expect(run.record.summary).toContain(`Chained: ${child.id}`);
    }),
  ));

test("a child inherits its parent's constraints, re-sourced, and never its authority", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([CLEAN]);
      const prompts = scriptedPrompts(["Build it now"]);
      const store = new RunStore(rig.stateDir);

      // The parent's Intent is written before it chains, exactly as a Run started with
      // `--goal`/`--constraint` would have it, and with a grant a child must not inherit.
      const seeded = seedIntent("placeholder", {
        goal: "Add a picker",
        constraints: [
          {
            id: "keep-envelope",
            kind: "semantic",
            text: "keep the --json envelope",
            severity: "block",
            source: "human",
            since: 1,
          },
        ],
      });

      const { run } = yield* runWorkflowEffect(
        rig,
        "parent",
        { goal: "Add a picker" },
        {
          prompts,
          before: (parent) =>
            writeIntent(parent.dir, {
              ...seeded,
              run: parent.id,
              authority: {
                ...seeded.authority,
                auto_correct: true,
              },
            }),
        },
      );

      const child = yield* store.load(run.record.children[0]!);
      const intent = yield* readIntent(child.dir);
      expect(intent?.version).toBe(1);
      expect(intent?.parent).toEqual({ run: run.id, version: 1, applied: 1 });
      expect(intent?.goal).toBe("Add a picker");
      expect(intent?.constraints.map((c) => [c.id, c.source])).toEqual([
        ["keep-envelope", "parent"],
      ]);
      // A grant is per Run: the child arrives with none, whatever its parent had.
      expect(intent?.authority.auto_correct).toBe(false);
    }),
  ));

test("resume lists the child on its own and not the finished parent", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([CLEAN]);

      const { run } = yield* runWorkflowEffect(
        rig,
        "parent",
        { goal: "g" },
        { prompts: scriptedPrompts(["Build it now"]) },
      );

      expect((yield* new RunStore(rig.stateDir).resumable()).map((r) => r.id)).toEqual(
        run.record.children,
      );
    }),
  ));

test("a chained input nobody forwarded is asked for in the runner pane", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([CLEAN]);
      const prompts = scriptedPrompts(["Ask me"], ["build the picker"]);

      const { run, status } = yield* runWorkflowEffect(rig, "parent", { goal: "g" }, { prompts });

      expect(status).toBe("done");
      expect(prompts.asked).toEqual(["What is the goal?"]);
      const child = yield* new RunStore(rig.stateDir).load(run.record.children[0]!);
      expect(child.record.inputs).toEqual({ goal: "build the picker" });
      expect(child.record.input_sources).toEqual({ goal: "asked" });
    }),
  ));

test("cancelling that question abandons the chain and offers the menu again", () =>
  runEffect(
    Effect.gen(function* () {
      // Two Outputs: the draft, then `after`, which Stop here does not skip.
      yield* rig.queueOutputs([CLEAN, CLEAN]);
      const prompts = scriptedPrompts(["Ask me", "Stop here"], []);

      const { run, status } = yield* runWorkflowEffect(rig, "parent", { goal: "g" }, { prompts });

      expect(status).toBe("done");
      expect(run.record.children).toEqual([]);
      expect(run.step("after").status).toBe("done");
      expect(prompts.offered).toHaveLength(2);
      expect(run.record.choices.map((c) => c.title)).toEqual(["Ask me", "Stop here"]);
      // No child run: the only plugin pane opened is the workspace's own board.
      expect(
        (yield* rig.calls()).filter((c) => c.cmd === "plugin pane" && c.argv!.includes("runner")),
      ).toEqual([]);
    }),
  ));

test("an unknown chained workflow or input fails validation before anything opens", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(
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

      const path = yield* Path.Path;
      const defs = yield* loadDefinitions(
        layerSet(rig.baselineDir, rig.configDir, path.join(rig.projectDir, ".herdr")),
      );
      const errors = yield* validateWorkflow(
        resolveWorkflow("broken-chain", defs, FALLBACK_DEFAULTS),
        defs,
        FALLBACK_DEFAULTS,
      );

      expect(errors).toEqual([
        'workflow "broken-chain" step "next" choice "Nowhere": unknown workflow "nope" (known: architecture, asker, broken-chain, child, implement, parent, plan, review)',
        'workflow "broken-chain" step "next" choice "Wrong input": workflow "child" has no input(s) spec (known: plan, post)',
      ]);
    }),
  ));

test("a child whose driver will not start is recorded, not left running", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* rig.queueOutputs([CLEAN]);
      const prompts = scriptedPrompts(["Build it now"]);

      // No driver to hand the child to, which is the ordinary state of a checkout whose
      // bin/collie has not been built.
      const missing = ConfigProvider.layer(
        ConfigProvider.fromUnknown({ COLLIE_DRIVER: path.join(rig.root, "not-here") }),
      );
      const { run } = yield* runWorkflow(rig, "parent", { goal: "add a picker" }, { prompts }).pipe(
        Effect.provide(missing),
      );

      const child = yield* new RunStore(rig.stateDir).load(run.record.children[0]!);
      // handOver records it, so it is not reported as advancing with nobody advancing it.
      expect(child.record.status).toBe("failed");
      expect(child.record.finished_at).not.toBeNull();
      expect(yield* fs.readFileString(path.join(child.dir, "log.txt"))).toContain(
        "driver did not start",
      );
    }),
  ));
