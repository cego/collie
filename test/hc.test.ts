import * as Arr from "effect/Array";
import { describe, expect, test } from "bun:test";
import { Effect, type Schema } from "effect";
import { applyNote, connect, snapshotOf, type HcNote, type HcTerminal } from "../src/hc";
import { runEffect } from "./support/effect";
import { jsonText } from "./support/hc-schema";
import { Rig } from "./support/recorder";

const terminal = (address: string, fields: Partial<HcTerminal> = {}): HcTerminal => ({
  address,
  labels: {},
  argv: ["sh"],
  cwd: "/",
  state: "live",
  created_ms: 1,
  cols: 80,
  rows: 24,
  ...fields,
});

const event = (seq: number, type: string, at: string, data: Schema.Json): HcNote => ({
  method: "event",
  params: { seq, type, terminal: at, data },
});

describe("the events snapshot", () => {
  test("an event at or below the snapshot's seq is dropped", () => {
    const start = snapshotOf({ seq: 5, terminals: [terminal("t1")] });
    const stale = applyNote(start, event(5, "finished", "t1", { reason: "exited", exit_code: 0 }));
    expect(stale.terminals.get("t1")?.state).toBe("live");
    const fresh = applyNote(
      stale,
      event(6, "finished", "t1", { reason: "exited", exit_code: 0, finished_ms: 9 }),
    );
    expect(fresh.terminals.get("t1")).toMatchObject({
      state: "finished",
      exit_code: 0,
      finished_ms: 9,
    });
    expect(fresh.seq).toBe(6);
  });

  test("missed replaces the snapshot, and only events above it apply", () => {
    const start = snapshotOf({ seq: 5, terminals: [terminal("t1"), terminal("t2")] });
    const missed = applyNote(start, {
      method: "missed",
      params: { seq: 20, terminals: [terminal("t3")] },
    });
    expect([...missed.terminals.keys()]).toEqual(["t3"]);
    const after = applyNote(missed, event(19, "removed", "t3", {}));
    expect([...after.terminals.keys()]).toEqual(["t3"]);
  });

  test("a status event replaces the status, and a turn event sets only the turn", () => {
    const start = snapshotOf({ seq: 0, terminals: [terminal("t1")] });
    const blocked = applyNote(
      start,
      event(1, "status", "t1", {
        status: { state: "blocked", kind: "question" },
        records: {},
        reported: true,
      }),
    );
    const turned = applyNote(blocked, event(2, "turn", "t1", { turn: 3, state: "idle" }));
    expect(turned.terminals.get("t1")).toMatchObject({
      state: "live",
      turn: 3,
      status: { state: "blocked", kind: "question" },
    });
  });
});

describe("the fake core", () => {
  test("answers the client, recording each call in the rig's log", () =>
    runEffect(
      Effect.gen(function* () {
        const rig = yield* Rig.scoped();
        const core = yield* rig.startCore();
        const hc = yield* connect(core.socketPath);
        yield* hc.call("hello", { generation: 1 });
        const run = yield* hc.call("terminal.run", { argv: ["claude"], name: "impl-1", cwd: "/w" });
        const list = yield* hc.call("terminal.list", {});
        expect(Arr.map(list.terminals, (t) => [t.address, t.name])).toEqual([
          [run.address, "impl-1"],
        ]);
        const calls = yield* rig.calls();
        expect(Arr.map(calls, (call) => [call.transport, call.cmd])).toEqual([
          ["core", "hello"],
          ["core", "terminal.run"],
          ["core", "terminal.list"],
        ]);
      }).pipe(Effect.scoped, Effect.orDie),
    ));

  test("a reply the schema forbids fails the call that caused it, naming the reply", () =>
    runEffect(
      Effect.gen(function* () {
        const rig = yield* Rig.scoped();
        const core = yield* rig.startCore();
        const { address: _, ...nameless } = terminal("t1");
        core.answer("terminal.get", nameless);
        const hc = yield* connect(core.socketPath);
        const error = yield* hc.call("terminal.get", { terminal: "t1" }).pipe(Effect.flip);
        expect(error.message).toContain(`terminal.get ${jsonText(nameless)}`);
        expect(error.message).toContain('["address"]');
      }).pipe(Effect.scoped, Effect.orDie),
    ));
});
