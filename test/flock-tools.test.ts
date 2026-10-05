// Desktop's Flock chat calls the same Collie tools Native chat does, answered by each
// Machine's host over its `chat` channel, with everything named `<machine>:<id>`.

import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Stream } from "effect";
import type { BoardMessage, Declaration, TaskView } from "../src/board-model";
import type { JsonObject } from "../src/schema";
import { callFlockTool, type ChatDoor, type ChatMachine } from "../desktop/src/bun/flock-tools";
import { task } from "./support/task";

interface Asked {
  readonly machine: string;
  readonly op: string;
  readonly payload: unknown;
}

const snapshot = (tasks: ReadonlyArray<TaskView>): BoardMessage => ({
  _tag: "Snapshot",
  installation: "i",
  build: "0.32.0",
  protocol: 1,
  herds: [{ id: "h1" }],
  tasks,
  seq: 0,
});

/** A host that answers from its board and writes down every operation it is asked. */
const machine = (name: string, tasks: ReadonlyArray<TaskView>, asked: Asked[]): ChatMachine => {
  const note = <P>(op: string, payload: P) => asked.push({ machine: name, op, payload });
  const door: ChatDoor = {
    board: () => Stream.make(snapshot(tasks)).pipe(Stream.concat(Stream.never)),
    declare: (payload: Declaration) =>
      Effect.sync(() => {
        note("declare", payload);
      }),
    act: (payload) =>
      Effect.sync(() => {
        note("act", payload);
        return [{ kind: "stop", state: "applied", note: "" }];
      }),
    control: (payload) =>
      Effect.sync(() => {
        note("control", payload);
        return {
          runId: payload.runId,
          control: payload.control,
          set: payload.set,
          applied: true,
          detail: `Held ${payload.runId}`,
          left: [],
        };
      }),
    confirm: (payload) =>
      Effect.sync(() => {
        note("confirm", payload);
        return { proposal: payload.proposal, results: [] };
      }),
    decline: (payload) =>
      Effect.sync(() => {
        note("decline", payload);
        return { proposal: payload.proposal };
      }),
    dispose: (payload) =>
      Effect.sync(() => {
        note("dispose", payload);
        return { at: "", by: "chat", kind: payload.kind, ref: payload.ref, note: null };
      }),
    propose: (payload) =>
      Effect.sync(() => {
        note("propose", payload);
        return { ok: true, code: null, human: "Carried out.", data: null };
      }),
    news: (payload) =>
      Effect.sync(() => {
        note("news", payload);
        return {
          items: [
            {
              key: "k1",
              run: "r-1",
              text: "r-1 finished.",
              at: "",
              significance: "consequential" as const,
            },
          ],
          omitted: 0,
        };
      }),
    runDetail: () => Stream.make(null),
    workflows: () => Effect.succeed([]),
  };
  return { name, door };
};

const flockOf = (asked: Asked[]) => ({
  machines: () => [
    machine("mk-pc", [task({ id: "t-a", run: "r-1", runs: ["r-1"] })], asked),
    machine(
      "vm-mk",
      [
        task({ id: "t-b", run: "r-2", runs: ["r-2"], name: "Fix board bugs" }),
        task({ id: "t-c", run: "r-1", runs: ["r-1"] }),
      ],
      asked,
    ),
  ],
  conversation: "flock@mk-pc",
  said: () => "stop the board bugs one",
});

const call = (asked: Asked[], name: string, input: JsonObject) =>
  callFlockTool(flockOf(asked), name, input).pipe(Effect.provide(BunServices.layer));

test("collie_herd is every Machine's board, each Run named by its Machine", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const said = yield* call([], "collie_herd", {});
      expect(said).toContain("run mk-pc:r-1:");
      expect(said).toContain("run vm-mk:r-2: Fix board bugs");
      expect(said).toContain("run vm-mk:r-1:");
    }),
  ));

test("a bare id only one Machine has acts there, under its own id, in the human's words", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const said = yield* call(asked, "collie_do", { actions: [{ kind: "stop", run: "r-2" }] });
      expect(said).toBe("stop: applied");
      expect(asked.map(({ machine, op }) => `${machine} ${op}`)).toEqual([
        "vm-mk declare",
        "vm-mk act",
      ]);
      expect(asked[0]!.payload).toEqual({
        frontDoor: "chat",
        conversation: "flock@mk-pc",
        said: "stop the board bugs one",
      });
      expect(asked[1]!.payload).toMatchObject({ actions: [{ kind: "stop", run: "r-2" }] });
    }),
  ));

test("an id two Machines have is refused with both candidates, and nothing is done", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const said = yield* call(asked, "collie_do", { actions: [{ kind: "stop", run: "r-1" }] });
      expect(said).toContain("mk-pc:r-1");
      expect(said).toContain("vm-mk:r-1");
      expect(asked).toEqual([]);
    }),
  ));

test("a Run named with its Machine goes to that Machine", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      yield* call(asked, "collie_hold", { run: "mk-pc:r-1", reason: "lunch" });
      expect(asked.map(({ machine, op }) => `${machine} ${op}`)).toEqual([
        "mk-pc declare",
        "mk-pc control",
      ]);
      expect(asked[1]!.payload).toMatchObject({
        runId: "r-1",
        control: "hold",
        set: true,
        reason: "lunch",
      });
    }),
  ));

test("a proposal's actions go to the one Machine they name, with their own ids", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const said = yield* call(asked, "collie_propose", {
        interpretation: "release it",
        actions: [{ kind: "release", run: "vm-mk:r-1" }],
        request_id: "req-1",
      });
      expect(said).toBe("Request: req-1\nCarried out.");
      expect(asked.at(-1)).toEqual({
        machine: "vm-mk",
        op: "propose",
        payload: {
          herd: null,
          interpretation: "release it",
          actions: [{ kind: "release", run: "r-1" }],
          request: "req-1",
        },
      });
    }),
  ));

test("input a tool does not take is refused in the tool's own terms", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const said = yield* call([], "collie_do", {
        actions: [{ kind: "stop", run: "r-2", goal: "x" }],
      });
      expect(said).toContain("refused the request (InvalidInput)");
      expect(said).toContain("does not take goal");
    }),
  ));

test("News is read from every Herd on every Machine, and only what was handed over is settled", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const said = yield* call(asked, "collie_news", {});
      expect(said).toContain("[consequential] mk-pc:r-1");
      expect(said).toContain("[consequential] vm-mk:r-1");
      const reads = asked.filter(({ op }) => op === "news");
      expect(reads.map(({ machine, payload }) => [machine, payload])).toEqual([
        ["mk-pc", expect.objectContaining({ herd: "h1", as: "sent", keys: [] })],
        ["vm-mk", expect.objectContaining({ herd: "h1", as: "sent", keys: [] })],
        ["mk-pc", expect.objectContaining({ herd: "h1", as: "read", keys: ["k1"] })],
        ["vm-mk", expect.objectContaining({ herd: "h1", as: "read", keys: ["k1"] })],
      ]);
    }),
  ));

test("a Machine nobody has is said to be no Machine, and nothing is done", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const said = yield* call(asked, "collie_hold", { run: "vm-typo:r-2" });
      expect(said).toContain('No Machine "vm-typo"');
      expect(said).toContain("mk-pc, vm-mk");
      expect(asked).toEqual([]);
    }),
  ));
