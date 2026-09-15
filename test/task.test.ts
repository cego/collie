// Task-scoped starts and continuations, at the shared operation both front doors use.
// What is asserted is what an outside observer sees: the Runs on disk, the Tasks on
// disk, and the calls that reached herdr — never how the operation got there.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { ConfigProvider, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";
import { installBaseline } from "./support/engine";
import { installFakeSkills, writeDef } from "./support/defs";
import { FakeBin } from "./support/bin";
import { newRequestId, prepareWorkflow, resumeRun, startRun } from "../src/operations";
import { RunStore } from "../src/run";
import {
  listTasks,
  newTask,
  readTask,
  taskOfWorkspace,
  writeTask,
  type TaskChoice,
} from "../src/task";
import type { PluginEnv } from "../src/env";

let rig: Rig;
let bin: FakeBin;
let driverLayer: Layer.Layer<never>;

const DEMO = `---
name: demo
inputs:
  goal: goal
steps:
  - id: work
    persona: planner
    output: out.json
---
## work
Do {{inputs.goal}}
`;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      rig = yield* Rig.make();
      yield* rig.startSocket();
      yield* installBaseline(rig);
      yield* writeDef(rig.baselineDir, "workflows", "demo", DEMO);
      yield* installFakeSkills(rig.root);
      bin = yield* FakeBin.make(path.join(rig.root, "bin"));
      yield* bin.add("glab", `exit 1`);
      yield* bin.add("git", `echo main`);
      const driver = path.join(rig.root, "fake-driver");
      yield* fs.writeFileString(driver, `#!/bin/sh\nexit 0\n`, { mode: 0o755 });
      driverLayer = ConfigProvider.layer(ConfigProvider.fromUnknown({ COLLIE_DRIVER: driver }));
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

/** `run.json` whole, so a key can be taken out of it without losing the rest. */
const RecordJson = Schema.fromJsonString(Schema.JsonObject);

/** One `demo` Run, started exactly as a front door starts it. */
const start = Effect.fn("taskTest.start")(function* (
  env: PluginEnv,
  goal: string,
  task: TaskChoice = { mode: "new" },
) {
  const prepared = yield* prepareWorkflow(env, "demo", task.mode === "continue" ? task.task : null);
  if (!prepared.ok) return yield* Effect.fail(new Error(prepared.error.message));
  for (const resolution of prepared.resolutions) {
    if (resolution.name !== "goal") continue;
    resolution.value = goal;
    resolution.source = "explicit";
    resolution.needsAsking = false;
  }
  return yield* startRun(env, {
    workflow: prepared.workflow,
    resolutions: prepared.resolutions,
    workspace: null,
    task,
  }).pipe(Effect.provide(driverLayer));
});

const startedRun = Effect.fn("taskTest.startedRun")(function* (
  env: PluginEnv,
  goal: string,
  task: TaskChoice = { mode: "new" },
) {
  const result = yield* start(env, goal, task);
  if (result._tag === "Rejected") {
    return yield* Effect.fail(new Error(result.result.error.message));
  }
  return result.run;
});

/** The workspace a `workspace.focus` names, from the params the rig logged. */
const asFocus = Schema.decodeUnknownOption(Schema.Struct({ workspace_id: Schema.String }));

/** Which workspaces herdr was asked to create and to focus, in order. */
const workspaceCalls = Effect.fn("taskTest.workspaceCalls")(function* () {
  const calls = yield* rig.calls();
  return {
    created: calls.filter((call) => call.cmd === "workspace create").length,
    focused: calls
      .filter((call) => call.method === "workspace.focus")
      .flatMap((call) =>
        Option.toArray(Option.map(asFocus(call.params ?? {}), (params) => params.workspace_id)),
      ),
  };
});

test("every fresh start gets a task workspace of its own, and it is focused", () =>
  runEffect(
    Effect.gen(function* () {
      const first = yield* startedRun(rig.pluginEnv(), "one");
      // The second start happens inside the first Task's workspace, which is exactly
      // where a fresh start must not land: a new Task is a new workspace.
      const second = yield* startedRun(
        rig.pluginEnv({ HERDR_WORKSPACE_ID: first.record.workspace ?? "" }),
        "two",
      );

      expect(first.record.task).not.toBeNull();
      expect(second.record.task).not.toBe(first.record.task);
      expect(first.record.workspace).not.toBe("1");
      expect(second.record.workspace).not.toBe(first.record.workspace);

      const tasks = yield* listTasks(rig.stateDir);
      const byName = (a: string, b: string) => a.localeCompare(b);
      expect(tasks.map((task) => task.workspace).toSorted(byName)).toEqual(
        [first.record.workspace!, second.record.workspace!].toSorted(byName),
      );
      const calls = yield* workspaceCalls();
      expect(calls.created).toBe(2);
      expect(calls.focused).toEqual([first.record.workspace!, second.record.workspace!]);
    }),
  ));

test("continuing a Task puts the Run in its workspace without making another", () =>
  runEffect(
    Effect.gen(function* () {
      const first = yield* startedRun(rig.pluginEnv(), "one");
      const task = yield* readTask(rig.stateDir, first.record.task!);
      if (!task) throw new Error("the first start recorded no Task");

      const second = yield* startedRun(rig.pluginEnv(), "two", { mode: "continue", task });

      expect(second.record.task).toBe(first.record.task);
      expect(second.record.workspace).toBe(first.record.workspace);
      expect((yield* workspaceCalls()).created).toBe(1);
      expect(yield* listTasks(rig.stateDir)).toHaveLength(1);
    }),
  ));

test("the current Task is the one whose workspace this is, not the one it is called", () =>
  runEffect(
    Effect.gen(function* () {
      const first = yield* startedRun(rig.pluginEnv(), "one");
      const second = yield* startedRun(rig.pluginEnv(), "two");

      const here = yield* taskOfWorkspace(rig.stateDir, second.record.workspace);
      expect(here?.id).toBe(second.record.task!);
      expect(yield* taskOfWorkspace(rig.stateDir, first.record.workspace)).toMatchObject({
        id: first.record.task!,
      });
      // Nothing outside a Task's workspace is that Task.
      expect(yield* taskOfWorkspace(rig.stateDir, "1")).toBeNull();
    }),
  ));

test("a start whose workspace herdr will not create starts nothing at all", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv({
        FAKE_HERDR_FAIL: Schema.encodeSync(Schema.fromJsonString(Schema.Json))({
          "workspace create": "no room for another workspace",
        }),
      });

      const refused = yield* start(env, "one");

      if (refused._tag === "Started") throw new Error("expected no run without a workspace");
      expect(refused.result.error.code).toBe("operation_failed");
      expect(refused.result.error.message).toContain("workspace");
      // Not in the workspace it was launched from either: there is no fallback.
      expect(yield* new RunStore(rig.stateDir).list()).toHaveLength(0);
      expect(yield* listTasks(rig.stateDir)).toHaveLength(0);
    }),
  ));

test("a Task whose workspace herdr no longer has refuses the continuation", () =>
  runEffect(
    Effect.gen(function* () {
      const first = yield* startedRun(rig.pluginEnv(), "one");
      // A Task whose workspace herdr does not have: one the human closed.
      const task = yield* writeTask(
        rig.stateDir,
        yield* newTask({ workspace: "closed", label: "Gone", cwd: rig.projectDir }),
      );

      const refused = yield* start(rig.pluginEnv(), "two", { mode: "continue", task });

      if (refused._tag === "Started") throw new Error("expected no run into a closed workspace");
      expect(refused.result.error.message).toContain(task.id);
      expect(refused.result.error.message).toContain("no workspace any more");
      // Not into the workspace it was launched from, and not into another Task.
      expect(yield* new RunStore(rig.stateDir).list()).toHaveLength(1);
      expect((yield* new RunStore(rig.stateDir).list())[0]!.id).toBe(first.id);
    }),
  ));

test("a Run recorded before Tasks existed reads back as belonging to none", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const run = yield* startedRun(rig.pluginEnv(), "one");
      const file = path.join(run.dir, "run.json");
      const legacy = yield* Schema.decodeUnknownEffect(RecordJson)(yield* fs.readFileString(file));
      const { task: _written, ...beforeTasks } = legacy;
      yield* fs.writeFileString(file, Schema.encodeSync(RecordJson)(beforeTasks));

      const reread = yield* new RunStore(rig.stateDir).load(run.id);

      expect(reread.record.task).toBeNull();
      // Read, not rewritten: nothing assigns an old Run to a Task behind the human.
      expect(
        yield* Schema.decodeUnknownEffect(RecordJson)(yield* fs.readFileString(file)),
      ).not.toHaveProperty("task");
    }),
  ));

test("a Task's own work source is inferred; another Task's is not", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const mine = yield* startedRun(rig.pluginEnv(), "mine");
      const theirs = yield* startedRun(rig.pluginEnv(), "theirs");
      // Both finished with a plan directory in the same repository, which is all the
      // old repository-wide inference needed to hand either one to the other.
      for (const run of [mine, theirs]) {
        yield* fs.makeDirectory(path.join(run.dir, "plan"), { recursive: true });
        yield* fs.writeFileString(path.join(run.dir, "plan", "SPEC.md"), "# A plan\n");
        run.record.status = "done";
        yield* run.save();
      }

      const task = yield* readTask(rig.stateDir, mine.record.task!);
      const prepared = yield* prepareWorkflow(rig.pluginEnv(), "implement", task);
      if (!prepared.ok) throw new Error(prepared.error.message);

      const plan = prepared.resolutions.find((resolution) => resolution.name === "plan");
      expect(plan?.value).toBe(path.join(mine.dir, "plan"));
      expect(plan?.value).not.toContain(theirs.id);
    }),
  ));

test("a fresh start infers no earlier Task's work source", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const earlier = yield* startedRun(rig.pluginEnv(), "earlier");
      yield* fs.makeDirectory(path.join(earlier.dir, "plan"), { recursive: true });
      yield* fs.writeFileString(path.join(earlier.dir, "plan", "SPEC.md"), "# A plan\n");
      earlier.record.status = "done";
      yield* earlier.save();

      const prepared = yield* prepareWorkflow(rig.pluginEnv(), "implement", null);
      if (!prepared.ok) throw new Error(prepared.error.message);

      const plan = prepared.resolutions.find((resolution) => resolution.name === "plan");
      expect(plan?.needsAsking).toBe(true);
    }),
  ));

test("resuming a Run keeps it in its Task rather than starting a fresh one", () =>
  runEffect(
    Effect.gen(function* () {
      const run = yield* startedRun(rig.pluginEnv(), "one");
      run.record.steps[0]!.status = "failed";
      run.record.status = "failed";
      yield* run.save();
      const before = yield* workspaceCalls();

      const resumed = yield* resumeRun(rig.pluginEnv(), run, yield* newRequestId()).pipe(
        Effect.provide(driverLayer),
      );

      expect(resumed.ok).toBe(true);
      const reread = yield* new RunStore(rig.stateDir).load(run.id);
      expect(reread.record.task).toBe(run.record.task);
      expect(reread.record.workspace).toBe(run.record.workspace);
      expect((yield* workspaceCalls()).created).toBe(before.created);
    }),
  ));

/** The label herdr was asked to put on the workspace it created, in order. */
const createdLabels = Effect.fn("taskTest.createdLabels")(function* () {
  return (yield* rig.calls())
    .filter((call) => call.cmd === "workspace create")
    .map((call) => call.argv?.[call.argv.indexOf("--label") + 1] ?? "");
});

test("a task workspace is named for its project and what the work is", () =>
  runEffect(
    Effect.gen(function* () {
      // What this person already calls this repository's work. Their own spelling, which
      // is not the directory's: reusing it is the whole point.
      yield* rig.addWorkspace("w9", "Project Mercury | Steering ledger", rig.projectDir);

      yield* startedRun(rig.pluginEnv(), "give each task its own workspace");

      expect(yield* createdLabels()).toEqual([
        "Project Mercury | Give each task its own workspace",
      ]);
    }),
  ));

test("naming follows the person's own vocabulary, not one fitted to a project", () =>
  runEffect(
    Effect.gen(function* () {
      // Somebody else's project, established for a repository that is not this one.
      yield* rig.addWorkspace("w9", "Ledger API | Refund webhooks", rig.projectDir);

      yield* startedRun(rig.pluginEnv(), "payout retries");

      // Not borrowed: a prefix belongs to the repository it names, and this one is
      // named from the repository itself rather than from the neighbour that looked handy.
      expect(yield* createdLabels()).toEqual(["Project | Payout retries"]);
    }),
  ));

test("a continuation keeps the Task's name, including one a human changed", () =>
  runEffect(
    Effect.gen(function* () {
      const first = yield* startedRun(rig.pluginEnv(), "one");
      const task = yield* readTask(rig.stateDir, first.record.task!);
      if (!task) throw new Error("the first start recorded no Task");
      const second = yield* startedRun(rig.pluginEnv(), "two", { mode: "continue", task });

      expect(second.record.task).toBe(task.id);
      expect(second.record.workspace).toBe(task.workspace);
      // Nothing was created and nothing renamed: a continuation names nothing, so a
      // workspace the human has since renamed keeps whatever they called it.
      expect(yield* createdLabels()).toHaveLength(1);
      expect((yield* rig.calls()).some((call) => call.cmd.startsWith("workspace rename"))).toBe(
        false,
      );
      expect(yield* readTask(rig.stateDir, task.id)).toMatchObject({ label: task.label });
    }),
  ));

test("where a namer can be asked, its answer is what the workspace is called", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // The frozen prompt this build asks with, and a `claude` that answers in the
      // schema. Both have to be there: without the prompt nothing is asked at all.
      yield* fs.makeDirectory(path.join(rig.baselineDir, "prompts"), { recursive: true });
      yield* fs.writeFileString(
        path.join(rig.baselineDir, "prompts", "namer.md"),
        "Name one workspace.\n",
      );
      const packFile = path.join(rig.root, "namer-pack.txt");
      yield* bin.add(
        "claude",
        `if [ "$1" = "--help" ]; then\n` +
          `  printf '%s\\n' '--print --output-format --json-schema --tools --restricted --strict-mcp-config --setting-sources --no-session-persistence --append-system-prompt-file'\n` +
          `  exit 0\nfi\n` +
          `cat > "${packFile}"\n` +
          `printf '%s\\n' '{"result":"{\\"project\\":\\"Collie\\",\\"title\\":\\"Per-task workspaces\\"}"}'`,
      );
      yield* rig.addWorkspace("w9", "Collie | Steering ledger", rig.projectDir);

      yield* startedRun(rig.pluginEnv(), "give each task its own workspace");

      expect(yield* createdLabels()).toEqual(["Collie | Per-task workspaces"]);
      // The task and the person's own live names both reached the namer, as data.
      const pack = yield* fs.readFileString(packFile);
      expect(pack).toContain("give each task its own workspace");
      expect(pack).toContain("Collie | Steering ledger");
    }),
  ));
