// A finished Run's agent closes once herdr has reported it idle for `idle_close_ms` since
// the Run finished, unless something still needs it
// (ADR-draft-a-finished-runs-idle-agent-is-closed).

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Option from "effect/Option";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Clock, DateTime, Effect, FileSystem, Schema, flow, Result } from "effect";
import {
  forgetGone,
  idleAgentsSweeper,
  JOURNAL,
  noteIdle,
  sweep,
  type FinishedSince,
  type IdleSince,
} from "../src/cleanup";
import { appendCard } from "../src/cards";
import { Launched } from "../src/launches";
import { Herdr, type AgentInfo } from "../src/herdr";
import { agentsIn } from "../src/herds";
import type { CompactionPorts, Stopped } from "../src/compaction";
import { appendLine, ledgerPath } from "../src/steering";
import type { RunFacts } from "../src/runs";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";
import { madeRun, runFacts } from "./support/records";

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

const MIN_MS = 60_000;
const HOUR_MS = 60 * MIN_MS;
const TERMINAL = "t-impl";
const TARGET = "impl of r1";
const asJson = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)), Result.getOrThrow);

/** The Task's workspace with its shell, and the agent `runId` launched in it. */
const arranged = (opts: { focused?: boolean; harness?: string; runId?: string } = {}) =>
  Effect.gen(function* () {
    yield* rig.addWorkspace("wT", "Project | Picker", "/project", opts.focused ?? false);
    yield* rig.addPane("wT-p1", "wT-t1", "/project", null, "wT");
    yield* rig.addPane("wT-p2", "wT-t1", "/project", "impl", "wT");
    yield* rig.addAgent("impl", "wT-p2", TERMINAL);
    yield* launched("impl", opts.runId ?? "r1", TERMINAL, opts.harness);
  });

const launched = (
  agent: string,
  runId: string,
  terminalId: string,
  harness = "claude",
  agentSession?: { kind: string; value: string },
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${rig.stateDir}/agents/${runId}`, { recursive: true });
    yield* fs.writeFileString(
      `${rig.stateDir}/agents/${runId}/build.launch.json`,
      asJson({
        agent,
        output: "out.json",
        reused: false,
        runId,
        operation: "build",
        role: "implementer",
        workflow: "implement",
        harness,
        terminalId,
        agentSession,
      }),
    );
  });

const ago = (ms: number) => Effect.map(Clock.currentTimeMillis, (now) => now - ms);
const isoAgo = (ms: number) =>
  Effect.map(ago(ms), (at) => DateTime.formatIso(DateTime.makeUnsafe(at)));

const finished = (ms: number, over: Partial<RunFacts> = {}) =>
  Effect.map(isoAgo(ms), (at) => runFacts({ id: "r1", state: "succeeded", finished: at, ...over }));

const idleFor = (ms: number) => Effect.map(ago(ms), (at): IdleSince => new Map([[TERMINAL, at]]));

const sweeper = (
  runs: ReadonlyArray<RunFacts>,
  idle: IdleSince,
  opts: {
    status?: string;
    idleCloseMs?: number;
    ports?: CompactionPorts;
    finishedSince?: FinishedSince;
  } = {},
) =>
  idleAgentsSweeper({
    stateDir: rig.stateDir,
    sessions: [
      {
        herd: null,
        herdr: new Herdr(
          rig.pluginEnv(opts.status === undefined ? {} : { FAKE_HERDR_AGENT_STATUS: opts.status }),
        ),
      },
    ],
    runs,
    idle,
    finishedSince: opts.finishedSince ?? new Map(),
    idleCloseMs: opts.idleCloseMs ?? HOUR_MS,
    ports: opts.ports,
  });

const closes = Effect.map(
  Effect.suspend(() => rig.cmds()),
  (cmds) => Arr.filter(cmds, (cmd) => cmd === "pane close").length,
);

const runLog = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .readFileString(`${rig.stateDir}/agents/r1/agents.log`)
    .pipe(Effect.orElseSucceed(() => ""));
});

const kept = (reason: string) => [{ kind: "idle-agent", target: TARGET, reason }];

test("a finished Run's agent idle for an hour is closed, and the Run's log says so", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged();
      const judged = yield* sweep(
        [sweeper([yield* finished(2 * HOUR_MS)], yield* idleFor(61 * MIN_MS))],
        rig.stateDir,
        "host",
      );
      expect(judged.remove).toEqual([
        { kind: "idle-agent", target: TARGET, bytes: 0, reason: "idle for 61 min" },
      ]);
      const calls = yield* rig.calls();
      expect(
        Arr.map(
          Arr.filter(calls, (call) => call.cmd === "pane close"),
          (c) => c.argv?.at(2),
        ),
      ).toEqual(["wT-p2"]);
      expect(yield* runLog).toContain(
        "impl ended: idle for 61 min; its harness reported no transcript",
      );
      const fs = yield* FileSystem.FileSystem;
      const journal = yield* fs.readFileString(`${rig.stateDir}/${JOURNAL}`);
      expect(journal).toContain('"by":"host"');
      expect(journal).toContain('"kind":"idle-agent"');
      expect(journal).toContain(`"target":"${TARGET}"`);
    }),
  ));

test("a closed agent's workspace is kept with a shell where its pane was the last", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.addWorkspace("wA", "Project | Alone", "/project");
      yield* rig.addPane("wA-p1", "wA-t1", "/project", "impl", "wA");
      yield* rig.addAgent("impl", "wA-p1", TERMINAL);
      yield* launched("impl", "r1", TERMINAL);
      yield* sweep(
        [sweeper([yield* finished(2 * HOUR_MS)], yield* idleFor(2 * HOUR_MS))],
        rig.stateDir,
        "host",
      );
      const cmds = yield* rig.cmds();
      expect(Arr.filter(cmds, (cmd) => cmd === "pane close")).toHaveLength(1);
      expect(Arr.some(cmds, (cmd) => pipe_(cmd, Str.startsWith("tab")))).toBe(true);
      expect(
        Option.getOrElse(
          Arr.findFirstIndex(cmds, (cmd) => pipe_(cmd, Str.startsWith("tab"))),
          () => -1,
        ),
      ).toBeLessThan(cmds.indexOf("pane close"));
    }),
  ));

test("the Run's log names the transcript the harness reported into its control record", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged();
      const fs = yield* FileSystem.FileSystem;
      const dir = `${rig.stateDir}/compaction/impl`;
      yield* fs.makeDirectory(dir, { recursive: true });
      const at = yield* Clock.currentTimeMillis;
      yield* fs.writeFileString(
        `${dir}/events.jsonl`,
        Arr.join(
          [
            asJson({ at, session: "s1", kind: "session" }),
            asJson({
              at,
              session: "s1",
              kind: "usage",
              tokens: 10,
              transcript: "/home/t/s1.jsonl",
            }),
            "",
          ],
          "\n",
        ),
      );
      yield* sweep(
        [sweeper([yield* finished(2 * HOUR_MS)], yield* idleFor(90 * MIN_MS))],
        rig.stateDir,
        "host",
      );
      expect(yield* runLog).toContain(
        "impl ended: idle for 90 min; its transcript is at /home/t/s1.jsonl",
      );
    }),
  ));

test("a builder idle while its Run's review and gate ran has the whole hour after the finish", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged();
      const just = yield* sweep(
        [sweeper([yield* finished(0)], yield* idleFor(75 * MIN_MS))],
        rig.stateDir,
        "host",
      );
      expect(just.keep).toEqual(kept("idle 0 of 60 min"));

      // 37 minutes on it is still there for a steer.
      const later = yield* sweep(
        [sweeper([yield* finished(37 * MIN_MS)], yield* idleFor(112 * MIN_MS))],
        rig.stateDir,
        "host",
      );
      expect(later.keep).toEqual(kept("idle 37 of 60 min"));
      expect(yield* closes).toBe(0);

      const hour = yield* sweep(
        [sweeper([yield* finished(61 * MIN_MS)], yield* idleFor(136 * MIN_MS))],
        rig.stateDir,
        "host",
      );
      expect(Arr.map(hour.remove, (item) => item.reason)).toEqual(["idle for 61 min"]);
      expect(yield* runLog).toContain("impl ended: idle for 61 min;");
    }),
  ));

test("a Run the host reads with no finish time counts from when the sweep first saw it finished", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged();
      const run = runFacts({ id: "r1", state: "succeeded", finished: null });
      const finishedSince: FinishedSince = new Map();
      const just = yield* sweep(
        [sweeper([run], yield* idleFor(75 * MIN_MS), { finishedSince })],
        rig.stateDir,
        "host",
      );
      expect(just.keep).toEqual(kept("idle 0 of 60 min"));
      expect(yield* closes).toBe(0);

      finishedSince.set("r1", yield* ago(61 * MIN_MS));
      const hour = yield* sweep(
        [sweeper([run], yield* idleFor(136 * MIN_MS), { finishedSince })],
        rig.stateDir,
        "host",
      );
      expect(Arr.map(hour.remove, (item) => item.reason)).toEqual(["idle for 61 min"]);
    }),
  ));

test("a stopped Run that resumes counts its next finish from when the sweep sees that one", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged();
      const finishedSince: FinishedSince = new Map([["r1", yield* ago(80 * MIN_MS)]]);
      const idle = yield* idleFor(80 * MIN_MS);
      const as = (state: RunFacts["state"]) =>
        sweeper([runFacts({ id: "r1", state, finished: null })], idle, { finishedSince });
      yield* sweep([as("running")], rig.stateDir, "host");
      const again = yield* sweep([as("succeeded")], rig.stateDir, "host");
      expect(again.keep).toEqual(kept("idle 0 of 60 min"));
      expect(yield* closes).toBe(0);
    }),
  ));

test("a Run that resumed and finished again between sweeps counts from its final card", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged();
      const run = yield* madeRun(rig.stateDir, { state: "succeeded", finished: null });
      yield* appendCard(run.dir, {
        id: "final",
        run: "r1",
        kind: "final",
        at: yield* isoAgo(7 * MIN_MS),
        step: "finish",
        iteration: 1,
        intent_version: 1,
        revision: { branch: "main", head_sha: "abc1234def", fingerprint: "f1", dirty: false },
        changes: { files: [], commits: [] },
        requested: { goal: null, constraints: [] },
        readiness: "claimed",
        verifications: [],
        claims: [],
        missing: [],
        inspect: [],
        links: {},
        drift: [],
        deliveries: [],
        narrative: null,
        aligned: "unverified",
        cross_run: "none",
        significance: "routine",
      });
      const finishedSince: FinishedSince = new Map([["r1", yield* ago(80 * MIN_MS)]]);
      const judged = yield* sweep(
        [sweeper([run], yield* idleFor(80 * MIN_MS), { finishedSince })],
        rig.stateDir,
        "host",
      );
      expect(judged.keep).toEqual(kept("idle 7 of 60 min"));
    }),
  ));

test("a Run stopped again between sweeps counts from its newest stop", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged();
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${rig.stateDir}/stop.r1`, "");
      const run = runFacts({ id: "r1", state: "stopped", finished: null });
      const finishedSince: FinishedSince = new Map([["r1", yield* ago(80 * MIN_MS)]]);
      const judged = yield* sweep(
        [sweeper([run], yield* idleFor(80 * MIN_MS), { finishedSince })],
        rig.stateDir,
        "host",
      );
      expect(judged.keep).toEqual(kept("idle 0 of 60 min"));
    }),
  ));

test("a turn clears the idle time, so a Reopened Run's agent has its hour again", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged();
      const idle = yield* idleFor(2 * HOUR_MS);
      const run = yield* finished(3 * HOUR_MS);
      const working = yield* sweep(
        [sweeper([run], idle, { status: "working" })],
        rig.stateDir,
        "host",
      );
      expect(working.keep).toEqual(kept("working"));
      expect(idle.has(TERMINAL)).toBe(false);

      const again = yield* sweep([sweeper([run], idle)], rig.stateDir, "host");
      expect(again.keep).toEqual(kept("idle 0 of 60 min"));
      expect(yield* closes).toBe(0);
    }),
  ));

test("blocked is not idle", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged();
      const idle = yield* idleFor(2 * HOUR_MS);
      const judged = yield* sweep(
        [sweeper([yield* finished(3 * HOUR_MS)], idle, { status: "blocked" })],
        rig.stateDir,
        "host",
      );
      expect(judged.keep).toEqual(kept("blocked"));
      expect(idle.has(TERMINAL)).toBe(false);
      expect(yield* closes).toBe(0);
    }),
  ));

test("a Delivery queued to it keeps it", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged();
      const at = yield* isoAgo(0);
      yield* appendLine(yield* ledgerPath(rig.stateDir, TERMINAL), {
        id: "d1",
        at,
        run: "r1",
        incarnation: TERMINAL,
        agent: "impl",
        causal_key: "k1",
        request_id: "q1",
        cause: { kind: "steer", ref: "s1" },
        mode: "boundary",
        text_hash: "h",
        intent_version: 1,
        attempt: 1,
        state: "deferred",
      });
      const judged = yield* sweep(
        [sweeper([yield* finished(3 * HOUR_MS)], yield* idleFor(2 * HOUR_MS))],
        rig.stateDir,
        "host",
      );
      expect(judged.keep).toEqual(kept("a Delivery to it is queued"));
      expect(yield* closes).toBe(0);
    }),
  ));

test("a question it asked that is open on its Run keeps it", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged();
      const run = yield* finished(3 * HOUR_MS, {
        asking: [{ name: "ask-build-1", prompt: "Which?", options: [] }],
      });
      const judged = yield* sweep(
        [sweeper([run], yield* idleFor(2 * HOUR_MS))],
        rig.stateDir,
        "host",
      );
      expect(judged.keep).toEqual(kept("a question it asked is open"));
      expect(yield* closes).toBe(0);
    }),
  ));

test("an agent whose pane is in focus is kept", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged({ focused: true });
      const judged = yield* sweep(
        [sweeper([yield* finished(3 * HOUR_MS)], yield* idleFor(2 * HOUR_MS))],
        rig.stateDir,
        "host",
      );
      expect(judged.keep).toEqual(kept("in focus"));
      expect(yield* closes).toBe(0);
    }),
  ));

test("an agent typed into since it went idle is kept; one typed into before is not", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged();
      const ledger = yield* ledgerPath(rig.stateDir, TERMINAL);
      const override = (at: string) =>
        appendLine(ledger, { kind: "manual_override", at, incarnation: TERMINAL, by: "mk" });
      const run = yield* finished(3 * HOUR_MS);

      yield* override(yield* isoAgo(3 * HOUR_MS));
      const before = yield* sweeper([run], yield* idleFor(2 * HOUR_MS)).judge;
      expect(Arr.map(before.remove, (item) => item.target)).toEqual([TARGET]);

      yield* override(yield* isoAgo(MIN_MS));
      const since = yield* sweep(
        [sweeper([run], yield* idleFor(2 * HOUR_MS))],
        rig.stateDir,
        "host",
      );
      expect(since.keep).toEqual(kept("typed into since it went idle"));
      expect(yield* closes).toBe(0);
    }),
  ));

test("a live Run's agent is untouched, even where a finished Run's launch names it too", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged();
      yield* launched("impl", "r2", TERMINAL);
      const idle = yield* idleFor(30 * HOUR_MS);
      for (const state of ["running", "waiting"] as const) {
        const judged = yield* sweep(
          [
            sweeper(
              [yield* finished(3 * HOUR_MS), runFacts({ id: "r2", state, task: null })],
              idle,
            ),
          ],
          rig.stateDir,
          "host",
        );
        expect(judged).toEqual({ remove: [], keep: [], bytes: 0 });
      }
      expect(yield* closes).toBe(0);
    }),
  ));

test("a chat, or any agent no launch record names, is never judged", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged();
      yield* rig.addPane("wH-p1", "wH-t1", "/project", "collie-chat", null);
      yield* rig.addAgent("collie-chat", "wH-p1", "t-chat");
      const idle: IdleSince = new Map([
        [TERMINAL, yield* ago(0)],
        ["t-chat", yield* ago(30 * HOUR_MS)],
      ]);
      const judged = yield* sweep(
        [sweeper([yield* finished(3 * HOUR_MS)], idle)],
        rig.stateDir,
        "host",
      );
      expect(judged.remove).toEqual([]);
      expect(judged.keep).toEqual(kept("idle 0 of 60 min"));
    }),
  ));

test("an agent on another terminal than its launch recorded is not this Run's to judge", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged();
      yield* launched("impl", "r1", "t-older");
      const judged = yield* sweep(
        [
          sweeper(
            [yield* finished(3 * HOUR_MS)],
            new Map([
              ["t-older", 0],
              [TERMINAL, 0],
            ]),
          ),
        ],
        rig.stateDir,
        "host",
      );
      expect(judged).toEqual({ remove: [], keep: [], bytes: 0 });
    }),
  ));

test("with idle_close_ms at 0 nothing is closed or listed", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged();
      const judged = yield* sweep(
        [
          sweeper([yield* finished(30 * HOUR_MS)], yield* idleFor(30 * HOUR_MS), {
            idleCloseMs: 0,
          }),
        ],
        rig.stateDir,
        "host",
      );
      expect(judged).toEqual({ remove: [], keep: [], bytes: 0 });
      expect(yield* closes).toBe(0);
    }),
  ));

test("a host that starts with the agent long idle counts from its first read: a restart only delays", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged();
      const idle: IdleSince = new Map();
      const run = yield* finished(30 * HOUR_MS);
      const first = yield* sweep([sweeper([run], idle)], rig.stateDir, "host");
      expect(first.keep).toEqual(kept("idle 0 of 60 min"));
      expect(idle.get(TERMINAL)).toBeGreaterThan(yield* ago(MIN_MS));
      expect(yield* closes).toBe(0);
    }),
  ));

test("each close is judged again when it is made: an agent working since the listing is kept", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged();
      const idle = yield* idleFor(2 * HOUR_MS);
      const run = yield* finished(3 * HOUR_MS);
      const listing = yield* sweeper([run], idle).judge;
      expect(Arr.map(listing.remove, (item) => item.target)).toEqual([TARGET]);

      const outcome = yield* sweeper([run], idle, { status: "working" }).remove(listing.remove[0]!);
      expect(outcome).toEqual({ kept: "working" });
      expect(yield* closes).toBe(0);
    }),
  ));

test("an agent whose turn does not stop is kept with the reason, and tried again next sweep", () =>
  runEffect(
    Effect.gen(function* () {
      yield* arranged({ harness: "served" });
      const fs = yield* FileSystem.FileSystem;
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
          gate: Effect.void,
          install: () => Effect.succeed({ args: [] }),
          request: () => Effect.die("unused"),
          poll: () => Effect.die("unused"),
          usage: () => Effect.die("unused"),
          stop: (target) =>
            Effect.sync(() => {
              stops.push(target.agent);
              return {
                state: "acknowledged",
                turns: [{ thread: "th-1", turn: "tu-1", transcript: null }],
                reason: "turn tu-1 still running after 30s",
                signalled: [],
                left: [],
                noted: [],
              } satisfies Stopped;
            }),
        },
      };
      const idle = yield* idleFor(2 * HOUR_MS);
      const run = yield* finished(3 * HOUR_MS);
      for (const _ of [1, 2]) {
        const judged = yield* sweep([sweeper([run], idle, { ports })], rig.stateDir, "host");
        expect(judged.remove).toEqual([]);
        expect(
          Arr.join(
            Arr.map(judged.keep, (one) => one.reason),
            "\n",
          ),
        ).toContain("impl is not stopped");
      }
      expect(stops).toEqual(["impl", "impl"]);
      expect(yield* closes).toBe(0);
    }),
  ));

test("the host keeps when it first saw each agent idle or done, and anything else clears it", () => {
  const agent = (name: string, status: AgentInfo["status"]): AgentInfo => ({
    name,
    paneId: `p-${name}`,
    workspaceId: null,
    status,
    title: null,
    terminalId: `t-${name}`,
    agentSession: null,
  });
  const idle: IdleSince = new Map();
  noteIdle(idle, [agent("a", "idle"), agent("b", "done"), agent("c", "working")], 100);
  expect([...idle]).toEqual([
    ["t-a", 100],
    ["t-b", 100],
  ]);
  noteIdle(idle, [agent("a", "done"), agent("b", "idle"), agent("c", "idle")], 200);
  expect([...idle]).toEqual([
    ["t-a", 100],
    ["t-b", 100],
    ["t-c", 200],
  ]);
  for (const status of ["working", "blocked", "unknown"] as const) {
    noteIdle(idle, [agent("a", status), agent("b", "idle"), agent("c", "idle")], 300);
    expect(idle.has("t-a")).toBe(false);
    idle.set("t-a", 100);
  }
  forgetGone(idle, new Set(["t-b"]));
  expect([...idle]).toEqual([["t-b", 100]]);
});

const SESSION = { kind: "pi", value: "/home/mk/.pi/sessions/impl.jsonl" };
const RESTORED = "t-restored";

/** The Task's workspace after a herdr restart: its shell, and a pane resuming `session` on a new terminal. */
const restored = (opts: { session: typeof SESSION | null; name?: string }) =>
  Effect.gen(function* () {
    yield* rig.addWorkspace("wT", "Project | Picker", "/project");
    yield* rig.addPane("wT-p1", "wT-t1", "/project", null, "wT");
    yield* rig.addRestored({
      paneId: "wT-p9",
      workspaceId: "wT",
      terminalId: RESTORED,
      session: opts.session,
      agent: opts.name,
    });
    yield* launched("impl", "r1", TERMINAL, "pi", SESSION);
  });

const restoredIdleFor = (ms: number) =>
  Effect.map(ago(ms), (at): IdleSince => new Map([[RESTORED, at]]));

test("a pane herdr restored without its name is the agent whose session it resumes, and closes idle", () =>
  runEffect(
    Effect.gen(function* () {
      yield* restored({ session: SESSION });
      const judged = yield* sweep(
        [sweeper([yield* finished(2 * HOUR_MS)], yield* restoredIdleFor(61 * MIN_MS))],
        rig.stateDir,
        "host",
      );
      expect(judged.remove).toEqual([
        { kind: "idle-agent", target: TARGET, bytes: 0, reason: "idle for 61 min" },
      ]);
      const calls = yield* rig.calls();
      expect(
        Arr.map(
          Arr.filter(calls, (call) => call.cmd === "pane close"),
          (c) => c.argv?.at(2),
        ),
      ).toEqual(["wT-p9"]);
      expect(yield* runLog).toContain(
        "impl ended: idle for 61 min; its harness reported no transcript",
      );
    }),
  ));

test("a restored pane that kept its name, on a new terminal, closes as the agent its session proves", () =>
  runEffect(
    Effect.gen(function* () {
      yield* restored({ session: SESSION, name: "impl" });
      const judged = yield* sweep(
        [sweeper([yield* finished(2 * HOUR_MS)], yield* restoredIdleFor(61 * MIN_MS))],
        rig.stateDir,
        "host",
      );
      expect(Arr.map(judged.remove, (item) => item.target)).toEqual([TARGET]);
      expect(yield* closes).toBe(1);
    }),
  ));

test("a restored pane on another session, or on none, is neither listed nor closed", () =>
  runEffect(
    Effect.gen(function* () {
      for (const session of [{ kind: "pi", value: "/elsewhere.jsonl" }, null]) {
        yield* rig.close();
        rig = yield* Rig.make();
        yield* rig.startSocket();
        yield* restored({ session, name: session === null ? undefined : "impl" });
        const judged = yield* sweep(
          [sweeper([yield* finished(2 * HOUR_MS)], yield* restoredIdleFor(2 * HOUR_MS))],
          rig.stateDir,
          "host",
        );
        expect(judged).toEqual({ remove: [], keep: [], bytes: 0 });
        expect(yield* closes).toBe(0);
      }
    }),
  ));

test("a restored pane is proved after the registry dropped its agent and the host restarted", () =>
  runEffect(
    Effect.gen(function* () {
      yield* restored({ session: SESSION });
      const fs = yield* FileSystem.FileSystem;
      const registry = `${rig.stateDir}/agents/wT-dropped.json`;
      yield* fs.writeFileString(registry, "[]");
      const idle: IdleSince = new Map();
      const first = yield* sweep(
        [sweeper([yield* finished(30 * HOUR_MS)], idle)],
        rig.stateDir,
        "host",
      );
      expect(first.keep).toEqual(kept("idle 0 of 60 min"));
      expect(idle.has(RESTORED)).toBe(true);

      idle.set(RESTORED, yield* ago(61 * MIN_MS));
      const later = yield* sweep(
        [sweeper([yield* finished(30 * HOUR_MS)], idle)],
        rig.stateDir,
        "host",
      );
      expect(Arr.map(later.remove, (item) => item.target)).toEqual([TARGET]);
    }),
  ));

test("a restored agent idle since before its Run finished counts from the finish", () =>
  runEffect(
    Effect.gen(function* () {
      yield* restored({ session: SESSION });
      const judged = yield* sweep(
        [sweeper([yield* finished(30 * MIN_MS)], yield* restoredIdleFor(2 * HOUR_MS))],
        rig.stateDir,
        "host",
      );
      expect(judged.keep).toEqual(kept("idle 30 of 60 min"));
    }),
  ));

test("the sweep records the session of an agent still on its launch's terminal", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.addWorkspace("wT", "Project | Picker", "/project");
      yield* rig.addRestored({
        paneId: "wT-p2",
        workspaceId: "wT",
        terminalId: TERMINAL,
        session: SESSION,
        agent: "impl",
      });
      yield* launched("impl", "r1", TERMINAL, "pi");
      yield* sweep([sweeper([yield* finished(0)], new Map())], rig.stateDir, "host");
      const fs = yield* FileSystem.FileSystem;
      const record = yield* fs.readFileString(`${rig.stateDir}/agents/r1/build.launch.json`);
      expect(
        (yield* Schema.decodeEffect(Schema.fromJsonString(Launched))(record).pipe(Effect.orDie))
          .agentSession,
      ).toEqual(SESSION);
    }),
  ));

test("a live Run's agent has the session herdr reports recorded, and is not judged", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.addWorkspace("wT", "Project | Picker", "/project");
      yield* rig.addRestored({
        paneId: "wT-p2",
        workspaceId: "wT",
        terminalId: TERMINAL,
        session: SESSION,
        agent: "impl",
      });
      yield* launched("impl", "r1", TERMINAL, "pi");
      const judged = yield* sweep(
        [sweeper([runFacts({ id: "r1", state: "running" })], yield* idleFor(2 * HOUR_MS))],
        rig.stateDir,
        "host",
      );
      expect([judged.remove, judged.keep]).toEqual([[], []]);
      const fs = yield* FileSystem.FileSystem;
      const record = yield* fs.readFileString(`${rig.stateDir}/agents/r1/build.launch.json`);
      expect(
        (yield* Schema.decodeEffect(Schema.fromJsonString(Launched))(record).pipe(Effect.orDie))
          .agentSession,
      ).toEqual(SESSION);
    }),
  ));

test("with idle_close_ms at 0 the sweep still records the session herdr reports", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.addWorkspace("wT", "Project | Picker", "/project");
      yield* rig.addRestored({
        paneId: "wT-p2",
        workspaceId: "wT",
        terminalId: TERMINAL,
        session: SESSION,
        agent: "impl",
      });
      yield* launched("impl", "r1", TERMINAL, "pi");
      yield* sweep(
        [sweeper([runFacts({ id: "r1", state: "running" })], new Map(), { idleCloseMs: 0 })],
        rig.stateDir,
        "host",
      );
      const fs = yield* FileSystem.FileSystem;
      const record = yield* fs.readFileString(`${rig.stateDir}/agents/r1/build.launch.json`);
      expect(
        (yield* Schema.decodeEffect(Schema.fromJsonString(Launched))(record).pipe(Effect.orDie))
          .agentSession,
      ).toEqual(SESSION);
    }),
  ));

test("a restored pane's turn between sweeps, as the host's board reads it, clears its idle time", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.addWorkspace("wT", "Project | Picker", "/project");
      yield* rig.addRestored({
        paneId: "wT-p9",
        workspaceId: "wT",
        terminalId: RESTORED,
        session: SESSION,
        status: "working",
      });
      const idle = yield* restoredIdleFor(61 * MIN_MS);
      const herds = [{ herd: null, herdr: new Herdr(rig.pluginEnv()) }];
      noteIdle(idle, (yield* agentsIn(herds)).restored, yield* Clock.currentTimeMillis);
      expect(idle.has(RESTORED)).toBe(false);
    }),
  ));
