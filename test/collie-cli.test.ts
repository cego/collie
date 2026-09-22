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

/** `workflow show` for a module: what a caller may give it, and what it gives back. */
const ShownModule = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.Struct({
      workflow: Schema.Struct({
        layer: Schema.String,
        path: Schema.String,
        broken: Schema.NullOr(Schema.String),
        inputs: Schema.Array(
          Schema.Struct({ name: Schema.String, strategy: Schema.NullOr(Schema.String) }),
        ),
        options: Schema.Array(Schema.Struct({ name: Schema.String, meaning: Schema.String })),
        success: Schema.Struct({ schema: Schema.NullOr(Schema.Json) }),
        error: Schema.Struct({ schema: Schema.NullOr(Schema.Json) }),
      }),
    }),
  }),
);

/** `workflow list`, just far enough to read each workflow's inputs back. */
const WorkflowRows = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.Struct({
      workflows: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          inputs: Schema.Array(Schema.Struct({ name: Schema.String })),
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

test("the names the host settles are published beside the ones a module declares", () =>
  runEffect(
    Effect.gen(function* () {
      // An agent driving Collie cannot pass an Input nothing names, and `branch` is
      // the one that decides which checkout the run gets. A module never declares it —
      // declaring it is refused — so it is published as the host's, with what it means.
      const implement = yield* cli(["--json", "workflow", "show", "implement"]);
      const described = Schema.decodeUnknownSync(ShownModule)(implement.stdout).data.workflow;
      expect(described.inputs.map((one) => one.name)).not.toContain("branch");
      expect(described.options.map((one) => one.name)).toEqual([
        "branch",
        "task",
        "workspace",
        "repo",
        "outcome",
        "risks",
        "previous",
      ]);

      // And for a human, the order `branch` is resolved in, which is the whole of it.
      const human = yield* cli(["workflow", "show", "implement"]);
      expect(human.stdout).toContain("branch:");
      expect(human.stdout).toContain("--input branch=");

      // `branch` is the host's, not a module's: it is never among what a module declares.
      const listed = yield* cli(["--json", "workflow", "list"]);
      const workflows = Schema.decodeUnknownSync(WorkflowRows)(listed.stdout).data.workflows;
      const row = workflows.find((w) => w.id === "implement")!;
      expect(row.inputs.map((input) => input.name)).not.toContain("branch");
    }),
  ));

test(
  "an agent saves a workflow, checks it and finds it, with nothing to register by hand",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // The project layer, so nothing outside this scratch directory is written.
        const cwd = yield* fs.makeTempDirectory({ prefix: "collie-authoring-" });
        const scratch = { COLLIE_CWD: cwd };
        const saved = join(cwd, ".herdr", "workflows");

        const made = yield* cli(
          ["--json", "workflow", "create", "tally", "--layer", "project"],
          scratch,
        );
        expect(made.exit).toBe(0);
        expect(yield* parseEnvelope(made.stdout)).toMatchObject({
          ok: true,
          data: { path: join(saved, "tally.workflow.ts"), toolchain: null },
        });
        // The setup to typecheck it is beside it, provisioned with the embedded Bun.
        for (const name of ["package.json", "tsconfig.json", "collie-native.d.ts"]) {
          expect(yield* fs.exists(join(saved, name))).toBe(true);
        }

        // Saving it is the whole of it: no registry to edit, no rebuild, no restart.
        const listed = yield* cli(["workflow", "list"], scratch);
        expect(listed.stdout).toContain("tally\tproject");

        // And it compiles against the declarations it was written against.
        const checked = yield* cli(["workflow", "check", "tally"], scratch);
        expect(checked.exit).toBe(0);
        expect(checked.stdout).toContain("tally\tproject\tok");
        expect(checked.stdout).not.toContain("not typechecked");

        // Never over a file that is already there — it is the one they already edited.
        const before = yield* fs.readFileString(join(saved, "tally.workflow.ts"));
        const again = yield* cli(
          ["--json", "workflow", "create", "tally", "--layer", "project"],
          scratch,
        );
        expect(again.exit).not.toBe(0);
        expect(yield* parseEnvelope(again.stdout)).toMatchObject({
          ok: false,
          error: { code: "target_exists" },
        });
        expect(yield* fs.readFileString(join(saved, "tally.workflow.ts"))).toBe(before);

        yield* fs.remove(cwd, { recursive: true, force: true });
      }),
    ),
  120_000,
);

test(
  "forking a module writes a file that imports what it keeps, and the merge flags are a migration",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectory({ prefix: "collie-forking-" });
        const scratch = { COLLIE_CWD: cwd };

        const forked = yield* cli(
          ["--json", "workflow", "fork", "implement", "--layer", "project", "--name", "ours"],
          scratch,
        );
        expect(forked.exit).toBe(0);
        const path = join(cwd, ".herdr", "workflows", "ours.workflow.ts");
        expect(yield* parseEnvelope(forked.stdout)).toMatchObject({ ok: true, data: { path } });
        // Ordinary composition: it imports the original and hands `make` on.
        const text = yield* fs.readFileString(path);
        expect(text).toContain("workflows/implement.workflow.ts");
        expect(text).toContain('export const id = "ours"');

        // Both are runnable, each under its own id, and the fork takes what it inherited.
        const shown = yield* cli(["--json", "workflow", "show", "ours"], scratch);
        const described = Schema.decodeUnknownSync(ShownModule)(shown.stdout).data.workflow;
        expect(described.layer).toBe("project");
        expect(described.inputs.map((one) => one.name)).toEqual(["plan"]);

        // There is nothing to merge in a module, so the flags that merged steps say so.
        const merged = yield* cli(
          [
            "--json",
            "workflow",
            "fork",
            "implement",
            "--layer",
            "project",
            "--name",
            "theirs",
            "--mode",
            "extends",
          ],
          scratch,
        );
        expect(yield* parseEnvelope(merged.stdout)).toMatchObject({
          ok: false,
          error: { code: "invalid_input", message: expect.stringContaining("--mode") },
        });
        expect(yield* fs.exists(join(cwd, ".herdr", "workflows", "theirs.workflow.ts"))).toBe(
          false,
        );

        yield* fs.remove(cwd, { recursive: true, force: true });
      }),
    ),
  120_000,
);

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
      // What an older Collie recorded is read into a row before it can be amended: the
      // command asks the host which Runs there are, and nothing else does.
      expect((yield* cli(["--json", "history", "import"], shared)).exit).toBe(0);

      // Work an older Collie recorded is history: its Intent is what it was held to,
      // and there is nothing left to hold to an amended one.
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
        ok: false,
        error: { code: "operation_failed", details: { history: true } },
      });

      const intent = yield* readIntent(run.dir);
      expect(intent?.version).toBe(1);
      expect(intent?.constraints).toEqual([]);

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

      expect((yield* cli(["--json", "history", "import"], env)).exit).toBe(0);

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
