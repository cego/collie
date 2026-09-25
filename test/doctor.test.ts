// `collie doctor`: every prerequisite checked at once, each with the command that
// fixes it. Driven at the operation, with the outside world scripted through the
// fake-PATH rig — the same seam the `upgrade` tests use.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { runEffect } from "./support/effect";
import { FakeHerdr, Rig } from "./support/recorder";
import { installBaseline } from "./support/engine";
import { installFakeSkills, writeDef } from "./support/defs";
import { FakeBin } from "./support/bin";
import { doctor } from "../src/doctor";
import { claudeSettingsPath, installStatusLine } from "../src/statusline";
import { shell } from "../src/mr";
import type { OpResult } from "../src/operations";

let rig: Rig;
let bin: FakeBin;

/**
 * The environment doctor sees. Its PATH is the stub directory alone: the developer's
 * own `claude` or `glab` would otherwise answer for one a test has removed.
 */
function env(overrides: Record<string, string> = {}) {
  return rig.pluginEnv({ PATH: `${rig.root}/bin`, ...overrides });
}

/** doctor against this rig: the fake herdr in-process, everything else on PATH. */
function report(overrides: Record<string, string> = {}) {
  const pluginEnv = env({
    FAKE_HERDR_PLUGINS: `cego.collie 0.1.0 [local:${rig.baselineDir}]`,
    ...overrides,
  });
  return doctor(pluginEnv, undefined, new FakeHerdr(pluginEnv));
}

const healthy = Effect.fn("doctorTest.healthy")(function* () {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(
    `${rig.baselineDir}/herdr-plugin.toml`,
    'id = "cego.collie"\nmin_herdr_version = "0.7.5"\n',
  );
  yield* fs.makeDirectory(`${rig.baselineDir}/bin`, { recursive: true });
  yield* fs.writeFileString(`${rig.baselineDir}/bin/collie`, "", { mode: 0o755 });
  yield* bin.add("collie", "exit 0");
  yield* bin.add("glab", `exit 0`);
  // A checkout that is level with its remote. `$*`, because the fetch arrives
  // behind the settings that stop it prompting.
  yield* bin.add("git", `case "$*" in *rev-list*) echo 0 ;; *) exit 0 ;; esac`);
  yield* bin.add("claude", `exit 0`);
  yield* bin.add("npx", `exit 0`);
  yield* installFakeSkills(rig.root);
});

/** Take one prerequisite away from the machine, to see what doctor says about it. */
const remove = (target: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.remove(target, { recursive: true }));

/** The checks, decoded from the envelope the same way any other boundary is read. */
const Checks = Schema.Struct({
  checks: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      ok: Schema.Boolean,
      detail: Schema.String,
      fix: Schema.String,
      warn: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});

function reported(result: OpResult) {
  return Schema.decodeUnknownSync(Checks)(result.ok ? result.data : result.error.details).checks;
}

/** One check by name, as doctor reported it. */
function check(result: OpResult, name: string) {
  const found = reported(result).find((c) => c.name === name);
  if (!found) throw new Error(`no check named "${name}"`);
  return found;
}

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      yield* installBaseline(rig);
      bin = yield* FakeBin.make(`${rig.root}/bin`);
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

test("a healthy machine passes every check and says so", () =>
  runEffect(
    Effect.gen(function* () {
      yield* healthy();

      const result = yield* report();

      if (!result.ok) throw new Error(result.error.message);
      expect(result.ok).toBe(true);
      expect(result.ok && result.human).toContain("ready");
      const checks = reported(result);
      expect(checks.every((c) => c.ok)).toBe(true);
      // Every prerequisite, in one run.
      expect(checks.map((c) => c.name)).toEqual([
        "herdr",
        "plugin",
        "runner",
        "collie on PATH",
        "node",
        "skills",
        "harnesses",
        "status line",
        "up to date",
        "workflows",
        "personas",
        "old workflow files",
        "glab",
        "helle",
        "linear mcp",
      ]);
      expect(check(result, "workflows").detail).toBe("every workflow here is the one Collie ships");
    }),
  ));

test("a herdr older than the manifest's minimum is the reported problem", () =>
  runEffect(
    Effect.gen(function* () {
      yield* healthy();
      const result = yield* report({ FAKE_HERDR_VERSION: "herdr 0.7.4" });

      expect(result.ok).toBe(false);
      const herdr = check(result, "herdr");
      expect(herdr.ok).toBe(false);
      expect(herdr.detail).toContain("0.7.4");
      expect(herdr.detail).toContain("0.7.5");
      expect(herdr.fix).not.toBe("");
    }),
  ));

test("a shim whose directory is not on PATH is its own state, not 'installed'", () =>
  runEffect(
    Effect.gen(function* () {
      yield* healthy();
      const fs = yield* FileSystem.FileSystem;
      // Where install.sh writes it by default, which is not on this PATH.
      yield* fs.makeDirectory(`${rig.root}/.local/bin`, { recursive: true });
      yield* fs.rename(`${rig.root}/bin/collie`, `${rig.root}/.local/bin/collie`);

      const result = yield* report();

      const shim = check(result, "collie on PATH");
      expect(shim.ok).toBe(false);
      expect(shim.detail).toContain("not on PATH");
      expect(shim.fix).toContain("PATH");
    }),
  ));

test("a skill store that is not there is named, with the routine that fills it", () =>
  runEffect(
    Effect.gen(function* () {
      yield* healthy();
      yield* remove(`${rig.root}/.agents/skills/collie`);

      const result = yield* report();

      expect(result.ok).toBe(false);
      const skills = check(result, "skills");
      expect(skills.detail).toContain("operator skill");
      // The fix is the routine that owns the sources and the store, not a bare
      // `npx skills add`, which would install a name into neither reliably.
      expect(skills.fix).toBe(`sh ${rig.baselineDir}/prepare.sh`);
    }),
  ));

test("a glab that is logged out is not the same as no glab", () =>
  runEffect(
    Effect.gen(function* () {
      yield* healthy();
      yield* bin.add("glab", `echo "not logged in" >&2; exit 1`);

      const loggedOut = yield* report();
      expect(check(loggedOut, "glab").detail).toContain("logged in");
      expect(check(loggedOut, "glab").fix).toContain("glab auth login");

      yield* remove(`${rig.root}/bin/glab`);
      const absent = yield* report();
      expect(check(absent, "glab").detail).toContain("not installed");
    }),
  ));

test("a glab that did not answer reads differently from one that said no", () =>
  runEffect(
    Effect.gen(function* () {
      yield* healthy();
      // What a timed-out `glab auth status` comes back as, which is what `doctor`
      // turns into a state of its own rather than into "not logged in". The bound
      // itself is twenty seconds of real time and is not what this asserts.
      const result = yield* doctor(
        env({ FAKE_HERDR_PLUGINS: `cego.collie 0.1.0 [local:${rig.baselineDir}]` }),
        (cmd, args, cwd) =>
          cmd === "glab"
            ? Effect.succeed({ code: 124, stdout: "timed out" })
            : shell(cmd, args, cwd, "say"),
      );

      expect(check(result, "glab").detail).toContain("did not answer");
    }),
  ));

test("a plugin linked from somewhere else is reported against this installation", () =>
  runEffect(
    Effect.gen(function* () {
      yield* healthy();
      const result = yield* report({
        FAKE_HERDR_PLUGINS: "cego.collie 0.1.0 [local:/somewhere/else]",
      });

      const plugin = check(result, "plugin");
      expect(plugin.ok).toBe(false);
      expect(plugin.fix).toContain(`herdr plugin link ${rig.baselineDir}`);
    }),
  ));

test("a harness a baseline workflow routes to is checked, and named when missing", () =>
  runEffect(
    Effect.gen(function* () {
      yield* healthy();
      yield* remove(`${rig.root}/bin/claude`);

      const result = yield* report();

      expect(check(result, "harnesses").detail).toContain("claude");
    }),
  ));

test("a runner that cannot be executed is not a runner", () =>
  runEffect(
    Effect.gen(function* () {
      yield* healthy();
      // The shim `exec`s this, so a bin/collie without its bit is the same
      // permission-denied mystery as a shim without one.
      yield* (yield* FileSystem.FileSystem).chmod(`${rig.baselineDir}/bin/collie`, 0o644);

      const result = yield* report();

      expect(check(result, "runner").ok).toBe(false);
      expect(result.ok).toBe(false);
    }),
  ));

test("a checkout behind its remote is reported, the same state the board shows", () =>
  runEffect(
    Effect.gen(function* () {
      yield* healthy();
      yield* bin.add("git", `case "$*" in *rev-list*) echo 3 ;; *) exit 0 ;; esac`);

      const result = yield* report();

      const behind = check(result, "up to date");
      expect(behind.detail).toContain("3 commits behind");
      expect(behind.fix).toBe("collie upgrade");
      // Behind is a thing to say, not a missing prerequisite: it carries the command
      // without failing the run, the same way the board shows it without sending it.
      expect(behind.ok).toBe(true);
      expect(result.ok).toBe(true);
    }),
  ));

test("a git that warns while answering is still answering", () =>
  runEffect(
    Effect.gen(function* () {
      yield* healthy();
      // doctor folds stderr into what it reads, so it can tell a human why a command
      // failed. A git that warns and then answers correctly is not a failure.
      yield* bin.add(
        "git",
        `case "$*" in
          *rev-list*) echo "warning: log.excludeDecoration is deprecated" >&2; echo 3 ;;
          *) exit 0 ;;
        esac`,
      );

      const result = yield* report();

      expect(check(result, "up to date").detail).toContain("3 commits behind");
    }),
  ));

test("an installation that is not a checkout says nothing about being behind", () =>
  runEffect(
    Effect.gen(function* () {
      yield* healthy();
      yield* bin.add("git", `exit 1`);

      const result = yield* report();

      expect(check(result, "up to date").ok).toBe(true);
    }),
  ));

test("every failing check carries its fix, and the message lists them", () =>
  runEffect(
    Effect.gen(function* () {
      // Nothing installed at all: the state a fresh machine is in, herdr included.
      const result = yield* report({
        HERDR_BIN_PATH: `${rig.root}/nowhere/herdr`,
        FAKE_HERDR_PLUGINS: "",
      });

      expect(result.ok).toBe(false);
      const failed = reported(result).filter((c) => !c.ok);
      expect(failed.length).toBeGreaterThan(0);
      expect(failed.every((c) => c.fix !== "")).toBe(true);
      expect(result.ok === false && result.error.message).toContain("herdr");
    }),
  ));

test("what is overridden here is named, never judged and never edited", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* healthy();
      const project = `${rig.projectDir}/.collie`;

      // A module of an author's own, claiming a shipped id — the customisation the whole
      // search path exists for. It is named, with no opinion about what is in it.
      const modules = `${project}/workflows`;
      yield* fs.makeDirectory(modules, { recursive: true });
      const mine = `${modules}/review.workflow.ts`;
      yield* fs.writeFileString(
        mine,
        [
          `import { defineWorkflow } from "collie";`,
          `import { Effect } from "effect";`,
          `export default defineWorkflow({`,
          `  id: "review",`,
          `  title: "Our review",`,
          `  description: "One reviewer, ours.",`,
          `  run: () => Effect.void,`,
          `});`,
        ].join("\n"),
      );
      const found = check(yield* report(), "workflows");
      // Not a failure: a customisation is the user's, and doctor still exits clean.
      expect(found.ok).toBe(true);
      expect(found.detail).toContain(`review (project, ${mine})`);
      expect(found.fix).toBe("");
      // Nothing about what any of them contains: an id doctor recognised would be the
      // start of a shipped workflow being privileged over one somebody wrote.
      expect(found.detail).not.toContain("still runs");

      // A module that answers for an id and will not load is the one exception: the
      // layer below it is not consulted, so nothing would run that id at all.
      yield* fs.writeFileString(mine, "export const id = 1;\n");
      const broken = check(yield* report(), "workflows");
      expect(broken.detail).toContain("review:");
      expect(broken.fix).toContain(mine);
      expect(yield* fs.readFileString(mine)).toBe("export const id = 1;\n");

      yield* fs.remove(project, { recursive: true, force: true });
    }),
  ));

test("a template or a persona naming what nothing fills is named with the file it is in", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* healthy();
      const project = `${rig.projectDir}/.collie`;
      yield* fs.makeDirectory(`${project}/workflows`, { recursive: true });
      yield* fs.makeDirectory(`${project}/personas`, { recursive: true });

      // A template is checked where its module loads, against the input it declares.
      const module = `${project}/workflows/templated.workflow.ts`;
      yield* fs.writeFileString(
        module,
        [
          `import { defineWorkflow, template } from "collie";`,
          `import { Effect } from "effect";`,
          `const told = template("Build {{plan}} as the {{role}}.", {});`,
          `export default defineWorkflow({`,
          `  id: "templated",`,
          `  title: "Templated",`,
          `  description: "Names a plan it never declares.",`,
          `  run: () => Effect.succeed(told.text),`,
          `});`,
        ].join("\n"),
      );
      const workflows = check(yield* report(), "workflows");
      expect(workflows.detail).toContain("templated:");
      expect(workflows.detail).toContain("{{plan}}");
      expect(workflows.detail).not.toContain("{{role}}");
      expect(workflows.fix).toContain(module);

      // A persona is told nothing but where its skills are.
      const persona = `${project}/personas/nosy.md`;
      yield* fs.writeFileString(persona, "Review {{inputs.target}} with {{skill:code-review}}.\n");
      const personas = check(yield* report(), "personas");
      expect(personas.detail).toBe(
        `${persona}: it names {{inputs.target}}; a persona is told nothing but {{skill:name}}`,
      );
      expect(personas.fix).toBe("fix each file named");

      yield* fs.remove(project, { recursive: true, force: true });
    }),
  ));

test("the chat pane's status line is reported, whoever configured it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* healthy();

      // Nothing configured yet: something to do, not a missing prerequisite — a board
      // still works without a line under the chat prompt.
      const bare = check(yield* report(), "status line");
      expect(bare.ok).toBe(true);
      expect(bare.detail).toContain("not configured");
      expect(bare.fix).toContain("status-line --install");

      yield* installStatusLine(env());
      const configured = check(yield* report(), "status line");
      expect(configured.detail).toContain("board");
      // Named, so the human reads that the line under the prompt and the answer chat
      // gets are the same fact.
      expect(configured.detail).toContain("each prompt");
      expect(configured.fix).toBe("");

      // Somebody else's line is theirs: named, and never quietly replaced.
      yield* fs.writeFileString(
        yield* claudeSettingsPath(env()),
        `{"statusLine":{"type":"command","command":"my-own-line"}}\n`,
      );
      expect(check(yield* report(), "status line").detail).toContain("my-own-line");
    }),
  ));

test("Helle is optional: absent is a note, configured and broken is a warning, never a failure", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* healthy();

      // Nothing at all: only a workflow that waits on Helle needs it, so say where it
      // would go and what to put there, and leave the run green.
      const absent = check(yield* report(), "helle");
      expect(absent.ok).toBe(true);
      expect(absent.warn).toBeUndefined();
      expect(absent.detail).toContain(`${rig.root}/.config/helle/env`);
      expect(absent.fix).toContain("HELLE_API_TOKEN=");

      // A file with one of its two lines: misconfigured, which is not "not set up".
      const file = `${rig.root}/.config/helle/env`;
      yield* fs.makeDirectory(`${rig.root}/.config/helle`, { recursive: true });
      yield* fs.writeFileString(file, "HELLE_API_URL=http://127.0.0.1:1\n");
      const missingToken = check(yield* report(), "helle");
      expect(missingToken.ok).toBe(true);
      expect(missingToken.warn).toBe(true);
      expect(missingToken.detail).toContain("HELLE_API_TOKEN");
      expect(missingToken.fix).toContain(file);

      // Both lines, and a Helle that does not answer: the token or the URL is wrong,
      // and the human is told which file to look in.
      yield* fs.writeFileString(file, "HELLE_API_URL=http://127.0.0.1:1\nHELLE_API_TOKEN=x\n");
      const result = yield* report();
      const unreachable = check(result, "helle");
      expect(unreachable.warn).toBe(true);
      expect(unreachable.fix).toContain(file);
      expect(result.ok).toBe(true);
      expect(result.ok && result.human).toContain("! helle");
    }),
  ));

test("a Linear MCP in Claude Code is looked for, and the add command is the fix", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* healthy();

      const absent = check(yield* report(), "linear mcp");
      expect(absent.ok).toBe(true);
      expect(absent.detail).toContain("no Linear MCP server");
      expect(absent.fix).toContain("claude mcp add");

      // User scope, named however the human named it: the URL says it is Linear's.
      yield* fs.writeFileString(
        `${rig.root}/.claude.json`,
        '{"mcpServers":{"tickets":{"type":"http","url":"https://mcp.linear.app/mcp"}}}',
      );
      const found = check(yield* report(), "linear mcp");
      expect(found.detail).toContain('"tickets"');
      expect(found.fix).toBe("");

      // A settings file Claude Code itself cannot read is a warning with the file named.
      yield* fs.writeFileString(`${rig.root}/.claude.json`, "{not json");
      const broken = check(yield* report(), "linear mcp");
      expect(broken.ok).toBe(true);
      expect(broken.warn).toBe(true);
      expect(broken.fix).toContain(".claude.json");
    }),
  ));
