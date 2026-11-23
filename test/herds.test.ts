import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, Fiber, Option, Stream } from "effect";
import { Herdr } from "../src/herdr";
import { agentsIn, focusPane, herdChanges } from "../src/herds";
import type { AgentEntry } from "../src/registry";
import { newTask, readTask, writeTask } from "../src/task";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";

let rig: Rig;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      yield* rig.startCore();
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

const registered: (agent: string, terminal: string) => AgentEntry = (agent, terminal) => ({
  role: "implementer",
  agent,
  paneId: terminal,
  workspaceId: null,
  runId: "r1",
  workflow: "implement",
  at: "2026-11-16T00:00:00Z",
  incarnation: { terminalId: terminal, agentSession: null, backend: "core" },
});

test("past the read it starts with, a change is what core tells of a terminal it ran", () =>
  runEffect(
    Effect.gen(function* () {
      const herdr = new Herdr(rig.pluginEnv());
      const twice = herdChanges(herdr).pipe(Stream.take(2), Stream.runCount);
      expect(yield* twice.pipe(Effect.timeoutOption("1 second"))).toEqual(Option.none());

      const next = yield* twice.pipe(Effect.timeoutOption("10 seconds"), Effect.forkChild);
      yield* Effect.sleep("300 millis");
      yield* rig.addAgent("impl-1");
      expect(yield* Fiber.join(next)).toEqual(Option.some(2));
    }),
  ));

test("a new Task records its Herd, and one recorded before the field still loads", () =>
  runEffect(
    Effect.gen(function* () {
      const task = yield* newTask({ workspace: "w1", label: "a | b", cwd: "/p", herd: "herd-1" });
      yield* writeTask(task);
      expect((yield* readTask(task.id))?.herd).toBe("herd-1");

      const { herd: _, ...older } = { ...task, id: "task-old" };
      yield* writeTask(older);
      const read = yield* readTask("task-old");
      expect(read?.label).toBe("a | b");
      expect(read?.herd).toBeUndefined();
    }),
  ));

test("a Run's pane is the terminal of the first agent asked for that core still has", () =>
  runEffect(
    Effect.gen(function* () {
      const sessions = [{ herd: null, herdr: new Herdr(rig.pluginEnv()) }];
      const impl = yield* rig.addAgent("impl-1");
      const review = yield* rig.addAgent("review-1");
      const absent = registered("impl-2", "missing");
      const builder = registered("impl-1", impl);
      const reviewer = registered("review-1", review);

      expect(yield* focusPane(sessions, [absent, reviewer, builder])).toEqual({
        session: null,
        workspace: "review-1",
        tab: null,
        pane: review,
        agent: "review-1",
        core: review,
      });
      expect((yield* focusPane(sessions, [builder]))?.core).toBe(impl);
      expect(yield* focusPane(sessions, [absent])).toBeNull();
      expect(
        yield* focusPane(sessions, [
          { ...builder, incarnation: { terminalId: "old", agentSession: null, backend: "core" } },
        ]),
      ).toBeNull();
    }),
  ));

test("Go to pane on a Run whose builder work moved on opens the live builder's pane, and delivery's once it takes over", () =>
  runEffect(
    Effect.gen(function* () {
      const sessions = [{ herd: null, herdr: new Herdr(rig.pluginEnv()) }];
      const first = registered("build-r1", "ended-1");
      const second = yield* rig.addAgent("build-02-r1");
      // Newest first, as the host asks.
      expect((yield* focusPane(sessions, [registered("build-02-r1", second), first]))?.core).toBe(
        second,
      );
      const deliver = yield* rig.addAgent("deliver-r1");
      expect(
        (yield* focusPane(sessions, [
          registered("deliver-r1", deliver),
          registered("build-02-r1", "ended-2"),
          first,
        ]))?.core,
      ).toBe(deliver);
    }),
  ));

test("a core that does not answer has no agents, and no pane to go to", () =>
  runEffect(
    Effect.gen(function* () {
      const terminal = yield* rig.addAgent("impl-1");
      const sessions = [
        { herd: null, herdr: new Herdr(rig.pluginEnv({ HC_SOCKET: `${rig.root}/gone.sock` })) },
      ];

      expect(yield* agentsIn(sessions)).toEqual({ alive: [] });
      expect(yield* focusPane(sessions, [registered("impl-1", terminal)])).toBeNull();
    }),
  ));
