// A Task and every one of its Runs are forgotten together 30 days after its last Run ended,
// and only once nothing could still need them (ADR-0045 D5).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Clock, Effect, FileSystem } from "effect";
import type { TaskView } from "../src/board-model";
import { retentionSweeper, sweep } from "../src/cleanup";
import { Herdr } from "../src/herdr";
import type { RunFacts } from "../src/runs";
import { readTask, writeTask, type TaskRecord } from "../src/task";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";
import { runFacts } from "./support/records";
import { task as view } from "./support/task";

const DAY_MS = 24 * 60 * 60_000;

let rig: Rig;
beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
    }),
  ),
);
afterEach(() => runEffect(rig.close()));

const record: TaskRecord = {
  id: "task-1",
  workspace: "wGone",
  label: "Project | Picker",
  cwd: "/project",
  created_at: "2026-09-01T00:00:00.000Z",
};

/** The Task's one Run, with its files and markers, its view ended `days` ago. */
const arranged = (days: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* writeTask(rig.stateDir, record);
    for (const dir of ["runs", "agents", "evidence"]) {
      yield* fs.makeDirectory(`${rig.stateDir}/${dir}/r1`, { recursive: true });
      yield* fs.writeFileString(`${rig.stateDir}/${dir}/r1/x`, "x");
    }
    yield* fs.writeFileString(`${rig.stateDir}/stop.r1`, "");
    yield* fs.makeDirectory(`${rig.stateDir}/agents/abc`, { recursive: true });
    yield* fs.writeFileString(`${rig.stateDir}/agents/abc/deliveries.jsonl`, '{"run":"r1"}\n');
    const now = yield* Clock.currentTimeMillis;
    return view({ id: "task-1", state: "done", landed: true, ended: now - days * DAY_MS });
  });

const forgotten: string[][] = [];
const sweeper = (
  views: ReadonlyArray<TaskView>,
  runs: ReadonlyArray<RunFacts> = [runFacts({ id: "r1", task: "task-1", state: "succeeded" })],
) =>
  retentionSweeper({
    stateDir: rig.stateDir,
    sessions: [new Herdr(rig.pluginEnv())],
    tasks: [record],
    views,
    runs,
    retire: (ids) =>
      Effect.sync(() => {
        forgotten.push([...ids]);
        return ids;
      }),
  });

test("a Task whose last Run ended 31 days ago is forgotten: its rows, then its files", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      forgotten.length = 0;
      const ended = yield* arranged(31);

      const report = yield* sweep([sweeper([ended])], rig.stateDir, "host");
      expect(report.remove).toEqual([
        {
          kind: "task",
          target: "task-1",
          bytes: expect.any(Number),
          reason: "its last Run ended 31 days ago",
        },
      ]);
      expect(forgotten).toEqual([["r1"]]);
      for (const gone of ["runs/r1", "agents/r1", "evidence/r1", "stop.r1", "agents/abc"])
        expect([gone, yield* fs.exists(`${rig.stateDir}/${gone}`)]).toEqual([gone, false]);
      expect(yield* readTask(rig.stateDir, "task-1")).toBeNull();
    }),
  ));

test("a Task that ended 29 days ago is kept, saying when", () =>
  runEffect(
    Effect.gen(function* () {
      const ended = yield* arranged(29);
      const judged = yield* sweeper([ended]).judge;
      expect(judged.keep).toEqual([
        { kind: "task", target: "task-1", reason: "its last Run ended 29 day(s) ago" },
      ]);
    }),
  ));

test("a plan a kept Run's input points into is kept, at any age", () =>
  runEffect(
    Effect.gen(function* () {
      const ended = yield* arranged(400);
      const runs = [
        runFacts({ id: "r1", task: "task-1", state: "succeeded" }),
        runFacts({
          id: "r2",
          task: "task-2",
          settled: { inputs: { plan: `${rig.stateDir}/runs/r1/plan` } },
        }),
      ];
      const judged = yield* sweeper([ended], runs).judge;
      expect(judged.keep).toEqual([
        { kind: "task", target: "task-1", reason: "r2 still points into it" },
      ]);
    }),
  ));

test("a Task with a checkout of its own still on disk is kept", () =>
  runEffect(
    Effect.gen(function* () {
      const ended = yield* arranged(400);
      const runs = [
        runFacts({
          id: "r1",
          task: "task-1",
          state: "succeeded",
          worktree: {
            path: rig.projectDir,
            branch: "wt",
            created_by_collie: true,
            managed_by: "git",
            workspace_id: null,
            made_at: 1,
            root_tab_id: null,
            root_pane_id: null,
          },
        }),
      ];
      const judged = yield* sweeper([ended], runs).judge;
      expect(judged.keep).toEqual([
        {
          kind: "task",
          target: "task-1",
          reason: `a checkout it made is on disk (${rig.projectDir})`,
        },
      ]);
    }),
  ));

test("a Task one of whose agents herdr still has is kept", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const ended = yield* arranged(400);
      yield* rig.addPane("p7", "t7", "/project", "impl", "wOther");
      yield* fs.writeFileString(
        `${rig.stateDir}/agents/r1/build.launch.json`,
        '{"terminalId":"t-p7"}',
      );
      const judged = yield* sweeper([ended]).judge;
      expect(judged.keep).toEqual([
        { kind: "task", target: "task-1", reason: "an agent of it is alive" },
      ]);
    }),
  ));

test("a Task whose workspace is still open, or that is not Finished, is kept", () =>
  runEffect(
    Effect.gen(function* () {
      const ended = yield* arranged(400);
      yield* rig.addWorkspace("wGone", "Project | Picker", "/project");
      expect((yield* sweeper([ended]).judge).keep).toEqual([
        { kind: "task", target: "task-1", reason: "its workspace is open" },
      ]);
      const waiting = { ...ended, landed: false };
      expect((yield* sweeper([waiting]).judge).keep).toEqual([
        { kind: "task", target: "task-1", reason: "waiting on you" },
      ]);
    }),
  ));
