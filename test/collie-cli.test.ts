import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { runEffect } from "./support/effect";
import { installFakeSkills } from "./support/defs";
import { readIntent, seedIntent, writeIntent } from "../src/intent";
import { appendMetric } from "../src/metrics";
import { RunStore } from "../src/run";

const root = new URL("../", import.meta.url).pathname;
const join = (...parts: string[]) => parts.join("/").replace(/\/+/g, "/");

const CliEnvelope = Schema.fromJsonString(
  Schema.Struct({
    ok: Schema.Boolean,
    data: Schema.optional(Schema.Unknown),
    error: Schema.optional(
      Schema.Struct({
        code: Schema.String,
        message: Schema.optional(Schema.String),
        details: Schema.Record(Schema.String, Schema.Unknown),
      }),
    ),
  }),
);

const cli = Effect.fn("test.cli")(function* (
  args: string[],
  extraEnv: Record<string, string> = {},
  /** Workflow definitions to install in this call's user layer, by file name. */
  defs: Record<string, string> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectory({ prefix: "collie-cli-" });
  yield* fs.makeDirectory(join(dir, "config"), { recursive: true });
  yield* installFakeSkills(dir);
  if (Object.keys(defs).length > 0) {
    yield* fs.makeDirectory(join(dir, "config", "workflows"), { recursive: true });
    for (const [name, text] of Object.entries(defs)) {
      yield* fs.writeFileString(join(dir, "config", "workflows", name), text);
    }
  }
  const proc = Bun.spawn([Bun.argv[0] ?? "bun", join(root, "src/main.ts"), ...args], {
    cwd: root,
    env: {
      HERDR_PLUGIN_ROOT: root,
      HERDR_PLUGIN_CONFIG_DIR: join(dir, "config"),
      HERDR_PLUGIN_STATE_DIR: join(dir, "state"),
      HOME: dir,
      PWD: root,
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = yield* Effect.promise(() =>
    Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
  );
  yield* fs.remove(dir, { recursive: true, force: true });
  return { stdout, stderr, exit };
});

const parseEnvelope = Schema.decodeUnknownEffect(CliEnvelope);

/**
 * A Markdown workflow with a menu and a previous-review input. The shipped three are
 * modules now, and what these tests are about is the engine that runs a definition: the
 * Driver it spawns, the Choices a launch may decide, and the run a `previous` has to name.
 */
const PANEL = `---
name: panel
title: panel — a definition with a menu
description: What the engine does with a Choice, for the tests that are about the engine.
inputs:
  target: diff-target
  previous: optional
steps:
  - id: post
    standalone: true
    choices:
      - title: Fix findings
        prompt: fix
        persona: implementer
        output: fix.json
      - title: Don't post
        stop: true
---

## fix

Fix what the review raised, then write the Output JSON.
`;
const withPanel = { "panel.md": PANEL };

/** `workflow list`, just far enough to read each workflow's inputs back. */
const WorkflowRows = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.Struct({
      workflows: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          inputs: Schema.Record(Schema.String, Schema.String),
        }),
      ),
    }),
  }),
);

test("public JSON discovery has one typed envelope", () =>
  runEffect(
    Effect.gen(function* () {
      const listed = yield* cli(["--json", "workflow", "list"]);
      expect(listed.exit).toBe(0);
      expect(listed.stderr).toBe("");
      expect(yield* parseEnvelope(listed.stdout)).toMatchObject({
        ok: true,
        data: { workflows: expect.any(Array) },
      });

      const missing = yield* cli(["--json", "workflow", "show", "__missing__"]);
      expect(missing.exit).toBe(1);
      expect(missing.stderr).toBe("");
      expect(yield* parseEnvelope(missing.stdout)).toMatchObject({
        ok: false,
        error: { code: "workflow_not_found", details: {} },
      });
    }),
  ));

test("persona discovery uses the same command boundary", () =>
  runEffect(
    Effect.gen(function* () {
      const result = yield* cli(["--json", "persona", "list"]);
      expect(result.exit).toBe(0);
      expect(yield* parseEnvelope(result.stdout)).toMatchObject({
        ok: true,
        data: { personas: expect.any(Array) },
      });
    }),
  ));

test("human workflow show includes its steps and source", () =>
  runEffect(
    Effect.gen(function* () {
      const shown = yield* cli(["workflow", "show", "architecture"]);
      expect(shown.exit).toBe(0);
      expect(shown.stdout).toContain("Steps:");
      expect(shown.stdout).toContain("Defined in:");
    }),
  ));

test("invalid input is one envelope on stdout, its reason on stderr, and exit 2", () =>
  runEffect(
    Effect.gen(function* () {
      const missing = yield* cli(["--json", "workflow", "show"]);

      // No usage text: under --json stdout carries the envelope and nothing else.
      expect(yield* parseEnvelope(missing.stdout)).toEqual({
        ok: false,
        error: {
          code: "invalid_input",
          message: "Missing required argument: workflow",
          details: {},
        },
      });
      expect(missing.stdout).not.toContain("USAGE");
      expect(missing.exit).toBe(2);
      // The diagnostic is still there for a human, on the stream that cannot corrupt it.
      expect(missing.stderr).toContain("Missing required argument");

      const unknownFlag = yield* cli(["--json", "workflow", "list", "--nope"]);
      expect(yield* parseEnvelope(unknownFlag.stdout)).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
      expect(unknownFlag.exit).toBe(2);

      // Asking for help is nobody's failure, and the release gate runs it.
      const help = yield* cli(["--help"]);
      expect(help.exit).toBe(0);
      expect(help.stdout).toContain("USAGE");
    }),
  ));

test("a command group named with no subcommand is invalid input, not success", () =>
  runEffect(
    Effect.gen(function* () {
      // Effect's CLI raises the same ShowHelp it raises for --help, carrying no parse
      // errors, so what tells them apart is whether help was actually asked for.
      for (const argv of [["--json", "run"], ["--json", "workflow"], ["--json"]]) {
        const stopped = yield* cli(argv);
        expect(yield* parseEnvelope(stopped.stdout)).toMatchObject({
          ok: false,
          error: { code: "invalid_input" },
        });
        expect(stopped.exit).toBe(2);
        // The envelope is the whole of stdout: no help document, and no blank line
        // ahead of it for a consumer reading a line at a time.
        expect(stopped.stdout.startsWith("{")).toBe(true);
        expect(stopped.stdout.trimEnd().split("\n")).toHaveLength(1);
      }
    }),
  ));

test("a Driver that cannot be started fails the Run rather than orphaning it", () =>
  runEffect(
    Effect.gen(function* () {
      const started = yield* cli(
        ["--json", "run", "start", "panel", "--input", "target=worktree", "--request-id", "r1"],
        { COLLIE_DRIVER: "/nonexistent/collie-bin" },
        withPanel,
      );
      expect(yield* parseEnvelope(started.stdout)).toMatchObject({
        ok: false,
        error: { code: "operation_failed" },
      });
      expect(started.exit).toBe(1);
    }),
  ));

test("discovery is global when an inherited workspace id no longer resolves", () =>
  runEffect(
    Effect.gen(function* () {
      // A script that inherited HERDR_WORKSPACE_ID from a pane whose workspace has
      // since closed. Discovery needs no workspace, so it answers rather than failing.
      const stale = { HERDR_WORKSPACE_ID: "gone", HERDR_BIN_PATH: "/nonexistent/herdr" };
      const listed = yield* cli(["--json", "workflow", "list"], stale);
      expect(yield* parseEnvelope(listed.stdout)).toMatchObject({ ok: true });
      expect(listed.exit).toBe(0);

      const personas = yield* cli(["--json", "persona", "list"], stale);
      expect(yield* parseEnvelope(personas.stdout)).toMatchObject({ ok: true });

      // A workspace the caller named is still an error: the spec reserves
      // workspace_not_found for exactly that.
      const named = yield* cli(["--json", "--workspace", "gone", "workflow", "list"], stale);
      expect(yield* parseEnvelope(named.stdout)).toMatchObject({
        ok: false,
        error: { code: "workspace_not_found" },
      });
      expect(named.exit).toBe(1);
    }),
  ));

test("--decide is validated against the workflow before any run exists", () =>
  runEffect(
    Effect.gen(function* () {
      // A typo that degraded to "ask me then" would hang the unattended run this
      // flag exists to make possible, so both halves are checked up front.
      const step = yield* cli(
        [
          "--json",
          "run",
          "start",
          "panel",
          "--input",
          "target=worktree",
          "--decide",
          "nope=Don't post",
        ],
        {},
        withPanel,
      );
      expect(yield* parseEnvelope(step.stdout)).toMatchObject({
        ok: false,
        error: { code: "invalid_input", message: expect.stringContaining("post") },
      });

      const title = yield* cli(
        [
          "--json",
          "run",
          "start",
          "panel",
          "--input",
          "target=worktree",
          "--decide",
          "post=Ship it",
        ],
        {},
        withPanel,
      );
      expect(yield* parseEnvelope(title.stdout)).toMatchObject({
        ok: false,
        error: { code: "invalid_input", message: expect.stringContaining("Don't post") },
      });

      // And the titles are discoverable without reading the markdown.
      const shown = yield* cli(["workflow", "show", "panel"], {}, withPanel);
      expect(shown.stdout).toContain("post — decide one of: Fix findings");
    }),
  ));

test("a previous review named by hand has to exist", () =>
  runEffect(
    Effect.gen(function* () {
      const unknown = yield* cli(
        [
          "--json",
          "run",
          "start",
          "panel",
          "--input",
          "target=worktree",
          "--input",
          "previous=review-nope-20260101-000000",
        ],
        {},
        withPanel,
      );
      expect(yield* parseEnvelope(unknown.stdout)).toMatchObject({
        ok: false,
        error: { code: "invalid_input", message: expect.stringContaining("review-nope") },
      });
    }),
  ));

test(
  "workflow check validates every layer without starting a run",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // The project layer is `<cwd>/.herdr`, and a checkout's own is a human's forked
        // workflows — never test data. This one is a scratch directory the run is
        // rooted at with COLLIE_CWD, so nothing outside it is written or removed.
        const cwd = yield* fs.makeTempDirectory({ prefix: "collie-project-" });
        const scratch = { COLLIE_CWD: cwd };

        // The baseline is the acceptance test for the rule set: it must come out clean.
        const clean = yield* cli(["workflow", "check"], scratch);
        expect(clean.exit).toBe(0);
        expect(clean.stdout).toContain("implement\tbaseline\tok");
        expect(clean.stdout).toContain("review\tbaseline\tok");

        const project = join(cwd, ".herdr", "workflows");
        yield* fs.makeDirectory(project, { recursive: true });
        yield* fs.writeFileString(
          join(project, "broken.md"),
          `---
name: broken
inputs:
  goal: goal
steps:
  - id: one
    persona: planner
    model: opus-9
    output: one.json
---
{{inputs.goal}} and {{inputs.nope}} and {{inputs.goal_kind}} and {{findings}} and {{skill:tdd}}
`,
        );
        yield* fs.writeFileString(join(project, "unparseable.md"), "no frontmatter here\n");
        // A Choice round drives a skill the same way a step does, and what a Choice
        // forwards to the workflow it chains is rendered from the same variables.
        yield* fs.writeFileString(
          join(project, "chains.md"),
          `---
name: chains
inputs:
  goal: goal
steps:
  - id: next
    choices:
      - title: Grill it
        prompt: grill
        persona: planner
        skill: not-a-real-skill
        output: grill.json
      - title: Build it
        run: implement
        inputs:
          plan: "{{inputs.plna}}"
          target: "{{target_repo}}"
          task: "{{outputs.gril.slug}}"
---
Goal: {{inputs.goal}}

## grill
Grill me.
`,
        );

        const bad = yield* cli(["--json", "workflow", "check"], scratch);
        const envelope = yield* parseEnvelope(bad.stdout);

        expect(bad.exit).not.toBe(0);
        const problems = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(
          envelope.error?.details ?? {},
        );
        expect(problems).toContain("opus-9");
        // A placeholder no input can fill is reported; the ones the engine supplies at
        // step time are not.
        expect(problems).toContain("inputs.nope");
        // A `goal` never carries a kind, so `goal_kind` is a placeholder the Run cannot
        // fill either — only a work-source and a diff-target render one.
        expect(problems).toContain("inputs.goal_kind");
        // A round's `skill:` is a prerequisite like a step's...
        expect(problems).toContain("not-a-real-skill");
        // ...and a typo in what a Choice forwards would otherwise render empty, be
        // treated as settled, and start the child without the Input it needed.
        expect(problems).toContain("inputs.plna");
        // A forwarded input is rendered with `run`, `inputs`, `cwd` and `outputs` and
        // nothing else, so a family a step's prompt may name is still unresolvable here.
        expect(problems).toContain("target_repo");
        // An Output is named by the step that writes it, so a mistyped step id is caught
        // too — it would otherwise render empty and chain the child without its task.
        expect(problems).toContain("outputs.gril.slug");
        expect(problems).not.toContain("findings");
        expect(problems).not.toContain("skill:tdd");
        // A file with nothing in it is reported rather than silently skipped by the
        // loader, the way the picker's banner used to be the only place it showed.
        expect(problems).toContain('"name":"unparseable"');
        expect(problems).toContain("has no steps");
        // And the workflows that are fine are still listed.
        expect(problems).toContain('"name":"plan","layer":"baseline","problems":[]');

        // Asked about one workflow, a broken file elsewhere is not its problem — the
        // targeted check has to stay usable while another definition is being edited.
        const named = yield* cli(["workflow", "check", "review"], scratch);
        expect(named.exit).toBe(0);
        expect(named.stdout).toContain("review\tbaseline\tok");
        expect(named.stdout).not.toContain("broken");

        // Its own broken file is its problem, though: a project-layer `review.md` that
        // will not parse leaves the baseline answering for `review`, and an author who
        // just broke it must not be told their workflow is fine.
        yield* fs.writeFileString(join(project, "review.md"), "---\nname: [unclosed\n---\nbody\n");
        const shadowed = yield* cli(["workflow", "check", "review"], scratch);
        expect(shadowed.exit).not.toBe(0);
        expect(shadowed.stdout).toContain("review.md");

        yield* fs.remove(cwd, { recursive: true, force: true });
      }),
    ),
  // Four real CLI startups: this checks validation, not a five-second startup SLO.
  20_000,
);

test("workflow show prints what a run actually gets, not what was authored", () =>
  runEffect(
    Effect.gen(function* () {
      const shown = yield* cli(["workflow", "show", "implement"]);

      expect(shown.exit).toBe(0);
      // `target` reaches implement only through the embedded review; a run takes it,
      // and this is the command an author checks that with.
      expect(shown.stdout).toContain('"target":"diff-target"');
      expect(shown.stdout).toContain("Inherited from an embedded workflow: target");
      expect(shown.stdout).toContain("review.synthesize");
      const steps = shown.stdout.split("Steps:")[1]!.split("Defined in:")[0]!.trim().split("\n");
      // build, review, review.synthesize, fix, mr — the resolved shape, `use:` flattened.
      expect(steps).toHaveLength(5);
    }),
  ));

test("a mutating workflow lists the branch input no workflow declares", () =>
  runEffect(
    Effect.gen(function* () {
      // An agent driving Collie cannot pass an Input nothing names, and `branch` is
      // the one that decides which checkout the run gets.
      const implement = yield* cli(["--json", "workflow", "show", "implement"]);
      expect(implement.stdout).toContain('"branch"');
      const human = yield* cli(["workflow", "show", "implement"]);
      expect(human.stdout).toContain("branch:");
      expect(human.stdout).toContain("--input branch=");

      // A declared strategy, never one invented here: an agent reading this map acts on
      // the strategy, and `branch` is optional in exactly that sense.
      expect(implement.stdout).toContain('"branch":"optional"');

      // Wherever the inputs are listed, not only in `show`.
      const listed = yield* cli(["--json", "workflow", "list"]);
      const workflows = Schema.decodeUnknownSync(WorkflowRows)(listed.stdout).data.workflows;
      const named = (name: string) => workflows.find((w) => w.name === name)!;
      expect(Object.keys(named("implement").inputs)).toContain("branch");

      // A workflow that changes nothing has no branch of its own to work on.
      const review = yield* cli(["--json", "workflow", "show", "review"]);
      expect(review.stdout).not.toContain('"branch"');
      expect(Object.keys(named("review").inputs)).not.toContain("branch");
    }),
  ));

test("upgrade is a command of its own, and says what it would do", () =>
  runEffect(
    Effect.gen(function* () {
      const help = yield* cli(["upgrade", "--help"]);
      expect(help.exit).toBe(0);
      expect(help.stdout).toContain("Update this installation");
      // Discoverable from the root help, like every other command.
      const root = yield* cli(["--help"]);
      expect(root.stdout).toContain("upgrade");
    }),
  ));

test("the version the CLI reports is the one the manifest declares", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // herdr reads the manifest, `install.sh` builds the release URL from it, and a
      // `--version` that disagreed with either would send someone to the wrong asset.
      const manifest = yield* fs.readFileString(join(root, "herdr-plugin.toml"));
      const declared = /^version = "(.+)"$/m.exec(manifest)?.[1];

      const shown = yield* cli(["--version"]);

      expect(declared).toBeDefined();
      expect(shown.stdout.trim()).toContain(declared!);
    }),
  ));

test("intent defaults round trip, and a Run's Intent is amended through the envelope", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectory({ prefix: "collie-intent-" });
      const state = join(home, "state");
      const shared = {
        HERDR_PLUGIN_STATE_DIR: state,
        HERDR_PLUGIN_CONFIG_DIR: join(home, "config"),
      };

      const added = yield* cli(
        ["--json", "run", "intent", "defaults", "add-constraint", "no new dependencies"],
        shared,
      );
      expect(added.exit).toBe(0);
      expect(yield* parseEnvelope(added.stdout)).toMatchObject({ ok: true });
      const shown = yield* cli(["--json", "run", "intent", "defaults", "show"], shared);
      expect(shown.stdout).toContain("no new dependencies");

      // A grant nobody named is not a grant: the file is refused, not silently ignored.
      const bogus = yield* cli(
        ["--json", "run", "intent", "defaults", "set-authority", "invented=true"],
        shared,
      );
      expect(bogus.exit).toBe(2);
      expect(yield* parseEnvelope(bogus.stdout)).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });

      const run = yield* new RunStore(state).create({
        workflow: "implement",
        cwd: root,
        inputs: {},
        inputSources: {},
        stepIds: ["build"],
        maxIterations: 1,
        namedAfter: "steering",
      });
      yield* writeIntent(run.dir, seedIntent(run.id, { goal: "ship it" }));

      const amended = yield* cli(
        [
          "--json",
          "run",
          "intent",
          "add-constraint",
          run.id,
          "preserve the public --json envelope",
          "--severity",
          "block",
        ],
        shared,
      );
      expect(yield* parseEnvelope(amended.stdout)).toMatchObject({
        ok: true,
        data: { version: 2 },
      });

      const intent = yield* readIntent(run.dir);
      expect(intent?.version).toBe(2);
      expect(intent?.history).toHaveLength(1);
      expect(intent?.constraints[0]?.severity).toBe("block");

      yield* fs.remove(home, { recursive: true, force: true });
    }),
  ));

test("run metrics reports what a Run produced, and says so when it has produced nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // One state directory the Run and the command both see: `cli` makes its own per
      // call, and a Run written into one of those would not be there for the next.
      const home = yield* fs.makeTempDirectory({ prefix: "collie-metrics-" });
      const stateDir = join(home, "state");
      const env = { HERDR_PLUGIN_STATE_DIR: stateDir };

      const run = yield* new RunStore(stateDir).create({
        workflow: "implement",
        cwd: root,
        inputs: { plan: "add a picker", outcome: "bug" },
        inputSources: { plan: "asked" },
        stepIds: ["build"],
        maxIterations: 1,
        namedAfter: "add a picker",
      });

      const empty = yield* cli(["--json", "run", "metrics", run.id], env);
      expect(empty.exit).toBe(0);
      const bare = yield* parseEnvelope(empty.stdout);
      expect(bare.ok).toBe(true);
      // SAFETY: the envelope decoded `ok: true` above, and `run metrics` puts exactly
      // these fields in `data` — asserted immediately below, so a shape that changed
      // fails here rather than passing silently.
      const data = bare.data as {
        metrics: { timeToFirstEvidence: number | null };
        outcome: string;
      };
      // Null rather than zero: "nothing yet" and "immediately" are different facts.
      expect(data.metrics.timeToFirstEvidence).toBeNull();
      expect(data.outcome).toBe("bug");

      yield* appendMetric(run.dir, {
        at: run.record.created_at,
        kind: "verification",
        subject: "v1",
        value: 1,
        note: "pass",
      });

      const shown = yield* cli(["run", "metrics", run.id], env);
      expect(shown.exit).toBe(0);
      expect(shown.stdout).toContain("time to first evidence: 0s");
      expect(shown.stdout).toContain("1 pass, 0 fail, 0 unstable (1 by collie)");
      expect(shown.stdout).toContain("rework: 0");

      yield* fs.remove(home, { recursive: true, force: true });
    }),
  ));
