// One behaviour, two front doors. Each case runs the same operation twice against
// identical Runs — once through the Herdr adapter, once through the `collie` CLI as
// its own process — and compares what an outside observer can see afterwards: the
// Run dir and the herdr calls. Nothing here asserts how either side got there.
//
// Start and resume have no adapter half left to diverge: the picker and the resume
// pane prompt, then call the same operation the CLI does, so those cases compare the
// operation against the CLI process rather than a copy of itself.
//
// The env below is pinned rather than inherited because this suite may itself be
// running inside herdr, where a leaked socket or workspace id would scope the two
// halves differently and make them look divergent when they are not.

import type { BunServices } from "@effect/platform-bun";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  Config,
  ConfigProvider,
  Effect,
  FileSystem,
  Path,
  PlatformError,
  Schema,
  Scope,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { runEffect } from "./support/effect";
import { writeChoice } from "../src/driver";
import { nowIso } from "../src/time";
import { readEnv, type PluginEnv } from "../src/env";
import { answerKey, stopRun as boardStop, type ControlSession } from "../src/flows";
import { Herdr } from "../src/herdr";
import { prepareWorkflow, resumeRun, startRun } from "../src/operations";
import { registerAgent, registryPath, scopeFor } from "../src/registry";
import { Run, RunStore } from "../src/run";
import type { RunRow, WorkspaceView } from "../src/workspace";

const root = new URL("../", import.meta.url).pathname;
let dir: string;
interface ParityEnv extends Record<string, string> {
  COLLIE_CWD: string;
  COLLIE_DRIVER: string;
  HERDR_PLUGIN_STATE_DIR: string;
}
let env: ParityEnv;

type TestError = Config.ConfigError | Error | PlatformError.PlatformError;
type TestServices = BunServices.BunServices | Scope.Scope;

const effectTest = (
  name: string,
  body: () => Generator<Effect.Effect<unknown, TestError, TestServices>, void, unknown>,
) => test(name, () => runEffect(Effect.gen(body).pipe(Effect.scoped)), 30_000);

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      dir = yield* fs.makeTempDirectory({ prefix: "collie-parity-" });
      const plugin = path.join(dir, "plugin");
      const workspace = path.join(dir, "workspace");
      yield* fs.makeDirectory(path.join(plugin, "workflows"), { recursive: true });
      yield* fs.makeDirectory(path.join(plugin, "personas"), { recursive: true });
      yield* fs.makeDirectory(workspace, { recursive: true });
      yield* fs.writeFileString(
        path.join(plugin, "workflows", "demo.md"),
        `---
name: demo
title: Demo
description: A demo.
inputs:
  goal: goal
steps:
  - id: work
    persona: helper
    output: out.json
---
## work
Do it.
`,
      );
      yield* fs.writeFileString(
        path.join(plugin, "personas", "helper.md"),
        `---
name: helper
description: Helps.
---
Help.
`,
      );
      // Both front doors reach herdr through this one script, so its log is the
      // record of what each of them actually asked herdr to do.
      const herdr = path.join(dir, "herdr");
      yield* fs.writeFileString(
        herdr,
        `#!/bin/sh
printf '%s\\n' "$*" >> "${path.join(dir, "herdr-calls")}"
if [ "$1 $2" = "workspace list" ]; then
  printf '%s\\n' '{"result":{"workspaces":[{"workspace_id":"w1","label":"One","cwd":"${workspace}"}]}}'
else
  printf '%s\\n' '{"result":{}}'
fi
`,
        { mode: 0o755 },
      );
      // A driver that records nothing but its own launch: a real one would race us.
      const driver = path.join(dir, "driver");
      yield* fs.writeFileString(
        driver,
        `#!/bin/sh
printf '%s\\n' "$COLLIE_RUN" >> "${path.join(dir, "drivers")}"
`,
        { mode: 0o755 },
      );
      env = {
        PATH: yield* Config.string("PATH").pipe(Config.withDefault("")),
        HOME: dir,
        COLLIE_CWD: workspace,
        HERDR_PLUGIN_ROOT: plugin,
        HERDR_PLUGIN_CONFIG_DIR: path.join(dir, "config"),
        HERDR_PLUGIN_STATE_DIR: path.join(dir, "state"),
        HERDR_BIN_PATH: herdr,
        HERDR_WORKSPACE_ID: "w1",
        HERDR_ACTIVE_WORKSPACE_ID: "w1",
        HERDR_SOCKET_PATH: path.join(dir, "herdr.sock"),
        HERDR_PLUGIN_CONTEXT_JSON: "{}",
        COLLIE_DRIVER: driver,
      };
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(dir, { recursive: true, force: true });
    }),
  ),
);

const EnvelopeJson = Schema.fromJsonString(
  Schema.Struct({
    ok: Schema.Boolean,
    data: Schema.optionalKey(Schema.Struct({ runId: Schema.optionalKey(Schema.String) })),
    error: Schema.optionalKey(Schema.Struct({ code: Schema.String, message: Schema.String })),
  }),
);

const InboxCommandJson = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.String,
    requestId: Schema.String,
    choiceId: Schema.optionalKey(Schema.String),
    answer: Schema.optionalKey(Schema.String),
  }),
);

const RecordJson = Schema.fromJsonString(
  Schema.Struct({
    status: Schema.String,
    slug: Schema.String,
    workflow: Schema.String,
    workspace: Schema.NullOr(Schema.String),
    workspace_label: Schema.NullOr(Schema.String),
    inputs: Schema.Record(Schema.String, Schema.String),
    input_sources: Schema.Record(Schema.String, Schema.String),
    steps: Schema.Array(Schema.Struct({ id: Schema.String, status: Schema.String })),
  }),
);

const pluginEnv = (): PluginEnv => readEnv(env);

/** The in-process half reads the driver override the way a spawned one reads its env. */
const withDriver = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      ConfigProvider.layer(ConfigProvider.fromUnknown({ COLLIE_DRIVER: env.COLLIE_DRIVER })),
    ),
  );

/** The CLI as its own process, exactly as an agent would run it. */
const cli = (args: string[]) => cliWith(env, args);

const cliWith = Effect.fn("parity.cli")(function* (
  withEnv: Record<string, string>,
  args: string[],
) {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const process = yield* spawner.spawn(
    ChildProcess.make("bun", [path.join(root, "src/main.ts"), "--json", ...args], {
      cwd: root,
      env: withEnv,
      extendEnv: true,
      stdout: "pipe",
      // Nothing here asserts on diagnostics, and an unread pipe is a place to wedge.
      stderr: "ignore",
    }),
  );
  const [stdout, exit] = yield* Effect.all(
    [
      process.stdout.pipe(
        Stream.decodeText(),
        Stream.runFold(
          () => "",
          (out, chunk) => out + chunk,
        ),
      ),
      process.exitCode,
    ],
    { concurrency: "unbounded" },
  ).pipe(Effect.scoped);
  return { body: yield* Schema.decodeUnknownEffect(EnvelopeJson)(stdout), exit: Number(exit) };
});

const makeRun = Effect.fn("parity.makeRun")(function* () {
  const prepared = yield* prepareWorkflow(pluginEnv(), "demo");
  if (!prepared.ok) throw new Error(prepared.error.message);
  for (const item of prepared.resolutions) {
    if (item.name !== "goal") continue;
    item.value = "ship";
    item.source = "explicit";
    item.needsAsking = false;
  }
  const started = yield* withDriver(
    startRun(pluginEnv(), {
      workflow: prepared.workflow,
      resolutions: prepared.resolutions,
      workspace: { workspaceId: "w1", label: "One", cwd: env.COLLIE_CWD, worktree: null },
    }),
  );
  if (!(started instanceof Run)) throw new Error(started.error.message);
  return started;
});

/** Everything about a Run that outlives the process that changed it. */
const observed = Effect.fn("parity.observed")(function* (runDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const inbox = path.join(runDir, "inbox");
  const commands = (yield* fs.exists(inbox))
    ? yield* Effect.forEach(yield* fs.readDirectory(inbox), (name) =>
        fs.readFileString(path.join(inbox, name)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(InboxCommandJson)),
          // The request id is deliberately unique per call, so it cannot be compared.
          Effect.map((command) => ({ ...command, requestId: "" })),
        ),
      )
    : [];
  const record = yield* Schema.decodeUnknownEffect(RecordJson)(
    yield* fs.readFileString(path.join(runDir, "run.json")),
  );
  return {
    stopped: yield* fs.exists(path.join(runDir, "stopped")),
    ...record,
    commands: commands.toSorted((a, b) => a.type.localeCompare(b.type)),
  };
});

const herdrCalls = Effect.fn("parity.herdrCalls")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(dir, "herdr-calls");
  if (!(yield* fs.exists(file))) return [];
  return (yield* fs.readFileString(file)).split("\n").filter((line) => line !== "");
});

effectTest("answering through the board and through the CLI leave the same trace", function* () {
  const board = yield* makeRun();
  const command = yield* makeRun();
  const menu = {
    id: "c1",
    kind: "menu",
    run: board.id,
    step: "work",
    header: "Pick",
    footer: "",
    items: [
      { id: "yes", title: "Yes" },
      { id: "no", title: "No" },
    ],
  } as const;
  yield* writeChoice(board.dir, menu);
  yield* writeChoice(command.dir, { ...menu, run: command.id });

  const row: RunRow = {
    id: board.id,
    dir: board.dir,
    glyph: "⚠",
    title: "Demo",
    detail: "",
    choice: menu,
  };
  yield* answerKey(row, { index: 0, typed: "" }, "\r");
  expect((yield* cli(["run", "answer", command.id, "yes"])).exit).toBe(0);

  const fromBoard = yield* observed(board.dir);
  const fromCli = yield* observed(command.dir);
  expect(fromBoard.commands).toEqual([
    { type: "answer", requestId: "", choiceId: "c1", answer: "yes" },
  ]);
  expect(fromCli.commands).toEqual(fromBoard.commands);
  expect(fromCli.status).toEqual(fromBoard.status);

  // And both refuse a second answer to the same Choice.
  const again = yield* answerKey(row, { index: 0, typed: "" }, "\r");
  expect(again.note).toContain("already has an answer");
  expect((yield* cli(["run", "answer", command.id, "yes"])).body.ok).toBe(false);
});

effectTest("stopping through the board and through the CLI leave the same trace", function* () {
  const board = yield* makeRun();
  const command = yield* makeRun();
  const scope = scopeFor(pluginEnv(), env.COLLIE_CWD);
  const registry = yield* registryPath(pluginEnv().stateDir, scope);
  for (const [run, pane] of [
    [board, "pane-board"],
    [command, "pane-cli"],
  ] as const) {
    yield* registerAgent(registry, {
      role: run.id,
      agent: `agent-${pane}`,
      paneId: pane,
      workspaceId: "w1",
      runId: run.id,
      workflow: "demo",
      at: yield* nowIso(),
    });
  }

  const session: ControlSession = {
    ...scope,
    herdr: new Herdr(pluginEnv()),
    stateDir: pluginEnv().stateDir,
  };
  // Only the fields the board's stop reads; the rest is rendering.
  const view: Pick<WorkspaceView, "active"> = {
    active: [{ id: board.id, dir: board.dir, glyph: "▶", title: "Demo", detail: "", choice: null }],
  };
  expect(yield* boardStop(session, view)).toContain("stopped");
  expect((yield* cli(["run", "stop", command.id])).exit).toBe(0);

  const fromBoard = yield* observed(board.dir);
  const fromCli = yield* observed(command.dir);
  expect(fromBoard.stopped).toBe(true);
  expect(fromCli).toEqual(fromBoard);

  // Each closed its own Run's pane, and only that one.
  const calls = yield* herdrCalls();
  expect(calls.some((line) => line.includes("pane-board"))).toBe(true);
  expect(calls.some((line) => line.includes("pane-cli"))).toBe(true);
});

effectTest("resuming through the operation and through the CLI leave the same trace", function* () {
  const board = yield* makeRun();
  const command = yield* makeRun();
  for (const run of [board, command]) {
    run.record.status = "failed";
    for (const step of run.record.steps) step.status = "failed";
    yield* run.save();
  }

  const resumed = yield* withDriver(resumeRun(pluginEnv(), board, "req-board"));
  expect(resumed.ok).toBe(true);
  expect((yield* cli(["run", "resume", command.id, "--request-id", "req-cli"])).exit).toBe(0);

  const fromBoard = yield* observed(board.dir);
  const fromCli = yield* observed(command.dir);
  expect(fromBoard.status).toBe("running");
  expect(fromCli).toEqual(fromBoard);
});

effectTest("starting through the operation and through the CLI record the same Run", function* () {
  const fromOperation = yield* observed((yield* makeRun()).dir);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const started = yield* cli(["run", "start", "demo", "--input", "goal=ship"]);
  expect(started.exit).toBe(0);
  const runId = started.body.data?.runId ?? "";
  const fromCli = yield* observed(path.join(env.HERDR_PLUGIN_STATE_DIR, "runs", runId));

  // The slug carries the Run's own id, and only that differs.
  expect({ ...fromCli, slug: "" }).toEqual({ ...fromOperation, slug: "" });
  expect(fromCli.slug.startsWith("demo-ship")).toBe(true);
  expect(fromOperation.slug.startsWith("demo-ship")).toBe(true);

  // Both handed the Run to a detached driver, and to exactly one.
  const launched = (yield* fs.readFileString(path.join(dir, "drivers"))).trim().split("\n");
  expect(launched).toHaveLength(2);
  expect(launched).toContain(runId);
});

effectTest("a run.json that is not a Run is reported, not trusted", function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const run = yield* makeRun();
  yield* fs.writeFileString(path.join(run.dir, "run.json"), '{"id":"broken"}\n');

  // The CLI names the Run and says its state is invalid rather than half-reading it.
  const shown = yield* cli(["run", "show", run.id]);
  expect(shown.body).toMatchObject({ ok: false, error: { code: "invalid_state" } });
  expect(shown.exit).toBe(1);
  expect((yield* cli(["run", "list"])).body).toMatchObject({
    ok: false,
    error: { code: "invalid_state" },
  });

  // And the store refuses to hand it to anyone, so no reader has to check again.
  const failure = yield* Effect.result(new RunStore(env.HERDR_PLUGIN_STATE_DIR).load(run.id));
  expect(failure._tag).toBe("Failure");
});

effectTest("concurrent starts get a directory and a sequence number each", function* () {
  const started = yield* Effect.all([makeRun(), makeRun(), makeRun(), makeRun()], {
    concurrency: "unbounded",
  });

  // Same workflow, same input, same second: the Run directory is the thing they race
  // for, and a shared one would mean each overwriting the other's run.json.
  expect(new Set(started.map((run) => run.id)).size).toBe(4);
  expect(new Set(started.map((run) => run.dir)).size).toBe(4);
  // The sequence number is what makes their agent names unique, and herdr refuses a
  // duplicate name outright.
  expect(new Set(started.map((run) => run.record.seq)).size).toBe(4);
});

effectTest("a Run that stops being readable ends the wait as a failure", function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const run = yield* makeRun();
  yield* fs.remove(path.join(run.dir, "run.json"), { force: true });

  const waited = yield* cli(["run", "wait", run.id]);
  expect(waited.body).toMatchObject({ ok: false, error: { code: "run_not_found" } });
  expect(waited.exit).toBe(1);
});

effectTest(
  "a start that cannot spawn a Driver records the Run as failed and replays",
  function* () {
    const path = yield* Path.Path;
    const broken = { ...env, COLLIE_DRIVER: path.join(dir, "nope") };
    const first = yield* cliWith(broken, [
      "run",
      "start",
      "demo",
      "--input",
      "goal=ship",
      "--request-id",
      "r1",
    ]);
    expect(first.body).toMatchObject({ ok: false, error: { code: "operation_failed" } });

    // Recorded, not left running with nothing driving it.
    const runs = yield* new RunStore(env.HERDR_PLUGIN_STATE_DIR).list();
    expect(runs.map((run) => run.record.status)).toEqual(["failed"]);

    // And the receipt replays, so the retry does not create a second Run.
    const again = yield* cliWith(broken, [
      "run",
      "start",
      "demo",
      "--input",
      "goal=ship",
      "--request-id",
      "r1",
    ]);
    expect(again.body).toEqual(first.body);
    expect((yield* new RunStore(env.HERDR_PLUGIN_STATE_DIR).list()).length).toBe(1);
  },
);
