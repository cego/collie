import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";
import {
  bodySections,
  layers,
  loadDefinitions,
  resolveWorkflow,
  stepVariants,
  validateWorkflow,
  variantKeys,
  STEP_WAITS,
  DefinitionError,
} from "../src/definitions";
import { FALLBACK_DEFAULTS, loadDefaults } from "../src/config";
import { Rig } from "./support/recorder";
import { layerSet, writeDef } from "./support/defs";

const join = (...parts: string[]) => parts.join("/").replace(/\/+/g, "/");
const writeText = Effect.fn("test.writeText")(function* (path: string, text: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(path, text);
});
const mkdirp = Effect.fn("test.mkdirp")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(path, { recursive: true });
});
const tempDir = Effect.fn("test.tempDir")(function* (prefix: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectory({ prefix });
});
const removeTree = Effect.fn("test.removeTree")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(path, { recursive: true, force: true });
});

let rig: Rig;
const defaults = FALLBACK_DEFAULTS;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

function ls() {
  return layerSet(rig.baselineDir, rig.configDir, join(rig.projectDir, ".herdr"));
}

const REVIEWER = "---\nname: reviewer\n---\nYou review code.";
const IMPLEMENTER = "---\nname: implementer\n---\nYou implement plans.";

test("layer dirs are baseline, user config, then the project's .herdr", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* layers({ pluginRoot: "/p", configDir: "/c", cwd: "/repo" })).toEqual({
        baseline: { name: "baseline", dir: "/p" },
        user: { name: "user", dir: "/c" },
        project: { name: "project", dir: "/repo/.herdr" },
        all: [
          { name: "baseline", dir: "/p" },
          { name: "user", dir: "/c" },
          { name: "project", dir: "/repo/.herdr" },
        ],
      });
    }),
  ));

test("a same-named definition in a later layer wins", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "review",
        "---\nname: review\ndescription: baseline\nsteps:\n  - id: review\n    persona: reviewer\n---\nbaseline prompt",
      );
      yield* writeDef(
        rig.configDir,
        "workflows",
        "review",
        "---\nname: review\ndescription: mine\nsteps:\n  - id: review\n    persona: reviewer\n---\nuser prompt",
      );
      yield* writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);
      yield* writeDef(
        join(rig.projectDir, ".herdr"),
        "personas",
        "reviewer",
        "---\nname: reviewer\n---\nProject reviewer.",
      );

      const defs = yield* loadDefinitions(ls());

      expect(defs.errors).toEqual([]);
      expect(defs.workflows.get("review")!.layer).toBe("user");
      expect(defs.workflows.get("review")!.description).toBe("mine");
      expect(defs.personas.get("reviewer")!.layer).toBe("project");
      expect(defs.personas.get("reviewer")!.body).toBe("Project reviewer.");
    }),
  ));

test("use: resolves through the layers and the override changes every embedder", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "review",
        "---\nname: review\nsteps:\n  - id: review\n    persona: reviewer\n    output: review.json\n---\nbaseline review prompt",
      );
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "implement",
        `---
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
`,
      );
      yield* writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);
      yield* writeDef(rig.baselineDir, "personas", "implementer", IMPLEMENTER);
      yield* writeDef(
        join(rig.projectDir, ".herdr"),
        "workflows",
        "review",
        "---\nname: review\nsteps:\n  - id: review\n    persona: reviewer\n    output: review.json\n---\nproject review prompt",
      );

      const defs = yield* loadDefinitions(ls());
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
      expect(yield* validateWorkflow(wf, defs, defaults)).toEqual([]);
    }),
  ));

test("a use: cycle is reported, not followed", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "a",
        "---\nname: a\nsteps:\n  - id: s\n    use: b\n---\nx",
      );
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "b",
        "---\nname: b\nsteps:\n  - id: s\n    use: a\n---\nx",
      );

      const defs = yield* loadDefinitions(ls());
      expect(() => resolveWorkflow("a", defs, defaults)).toThrow(DefinitionError);
      expect(() => resolveWorkflow("a", defs, defaults)).toThrow("a -> b -> a");
    }),
  ));

test("use: of a missing workflow names the embedding step", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "implement",
        "---\nname: implement\nsteps:\n  - id: review\n    use: nope\n---\nx",
      );

      const defs = yield* loadDefinitions(ls());
      expect(() => resolveWorkflow("implement", defs, defaults)).toThrow(
        'workflow "implement" step "review" uses unknown workflow "nope"',
      );
    }),
  ));

test("validation names the step and the bad model", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "implement",
        `---
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
`,
      );
      yield* writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);
      yield* writeDef(rig.baselineDir, "personas", "implementer", IMPLEMENTER);

      const defs = yield* loadDefinitions(ls());
      const errors = yield* validateWorkflow(
        resolveWorkflow("implement", defs, defaults),
        defs,
        defaults,
      );

      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('workflow "implement" step "review"');
      expect(errors[0]).toContain('unknown model "haiku" for harness "codex"');
      expect(errors[0]).toContain("gpt-5-codex");
    }),
  ));

test("validation names the step and the bad harness", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "w",
        "---\nname: w\nsteps:\n  - id: s\n    persona: reviewer\n    harness: aider\n---\nprompt",
      );
      yield* writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);

      const defs = yield* loadDefinitions(ls());
      const errors = yield* validateWorkflow(resolveWorkflow("w", defs, defaults), defs, defaults);

      expect(errors[0]).toBe(
        'workflow "w" step "s": unknown harness "aider" (known: claude, codex, opencode, pi)',
      );
    }),
  ));

test("validation catches missing personas, prompts, strategies and bad back-references", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "w",
        `---
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
`,
      );
      yield* writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);

      const defs = yield* loadDefinitions(ls());
      const errors = yield* validateWorkflow(resolveWorkflow("w", defs, defaults), defs, defaults);

      expect(errors).toEqual([
        'workflow "w" input "goal": unknown strategy "interview" (known: goal, plan-dir, work-source, diff-target, ticket, flag, optional, gitlab-repository)',
        'workflow "w" step "a": unknown persona "ghost" (known: reviewer)',
        'workflow "w" step "b": no prompt (add a "## b" section to w.md)',
        'workflow "w" step "b": agent "nowhere" is not an earlier step',
        'workflow "w" step "c": repeat.from "later" is not an earlier step',
      ]);
    }),
  ));

test("fan_in, requires and a post choice are validated like every other back-reference", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "w",
        `---
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
`,
      );
      yield* writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);

      const defs = yield* loadDefinitions(ls());
      const wf = resolveWorkflow("w", defs, defaults);

      // A single requirement and a list of them both parse to a list.
      expect(wf.steps.map((s) => s.requires ?? [])).toEqual([
        ["gitlab", "moonlight"],
        ["mr-target"],
      ]);
      expect(yield* validateWorkflow(wf, defs, defaults)).toEqual([
        'workflow "w" step "a": unknown requires "moonlight" (known: gitlab, mr-target, someone-elses-mr)',
        'workflow "w" step "a": fan_in "later" is not an earlier step',
        'workflow "w" step "a": fan_in needs an output, so the synthesis can be read',
        'workflow "w" step "b" choice "Both": needs exactly one of run, prompt, post, handoff or stop',
        'workflow "w" step "b" choice "Neither": needs exactly one of run, prompt, post, handoff or stop',
      ]);
    }),
  ));

test("waits: is validated like requires:, and a misspelling names the workflow and step", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "w",
        `---
name: w
steps:
  - id: a
    persona: reviewer
    waits: helle
  - id: b
    persona: reviewer
    waits: [helle, hell]
---
## a
a prompt

## b
b prompt
`,
      );
      yield* writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);

      const defs = yield* loadDefinitions(ls());
      const wf = resolveWorkflow("w", defs, defaults);

      expect(wf.steps.map((s) => s.waits ?? [])).toEqual([["helle"], ["helle", "hell"]]);
      expect(yield* validateWorkflow(wf, defs, defaults)).toEqual([
        'workflow "w" step "b": unknown waits "hell" (known: helle)',
      ]);
    }),
  ));

test("every wait the parser accepts is documented in the authoring docs", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const docs = yield* fs.readFileString(
        new URL("../docs/authoring.md", import.meta.url).pathname,
      );

      for (const name of STEP_WAITS) expect(docs).toContain(`\`${name}\``);
      expect(docs).toContain("`waits`");
    }),
  ));

test("an embedded step that shares the embedding step's name keeps it; its siblings are prefixed", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "review",
        `---
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
`,
      );
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "implement",
        `---
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
      converge: true
---
## build
build it

## fix
fix it
`,
      );
      yield* writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);
      yield* writeDef(rig.baselineDir, "personas", "implementer", IMPLEMENTER);

      const defs = yield* loadDefinitions(ls());
      const wf = resolveWorkflow("implement", defs, defaults);

      expect(wf.steps.map((s) => s.id)).toEqual(["build", "review", "review.synthesize", "fix"]);
      // The fan-in reference moved with the step it points at.
      expect(wf.steps[2]!.fanIn).toBe("review");
      // The loop's policy travels with the rebased reference.
      expect(wf.steps[3]!.repeat).toEqual({ from: "review.synthesize", converge: true });
      expect(yield* validateWorkflow(wf, defs, defaults)).toEqual([]);
    }),
  ));

test("model: default validates for every harness and is what the step runs on", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "w",
        `---
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
`,
      );
      yield* writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);

      const defs = yield* loadDefinitions(ls());
      const wf = resolveWorkflow("w", defs, defaults);

      // codex and opencode have no effort flag, so only claude's effort survives validation.
      expect(yield* validateWorkflow(wf, defs, defaults)).toEqual([
        'workflow "w" step "s": harness "codex" has no effort setting',
        'workflow "w" step "s": harness "opencode" has no effort setting',
      ]);
      expect(stepVariants(wf.steps[0]!, defaults)).toEqual([
        { harness: "claude", model: "opus", effort: "medium" },
        { harness: "codex", model: "default", effort: "medium" },
        { harness: "opencode", model: "default", effort: "medium" },
      ]);
    }),
  ));

test("a broken definition file is reported without failing the rest", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "broken",
        "---\nname: broken\nnot a mapping\n---\nx",
      );
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "fine",
        "---\nname: fine\nsteps:\n  - id: s\n    persona: reviewer\n---\nx",
      );

      const defs = yield* loadDefinitions(ls());

      expect(defs.workflows.has("fine")).toBe(true);
      expect(defs.errors).toHaveLength(1);
      expect(defs.errors[0]).toContain("broken.md");
    }),
  ));

test("the body splits into a preamble plus one section per step heading", () =>
  runEffect(
    Effect.gen(function* () {
      yield* Effect.void;
      expect(bodySections("shared\n\n## build\nbuild me\n\n## fix\nfix me\n")).toEqual({
        preamble: "shared",
        sections: new Map([
          ["build", "build me"],
          ["fix", "fix me"],
        ]),
      });
    }),
  ));

test("user defaults come from config.json in the config layer", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* loadDefaults(rig.configDir)).toEqual(FALLBACK_DEFAULTS);
      expect(FALLBACK_DEFAULTS.model).toBe("opus");
      yield* writeText(
        join(rig.configDir, "config.json"),
        `{ "harness": "codex", "model": "gpt-5", "max_iterations": 2, "handoff_timeout_ms": 60000, "models": { "opencode": ["local/foo"] } }`,
      );

      expect(yield* loadDefaults(rig.configDir)).toEqual({
        harness: "codex",
        model: "gpt-5",
        maxIterations: 2,
        handoffTimeoutMs: 60_000,
        quietMs: FALLBACK_DEFAULTS.quietMs,
        boardQuietMs: FALLBACK_DEFAULTS.boardQuietMs,
        compactAtTokens: FALLBACK_DEFAULTS.compactAtTokens,
        notifications: {},
        models: { opencode: ["local/foo"] },
        trust: "auto",
        permissions: "bypass",
        scope: "local",
        density: "comfortable",
        questions: "focus",
        proactive: true,
      });
    }),
  ));

test("permissions defaults to bypass, takes `harness`, and names anything else", () =>
  runEffect(
    Effect.gen(function* () {
      expect(FALLBACK_DEFAULTS.permissions).toBe("bypass");

      yield* writeText(join(rig.configDir, "config.json"), `{ "permissions": "harness" }`);
      expect((yield* loadDefaults(rig.configDir)).permissions).toBe("harness");

      // Kept as written rather than coerced or thrown: coercing would fall back to
      // `bypass` and start agents unattended, and throwing would take the Settings view
      // that repairs the file down with it. Validation is what refuses it.
      yield* writeText(join(rig.configDir, "config.json"), `{ "permissions": "yolo" }`);
      const broken = yield* loadDefaults(rig.configDir);
      expect(broken.permissions).toBe("yolo");

      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "w",
        "---\nname: w\nsteps:\n  - id: a\n    persona: reviewer\n    output: a.json\n---\n## a\na\n",
      );
      yield* writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);
      const defs = yield* loadDefinitions(ls());
      expect(yield* validateWorkflow(resolveWorkflow("w", defs, broken), defs, broken)).toEqual([
        'config.json: unknown permissions "yolo" (known: bypass, harness)',
      ]);
    }),
  ));

test("effort resolves from the variant, the step, then the user default", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "w",
        `---
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
`,
      );
      yield* writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);

      const defs = yield* loadDefinitions(ls());
      const withDefault = { ...defaults, effort: "medium" };
      const wf = resolveWorkflow("w", defs, withDefault);

      expect(stepVariants(wf.steps[0]!, withDefault)).toEqual([
        { harness: "claude", model: "opus", effort: "high" },
      ]);
      expect(stepVariants(wf.steps[1]!, withDefault)).toEqual([
        { harness: "claude", model: "opus", effort: "xhigh" },
        { harness: "claude", model: "sonnet", effort: "medium" },
      ]);
      expect(stepVariants(wf.steps[2]!, withDefault)).toEqual([
        { harness: "claude", model: "opus", effort: "medium" },
      ]);
      expect(stepVariants(wf.steps[2]!, defaults)).toEqual([{ harness: "claude", model: "opus" }]);
      expect(yield* validateWorkflow(wf, defs, withDefault)).toEqual([]);
    }),
  ));

test("a step may keep the harness's own prompting, and only `bypass`/`harness` are legal", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "w",
        `---
name: w
steps:
  - id: a
    persona: reviewer
    permissions: harness
  - id: b
    persona: reviewer
  - id: c
    persona: reviewer
    permissions: whatever
  - id: d
    persona: reviewer
    permissions: false
  - id: e
    persona: reviewer
    parallel:
      - { harness: claude, model: opus, permissions: 3 }
  - id: menu
    persona: reviewer
    choices:
      - title: Refine
        prompt: refine
        permissions: nope
        output: refine.json
---
## a
a

## b
b

## c
c

## d
d

## e
e

## refine
refine
`,
      );
      yield* writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);

      const defs = yield* loadDefinitions(ls());
      const wf = resolveWorkflow("w", defs, defaults);

      expect(stepVariants(wf.steps[0]!, defaults)).toEqual([
        { harness: "claude", model: "opus", permissions: "harness" },
      ]);
      // No override: the Run's default decides, so the variant says nothing.
      expect(stepVariants(wf.steps[1]!, defaults)).toEqual([{ harness: "claude", model: "opus" }]);
      // A value that is not a string is still a value someone meant: it is named, not
      // dropped, because dropping it would start the step unattended after all.
      expect(yield* validateWorkflow(wf, defs, defaults)).toEqual([
        'workflow "w" step "c": unknown permissions "whatever" (known: bypass, harness)',
        'workflow "w" step "d": unknown permissions "false" (known: bypass, harness)',
        'workflow "w" step "e": unknown permissions "3" (known: bypass, harness)',
        'workflow "w" step "menu" choice "Refine": unknown permissions "nope" (known: bypass, harness)',
      ]);
    }),
  ));

test("a permissions mode never re-permissions an agent someone else started", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "w",
        `---
name: w
steps:
  - id: build
    persona: reviewer
    output: build.json
  - id: conflicts
    persona: reviewer
    agent: build
    permissions: harness
    output: conflicts.json
  - id: agrees
    persona: reviewer
    agent: build
    permissions: bypass
    output: agrees.json
---
## build
b

## conflicts
c

## agrees
a
`,
      );
      yield* writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);

      const defs = yield* loadDefinitions(ls());
      const wf = resolveWorkflow("w", defs, defaults);

      // The mode is fixed when the process starts, so a later step cannot change it —
      // but a step whose mode already matches is saying nothing new.
      expect(yield* validateWorkflow(wf, defs, defaults)).toEqual([
        'workflow "w" step "conflicts": permissions "harness" cannot apply to a step that ' +
          'continues agent "build", which starts with "bypass" — set it on "build", or drop ' +
          '"agent" so this step starts one of its own',
      ]);

      // Which is what embedding does: `permissions` on a `use:` step reaches every step
      // of the embedded workflow, continuation steps included, so they all agree.
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "outer",
        `---
name: outer
steps:
  - id: inner
    use: w
    permissions: harness
---
## inner
never used, the embedded workflow supplies this
`,
      );
      // A chain: `relay` continues `build` without a mode of its own, so it runs the
      // process `build` started. A step continuing `relay` is really continuing `build`,
      // and is compared against where that agent actually started — not against what
      // `relay` would have resolved to had it started one.
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "chain",
        `---
name: chain
steps:
  - id: build
    persona: reviewer
    permissions: bypass
    output: build.json
  - id: relay
    persona: reviewer
    agent: build
    output: relay.json
  - id: sensitive
    persona: reviewer
    agent: relay
    permissions: harness
    output: sensitive.json
---
## build
b

## relay
r

## sensitive
s
`,
      );
      const withChain = yield* loadDefinitions(ls());
      const asks = { ...defaults, permissions: "harness" };
      expect(
        yield* validateWorkflow(resolveWorkflow("chain", withChain, asks), withChain, asks),
      ).toEqual([
        'workflow "chain" step "sensitive": permissions "harness" cannot apply to a step ' +
          'that continues agent "relay", which starts with "bypass" in step "build" — set ' +
          'it on "build", or drop "agent" so this step starts one of its own',
      ]);

      // A Choice step opens its agent inside a round, so that round's mode is what a
      // later continuation is really up against — not the step's, and not the default.
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "picked",
        `---
name: picked
steps:
  - id: menu
    persona: reviewer
    choices:
      - title: Refine
        prompt: refine
        permissions: bypass
        output: refine.json
  - id: after
    persona: reviewer
    agent: menu
    permissions: harness
    output: after.json
---
## menu
m

## refine
r

## after
a
`,
      );
      const withPicked = yield* loadDefinitions(ls());
      const asksToo = { ...defaults, permissions: "harness" };
      expect(
        yield* validateWorkflow(
          resolveWorkflow("picked", withPicked, asksToo),
          withPicked,
          asksToo,
        ),
      ).toEqual([
        'workflow "picked" step "after": permissions "harness" cannot apply to a step that ' +
          'continues agent "menu", which starts with "bypass" — set it on "menu", or drop ' +
          '"agent" so this step starts one of its own',
      ]);

      // A round continues an agent the same way its step does, and is refused the same
      // way: the mode was settled when that agent started.
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "menu",
        `---
name: menu
steps:
  - id: build
    persona: reviewer
    output: build.json
  - id: next
    persona: reviewer
    choices:
      - title: Again
        prompt: again
        agent: build
        permissions: harness
        output: again.json
---
## build
b

## next
n

## again
a
`,
      );
      const withMenu = yield* loadDefinitions(ls());
      expect(
        yield* validateWorkflow(resolveWorkflow("menu", withMenu, defaults), withMenu, defaults),
      ).toEqual([
        'workflow "menu" step "next" choice "Again": permissions "harness" cannot apply to a ' +
          'step that continues agent "build", which starts with "bypass" — set it on "build", ' +
          'or drop "agent" so this step starts one of its own',
      ]);

      const withOuter = yield* loadDefinitions(ls());
      const outer = resolveWorkflow("outer", withOuter, defaults);
      expect(outer.steps.map((step) => step.permissions)).toEqual([
        "harness",
        "harness",
        "harness",
      ]);
      expect(yield* validateWorkflow(outer, withOuter, defaults)).toEqual([]);
    }),
  ));

test("validation names the step for a bad effort and for a harness without one", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "w",
        `---
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
`,
      );
      yield* writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);

      const defs = yield* loadDefinitions(ls());
      const errors = yield* validateWorkflow(resolveWorkflow("w", defs, defaults), defs, defaults);

      expect(errors).toEqual([
        'workflow "w" step "a": unknown effort "ludicrous" for harness "claude" (known: low, medium, high, xhigh, max)',
        'workflow "w" step "b": harness "codex" has no effort setting',
      ]);
    }),
  ));

test("variant names take in effort only when harness and model would collide", () =>
  runEffect(
    Effect.gen(function* () {
      yield* Effect.void;
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
    }),
  ));

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

test("a step may name a body section other than its id, and an embedder may pick another", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(rig.baselineDir, "workflows", "arch", ARCH);
      yield* writeDef(
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
      yield* writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);

      const defs = yield* loadDefinitions(ls());

      const standalone = resolveWorkflow("arch", defs, defaults);
      expect(standalone.steps[0]!.prompt).toBe("Run the real interview.");
      expect(yield* validateWorkflow(standalone, defs, defaults)).toEqual([]);

      const outer = resolveWorkflow("outer", defs, defaults);
      expect(outer.steps[1]!.prompt).toBe(
        "Apply Strong candidates only, top first, at most two passes.",
      );
      expect(outer.steps[1]!.preamble).toBe("Project: {{cwd}}");
      expect(outer.steps[1]!.origin).toBe("arch");
      expect(outer.steps[1]!.agent).toBe("build");
      expect(yield* validateWorkflow(outer, defs, defaults)).toEqual([]);
    }),
  ));

test("an unknown prompt section names the file and the sections it does have", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "arch",
        ARCH.replace("prompt: attended", "prompt: nowhere"),
      );
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "outer",
        "---\nname: outer\nsteps:\n  - id: arch\n    use: arch\n    prompt: elsewhere\n---\nx",
      );
      yield* writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);

      const defs = yield* loadDefinitions(ls());

      expect(
        yield* validateWorkflow(resolveWorkflow("arch", defs, defaults), defs, defaults),
      ).toEqual([
        'workflow "arch" step "arch": unknown prompt section "nowhere" in arch.md (known: attended, unattended)',
      ]);
      expect(
        yield* validateWorkflow(resolveWorkflow("outer", defs, defaults), defs, defaults),
      ).toEqual([
        'workflow "outer" step "arch": unknown prompt section "elsewhere" in arch.md (known: attended, unattended)',
      ]);
    }),
  ));

test("a skill a definition asks for and nothing installed is a validation error", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* tempDir("hw-skills-");
      yield* writeDef(
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
      yield* writeDef(
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
      const defs = yield* loadDefinitions(layerSet(dir, join(dir, "user"), join(dir, "project")));
      const wf = resolveWorkflow("w", defs, FALLBACK_DEFAULTS);

      // Two skills are installed; the other two are not, and each is named once with the
      // command that installs it. A missing skill is a prerequisite, not a definition bug.
      const skills = join(dir, "installed");
      // Installed means the file a mention points an agent at, not just a directory
      // with the right name.
      for (const name of ["code-review", "tdd"]) {
        yield* mkdirp(join(skills, name));
        yield* writeText(join(skills, name, "SKILL.md"), `# ${name}\n`);
      }

      const errors = yield* validateWorkflow(wf, defs, FALLBACK_DEFAULTS, [skills]);
      expect(errors).toEqual([
        'w step "a": the skill "to-spec" is not installed — run `npx skills add to-spec`',
        'persona "reviewer": the skill "not-installed" is not installed — run `npx skills add not-installed`',
      ]);

      // A directory with the right name and no SKILL.md in it is not installed: the
      // agent would be pointed at a file that is not there.
      yield* mkdirp(join(skills, "to-spec"));
      expect(yield* validateWorkflow(wf, defs, FALLBACK_DEFAULTS, [skills])).toHaveLength(2);

      // Everything installed, and the workflow validates.
      for (const name of ["to-spec", "not-installed"]) {
        yield* mkdirp(join(skills, name));
        yield* writeText(join(skills, name, "SKILL.md"), `# ${name}\n`);
      }
      expect(yield* validateWorkflow(wf, defs, FALLBACK_DEFAULTS, [skills])).toEqual([]);

      // Either dir counts, and no dirs at all means the check is not made.
      expect(yield* validateWorkflow(wf, defs, FALLBACK_DEFAULTS, ["/nowhere", skills])).toEqual(
        [],
      );
      expect(yield* validateWorkflow(wf, defs, FALLBACK_DEFAULTS)).toEqual([]);
      yield* removeTree(dir);
    }),
  ));

test("extends changes only what it names", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(
        rig.baselineDir,
        "personas",
        "reviewer",
        "---\nname: reviewer\ndescription: base\n---\nBase reviewer.",
      );
      yield* writeDef(
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
      yield* writeDef(
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

      const defs = yield* loadDefinitions(yield* layers(rig.pluginEnv()));
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
    }),
  ));

test("a child preamble replaces the parent's, but only when it has one", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(
        rig.baselineDir,
        "personas",
        "p",
        "---\nname: p\n---\nBase persona.\n\n## Output\nBase output.",
      );
      yield* writeDef(
        rig.configDir,
        "personas",
        "p",
        "---\nname: p\nextends: p\n---\nMine.\n\n## Output\nMine too.",
      );

      const mine = (yield* loadDefinitions(yield* layers(rig.pluginEnv()))).personas.get("p")!;
      expect(bodySections(mine.body).preamble).toBe("Mine.");
      expect(bodySections(mine.body).sections.get("Output")).toBe("Mine too.");
    }),
  ));

test("an unknown parent and a cycle are errors that name the file", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(
        rig.configDir,
        "workflows",
        "orphan",
        "---\nname: orphan\nextends: nobody\n---\n## a\nx",
      );
      yield* writeDef(rig.configDir, "workflows", "a", "---\nname: a\nextends: b\n---\n## a\nx");
      yield* writeDef(rig.configDir, "workflows", "b", "---\nname: b\nextends: a\n---\n## a\nx");

      const defs = yield* loadDefinitions(yield* layers(rig.pluginEnv()));

      expect(
        defs.errors.some((e) => e.includes("orphan.md") && e.includes('extends "nobody"')),
      ).toBe(true);
      expect(defs.errors.some((e) => e.includes("extends cycle"))).toBe(true);
      // Nothing half-merged goes in: a definition that could not resolve is simply absent.
      expect(defs.workflows.has("orphan")).toBe(false);
    }),
  ));

test("a file with no extends still replaces the whole definition", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "w",
        "---\nname: w\ntitle: base\ninputs:\n  a: goal\n---\n## s\nbase",
      );
      yield* writeDef(rig.configDir, "workflows", "w", "---\nname: w\n---\n## s\nmine");

      const wf = (yield* loadDefinitions(yield* layers(rig.pluginEnv()))).workflows.get("w")!;
      expect(wf.title).toBe("w");
      expect(wf.inputs).toEqual({});
      expect(bodySections(wf.body).sections.get("s")).toBe("mine");
    }),
  ));

test("names that cannot be one path component inside the Run are rejected, naming the field", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "w",
        `---
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
`,
      );
      yield* writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);

      const defs = yield* loadDefinitions(ls());
      const errors = yield* validateWorkflow(resolveWorkflow("w", defs, defaults), defs, defaults);

      expect(
        errors.some((e) => e.includes('workflow "w" step "../evil"') && e.includes("id")),
      ).toBe(true);
      expect(
        errors.some((e) => e.includes('step "ok"') && e.includes('output "/etc/passwd"')),
      ).toBe(true);
      expect(
        errors.some((e) => e.includes('choice "Refine"') && e.includes('output "sub/dir.json"')),
      ).toBe(true);
    }),
  ));

test("a persona whose name cannot be a filename component is rejected", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "w",
        "---\nname: w\nsteps:\n  - id: s\n    persona: ../escape\n---\n## s\nx",
      );
      yield* writeDef(rig.baselineDir, "personas", "escape", "---\nname: ../escape\n---\nEvil.");

      const defs = yield* loadDefinitions(ls());
      const errors = yield* validateWorkflow(resolveWorkflow("w", defs, defaults), defs, defaults);

      expect(errors.some((e) => e.includes('step "s"') && e.includes('persona "../escape"'))).toBe(
        true,
      );
    }),
  ));

test("dots inside an id are fine; empty, dot and separator components are not", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "w",
        "---\nname: w\nsteps:\n  - id: build.tickets\n    persona: reviewer\n    output: out.json\n---\n## build.tickets\nx",
      );
      yield* writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);

      const defs = yield* loadDefinitions(ls());
      expect(yield* validateWorkflow(resolveWorkflow("w", defs, defaults), defs, defaults)).toEqual(
        [],
      );
    }),
  ));

test("a provider-qualified model becomes one safe directory component in its variant key", () =>
  runEffect(
    Effect.gen(function* () {
      yield* Effect.void;
      expect(
        variantKeys([
          { harness: "pi", model: "openai-codex/gpt-5.6-sol" },
          { harness: "claude", model: "opus" },
        ]),
      ).toEqual(["pi-openai-codex-gpt-5.6-sol", "claude-opus"]);
    }),
  ));

test("a workflow whose own name cannot be a path component is rejected before a Run exists", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "evil",
        "---\nname: ../../escaped\nsteps:\n  - id: s\n    persona: reviewer\n---\n## s\nx",
      );
      yield* writeDef(rig.baselineDir, "personas", "reviewer", REVIEWER);

      const defs = yield* loadDefinitions(ls());
      const errors = yield* validateWorkflow(
        resolveWorkflow("../../escaped", defs, defaults),
        defs,
        defaults,
      );

      expect(
        errors.some((e) => e.includes('workflow "../../escaped"') && e.includes("Run directory")),
      ).toBe(true);
    }),
  ));

test("variant keys stay unique even when encoding makes different models collide", () =>
  runEffect(
    Effect.gen(function* () {
      yield* Effect.void;
      expect(
        variantKeys([
          { harness: "pi", model: "p/foo:bar" },
          { harness: "pi", model: "p/foo-bar" },
          { harness: "pi", model: "p/foo-bar-2" },
        ]),
      ).toEqual(["pi-p-foo-bar", "pi-p-foo-bar-2", "pi-p-foo-bar-2-2"]);
    }),
  ));

test("each: tickets needs a plan to take them from, an output, and nothing to race with", () =>
  runEffect(
    Effect.gen(function* () {
      // A persona every step of the fixture can name; the subject here is `each`.
      yield* writeDef(join(rig.projectDir, ".herdr"), "personas", "implementer", IMPLEMENTER);
      const problems = (frontmatter: string) =>
        Effect.gen(function* () {
          yield* writeDef(
            join(rig.projectDir, ".herdr"),
            "workflows",
            "sliced",
            `---\nname: sliced\ntitle: sliced\n${frontmatter}---\n\n## build\n\nBuild it.\n\n## other\n\nOther.\n`,
          );
          const defs = yield* loadDefinitions(ls());
          const wf = resolveWorkflow("sliced", defs, FALLBACK_DEFAULTS);
          return yield* validateWorkflow(wf, defs, FALLBACK_DEFAULTS);
        });

      // The shape that works: a work source to take the tickets from, and an Output.
      expect(
        yield* problems(
          "inputs:\n  plan: work-source\nsteps:\n  - id: build\n    persona: implementer\n    each: tickets\n    output: build.json\n",
        ),
      ).toEqual([]);

      // Nothing to slice.
      expect(
        (yield* problems(
          "steps:\n  - id: build\n    persona: implementer\n    each: tickets\n    output: build.json\n",
        )).join("\n"),
      ).toContain("needs a work-source input");

      // Every slice records one, or a resume cannot tell which ones are done.
      expect(
        (yield* problems(
          "inputs:\n  plan: work-source\nsteps:\n  - id: build\n    persona: implementer\n    each: tickets\n",
        )).join("\n"),
      ).toContain("each needs an output");

      // Slices are one at a time on one agent; these are the two shapes that are not.
      expect(
        (yield* problems(
          "inputs:\n  plan: work-source\nsteps:\n  - id: build\n    persona: implementer\n    each: tickets\n    output: build.json\n    parallel:\n      - { harness: claude, model: opus }\n      - { harness: claude, model: sonnet }\n",
        )).join("\n"),
      ).toContain("each and parallel cannot both be set");
      // One entry is still a parallel step: the docs say the two are exclusive, and a
      // single entry is the shape a second one is added to tomorrow.
      expect(
        (yield* problems(
          "inputs:\n  plan: work-source\nsteps:\n  - id: build\n    persona: implementer\n    each: tickets\n    output: build.json\n    parallel:\n      - { harness: claude, model: opus }\n",
        )).join("\n"),
      ).toContain("each and parallel cannot both be set");
      expect(
        (yield* problems(
          "inputs:\n  plan: work-source\nsteps:\n  - id: other\n    persona: implementer\n    output: a.json\n  - id: build\n    persona: implementer\n    each: tickets\n    fan_in: other\n    output: build.json\n",
        )).join("\n"),
      ).toContain("each and fan_in cannot both be set");

      // A value nobody implements is named rather than ignored.
      expect(
        (yield* problems(
          "inputs:\n  plan: work-source\nsteps:\n  - id: build\n    persona: implementer\n    each: commits\n    output: build.json\n",
        )).join("\n"),
      ).toContain('each must be "tickets"');
    }),
  ));

test("a fork under its own name is still the workflow it extends", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "renovate",
        "---\nname: renovate\ncheckout: roaming\ninputs:\n  repository: gitlab-repository\nsteps:\n  - id: merge\n    output: merge.json\n---\n## merge\nBaseline.\n",
      );
      yield* writeDef(
        rig.configDir,
        "workflows",
        "renovate-batch",
        "---\nname: renovate-batch\nextends: renovate\n---\n## merge\nOnto an integration branch.\n",
      );
      // A fork of the fork, to show the bottom of the chain carries however deep it goes.
      yield* writeDef(
        rig.configDir,
        "workflows",
        "renovate-batch-dry",
        "---\nname: renovate-batch-dry\nextends: renovate-batch\n---\n## merge\nDry run.\n",
      );

      const defs = yield* loadDefinitions(yield* layers(rig.pluginEnv()));

      // `name` is what the operator typed; `base` is what the Run behaves as — and it
      // is `base` that decides whether the Run is given a checkout of its own.
      expect(defs.workflows.get("renovate")!.base).toBe("renovate");
      expect(defs.workflows.get("renovate-batch")!.base).toBe("renovate");
      expect(defs.workflows.get("renovate-batch-dry")!.base).toBe("renovate");

      // And the checkout it needs comes with it, however many forks deep: a fork that
      // is handed the directory it was launched from shares a working tree with the
      // Run that launched it.
      expect(defs.workflows.get("renovate")!.checkout).toBe("roaming");
      expect(defs.workflows.get("renovate-batch")!.checkout).toBe("roaming");
      expect(defs.workflows.get("renovate-batch-dry")!.checkout).toBe("roaming");
    }),
  ));

test("a fork may declare a checkout of its own, and an unknown one fails the file", () =>
  runEffect(
    Effect.gen(function* () {
      yield* writeDef(
        rig.baselineDir,
        "workflows",
        "renovate",
        "---\nname: renovate\ncheckout: roaming\nsteps:\n  - id: merge\n    output: merge.json\n---\n## merge\nBaseline.\n",
      );
      // A fork that reads rather than changes the repository says so, and is believed.
      yield* writeDef(
        rig.configDir,
        "workflows",
        "renovate-report",
        "---\nname: renovate-report\nextends: renovate\ncheckout: none\n---\n## merge\nReport only.\n",
      );
      yield* writeDef(
        rig.configDir,
        "workflows",
        "renovate-typo",
        "---\nname: renovate-typo\nextends: renovate\ncheckout: detached\n---\n## merge\nTypo.\n",
      );

      const defs = yield* loadDefinitions(yield* layers(rig.pluginEnv()));

      expect(defs.workflows.get("renovate-report")!.checkout).toBe("none");
      // Not silently `none`: a value nothing recognises would be a Run quietly working
      // in the directory it was started from.
      expect(defs.workflows.has("renovate-typo")).toBe(false);
      expect(defs.errors.some((e) => /renovate-typo.*checkout: "detached"/s.test(e))).toBe(true);
    }),
  ));
