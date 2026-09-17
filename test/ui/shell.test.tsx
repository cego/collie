// What the tab is around the board: the boundary that catches a render, the screen it
// falls back to, and the one overlay the board puts up by itself.

import { expect, test } from "bun:test";
import { Effect } from "effect";
import { createSignal, ErrorBoundary } from "solid-js";
import { testRender } from "@opentui/solid";
import { runEffect } from "../support/effect";
import { App } from "../../src/ui/App";
import { StoppedDrawing } from "../../src/ui/bridge";
import type { AppState, Command } from "../../src/ui/state";
import type { WorkspaceView } from "../../src/workspace";

const NOW = Date.parse("2026-09-16T12:00:00.000Z");

function board(over: Partial<WorkspaceView> = {}): WorkspaceView {
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
    ...over,
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

const mount = Effect.fn("shell.mount")(function* (initial: AppState) {
  const [state, setState] = createSignal<AppState>(initial);
  const commands: Command[] = [];
  const t = yield* Effect.promise(() =>
    testRender(() => <App state={state} dispatch={(c) => commands.push(c)} />, {
      width: 100,
      height: 30,
    }),
  );
  const flush = Effect.promise(() => t.flush());
  yield* flush;
  return {
    acted: () => commands.filter((c) => c._tag !== "Select"),
    flush,
    frame: () => t.captureCharFrame(),
    mockInput: t.mockInput,
    setState: (next: AppState) =>
      Effect.andThen(
        Effect.sync(() => setState(next)),
        flush,
      ),
  };
});

function Broken() {
  throw new Error("a card rendered something impossible");
}

test("a component that throws is caught rather than taking the pane down", () =>
  runEffect(
    Effect.gen(function* () {
      const t = yield* Effect.promise(() =>
        testRender(
          () => (
            <ErrorBoundary
              fallback={(thrown: Error) => <text>{`stopped: ${thrown.message}`}</text>}
            >
              <Broken />
            </ErrorBoundary>
          ),
          { width: 60, height: 6 },
        ),
      );
      yield* Effect.promise(() => t.flush());

      // Without the boundary this throw reaches the renderer and the pane dies with it,
      // which is also how the text-view escape hatch stops being reachable.
      expect(t.captureCharFrame()).toContain("stopped: a card rendered something");
    }),
  ));

test("the render-error screen can do the one thing it offers, and gives the mouse back", () =>
  runEffect(
    Effect.gen(function* () {
      const quits: number[] = [];
      const t = yield* Effect.promise(() =>
        testRender(
          () => (
            <StoppedDrawing
              why="a card rendered something impossible"
              what="q closes this tab; reopening it starts a fresh one."
              onQuit={() => quits.push(1)}
            />
          ),
          { width: 70, height: 6 },
        ),
      );
      yield* Effect.promise(() => t.flush());

      expect(t.captureCharFrame()).toContain("Collie stopped drawing");
      // `App`'s handler is gone by the time this is on screen — `useKeyboard` removes it
      // in `onCleanup` — so a `q` that only App implemented left the pane stuck until it
      // was killed from outside. This screen registers its own.
      t.mockInput.pressKey("q");
      yield* Effect.promise(() => t.flush());
      expect(quits).toHaveLength(1);

      t.mockInput.pressCtrlC();
      yield* Effect.promise(() => t.flush());
      expect(quits).toHaveLength(2);

      // And `App`'s `onBlur` went with it, which left the mouse captured and took
      // copy-and-paste out of every other herdr pane.
      expect(t.renderer.useMouse).toBe(false);
    }),
  ));

test("there is no composer to find: the conversation is the pane beside this one", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState());
      expect(app.frame()).not.toContain("to ask");

      app.mockInput.pressKey(":");
      yield* app.flush;
      expect(app.acted()).toEqual([]);
    }),
  ));

test("a proposal that has appeared is drawn, and Enter confirms exactly what is on it", () =>
  runEffect(
    Effect.gen(function* () {
      const proposal = {
        kind: "proposal" as const,
        id: "p1",
        content_hash: "deadbeef",
        interpretation: "You want the implementer to slow down.",
        targets: [{ run: "r1" }],
        actions: [{ kind: "hold" as const, run: "r1" }],
        allowed_now: [],
        created_at: "2026-09-16T12:00:00.000Z",
        expires_at: "2026-09-16T12:30:00.000Z",
        intent_versions: { r1: 1 },
        by: "board",
        state: "pending" as const,
      };
      const live = {
        run: "r1",
        cards: [],
        drift: [],
        deliveries: [],
        proposals: [proposal],
        pending: [],
        ownership: null,
        news: { waiting: 0, uncertain: 0 },
      };
      const app = yield* mount(appState({ live }));

      // Drawn without being asked for: a proposal waiting on an answer is the board
      // telling the human it is waiting, and it takes no pane focus to do it.
      expect(app.acted()).toEqual([{ _tag: "Preview", id: "p1" }]);
      yield* app.setState(appState({ live, previewing: "p1" }));
      expect(app.frame()).toContain("You want the implementer to slow down.");

      app.mockInput.pressEnter();
      yield* app.flush;
      expect(app.acted().at(-1)).toEqual({
        _tag: "ConfirmProposal",
        id: "p1",
        hash: "deadbeef",
      });
    }),
  ));
