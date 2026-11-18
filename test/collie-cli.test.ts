import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { expect, test } from "bun:test";
import { Config, Effect, FileSystem, Option, Schema, flow, Result } from "effect";
import { FakeBin } from "./support/bin";
import { exec } from "./support/command";
import { runEffect, suiteEnv } from "./support/effect";
import { forgeOnPath, serveForges } from "./support/forge";
import { stopHost } from "./support/host";
import { installFakeSkills } from "./support/defs";
import { testBunfig } from "./support/packages";
import { readIntent, seedIntent, writeIntent } from "../src/intent";
import { appendMetric } from "../src/metrics";
import { hosted, settledRun } from "./support/hosted";
import { evidenceDir } from "../src/engine";
import { connect, frontDoor, socketOf } from "../src/host";
import { recordsAt } from "./support/records";
import { readAudit } from "../src/audit";
import { VerifySpecSchema } from "../src/verify-spec";
import { callTool } from "../src/tools";
import { readEnv } from "../src/env";

const root = new URL("../", import.meta.url).pathname;
const join = (...parts: string[]) => pipe_(Arr.join(parts, "/"), Str.replace(/\/+/g, "/"));

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
) {
  const fs = yield* FileSystem.FileSystem;
  const suite = yield* suiteEnv;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-cli-" });
  yield* Effect.addFinalizer(() => Effect.ignore(stopHost(join(dir, "state"))));
  yield* fs.makeDirectory(join(dir, "config"), { recursive: true });
  yield* fs.writeFileString(join(dir, ".bunfig.toml"), testBunfig);
  yield* installFakeSkills(dir);
  const binary = yield* Config.option(Config.String("COLLIE_TEST_BINARY"));
  const command = Option.isSome(binary)
    ? [binary.value]
    : [Bun.argv[0] ?? "bun", join(root, "src/main.ts")];
  const proc = Bun.spawn([...command, ...args], {
    cwd: root,
    env: {
      COLLIE_ROOT: root,
      COLLIE_USER_DIR: join(dir, "config"),
      COLLIE_STATE_DIR: join(dir, "state"),
      HOME: dir,
      PWD: root,
      ...suite,
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exit] = yield* Effect.promise(() =>
    Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
  );
  return { stdout, stderr, exit };
});

const parseEnvelope = Schema.decodeUnknownEffect(CliEnvelope);
const decodeRemembered = flow(
  Schema.decodeUnknownResult(Schema.fromJsonString(Schema.Array(VerifySpecSchema))),
  Result.getOrThrow,
);

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
      expect(missing.stderr).toContain("Missing required argument");

      const unknownFlag = yield* cli(["--json", "workflow", "list", "--nope"]);
      expect(yield* parseEnvelope(unknownFlag.stdout)).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });
      expect(unknownFlag.exit).toBe(2);

      const help = yield* cli(["--help"]);
      expect(help.exit).toBe(0);
      expect(help.stdout).toContain("USAGE");
    }),
  ));

test("a hold takes no time to lift at, and a release no reason, which nothing would read", () =>
  runEffect(
    Effect.gen(function* () {
      const released = yield* cli(["--json", "run", "release", "r1", "--reason", "lunch"]);
      expect(yield* parseEnvelope(released.stdout)).toMatchObject({
        ok: false,
        error: { message: "Unrecognized flag: --reason in command collie run release" },
      });
      const timed = yield* cli(["--json", "run", "hold", "r1", "--until", "14:00"]);
      expect(yield* parseEnvelope(timed.stdout)).toMatchObject({
        ok: false,
        error: {
          code: "invalid_input",
          message: "Unrecognized flag: --until in command collie run hold",
        },
      });
      expect(timed.exit).toBe(2);
    }),
  ));

test("an answer names its question with --decision, not a flag nothing reads", () =>
  runEffect(
    Effect.gen(function* () {
      const expecting = yield* cli([
        "--json",
        "run",
        "answer",
        "r1",
        "yes",
        "--expect-choice",
        "c1",
      ]);
      expect(yield* parseEnvelope(expecting.stdout)).toMatchObject({
        ok: false,
        error: {
          code: "invalid_input",
          message: "Unrecognized flag: --expect-choice in command collie run answer",
        },
      });
      expect(expecting.exit).toBe(2);
    }),
  ));

test("a workflow is forked by importing it, so fork takes no Markdown merge flags", () =>
  runEffect(
    Effect.gen(function* () {
      for (const flag of ["--mode", "--step"]) {
        const given = yield* cli(["--json", "workflow", "fork", "implement", flag, "copy"]);
        expect(yield* parseEnvelope(given.stdout)).toMatchObject({
          ok: false,
          error: { message: `Unrecognized flag: ${flag} in command collie workflow fork` },
        });
      }
    }),
  ));

test("a command group named with no subcommand is invalid input, not success", () =>
  runEffect(
    Effect.gen(function* () {
      for (const argv of [["--json", "run"], ["--json", "workflow"], ["--json"]]) {
        const stopped = yield* cli(argv);
        expect(yield* parseEnvelope(stopped.stdout)).toMatchObject({
          ok: false,
          error: { code: "invalid_input" },
        });
        expect(stopped.exit).toBe(2);
        expect(pipe_(stopped.stdout, Str.startsWith("{"))).toBe(true);
        expect(Str.split(Str.trimEnd(stopped.stdout), "\n")).toHaveLength(1);
      }
    }),
  ));

test("discovery ignores a workspace id Herdr 1 left in the environment", () =>
  runEffect(
    Effect.gen(function* () {
      const stale = { HERDR_WORKSPACE_ID: "gone" };
      const listed = yield* cli(["--json", "workflow", "list"], stale);
      expect(yield* parseEnvelope(listed.stdout)).toMatchObject({ ok: true });
      expect(listed.exit).toBe(0);

      const personas = yield* cli(["--json", "persona", "list"], stale);
      expect(yield* parseEnvelope(personas.stdout)).toMatchObject({ ok: true });

      const named = yield* cli(["--json", "--workspace", "gone", "workflow", "list"], stale);
      expect(yield* parseEnvelope(named.stdout)).toMatchObject({
        ok: false,
        error: { code: "workspace_not_found" },
      });
      expect(named.exit).toBe(1);
    }),
  ));

test("plan takes a goal and no ticket, and architecture needs a goal", () =>
  runEffect(
    Effect.gen(function* () {
      const inputsOf = (stdout: string) =>
        Arr.map(
          flow(Schema.decodeResult(ShownModule), Result.getOrThrow)(stdout).data.workflow.inputs,
          (one) => [one.name, one.strategy],
        );
      expect(inputsOf((yield* cli(["--json", "workflow", "show", "plan"])).stdout)).toEqual([
        ["goal", "goal"],
        ["then", "reach"],
      ]);
      expect(inputsOf((yield* cli(["--json", "workflow", "show", "architecture"])).stdout)).toEqual(
        [["goal", "goal"]],
      );

      const ticket = yield* cli([
        "--json",
        "run",
        "start",
        "plan",
        "--input",
        "goal=one registry",
        "--input",
        "then=",
        "--input",
        "ticket=ENG-1",
      ]);
      expect(yield* parseEnvelope(ticket.stdout)).toMatchObject({
        ok: false,
        error: {
          code: "invalid_input",
          message: expect.stringContaining('"ticket" is not an input'),
        },
      });

      const bare = yield* cli(["--json", "run", "start", "architecture"]);
      expect(yield* parseEnvelope(bare.stdout)).toMatchObject({
        ok: false,
        error: { code: "needs_input", details: { inputs: [{ name: "goal" }] } },
      });
    }),
  ));

const projectsTree = Effect.fn("test.projectsTree")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-projects-" });
  for (const checkout of ["app/.git", "group/lib/.git"])
    yield* fs.makeDirectory(join(dir, "root", checkout), { recursive: true });
  yield* fs.makeDirectory(join(dir, "elsewhere"), { recursive: true });
  return { root: join(dir, "root"), elsewhere: join(dir, "elsewhere"), dir };
});

test("a start outside any checkout names one, or is refused with the checkouts to choose from", () =>
  runEffect(
    Effect.gen(function* () {
      const tree = yield* projectsTree();
      const refused = yield* cli(
        [
          "--json",
          "run",
          "start",
          "review",
          "--input",
          "target=worktree",
          "--input",
          "plan=",
          "--input",
          "proves=",
        ],
        { COLLIE_CWD: tree.elsewhere, GITTE_CWD: tree.root },
      );
      const envelope = yield* parseEnvelope(refused.stdout);
      expect(envelope).toMatchObject({
        ok: false,
        error: {
          code: "needs_input",
          message: expect.stringContaining("workspace="),
          details: {
            inputs: [
              {
                name: "workspace",
                facts: [join(tree.root, "app"), join(tree.root, "group/lib"), "projects-root"],
              },
            ],
          },
        },
      });
    }),
  ));

test("an agent's start names every Input, an optional one as empty, and is told what each means", () =>
  runEffect(
    Effect.gen(function* () {
      const bare = yield* cli(["--json", "run", "start", "review", "--input", "target=worktree"]);
      const envelope = yield* parseEnvelope(bare.stdout);
      expect(envelope).toMatchObject({
        ok: false,
        error: { code: "needs_input", message: expect.stringContaining('""') },
      });
      const missing = yield* Schema.decodeUnknownEffect(
        Schema.Array(Schema.Struct({ name: Schema.String, meaning: Schema.String })),
      )(envelope.error?.details["inputs"]).pipe(Effect.orDie);
      expect(Arr.map(missing, (one) => one.name)).toEqual(["plan", "proves"]);
      for (const one of missing) expect(one.meaning).not.toBe("");

      const release = yield* cli(["--json", "run", "start", "release", "--input", "mr=!1"]);
      const releaseMissing = (yield* parseEnvelope(release.stdout)).error?.details["inputs"];
      expect(releaseMissing).toEqual([expect.objectContaining({ name: "ship" })]);

      const plan = yield* cli(["--json", "run", "start", "plan", "--input", "goal=one registry"]);
      expect(yield* parseEnvelope(plan.stdout)).toMatchObject({
        ok: false,
        error: { code: "needs_input", details: { inputs: [{ name: "then" }] } },
      });
    }),
  ));

test("a missing diff target is told the target inference would pick in the checkout", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const bin = yield* fs.makeTempDirectoryScoped({ prefix: "collie-bin-" });
      const checkout = join(bin, "project");
      yield* fs.makeDirectory(checkout);
      yield* exec(["git", "init", "-q", "-b", "main"], { cwd: checkout });
      yield* exec(
        [
          "git",
          "-c",
          "user.email=t@example.test",
          "-c",
          "user.name=t",
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          "init",
        ],
        { cwd: checkout },
      );
      yield* exec(["git", "remote", "add", "origin", "git@gitlab.example.com:group/app.git"], {
        cwd: checkout,
      });
      const fake = yield* FakeBin.make(join(bin, "fake"));
      const gitlab = yield* forgeOnPath(fake, "gitlab", {
        installed: true,
        loggedIn: ["gitlab.example.com"],
        login: "me",
        mrs: [
          {
            project: "gitlab.example.com/group/app",
            iid: "42",
            state: "open",
            title: "t",
            sourceBranch: "main",
          },
        ],
      });
      const COLLIE_FORGE_API = yield* serveForges(gitlab);
      yield* fake.restore();
      const bare = yield* cli(
        ["--json", "run", "start", "review", "--input", "plan=", "--input", "proves="],
        { PATH: `${fake.dir}:/usr/bin:/bin`, COLLIE_CWD: checkout, COLLIE_FORGE_API },
      );
      expect(yield* parseEnvelope(bare.stdout)).toMatchObject({
        ok: false,
        error: {
          code: "needs_input",
          details: { inputs: [{ name: "target", facts: [expect.stringContaining("!42")] }] },
        },
      });
    }),
  ));

test("a missing diff target is told what inference would pick in the checkout named, not the shell's", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tree = yield* projectsTree();
      const named = join(tree.dir, "named");
      yield* fs.makeDirectory(named, { recursive: true });
      const git = (...args: string[]) =>
        exec(["git", "-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: named });
      yield* git("init", "-q", "-b", "main");
      yield* git("commit", "-q", "--allow-empty", "-m", "base");
      yield* git("checkout", "-q", "-b", "topic");
      yield* git("commit", "-q", "--allow-empty", "-m", "work");
      const bin = join(tree.dir, "bin");
      yield* fs.makeDirectory(bin, { recursive: true });
      yield* fs.writeFileString(join(bin, "glab"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });

      const refused = yield* cli(
        [
          "--json",
          "run",
          "start",
          "review",
          "--input",
          `workspace=${named}`,
          "--input",
          "plan=",
          "--input",
          "proves=",
        ],
        { COLLIE_CWD: tree.elsewhere, PATH: `${bin}:/usr/bin:/bin` },
      );
      expect(yield* parseEnvelope(refused.stdout)).toMatchObject({
        ok: false,
        error: {
          code: "needs_input",
          details: {
            inputs: [{ name: "target", facts: [expect.stringContaining("main...topic")] }],
          },
        },
      });
    }),
  ));

const documentedStarts = Effect.fn("test.documentedStarts")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const lines: string[] = [];
  for (const file of ["README.md", "docs/cli.md"]) {
    const text = yield* fs.readFileString(join(root, file));
    for (const line of Str.split(text, "\n")) {
      const trimmed = Str.trim(line);
      if (!pipe_(trimmed, Str.startsWith("collie run start "))) continue;
      if (/[<…]|\\$/.test(trimmed)) continue;
      lines.push(trimmed);
    }
  }
  return lines;
});

const words = (line: string) =>
  Arr.map([...pipe_(line, Str.matchAll(/(?:[^\s"]+|"[^"]*")+/g))], ([word]) =>
    pipe_(word, Str.replaceAll('"', "")),
  );

test("every documented start, run inside a checkout, is admitted as written", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tree = yield* projectsTree();
      const checkout = join(tree.root, "app");
      yield* fs.makeDirectory(join(checkout, ".collie"), { recursive: true });
      yield* fs.writeFileString(
        join(checkout, ".collie/verify.json"),
        `[{"name":"unit","executable":"true","argv":[],"cwd":"worktree"}]`,
      );
      for (const args of [
        ["init", "-q", "-b", "main"],
        ["remote", "add", "origin", "git@gitlab.example.com:team/project.git"],
        [
          "-c",
          "user.email=t@example.com",
          "-c",
          "user.name=t",
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          "first",
        ],
        ["remote", "add", "upstream", "git@gitlab.example.com:group/app.git"],
      ])
        yield* exec(["git", ...args], { cwd: checkout });
      const bin = join(tree.dir, "bin");
      yield* fs.makeDirectory(bin, { recursive: true });
      yield* fs.writeFileString(join(bin, "glab"), "#!/bin/sh\necho '[]'\n", { mode: 0o755 });
      const starts = yield* documentedStarts();
      expect(starts.length).toBeGreaterThan(2);
      for (const line of starts) {
        const started = yield* cli(["--json", ...words(line).slice(1)], {
          COLLIE_CWD: checkout,
          GITTE_CWD: tree.root,
          GITLAB_USER_LOGIN: "tester",
          PATH: `${bin}:/usr/bin:/bin`,
        });
        const envelope = yield* parseEnvelope(started.stdout);
        expect({ line, ok: envelope.ok, error: envelope.error?.message }).toEqual({
          line,
          ok: true,
          error: undefined,
        });
      }
    }),
  ));

test("the names the host settles are published beside the ones a module declares", () =>
  runEffect(
    Effect.gen(function* () {
      const implement = yield* cli(["--json", "workflow", "show", "implement"]);
      const described = (yield* Schema.decodeEffect(ShownModule)(implement.stdout).pipe(
        Effect.orDie,
      )).data.workflow;
      expect(Arr.map(described.inputs, (one) => one.name)).not.toContain("branch");
      expect(Arr.map(described.options, (one) => one.name)).toEqual([
        "branch",
        "task",
        "workspace",
        "repo",
        "change",
        "stacked",
        "outcome",
        "risks",
        "previous",
        "harness",
        "model",
        "effort",
      ]);

      const human = yield* cli(["workflow", "show", "implement"]);
      expect(human.stdout).toContain("branch:");
      expect(human.stdout).toContain("--input branch=");

      const listed = yield* cli(["--json", "workflow", "list"]);
      const workflows = (yield* Schema.decodeEffect(WorkflowRows)(listed.stdout).pipe(Effect.orDie))
        .data.workflows;
      const row = Option.getOrUndefined(Arr.findFirst(workflows, (w) => w.id === "implement"))!;
      expect(Arr.map(row.inputs, (input) => input.name)).not.toContain("branch");
    }),
  ));

test("an agent saves a workflow, checks it and finds it, with nothing to register by hand", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "collie-authoring-" });
      const scratch = { COLLIE_CWD: cwd };
      const saved = join(cwd, ".collie", "workflows");

      const made = yield* cli(
        ["--json", "workflow", "create", "tally", "--layer", "project"],
        scratch,
      );
      expect(made.exit).toBe(0);
      expect(yield* parseEnvelope(made.stdout)).toMatchObject({
        ok: true,
        data: { path: join(saved, "tally.workflow.ts"), toolchain: null },
      });
      for (const name of ["package.json", "tsconfig.json", "collie.d.ts"]) {
        expect(yield* fs.exists(join(saved, name))).toBe(true);
      }

      const listed = yield* cli(["workflow", "list"], scratch);
      expect(listed.stdout).toContain("tally\tproject");

      const checked = yield* cli(["workflow", "check", "tally"], scratch);
      expect(checked.exit).toBe(0);
      expect(checked.stdout).toContain("tally\tproject\tok");
      expect(checked.stdout).not.toContain("not typechecked");

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
    }),
  ));

test("forking a module writes a file that imports what it keeps, and the merge flags are a migration", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "collie-forking-" });
      const scratch = { COLLIE_CWD: cwd };

      const forked = yield* cli(
        ["--json", "workflow", "fork", "implement", "--layer", "project", "--name", "ours"],
        scratch,
      );
      expect(forked.exit).toBe(0);
      const path = join(cwd, ".collie", "workflows", "ours.workflow.ts");
      expect(yield* parseEnvelope(forked.stdout)).toMatchObject({ ok: true, data: { path } });
      const text = yield* fs.readFileString(path);
      expect(text).toContain("workflows/implement.workflow.ts");
      expect(text).toContain("...original");
      expect(text).toContain('id: "ours"');
      expect(text).not.toContain("title:");

      const shown = yield* cli(["--json", "workflow", "show", "ours"], scratch);
      const described = (yield* Schema.decodeEffect(ShownModule)(shown.stdout).pipe(Effect.orDie))
        .data.workflow;
      expect(described.layer).toBe("project");
      expect(Arr.map(described.inputs, (one) => one.name)).toEqual(["plan", "recovery", "then"]);

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
      expect(yield* fs.exists(join(cwd, ".collie", "workflows", "theirs.workflow.ts"))).toBe(false);
    }),
  ));

test("upgrade is a command of its own, and says what it would do", () =>
  runEffect(
    Effect.gen(function* () {
      const help = yield* cli(["upgrade", "--help"]);
      expect(help.exit).toBe(0);
      expect(help.stdout).toContain("Update this installation");
      const root = yield* cli(["--help"]);
      expect(root.stdout).toContain("upgrade");
    }),
  ));

test("the version the CLI reports is the one package.json declares", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const manifest = yield* fs.readFileString(join(root, "package.json"));
      const declared = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
      )(manifest);

      const shown = yield* cli(["--version"]);

      expect(Str.trim(shown.stdout)).toContain(declared.version);
    }),
  ));

test("intent defaults round trip, and a Run's Intent is amended through the envelope", () =>
  hosted("collie-intent-", ({ world }) =>
    Effect.gen(function* () {
      const shared = {
        COLLIE_ROOT: world.install,
        COLLIE_STATE_DIR: world.state,
        COLLIE_USER_DIR: world.config,
      };

      const added = yield* cli(
        ["--json", "run", "intent", "defaults", "add-constraint", "no new dependencies"],
        shared,
      );
      expect(added.exit).toBe(0);
      expect(yield* parseEnvelope(added.stdout)).toMatchObject({ ok: true });
      const shown = yield* cli(["--json", "run", "intent", "defaults", "show"], shared);
      expect(shown.stdout).toContain("no new dependencies");

      const bogus = yield* cli(
        ["--json", "run", "intent", "defaults", "set-authority", "invented=true"],
        shared,
      );
      expect(bogus.exit).toBe(2);
      expect(yield* parseEnvelope(bogus.stdout)).toMatchObject({
        ok: false,
        error: { code: "invalid_input" },
      });

      const run = yield* settledRun(world, "hello");
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
        data: { runId: run.id, version: 2 },
      });

      const intent = yield* readIntent(run.dir);
      expect(intent?.version).toBe(2);
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(intent), (present) =>
            Arr.map(present.constraints, (constraint) => constraint.text),
          ),
        ),
      ).toEqual(["preserve the public --json envelope"]);
    }).pipe(Effect.provide(recordsAt(world.state))),
  ));

test("run metrics reports what a Run produced, and says so when it has produced nothing", () =>
  hosted("collie-metrics-", ({ world }) =>
    Effect.gen(function* () {
      const env = { COLLIE_STATE_DIR: world.state };
      const run = yield* settledRun(world, "hello", { outcome: "bug" });

      const empty = yield* cli(["--json", "run", "metrics", run.id], env);
      expect(empty.exit).toBe(0);
      const bare = yield* parseEnvelope(empty.stdout);
      expect(bare.ok).toBe(true);
      // WARNING: the envelope decoded `ok: true` above, and `run metrics` puts exactly these fields in `data` — asserted immediately below, so a shape that changed fails here rather than passing silently.
      const data = bare.data as {
        metrics: { timeToFirstEvidence: number | null };
        outcome: string;
      };
      expect(data.metrics.timeToFirstEvidence).toBeNull();
      expect(data.outcome).toBe("bug");

      yield* appendMetric(evidenceDir(world.state, run.id), {
        at: "2026-09-01T10:00:00Z",
        kind: "verification",
        subject: "v1",
        value: 1,
        note: "pass",
      }).pipe(Effect.provide(recordsAt(world.state)));

      const shown = yield* cli(["run", "metrics", run.id], env);
      expect(shown.exit).toBe(0);
      expect(shown.stdout).toContain("time to first evidence: 0s");
      expect(shown.stdout).toContain("1 pass, 0 fail, 0 unstable (1 by collie)");
      expect(shown.stdout).toContain("rework: 0");
    }),
  ));

test("run intent remember keeps a Run's checks for its repository, and overwrites only when told", () =>
  hosted("collie-remember-", ({ world }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const env = { COLLIE_STATE_DIR: world.state, COLLIE_USER_DIR: world.config };
      const worktree = join(world.home, "worktree");
      yield* fs.makeDirectory(worktree, { recursive: true });
      yield* exec(["git", "init", "-q"], { cwd: worktree });
      for (const cwd of [world.project, worktree])
        yield* exec(["git", "remote", "add", "origin", "git@example.test:team/app.git"], { cwd });
      const run = yield* settledRun(world, "hello", { workspace: worktree });
      const client = yield* connect(world.state).pipe(Effect.orDie);
      expect((yield* client.run({ runId: run.id }).pipe(Effect.orDie))?.cwd).toBe(worktree);
      yield* writeIntent(run.dir, seedIntent(run.id, { goal: "ship it" }));

      const granted = yield* cli(
        ["--json", "run", "intent", "verification", run.id, "--name", "unit", "--", "true"],
        env,
      );
      expect(granted.exit).toBe(0);

      const remember = ["--json", "run", "intent", "remember", run.id];
      const first = yield* cli(remember, env);
      expect(first.exit).toBe(0);
      expect(yield* parseEnvelope(first.stdout)).toMatchObject({ ok: true });
      const file = join(world.config, "verify/example.test/team/app.json");
      expect(decodeRemembered(yield* fs.readFileString(file))).toEqual([
        { name: "unit", executable: "true", argv: [], cwd: "worktree" },
      ]);

      yield* fs.remove(worktree, { recursive: true });
      const again = yield* cli(remember, env);
      expect(again.exit).not.toBe(0);
      expect(yield* parseEnvelope(again.stdout)).toMatchObject({ ok: false });

      const replaced = yield* cli([...remember, "--replace"], env);
      expect(replaced.exit).toBe(0);
    }).pipe(Effect.provide(recordsAt(world.state))),
  ));

test("run report counts every Run by where it ended, and refuses a --since that is not a date", () =>
  hosted("collie-report-", ({ world }) =>
    Effect.gen(function* () {
      const env = { COLLIE_STATE_DIR: world.state };
      yield* settledRun(world, "hello");

      const all = yield* cli(["--json", "run", "report"], env);
      expect(all.exit).toBe(0);
      const report = yield* parseEnvelope(all.stdout);
      expect(report.ok).toBe(true);
      // WARNING: the envelope decoded `ok: true` above, and `run report`'s `data` is the Report — these two fields are asserted immediately below.
      const data = report.data as { total: number; workflows: Array<{ total: number }> };
      expect(data.total).toBe(1);
      expect(data.workflows[0]!.total).toBe(1);

      const ran = yield* settledRun(world, "hello");
      yield* appendMetric(evidenceDir(world.state, ran.id), {
        at: "2026-09-30T10:00:00.000Z",
        kind: "context",
        subject: "hello-agent",
        value: 42_000,
        note: "",
      }).pipe(Effect.provide(recordsAt(world.state)));
      const measured = yield* cli(["--json", "run", "report"], env);
      // WARNING: `run report`'s `data` is the Report; only its peak context is read.
      const measures = (yield* parseEnvelope(measured.stdout)).data as {
        measures: {
          peakContext: Array<{ runId: string; tokens: number | null; agent: string | null }>;
        };
      };
      expect(measures.measures.peakContext).toContainEqual({
        runId: ran.id,
        tokens: 42_000,
        agent: "hello-agent",
      });
      const text = yield* cli(["run", "report"], env);
      expect(text.stdout).toContain("peak context tokens: 1 of 2 Runs recorded");
      const asked = yield* callTool(readEnv({ ...process.env, ...env }), "collie_report", {});
      expect(asked).toBe(Str.trim(text.stdout));

      const later = yield* cli(["--json", "run", "report", "--since", "2999-01-01"], env);
      expect(later.exit).toBe(0);
      // WARNING: as above; only `total` is read.
      expect(((yield* parseEnvelope(later.stdout)).data as { total: number }).total).toBe(0);

      const bad = yield* cli(["--json", "run", "report", "--since", "nope"], env);
      expect(bad.exit).not.toBe(0);
      expect((yield* parseEnvelope(bad.stdout)).ok).toBe(false);
    }),
  ));

test("usage is each Subscription's reading in the standard envelope, and says why one is missing", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const claudeDir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-claude-" });
      const login = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        claudeAiOauth: { accessToken: "t", expiresAt: 1, subscriptionType: "max" },
      }).pipe(Effect.orDie);
      yield* fs.writeFileString(join(claudeDir, ".credentials.json"), login);
      const state = yield* fs.makeTempDirectoryScoped({ prefix: "collie-state-" });
      yield* Effect.addFinalizer(() => Effect.ignore(stopHost(state)));
      const env = { CLAUDE_CONFIG_DIR: claudeDir, COLLIE_STATE_DIR: state };

      const read = yield* cli(["--json", "usage"], env);
      expect(read.exit).toBe(0);
      expect(yield* parseEnvelope(read.stdout)).toMatchObject({
        ok: true,
        data: {
          readings: [
            {
              subscription: "claude",
              plan: "max",
              windows: [],
              source: "claude-usage",
              problem: "Claude Code's login expired; it refreshes when Claude Code next runs",
            },
            {
              subscription: "chatgpt",
              source: "codex-app-server",
              problem: "Codex is not installed on this Machine",
            },
          ],
        },
      });
      expect(yield* fs.readFileString(join(claudeDir, ".credentials.json"))).toBe(login);

      const human = yield* cli(["usage"], env);
      expect(human.exit).toBe(0);
      expect(Str.split(Str.trim(human.stdout), "\n")).toEqual([
        "claude  Claude Code's login expired; it refreshes when Claude Code next runs",
        "chatgpt Codex is not installed on this Machine",
      ]);
      const trail = yield* readAudit(join(state, "usage"));
      expect(Arr.map(trail, ({ operation, actor }) => [operation, actor.origin])).toEqual([
        ["usage", "cli"],
        ["usage", "cli"],
      ]);

      const door = yield* frontDoor(socketOf(state));
      yield* Effect.forEach(Array.from({ length: 230 }), () => door.usage(), {
        concurrency: "unbounded",
      });
      expect((yield* readAudit(join(state, "usage"))).length).toBe(200);
    }),
  ));
