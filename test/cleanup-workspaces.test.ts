// A Finished Task's workspace closes an hour on, unless it is in focus or holds a pane
// Collie did not open; nothing else of a Task's is closed (ADR-0045 D3).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Clock, Effect, FileSystem } from "effect";
import type { TaskView } from "../src/board-model";
import { sweep, taskWorkspacesSweeper } from "../src/cleanup";
import { Herdr } from "../src/herdr";
import type { TaskRecord } from "../src/task";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";
import { runFacts } from "./support/records";
import { task as view } from "./support/task";

let rig: Rig;
beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      yield* rig.startSocket();
    }),
  ),
);
afterEach(() => runEffect(rig.close()));

const HOUR_MS = 60 * 60_000;

const record: TaskRecord = {
  id: "task-1",
  workspace: "wT",
  label: "Project | Picker",
  cwd: "/project",
  root_pane: "wT-p1",
  created_at: "2026-10-07T00:00:00.000Z",
};
const finished = view({ id: "task-1", state: "done", landed: true });

/** The Task's workspace, its root shell and one agent its Run launched. */
const arranged = (opts: { focused?: boolean } = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* rig.addWorkspace("wT", record.label, "/project", opts.focused ?? false);
    yield* rig.addPane("wT-p1", "wT-t1", "/project", null, "wT");
    yield* rig.addPane("wT-p2", "wT-t1", "/project", "impl", "wT");
    yield* fs.makeDirectory(`${rig.stateDir}/agents/r1`, { recursive: true });
    yield* fs.writeFileString(
      `${rig.stateDir}/agents/r1/build.launch.json`,
      '{"terminalId":"t-wT-p2"}',
    );
  });

const sweeper = (seen: Map<string, number>, views: ReadonlyArray<TaskView> = [finished]) =>
  taskWorkspacesSweeper({
    stateDir: rig.stateDir,
    sessions: [{ herd: null, herdr: new Herdr(rig.pluginEnv()) }],
    tasks: [record],
    views,
    runs: [runFacts({ id: "r1", task: "task-1", state: "succeeded" })],
    seen,
  });

const closes = Effect.map(
  Effect.suspend(() => rig.cmds()),
  (cmds) => cmds.filter((cmd) => cmd === "workspace.close").length,
);

/** Seen Finished `ms` ago. */
const seenAgo = (ms: number) =>
  Effect.map(Clock.currentTimeMillis, (now) => new Map([["task-1", now - ms]]));

test("a Finished Task's workspace is kept for its hour, then closed", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged();
      const seen = new Map<string, number>();

      const first = yield* sweep([sweeper(seen)], rig.stateDir, "host");
      expect(first.keep).toEqual([
        { kind: "workspace", target: "wT", reason: "Finished 0 min ago" },
      ]);
      expect(yield* closes).toBe(0);

      seen.set("task-1", seen.get("task-1")! - HOUR_MS);
      const later = yield* sweep([sweeper(seen)], rig.stateDir, "host");
      expect(later.remove.map((item) => item.target)).toEqual(["wT"]);
      const calls = yield* rig.calls();
      expect(calls.filter((call) => call.cmd === "workspace.close").map((c) => c.params)).toEqual([
        { workspace_id: "wT" },
      ]);
    }),
  ));

test("a workspace herdr has in focus is kept, and nothing is closed", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged({ focused: true });
      const judged = yield* sweep([sweeper(yield* seenAgo(2 * HOUR_MS))], rig.stateDir, "host");
      expect(judged.keep).toEqual([{ kind: "workspace", target: "wT", reason: "in focus" }]);
      expect(yield* closes).toBe(0);
    }),
  ));

test("a workspace holding a pane Collie did not open is kept, naming the pane", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged();
      yield* rig.addPane("wT-p9", "wT-t2", "/project", null, "wT");
      const judged = yield* sweep([sweeper(yield* seenAgo(2 * HOUR_MS))], rig.stateDir, "host");
      expect(judged.keep).toEqual([
        { kind: "workspace", target: "wT", reason: "holds a pane Collie did not open (wT-p9)" },
      ]);
      expect(yield* closes).toBe(0);
    }),
  ));

test("a Task waiting on you is never closed, and stops counting its hour", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged();
      const seen = yield* seenAgo(30 * 24 * HOUR_MS);
      const waiting = view({ id: "task-1", state: "done", landed: false });

      const judged = yield* sweep([sweeper(seen, [waiting])], rig.stateDir, "host");
      expect(judged.keep).toEqual([{ kind: "workspace", target: "wT", reason: "waiting on you" }]);
      expect(seen.has("task-1")).toBe(false);

      // Finished again: its hour starts over.
      const again = yield* sweep([sweeper(seen)], rig.stateDir, "host");
      expect(again.keep).toEqual([
        { kind: "workspace", target: "wT", reason: "Finished 0 min ago" },
      ]);
      expect(yield* closes).toBe(0);
    }),
  ));

test("the Home is never closed", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged();
      yield* new Herdr(rig.pluginEnv()).workspaceReportMetadata("wT", { collie_home: "x" }, 60_000);
      const judged = yield* sweep([sweeper(yield* seenAgo(2 * HOUR_MS))], rig.stateDir, "host");
      expect(judged.keep).toEqual([{ kind: "workspace", target: "wT", reason: "it is the Home" }]);
      expect(yield* closes).toBe(0);
    }),
  ));

test("a herdr that will not list workspaces keeps every Task's", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged();
      const herdr = new Herdr(rig.pluginEnv({ FAKE_HERDR_FAIL: '{"workspace list":"gone"}' }));
      const judged = yield* taskWorkspacesSweeper({
        stateDir: rig.stateDir,
        sessions: [{ herd: null, herdr }],
        tasks: [record],
        views: [finished],
        runs: [],
        seen: yield* seenAgo(2 * HOUR_MS),
      }).judge;
      expect(judged.keep).toEqual([
        { kind: "workspace", target: "wT", reason: "could not ask herdr what is open" },
      ]);
    }),
  ));
