// A Finished Task's workspace closes an hour on, unless it is in focus or holds a pane
// Collie did not open; nothing else of a Task's is closed (ADR-0045 D3).

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Clock, Effect, FileSystem, Schema } from "effect";
import type { TaskView } from "../src/board-model";
import { sweep, taskWorkspacesSweeper } from "../src/cleanup";
import { Herdr } from "../src/herdr";
import type { CompactionPorts, Stopped } from "../src/compaction";
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

const asJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** The agent's server, as its control record names it, stopped by a port that says `state`. */
const servedBy = (state: Stopped["state"]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(
      `${rig.stateDir}/agents/r1/build.launch.json`,
      asJson({
        agent: "impl",
        output: "out.json",
        reused: false,
        runId: "r1",
        operation: "build",
        role: "implementer",
        workflow: "implement",
        harness: "served",
        terminalId: "t-wT-p2",
      }),
    );
    const dir = `${rig.stateDir}/compaction/impl`;
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(
      `${dir}/control.json`,
      asJson({
        agent: "impl",
        harness: "served",
        cwd: "/project",
        dir,
        endpoint: "ws://127.0.0.1:1",
        pid: process.pid,
        command: "bun",
        started: null,
        attempt: null,
      }),
    );
    const stops: string[] = [];
    const ports: CompactionPorts = {
      served: {
        gate: () => Effect.void,
        install: () => Effect.succeed({ args: [] }),
        request: () => Effect.die("unused"),
        poll: () => Effect.die("unused"),
        usage: () => Effect.die("unused"),
        stop: (target) =>
          Effect.sync(() => {
            stops.push(target.agent);
            return {
              state,
              turns: [{ thread: "th-1", turn: "tu-1", transcript: null }],
              reason: state === "quiet" ? null : "turn tu-1 still running after 30s",
              signalled: [],
              left: [],
              noted: [],
            } satisfies Stopped;
          }),
      },
    };
    return { stops, ports };
  });

test("a Finished Task's workspace closes only once its agents are stopped where their work runs", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged();
      const { stops, ports } = yield* servedBy("quiet");
      const swept = taskWorkspacesSweeper({
        stateDir: rig.stateDir,
        sessions: [{ herd: null, herdr: new Herdr(rig.pluginEnv()) }],
        tasks: [record],
        views: [finished],
        runs: [runFacts({ id: "r1", task: "task-1", state: "succeeded" })],
        seen: yield* seenAgo(2 * HOUR_MS),
        ports,
      });
      const judged = yield* sweep([swept], rig.stateDir, "host");
      expect(stops).toEqual(["impl"]);
      expect(judged.remove.map((item) => item.target)).toEqual(["wT"]);
      expect(yield* closes).toBe(1);
    }),
  ));

test("a Finished Task's workspace whose agent's turn has not stopped is kept, with the reason", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged();
      const { stops, ports } = yield* servedBy("acknowledged");
      const swept = taskWorkspacesSweeper({
        stateDir: rig.stateDir,
        sessions: [{ herd: null, herdr: new Herdr(rig.pluginEnv()) }],
        tasks: [record],
        views: [finished],
        runs: [runFacts({ id: "r1", task: "task-1", state: "succeeded" })],
        seen: yield* seenAgo(2 * HOUR_MS),
        ports,
      });
      const judged = yield* sweep([swept], rig.stateDir, "host");
      expect(judged.remove).toEqual([]);
      expect(judged.keep.map((one) => one.reason).join("\n")).toContain(
        "its Codex turn has not stopped: impl is not stopped: acknowledged",
      );
      expect(yield* closes).toBe(0);
      // The listing says the same, now that the stop is on its record.
      expect((yield* swept.judge).keep.map((one) => one.reason).join("\n")).toContain(
        "thread th-1 turn tu-1",
      );
      // A later sweep stops it again rather than repeating the old reason.
      yield* sweep([swept], rig.stateDir, "host");
      expect(stops).toEqual(["impl", "impl"]);
      expect(yield* closes).toBe(0);
    }),
  ));

test("a Finished Task's workspace whose root pane another named agent has taken is kept", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged();
      yield* rig.addAgent("other", "wT-p1", "t-other");
      const judged = yield* sweep([sweeper(yield* seenAgo(2 * HOUR_MS))], rig.stateDir, "host");
      expect(judged.keep).toEqual([
        { kind: "workspace", target: "wT", reason: "other runs in it, and is not this Task's" },
      ]);
      expect(yield* closes).toBe(0);
    }),
  ));

test("an agent moved to another workspace is logged ended only once its pane there closes", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const fail of [true, false]) {
        yield* rig.addWorkspace("wT", record.label, "/project");
        yield* rig.addPane("wT-p1", "wT-t1", "/project", null, "wT");
        yield* rig.addWorkspace("wX", "Elsewhere", "/project");
        yield* rig.addPane("wX-p5", "wX-t1", "/project", "claude", "wX");
        yield* rig.addAgent("impl", "wX-p5", "t-wX-p5");
        yield* fs.makeDirectory(`${rig.stateDir}/agents/r1`, { recursive: true });
        yield* fs.writeFileString(
          `${rig.stateDir}/agents/r1/build.launch.json`,
          asJson({
            agent: "impl",
            output: "out.json",
            reused: false,
            runId: "r1",
            operation: "build",
            role: "implementer",
            workflow: "implement",
            harness: "claude",
            terminalId: "t-wX-p5",
          }),
        );
        const herdr = new Herdr(
          rig.pluginEnv(
            fail
              ? { FAKE_HERDR_FAIL: `{"pane close":"pane is busy","pane.close":"pane is busy"}` }
              : {},
          ),
        );
        const judged = yield* sweep(
          [
            taskWorkspacesSweeper({
              stateDir: rig.stateDir,
              sessions: [{ herd: null, herdr }],
              tasks: [record],
              views: [finished],
              runs: [runFacts({ id: "r1", task: "task-1", state: "succeeded" })],
              seen: yield* seenAgo(2 * HOUR_MS),
            }),
          ],
          rig.stateDir,
          "host",
        );
        expect(judged.remove.map((item) => item.target)).toEqual(["wT"]);
        const log = yield* fs
          .readFileString(`${rig.stateDir}/agents/r1/agents.log`)
          .pipe(Effect.orElseSucceed(() => ""));
        expect(log.includes("impl ended: its Task's workspace closed")).toBe(!fail);
      }
    }),
  ));
