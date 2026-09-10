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

const CLEAN = { verdict: "clean", findings: [] };

function runWorkflowEffect(...args: Parameters<typeof runWorkflow>) {
  return runWorkflow(...args);
}
const PLAN_FINDING = {
  verdict: "findings",
  findings: [
    {
      severity: "major",
      title: "no ticket for the migration",
      detail: "SPEC has one, issues/ does not",
    },
  ],
};

function plan() {
  return Effect.gen(function* () {
    const env = rig.pluginEnv();
    const defs = yield* layers(env).pipe(Effect.flatMap(loadDefinitions));
    return { defs, wf: resolveWorkflow("plan", defs, FALLBACK_DEFAULTS) };
  });
}

test("plan is one agent through grill, spec and tickets, then a menu", () =>
  runEffect(
    Effect.gen(function* () {
      const { defs, wf } = yield* plan();

      expect(wf.steps.map((s) => s.id)).toEqual(["grill", "spec", "tickets", "next"]);
      expect(wf.steps.map((s) => s.agent)).toEqual([undefined, "grill", "grill", undefined]);
      expect(wf.steps.map((s) => s.persona)).toEqual(["planner", "planner", "planner", undefined]);
      expect(yield* validateWorkflow(wf, defs, FALLBACK_DEFAULTS)).toEqual([]);

      const choices = wf.steps[3]!.choices!;
      expect(choices.map((c) => c.title)).toEqual([
        "Implement now",
        "Second opinion",
        "Offload to Linear",
        "Refine",
      ]);
      expect(choices[0]!.run).toBe("implement");
      // The plan it wrote, and the parent's own answer about where the run lives, so a
      // `workspace=new` plan chains into an implement that gets one too.
      expect(choices[0]!.inputs).toEqual({
        plan: "{{run.dir}}/plan",
        // The short name `grill` settled on, which is what the child's branch is called.
        task: "{{outputs.grill.slug}}",
        workspace: "{{inputs.workspace}}",
      });
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
    }),
  ));

test("the tickets prompt makes every ticket name its repository", () =>
  runEffect(
    Effect.gen(function* () {
      const { wf } = yield* plan();
      const tickets = wf.steps.find((step) => step.id === "tickets")!.prompt;

      // The line itself, where it goes, and what the path is relative to: the fan-out
      // reads it, so a planner that writes it differently breaks the hand-off.
      expect(tickets).toContain("**Repo:**");
      expect(tickets).toContain("Blocked by");
      expect(tickets).toContain("`.`");
      // The rule the fan-out cannot recover from: repos that block each other.
      expect(tickets).toMatch(/interleav|cycle|never be blocked by/i);
    }),
  ));

test("every plan prompt tells the planner how to answer the end menu itself", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([CLEAN, CLEAN, CLEAN]);
      const prompts = scriptedPrompts(["Refine"]);

      const { run } = yield* runWorkflowEffect(
        rig,
        "plan",
        { goal: "Add a version flag" },
        { prompts },
      );

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // The preamble, so the planner knows it before the menu exists as well as after:
      // "proceed" arrives in the middle of a step as often as at the end of one.
      for (const step of ["grill", "spec", "tickets"]) {
        const prompt = yield* fs.readFileString(path.join(run.dir, "steps", step, "prompt-1.md"));
        expect(prompt).toContain(`collie run answer ${run.id} "Implement now"`);
        expect(prompt).toContain("proceed");
      }
      // Answering the menu is the whole instruction: no prompt tells the planner to
      // start a run itself, which is what the superseded refine-prompt change did.
      const source = yield* fs.readFileString(path.join(rig.baselineDir, "workflows", "plan.md"));
      expect(source).not.toContain("collie run start");
    }),
  ));

test("a plan started with workspace=new chains an implement that gets one too", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([CLEAN, CLEAN, CLEAN]);
      const prompts = scriptedPrompts(["Implement now"]);

      const { run, status } = yield* runWorkflowEffect(
        rig,
        "plan",
        { goal: "Add a version flag", workspace: "new" },
        { prompts },
      );

      expect(status).toBe("done");
      const childId = run.record.children.at(0);
      if (!childId) throw new Error("expected a chained implement");
      const child = yield* new RunStore(rig.pluginEnv().stateDir).load(childId);
      // The escape hatch survives the hand-off: herdr made the checkout and opened a
      // workspace on it, rather than Collie making it with git in place.
      expect(child.record.inputs.workspace).toBe("new");
      expect(child.record.worktree).toMatchObject({ managed_by: "herdr" });
      expect((yield* rig.cmds()).filter((cmd) => cmd.startsWith("worktree"))).toEqual([
        "worktree list",
        "worktree create",
      ]);
    }),
  ));

test(
  "plan writes into the run dir, keeps one agent, and chains implement",
  () =>
    runEffect(
      Effect.gen(function* () {
        // The spec step writes the SPEC, which is what makes `<run.dir>/plan` a plan
        // directory by the time the chain classifies it — and so what makes the chained
        // implement's branch a real question rather than a fixture artefact.
        yield* rig.queueOutputs([
          CLEAN,
          { __write: { "plan/SPEC.md": "# Add a version flag\n" }, output: CLEAN },
          CLEAN,
        ]);
        const prompts = scriptedPrompts(["Implement now"]);

        const { run, status } = yield* runWorkflowEffect(
          rig,
          "plan",
          { goal: "Add a version flag" },
          { prompts },
        );

        expect(status).toBe("done");
        const planner = run.step("grill").variants[0]!.agent;
        const calls = yield* rig.calls();
        expect(calls.filter((c) => c.cmd === "agent start")).toHaveLength(1);
        expect(calls.filter((c) => c.cmd === "agent prompt").map((c) => c.argv![2])).toEqual([
          planner,
          planner,
          planner,
        ]);

        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // A mention names the skill and the file to read; the slash form is only
        // what the human channel types to start one.
        for (const [step, mentions] of [
          ["grill", "the `grill-with-docs` skill"],
          ["spec", "the `to-spec` skill"],
          ["tickets", "the `to-tickets` skill"],
        ] as const) {
          const prompt = yield* fs.readFileString(path.join(run.dir, "steps", step, "prompt-1.md"));
          expect(prompt).toContain(mentions);
          expect(prompt).toContain("Add a version flag");
        }
        expect(
          yield* fs.readFileString(path.join(run.dir, "steps", "spec", "prompt-1.md")),
        ).toContain(`${run.dir}/plan/SPEC.md`);

        const child = yield* new RunStore(rig.stateDir).load(run.record.children[0]!);
        expect(child.record.workflow).toBe("implement");
        // A plan directory, so rule 4 would name the branch after its basename — which
        // for every chained run is the literal `plan`. The parent's own name is what
        // keeps two of these apart, on the board and in the checkout.
        expect(child.record.inputs.plan_kind).toBe("plan-dir");
        expect(child.record.slug).toBe("implement-add-a-version-flag");
        expect(child.record.inputs.plan).toBe(`${run.dir}/plan`);
      }),
    ),
  20_000,
);

test(
  "a second opinion is a fresh opus reviewer whose findings go back to the planner, twice at most",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([CLEAN, CLEAN, CLEAN, PLAN_FINDING, CLEAN, CLEAN]);
        const prompts = scriptedPrompts(["Second opinion", "Second opinion", "Implement now"]);

        const { run, status } = yield* runWorkflowEffect(rig, "plan", { goal: "g" }, { prompts });

        expect(status).toBe("done");
        expect(prompts.offered.at(-1)).toEqual(["Implement now", "Offload to Linear", "Refine"]);

        const path = yield* Path.Path;
        const calls = yield* rig.calls();
        const reviewers = calls.filter((c) => c.cmd === "agent start").slice(1);
        expect(reviewers.map((c) => c.argv!.slice(8))).toEqual([
          [
            "--model",
            "opus",
            "--effort",
            "xhigh",
            "--append-system-prompt-file",
            path.join(run.dir, "personas", "reviewer.claude.md"),
            "--permission-mode",
            "bypassPermissions",
          ],
          [
            "--model",
            "opus",
            "--effort",
            "xhigh",
            "--append-system-prompt-file",
            path.join(run.dir, "personas", "reviewer.claude.md"),
            "--permission-mode",
            "bypassPermissions",
          ],
        ]);
        const fs = yield* FileSystem.FileSystem;
        const opinion = yield* fs.readFileString(
          path.join(run.dir, "steps", "next", "second-opinion-1", "prompt-1.md"),
        );
        expect(opinion).toContain("Review the plan, not the code");

        const revise = yield* fs.readFileString(
          path.join(run.dir, "steps", "next", "second-opinion-1-then", "prompt-1.md"),
        );
        expect(revise).toContain("- [major] no ticket for the migration");
        const planner = run.step("grill").variants[0]!.agent;
        expect(
          calls
            .filter((c) => c.cmd === "agent prompt")
            .map((c) => c.argv![2])
            .at(-2),
        ).toBe(planner);
      }),
    ),
  20_000,
);

test(
  "offloading to Linear asks for the team once and keeps it in config.json",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([CLEAN, CLEAN, CLEAN, CLEAN]);
        const prompts = scriptedPrompts(["Offload to Linear", "Implement now"], ["ENG"]);

        const { run, status } = yield* runWorkflowEffect(rig, "plan", { goal: "g" }, { prompts });

        expect(status).toBe("done");
        expect(prompts.asked).toEqual(["Which Linear team do new issues go to"]);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        expect(yield* fs.readFileString(path.join(rig.configDir, "config.json"))).toContain(
          '"team":"ENG"',
        );

        const offload = yield* fs.readFileString(
          path.join(run.dir, "steps", "next", "offload-to-linear-1", "prompt-1.md"),
        );
        expect(offload).toContain("`ENG` team's board");
        expect(offload).toContain("ONE issue");
      }),
    ),
  20_000,
);

test("a workflow embedding plan gets the same steps with the references rebased", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();
      // The baseline no longer embeds `plan`, but a user layer still may.
      yield* writeDef(
        (yield* Path.Path).join(env.cwd, ".herdr"),
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
      const defs = yield* layers(env).pipe(Effect.flatMap(loadDefinitions));
      const wf = resolveWorkflow("embeds-plan", defs, FALLBACK_DEFAULTS);

      // The embedder's own Inputs first, then the ones `plan` brings with it.
      expect(wf.inputs).toEqual({ goal: "goal", ticket: "ticket", workspace: "optional" });
      expect(wf.steps.map((s) => s.id)).toEqual([
        "plan.grill",
        "plan.spec",
        "plan.tickets",
        "plan.next",
      ]);
      expect(wf.steps.map((s) => s.agent)).toEqual([
        undefined,
        "plan.grill",
        "plan.grill",
        undefined,
      ]);
      expect(wf.steps[3]!.choices!.map((c) => c.round?.agent)).toEqual([
        undefined,
        undefined,
        "plan.grill",
        "plan.grill",
      ]);
      expect(wf.steps[3]!.choices![1]!.followUp!.agent).toBe("plan.grill");
      expect(wf.steps[0]!.prompt).toContain("Linear issue id");
      expect(yield* validateWorkflow(wf, defs, FALLBACK_DEFAULTS)).toEqual([]);
    }),
  ));
