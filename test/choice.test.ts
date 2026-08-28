import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Rig } from "./support/recorder";
import { installBaseline, runWorkflow, scriptedPrompts } from "./support/engine";
import { layerSet, writeDef } from "./support/defs";
import { FALLBACK_DEFAULTS } from "../src/config";
import { loadDefinitions, resolveWorkflow, validateWorkflow } from "../src/definitions";
import { RunStore } from "../src/run";

let rig: Rig;

beforeEach(async () => {
  rig = new Rig();
  await rig.startSocket();
  installBaseline(rig);
  writeDef(rig.baselineDir, "workflows", "choose", CHOOSE);
});

afterEach(async () => {
  await rig.close();
});

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

test("a prompt choice prompts the named agent and offers the menu again", async () => {
  rig.queueOutputs([CLEAN, CLEAN]);
  const prompts = scriptedPrompts(["Refine", "Stop here"]);

  const { run, status, lines } = await runWorkflow(rig, "choose", { goal: "Add a picker" }, { prompts });

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
  const prompted = rig.calls().filter((c) => c.cmd === "agent prompt").map((c) => c.argv![2]);
  expect(prompted).toEqual([drafter, drafter]);
  const round = readFileSync(join(run.dir, "steps", "next", "refine-1", "prompt-1.md"), "utf8");
  expect(round).toContain("The human wants changes");
  expect(round).toContain("Goal: Add a picker");
  expect(run.step("next").variants[0]!.output).toBe("steps/next/refine-1/refine.json");
});

test("a fresh reviewer choice gets its own tab and its findings prompt the follow-up", async () => {
  rig.queueOutputs([CLEAN, FINDING, CLEAN]);
  const prompts = scriptedPrompts(["Second opinion", "Stop here"]);

  const { run, status } = await runWorkflow(rig, "choose", { goal: "g" }, { prompts });

  expect(status).toBe("done");
  // The run's own tab takes the workflow's name; the round's takes its step's.
  // Neither says which choice started it, and neither says the target.
  const labels = rig.calls().filter((c) => c.cmd === "tab create").map((c) => c.argv!.at(-2));
  expect(labels).toEqual(["⚙ choose", "⚙ next"]);

  // The run's own pane is the smaller half of the board's tab, so a menu takes the
  // whole tab while it is open and gives it back afterwards — once per menu shown.
  const zooms = rig.calls().filter((c) => c.cmd === "pane zoom").map((c) => c.argv!.slice(2));
  expect(zooms.length).toBeGreaterThan(0);
  expect(zooms.length % 2).toBe(0);
  for (const [i, z] of zooms.entries()) {
    expect(z[0]).toBe("1-0");
    expect(z[1]).toBe(i % 2 === 0 ? "--on" : "--off");
  }

  const start = rig.calls().filter((c) => c.cmd === "agent start").at(-1)!.argv!;
  expect(start.slice(7)).toEqual([
    "--",
    "--model",
    "opus",
    "--effort",
    "xhigh",
    "--append-system-prompt-file",
    join(run.dir, "personas", "reviewer.md"),
  ]);

  const followUp = readFileSync(join(run.dir, "steps", "next", "second-opinion-1-then", "prompt-1.md"), "utf8");
  expect(followUp).toContain("- [major] no story for the CLI");
  expect(followUp).toContain("Revise the spec.");
  const drafter = run.step("draft").variants[0]!.agent;
  expect(rig.calls().filter((c) => c.cmd === "agent prompt").at(-1)!.argv![2]).toBe(drafter);
  expect(run.step("next").variants.map((v) => v.status)).toEqual(["done", "done"]);
});

test("a clean round skips the follow-up, and max caps how often a choice is offered", async () => {
  rig.queueOutputs([CLEAN, CLEAN, CLEAN]);
  const prompts = scriptedPrompts(["Second opinion", "Second opinion", "Stop here"]);

  const { run, status } = await runWorkflow(rig, "choose", { goal: "g" }, { prompts });

  expect(status).toBe("done");
  expect(prompts.offered.at(-1)).toEqual(["Offload", "Refine", "Stop here"]);
  expect(existsSync(join(run.dir, "steps", "next", "second-opinion-1-then"))).toBe(false);
  expect(run.step("next").variants).toHaveLength(2);
});

test("a config key a choice needs is asked once and remembered in config.json", async () => {
  rig.queueOutputs([CLEAN, CLEAN, CLEAN]);
  const prompts = scriptedPrompts(["Offload", "Offload", "Stop here"], ["CEGO"]);

  const { run, status } = await runWorkflow(rig, "choose", { goal: "g" }, { prompts });

  expect(status).toBe("done");
  expect(prompts.asked).toEqual(["Linear team key"]);
  expect(JSON.parse(readFileSync(join(rig.configDir, "config.json"), "utf8")).linear).toEqual({
    team: "CEGO",
  });
  const first = readFileSync(join(run.dir, "steps", "next", "offload-1", "prompt-1.md"), "utf8");
  expect(first).toContain("Put the spec on the CEGO board.");
});

test("cancelling the menu leaves the step unfinished so the run can be resumed", async () => {
  rig.queueOutputs([CLEAN]);
  const prompts = scriptedPrompts([null]);

  const { run, status } = await runWorkflow(rig, "choose", { goal: "g" }, { prompts });

  expect(status).toBe("blocked");
  expect(run.step("next").status).toBe("blocked");
  expect(run.step("next").note).toBe("no choice taken");
  expect(new RunStore(rig.stateDir).resumable().map((r) => r.id)).toEqual([run.id]);
});

test("choices are validated before anything opens", () => {
  writeDef(
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

  const defs = loadDefinitions(layerSet(rig.baselineDir, rig.configDir, join(rig.projectDir, ".herdr")));
  const errors = validateWorkflow(resolveWorkflow("bad", defs, FALLBACK_DEFAULTS), defs, FALLBACK_DEFAULTS);

  expect(errors).toEqual([
    'workflow "bad" step "next" choice "Both": needs exactly one of run, prompt, post or stop',
    'workflow "bad" step "next" choice "Both": needs a persona or an agent',
    'workflow "bad" step "next" choice "Both": needs an output, so the round can finish',
    'workflow "bad" step "next" choice "Neither": needs exactly one of run, prompt, post or stop',
    'workflow "bad" step "next" choice 3: needs a title',
    'workflow "bad" step "next" choice 3: needs a persona or an agent',
    'workflow "bad" step "next" choice 3: needs an output, so the round can finish',
    'workflow "bad" step "next" choice "No such section": unknown prompt section "nowhere" in bad.md (known: draft, refine)',
    'workflow "bad" step "next" choice "No such agent": agent "ghost" is not an earlier step',
    'workflow "bad" step "next" choice "Bad model": unknown model "haiku" for harness "codex" (known: default, gpt-5-codex, gpt-5, gpt-5-mini or anything matching ^(?:gpt|o)[0-9][a-z0-9.-]*$)',
  ]);
});

test("a choice step needs no persona and no prompt section of its own", () => {
  const defs = loadDefinitions(layerSet(rig.baselineDir, rig.configDir, join(rig.projectDir, ".herdr")));
  const wf = resolveWorkflow("choose", defs, FALLBACK_DEFAULTS);

  expect(validateWorkflow(wf, defs, FALLBACK_DEFAULTS)).toEqual([]);
  expect(wf.steps[1]!.choices!.map((c) => c.title)).toEqual([
    "Second opinion",
    "Offload",
    "Refine",
    "Stop here",
  ]);
  expect(wf.steps[1]!.choices![0]!.round!.prompt).toContain("plan-level problems only");
});
