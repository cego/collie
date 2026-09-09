import { afterEach, beforeEach, expect, test } from "bun:test";
import { ConfigProvider, Effect, FileSystem, Path, Schema } from "effect";
import { FakeHerdr, Rig } from "./support/recorder";
import { fakeHerdr } from "./support/fake-herdr-core";
import { installBaseline, runWorkflow, scriptedPrompts } from "./support/engine";
import { layerSet, writeDef } from "./support/defs";
import { FALLBACK_DEFAULTS } from "../src/config";
import { loadDefinitions, resolveWorkflow, validateWorkflow } from "../src/definitions";
import { RunStore } from "../src/run";
import { filePrompts, readChoice } from "../src/driver";
import { runEffect } from "./support/effect";

const Json = Schema.fromJsonString(Schema.Any);
const decodeJson = Schema.decodeUnknownSync(Json);
const encodeJson = Schema.encodeUnknownSync(Json);

Object.defineProperty(FakeHerdr.prototype, "exec", {
  value(args: string[]) {
    return fakeHerdr(args).pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(Bun.env))),
    );
  },
});

let rig: Rig;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      yield* rig.startSocket();
      yield* installBaseline(rig);
      yield* writeDef(rig.baselineDir, "workflows", "choose", CHOOSE);
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

function runWorkflowEffect(...args: Parameters<typeof runWorkflow>) {
  return runWorkflow(...args).pipe(Effect.orDie);
}

const CHOOSE = `---
name: choose
title: choose — a menu after the draft
inputs:
  goal: goal
steps:
  - id: draft
    persona: planner
    output: draft.json
  - id: next
    choices:
      - title: Second opinion
        prompt: opinion
        persona: reviewer
        model: opus
        effort: xhigh
        fresh: true
        output: opinion.json
        max: 2
        follow_up:
          agent: draft
          prompt: revise
          output: revise.json
      - title: Offload
        agent: draft
        prompt: offload
        output: offload.json
        config:
          key: linear.team
          question: Linear team key
      - title: Refine
        agent: draft
        prompt: refine
        output: refine.json
      - title: Stop here
        stop: true
---
Goal: {{inputs.goal}}

## draft
Draft the spec into {{run.dir}}/plan/SPEC.md

## opinion
Read {{run.dir}}/plan/SPEC.md and report plan-level problems only.

## revise
The second opinion found:

{{findings}}

Revise the spec.

## offload
Put the spec on the {{config.linear.team}} board.

## refine
The human wants changes; ask what, then rewrite.
`;

const CLEAN = { verdict: "clean", findings: [] };
const FINDING = {
  verdict: "findings",
  findings: [{ severity: "major", title: "no story for the CLI", detail: "SPEC skips it" }],
};

test("a headless inbox answer supplies text to an ask Choice", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectory({ prefix: "collie-ask-choice-" });
      const prompts = filePrompts({
        dir,
        run: "ask-choice",
        step: () => "question",
        timeoutMs: 1_000,
        pollMs: 10,
      });
      const pending = runEffect(prompts.ask("What should change?").pipe(Effect.orDie));

      while (!(yield* readChoice(dir))) yield* Effect.sleep("5 millis");
      const choice = yield* readChoice(dir);
      expect(choice).not.toBeNull();
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.join(dir, "inbox"), { recursive: true });
      yield* fs.writeFileString(
        path.join(dir, "inbox", "answer-ask.json"),
        `${encodeJson({
          type: "answer",
          requestId: "answer-ask",
          choiceId: choice!.id,
          answer: "Use the smaller API",
        })}\n`,
      );

      expect(yield* Effect.promise(() => pending).pipe(Effect.orDie)).toBe("Use the smaller API");
    }),
  ));

test("a prompt choice prompts the named agent and offers the menu again", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* rig.queueOutputs([CLEAN, CLEAN]);
      const prompts = scriptedPrompts(["Refine", "Stop here"]);

      const { run, status, lines } = yield* runWorkflowEffect(
        rig,
        "choose",
        { goal: "Add a picker" },
        { prompts },
      );

      expect(status).toBe("done");
      expect(prompts.offered).toHaveLength(2);
      expect(prompts.offered[0]).toEqual(["Second opinion", "Offload", "Refine", "Stop here"]);
      expect(run.record.choices.map((c) => [c.step, c.title])).toEqual([
        ["next", "Refine"],
        ["next", "Stop here"],
      ]);
      expect(run.step("next").status).toBe("done");
      expect(run.step("next").note).toBe('chose "Stop here"');
      expect(lines).toContain("  ▸ Refine");

      // The choice reuses the drafting agent, so the human keeps one conversation.
      const drafter = run.step("draft").variants[0]!.agent;
      const prompted = (yield* rig.calls())
        .filter((c) => c.cmd === "agent prompt")
        .map((c) => c.argv![2]);
      expect(prompted).toEqual([drafter, drafter]);
      const round = yield* fs.readFileString(
        path.join(run.dir, "steps", "next", "refine-1", "prompt-1.md"),
      );
      expect(round).toContain("The human wants changes");
      expect(round).toContain("Goal: Add a picker");
      expect(run.step("next").variants[0]!.output).toBe("steps/next/refine-1/refine.json");

      // The drafter's tab says the run is asking, so herdr's sidebar row for the
      // workspace does: the step it stopped in the middle of is not what tells a
      // human to come and look. It stops saying it as soon as the menu is answered,
      // and the run's end is the last word.
      const labels = (yield* rig.calls())
        .filter(
          (c) => c.cmd === "tab rename" && c.argv![2] === run.step("draft").variants[0]!.tabId,
        )
        .map((c) => c.argv!.at(-1));
      const asking = labels.lastIndexOf("⚠ Choose · add-a-picker · asks you");
      expect(asking).toBeGreaterThanOrEqual(0);
      expect(labels.slice(asking + 1)).not.toContain("⚠ Choose · add-a-picker · asks you");
      expect(labels.at(-1)).toBe("✓ Choose · add-a-picker");
    }),
  ));

test("a fresh reviewer choice gets its own tab and its findings prompt the follow-up", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* rig.queueOutputs([CLEAN, FINDING, CLEAN]);
      const prompts = scriptedPrompts(["Second opinion", "Stop here"]);

      const { run, status } = yield* runWorkflowEffect(rig, "choose", { goal: "g" }, { prompts });

      expect(status).toBe("done");
      // Both tabs name the run and the step they were opened for. Neither says which
      // choice started it, and neither says a model or a slug.
      const labels = (yield* rig.calls())
        .filter((c) => c.cmd === "tab create")
        .map((c) => c.argv!.at(-2));
      expect(labels).toEqual(["⚙ Choose · g · draft", "⚙ Choose · g · next"]);

      // A menu zooms nothing: the run has no pane, and the Control Plane renders the
      // question inline under the run it belongs to.
      expect(yield* rig.cmds()).not.toContain("pane zoom");

      const start = (yield* rig.calls()).filter((c) => c.cmd === "agent start").at(-1)!.argv!;
      expect(start.slice(7)).toEqual([
        "--",
        "--model",
        "opus",
        "--effort",
        "xhigh",
        "--append-system-prompt-file",
        path.join(run.dir, "personas", "reviewer.claude.md"),
        "--permission-mode",
        "bypassPermissions",
      ]);

      const followUp = yield* fs.readFileString(
        path.join(run.dir, "steps", "next", "second-opinion-1-then", "prompt-1.md"),
        "utf8",
      );
      expect(followUp).toContain("- [major] no story for the CLI");
      expect(followUp).toContain("Revise the spec.");
      const drafter = run.step("draft").variants[0]!.agent;
      expect((yield* rig.calls()).filter((c) => c.cmd === "agent prompt").at(-1)!.argv![2]).toBe(
        drafter,
      );
      expect(run.step("next").variants.map((v) => v.status)).toEqual(["done", "done"]);
    }),
  ));

test("a clean round skips the follow-up, and max caps how often a choice is offered", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* rig.queueOutputs([CLEAN, CLEAN, CLEAN]);
      const prompts = scriptedPrompts(["Second opinion", "Second opinion", "Stop here"]);

      const { run, status } = yield* runWorkflowEffect(rig, "choose", { goal: "g" }, { prompts });

      expect(status).toBe("done");
      expect(prompts.offered.at(-1)).toEqual(["Offload", "Refine", "Stop here"]);
      expect(yield* fs.exists(path.join(run.dir, "steps", "next", "second-opinion-1-then"))).toBe(
        false,
      );
      expect(run.step("next").variants).toHaveLength(2);
    }),
  ));

test("a config key a choice needs is asked once and remembered in config.json", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* rig.queueOutputs([CLEAN, CLEAN, CLEAN]);
      const prompts = scriptedPrompts(["Offload", "Offload", "Stop here"], ["CEGO"]);

      const { run, status } = yield* runWorkflowEffect(rig, "choose", { goal: "g" }, { prompts });

      expect(status).toBe("done");
      expect(prompts.asked).toEqual(["Linear team key"]);
      expect(
        decodeJson(yield* fs.readFileString(path.join(rig.configDir, "config.json"))).linear,
      ).toEqual({
        team: "CEGO",
      });
      const first = yield* fs.readFileString(
        path.join(run.dir, "steps", "next", "offload-1", "prompt-1.md"),
      );
      expect(first).toContain("Put the spec on the CEGO board.");
    }),
  ));

test("cancelling the menu leaves the step unfinished so the run can be resumed", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([CLEAN]);
      const prompts = scriptedPrompts([null]);

      const { run, status } = yield* runWorkflowEffect(rig, "choose", { goal: "g" }, { prompts });

      expect(status).toBe("blocked");
      expect(run.step("next").status).toBe("blocked");
      expect(run.step("next").note).toBe("no choice taken");
      expect((yield* new RunStore(rig.stateDir).resumable()).map((r) => r.id)).toEqual([run.id]);
    }),
  ));

test("choices are validated before anything opens", () =>
  runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "bad",
        `---
name: bad
steps:
  - id: draft
    persona: planner
    output: draft.json
  - id: next
    choices:
      - title: Both
        run: choose
        prompt: refine
      - title: Neither
      - prompt: refine
      - title: No such section
        prompt: nowhere
        persona: planner
        output: x.json
      - title: No such agent
        prompt: refine
        agent: ghost
        output: x.json
      - title: Bad model
        prompt: refine
        persona: planner
        model: haiku
        harness: codex
        output: x.json
---
## draft
draft

## refine
refine it
`,
      );

      const defs = yield* loadDefinitions(
        layerSet(rig.baselineDir, rig.configDir, path.join(rig.projectDir, ".herdr")),
      );
      const errors = yield* validateWorkflow(
        resolveWorkflow("bad", defs, FALLBACK_DEFAULTS),
        defs,
        FALLBACK_DEFAULTS,
      );

      expect(errors).toEqual([
        'workflow "bad" step "next" choice "Both": needs exactly one of run, prompt, post, handoff or stop',
        'workflow "bad" step "next" choice "Both": needs a persona or an agent',
        'workflow "bad" step "next" choice "Both": needs an output, so the round can finish',
        'workflow "bad" step "next" choice "Neither": needs exactly one of run, prompt, post, handoff or stop',
        'workflow "bad" step "next" choice 3: needs a title',
        'workflow "bad" step "next" choice 3: needs a persona or an agent',
        'workflow "bad" step "next" choice 3: needs an output, so the round can finish',
        'workflow "bad" step "next" choice "No such section": unknown prompt section "nowhere" in bad.md (known: draft, refine)',
        'workflow "bad" step "next" choice "No such agent": agent "ghost" is not an earlier step',
        'workflow "bad" step "next" choice "Bad model": unknown model "haiku" for harness "codex" (known: default, gpt-5-codex, gpt-5, gpt-5-mini or anything matching ^(?:gpt|o)[0-9][a-z0-9.-]*$)',
      ]);
    }),
  ));

test("a choice step needs no persona and no prompt section of its own", () =>
  runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const defs = yield* loadDefinitions(
        layerSet(rig.baselineDir, rig.configDir, path.join(rig.projectDir, ".herdr")),
      );
      const wf = resolveWorkflow("choose", defs, FALLBACK_DEFAULTS);

      expect(yield* validateWorkflow(wf, defs, FALLBACK_DEFAULTS)).toEqual([]);
      expect(wf.steps[1]!.choices!.map((c) => c.title)).toEqual([
        "Second opinion",
        "Offload",
        "Refine",
        "Stop here",
      ]);
      expect(wf.steps[1]!.choices![0]!.round!.prompt).toContain("plan-level problems only");
    }),
  ));

test("a decided choice is taken without drawing the menu", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([CLEAN]);
      const prompts = scriptedPrompts([]);

      const { run, status, lines } = yield* runWorkflowEffect(
        rig,
        "choose",
        { goal: "Add a picker" },
        { prompts, decisions: { next: "Stop here" } },
      );

      expect(status).toBe("done");
      expect(prompts.offered).toHaveLength(0);
      expect(run.step("next").note).toBe('chose "Stop here"');
      expect(lines).toContain("  ▸ Stop here (decided at launch)");
    }),
  ));

test("a decided round runs once and ends the step, where a picked one asks again", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([CLEAN, CLEAN]);
      const prompts = scriptedPrompts([]);

      const { run, status } = yield* runWorkflowEffect(
        rig,
        "choose",
        { goal: "Add a picker" },
        { prompts, decisions: { next: "Refine" } },
      );

      expect(status).toBe("done");
      expect(prompts.offered).toHaveLength(0);
      expect(run.record.choices.map((c) => c.title)).toEqual(["Refine"]);
      expect(run.step("next").note).toBe('decided at launch: "Refine"');
    }),
  ));

test("a decision that is not available asks, and the run says why", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([CLEAN]);
      const prompts = scriptedPrompts(["Stop here"]);

      const { run, status, lines } = yield* runWorkflowEffect(
        rig,
        "choose",
        { goal: "Add a picker" },
        { prompts, decisions: { next: "Ship it" } },
      );

      expect(status).toBe("done");
      expect(prompts.offered).toHaveLength(1);
      expect(lines).toContain('  decided "Ship it", not available here');
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      expect(yield* fs.readFileString(path.join(run.dir, "log.txt"))).toContain(
        'decided "Ship it", not available here',
      );
    }),
  ));

test("one offered choice is taken, and a spent round still asks", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "lonely",
        `---
name: lonely
inputs:
  goal: goal
steps:
  - id: next
    choices:
      - title: Stop here
        stop: true
---
Goal: {{inputs.goal}}
`,
      );
      const prompts = scriptedPrompts([]);

      const { status, lines } = yield* runWorkflowEffect(rig, "lonely", { goal: "g" }, { prompts });

      expect(status).toBe("done");
      expect(prompts.offered).toHaveLength(0);
      expect(lines).toContain("  ▸ Stop here (only option)");
    }),
  ));

test("two choices may share a title only as a handoff and its unless twin", () =>
  runEffect(
    Effect.gen(function* () {
      const defs = yield* loadDefinitions(
        layerSet(rig.baselineDir, rig.configDir, `${rig.projectDir}/.herdr`),
      );
      // The baseline pair: one decision, two implementations.
      const review = resolveWorkflow("review", defs, FALLBACK_DEFAULTS);
      const post = review.steps.find((s) => s.id === "post")!;
      expect(post.choices!.filter((c) => c.title === "Fix findings")).toHaveLength(2);
      expect(yield* validateWorkflow(review, defs, FALLBACK_DEFAULTS)).toEqual([]);

      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "twins",
        `---
name: twins
inputs:
  goal: goal
steps:
  - id: next
    choices:
      - title: Stop here
        stop: true
      - title: Stop here
        stop: true
---
Goal: {{inputs.goal}}
`,
      );
      const again = yield* loadDefinitions(
        layerSet(rig.baselineDir, rig.configDir, `${rig.projectDir}/.herdr`),
      );
      expect(
        yield* validateWorkflow(
          resolveWorkflow("twins", again, FALLBACK_DEFAULTS),
          again,
          FALLBACK_DEFAULTS,
        ),
      ).toEqual(['workflow "twins" step "next": duplicate choice title "Stop here"']);
    }),
  ));

test("a decision that is not available but leaves one option is taken, not announced", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "lonely-decided",
        `---
name: lonely-decided
inputs:
  goal: goal
steps:
  - id: next
    choices:
      - title: Stop here
        stop: true
---
Goal: {{inputs.goal}}
`,
      );
      const prompts = scriptedPrompts([]);

      const { status, lines } = yield* runWorkflowEffect(
        rig,
        "lonely-decided",
        { goal: "g" },
        { prompts, decisions: { next: "Ship it" } },
      );

      expect(status).toBe("done");
      // The run says what happened to the decision...
      expect(lines).toContain('  decided "Ship it", not available here');
      expect(lines).toContain("  ▸ Stop here (only option)");
      // ...but nobody is called to a menu that is not being drawn.
      const toasts = (yield* rig.calls()).filter((c) => c.cmd === "notification show");
      const titles = toasts.map((c) => c.argv![2] ?? "");
      expect(titles.filter((title) => title.includes("asking after all"))).toEqual([]);
    }),
  ));

test("a question brings the Session's tab to the front, unless questions are notify-only", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([CLEAN]);

      yield* runWorkflowEffect(
        rig,
        "choose",
        { goal: "focus" },
        { prompts: scriptedPrompts(["Stop here"]) },
      );

      // The default is unchanged: a question nobody sees is a Run that stopped in
      // silence, so the board's tab is brought forward.
      expect(yield* rig.cmds()).toContain("tab focus");
    }),
  ));

test("notify-only questions still toast and still say `asks you`, without taking focus", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.queueOutputs([CLEAN]);

      const { run, status } = yield* runWorkflowEffect(
        rig,
        "choose",
        { goal: "quiet" },
        { prompts: scriptedPrompts(["Stop here"]), defaults: { questions: "notify" } },
      );

      expect(status).toBe("done");
      expect(yield* rig.cmds()).not.toContain("tab focus");
      // Suppressing the jump suppresses nothing else: the toast is raised, the tab
      // still says the Run is asking, and the Choice was answerable throughout.
      expect(yield* rig.cmds()).toContain("notification show");
      const labels = (yield* rig.calls())
        .filter((c) => c.cmd === "tab rename")
        .map((c) => c.argv!.at(-1));
      expect(labels).toContain("⚠ Choose · quiet · asks you");
      expect(run.record.choices.map((c) => c.title)).toEqual(["Stop here"]);
    }),
  ));
