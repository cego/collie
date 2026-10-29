// A Run's stop of a Codex agent, and everything that would take over its work, at the
// Agents service. The agent's work runs in the App Server Collie started for it, so the
// server here is a real process — the stand-in in `support/codex-server.ts` — and what
// is asserted is what a human could see: whether its checkout stops changing, what the
// stop says, what it was sent, and whether anything started beside it.

import { afterEach, beforeEach, expect, test } from "bun:test";
import type { PlatformServices } from "../src/platform";
import { Duration, Effect, FileSystem, Path, Schema } from "effect";
import { TestClock } from "effect/testing";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { Rig } from "./support/recorder";
import { fastForward, runEffect as runLive } from "./support/effect";
import { Agents, agentWork, agentsLayer, type AgentHost } from "../src/agents";
import { asRun, enveloped } from "./support/enveloped";
import { PARKED, controlPath, foundationLayer, pollStatus } from "../src/engine";
import { compactionSweeper, sweep } from "../src/cleanup";
import { Herdr } from "../src/herdr";
import { recordClaudeEvent } from "../src/compactors";
import { installControls, withControlLock } from "../src/compaction";
import { processOf } from "../src/processes";
import { FakeHerdr } from "./support/recorder";
import { agentName } from "../src/naming";
import { COMPACTION_PORTS, codexPort } from "../src/compactors";
import type { StandIn } from "./support/codex-server";

const asJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

let rig: Rig;
let dir: string;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      const fs = yield* FileSystem.FileSystem;
      dir = `${rig.root}/host`;
      yield* fs.makeDirectory(dir, { recursive: true });
      yield* fs.makeDirectory(rig.projectDir, { recursive: true });
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      // Whatever a test left of the stand-in, so one failure does not outlive its test.
      for (const event of yield* events())
        for (const pid of [event.pid, event.child]) if (pid !== undefined) kill(pid);
      yield* rig.close();
    }),
  ),
);

const Verdict = Schema.Struct({
  verdict: Schema.Literals(["clean", "findings"]),
  note: Schema.String,
});
const work = enveloped({
  name: "agent-work",
  input: { skip: Schema.Boolean },
  success: Verdict,
});
const body = work.toLayer((payload) =>
  agentWork({
    operation: "build",
    role: "implementer",
    workflow: "agent-work",
    cwd: rig.projectDir,
    instructions: "Build it.",
    output: Verdict,
  }).pipe(asRun(payload)),
);

const runEffect = <A, E>(effect: Effect.Effect<A, E, PlatformServices>) =>
  runLive(fastForward(effect));

const SERVER = `${import.meta.dir}/support/codex-server.ts`;
const config = () => `${rig.root}/codex-server.json`;
const eventsFile = () => `${rig.root}/codex-server.events`;
const written = () => `${rig.projectDir}/written.txt`;
const THREAD = "01a134f2-e3e2-7242-9620-c2121348e1b8";
const TURN = "01a134f4-044f-7053-93f6-1db57d18653a";

/** The stand-in's behaviour for this test: one thread in the checkout, its turn writing. */
const serve = (over: Partial<StandIn> = {}) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.writeFileString(
        config(),
        asJson({
          events: eventsFile(),
          threads: [
            {
              id: THREAD,
              cwd: rig.projectDir,
              path: `${rig.root}/rollout-${THREAD}.jsonl`,
              turn: { id: TURN, writes: written() },
            },
          ],
          ...over,
        }),
      ),
    ),
    Effect.orDie,
  );

const hostOf = (over?: Partial<AgentHost>): AgentHost => ({
  dir,
  env: rig.pluginEnv(),
  herdr: new FakeHerdr(rig.pluginEnv()),
  harness: "codex",
  model: "default",
  permissions: "auto",
  compactAtTokens: 1000,
  pollMs: 20,
  collectMs: 30_000,
  stopMs: 250_000,
  ports: {
    codex: {
      ...codexPort(`bun ${SERVER} ${config()}`),
      gate: () => Effect.void,
    },
    claude: { ...COMPACTION_PORTS.claude!, gate: () => Effect.void },
  },
  ...over,
});

const session = <A, E>(
  run: Effect.Effect<
    A,
    E,
    WorkflowEngine.WorkflowEngine | Agents | FileSystem.FileSystem | Path.Path
  >,
  over?: Partial<AgentHost>,
) =>
  run.pipe(
    Effect.provide(body),
    Effect.provide(agentsLayer(hostOf(over))),
    Effect.provide(foundationLayer({ dir })),
    Effect.scoped,
    Effect.orDie,
  );

const agent = agentName("r1", "build", null, 1);
const started = () =>
  session(work.execute({ runId: "r1", input: { skip: false } }).pipe(Effect.result));
const halted = (over?: Partial<AgentHost>) =>
  session(Agents.pipe(Effect.flatMap((agents) => agents.halt("r1"))), over);

const Event = Schema.Struct({
  signal: Schema.optionalKey(Schema.String),
  method: Schema.optionalKey(Schema.String),
  params: Schema.optionalKey(Schema.Unknown),
  pid: Schema.optionalKey(Schema.Number),
  child: Schema.optionalKey(Schema.Number),
  turn: Schema.optionalKey(Schema.String),
  thread: Schema.optionalKey(Schema.String),
});
const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(Event));
const events = () =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(eventsFile())),
    Effect.orElseSucceed(() => ""),
    Effect.map((text) =>
      text
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => decodeEvent(line)),
    ),
  );
const signals = () =>
  events().pipe(Effect.map((all) => all.filter((one) => one.signal !== undefined)));
const sizeOf = (file: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.stat(file)),
    Effect.map((info) => Number(info.size)),
    Effect.orElseSucceed(() => 0),
  );
/** Long enough, on the fast clock, for the stand-in's turn to have written a few times more. */
const aWhile = Effect.sleep(Duration.seconds(8));
const kill = (pid: number) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
};
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const serverPid = () =>
  events().pipe(Effect.map((all) => all.find((one) => one.pid !== undefined)?.pid ?? 0));

test("a stopped Codex agent's turn ends before the stop says it stopped, and nothing writes after", () =>
  runEffect(
    Effect.gen(function* () {
      yield* serve();
      yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
      yield* started();
      yield* sizeOf(written()).pipe(Effect.repeat({ until: (size) => size > 0 }));

      const halt = yield* halted();
      const atStop = yield* sizeOf(written());
      yield* aWhile;

      expect(halt).toEqual({ stopped: [agent], left: [] });
      expect(yield* sizeOf(written())).toBe(atStop);
      expect((yield* signals()).map((one) => one.signal)).toEqual(["SIGTERM"]);
      const interrupts = (yield* events()).filter((one) => one.method === "turn/interrupt");
      expect(interrupts.map((one) => one.params)).toEqual([{ threadId: THREAD, turnId: TURN }]);
      expect(alive(yield* serverPid())).toBe(false);
    }),
  ));

const SUB_THREAD = "01a13504-4237-7000-8000-000000000001";
const SUB_TURN = "01a13504-4237-7000-8000-000000000002";
type JsonObject = typeof Schema.JsonObject.Type;
const decodeObject = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.JsonObject));
const control = () => `${rig.root}/state/compaction/${agent}/control.json`;
const panesClosed = () =>
  rig.cmds().pipe(Effect.map((cmds) => cmds.filter((cmd) => cmd === "pane close").length));
const agentsLog = () =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(`${dir}/agents/r1/agents.log`)),
    Effect.orElseSucceed(() => ""),
  );
const editControl = (edit: (record: JsonObject) => JsonObject) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs.readFileString(control()).pipe(
        Effect.flatMap(decodeObject),
        Effect.flatMap((record) => fs.writeFileString(control(), asJson(edit(record)))),
      ),
    ),
    Effect.orDie,
  );
const recorded = () =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(control())),
    Effect.flatMap(decodeObject),
    Effect.orElseSucceed(() => null),
  );

/** A human closing the agent's pane, which herdr then no longer lists. */
const closedByHand = Effect.gen(function* () {
  const herdr = new FakeHerdr(rig.pluginEnv());
  const one = (yield* herdr.agentList()).find((listed) => listed.name === agent);
  if (one !== undefined) yield* herdr.paneClose(one.paneId);
}).pipe(Effect.orDie);

/** A Run whose Codex agent is working, with the stand-in as `over` makes it. */
const working = (over: Partial<StandIn> = {}) =>
  Effect.gen(function* () {
    yield* serve(over);
    yield* rig.queueOutputs([{ verdict: "clean", note: "done" }]);
    yield* started();
  });

test("a sub-agent's running turn on the same server is interrupted too", () =>
  runEffect(
    Effect.gen(function* () {
      yield* working({
        threads: [
          { id: THREAD, cwd: rig.projectDir, turn: { id: TURN, writes: written() } },
          {
            id: SUB_THREAD,
            cwd: "/elsewhere",
            parent: THREAD,
            turn: { id: SUB_TURN, writes: written() },
          },
        ],
      });
      expect(yield* halted()).toEqual({ stopped: [agent], left: [] });
      const interrupts = (yield* events()).filter((one) => one.method === "turn/interrupt");
      expect(interrupts.map((one) => one.params)).toEqual([
        { threadId: THREAD, turnId: TURN },
        { threadId: SUB_THREAD, turnId: SUB_TURN },
      ]);
    }),
  ));

test("a continuation queued behind an interrupted turn never starts", () =>
  runEffect(
    Effect.gen(function* () {
      yield* working({ continuation: true });
      expect(yield* halted()).toEqual({ stopped: [agent], left: [] });
      const atStop = yield* sizeOf(written());
      yield* aWhile;
      expect(yield* sizeOf(written())).toBe(atStop);
      expect(yield* sizeOf(written())).toBeGreaterThan(0);
    }),
  ));

const Turn = Schema.Struct({ threadId: Schema.String, turnId: Schema.String });
const decodeTurn = Schema.decodeUnknownSync(Turn);
const byTurn = (a: typeof Turn.Type, b: typeof Turn.Type) =>
  `${a.threadId} ${a.turnId}`.localeCompare(`${b.threadId} ${b.turnId}`);

test.each([1, 2])(
  "a continuation that started before the server took its drain is interrupted too, the drain landing after interrupt %i",
  (lateDrain) =>
    runEffect(
      Effect.gen(function* () {
        yield* working({ continuation: true, lateDrain });
        expect(yield* halted()).toEqual({ stopped: [agent], left: [] });
        const atStop = yield* sizeOf(written());
        yield* aWhile;
        expect(yield* sizeOf(written())).toBe(atStop);
        const all = yield* events();
        const interrupted = all
          .filter((one) => one.method === "turn/interrupt")
          .map((one) => decodeTurn(one.params));
        const begun = all
          .filter((one) => one.turn !== undefined)
          .map((one) => decodeTurn({ threadId: one.thread, turnId: one.turn }));
        expect(interrupted.slice(0, 2)).toEqual([
          { threadId: THREAD, turnId: TURN },
          { threadId: THREAD, turnId: `${TURN}-continued` },
        ]);
        expect(interrupted.toSorted(byTurn)).toEqual(begun.toSorted(byTurn));
      }),
    ),
);

test("a process left in the server's session gets one SIGTERM and ends", () =>
  runEffect(
    Effect.gen(function* () {
      yield* working({ child: "ends" });
      const child = (yield* events()).find((one) => one.child !== undefined)!.child!;
      expect(yield* halted()).toEqual({ stopped: [agent], left: [] });
      expect(alive(child)).toBe(false);
    }),
  ));

test("a process the first stop noted is still the server's after the server has gone, and the next stop ends it", () =>
  runEffect(
    Effect.gen(function* () {
      yield* working({ ignoreInterrupt: true, child: "ends" });
      const child = (yield* events()).find((one) => one.child !== undefined)!.child!;
      expect((yield* halted({ stopMs: 300 })).left).toHaveLength(1);

      // Its turn ends and it exits, leaving the process it started.
      yield* release();
      const pid = yield* serverPid();
      while (alive(pid)) yield* TestClock.withLive(Effect.sleep("20 millis"));
      expect(alive(child)).toBe(true);

      expect(yield* halted()).toEqual({ stopped: [agent], left: [] });
      expect(alive(child)).toBe(false);
    }),
  ));

test(
  "a process of the session that ignores SIGTERM fails the stop by its pid, and gets no second signal",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* working({ child: "ignores" });
        const child = (yield* events()).find((one) => one.child !== undefined)!.child!;
        // Live: the server's exit and its survivors' grace are real time, not the fast clock's.
        const halt = yield* TestClock.withLive(halted({ stopMs: 5_000 }));
        expect(halt.stopped).toEqual([]);
        expect(halt.left.join("\n")).toContain(`pid ${child}`);
        expect(alive(child)).toBe(true);
        const fs = yield* FileSystem.FileSystem;
        expect((yield* fs.readFileString(`${eventsFile()}.child`)).trim().split("\n")).toEqual([
          "TERM",
        ]);
        expect((yield* signals()).map((one) => one.signal)).toEqual(["SIGTERM"]);
        expect(yield* panesClosed()).toBe(0);
      }),
    ),
  // The stop waits out its 5s budget on the survivor, which a bare `bun test` times out at.
  30_000,
);

test("an agent whose pane herdr no longer lists still has its server stopped", () =>
  runEffect(
    Effect.gen(function* () {
      yield* working();
      yield* closedByHand;
      expect(yield* halted()).toEqual({ stopped: [agent], left: [] });
      expect(alive(yield* serverPid())).toBe(false);
      expect(yield* recorded()).toBeNull();
    }),
  ));

test("a server that acknowledges but never exits is left, acknowledged, with its pane open and its record kept", () =>
  runEffect(
    Effect.gen(function* () {
      yield* working({ ignoreInterrupt: true });
      const halt = yield* halted({ stopMs: 25_000 });
      const pid = yield* serverPid();
      expect(halt.stopped).toEqual([]);
      expect(halt.left).toHaveLength(1);
      expect(halt.left[0]).toContain(`${agent} is not stopped: acknowledged`);
      for (const id of [THREAD, TURN, `pid ${pid}`, "ws://127.0.0.1:"])
        expect(halt.left[0]).toContain(id);
      expect(yield* panesClosed()).toBe(0);
      expect(alive(pid)).toBe(true);
      expect(yield* recorded()).toMatchObject({
        pid,
        endpoint: expect.stringContaining("ws://127.0.0.1:"),
        started: expect.any(String),
        stop: { state: "acknowledged", turns: [{ thread: THREAD, turn: TURN }] },
      });
      expect((yield* signals()).map((one) => one.signal)).toEqual(["SIGTERM"]);
    }),
  ));

for (const [what, over, edit, why] of [
  [
    "a connection that drops mid-stop",
    () => ({ dropOn: "thread/turns/list" }),
    null,
    /connection closed/,
  ],
  [
    "an endpoint that answers with a thread in another directory",
    () => ({
      threads: [
        { id: THREAD, cwd: rig.projectDir, turn: { id: TURN } },
        { id: SUB_THREAD, cwd: "/somewhere/else" },
      ],
    }),
    null,
    /works in \/somewhere\/else/,
  ],
  [
    "a thread with no user message that is not idle",
    () => unmaterialized({ status: "active" }),
    null,
    /is not materialized yet/,
  ],
  [
    "an idle thread whose turns are refused for another reason",
    () => unmaterialized({ turnsRefusal: { code: -32600, message: "rollout is unreadable" } }),
    null,
    /rollout is unreadable/,
  ],
  [
    "an idle thread whose turns are refused with that text under another code",
    () =>
      unmaterialized({
        turnsRefusal: {
          code: -32603,
          message: `thread ${THREAD} is not materialized yet; thread/turns/list is unavailable before first user message`,
        },
      }),
    null,
    /is not materialized yet/,
  ],
  [
    "a thread with no user message in another directory",
    () => unmaterialized({ cwd: "/somewhere/else" }),
    null,
    /works in \/somewhere\/else/,
  ],
  [
    "an unlistable thread that is not idle",
    () => unlistable({ status: "active" }),
    null,
    /list_turns is not supported yet/,
  ],
  [
    "an unlistable thread that has turns",
    () => unlistable({ readTurns: [{ id: TURN }] }),
    null,
    /list_turns is not supported yet/,
  ],
  [
    "an unlistable thread with a preview",
    () => unlistable({ preview: "a first message" }),
    null,
    /list_turns is not supported yet/,
  ],
  [
    "an unlistable thread whose history is not paginated",
    () => unlistable({ historyMode: "legacy" }),
    null,
    /list_turns is not supported yet/,
  ],
  [
    "an unlistable thread in another directory",
    () => unlistable({ cwd: "/somewhere/else" }),
    null,
    /works in \/somewhere\/else/,
  ],
  [
    "an idle thread whose turns are refused as unsupported for another reason",
    () =>
      unlistable({
        turnsRefusal: { code: -32601, message: "thread/items/list is not supported yet" },
      }),
    null,
    /thread\/items\/list is not supported yet/,
  ],
  [
    "a pid whose start time does not match the record",
    () => ({}),
    (record: JsonObject) => ({ ...record, started: "1" }),
    /started at .*, not 1/,
  ],
] as const) {
  test(`${what} is refused as failed, with no signal sent and the pane open`, () =>
    runEffect(
      Effect.gen(function* () {
        yield* working(over());
        if (edit !== null) yield* editControl(edit);
        const halt = yield* halted();
        expect(halt.stopped).toEqual([]);
        expect(halt.left.join("\n")).toMatch(/is not stopped: failed/);
        expect(halt.left.join("\n")).toMatch(why);
        // Refused before it looked, so it says nothing of the turns it never read.
        expect(halt.left.join("\n")).toContain("its turns were never read");
        expect(yield* signals()).toEqual([]);
        expect(yield* panesClosed()).toBe(0);
        expect(alive(yield* serverPid())).toBe(true);
      }),
    ));
}

test("a stop repeated while the server is not Quiet looks again and sends no second signal", () =>
  runEffect(
    Effect.gen(function* () {
      yield* working({ ignoreInterrupt: true });
      expect((yield* halted({ stopMs: 300 })).left).toHaveLength(1);
      expect((yield* halted({ stopMs: 300 })).left).toHaveLength(1);
      expect((yield* signals()).map((one) => one.signal)).toEqual(["SIGTERM"]);
    }),
  ));

test("a stop repeated once the agent is Quiet sends nothing and changes nothing", () =>
  runEffect(
    Effect.gen(function* () {
      yield* working();
      expect(yield* halted()).toEqual({ stopped: [agent], left: [] });
      const before = (yield* events()).length;
      const closes = yield* panesClosed();
      expect((yield* halted()).left).toEqual([]);
      expect((yield* events()).length).toBe(before);
      expect(yield* panesClosed()).toBe(closes);
    }),
  ));

test("a record from the previous build, with no start time, is stopped once its command and endpoint are proven", () =>
  runEffect(
    Effect.gen(function* () {
      yield* working();
      yield* editControl((record) =>
        Object.fromEntries(
          Object.entries(record).filter(([key]) => key !== "started" && key !== "stop"),
        ),
      );
      expect(yield* halted()).toEqual({ stopped: [agent], left: [] });
      expect(alive(yield* serverPid())).toBe(false);
    }),
  ));

test("the agents log has each state reached with the full ids, and only a quiet agent as stopped", () =>
  runEffect(
    Effect.gen(function* () {
      yield* working();
      yield* halted();
      const lines = (yield* agentsLog()).split("\n");
      const transcript = `${rig.root}/rollout-${THREAD}.jsonl`;
      for (const state of ["interrupt submitted", "interrupt acknowledged", "quiet"]) {
        const line = lines.find((one) => one.includes(`${agent}: ${state}`));
        expect(line).toBeDefined();
        for (const fact of [
          THREAD,
          TURN,
          "ws://127.0.0.1:",
          `pid ${yield* serverPid()}`,
          transcript,
        ])
          expect(line).toContain(fact);
      }
      expect(lines.some((one) => one.includes(`stopped ${agent}`))).toBe(true);
    }),
  ));

// Nothing takes over beside an agent that is not Quiet.

const release = () =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.writeFileString(`${eventsFile()}.release`, "")),
    Effect.orDie,
  );
const stopFlag = (set: boolean) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => {
      const path = controlPath(dir, "stop", "r1");
      return set ? fs.writeFileString(path, "") : fs.remove(path).pipe(Effect.ignore);
    }),
    Effect.orDie,
  );
const parkedWhy = () =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(controlPath(dir, PARKED, "r1"))),
    Effect.orElseSucceed(() => ""),
  );
const agentStarts = () =>
  rig
    .calls()
    .pipe(
      Effect.map((calls) =>
        calls
          .filter((call) => call.cmd === "agent start")
          .map((call) => (call.argv ?? []).find((arg) => arg === "claude" || arg === "codex")),
      ),
    );
type Reached = Effect.Effect<boolean, never, WorkflowEngine.WorkflowEngine | FileSystem.FileSystem>;
const suspended: Reached = Effect.gen(function* () {
  const engine = yield* WorkflowEngine.WorkflowEngine;
  const id = yield* work.executionId({ runId: "r1", input: { skip: false } });
  return pollStatus(yield* engine.poll(work, id), "agent-work").status === "suspended";
});
const given = Effect.suspend(() =>
  rig.calls().pipe(
    Effect.map((calls) =>
      calls.some(
        (call) => call.cmd === "agent prompt" && (call.argv?.[3] ?? "").includes("Your task"),
      ),
    ),
    Effect.orElseSucceed(() => false),
  ),
);
/** Starts or resumes the work and lets the host go once it has got as far as `reached`. */
const until = (reached: Reached, over?: Partial<AgentHost>, resume = false) =>
  session(
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine.WorkflowEngine;
      const payload = { runId: "r1", input: { skip: false } };
      if (resume) yield* engine.resume(work, yield* work.executionId(payload));
      yield* work.execute(payload, { discard: true });
      for (let tries = 0; !(yield* reached); tries++) {
        if (tries === 3_000) return yield* Effect.die(new Error("r1 never got that far"));
        yield* TestClock.withLive(Effect.sleep("10 millis"));
      }
    }),
    over,
  );
const resumedToEnd = (over?: Partial<AgentHost>) =>
  session(
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine.WorkflowEngine;
      const payload = { runId: "r1", input: { skip: false } };
      yield* engine.resume(work, yield* work.executionId(payload));
      return yield* work.execute(payload).pipe(Effect.result);
    }),
    over,
  );

test(
  "a restart beside a Codex turn that has not stopped parks, and starts its successor only once it has",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* serve({ ignoreInterrupt: true });
        yield* rig.queueOutputs([null, { verdict: "clean", note: "restarted" }]);
        yield* until(given);

        // Stopped while its turn will not end, and its pane then closed by hand.
        yield* stopFlag(true);
        expect((yield* halted({ stopMs: 25_000 })).left).toHaveLength(1);
        yield* closedByHand;
        yield* stopFlag(false);

        const restarted = agentStarts().pipe(
          Effect.map((starts) => starts.length > 1),
          Effect.orElseSucceed(() => false),
        );
        yield* until(
          Effect.map(Effect.all([suspended, restarted]), (one) => one.some(Boolean)),
          { stopMs: 25_000 },
          true,
        );
        expect(yield* agentStarts()).toEqual(["codex"]);
        const why = yield* parkedWhy();
        for (const fact of [agent, THREAD, TURN, "ws://127.0.0.1:", `pid ${yield* serverPid()}`])
          expect(why).toContain(fact);
        expect(yield* recorded()).not.toBeNull();

        // Its turn ends and it exits; the agent started in its place gets a server of its own.
        yield* release();
        yield* serve({ threads: [{ id: SUB_THREAD, cwd: rig.projectDir }] });
        const result = yield* resumedToEnd();
        const atEnd = yield* sizeOf(written());
        expect(result._tag === "Success" && result.success.note).toBe("restarted");
        expect(yield* agentStarts()).toEqual(["codex", "codex"]);
        expect(alive(yield* serverPid())).toBe(false);
        yield* aWhile;
        expect(yield* sizeOf(written())).toBe(atEnd);
        const log = yield* agentsLog();
        expect(log.indexOf(`${agent}: quiet`)).toBeGreaterThan(-1);
        expect(log.indexOf(`${agent}: quiet`)).toBeLessThan(log.lastIndexOf(`${agent}: codex in`));
      }),
    ),
  120_000,
);

const successor = agentName("r1", "build", null, 2);
const fallback = { fallbacks: Effect.succeed(["claude"]) };
/** Once the Codex agent has its work, its harness says it ran out. */
const runsOut = Effect.gen(function* () {
  while (!(yield* given)) yield* TestClock.withLive(Effect.sleep("10 millis"));
  yield* recordClaudeEvent(
    `${rig.root}/state/compaction/${agent}`,
    asJson({
      session_id: "s-out",
      hook_event_name: "StopFailure",
      error: "rate_limit",
      transcript_path: "/tmp/s-out.jsonl",
    }),
  );
}).pipe(Effect.orDie);

test("a Codex agent that runs out is Quiet before its Claude successor starts", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        yield* serve();
        yield* rig.queueOutputs([null, { verdict: "clean", note: "finished on claude" }]);
        yield* Effect.forkScoped(runsOut);
        const result = yield* session(
          work.execute({ runId: "r1", input: { skip: false } }).pipe(Effect.result),
          fallback,
        );
        expect(result._tag === "Success" && result.success.note).toBe("finished on claude");
        expect(yield* agentStarts()).toEqual(["codex", "claude"]);
        expect(alive(yield* serverPid())).toBe(false);
        const log = yield* agentsLog();
        expect(log.indexOf(`${agent}: quiet`)).toBeGreaterThan(-1);
        expect(log.indexOf(`${agent}: quiet`)).toBeLessThan(log.indexOf(`${successor}: claude in`));
      }),
    ),
  ));

test("a Codex agent that runs out and will not stop parks the work, and no successor starts", () =>
  runEffect(
    Effect.gen(function* () {
      yield* serve({ ignoreInterrupt: true });
      yield* rig.queueOutputs([null, { verdict: "clean", note: "never" }]);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkScoped(runsOut);
          yield* until(suspended, { ...fallback, stopMs: 25_000 });
        }),
      );
      expect(yield* agentStarts()).toEqual(["codex"]);
      const why = yield* parkedWhy();
      expect(why).toContain(`${agent} is not stopped: acknowledged`);
      expect(why).toContain(TURN);
      expect(yield* panesClosed()).toBe(0);
    }),
  ));

/** herdr as a stop landing right after `after` happens. */
class StopsAfter extends FakeHerdr {
  constructor(private readonly after: "pane close" | "agent start") {
    super(rig.pluginEnv());
  }
  override paneClose(paneId: string) {
    const closed = super.paneClose(paneId);
    return this.after === "pane close" ? closed.pipe(Effect.tap(() => stopFlag(true))) : closed;
  }
  override agentStart(options: Parameters<FakeHerdr["agentStart"]>[0]) {
    const started = super.agentStart(options);
    return this.after === "agent start" && options.name === successor
      ? started.pipe(Effect.tap(() => stopFlag(true)))
      : started;
  }
}

test("a stop between a Fallback's retirement and its launch leaves no agent running", () =>
  runEffect(
    Effect.gen(function* () {
      yield* serve();
      yield* rig.queueOutputs([null, { verdict: "clean", note: "never" }]);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkScoped(runsOut);
          yield* until(suspended, { ...fallback, herdr: new StopsAfter("pane close") });
        }),
      );
      expect(yield* agentStarts()).toEqual(["codex"]);
      expect(alive(yield* serverPid())).toBe(false);
    }),
  ));

test("a stop just after a launch started its agent stops that agent, and a resume goes on with one", () =>
  runEffect(
    Effect.gen(function* () {
      yield* serve();
      yield* rig.queueOutputs([null, null, { verdict: "clean", note: "after the stop" }]);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.forkScoped(runsOut);
          yield* until(suspended, { ...fallback, herdr: new StopsAfter("agent start") });
        }),
      );
      expect(yield* agentStarts()).toEqual(["codex", "claude"]);
      const live = yield* new Herdr(rig.pluginEnv()).agentList().pipe(Effect.orDie);
      expect(live.map((one) => one.name)).not.toContain(successor);

      yield* stopFlag(false);
      const result = yield* resumedToEnd(fallback);
      expect(result._tag === "Success" && result.success.note).toBe("after the stop");
      const now = yield* new Herdr(rig.pluginEnv()).agentList().pipe(Effect.orDie);
      expect(now.filter((one) => one.name === successor)).toHaveLength(1);
    }),
  ));

test("the sweep keeps an unlisted agent's record while its server is not Quiet, and removes it once it is", () =>
  runEffect(
    Effect.gen(function* () {
      yield* working({ ignoreInterrupt: true });
      yield* closedByHand;
      const sweeper = compactionSweeper(
        `${rig.root}/state`,
        [new FakeHerdr(rig.pluginEnv())],
        hostOf().ports,
        25_000,
      );
      const first = yield* sweep([sweeper], `${rig.root}/state`, "host");
      expect(first.remove).toEqual([]);
      expect(first.keep.map((one) => one.reason).join("\n")).toContain(
        `its Codex turn has not stopped: ${agent} is not stopped: acknowledged`,
      );
      expect(yield* recorded()).not.toBeNull();
      // What `collie cleanup` lists says the same, and a second sweep sends no second signal.
      const listed = yield* sweeper.judge;
      expect(listed.remove).toEqual([]);
      expect(listed.keep.map((one) => one.reason).join("\n")).toContain(
        `its Codex turn has not stopped: ${agent} is not stopped: acknowledged`,
      );
      const interrupts = () =>
        events().pipe(
          Effect.map((all) => all.filter((one) => one.method === "turn/interrupt").length),
        );
      const asked = yield* interrupts();
      yield* sweep([sweeper], `${rig.root}/state`, "host");
      // Stopped again: interrupted again, and signalled once.
      expect(yield* interrupts()).toBeGreaterThan(asked);
      expect((yield* events()).filter((one) => one.signal === "SIGTERM")).toHaveLength(1);

      yield* release();
      const pid = yield* serverPid();
      while (alive(pid)) yield* TestClock.withLive(Effect.sleep("20 millis"));
      const second = yield* sweep([sweeper], `${rig.root}/state`, "host");
      expect(second.remove.map((one) => one.target)).toEqual([
        `${rig.root}/state/compaction/${agent}`,
      ]);
      expect(yield* recorded()).toBeNull();
      // Told to the Run that launched it, with the turn it stopped.
      expect(yield* agentsLog()).toContain(`${agent}: quiet — thread ${THREAD} turn ${TURN}`);
    }),
  ));

test("a sweep stops again a record whose earlier stop failed before it signalled anything", () =>
  runEffect(
    Effect.gen(function* () {
      yield* working();
      const pid = yield* serverPid();
      const started = (yield* processOf(pid))!.started;
      yield* editControl((record) => ({
        ...record,
        stop: {
          state: "failed",
          at: 0,
          turns: null,
          reason: "the connection was lost",
          signalled: [],
          left: [{ pid, started }],
          noted: [],
        },
      }));
      yield* closedByHand;
      const sweeper = compactionSweeper(
        `${rig.root}/state`,
        [new FakeHerdr(rig.pluginEnv())],
        hostOf().ports,
        25_000,
      );
      expect((yield* sweeper.judge).keep.map((one) => one.reason).join("\n")).toContain(
        "the connection was lost",
      );
      // Live: the server's exit after its signal is real time, not the fast clock's.
      const swept = yield* TestClock.withLive(sweep([sweeper], `${rig.root}/state`, "host"));
      expect((yield* signals()).map((one) => one.signal)).toEqual(["SIGTERM"]);
      expect(swept.remove.map((one) => one.target)).toEqual([
        `${rig.root}/state/compaction/${agent}`,
      ]);
      expect(alive(pid)).toBe(false);
    }),
  ));

test("a launch beside an unlisted agent whose server is not Quiet keeps that record, and goes on", () =>
  runEffect(
    Effect.gen(function* () {
      yield* working({ ignoreInterrupt: true });
      yield* closedByHand;
      const host = hostOf();
      const installed = yield* installControls(
        {
          ports: host.ports!,
          stateDir: `${rig.root}/state`,
          configured: host.compactAtTokens,
          log: () => Effect.void,
          herdr: host.herdr,
          stopMs: 2_000,
        },
        {
          agent: "r2-other",
          harness: "claude",
          cwd: rig.projectDir,
          runLog: `${dir}/agents/r2/agents.log`,
        },
      );
      expect(installed.length).toBeGreaterThan(0);
      expect(yield* recorded()).toMatchObject({ stop: { state: "acknowledged" } });
    }),
  ));

const unmaterialized = (over: Partial<StandIn["threads"][number]> = {}) => ({
  threads: [
    {
      id: THREAD,
      cwd: rig.projectDir,
      path: `${rig.root}/rollout-${THREAD}.jsonl`,
      unmaterialized: true,
      ...over,
    },
  ],
});
const unlistable = (over: Partial<StandIn["threads"][number]> = {}) => ({
  threads: [
    {
      id: THREAD,
      cwd: rig.projectDir,
      path: `${rig.root}/rollout-${THREAD}.jsonl`,
      unlistable: true,
      ...over,
    },
  ],
});
const neverAdmits = () =>
  new FakeHerdr(
    rig.pluginEnv({
      FAKE_HERDR_FAIL: asJson({ "agent start": "timed out waiting for agent startup" }),
    }),
  );

test("a start herdr never admits parks naming its agent, and the next launch under that name stops its server first", () =>
  runEffect(
    Effect.gen(function* () {
      yield* serve(unmaterialized());
      yield* until(suspended, { herdr: neverAdmits() });
      const why = yield* parkedWhy();
      expect(why).toContain(`${agent} did not start`);
      expect(why).toContain("timed out waiting for agent startup");
      expect(yield* rig.cmds()).not.toContain("agent prompt");
      const stranded = yield* serverPid();

      const relaunched = yield* session(
        Agents.pipe(
          Effect.flatMap((agents) =>
            agents.launch({
              runId: "r1",
              operation: "build",
              role: "implementer",
              workflow: "agent-work",
              task: null,
              agent: null,
              cwd: rig.projectDir,
              prompt: "Build it.",
              output: `${dir}/output.json`,
              skill: null,
              harness: "codex",
              model: null,
              effort: null,
              permissions: null,
            }),
          ),
        ),
      );
      expect(relaunched.agent).toBe(agent);
      expect(alive(stranded)).toBe(false);
      const all = yield* events();
      const servers = all.flatMap((one, at) => (one.pid === undefined ? [] : [at]));
      const signalled = all.flatMap((one, at) => (one.signal === undefined ? [] : [at]));
      expect(servers).toHaveLength(2);
      expect(signalled).toHaveLength(1);
      expect(signalled[0]).toBeLessThan(servers[1]!);
      expect(yield* agentStarts()).toEqual(["codex", "codex"]);
      const log = yield* agentsLog();
      expect(log.indexOf(`${agent}: quiet`)).toBeGreaterThan(-1);
      expect(log.indexOf(`${agent}: quiet`)).toBeLessThan(log.lastIndexOf(`${agent}: codex in`));
    }),
  ));

/** r1's start, which herdr never admits, leaving its server up with no launch recorded. */
const neverAdmitted = Effect.gen(function* () {
  yield* serve(unmaterialized());
  yield* until(suspended, { herdr: neverAdmits() });
  return yield* serverPid();
});

test("the stop of a Run whose start herdr never admitted stops that start's server to quiet", () =>
  runEffect(
    Effect.gen(function* () {
      const stranded = yield* neverAdmitted;
      expect(yield* halted({ herdr: neverAdmits() })).toEqual({ stopped: [agent], left: [] });
      expect((yield* signals()).map((one) => one.signal)).toEqual(["SIGTERM"]);
      expect(alive(stranded)).toBe(false);
      expect(yield* agentsLog()).toContain(`${agent}: quiet`);
      expect(yield* recorded()).toBeNull();
    }),
  ));

test("another Run's stop leaves alone a start herdr never admitted", () =>
  runEffect(
    Effect.gen(function* () {
      const stranded = yield* neverAdmitted;
      const other = yield* session(Agents.pipe(Effect.flatMap((agents) => agents.halt("r2"))), {
        herdr: neverAdmits(),
      });
      expect(other).toEqual({ stopped: [], left: [] });
      expect(yield* signals()).toEqual([]);
      expect(alive(stranded)).toBe(true);
      expect(yield* recorded()).not.toBeNull();
      kill(stranded);
    }),
  ));

test("a stop of a start herdr never admitted that cannot remove its record says so, and keeps it", () =>
  runEffect(
    Effect.gen(function* () {
      yield* neverAdmitted;
      const records = `${rig.root}/state/compaction`;
      const fs = yield* FileSystem.FileSystem;
      yield* fs.chmod(records, 0o555).pipe(Effect.orDie);
      const halt = yield* halted({ herdr: neverAdmits() }).pipe(
        Effect.ensuring(fs.chmod(records, 0o755).pipe(Effect.orDie)),
      );
      expect(halt.stopped).toEqual([]);
      expect(halt.left).toHaveLength(1);
      expect(halt.left[0]).toContain(`${agent} could not be stopped`);
      expect(yield* recorded()).not.toBeNull();
    }),
  ));

test("a stop of a start herdr never admitted whose controls are held elsewhere says it was not stopped", () =>
  runEffect(
    Effect.gen(function* () {
      const stranded = yield* neverAdmitted;
      const halt = yield* withControlLock(
        `${rig.root}/state`,
        agent,
        halted({ herdr: neverAdmits() }),
      );
      expect(halt.stopped).toEqual([]);
      expect(halt.left).toHaveLength(1);
      expect(halt.left[0]).toContain(`${agent} could not be stopped yet`);
      expect(yield* signals()).toEqual([]);
      expect(alive(stranded)).toBe(true);
      expect(yield* recorded()).not.toBeNull();
      kill(stranded);
    }),
  ));

const unreadable: ReadonlyArray<
  readonly [string, Effect.Effect<() => Effect.Effect<void>, never, FileSystem.FileSystem>]
> = [
  [
    "a record of this Run's that no longer parses",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const text = yield* fs.readFileString(control()).pipe(Effect.orDie);
      yield* fs
        .writeFileString(control(), text.slice(0, text.indexOf('"stop"')))
        .pipe(Effect.orDie);
      return () => Effect.void;
    }),
  ],
  [
    "a record that cannot be read",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.chmod(control(), 0o000).pipe(Effect.orDie);
      return () => fs.chmod(control(), 0o644).pipe(Effect.orDie);
    }),
  ],
  [
    "a directory of records that cannot be read",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const records = `${rig.root}/state/compaction`;
      yield* fs.chmod(records, 0o000).pipe(Effect.orDie);
      return () => fs.chmod(records, 0o755).pipe(Effect.orDie);
    }),
  ],
];
for (const [what, spoil] of unreadable)
  test(`a stop that meets ${what} does not say it stopped everything`, () =>
    runEffect(
      Effect.gen(function* () {
        const stranded = yield* neverAdmitted;
        const restore = yield* spoil;
        const halt = yield* halted({ herdr: neverAdmits() }).pipe(
          Effect.ensuring(Effect.suspend(restore)),
        );
        expect(halt.stopped).toEqual([]);
        expect(halt.left).toHaveLength(1);
        expect(yield* signals()).toEqual([]);
        expect(alive(stranded)).toBe(true);
        kill(stranded);
      }),
    ));

/** herdr refusing a start that a Run's stop lands in, as that stop reaches the Run's agents. */
class StoppedWhileStarting extends FakeHerdr {
  halts: Array<{ readonly stopped: ReadonlyArray<string>; readonly left: ReadonlyArray<string> }> =
    [];
  constructor() {
    super(
      rig.pluginEnv({
        FAKE_HERDR_FAIL: asJson({ "agent start": "timed out waiting for agent startup" }),
      }),
    );
  }
  override agentStart(options: Parameters<FakeHerdr["agentStart"]>[0]) {
    return stopFlag(true).pipe(
      Effect.andThen(halted({ herdr: neverAdmits() })),
      Effect.tap((halt) => Effect.sync(() => this.halts.push(halt))),
      Effect.andThen(super.agentStart(options)),
    );
  }
}

test("a stop that lands in a start herdr then refuses stops that start's server once it parks", () =>
  runEffect(
    Effect.gen(function* () {
      yield* serve(unmaterialized());
      const herdr = new StoppedWhileStarting();
      yield* until(suspended, { herdr });
      expect(herdr.halts).toEqual([
        {
          stopped: [],
          left: [
            `${agent} could not be stopped yet: a start, prune or stop still holds its controls`,
          ],
        },
      ]);
      expect((yield* signals()).map((one) => one.signal)).toEqual(["SIGTERM"]);
      expect(alive(yield* serverPid())).toBe(false);
      expect(yield* agentsLog()).toContain(`${agent}: quiet`);
      expect(yield* recorded()).toBeNull();
    }),
  ));

test("a Codex agent that never got a user message stops to quiet", () =>
  runEffect(
    Effect.gen(function* () {
      yield* working(unmaterialized());
      expect(yield* halted()).toEqual({ stopped: [agent], left: [] });
      expect((yield* signals()).map((one) => one.signal)).toEqual(["SIGTERM"]);
      expect(alive(yield* serverPid())).toBe(false);
      expect(yield* agentsLog()).toContain(`${agent}: quiet`);
      expect(yield* recorded()).toBeNull();
    }),
  ));

test("a Codex agent whose paginated thread with no user message cannot list its turns stops to quiet", () =>
  runEffect(
    Effect.gen(function* () {
      yield* working(unlistable());
      expect(yield* halted()).toEqual({ stopped: [agent], left: [] });
      expect((yield* signals()).map((one) => one.signal)).toEqual(["SIGTERM"]);
      expect(alive(yield* serverPid())).toBe(false);
      expect(yield* agentsLog()).toContain(`${agent}: quiet`);
      expect(yield* recorded()).toBeNull();
    }),
  ));
