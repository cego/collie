// The grace before a stop: the board marks the run and holds it, and only when the five
// seconds are up does the Driver hear anything at all. Driven through the bridge, which
// is where the waiting happens — an undo that raced a signal already sent would not be
// an undo.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { Rig } from "../support/recorder";
import { runEffect } from "../support/effect";
import { driveBridge } from "../../src/ui/bridge";
import type { AppState, Command } from "../../src/ui/state";

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
  now: Date.parse("2026-09-16T12:00:00.000Z"),
  density: "comfortable",
  wide: null,
  board: {
    repo: "collie",
    cwd: "/w/collie",
    worktrees: [],
    behind: null,
    now: 0,
    agents: [],
    extraAgents: 0,
    active: [],
    recent: [],
  },
  note: null,
  history: null,
  definitions: null,
  settings: null,
  detail: null,
  marks: {},
  live: null,
  previewing: null,
  stopping: [],
};

/** Waits for something the fibers do, rather than for a duration. */
const until = Effect.fn("stop.until")(function* (what: string, ready: () => boolean) {
  for (let tries = 0; tries < 200; tries++) {
    if (ready()) return;
    yield* Effect.sleep("5 millis");
  }
  return yield* Effect.fail(new Error(`${what} never happened`));
});

/** A bridge that records what was asked of it, with a grace short enough to wait out. */
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
        // The mark goes when the stop does: what is on the board is what has not been sent.
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

        // Well past when it would have gone, and it never did.
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

        expect(acted.map((command) => command._tag === "StopRun" && command.runId).sort()).toEqual([
          "run:a",
          "run:b",
          "run:c",
        ]);
        expect(driven.state().stopping).toEqual([]);
      }),
    ),
  ));
