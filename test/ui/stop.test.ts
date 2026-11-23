import * as Cause from "effect/Cause";

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { Rig } from "../support/recorder";
import { runEffect } from "../support/effect";
import { driveBridge } from "../../src/ui/bridge";
import type { AppState, Command } from "../../src/ui/state";
import { epochMs } from "../../src/time";

let rig: Rig;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

const EMPTY: AppState = {
  view: "runs",
  filter: { kind: "workspace", id: "w1" },
  tasks: [],
  now: epochMs("2026-09-16T12:00:00.000Z"),
  density: "comfortable",
  note: null,
  history: null,
  definitions: null,
  settings: null,
  detail: null,
  live: null,
  previewing: null,
  stopping: [],
};

const until = Effect.fn("stop.until")(function* (what: string, ready: () => boolean) {
  for (let tries = 0; tries < 200; tries++) {
    if (ready()) return;
    yield* Effect.sleep("5 millis");
  }
  return yield* new Cause.TimeoutError(`${what} never happened`);
});

function held(acted: Command[], graceMs = 80) {
  return {
    filter: { kind: "workspace", id: "w1" } as const,
    origin: "w1",
    stateDir: rig.stateDir,
    graceMs,
    load: () => Effect.succeed(EMPTY),
    act: (command: Command) =>
      Effect.sync(() => {
        acted.push(command);
        return "stopped it";
      }),
  };
}

test("a stop is marked on the board and nothing is sent until the grace is up", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const acted: Command[] = [];
        const driven = yield* driveBridge(held(acted));

        driven.dispatch({ _tag: "StopRun", runId: "run:a" });
        yield* until("the mark", () => driven.state().stopping.includes("run:a"));
        expect(acted).toEqual([]);

        yield* until("the stop to be sent", () => acted.length === 1);
        expect(acted).toEqual([{ _tag: "StopRun", runId: "run:a" }]);
        // WARNING: the mark goes when the stop does; what is on the board is what has not been sent.
        expect(driven.state().stopping).toEqual([]);
      }),
    ),
  ));

test("undo inside the grace sends nothing at all", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const acted: Command[] = [];
        const driven = yield* driveBridge(held(acted));

        driven.dispatch({ _tag: "StopRun", runId: "run:a" });
        yield* until("the mark", () => driven.state().stopping.includes("run:a"));
        driven.dispatch({ _tag: "UndoStop" });
        yield* until("the mark to go", () => driven.state().stopping.length === 0);

        yield* Effect.sleep("200 millis");
        expect(acted).toEqual([]);
      }),
    ),
  ));

test("stopping three at once holds all three, and undo takes back all three", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const acted: Command[] = [];
        const driven = yield* driveBridge(held(acted));

        for (const runId of ["run:a", "run:b", "run:c"])
          driven.dispatch({ _tag: "StopRun", runId });
        yield* until("all three marks", () => driven.state().stopping.length === 3);
        expect(acted).toEqual([]);

        driven.dispatch({ _tag: "UndoStop" });
        yield* until("the marks to go", () => driven.state().stopping.length === 0);
        yield* Effect.sleep("200 millis");
        expect(acted).toEqual([]);
      }),
    ),
  ));

test("three stops nobody took back are three stops", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const acted: Command[] = [];
        const driven = yield* driveBridge(held(acted));

        for (const runId of ["run:a", "run:b", "run:c"])
          driven.dispatch({ _tag: "StopRun", runId });
        yield* until("all three stops", () => acted.length === 3);

        const stopped = Arr.map(acted, (command) =>
          command._tag === "StopRun" ? command.runId : "",
        );
        expect(stopped.sort((a, b) => pipe(a, Str.localeCompare(b)))).toEqual([
          "run:a",
          "run:b",
          "run:c",
        ]);
        expect(driven.state().stopping).toEqual([]);
      }),
    ),
  ));
