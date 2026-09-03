import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Path } from "effect";
import { Rig } from "./support/recorder";
import { FakeBin, gitWorktreeCases } from "./support/bin";
import { runEffect } from "./support/effect";
import { installBaseline, runWorkflow, scriptedPrompts } from "./support/engine";
import { writeDef } from "./support/defs";
import { FALLBACK_DEFAULTS } from "../src/config";
import { layers, loadDefinitions, resolveWorkflow, validateWorkflow } from "../src/definitions";
import { RunStore } from "../src/run";

let rig: Rig;
let bin: FakeBin;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      rig = yield* Rig.make();
      yield* rig.startSocket();
      yield* installBaseline(rig);
      bin = yield* FakeBin.make(path.join(rig.root, "bin"));
      yield* bin.add("glab", `exit 1`);
      yield* bin.add(
        "git",
        `case "$*" in
${gitWorktreeCases(rig.projectDir)}
      *) echo main ;;
    esac`,
      );
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

function runWorkflowEffect(...args: Parameters<typeof runWorkflow>) {
  return runWorkflow(...args);
}

const DEFERRED = {
  verdict: "clean",
  findings: [],
  report: "plan/ARCHITECTURE.md",
  applied: ["collapsed the two loaders into one"],
  deferred: [
    {
      file: "src/engine.ts",
      severity: "moderate",
      title: "split the run loop",
      detail: "big, but not this branch's job",
    },
    {
      file: "src/yaml.ts",
      severity: "weak",
      title: "drop the flow parser",
      detail: "nothing uses flow maps yet",
    },
  ],
};

function defsOf() {
  return Effect.gen(function* () {
    const env = rig.pluginEnv();
    return yield* layers(env).pipe(Effect.flatMap(loadDefinitions));
  });
}

test("architecture is attended when it runs on its own, and ends with a menu", () =>
  runEffect(
    Effect.gen(function* () {
      const defs = yield* defsOf();
      const wf = resolveWorkflow("architecture", defs, FALLBACK_DEFAULTS);

      expect(wf.steps.map((s) => s.id)).toEqual(["architecture", "next"]);
      expect(wf.steps[0]!.persona).toBe("architect");
      expect(wf.steps[0]!.prompt).toContain("ask me about the parts you cannot judge");
      expect(wf.steps[0]!.prompt).not.toContain("Nobody is watching");
      expect(wf.steps[0]!.skill).toBe("improve-codebase-architecture");
      expect(wf.steps[1]!.choices!.map((c) => c.title)).toEqual(["Implement now", "Stop here"]);
      expect(wf.steps[1]!.choices![1]!.stop).toBe(true);
      expect(yield* validateWorkflow(wf, defs, FALLBACK_DEFAULTS)).toEqual([]);
    }),
  ));

test("an embedder gets the unattended body and no menu", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(
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

      const defs = yield* defsOf();
      const wf = resolveWorkflow("outer", defs, FALLBACK_DEFAULTS);

      // The Choice step is dropped: a menu needs the human, and the embedder decides
      // what comes next.
      expect(wf.steps.map((s) => s.id)).toEqual(["build", "architecture"]);
      expect(wf.steps[1]!.prompt).toContain("Nobody is watching");
      expect(wf.steps[1]!.prompt).toContain("Strong");
      // The embedded step still runs the skill as a slash command.
      expect(wf.steps[1]!.skill).toBe("improve-codebase-architecture");
      expect(wf.steps[1]!.persona).toBe("implementer");
      expect(wf.steps[1]!.agent).toBe("build");
      expect(wf.steps[1]!.output).toBe("architecture.json");
      expect(yield* validateWorkflow(wf, defs, FALLBACK_DEFAULTS)).toEqual([]);
    }),
  ));

test("the deferred list reaches the run record and the summary", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([DEFERRED]);
      const prompts = scriptedPrompts(["Stop here"]);

      const { run, status } = yield* runWorkflowEffect(rig, "architecture", {}, { prompts });

      expect(status).toBe("done");
      expect(run.record.deferred.map((f) => f.title)).toEqual([
        "split the run loop",
        "drop the flow parser",
      ]);
      expect(run.record.summary).toContain("Deferred (the architect did not apply these):");
      expect(run.record.summary).toContain("- [moderate] split the run loop (src/engine.ts)");
      expect(run.record.summary).toContain("Choices:\n  next: Stop here");

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const prompt = yield* fs.readFileString(
        path.join(run.dir, "steps", "architecture", "prompt-1.md"),
      );
      expect(prompt).toContain(`${run.dir}/plan/ARCHITECTURE.md`);
      expect(yield* fs.exists(path.join(run.dir, "personas", "architect.claude.md"))).toBe(true);
    }),
  ));

test("Implement now chains implement with the plan the grill wrote", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([DEFERRED]);
      const prompts = scriptedPrompts(["Implement now"]);

      const { run, status } = yield* runWorkflowEffect(rig, "architecture", {}, { prompts });

      expect(status).toBe("done");
      expect(run.record.children).toHaveLength(1);
      const child = yield* new RunStore(rig.stateDir).load(run.record.children[0]!);
      expect(child.record.workflow).toBe("implement");
      expect(child.record.inputs.plan).toBe(`${run.dir}/plan`);
    }),
  ));
