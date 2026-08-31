import { afterEach, beforeEach, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  expect(errors[0]).toBe('workflow "w" step "s": unknown harness "aider" (known: claude, codex, opencode, pi)');
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

test("fan_in, requires and a post choice are validated like every other back-reference", () => {
  writeDef(rig.baselineDir, "workflows", "w", `---
name: w
steps:
  - id: a
    persona: reviewer
    fan_in: later
    requires: [gitlab, moonlight]
  - id: b
    requires: mr-target
    choices:
      - title: Both
        post: true
        stop: true
      - title: Neither
---
## a
a prompt
`);
  writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);

  const defs = loadDefinitions(ls());
  const wf = resolveWorkflow("w", defs, defaults);

  // A single requirement and a list of them both parse to a list.
  expect(wf.steps.map((s) => s.requires as string[])).toEqual([["gitlab", "moonlight"], ["mr-target"]]);
  expect(validateWorkflow(wf, defs, defaults)).toEqual([
    'workflow "w" step "a": unknown requires "moonlight" (known: gitlab, mr-target)',
    'workflow "w" step "a": fan_in "later" is not an earlier step',
    'workflow "w" step "a": fan_in needs an output, so the synthesis can be read',
    'workflow "w" step "b" choice "Both": needs exactly one of run, prompt, post, handoff or stop',
    'workflow "w" step "b" choice "Neither": needs exactly one of run, prompt, post, handoff or stop',
  ]);
});

test("an embedded step that shares the embedding step's name keeps it; its siblings are prefixed", () => {
  writeDef(rig.baselineDir, "workflows", "review", `---
name: review
steps:
  - id: review
    persona: reviewer
    output: review.json
  - id: synthesize
    persona: reviewer
    fan_in: review
    output: synthesized.json
---
## review
review it

## synthesize
{{fan_in}}
`);
  writeDef(rig.baselineDir, "workflows", "implement", `---
name: implement
steps:
  - id: build
    persona: implementer
  - id: review
    use: review
    fresh: true
  - id: fix
    persona: implementer
    repeat:
      from: review.synthesize
---
## build
build it

## fix
fix it
`);
  writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);
  writeDef(rig.baselineDir, "personas", "implementer", IMPLEMENTER);

  const defs = loadDefinitions(ls());
  const wf = resolveWorkflow("implement", defs, defaults);

  expect(wf.steps.map((s) => s.id)).toEqual(["build", "review", "review.synthesize", "fix"]);
  // The fan-in reference moved with the step it points at.
  expect(wf.steps[2]!.fanIn).toBe("review");
  expect(validateWorkflow(wf, defs, defaults)).toEqual([]);
});

test("model: default validates for every harness and is what the step runs on", () => {
  writeDef(rig.baselineDir, "workflows", "w", `---
name: w
steps:
  - id: s
    persona: reviewer
    model: default
    effort: medium
    parallel:
      - { harness: claude, model: default }
      - { harness: codex, model: default }
      - { harness: opencode, model: default }
---
## s
do it
`);
  writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);

  const defs = loadDefinitions(ls());
  const wf = resolveWorkflow("w", defs, defaults);

  // codex and opencode have no effort flag, so only claude's effort survives validation.
  expect(validateWorkflow(wf, defs, defaults)).toEqual([
    'workflow "w" step "s": harness "codex" has no effort setting',
    'workflow "w" step "s": harness "opencode" has no effort setting',
  ]);
  expect(stepVariants(wf.steps[0]!, defaults)).toEqual([
    { harness: "claude", model: "default", effort: "medium" },
    { harness: "codex", model: "default", effort: "medium" },
    { harness: "opencode", model: "default", effort: "medium" },
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

test("a skill a definition asks for and nothing installed is a validation error", () => {
  const dir = mkdtempSync(join(tmpdir(), "hw-skills-"));
  writeDef(
    dir,
    "personas",
    "reviewer",
    `---
name: reviewer
description: reviews
---
Your skills: {{skill:code-review}} and {{skill:not-installed}}.
`,
  );
  writeDef(
    dir,
    "workflows",
    "w",
    `---
name: w
steps:
  - id: a
    persona: reviewer
    skill: to-spec
---
## a
Run {{skill:tdd}}.
`,
  );
  const defs = loadDefinitions(layerSet(dir, join(dir, "user"), join(dir, "project")));
  const wf = resolveWorkflow("w", defs, FALLBACK_DEFAULTS);

  // Two skills are installed; the other two are not, and each is named once with the
  // command that installs it. A missing skill is a prerequisite, not a definition bug.
  const skills = join(dir, "installed");
  for (const name of ["code-review", "tdd"]) mkdirSync(join(skills, name), { recursive: true });

  const errors = validateWorkflow(wf, defs, FALLBACK_DEFAULTS, [skills]);
  expect(errors).toEqual([
    'w step "a": the skill "to-spec" is not installed — run `npx skills add to-spec`',
    'persona "reviewer": the skill "not-installed" is not installed — run `npx skills add not-installed`',
  ]);

  // Everything installed, and the workflow validates.
  for (const name of ["to-spec", "not-installed"]) mkdirSync(join(skills, name), { recursive: true });
  expect(validateWorkflow(wf, defs, FALLBACK_DEFAULTS, [skills])).toEqual([]);

  // Either dir counts, and no dirs at all means the check is not made.
  expect(validateWorkflow(wf, defs, FALLBACK_DEFAULTS, ["/nowhere", skills])).toEqual([]);
  expect(validateWorkflow(wf, defs, FALLBACK_DEFAULTS)).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});

test("extends changes only what it names", () => {
  writeDef(
    rig.baselineDir,
    "personas",
    "reviewer",
    "---\nname: reviewer\ndescription: base\n---\nBase reviewer.",
  );
  writeDef(
    rig.baselineDir,
    "workflows",
    "review",
    `---
name: review
title: review — the baseline one
description: base description
inputs:
  target: diff-target
max_iterations: 5
steps:
  - id: review
    persona: reviewer
    output: review.json
    parallel:
      - { harness: claude, model: opus, effort: xhigh }
      - { harness: claude, model: sonnet, effort: xhigh }
  - id: synthesize
    persona: reviewer
    fan_in: review
    output: synthesized.json
---
Shared preamble.

## review
The baseline review body.

## synthesize
The baseline synthesis body.
`,
  );
  // The canonical use: different reviewers, everything else untouched.
  writeDef(
    rig.configDir,
    "workflows",
    "review",
    `---
name: review
extends: review
inputs:
  extra: goal
steps:
  - id: review
    parallel:
      - { harness: claude, model: opus, effort: medium }
      - { harness: pi, model: openai-codex/gpt-5.6-sol, effort: medium }
  - id: afterwards
    persona: reviewer
    output: after.json
---
## review
My review body.

## afterwards
Something new.
`,
  );

  const defs = loadDefinitions(layers(rig.pluginEnv()));
  const wf = defs.workflows.get("review")!;

  // Scalars the child did not name are still the parent's.
  expect(wf.layer).toBe("user");
  expect(wf.extends).toBe("review");
  expect(wf.title).toBe("review — the baseline one");
  expect(wf.description).toBe("base description");
  expect(wf.maxIterations).toBe(5);
  // Inputs merge by name.
  expect(wf.inputs).toEqual({ target: "diff-target", extra: "goal" });

  // Steps match by id; a new id is appended after the parent's.
  expect(wf.steps.map((step) => step.id)).toEqual(["review", "synthesize", "afterwards"]);
  // `parallel` is replaced whole, not merged entry by entry.
  expect(wf.steps[0]!.parallel).toEqual([
    { harness: "claude", model: "opus", effort: "medium" },
    { harness: "pi", model: "openai-codex/gpt-5.6-sol", effort: "medium" },
  ]);
  // Keys the child's step did not name survive from the parent's.
  expect(wf.steps[0]!.persona).toBe("reviewer");
  expect(wf.steps[0]!.output).toBe("review.json");
  expect(wf.steps[1]!.fanIn).toBe("review");

  // Sections: replaced by name, new ones appended, and an empty child preamble
  // leaves the parent's alone.
  const body = bodySections(wf.body);
  expect(body.preamble).toBe("Shared preamble.");
  expect(body.sections.get("review")).toBe("My review body.");
  expect(body.sections.get("synthesize")).toBe("The baseline synthesis body.");
  expect(body.sections.get("afterwards")).toBe("Something new.");
});

test("a child preamble replaces the parent's, but only when it has one", () => {
  writeDef(rig.baselineDir, "personas", "p", "---\nname: p\n---\nBase persona.\n\n## Output\nBase output.");
  writeDef(rig.configDir, "personas", "p", "---\nname: p\nextends: p\n---\nMine.\n\n## Output\nMine too.");

  const mine = loadDefinitions(layers(rig.pluginEnv())).personas.get("p")!;
  expect(bodySections(mine.body).preamble).toBe("Mine.");
  expect(bodySections(mine.body).sections.get("Output")).toBe("Mine too.");
});

test("an unknown parent and a cycle are errors that name the file", () => {
  writeDef(rig.configDir, "workflows", "orphan", "---\nname: orphan\nextends: nobody\n---\n## a\nx");
  writeDef(rig.configDir, "workflows", "a", "---\nname: a\nextends: b\n---\n## a\nx");
  writeDef(rig.configDir, "workflows", "b", "---\nname: b\nextends: a\n---\n## a\nx");

  const defs = loadDefinitions(layers(rig.pluginEnv()));

  expect(defs.errors.some((e) => e.includes("orphan.md") && e.includes('extends "nobody"'))).toBe(true);
  expect(defs.errors.some((e) => e.includes("extends cycle"))).toBe(true);
  // Nothing half-merged goes in: a definition that could not resolve is simply absent.
  expect(defs.workflows.has("orphan")).toBe(false);
});

test("a file with no extends still replaces the whole definition", () => {
  writeDef(rig.baselineDir, "workflows", "w", "---\nname: w\ntitle: base\ninputs:\n  a: goal\n---\n## s\nbase");
  writeDef(rig.configDir, "workflows", "w", "---\nname: w\n---\n## s\nmine");

  const wf = loadDefinitions(layers(rig.pluginEnv())).workflows.get("w")!;
  expect(wf.title).toBe("w");
  expect(wf.inputs).toEqual({});
  expect(bodySections(wf.body).sections.get("s")).toBe("mine");
});

test("names that cannot be one path component inside the Run are rejected, naming the field", () => {
  writeDef(rig.baselineDir, "workflows", "w", `---
name: w
steps:
  - id: ../evil
    persona: reviewer
    output: build.json
  - id: ok
    persona: reviewer
    output: /etc/passwd
  - id: menu
    persona: reviewer
    choices:
      - title: Refine
        prompt: refine
        output: sub/dir.json
---
## ../evil
a

## ok
b

## refine
c
`);
  writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);

  const defs = loadDefinitions(ls());
  const errors = validateWorkflow(resolveWorkflow("w", defs, defaults), defs, defaults);

  expect(errors.some((e) => e.includes('workflow "w" step "../evil"') && e.includes("id"))).toBe(true);
  expect(errors.some((e) => e.includes('step "ok"') && e.includes('output "/etc/passwd"'))).toBe(true);
  expect(errors.some((e) => e.includes('choice "Refine"') && e.includes('output "sub/dir.json"'))).toBe(true);
});

test("a persona whose name cannot be a filename component is rejected", () => {
  writeDef(rig.baselineDir, "workflows", "w", "---\nname: w\nsteps:\n  - id: s\n    persona: ../escape\n---\n## s\nx");
  writeDef(rig.baselineDir, "personas", "escape", "---\nname: ../escape\n---\nEvil.");

  const defs = loadDefinitions(ls());
  const errors = validateWorkflow(resolveWorkflow("w", defs, defaults), defs, defaults);

  expect(errors.some((e) => e.includes('step "s"') && e.includes('persona "../escape"'))).toBe(true);
});

test("dots inside an id are fine; empty, dot and separator components are not", () => {
  writeDef(rig.baselineDir, "workflows", "w", "---\nname: w\nsteps:\n  - id: build.tickets\n    persona: reviewer\n    output: out.json\n---\n## build.tickets\nx");
  writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);

  const defs = loadDefinitions(ls());
  expect(validateWorkflow(resolveWorkflow("w", defs, defaults), defs, defaults)).toEqual([]);
});

test("a provider-qualified model becomes one safe directory component in its variant key", () => {
  expect(
    variantKeys([
      { harness: "pi", model: "openai-codex/gpt-5.6-sol" },
      { harness: "claude", model: "opus" },
    ]),
  ).toEqual(["pi-openai-codex-gpt-5.6-sol", "claude-opus"]);
});

test("a workflow whose own name cannot be a path component is rejected before a Run exists", () => {
  writeDef(rig.baselineDir, "workflows", "evil", "---\nname: ../../escaped\nsteps:\n  - id: s\n    persona: reviewer\n---\n## s\nx");
  writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);

  const defs = loadDefinitions(ls());
  const errors = validateWorkflow(resolveWorkflow("../../escaped", defs, defaults), defs, defaults);

  expect(errors.some((e) => e.includes('workflow "../../escaped"') && e.includes("Run directory"))).toBe(true);
});

test("variant keys stay unique even when encoding makes different models collide", () => {
  expect(
    variantKeys([
      { harness: "pi", model: "p/foo:bar" },
      { harness: "pi", model: "p/foo-bar" },
      { harness: "pi", model: "p/foo-bar-2" },
    ]),
  ).toEqual(["pi-p-foo-bar", "pi-p-foo-bar-2", "pi-p-foo-bar-2-2"]);
});
