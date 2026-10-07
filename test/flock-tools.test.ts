// Desktop's Flock chat calls the same Collie tools Native chat does, answered by each
// Machine's host over its `chat` channel, with everything named `<machine>:<id>`.

import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { type BoardMessage, type Declaration, PROTOCOL, type TaskView } from "../src/board-model";
import type { JsonObject } from "../src/schema";
import { callFlockTool, type ChatDoor, type ChatMachine } from "../desktop/src/bun/flock-tools";
import { task } from "./support/task";

interface Asked {
  readonly machine: string;
  readonly op: string;
  readonly payload: unknown;
}

const snapshot = (tasks: ReadonlyArray<TaskView>, protocol: number): BoardMessage => ({
  _tag: "Snapshot",
  installation: "i",
  build: "0.32.0",
  protocol,
  herds: [{ id: "h1" }],
  tasks,
  seq: 0,
});

/** A host that answers from its board and writes down every operation it is asked. */
const machine = (
  name: string,
  tasks: ReadonlyArray<TaskView>,
  asked: Asked[],
  protocol = PROTOCOL,
): ChatMachine => {
  const note = <P>(op: string, payload: P) => asked.push({ machine: name, op, payload });
  const door: ChatDoor = {
    board: () => Stream.make(snapshot(tasks, protocol)).pipe(Stream.concat(Stream.never)),
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
    read: (payload) =>
      Effect.sync(() => {
        note("read", payload);
        return `${payload.tool} answered by ${name}`;
      }),
  };
  return { name, door };
};

let saved: string | undefined;
const savedRule = () => saved;

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
  machineRule: () => saved,
  setMachineRule: (rule: string) => Effect.sync(() => (saved = rule)),
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

test("a Machine whose host is older than the Flock chat is written to by nothing, and says why", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const flock = {
        machines: () => [machine("old-pc", [task({ id: "t-a", run: "r-1" })], asked, 1)],
        conversation: "flock@mk-pc",
        machineRule: () => undefined,
        setMachineRule: () => Effect.void,
        said: () => "hold it",
      };
      const hold = yield* callFlockTool(flock, "collie_hold", {
        run: "old-pc:r-1",
      });
      const news = yield* callFlockTool(flock, "collie_news", {});
      expect(asked).toEqual([]);
      expect(hold).toContain("upgrade Collie on old-pc");
      expect(news).toContain("upgrade Collie on old-pc");
    }).pipe(Effect.provide(BunServices.layer)),
  ));

test("a Machine that stops answering costs a look for News its time, and the others still speak", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const wedged = machine("vm-mk", [], asked);
      const flock = {
        machines: () => [
          machine("mk-pc", [], asked),
          { ...wedged, door: { ...wedged.door, news: () => Effect.never } },
        ],
        conversation: "flock@mk-pc",
        machineRule: () => undefined,
        setMachineRule: () => Effect.void,
        said: () => undefined,
      };
      const looking = yield* callFlockTool(flock, "collie_news", {}).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      const said = yield* Fiber.join(looking);
      expect(said).toContain("[consequential] mk-pc:r-1");
      expect(said).toContain("vm-mk's News could not be read");
    }).pipe(Effect.provide([BunServices.layer, TestClock.layer()])),
  ));

test("a Machine whose board could not be read is written to by nothing, and a bare id it may have is not taken as unique", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const unreadable = machine("vm-mk", [], asked);
      const flock = {
        machines: () => [
          machine("mk-pc", [task({ id: "t-a", run: "r-1", runs: ["r-1"] })], asked),
          { ...unreadable, door: { ...unreadable.door, board: () => Stream.empty } },
        ],
        conversation: "flock@mk-pc",
        machineRule: () => undefined,
        setMachineRule: () => Effect.void,
        said: () => "hold it",
      };
      const bare = yield* callFlockTool(flock, "collie_hold", { run: "r-1" });
      const named = yield* callFlockTool(flock, "collie_hold", { run: "vm-mk:r-1" });
      expect(bare).toContain("vm-mk could not be read");
      expect(bare).toContain("mk-pc:r-1");
      expect(named).toContain("its board could not be read");
      expect(asked).toEqual([]);
    }).pipe(Effect.provide(BunServices.layer)),
  ));

const reads = (asked: Asked[]) =>
  asked.filter(({ op }) => op === "read").map(({ machine, payload }) => ({ machine, payload }));

test("a Run named on a Machine is read by that Machine's host, under its own id, and headed with its name", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const said = yield* call(asked, "collie_run", { run: "vm-mk:r-2" });
      expect(reads(asked)).toEqual([
        { machine: "vm-mk", payload: { tool: "collie_run", input: { run: "r-2" } } },
      ]);
      expect(said).toBe("## vm-mk\n\ncollie_run answered by vm-mk");
    }),
  ));

test("a bare id only one Machine has is read there", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const said = yield* call(asked, "collie_receipts", { run: "r-2" });
      expect(reads(asked)).toEqual([
        { machine: "vm-mk", payload: { tool: "collie_receipts", input: { run: "r-2" } } },
      ]);
      expect(said).toStartWith("## vm-mk");
      // Ambiguous still refuses, asking nothing.
      const both: Asked[] = [];
      expect(yield* call(both, "collie_run", { run: "r-1" })).toContain(
        "is on more than one Machine",
      );
      expect(reads(both)).toEqual([]);
    }),
  ));

test("where work can start is every Machine's own answer, a section each, and a naming rule with no example path", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const said = yield* call(asked, "collie_workspaces", {});
      expect(
        reads(asked)
          .map(({ machine }) => machine)
          .sort(),
      ).toEqual(["mk-pc", "vm-mk"]);
      expect(said).toContain("## mk-pc\n\ncollie_workspaces answered by mk-pc");
      expect(said).toContain("## vm-mk\n\ncollie_workspaces answered by vm-mk");
      expect(said).toContain("as <machine>: followed by a workspace id");
      expect(said).not.toContain("/home/");
    }),
  ));

test("a Machine whose host cannot answer a read is told to upgrade, and the rest still answer", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const old = machine("vm-mk", [], asked);
      const flock = {
        machines: () => [
          machine("mk-pc", [], asked),
          { ...old, door: { ...old.door, read: () => Effect.never } },
        ],
        conversation: "flock@mk-pc",
        said: () => undefined,
        machineRule: () => undefined,
        setMachineRule: () => Effect.void,
      };
      const reading = yield* callFlockTool(flock, "collie_workspaces", {}).pipe(Effect.forkChild);
      yield* TestClock.adjust("1 minute");
      const said = yield* Fiber.join(reading);
      expect(said).toContain("upgrade Collie on vm-mk");
      expect(said).toContain("collie_workspaces answered by mk-pc");
    }).pipe(Effect.provide([BunServices.layer, TestClock.layer()])),
  ));

test("the Machine rule is read back as saved, and replaced with what the human asked for", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      saved = undefined;
      expect(yield* call([], "collie_machine_rule", {})).toBe(
        "There is no Machine rule: the human has not said which Machine work goes to.",
      );
      expect(
        yield* call([], "collie_machine_rule", { rule: " Frontend work is on the laptop\n" }),
      ).toBe('The Machine rule is now: "Frontend work is on the laptop"');
      expect(savedRule()).toBe("Frontend work is on the laptop");
      expect(yield* call([], "collie_machine_rule", {})).toBe(
        'The Machine rule is: "Frontend work is on the laptop"',
      );
      expect(yield* call([], "collie_machine_rule", { rule: "" })).toBe(
        "The Machine rule is cleared.",
      );
      expect(savedRule()).toBe("");
    }),
  ));

test("a start that names no Machine while several are reachable is still refused, rule or no rule", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      saved = "Everything is on the vm";
      const asked: Asked[] = [];
      const said = yield* call(asked, "collie_do", {
        actions: [{ kind: "start", workflow: "plan", inputs: {} }],
      });
      expect(said).toBe("start: failed — name the Machine it is for, as <machine>:<workspace>");
      expect(asked).toEqual([]);
      saved = undefined;
    }),
  ));

test("a Machine whose Collie has no such operation is told to upgrade, and the rest still answer", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const asked: Asked[] = [];
      const old = machine("vm-mk", [], asked);
      const flock = {
        machines: () => [
          machine("mk-pc", [], asked),
          { ...old, door: { ...old.door, read: () => Effect.die("Unknown request tag: read") } },
        ],
        conversation: "flock@mk-pc",
        said: () => undefined,
        machineRule: () => undefined,
        setMachineRule: () => Effect.void,
      };
      const said = yield* callFlockTool(flock, "collie_workspaces", {});
      expect(said).toContain("upgrade Collie on vm-mk");
      expect(said).toContain("collie_workspaces answered by mk-pc");
    }).pipe(Effect.provide(BunServices.layer)),
  ));
