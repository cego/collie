import { afterEach, beforeEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bodySections,
  layers,
  loadDefinitions,
  resolveWorkflow,
  stepVariants,
  validateWorkflow,
  variantKeys,
  DefinitionError,
} from "../src/definitions";
import { FALLBACK_DEFAULTS, loadDefaults } from "../src/config";
import { Rig } from "./support/recorder";
import { layerSet, writeDef } from "./support/defs";

let rig: Rig;
const defaults = FALLBACK_DEFAULTS;

beforeEach(() => {
  rig = new Rig();
});

afterEach(async () => {
  await rig.close();
});

function ls() {
  return layerSet(rig.baselineDir, rig.configDir, join(rig.projectDir, ".herdr"));
}

const REVIEWER = "---\nname: reviewer\n---\nYou review code.";
const IMPLEMENTER = "---\nname: implementer\n---\nYou implement plans.";

test("layer dirs are baseline, user config, then the project's .herdr", () => {
  expect(layers({ pluginRoot: "/p", configDir: "/c", cwd: "/repo" })).toEqual([
    { name: "baseline", dir: "/p" },
    { name: "user", dir: "/c" },
    { name: "project", dir: "/repo/.herdr" },
  ]);
});

test("a same-named definition in a later layer wins", () => {
  writeDef(rig.baselineDir, "workflows", "review", "---\nname: review\ndescription: baseline\nsteps:\n  - id: review\n    persona: reviewer\n---\nbaseline prompt");
  writeDef(rig.configDir, "workflows", "review", "---\nname: review\ndescription: mine\nsteps:\n  - id: review\n    persona: reviewer\n---\nuser prompt");
  writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);
  writeDef(join(rig.projectDir, ".herdr"), "personas", "reviewer", "---\nname: reviewer\n---\nProject reviewer.");

  const defs = loadDefinitions(ls());

  expect(defs.errors).toEqual([]);
  expect(defs.workflows.get("review")!.layer).toBe("user");
  expect(defs.workflows.get("review")!.description).toBe("mine");
  expect(defs.personas.get("reviewer")!.layer).toBe("project");
  expect(defs.personas.get("reviewer")!.body).toBe("Project reviewer.");
});

test("use: resolves through the layers and the override changes every embedder", () => {
  writeDef(rig.baselineDir, "workflows", "review", "---\nname: review\nsteps:\n  - id: review\n    persona: reviewer\n    output: review.json\n---\nbaseline review prompt");
  writeDef(rig.baselineDir, "workflows", "implement", `---
name: implement
steps:
  - id: build
    persona: implementer
  - id: review
    use: review
    fresh: true
    parallel:
      - harness: claude
        model: sonnet
      - harness: codex
        model: gpt-5-codex
---
## build
build it

## review
never used, the embedded workflow supplies this
`);
  writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);
  writeDef(rig.baselineDir, "personas", "implementer", IMPLEMENTER);
  writeDef(join(rig.projectDir, ".herdr"), "workflows", "review", "---\nname: review\nsteps:\n  - id: review\n    persona: reviewer\n    output: review.json\n---\nproject review prompt");

  const defs = loadDefinitions(ls());
  const wf = resolveWorkflow("implement", defs, defaults);

  expect(wf.steps.map((s) => s.id)).toEqual(["build", "review"]);
  const review = wf.steps[1]!;
  expect(review.origin).toBe("review");
  expect(review.prompt).toBe("project review prompt");
  expect(review.output).toBe("review.json");
  expect(review.fresh).toBe(true);
  expect(stepVariants(review, defaults)).toEqual([
    { harness: "claude", model: "sonnet" },
    { harness: "codex", model: "gpt-5-codex" },
  ]);
  expect(validateWorkflow(wf, defs, defaults)).toEqual([]);
});

test("a use: cycle is reported, not followed", () => {
  writeDef(rig.baselineDir, "workflows", "a", "---\nname: a\nsteps:\n  - id: s\n    use: b\n---\nx");
  writeDef(rig.baselineDir, "workflows", "b", "---\nname: b\nsteps:\n  - id: s\n    use: a\n---\nx");

  expect(() => resolveWorkflow("a", loadDefinitions(ls()), defaults)).toThrow(DefinitionError);
  expect(() => resolveWorkflow("a", loadDefinitions(ls()), defaults)).toThrow("a -> b -> a");
});

test("use: of a missing workflow names the embedding step", () => {
  writeDef(rig.baselineDir, "workflows", "implement", "---\nname: implement\nsteps:\n  - id: review\n    use: nope\n---\nx");

  expect(() => resolveWorkflow("implement", loadDefinitions(ls()), defaults)).toThrow(
    'workflow "implement" step "review" uses unknown workflow "nope"',
  );
});

test("validation names the step and the bad model", () => {
  writeDef(rig.baselineDir, "workflows", "implement", `---
name: implement
steps:
  - id: build
    persona: implementer
    harness: claude
    model: sonnet
  - id: review
    persona: reviewer
    parallel:
      - harness: claude
        model: sonnet
      - harness: codex
        model: haiku
---
## build
b

## review
r
`);
  writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);
  writeDef(rig.baselineDir, "personas", "implementer", IMPLEMENTER);

  const defs = loadDefinitions(ls());
  const errors = validateWorkflow(resolveWorkflow("implement", defs, defaults), defs, defaults);

  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain('workflow "implement" step "review"');
  expect(errors[0]).toContain('unknown model "haiku" for harness "codex"');
  expect(errors[0]).toContain("gpt-5-codex");
});

test("validation names the step and the bad harness", () => {
  writeDef(rig.baselineDir, "workflows", "w", "---\nname: w\nsteps:\n  - id: s\n    persona: reviewer\n    harness: aider\n---\nprompt");
  writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);

  const defs = loadDefinitions(ls());
  const errors = validateWorkflow(resolveWorkflow("w", defs, defaults), defs, defaults);

  expect(errors[0]).toBe('workflow "w" step "s": unknown harness "aider" (known: claude, codex, opencode)');
});

test("validation catches missing personas, prompts, strategies and bad back-references", () => {
  writeDef(rig.baselineDir, "workflows", "w", `---
name: w
inputs:
  goal: interview
steps:
  - id: a
    persona: ghost
  - id: b
    persona: reviewer
    agent: nowhere
  - id: c
    persona: reviewer
    repeat:
      from: later
---
## a
a prompt

## c
c prompt
`);
  writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);

  const defs = loadDefinitions(ls());
  const errors = validateWorkflow(resolveWorkflow("w", defs, defaults), defs, defaults);

  expect(errors).toEqual([
    'workflow "w" input "goal": unknown strategy "interview" (known: goal, plan-dir, work-source, diff-target, ticket, flag)',
    'workflow "w" step "a": unknown persona "ghost" (known: reviewer)',
    'workflow "w" step "b": no prompt (add a "## b" section to w.md)',
    'workflow "w" step "b": agent "nowhere" is not an earlier step',
    'workflow "w" step "c": repeat.from "later" is not an earlier step',
  ]);
});

test("a broken definition file is reported without failing the rest", () => {
  writeDef(rig.baselineDir, "workflows", "broken", "---\nname: broken\nnot a mapping\n---\nx");
  writeDef(rig.baselineDir, "workflows", "fine", "---\nname: fine\nsteps:\n  - id: s\n    persona: reviewer\n---\nx");

  const defs = loadDefinitions(ls());

  expect(defs.workflows.has("fine")).toBe(true);
  expect(defs.errors).toHaveLength(1);
  expect(defs.errors[0]).toContain("broken.md");
});

test("the body splits into a preamble plus one section per step heading", () => {
  expect(bodySections("shared\n\n## build\nbuild me\n\n## fix\nfix me\n")).toEqual({
    preamble: "shared",
    sections: new Map([
      ["build", "build me"],
      ["fix", "fix me"],
    ]),
  });
});

test("user defaults come from config.json in the config layer", () => {
  expect(loadDefaults(rig.configDir)).toEqual(FALLBACK_DEFAULTS);
  writeFileSync(
    join(rig.configDir, "config.json"),
    JSON.stringify({
      harness: "codex",
      model: "gpt-5",
      max_iterations: 2,
      handoff_timeout_ms: 60_000,
      models: { opencode: ["local/foo"] },
    }),
  );

  expect(loadDefaults(rig.configDir)).toEqual({
    harness: "codex",
    model: "gpt-5",
    maxIterations: 2,
    handoffTimeoutMs: 60_000,
    models: { opencode: ["local/foo"] },
    trust: "ask",
  });
});

test("effort resolves from the variant, the step, then the user default", () => {
  writeDef(rig.baselineDir, "workflows", "w", `---
name: w
steps:
  - id: a
    persona: reviewer
    effort: high
  - id: b
    persona: reviewer
    parallel:
      - { harness: claude, model: opus, effort: xhigh }
      - { harness: claude, model: sonnet }
  - id: c
    persona: reviewer
---
## a
a

## b
b

## c
c
`);
  writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);

  const defs = loadDefinitions(ls());
  const withDefault = { ...defaults, effort: "medium" };
  const wf = resolveWorkflow("w", defs, withDefault);

  expect(stepVariants(wf.steps[0]!, withDefault)).toEqual([
    { harness: "claude", model: "sonnet", effort: "high" },
  ]);
  expect(stepVariants(wf.steps[1]!, withDefault)).toEqual([
    { harness: "claude", model: "opus", effort: "xhigh" },
    { harness: "claude", model: "sonnet", effort: "medium" },
  ]);
  expect(stepVariants(wf.steps[2]!, withDefault)).toEqual([
    { harness: "claude", model: "sonnet", effort: "medium" },
  ]);
  // No default set means the harness decides, so no flag is passed at all.
  expect(stepVariants(wf.steps[2]!, defaults)).toEqual([{ harness: "claude", model: "sonnet" }]);
  expect(validateWorkflow(wf, defs, withDefault)).toEqual([]);
});

test("validation names the step for a bad effort and for a harness without one", () => {
  writeDef(rig.baselineDir, "workflows", "w", `---
name: w
steps:
  - id: a
    persona: reviewer
    effort: ludicrous
  - id: b
    persona: reviewer
    harness: codex
    model: gpt-5
    effort: xhigh
---
## a
a

## b
b
`);
  writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);

  const defs = loadDefinitions(ls());
  const errors = validateWorkflow(resolveWorkflow("w", defs, defaults), defs, defaults);

  expect(errors).toEqual([
    'workflow "w" step "a": unknown effort "ludicrous" for harness "claude" (known: low, medium, high, xhigh, max)',
    'workflow "w" step "b": harness "codex" has no effort setting',
  ]);
});

test("variant names take in effort only when harness and model would collide", () => {
  expect(variantKeys([{ harness: "claude", model: "opus", effort: "xhigh" }])).toEqual([null]);
  expect(
    variantKeys([
      { harness: "claude", model: "opus", effort: "xhigh" },
      { harness: "claude", model: "sonnet", effort: "xhigh" },
    ]),
  ).toEqual(["claude-opus", "claude-sonnet"]);
  expect(
    variantKeys([
      { harness: "claude", model: "opus", effort: "high" },
      { harness: "claude", model: "opus", effort: "xhigh" },
    ]),
  ).toEqual(["claude-opus-high", "claude-opus-xhigh"]);
  // Genuinely identical variants still get distinct names rather than clashing.
  expect(
    variantKeys([
      { harness: "claude", model: "opus" },
      { harness: "claude", model: "opus" },
    ]),
  ).toEqual(["claude-opus", "claude-opus-2"]);
});

const ARCH = `---
name: arch
steps:
  - id: arch
    persona: reviewer
    prompt: attended
    output: arch.json
---
Project: {{cwd}}

## attended
Run the real interview.

## unattended
Apply Strong candidates only, top first, at most two passes.
`;

test("a step may name a body section other than its id, and an embedder may pick another", () => {
  writeDef(rig.baselineDir, "workflows", "arch", ARCH);
  writeDef(
    rig.baselineDir,
    "workflows",
    "outer",
    `---
name: outer
steps:
  - id: build
    persona: reviewer
    output: build.json
  - id: arch
    use: arch
    prompt: unattended
    agent: build
---
## build
build it
`,
  );
  writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);

  const defs = loadDefinitions(ls());

  const standalone = resolveWorkflow("arch", defs, defaults);
  expect(standalone.steps[0]!.prompt).toBe("Run the real interview.");
  expect(validateWorkflow(standalone, defs, defaults)).toEqual([]);

  const outer = resolveWorkflow("outer", defs, defaults);
  expect(outer.steps[1]!.prompt).toBe("Apply Strong candidates only, top first, at most two passes.");
  expect(outer.steps[1]!.preamble).toBe("Project: {{cwd}}");
  expect(outer.steps[1]!.origin).toBe("arch");
  expect(outer.steps[1]!.agent).toBe("build");
  expect(validateWorkflow(outer, defs, defaults)).toEqual([]);
});

test("an unknown prompt section names the file and the sections it does have", () => {
  writeDef(rig.baselineDir, "workflows", "arch", ARCH.replace("prompt: attended", "prompt: nowhere"));
  writeDef(
    rig.baselineDir,
    "workflows",
    "outer",
    "---\nname: outer\nsteps:\n  - id: arch\n    use: arch\n    prompt: elsewhere\n---\nx",
  );
  writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);

  const defs = loadDefinitions(ls());

  expect(validateWorkflow(resolveWorkflow("arch", defs, defaults), defs, defaults)).toEqual([
    'workflow "arch" step "arch": unknown prompt section "nowhere" in arch.md (known: attended, unattended)',
  ]);
  expect(validateWorkflow(resolveWorkflow("outer", defs, defaults), defs, defaults)).toEqual([
    'workflow "outer" step "arch": unknown prompt section "elsewhere" in arch.md (known: attended, unattended)',
  ]);
});
