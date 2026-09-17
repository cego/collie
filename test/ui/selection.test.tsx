// What the board has selected, told to the other half of the Home. Driven the way a human
// drives it — a click on a card, Esc to close it — with the real bridge behind the real
// board, because the promise is that chat can read what is on screen and nothing less.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { testRender } from "@opentui/solid";
import { runEffect } from "../support/effect";
import { Rig } from "../support/recorder";
import { task } from "../support/task";
import { App } from "../../src/ui/App";
import { driveBridge } from "../../src/ui/bridge";
import type { Command } from "../../src/ui/state";
import type { AppState } from "../../src/ui/state";
import { readSelection, selectionPath, writeSelection } from "../../src/selection";
import { NO_OUTCOME, type WorkspaceView } from "../../src/workspace";

const NOW = Date.parse("2026-09-16T12:00:00.000Z");
const KEY = "herd-key";

let rig: Rig;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

function board(): WorkspaceView {
  return {
    repo: "collie",
    cwd: "/w/collie",
    worktrees: [],
    behind: null,
    now: NOW,
    agents: [],
    extraAgents: 0,
    active: [],
    recent: [],
    ...NO_OUTCOME,
  };
}

function appState(over: Partial<AppState> = {}): AppState {
  return {
    view: "runs",
    filter: { kind: "all" },
    tasks: [],
    now: Date.parse("2026-09-16T12:00:00.000Z"),
    density: "comfortable",
    board: board(),
    wide: null,
    note: null,
    history: null,
    definitions: null,
    settings: null,
    detail: null,
    marks: {},
    live: null,
    previewing: null,
    stopping: [],
    ...over,
  };
}

/** The tab, wired to a bridge that writes the selection where chat reads it. */
const mount = Effect.fn("selection.mount")(function* (state: AppState) {
  const file = yield* selectionPath(rig.stateDir, KEY);
  const driven = yield* driveBridge({
    filter: { kind: "all" } as const,
    origin: null,
    stateDir: rig.stateDir,
    load: () => Effect.succeed(state),
    act: () => Effect.succeed(null),
    selected: (on) => writeSelection(file, on),
  });
  const t = yield* Effect.promise(() =>
    testRender(() => <App state={driven.state} dispatch={driven.dispatch} />, {
      width: 120,
      height: 40,
    }),
  );
  const settle = Effect.gen(function* () {
    yield* Effect.promise(() => t.flush());
    yield* Effect.sleep("60 millis");
    yield* Effect.promise(() => t.flush());
  });
  yield* settle;
  return {
    settle,
    dispatch: (command: Command) =>
      Effect.andThen(
        Effect.sync(() => driven.dispatch(command)),
        settle,
      ),
    selected: () => readSelection(file),
    lineOf(text: string) {
      const y = t
        .captureCharFrame()
        .split("\n")
        .findIndex((l) => l.includes(text));
      if (y < 0) throw new Error(`no line containing ${JSON.stringify(text)}`);
      return y;
    },
    click: (x: number, y: number) =>
      Effect.andThen(
        Effect.promise(() => t.mockMouse.click(x, y)),
        settle,
      ),
    escape: Effect.andThen(
      Effect.sync(() => t.mockInput.pressEscape()),
      settle,
    ),
  };
});

test("selecting a card writes what chat needs about it, and closing it clears the record", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const app = yield* mount(appState({ tasks: [task()] }));

        // Nothing is selected until something is: a board that has just opened must not
        // leave chat answering about whatever was open the last time it ran.
        expect(yield* app.selected()).toBe(null);

        yield* app.click(6, app.lineOf("Strapi prod seeder"));

        expect(yield* app.selected()).toEqual({
          task: "t1",
          run: "r1",
          name: "Strapi prod seeder",
        });

        yield* app.escape;

        expect(yield* app.selected()).toBe(null);
      }),
    ),
  ));

test("closing the board leaves nothing selected behind it", () =>
  runEffect(
    Effect.scoped(
      Effect.gen(function* () {
        const app = yield* mount(appState({ tasks: [task()] }));
        yield* app.click(6, app.lineOf("Strapi prod seeder"));
        expect(yield* app.selected()).not.toBe(null);

        // A board nobody has open selects nothing, and chat must not answer about a card
        // that was on screen when the tab was closed.
        yield* app.dispatch({ _tag: "Quit" });

        expect(yield* app.selected()).toBe(null);
      }),
    ),
  ));
