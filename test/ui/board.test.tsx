// The card board, driven the way a human drives it: a pane of a given width, a click on
// a card, text in the search field. Every assertion is about what the pane says and
// which command went out — never about a component's own state.

import { expect, test } from "bun:test";
import { Effect } from "effect";
import { createSignal } from "solid-js";
import { testRender } from "@opentui/solid";
import { runEffect } from "../support/effect";
import { task } from "../support/task";
import { App } from "../../src/ui/App";
import type { AppState, Command } from "../../src/ui/state";
import type { Ask, Pending } from "../../src/ui/prompts";
import type { TaskView } from "../../src/board";
import type { RunDetail } from "../../src/views";
import { NO_RUN_OUTCOME } from "../../src/views";
import type { Live } from "../../src/live";
import type { Card } from "../../src/cards";
import type { Delivery } from "../../src/steering";
import { NO_OUTCOME, type WorkspaceView } from "../../src/workspace";

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

const mount = Effect.fn("board.mount")(function* (
  initial: AppState,
  width = 120,
  height = 40,
  /** A launch flow asking inline, which is the one thing drawn over the whole board. */
  asking: Ask | null = null,
) {
  const [state, setState] = createSignal<AppState>(initial);
  const commands: Command[] = [];
  const answers: Array<string | null> = [];
  const [pending] = createSignal<Pending | null>(
    asking === null ? null : { ask: asking, answer: (value) => answers.push(value) },
  );
  const t = yield* Effect.promise(() =>
    testRender(() => <App state={state} pending={pending} dispatch={(c) => commands.push(c)} />, {
      width,
      height,
    }),
  );
  const flush = Effect.promise(() => t.flush());
  yield* flush;
  return {
    commands,
    acted: () => commands.filter((c) => c._tag !== "Select"),
    flush,
    frame: () => t.captureCharFrame(),
    /** The frame as one run of words, so a test is not a test of where a wrap fell. */
    said: () =>
      t
        .captureCharFrame()
        .replace(/[│┌┐└┘─]/g, " ")
        .replace(/\s+/g, " "),
    mockInput: t.mockInput,
    escape: Effect.gen(function* () {
      t.mockInput.pressEscape();
      yield* Effect.sleep("60 millis");
      yield* Effect.promise(() => t.flush());
    }),
    click: (x: number, y: number) =>
      Effect.andThen(
        Effect.promise(() => t.mockMouse.click(x, y)),
        flush,
      ),
    /** A click aimed at a word: how a human presses a button they can read. */
    clickOn(text: string) {
      const { x, y } = spotOf(t.captureCharFrame(), text);
      return Effect.andThen(
        Effect.promise(() => t.mockMouse.click(x, y)),
        flush,
      );
    },
    /** Shift and the left button, which is how several cards are picked at once. */
    shiftClickOn(text: string) {
      const { x, y } = spotOf(t.captureCharFrame(), text);
      return Effect.andThen(
        Effect.promise(() => t.mockMouse.click(x, y, 0, { modifiers: { shift: true } })),
        flush,
      );
    },
    /** The right button, which opens the same menu the ⋯ does. */
    rightClickOn(text: string) {
      const { x, y } = spotOf(t.captureCharFrame(), text);
      return Effect.andThen(
        Effect.promise(() => t.mockMouse.click(x, y, 2)),
        flush,
      );
    },
    /** The wheel, over whatever is under the pointer. */
    scrollAt(x: number, y: number, times = 1) {
      return Effect.gen(function* () {
        for (let n = 0; n < times; n++)
          yield* Effect.promise(() => t.mockMouse.scroll(x, y, "down"));
        yield* flush;
      });
    },
    /** Pointing at something, which is what reveals what a card can do. */
    pointAt(text: string) {
      const { x, y } = spotOf(t.captureCharFrame(), text);
      return Effect.andThen(
        Effect.promise(() => t.mockMouse.moveTo(x, y)),
        flush,
      );
    },
    /** What a word is drawn on, which is what tells a filled button from a plain one. */
    bgOf(text: string) {
      for (const line of t.captureSpans().lines) {
        for (const span of line.spans) {
          if (span.text.includes(text)) return `${span.bg.r} ${span.bg.g} ${span.bg.b}`;
        }
      }
      throw new Error(`nothing drawn containing ${JSON.stringify(text)}`);
    },
    setState: (next: AppState) =>
      Effect.andThen(
        Effect.sync(() => setState(next)),
        flush,
      ),
    /** One screen line as drawn, for aiming at a cell by what is next to it. */
    frameLine(y: number) {
      return t.captureCharFrame().split("\n")[y] ?? "";
    },
    /** Where a line is on screen, which is what a click has to be aimed at. */
    lineOf(text: string) {
      const y = t
        .captureCharFrame()
        .split("\n")
        .findIndex((l) => l.includes(text));
      if (y < 0) throw new Error(`no line containing ${JSON.stringify(text)}`);
      return y;
    },
  };
});

/** Where a word is on screen, which is what a click has to be aimed at. */
function spotOf(frame: string, text: string) {
  const lines = frame.split("\n");
  const y = lines.findIndex((line) => line.includes(text));
  if (y < 0) throw new Error(`no line containing ${JSON.stringify(text)}`);
  // The middle of the word: its own cell, whatever sits either side of it.
  return { x: lines[y]!.indexOf(text) + Math.floor(text.length / 2), y };
}

const QUESTION: TaskView["decision"] = {
  kind: "question",
  run: "r9",
  id: "c1",
  step: "review",
  topic: "the upload cap",
  text: "Maps are 13 MB per brand and Kibana caps uploads at 1 MB. Split per chunk?",
  options: [
    { id: "split", title: "Split per chunk", subtitle: null },
    { id: "one", title: "Keep one file", subtitle: null },
  ],
};

/** A question typed into rather than picked from: the Driver's `ask`, which has no items. */
const TYPED: TaskView["decision"] = {
  kind: "question",
  run: "r8",
  id: "c2",
  step: "plan",
  topic: "the seeder's name",
  text: "What should the seeder be called?",
  options: [],
};

const PROPOSAL: TaskView["decision"] = {
  kind: "proposal",
  id: "p1",
  hash: "deadbeef",
  text: "You want the implementer to slow down.",
  actions: [
    { text: "hold r1", allowed: true },
    { text: "steer r1", allowed: false },
  ],
};

const HERD = [
  task({
    id: "t0",
    name: "RUM sourcemap upload",
    project: "frontend-core",
    state: "blocked",
    decision: QUESTION,
    sentence: "Waiting on your answer about the upload cap.",
    run: "r9",
  }),
  task(),
  task({
    id: "t2",
    name: "Docs run",
    state: "quiet",
    sentence: "Building, but silent for 3 hours.",
    run: "r2",
  }),
  task({
    id: "t3",
    name: "Typecheck to zero",
    project: "backoffice-core",
    state: "done",
    sentence: "Merged as backoffice-core!151 4 hours ago.",
    run: "r3",
  }),
];

test("the board opens on three sections under one sentence about the herd", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ tasks: HERD }));
      const said = app.said();

      expect(said).toContain("collie");
      expect(said).toContain("One decision is waiting on you. 2 working, 1 gone quiet.");
      expect(said).toContain("Needs you");
      expect(said).toContain("Working · 2");
      // Finished is one line until someone asks for it.
      expect(said).toContain("1 finished today");
      expect(said).not.toContain("Typecheck to zero");
    }),
  ));

test("a working card says what it is, what is happening and where it has got to", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(
        appState({
          tasks: [
            task({
              drift: "editing src/ui/App.tsx, which is outside the slice",
              agents: [
                { name: "Implementer", status: "working", now: "Convert blocks", run: "r1" },
              ],
            }),
          ],
        }),
      );
      const said = app.said();

      expect(said).toContain("Strapi prod seeder");
      expect(said).toContain("content");
      expect(said).toContain("Fixing the review findings, round 2 of 5.");
      expect(said).toContain("editing src/ui/App.tsx, which is outside the slice");
      expect(said).toContain("review");
      expect(said).toContain("1 agent");
      expect(said).toContain("58m");
    }),
  ));

test("a decision card says what is being asked, in Needs you", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ tasks: [HERD[0]!] }));
      expect(app.said()).toContain("Kibana caps uploads at 1 MB");
    }),
  ));

test("a held task carries its line under the sentence", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ tasks: [task({ held: "⏸ Held until 14:00." })] }));
      expect(app.said()).toContain("Held until 14:00.");
    }),
  ));

test("the table's chrome is gone: no nav, no view tabs, no key footer", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ tasks: HERD }));
      const said = app.said();

      for (const gone of ["History", "Workflows", "Settings", "q close", "? keys", "Runs ·"]) {
        expect(said).not.toContain(gone);
      }
    }),
  ));

test("Finished opens to cards and closes again", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ tasks: HERD }));
      const line = app.lineOf("1 finished today");

      yield* app.click(4, line);
      expect(app.said()).toContain("Typecheck to zero");
      expect(app.said()).toContain("Finished · 1");

      yield* app.click(4, app.lineOf("Finished · 1"));
      expect(app.said()).not.toContain("Typecheck to zero");
    }),
  ));

test("earlier work is reachable on a day nothing finished", () =>
  runEffect(
    Effect.gen(function* () {
      // Working cards and nothing finished today. History is the only place this
      // checkout's earlier runs are, and the line into it is the same one.
      const app = yield* mount(appState({ tasks: [task()] }));
      expect(app.said()).toContain("Earlier work");

      yield* app.clickOn("Earlier work");
      expect(app.said()).toContain("Older…");

      // And with nothing on the board at all, the way in is still there.
      const bare = yield* mount(appState({ tasks: [] }));
      expect(bare.said()).toContain("Earlier work");
    }),
  ));

test("the search narrows the sections and offers a way back", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ tasks: HERD }));

      void app.mockInput.typeText("/");
      yield* app.flush;
      void app.mockInput.typeText("docs");
      yield* app.flush;

      expect(app.said()).toContain("Docs run");
      expect(app.said()).not.toContain("Strapi prod seeder");
      // The header counts the whole herd: a decision the search hides still waits.
      expect(app.said()).toContain("One decision is waiting on you.");

      void app.mockInput.typeText("zzzz");
      yield* app.flush;
      expect(app.said()).toContain("Nothing matches");

      yield* app.escape;
      expect(app.said()).toContain("Strapi prod seeder");
    }),
  ));

test("the grid is one column on a narrow pane and three when compact", () =>
  runEffect(
    Effect.gen(function* () {
      const many = [task({ id: "a", name: "Aaa" }), task({ id: "b", name: "Bbb" })];

      const narrow = yield* mount(appState({ tasks: many }), 70);
      expect(narrow.lineOf("Aaa")).not.toBe(narrow.lineOf("Bbb"));

      const wide = yield* mount(appState({ tasks: many }), 120);
      expect(wide.lineOf("Aaa")).toBe(wide.lineOf("Bbb"));
    }),
  ));

test("clicking a card opens its record over the board, and Esc closes it", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ tasks: HERD }));

      yield* app.click(6, app.lineOf("Strapi prod seeder"));
      expect(app.commands).toContainEqual({
        _tag: "Select",
        id: "run:r1",
        on: { task: "t1", run: "r1", name: "Strapi prod seeder" },
      });
      const open = app.said();
      expect(open).toContain("INTENT");
      expect(open).toContain("BRANCH");
      expect(open).toContain("mk/strapi-seed");
      expect(open).toContain("Close");
      // Over the board, never instead of it: the other sections are still there.
      expect(open).toContain("Needs you");

      yield* app.escape;
      expect(app.said()).not.toContain("Summary");
    }),
  ));

test("a question's options are buttons, the first one filled", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ tasks: [HERD[0]!] }));
      const said = app.said();

      expect(said).toContain("Split per chunk");
      expect(said).toContain("Keep one file");
      // Primary is the filled one, and a plain option is still drawn as a button rather
      // than as another line of the card.
      expect(app.bgOf(" Split per chunk ")).not.toBe(app.bgOf(" Keep one file "));
      expect(app.bgOf(" Keep one file ")).not.toBe(app.bgOf("Waiting on your answer"));
    }),
  ));

test("clicking an option answers that question, and the board recounts", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ tasks: [HERD[0]!, HERD[1]!] }));

      yield* app.clickOn("Keep one file");
      expect(app.acted()).toEqual([{ _tag: "Answer", runId: "r9", choiceId: "c1", value: "one" }]);
      // A button is a button: pressing it must not also open the record behind it.
      expect(app.said()).not.toContain("Summary");

      yield* app.setState(
        appState({
          tasks: [
            task({
              id: "t0",
              name: "RUM sourcemap upload",
              project: "frontend-core",
              sentence: "Resumed with “Keep one file”.",
              run: "r9",
            }),
            HERD[1]!,
          ],
        }),
      );
      const after = app.said();
      expect(after).toContain("Nothing needs you. 2 working.");
      expect(after).not.toContain("Needs you");
      expect(after).toContain("Resumed with “Keep one file”.");
      expect(after).toContain("Working · 2");
    }),
  ));

test("a question with no options is typed into on the card, and Enter sends it", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(
        appState({
          tasks: [task({ id: "t8", state: "blocked", decision: TYPED, run: "r8" })],
        }),
      );

      expect(app.said()).toContain("What should the seeder be called?");
      yield* app.clickOn("type your answer");

      // Including the keys the board itself uses: while a card is being typed into,
      // `q` is a letter of the answer and `/` is not the search.
      void app.mockInput.typeText("queue it under /tmp");
      yield* app.flush;
      expect(app.said()).toContain("queue it under /tmp");
      // Nothing leaves the tab until it is sent: half an answer is not an answer.
      expect(app.acted()).toEqual([]);

      app.mockInput.pressEnter();
      yield* app.flush;
      expect(app.acted()).toEqual([
        { _tag: "Answer", runId: "r8", choiceId: "c2", value: "queue it under /tmp" },
      ]);
    }),
  ));

test("clicking the search takes the keyboard off whatever had it", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(
        appState({
          tasks: [task({ id: "t8", state: "blocked", decision: TYPED, run: "r8" })],
        }),
      );

      yield* app.clickOn("type your answer");
      yield* app.clickOn("⌕");

      // The field they clicked is the field they are typing into: an answer that
      // swallowed this would send the search to a Run.
      void app.mockInput.typeText("Alpha");
      yield* app.flush;
      app.mockInput.pressEnter();
      yield* app.flush;

      expect(app.acted()).toEqual([]);
      expect(app.said()).toContain("Alpha");
    }),
  ));

test("a half-typed answer is kept per question while the tab is open", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(
        appState({
          tasks: [
            task({ id: "t8", name: "Seeder", state: "blocked", decision: TYPED, run: "r8" }),
            task({
              id: "t7",
              name: "Other ask",
              state: "blocked",
              run: "r7",
              decision: { ...TYPED, run: "r7", id: "c3", text: "Which region?" },
            }),
          ],
        }),
      );

      yield* app.clickOn("type your answer");
      void app.mockInput.typeText("half of it");
      yield* app.flush;

      // Away from the field and back: what was typed is still there, and never left.
      yield* app.escape;
      expect(app.said()).toContain("half of it");
      expect(app.acted()).toEqual([]);

      // The other question is its own draft, not this one.
      yield* app.clickOn("type your answer");
      void app.mockInput.typeText("eu-west");
      yield* app.flush;
      const said = app.said();
      expect(said).toContain("half of it");
      expect(said).toContain("eu-west");

      app.mockInput.pressEnter();
      yield* app.flush;
      expect(app.acted()).toEqual([
        { _tag: "Answer", runId: "r7", choiceId: "c3", value: "eu-west" },
      ]);
    }),
  ));

test("a proposal card says what a yes is consent to, and only its buttons act on it", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(
        appState({
          tasks: [task({ id: "tp", name: "Slow down", state: "blocked", decision: PROPOSAL })],
        }),
      );
      const said = app.said();

      expect(said).toContain("You want the implementer to slow down.");
      expect(said).toContain("✓ hold r1 · allowed now");
      expect(said).toContain("? steer r1 · needs your yes");
      expect(said).toContain("p1 · deadbeef");

      // The card is still a card: clicking it opens the record and consents to nothing.
      yield* app.clickOn("Slow down");
      expect(app.acted()).toEqual([]);

      yield* app.clickOn("Confirm");
      expect(app.acted()).toEqual([{ _tag: "ConfirmProposal", id: "p1", hash: "deadbeef" }]);
    }),
  ));

test("declining a proposal declines it, and the card leaves Needs you", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(
        appState({
          tasks: [task({ id: "tp", name: "Slow down", state: "blocked", decision: PROPOSAL })],
        }),
      );

      yield* app.clickOn("Decline");
      expect(app.acted()).toEqual([{ _tag: "DeclineProposal", id: "p1" }]);

      yield* app.setState(appState({ tasks: [task({ id: "tp", name: "Slow down" })] }));
      const after = app.said();
      expect(after).toContain("Nothing needs you. 1 working.");
      expect(after).not.toContain("Needs you");
    }),
  ));

test("a card's actions are always on it, and pointing at it moves nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ tasks: HERD }));
      const before = app.lineOf("Working · 2");
      expect(app.said()).toContain("Go to tab");
      expect(app.said()).toContain("⋯");

      yield* app.pointAt("Strapi prod seeder");
      // A card that changed under the pointer would move the board under the pointer,
      // and a button that appears only once found is not offered.
      expect(app.lineOf("Working · 2")).toBe(before);
    }),
  ));

test("⋯ and the right button open the same menu, and a click outside closes it", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ tasks: [task()] }));

      yield* app.pointAt("Strapi prod seeder");
      yield* app.clickOn("⋯");
      const open = app.said();
      expect(open).toContain("Open record");
      expect(open).toContain("Go to its tab");
      expect(open).toContain("Steer…");
      expect(open).toContain("Stop run");
      // Over the board, not instead of it.
      expect(open).toContain("Strapi prod seeder");
      // Nothing has been asked for yet.
      expect(app.acted()).toEqual([]);

      yield* app.click(2, 0);
      expect(app.said()).not.toContain("Open record");

      yield* app.rightClickOn("Fixing the review findings");
      expect(app.said()).toContain("Open record");
    }),
  ));

test("the menu offers only what that Task can be asked for", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(
        appState({
          tasks: [
            task({
              state: "done",
              sentence: "Finished; nothing merged yet.",
              mr: "https://gitlab.cego.dk/mk/collie/-/merge_requests/151",
            }),
          ],
        }),
      );
      yield* app.clickOn("1 finished today");
      yield* app.rightClickOn("Strapi prod seeder");
      const said = app.said();

      expect(said).toContain("Follow-up run");
      expect(said).toContain("Open merge request");
      expect(said).not.toContain("Stop run");
      expect(said).not.toContain("Resume run");
    }),
  ));

test("a menu item acts, says so, and the menu goes", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ tasks: [task()] }));

      yield* app.rightClickOn("Strapi prod seeder");
      yield* app.clickOn("Stop run");
      expect(app.acted()).toEqual([{ _tag: "StopRun", runId: "r1" }]);
      expect(app.said()).not.toContain("Open record");

      // What it did, in the board's own words, for as long as it is worth saying.
      yield* app.setState(appState({ tasks: [task()], note: "stopping r1" }));
      expect(app.said()).toContain("stopping r1");
    }),
  ));

/** One message to this Run's agents, and what it actually reached. */
const DELIVERED = {
  id: "d1",
  at: "2026-09-16T10:05:00.000Z",
  run: "r1",
  incarnation: "i1",
  agent: "implementer",
  causal_key: "k1",
  request_id: "q1",
  cause: { kind: "steer", ref: "s1" },
  mode: "now",
  text_hash: "h1",
  intent_version: 1,
  attempt: 1,
  state: "acknowledged",
} satisfies Delivery;

test("a long record does not take the drawer's spacing back from its header", () =>
  runEffect(
    Effect.gen(function* () {
      // Sixty steps: taller than the pane, so the scroll area is the one thing that has
      // to give. The column used to shrink the header's blank rows instead.
      const steps = Array.from({ length: 60 }, (_, i) => ({
        name: `step-${i}`,
        state: "done" as const,
      }));
      const done = task({ state: "done", sentence: "Finished; nothing merged yet.", steps });
      const app = yield* mount(appState({ tasks: [done] }), 140, 30);
      yield* app.clickOn("1 finished today");
      yield* app.clickOn("Strapi prod seeder");

      const lines = app.frame().split("\n");
      const at = (text: string) => lines.findIndex((line) => line.includes(text));
      expect(at("Finished; nothing merged yet.")).toBe(at("content · 58m") + 2);
      expect(at("Go to its tab")).toBe(at("Finished; nothing merged yet.") + 2);
      // The buttons may wrap; the tabs still sit a blank row under the last of them.
      const left = lines[at("Summary")]!.indexOf("Summary") - 3;
      expect(lines[at("Summary") - 1]!.slice(left).replace(/[│ ]/g, "")).toBe("");
    }),
  ));

test("the drawer offers the same as buttons, and records what became of the work", () =>
  runEffect(
    Effect.gen(function* () {
      const done = task({
        state: "done",
        sentence: "Finished; nothing merged yet.",
        mr: "https://gitlab.cego.dk/mk/collie/-/merge_requests/151",
      });
      const app = yield* mount(appState({ tasks: [done] }));
      yield* app.clickOn("1 finished today");
      yield* app.clickOn("Strapi prod seeder");

      const said = app.said();
      expect(said).toContain("Go to its tab");
      expect(said).toContain("Follow-up run");
      expect(said).toContain("Mark merged");
      expect(said).toContain("Mark abandoned");
      // Already in the record: the drawer does not offer to open what is open.
      expect(said).not.toContain("Open record");

      yield* app.clickOn("Mark merged");
      expect(app.acted()).toEqual([
        { _tag: "RecordDisposition", runId: "r1", kind: "merged", ref: "collie!151" },
      ]);
    }),
  ));

test("Steer… opens the record with the keyboard in the steer field, and Enter sends it", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ tasks: [task()] }));

      yield* app.rightClickOn("Strapi prod seeder");
      yield* app.clickOn("Steer…");
      expect(app.said()).toContain("merge request");

      void app.mockInput.typeText("wait for the review");
      yield* app.flush;
      expect(app.said()).toContain("wait for the review");
      expect(app.acted()).toEqual([]);

      app.mockInput.pressEnter();
      yield* app.flush;
      expect(app.acted()).toEqual([{ _tag: "Steer", runId: "r1", text: "wait for the review" }]);

      // What the send actually reached, rather than that it was typed: the note confirms
      // it, and Cards carries the receipt the ledger wrote.
      yield* app.setState(
        appState({
          tasks: [task()],
          note: "sent to implementer",
          live: liveOf({ deliveries: [DELIVERED] }),
        }),
      );
      expect(app.said()).toContain("sent to implementer");
      yield* app.clickOn("Cards");
      expect(app.said()).toContain("implementer acknowledged");
    }),
  ));

const SETTINGS = {
  configPath: "/home/mk/.collie/config.json",
  defaults: [
    { key: "harness", value: "claude" },
    { key: "density", value: "comfortable" },
  ],
  remembered: [{ key: "linear.team", value: "Collie" }],
  trust: { cwd: "/w/collie", state: "trusted" },
};

const WORKFLOW = {
  name: "implement",
  title: "Implement",
  layer: "baseline" as const,
  provenance: "[baseline]",
  path: "/w/implement.md",
  inputs: ["plan"],
  steps: ["build", "review"],
  decisions: [],
  problems: [],
};

const HISTORY_ROWS = [
  {
    id: "old-1",
    dir: "/state/runs/old-1",
    glyph: "✓",
    title: "Implement · pin the CI image",
    detail: "succeeded · 2h",
    at: NOW - 86_400_000,
    target: null,
    children: [],
    fixable: false,
    choice: null,
    needsYou: false,
    ...NO_OUTCOME,
  },
  {
    id: "old-2",
    dir: "/state/runs/old-2",
    glyph: "✗",
    title: "Review · the seeder",
    detail: "failed · yesterday",
    at: NOW - 90_000_000,
    target: null,
    children: [],
    fixable: false,
    choice: null,
    needsYou: false,
    ...NO_OUTCOME,
  },
];

test("the Finished section ends with older…, which reads and pages what came before", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ tasks: HERD }));
      yield* app.clickOn("1 finished today");
      expect(app.said()).toContain("Older…");

      // Asking is what reads it: nothing older is read until the link is pressed.
      yield* app.clickOn("Older…");
      expect(app.acted()).toEqual([{ _tag: "ShowOlder" }]);

      // What it read arrives, and the page that was asked for is drawn.
      yield* app.setState(appState({ tasks: HERD, history: HISTORY_ROWS }));
      const said = app.said();
      expect(said).toContain("Implement · pin the CI image");
      expect(said).toContain("Review · the seeder");
      expect(said).not.toContain("Older…");
    }),
  ));

test("the last page of earlier work stays on screen once it is read", () =>
  runEffect(
    Effect.gen(function* () {
      // Nothing finished today, so these rows are the whole of what is behind the line.
      const app = yield* mount(appState({ tasks: [task()] }));
      yield* app.clickOn("Earlier work");
      yield* app.clickOn("Older…");

      yield* app.setState(appState({ tasks: [task()], history: HISTORY_ROWS }));
      const said = app.said();

      expect(said).toContain("Implement · pin the CI image");
      expect(said).toContain("Review · the seeder");
      // Nothing more to page in, nothing already read taken away.
      expect(said).not.toContain("Older…");
    }),
  ));

test("Workflows and Settings open from the header and Esc comes back to the board", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ tasks: HERD }));

      yield* app.clickOn("≡");
      expect(app.said()).toContain("Workflows");
      expect(app.said()).toContain("Settings");

      yield* app.clickOn("Workflows");
      expect(app.acted().at(-1)).toEqual({ _tag: "ShowView", view: "workflows" });
      yield* app.setState(
        appState({
          tasks: HERD,
          view: "workflows",
          definitions: { workflows: [WORKFLOW], errors: [] },
        }),
      );
      const workflows = app.said();
      expect(workflows).toContain("Implement");
      // It fills the pane: the board is not behind it.
      expect(workflows).not.toContain("Strapi prod seeder");

      yield* app.escape;
      expect(app.acted().at(-1)).toEqual({ _tag: "ShowView", view: "runs" });
      yield* app.setState(appState({ tasks: HERD }));

      // A record open, and Settings over it: what was open is open when it closes.
      yield* app.clickOn("Strapi prod seeder");
      expect(app.said()).toContain("merge request");
      app.mockInput.pressTab();
      yield* app.flush;
      app.mockInput.pressTab();
      yield* app.flush;
      yield* app.clickOn("Settings");
      expect(app.acted().at(-1)).toEqual({ _tag: "ShowView", view: "settings" });
      yield* app.setState(appState({ tasks: HERD, view: "settings", settings: SETTINGS }));
      expect(app.said()).toContain("linear.team");

      yield* app.escape;
      yield* app.setState(appState({ tasks: HERD }));
      expect(app.said()).toContain("merge request");
    }),
  ));

test("density is a setting, and the board is drawn at the one that is set", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ tasks: HERD, view: "settings", settings: SETTINGS }));

      yield* app.clickOn("density");
      void app.mockInput.typeText("compact");
      yield* app.flush;
      // The field is on the row it is about, beside the value it would replace.
      expect(app.said()).toContain("comfortable → compact");

      app.mockInput.pressEnter();
      yield* app.flush;
      expect(app.acted()).toEqual([{ _tag: "SetDefault", key: "density", value: "compact" }]);

      // What the file says is what the board draws: three across rather than two.
      const three = [task({ id: "a", name: "Aaa" }), task({ id: "b", name: "Bbb" })];
      const wide = yield* mount(appState({ tasks: three, density: "compact" }), 120);
      expect(wide.lineOf("Aaa")).toBe(wide.lineOf("Bbb"));
      const comfortable = yield* mount(appState({ tasks: three }), 100);
      expect(comfortable.lineOf("Aaa")).toBe(comfortable.lineOf("Bbb"));
    }),
  ));

test("Tab moves between the board, an open record and the menu", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ tasks: [task()] }));
      yield* app.clickOn("Strapi prod seeder");
      expect(app.said()).toContain("say something about this run");

      app.mockInput.pressTab();
      yield* app.flush;
      // In the record: what is typed goes to its field rather than to the board.
      void app.mockInput.typeText("slow down");
      yield* app.flush;
      expect(app.said()).toContain("slow down");

      app.mockInput.pressTab();
      yield* app.flush;
      expect(app.said()).toContain("Workflows");

      app.mockInput.pressTab();
      yield* app.flush;
      expect(app.said()).not.toContain("Workflows");
    }),
  ));

const REVIEW = [
  "## Verdict",
  "",
  "clean, with one thing worth saying.",
  "",
  "- src/seed.ts: the brand loop reads the whole file per brand",
].join("\n");

const MR_PANEL = {
  _tag: "Details" as const,
  iid: "151",
  project: "mk/collie",
  title: "Seed the brands",
  state: "opened",
  author: "mk",
  assignees: [],
  sourceBranch: "mk/strapi-seed",
  targetBranch: "master",
  pipeline: "success",
  approvals: "1 of 2 approvals",
  unresolved: true,
  notes: 3,
  headSha: "abc1234",
  mergedSha: "",
  updatedAt: NOW,
  url: "https://gitlab.cego.dk/mk/collie/-/merge_requests/151",
};

function record(over: Partial<RunDetail> = {}): RunDetail {
  return {
    id: "r1",
    dir: "/state/runs/r1",
    title: "Implement · Strapi prod seeder",
    status: "running",
    inputs: [{ name: "plan", value: "seed the brands", source: "picker" }],
    steps: [{ id: "build", status: "done", note: "", took: "12m", agents: [] }],
    handoffs: [],
    intent: { goal: "seed the brands", constraints: ["no production writes"] },
    review: { _tag: "Text", text: REVIEW, truncated: true },
    plan: {
      spec: {
        _tag: "Text",
        text: "# The seeder\n\nOne command seeds every brand.",
        truncated: false,
      },
      tickets: [
        { file: "01-loader.md", title: "The loader", done: true },
        { file: "02-brands.md", title: "Brands per environment", done: false },
      ],
    },
    outputs: [],
    tail: null,
    attention: {
      category: "none",
      reason: "running",
      explanation: "",
      step: "build",
      actions: [],
      choice: null,
      driver: "live",
      preserved: [],
      agents: [],
      agentsAlive: "unasked",
    },
    outcome: NO_RUN_OUTCOME,
    finishedAt: 0,
    mr: MR_PANEL,
    ...over,
  };
}

const CARD: Card = {
  id: "c1",
  run: "r1",
  kind: "slice",
  at: "2026-09-16T10:00:00.000Z",
  step: "build",
  iteration: 2,
  intent_version: 1,
  revision: { branch: "mk/strapi-seed", head_sha: "abc1234def", fingerprint: "f1", dirty: false },
  changes: { files: ["src/seed.ts"], commits: ["abc1234"] },
  requested: { goal: "seed the brands", constraints: [] },
  readiness: "inspect-ready",
  verifications: [{ id: "v1", name: "seeder-tests", result: "pass", ref: "tree abc1234" }],
  claims: [{ text: "every brand is seeded", ref: "src/seed.ts" }],
  missing: ["nobody ran it against staging"],
  inspect: [],
  links: {},
  drift: [],
  deliveries: [],
  narrative: null,
  aligned: "unverified",
  cross_run: "none",
  significance: "try-it",
};

function liveOf(over: Partial<Live> = {}): Live {
  return {
    run: "r1",
    cards: [],
    drift: [],
    deliveries: [],
    proposals: [],
    pending: [],
    ownership: null,
    news: { waiting: 0, uncertain: 0 },
    ...over,
  };
}

/** The record open on a Task, which is where every tab below is reached from. */
const opened = Effect.fn("board.opened")(function* (state: AppState) {
  const app = yield* mount(state);
  yield* app.clickOn("Strapi prod seeder");
  return app;
});

test("the record opens on Summary, with the merge request's own state in it", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* opened(
        appState({ tasks: [task()], detail: record(), live: liveOf({ cards: [CARD] }) }),
      );

      const said = app.said();
      expect(said).toContain("Summary");
      expect(said).toContain("Review");
      expect(said).toContain("Plan");
      expect(said).toContain("Cards");
      expect(said).toContain("Log");
      // Summary's own content, and the merge request behind it.
      expect(said).toContain("seed the brands");
      expect(said).toContain("no production writes");
      expect(said).toContain("opened");
      expect(said).toContain("pipeline success");
      expect(said).toContain("1 of 2 approvals");
      expect(said).toContain("unresolved");
      // The other tabs' content is behind them.
      expect(said).not.toContain("the brand loop reads the whole file per brand");
    }),
  ));

test("Review shows the verdict and findings, and says when it was cut short", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* opened(appState({ tasks: [task()], detail: record() }));

      yield* app.clickOn("Review");

      const said = app.said();
      expect(said).toContain("clean, with one thing worth saying");
      expect(said).toContain("the brand loop reads the whole file per brand");
      expect(said).toContain("m reads more");
      // One tab at a time: Summary's sections are not under it.
      expect(said).not.toContain("no production writes");
    }),
  ));

test("Plan shows the spec and its tickets, ticked where they are done", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* opened(appState({ tasks: [task()], detail: record() }));

      yield* app.clickOn("Plan");

      const said = app.said();
      expect(said).toContain("One command seeds every brand");
      expect(said).toContain("✓ The loader");
      expect(said).toContain("· Brands per environment");
    }),
  ));

test("Cards shows the run's evidence, keeping claims apart from what was run", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* opened(
        appState({
          tasks: [task()],
          detail: record(),
          live: liveOf({
            cards: [CARD],
            deliveries: [DELIVERED],
          }),
        }),
      );

      yield* app.clickOn("Cards");

      const said = app.said();
      expect(said).toContain("seeder-tests pass");
      expect(said).toContain("claimed: every brand is seeded");
      expect(said).toContain("missing: nobody ran it against staging");
      // The receipt for what was said to this run's agents.
      expect(said).toContain("implementer acknowledged");
    }),
  ));

test("Log tails the run's log, and only that tab asks for it", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* opened(appState({ tasks: [task()], detail: record() }));
      expect(app.acted()).toEqual([]);

      yield* app.clickOn("Log");

      // The log is read only while it is being looked at.
      expect(app.acted()).toEqual([{ _tag: "ToggleTail" }]);
      yield* app.setState(
        appState({
          tasks: [task()],
          detail: record({
            tail: { _tag: "Text", text: "seeding brand 14 of 20", truncated: true },
          }),
        }),
      );
      expect(app.said()).toContain("seeding brand 14 of 20");

      yield* app.clickOn("Summary");
      expect(app.acted()).toEqual([{ _tag: "ToggleTail" }, { _tag: "ToggleTail" }]);
    }),
  ));

test("m reads more of a review the record cut short", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* opened(appState({ tasks: [task()], detail: record() }));
      yield* app.clickOn("Review");

      void app.mockInput.typeText("m");
      yield* app.flush;

      expect(app.acted()).toEqual([{ _tag: "MoreReview" }]);
    }),
  ));

test("a finished run has no steer field: there is nothing driving it to say it to", () =>
  runEffect(
    Effect.gen(function* () {
      const done = task({ state: "done", sentence: "Finished; nothing merged yet." });
      const app = yield* mount(appState({ tasks: [done], detail: record() }));
      yield* app.clickOn("1 finished today");
      yield* app.clickOn("Strapi prod seeder");

      expect(app.said()).toContain("Summary");
      expect(app.said()).not.toContain("say something about this run");
    }),
  ));

test("the wheel scrolls the record under the pointer", () =>
  runEffect(
    Effect.gen(function* () {
      const long = Array.from({ length: 80 }, (_, at) => `finding ${at + 1}`).join("\n");
      const app = yield* opened(
        appState({
          tasks: [task()],
          detail: record({ review: { _tag: "Text", text: long, truncated: false } }),
        }),
      );
      yield* app.clickOn("Review");
      expect(app.said()).toContain("finding 2 ");
      expect(app.said()).not.toContain("finding 80");

      // Over the drawer, which is the right-hand 60% of the pane: nothing the board puts
      // over it — a scrim, a card's own hover — may swallow the wheel.
      yield* app.scrollAt(100, 20, 60);

      expect(app.said()).toContain("finding 80");
      expect(app.said()).not.toContain("finding 2 ");
    }),
  ));

test("a new record opens at the top of what it is showing", () =>
  runEffect(
    Effect.gen(function* () {
      const long = Array.from({ length: 80 }, (_, at) => `finding ${at + 1}`).join("\n");
      const other = task({ id: "t9", name: "Kibana upload cap", run: "r9" });
      const app = yield* opened(
        appState({
          tasks: [task(), other],
          detail: record({ review: { _tag: "Text", text: long, truncated: false } }),
        }),
      );
      yield* app.clickOn("Review");
      yield* app.scrollAt(100, 20, 60);
      expect(app.said()).toContain("finding 80");

      yield* app.escape;
      yield* app.clickOn("Kibana upload cap");

      // How far the last record had been scrolled says nothing about this one, and it
      // opens on Summary rather than on whichever tab the last one was left on.
      const said = app.said();
      expect(said).toContain("no production writes");
      expect(said).not.toContain("finding 80");
    }),
  ));

const GATE: TaskView["decision"] = {
  kind: "gate",
  run: "rg",
  id: "g1",
  step: "mr",
  verifications: ["tests", "lint", "typecheck"],
};

const HOLDING = task({
  id: "tg",
  name: "Upload cap",
  state: "blocked",
  decision: GATE,
  sentence: "Holding at the mr gate until you approve the list.",
  run: "rg",
});

test("a gate card lists what would prove the run, and answers on the card", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ tasks: [HOLDING] }));
      const said = app.said();

      expect(said).toContain("Holding at the mr gate until you approve the list.");
      expect(said).toContain("tests");
      expect(said).toContain("typecheck");

      yield* app.clickOn("Approve");
      expect(app.acted()).toEqual([
        { _tag: "Answer", runId: "rg", choiceId: "g1", value: "approve" },
      ]);
    }),
  ));

test("Skip takes the run past the gate", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ tasks: [HOLDING] }));

      yield* app.clickOn("Skip");
      expect(app.acted()).toEqual([{ _tag: "Answer", runId: "rg", choiceId: "g1", value: "skip" }]);
    }),
  ));

test("Edit the list opens the record, and approves what is left of it", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ tasks: [HOLDING] }));

      yield* app.clickOn("Edit the list");
      // The record is open on the gate, with every verification on it.
      expect(app.said()).toContain("What proves this run");
      expect(app.said()).toContain("✓ lint");

      // Dropping one, then approving what is left.
      yield* app.clickOn("✓ lint");
      expect(app.said()).toContain("○ lint");
      yield* app.clickOn("Approve the list");
      expect(app.acted().at(-1)).toEqual({
        _tag: "Answer",
        runId: "rg",
        choiceId: "g1",
        value: "approve:tests,typecheck",
      });
    }),
  ));

const THREE = [
  task({ id: "ta", name: "Aaa seeder", run: "ra" }),
  task({ id: "tb", name: "Bbb uploader", run: "rb" }),
  task({ id: "tc", name: "Ccc importer", run: "rc" }),
];

test("a run on its way to being stopped says so, and the toast takes it back", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ tasks: [task()], stopping: ["r1"] }));
      const said = app.said();

      expect(said).toContain("stopping");
      expect(said).toContain("Stopped Strapi prod seeder");
      expect(said).toContain("Undo");

      yield* app.clickOn("Undo");
      expect(app.acted()).toEqual([{ _tag: "UndoStop" }]);
    }),
  ));

test("three on their way out are one toast, not three", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ tasks: THREE, stopping: ["ra", "rb", "rc"] }));

      expect(app.said()).toContain("Stopped 3 runs");
      expect(app.said()).not.toContain("Stopped Aaa seeder");
    }),
  ));

test("shift-click picks cards, and the bar stops the lot of them", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ tasks: THREE }));

      // One picked is not a batch: the bar is for what a human could not do card by card.
      yield* app.shiftClickOn("Aaa seeder");
      expect(app.said()).not.toContain("selected");

      yield* app.shiftClickOn("Bbb uploader");
      yield* app.shiftClickOn("Ccc importer");
      expect(app.said()).toContain("3 selected");
      // Picking is not opening: nothing has been asked for yet.
      expect(app.acted()).toEqual([]);

      yield* app.clickOn("Stop all");
      expect(app.acted()).toEqual([
        { _tag: "StopRun", runId: "ra" },
        { _tag: "StopRun", runId: "rb" },
        { _tag: "StopRun", runId: "rc" },
      ]);
      // The bar goes with the selection it was about.
      expect(app.said()).not.toContain("3 selected");
    }),
  ));

test("a selection with nothing to stop is not offered a stop", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(
        appState({
          tasks: [
            task({ id: "td", name: "Ddd merged", state: "done", run: "rd" }),
            task({ id: "te", name: "Eee merged", state: "done", run: "re" }),
          ],
        }),
      );
      // Finished work is folded away until it is asked for.
      yield* app.clickOn("2 finished today");
      yield* app.shiftClickOn("Ddd merged");
      yield* app.shiftClickOn("Eee merged");

      expect(app.said()).toContain("2 selected");
      expect(app.said()).not.toContain("Stop all");
    }),
  ));

test("clear drops the selection, and so does an ordinary click", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ tasks: THREE }));

      yield* app.shiftClickOn("Aaa seeder");
      yield* app.shiftClickOn("Bbb uploader");
      expect(app.said()).toContain("2 selected");

      yield* app.clickOn("Clear");
      expect(app.said()).not.toContain("selected");
      expect(app.acted()).toEqual([]);

      yield* app.shiftClickOn("Aaa seeder");
      yield* app.shiftClickOn("Bbb uploader");
      expect(app.said()).toContain("2 selected");

      // A plain click is about that one card, so it is the end of the selection.
      yield* app.clickOn("Ccc importer");
      expect(app.said()).not.toContain("selected");
    }),
  ));

test("the launch flow owns the keyboard while it is asking", () =>
  runEffect(
    Effect.gen(function* () {
      // A goal with a `q` and an `r` in it: the board's own keys are not keys while
      // something is being typed at an inline question.
      const app = yield* mount(appState({ tasks: THREE }), 120, 40, {
        _tag: "Question",
        header: "What is the goal?",
        footer: "type an answer · Enter send · Esc cancel",
        initial: "",
      });

      void app.mockInput.typeText("query the records");
      yield* app.flush;

      expect(app.said()).toContain("query the records");
      expect(app.acted()).toEqual([]);
    }),
  ));

test("? lists every key the board takes, and any key closes it", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ tasks: THREE }));

      void app.mockInput.typeText("?");
      yield* app.flush;
      const said = app.said();
      // The board's own keys, and the card menu's, which is the whole of what a key does.
      expect(said).toContain("Close the tab");
      expect(said).toContain("Stop run");
      expect(app.acted()).toEqual([]);

      void app.mockInput.typeText("x");
      yield* app.flush;
      expect(app.said()).not.toContain("Close the tab");
    }),
  ));

test("clicking the search field is what a mouse-first human does to search", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ tasks: THREE }));

      yield* app.clickOn("⌕");
      void app.mockInput.typeText("Aaa");
      yield* app.flush;

      const said = app.said();
      expect(said).toContain("Aaa seeder");
      expect(said).not.toContain("Bbb uploader");
    }),
  ));

test("a pasted answer reaches the field that has the keyboard", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(
        appState({
          tasks: [task({ id: "t8", state: "blocked", decision: TYPED, run: "r8" })],
        }),
      );

      yield* app.clickOn("type your answer");
      yield* Effect.promise(() => app.mockInput.pasteBracketedText("s3://maps/2026-09\n"));
      yield* app.flush;

      expect(app.said()).toContain("s3://maps/2026-09");
      app.mockInput.pressEnter();
      yield* app.flush;
      expect(app.acted()).toEqual([
        { _tag: "Answer", runId: "r8", choiceId: "c2", value: "s3://maps/2026-09" },
      ]);
    }),
  ));

test("a menu item pressed where it is drawn acts, and does not open the card beneath it", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ tasks: [task()] }));
      yield* app.clickOn("⋯");
      expect(app.said()).toContain("Go to its tab");

      // Pressed by position, inside the menu, on a line that is also a card's: the menu
      // is over the card, so the card must not hear it.
      const before = app.commands.length;
      // On the item's key, at the menu's right edge, rather than on its label: the whole
      // row is the item, and every cell of it is over the card.
      const y = app.lineOf("Go to its tab");
      const row = app.frameLine(y);
      yield* app.click(row.lastIndexOf("g"), y);
      const since = app.commands.slice(before);
      expect(since.some((command) => command._tag === "Jump")).toBe(true);
      expect(since.some((command) => command._tag === "Select")).toBe(false);
      expect(app.said()).not.toContain("Summary");
    }),
  ));

test("a long name is cut to its card, and the project and age keep their place", () =>
  runEffect(
    Effect.gen(function* () {
      const long =
        "npm-packages/content dependency updates and release for core 6.69.0 and everything after it";
      const app = yield* mount(
        appState({ tasks: [task({ name: long, project: "Renovate", age: "17h" })] }),
      );
      const y = app.lineOf("Renovate");
      const line = app.frameLine(y);
      // One line, with an ellipsis, and the age still at the right of the same line.
      expect(line).toContain("…");
      expect(line).toContain("17h");
      expect(app.said()).not.toContain("everything after it");
    }),
  ));
