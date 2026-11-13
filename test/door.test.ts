// The host's door: what it answers itself while the engine answers nothing, and what it
// passes on to the engine.

import { expect, test } from "bun:test";
import * as BunSocket from "@effect/platform-bun/BunSocket";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { Deferred, Effect, Fiber, FileSystem, Layer, Option, Stream } from "effect";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import { IdentityRpc, recordIn, type OfferView, type RunDetail } from "../src/board-model";
import { door, relatedOf, type FromDoor, type ToDoor } from "../src/door";
import { readEnv } from "../src/env";
import type { AgentInfo } from "../src/herdr";
import { frontDoor } from "../src/host";
import { recordLaunch } from "../src/launches";
import { registerAgent } from "../src/registry";
import type { RunFacts } from "../src/runs";
import { encodeStepLine, STEPS_FILE, type StepLine } from "../src/steps";
import { runEffect } from "./support/effect";
import { madeRun, recordsAt } from "./support/records";

const identity = { build: "test", pid: 1, dir: "/state", protocol: 1, installation: "i" };

/** A door over `dir` whose engine hears everything and answers nothing. */
const silentEngine = (
  dir: string,
  socket: string,
  runs: ReadonlyArray<RunFacts>,
  offers: ReadonlyArray<readonly [string, ReadonlyArray<OfferView>]> = [],
) =>
  Effect.gen(function* () {
    // The engine lists its Runs only once it has migrated `host.db`.
    yield* Layer.build(recordsAt(dir));
    const heard: Array<FromDoor> = [];
    const listening = yield* Deferred.make<void>();
    let tell: (message: ToDoor) => void = () => {};
    yield* Effect.forkScoped(
      door({
        post: (message) => {
          heard.push(message);
          if (message._tag === "Listening") Deferred.doneUnsafe(listening, Effect.void);
        },
        listen: (receive) => {
          tell = receive;
        },
      }),
    );
    yield* Effect.yieldNow;
    tell({
      _tag: "Open",
      socket,
      env: readEnv({ HERDR_PLUGIN_STATE_DIR: dir, COLLIE_CWD: "/project" }),
      identity,
      model: { counter: new SharedArrayBuffer(4), epoch: "e", installation: "i" },
    });
    tell({
      _tag: "Listed",
      runs: Arr.map(runs, (fact) => ({ fact, seq: 0 })),
      gone: [],
      order: Arr.map(runs, (fact) => fact.id),
      alive: [],
      offers,
    });
    yield* Deferred.await(listening);
    return { heard, tell };
  });

const until = (done: () => boolean) =>
  Effect.gen(function* () {
    while (!done()) yield* Effect.sleep("10 millis");
  }).pipe(Effect.timeout("4 seconds"));

test("the door answers a Run's record and the host's identity while the engine answers nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-door-" });
      const run = yield* madeRun(dir, {
        id: "r1",
        state: "succeeded",
        created: "2026-10-30T09:00:00Z",
        finished: "2026-10-30T09:30:00Z",
      });
      const socket = `${dir}/host.sock`;
      const { heard } = yield* silentEngine(dir, socket, [run]);

      const client = yield* frontDoor(socket);
      const first = yield* client
        .runDetail({ runId: "r1", tail: false, pages: 1, refreshMr: false, parts: true })
        .pipe(Stream.runHead, Effect.timeout("5 seconds"));
      expect(first._tag).toBe("Some");
      // SAFETY: a record of a Run the door was told of is a record, not null or Unchanged.
      expect((first._tag === "Some" ? (first.value as RunDetail) : null)?.id).toBe("r1");

      // A Run with no merge request has nothing to ask the engine for any part.
      const whole = yield* client
        .runDetail({ runId: "r1", tail: true, pages: 1, refreshMr: false, parts: true })
        .pipe(
          Stream.filter(
            (frame) => frame !== null && "pending" in frame && frame.pending?.length === 0,
          ),
          Stream.runHead,
          Effect.timeout("5 seconds"),
        );
      expect(whole._tag).toBe("Some");
      // Its Flow shows no offer, so it asked the engine for none.
      expect(Arr.filter(heard, (one) => one._tag === "Ask")).toEqual([]);

      const who = yield* RpcClient.make(RpcGroup.make(IdentityRpc)).pipe(
        Effect.provideContext(
          yield* Layer.build(
            RpcClient.layerProtocolSocket().pipe(
              Layer.provide(BunSocket.layerNet({ path: socket })),
              Layer.provide(RpcSerialization.layerNdjson),
            ),
          ),
        ),
      );
      expect(yield* who.identity().pipe(Effect.timeout("5 seconds"))).toEqual(identity);

      const toasts = yield* Effect.forkScoped(Stream.runDrain(client.toasts()));
      yield* until(() =>
        Arr.some(heard, (one) => one._tag === "Request" && one.frame._tag === "Request"),
      );
      const passed = Arr.flatMap(heard, (one) =>
        one._tag === "Request" && one.frame._tag === "Request" ? [one.frame.tag] : [],
      );
      expect(passed).toEqual(["toasts"]);
      yield* Fiber.interrupt(toasts);
    }).pipe(Effect.scoped),
  ));

test("the door reads a record before any client asks, and tells the engine nothing of it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-door-" });
      const run = yield* madeRun(dir, {
        id: "r1",
        state: "succeeded",
        created: "2026-10-30T09:00:00Z",
        finished: "2026-10-30T09:30:00Z",
      });
      // A finished Step, which an open's record would tell the engine it showed.
      const step = {
        id: "build",
        title: "Build",
        description: "",
        kind: "agent",
        role: null,
        produces: null,
      } as const;
      const lines: ReadonlyArray<StepLine> = [
        { kind: "forecast", steps: [step], at: "2026-10-30T09:00:00Z" },
        { kind: "enter", key: "build", step, place: null, at: "2026-10-30T09:01:00Z" },
        { kind: "leave", key: "build", at: "2026-10-30T09:29:00Z" },
      ];
      yield* fs.writeFileString(
        `${run.dir}/${STEPS_FILE}`,
        Arr.join(
          Arr.map(lines, (line) => `${encodeStepLine(line)}\n`),
          "",
        ),
      );
      const { heard } = yield* silentEngine(dir, `${dir}/host.sock`, [run]);
      yield* until(() => Arr.some(heard, (one) => one._tag === "Warmed"));
      expect(Arr.map(heard, (one) => one._tag).sort()).toEqual(["Listening", "Warmed"]);
      expect(
        Arr.findFirst(heard, (one) => one._tag === "Warmed").pipe(
          Option.map((one) => "runs" in one && one.runs),
        ),
      ).toEqual(Option.some(1));
    }).pipe(Effect.scoped),
  ));

test("a delayed board listing preserves the door's newer agent reading", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-door-agents-" });
      const run = yield* madeRun(dir, { id: "r1", cwd: dir });
      const socket = `${dir}/host.sock`;
      const { tell } = yield* silentEngine(dir, socket, [run], [[run.id, []]]);
      yield* recordLaunch({
        runId: run.id,
        agent: "r1-build",
        operation: "build",
        output: `${dir}/output.json`,
        reused: false,
        role: "implementer",
        workflow: "implement",
        harness: "claude",
      }).pipe(Effect.provide(recordsAt(dir)));
      const agent: AgentInfo = {
        name: "r1-build",
        paneId: "p1",
        workspaceId: null,
        status: "idle",
        title: null,
        terminalId: null,
        agentSession: null,
      };
      yield* registerAgent(
        { session: null, workspaceId: null, cwd: dir },
        {
          role: "implementer",
          agent: agent.name,
          paneId: agent.paneId,
          workspaceId: null,
          runId: run.id,
          workflow: run.workflow,
          at: "2026-10-30T09:00:00Z",
        },
      ).pipe(Effect.provide(recordsAt(dir)));
      const client = yield* frontDoor(socket);
      const actions = client
        .runDetail({ runId: run.id, tail: false, pages: 1, refreshMr: false })
        .pipe(
          Stream.map(recordIn),
          Stream.runHead,
          Effect.map((head) => {
            const flow = Option.getOrNull(head)?.flow;
            return flow == null
              ? undefined
              : Arr.flatMap(flow.lanes, (lane) =>
                  Arr.flatMap(lane.nodes, (node) =>
                    node.agent === agent.name ? (node.actions ?? []) : [],
                  ),
                );
          }),
        );
      const agents = (alive: ReadonlyArray<AgentInfo>) =>
        tell({ _tag: "Listed", runs: [], gone: [], order: null, alive, offers: [] });
      const board = () =>
        tell({
          _tag: "Listed",
          runs: [{ fact: run, seq: 0 }],
          gone: [],
          order: [run.id],
          offers: [[run.id, []]],
        });

      agents([agent]);
      expect(yield* actions).toContain("tell");
      board();
      expect(yield* actions).toContain("tell");

      agents([]);
      board();
      const gone = yield* actions;
      expect(gone).toBeDefined();
      expect(gone).not.toContain("tell");
    }).pipe(Effect.scoped),
  ));

const implementNow: OfferView = {
  id: "implement-now",
  title: "Implement now",
  workflow: "implement",
  arguments: null,
  kind: "follow-up",
  primary: true,
  unavailable: null,
};

/** A plan ready to implement, whose Flow shows its first offer. */
const readyPlan = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const run = yield* madeRun(dir, {
      id: "plan",
      workflow: "plan",
      state: "succeeded",
      created: "2026-10-30T09:00:00Z",
      finished: "2026-10-30T09:30:00Z",
    });
    yield* fs.makeDirectory(`${run.dir}/plan/issues`, { recursive: true });
    yield* fs.writeFileString(`${run.dir}/plan/issues/01-one.md`, "# One\n");
    return run;
  });

const flowIds = (shown: Option.Option<unknown>) => {
  // SAFETY: a record of a Run the door was told of is a record, not null or Unchanged.
  const flow = (shown._tag === "Some" ? (shown.value as RunDetail) : null)?.flow;
  return Arr.flatMap(flow?.lanes ?? [], (lane) => Arr.map(lane.nodes, (node) => node.id));
};

const planRecord = (socket: string) =>
  Effect.flatMap(frontDoor(socket), (client) =>
    client
      .runDetail({ runId: "plan", tail: false, pages: 1, refreshMr: false, parts: true })
      .pipe(Stream.runHead),
  );

test("the door asks the engine for the offers of a plan ready to implement it was not told of", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-door-" });
      const socket = `${dir}/host.sock`;
      const { heard, tell } = yield* silentEngine(dir, socket, [yield* readyPlan(dir)]);
      const first = yield* Effect.forkScoped(planRecord(socket));
      yield* until(() => Arr.some(heard, (one) => one._tag === "Ask"));
      const asked = Arr.filter(heard, (one) => one._tag === "Ask");
      expect(Arr.map(asked, (one) => one.asked)).toEqual([{ _tag: "Offers", runId: "plan" }]);
      tell({ _tag: "Answer", ask: asked[0]!.ask, value: [implementNow] });
      expect(flowIds(yield* Fiber.join(first).pipe(Effect.timeout("4 seconds")))).toContain(
        "offer:implement-now",
      );
    }).pipe(Effect.scoped),
  ));

test("the door shows the offers the engine's board read with its listing, and asks for none", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-door-" });
      const socket = `${dir}/host.sock`;
      const { heard } = yield* silentEngine(
        dir,
        socket,
        [yield* readyPlan(dir)],
        [["plan", [implementNow]]],
      );
      const shown = yield* planRecord(socket).pipe(Effect.timeout("4 seconds"));
      expect(flowIds(shown)).toContain("offer:implement-now");
      expect(Arr.filter(heard, (one) => one._tag === "Ask")).toEqual([]);
    }).pipe(Effect.scoped),
  ));

test("the door reads the Runs of a record as the engine chooses them, and none it was not told of", () => {
  const fact = (id: string, over: Partial<RunFacts> = {}) =>
    // SAFETY: only the fields `relatedOf` reads are given.
    ({ id, task: null, parent: null, ...over }) as RunFacts;
  const facts = new Map(
    Arr.map(
      [
        fact("a", { task: "t" }),
        fact("b", { task: "t", parent: "p" }),
        fact("p", { task: "u" }),
        fact("c", { parent: "a" }),
        fact("asker", {
          requestedBy: { run: "b", agent: "a", machine: { installation: "i", name: "here" } },
        }),
        fact("other", { task: "v" }),
        fact("plan"),
      ],
      (one) => [one.id, one] as const,
    ),
  );
  const order = ["a", "b", "p", "c", "asker", "other", "plan"];
  const ids = (runs: ReadonlyArray<RunFacts> | null) =>
    runs === null ? null : Arr.map(runs, (one) => one.id);
  expect(ids(relatedOf(facts, order, "a", ["plan"]))).toEqual([
    "a",
    "b",
    "p",
    "c",
    "asker",
    "plan",
  ]);
  expect(relatedOf(facts, order, "a", ["unknown"])).toBeNull();
  expect(relatedOf(facts, order, "missing", [])).toBeNull();
  // A Run asked of the engine before any listing named it is not yet in the listing's order.
  expect(relatedOf(facts, ["b", "p"], "a", [])).toBeNull();
});

test(
  "a record the door is slow to send first tells the engine how long it took",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-door-slow-" });
        const run = yield* madeRun(dir, {
          id: "r1",
          state: "succeeded",
          created: "2026-10-30T09:00:00Z",
          finished: "2026-10-30T09:30:00Z",
        });
        const socket = `${dir}/host.sock`;
        // Told of no Run, so the door asks the engine for the record's Runs.
        const { heard, tell } = yield* silentEngine(dir, socket, []);
        const client = yield* frontDoor(socket);
        const first = yield* client
          .runDetail({ runId: "r1", tail: false, pages: 1, refreshMr: false, parts: true })
          .pipe(Stream.runHead, Effect.forkScoped);
        yield* until(() => Arr.some(heard, (one) => one._tag === "Ask"));
        const asked = Arr.findFirst(heard, (one) => one._tag === "Ask");
        // The engine answers past the door's slow mark.
        yield* Effect.sleep("2100 millis");
        tell({
          _tag: "Answer",
          ask: asked._tag === "Some" && asked.value._tag === "Ask" ? asked.value.ask : 0,
          value: [{ fact: run, seq: 0 }],
        });
        yield* Fiber.join(first);

        yield* until(() => Arr.some(heard, (one) => one._tag === "Slow"));
        const slow = Arr.findFirst(heard, (one) => one._tag === "Slow");
        expect(slow._tag === "Some" && slow.value._tag === "Slow" && slow.value.rpc).toBe(
          "runDetail",
        );
        expect(slow._tag === "Some" && slow.value._tag === "Slow" && slow.value.ms).toBeGreaterThan(
          2_000,
        );
      }).pipe(Effect.scoped),
    ),
  15_000,
);

/** A raw client of the door's socket: what it read, and its socket to stop reading or close. */
const rawClient = (socket: string) =>
  Effect.gen(function* () {
    let text = "";
    const opened = yield* Effect.promise(() =>
      Bun.connect({
        unix: socket,
        socket: {
          data: (_socket, data) => {
            text += new TextDecoder().decode(data);
          },
        },
      }),
    );
    return { socket: opened, read: () => text };
  });

const requestLine = (id: string, tag: string) =>
  `${JSON.stringify({ _tag: "Request", id, tag, payload: null, headers: [] })}\n`;

test("a client that stops reading, then goes, leaves every other client answered", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-door-" });
      const socket = `${dir}/host.sock`;
      const { heard, tell } = yield* silentEngine(dir, socket, []);
      const passed = (id: string) =>
        Arr.findFirst(
          heard,
          (one) => one._tag === "Request" && one.frame._tag === "Request" && one.frame.id === id,
        );

      // A asks the engine for a stream and never reads what it is sent.
      const a = yield* rawClient(socket);
      a.socket.pause();
      a.socket.write(requestLine("a", "toasts"));
      yield* until(() => Option.isSome(passed("a")));
      const connA = Option.getOrThrow(passed("a"));
      const b = yield* rawClient(socket);
      b.socket.write(requestLine("b", "toasts"));
      yield* until(() => Option.isSome(passed("b")));
      const connB = Option.getOrThrow(passed("b"));
      if (connA._tag !== "Request" || connB._tag !== "Request") return;

      // The engine streams to A until its socket is full, then A goes away.
      const big = pipe("x", Str.repeat(64 * 1024));
      for (let i = 0; i < 256; i++)
        tell({
          _tag: "Response",
          conn: connA.conn,
          frame: { _tag: "Chunk", requestId: "a", values: [big] },
        });
      yield* Effect.sleep("200 millis");
      a.socket.end();
      a.socket.terminate();
      yield* Effect.sleep("200 millis");

      tell({
        _tag: "Response",
        conn: connB.conn,
        frame: { _tag: "Exit", requestId: "b", exit: { _tag: "Success", value: null } },
      });
      yield* until(() => pipe(b.read(), Str.includes('"requestId":"b"')));
      expect(pipe(b.read(), Str.includes('"_tag":"Exit"'))).toBe(true);
      b.socket.end();
    }).pipe(Effect.scoped),
  ));
