// The herdr sessions a host reads, and what tells it that one of them changed.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { type Duration, Effect, Option, Stream } from "effect";
import { Herdr } from "../src/herdr";
import { herdChanges } from "../src/herds";
import { newTask, readTask, writeTask } from "../src/task";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";

let rig: Rig;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      yield* rig.startSocket();
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      delete Bun.env.FAKE_HERDR_PUSH_EVENT;
      yield* rig.close();
    }),
  ),
);

const changeAfter = (wait: Duration.Input) =>
  Effect.gen(function* () {
    const env = rig.pluginEnv();
    const herdr = new Herdr(env);
    yield* herdr.cli(["agent", "start", "impl-1", "--pane", "1-1"]);
    return yield* herdChanges(herdr, env).pipe(Stream.runHead, Effect.timeoutOption(wait));
  });

test("a change is what herdr pushes on the session's subscription, for each agent's pane", () =>
  runEffect(
    Effect.gen(function* () {
      Bun.env.FAKE_HERDR_PUSH_EVENT = "1";
      expect(Option.isSome(yield* changeAfter("10 seconds"))).toBe(true);

      const subscribed = (yield* rig.calls()).find((call) => call.cmd === "events.subscribe");
      expect(subscribed?.params).toEqual({
        subscriptions: [
          { type: "pane.created" },
          { type: "pane.closed" },
          { type: "pane.agent_detected" },
          { type: "pane.agent_status_changed", pane_id: "1-1" },
        ],
      });
    }),
  ));

test("a session herdr says nothing about is not a change", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* changeAfter("1 second")).toEqual(Option.none());
    }),
  ));

test("a new Task records its Herd, and one recorded before the field still loads", () =>
  runEffect(
    Effect.gen(function* () {
      const task = yield* newTask({ workspace: "w1", label: "a | b", cwd: "/p", herd: "herd-1" });
      yield* writeTask(rig.stateDir, task);
      expect((yield* readTask(rig.stateDir, task.id))?.herd).toBe("herd-1");

      const { herd: _, ...older } = { ...task, id: "task-old" };
      yield* writeTask(rig.stateDir, older);
      const read = yield* readTask(rig.stateDir, "task-old");
      expect(read?.label).toBe("a | b");
      expect(read?.herd).toBeUndefined();
    }),
  ));
