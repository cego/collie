import { expect, test } from "bun:test";
import { Effect } from "effect";
import { createSignal, ErrorBoundary } from "solid-js";
import { testRender } from "@opentui/solid";
import { runEffect } from "../support/effect";
import { App } from "../../src/ui/App";
import { StoppedDrawing } from "../../src/ui/bridge";
import type { AppState, Command } from "../../src/ui/state";
import type { MrDetails } from "../../src/mr";
import type { DefinitionRow, RunDetail, SettingsView } from "../../src/views";
import type { PendingChoice } from "../../src/driver";
import type { WorkspaceView } from "../../src/workspace";

/** A fixed clock, so a row's relative time does not depend on the wall. */
const NOW = Date.parse("2026-09-02T12:00:00.000Z");
/** Long enough to run into the keys above it if the footer's rows are not bounded. */
const NOTE = "sent the review to the implementer";

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

function run(id: string, title: string, over: Partial<WorkspaceView["active"][number]> = {}) {
  return {
    id,
    dir: `/state/runs/${id}`,
    glyph: "⚙",
    title,
    detail: "build",
    at: NOW - 120_000,
    target: null,
    fixable: false,
    choice: null,
    ...over,
  };
}

function choice(runId: string, header: string): PendingChoice {
  return {
    id: `c-${runId}`,
    kind: "menu",
    run: runId,
    step: "next",
    header,
    footer: "↑↓ move · Enter choose",
    items: [
      { id: "Implement now", title: "Implement now" },
      { id: "Stop here", title: "Stop here" },
    ],
  };
}

/** Each screen row cut back to the list region, where the list is a column. */
function listLines(frame: string): string[] {
  return frame.split("\n").map((line) => {
    const split = line.indexOf("││");
    return split < 0 ? line : line.slice(0, split);
  });
}

/** Whatever the app is looking at, with the parts a test does not care about empty. */
function appState(over: Partial<AppState> = {}): AppState {
  return {
    view: "runs",
    board: board(),
    note: NOTE,
    history: null,
    definitions: null,
    settings: null,
    detail: null,
    ...over,
  };
}

/** The app over a state a test can replace, and every command it dispatched. */
const mount = Effect.fn("app.mount")(function* (initial: AppState, width = 100, height = 26) {
  const [state, setState] = createSignal<AppState>(initial);
  const commands: Command[] = [];
  const t = yield* Effect.promise(() =>
    testRender(() => <App state={state} dispatch={(c) => commands.push(c)} />, { width, height }),
  );
  const flush = Effect.promise(() => t.flush());
  yield* flush;
  return {
    commands,
    /**
     * Everything but `Select`. Moving the Selection is bookkeeping — it tells the
     * producers what to read — and it would otherwise drown every assertion about
     * what a row action actually did.
     */
    acted: () => commands.filter((c) => c._tag !== "Select"),
    flush,
    frame: () => t.captureCharFrame(),
    /**
     * The frame as one run of words. The detail panel is a narrow column, so anything
     * long wraps mid-phrase; a test about what it says should not also be a test of
     * where the wrap fell.
     */
    said: () =>
      t
        .captureCharFrame()
        .replace(/[│┌┐└┘─]/g, " ")
        .replace(/\s+/g, " "),
    mockInput: t.mockInput,
    click: (x: number, y: number) =>
      Effect.andThen(
        Effect.promise(() => t.mockMouse.click(x, y)),
        flush,
      ),
    hover: (x: number, y: number) =>
      Effect.andThen(
        Effect.promise(() => t.mockMouse.moveTo(x, y)),
        flush,
      ),
    setState: (next: AppState) =>
      Effect.andThen(
        Effect.sync(() => setState(next)),
        flush,
      ),
    /**
     * Where a row is on screen, which is what a click has to be aimed at. Only the list
     * column counts: the detail panel repeats the selected row's title on the same
     * screen rows, so a whole-line search finds the wrong y.
     */
    lineOf(text: string) {
      const y = listLines(t.captureCharFrame()).findIndex((l) => l.includes(text));
      if (y < 0) throw new Error(`no list line containing ${JSON.stringify(text)}`);
      return y;
    },
    columnOf(text: string, needle: string) {
      return listLines(t.captureCharFrame())
        .find((l) => l.includes(text))!
        .indexOf(needle);
    },
  };
});

const BOARD = board({
  agents: [{ key: "1", name: "Implementer", agent: "impl-1", status: "working", run: "r1" }],
  active: [run("r1", "Implement · add-a-picker"), run("r2", "Review · worktree")],
  recent: [run("r0", "Plan · the picker", { glyph: "✓", detail: "done" })],
});

test("an installation behind its remote says so in the nav, and only when it is", () =>
  runEffect(
    Effect.gen(function* () {
      // Shown and never sent: being a few commits behind belongs where the human is
      // already looking, not in a notification.
      const behind = yield* mount(appState({ board: board({ behind: 3 }) }));
      expect(behind.frame()).toContain("3 commits behind");
      expect(behind.frame()).toContain("collie upgrade");

      const level = yield* mount(appState({ board: board({ behind: 0 }) }));
      expect(level.frame()).not.toContain("behind");
    }),
  ));

test("the board's agents, running runs and finished runs all reach the screen", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ board: BOARD }));
      const frame = app.frame();

      expect(frame).toContain("Implementer");
      expect(frame).toContain("Implement · add-a-picker");
      expect(frame).toContain("Review · worktree");
      expect(frame).toContain("Plan · the picker");
      // The status glyphs survive, because colour is not available to everyone.
      expect(frame).toContain("⚙");
      expect(frame).toContain("✓");
      // The nav names every view, with Runs the one that is showing.
      // A run list answers "how long has this been like this", so it says so.
      expect(frame).toContain("2m ago");
      expect(frame).toContain("[Runs]");
      expect(frame).toContain("History");
      expect(frame).toContain("Settings");

      // The footer's rows are bounded: the last thing the tab said gets a line of its
      // own instead of being drawn over the wrapped key list above it.
      const note = frame.split("\n").filter((l) => l.includes("sent the review"));
      expect(note).toHaveLength(1);
      expect(note[0]!).toContain(NOTE);
    }),
  ));

test("clicking a row selects it and points its actions at that run", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ board: BOARD }));
      // Nothing was clicked yet, so the first row is the Selection.
      expect(app.frame()).toContain("❯");

      yield* app.click(4, app.lineOf("Review · worktree"));

      const lines = listLines(app.frame());
      expect(lines[app.lineOf("Review · worktree")]).toContain("❯");
      expect(lines[app.lineOf("Implement · add-a-picker")]).not.toContain("❯");
      // The Selection's own buttons are offered in the footer, where they cannot change
      // the height of the row they belong to.
      expect(app.frame()).toContain("[k stop]");
      expect(app.acted()).toEqual([]);
    }),
  ));

test("selecting or hovering a row leaves every other row where it was", () =>
  runEffect(
    Effect.gen(function* () {
      // The list has to stay still. A row that grew when it was selected pushed every
      // row under it down a line, so the row a human was aiming at moved out from
      // under the cursor as soon as the one above it was touched.
      const app = yield* mount(appState({ board: BOARD }));
      const titles = [
        "Implementer",
        "Implement · add-a-picker",
        "Review · worktree",
        "Plan · the picker",
      ];
      const where = () => titles.map((title) => app.lineOf(title));
      const before = where();

      yield* app.click(4, app.lineOf("Implement · add-a-picker"));
      expect(where()).toEqual(before);

      yield* app.click(4, app.lineOf("Review · worktree"));
      expect(where()).toEqual(before);

      yield* app.hover(4, app.lineOf("Implementer"));
      expect(where()).toEqual(before);
    }),
  ));

test("a field that has the keys takes the footer's buttons with them", () =>
  runEffect(
    Effect.gen(function* () {
      // Every key belongs to the field being typed into, so a button that still acted on
      // the Selection disagreed with the key printed on it: `k` typed a `k` into the
      // filter while `[k stop]` stopped the run.
      const app = yield* mount(appState({ board: BOARD }));
      expect(app.frame()).toContain("[k stop]");

      app.mockInput.pressKey("/");
      yield* app.flush;
      expect(app.frame()).not.toContain("[k stop]");
      expect(app.frame()).toContain("type to narrow");
      // And the board's own keys are not offered either, for the same reason.
      expect(app.frame()).not.toContain("p run");

      // Enter keeps the filter and gives the keys back, so the buttons come back too.
      app.mockInput.pressEnter();
      yield* app.flush;
      expect(app.frame()).toContain("[k stop]");
      expect(app.acted()).toEqual([]);
    }),
  ));

test("clicking a row's stop button stops that run and nothing else", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ board: BOARD }));

      yield* app.click(4, app.lineOf("Review · worktree"));
      // The buttons sit in the footer, so that is where the click lands.
      yield* app.click(app.columnOf("[k stop]", "[k stop]") + 2, app.lineOf("[k stop]"));

      expect(app.acted()).toEqual([{ _tag: "StopRun", runId: "r2" }]);
    }),
  ));

test("a run that finishes under the cursor leaves its neighbour selected", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ board: BOARD }));
      yield* app.click(4, app.lineOf("Review · worktree"));

      // r2 is gone; the row that took its place is the one now selected.
      yield* app.setState(
        appState({
          board: board({
            agents: BOARD.agents,
            active: [run("r1", "Implement · add-a-picker")],
            recent: [run("r0", "Plan · the picker", { glyph: "✓", detail: "done" })],
          }),
        }),
      );

      expect(listLines(app.frame())[app.lineOf("Plan · the picker")]).toContain("❯");
      // A refresh is not an action: nothing was dispatched on the way.
      expect(app.acted()).toEqual([]);
    }),
  ));

test("arrow keys keep the Selection on screen in a list longer than the region", () =>
  runEffect(
    Effect.gen(function* () {
      const many = Array.from({ length: 40 }, (_, i) => run(`r${i}`, `Review · number ${i}`));
      const app = yield* mount(appState({ board: board({ recent: many }) }), 100, 20);

      for (const _ of Array.from({ length: 30 })) {
        app.mockInput.pressArrow("down");
        yield* app.flush;
      }

      // Whatever the list has scrolled to, the row the keys are acting on is one the
      // human can see: the marker is somewhere in the list region.
      const marked = listLines(app.frame()).filter((line) => line.includes("❯"));
      expect(marked).toHaveLength(1);
      expect(marked[0]!).toContain("number 30");
    }),
  ));

test("every key the board offered still does what it did, against the Selection", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ board: BOARD }));

      for (const key of ["1", "p", "u", "f", "s"]) app.mockInput.pressKey(key);
      yield* app.flush;
      // `l` and `k` act on the Selection: the arrow keys are what puts it on a run. Two
      // rows down, because the first run's own agent hangs off it.
      app.mockInput.pressArrow("down");
      yield* app.flush;
      app.mockInput.pressArrow("down");
      yield* app.flush;
      app.mockInput.pressKey("l");
      yield* app.flush;

      expect(app.acted()).toEqual([
        { _tag: "FocusAgent", agent: "impl-1" },
        { _tag: "OpenMode", mode: "pick" },
        { _tag: "OpenMode", mode: "resume" },
        { _tag: "OpenMode", mode: "fork" },
        // The Selection at that point is the first row, the first run's, and that run is
        // what the hand-off is about: `s` names a run rather than meaning "the newest".
        { _tag: "SendReview", runId: "r1" },
        { _tag: "OpenLog", runId: "r2" },
      ]);

      app.mockInput.pressKey("q");
      yield* app.flush;
      expect(app.acted().at(-1)).toEqual({ _tag: "Quit" });
    }),
  ));

test("send review names the selected run, not whichever review is newest", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(
        appState({
          board: board({
            recent: [
              run("r2", "Review · newest", { glyph: "✓", detail: "done" }),
              run("r9", "Review · an older one", { glyph: "✓", detail: "done" }),
            ],
          }),
        }),
      );

      yield* app.click(4, app.lineOf("Review · an older one"));
      app.mockInput.pressKey("s");
      yield* app.flush;

      expect(app.acted()).toEqual([{ _tag: "SendReview", runId: "r9" }]);
    }),
  ));

test("a second waiting run is selectable and answerable", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(
        appState({
          board: board({
            active: [
              run("r1", "Implement · one", { choice: choice("r1", "Fix or stop?") }),
              run("r2", "Review · two", { choice: choice("r2", "Post it?") }),
            ],
          }),
        }),
      );

      // The first run's question is on screen because its row is the Selection.
      expect(app.frame()).toContain("Fix or stop?");

      yield* app.click(4, app.lineOf("Review · two"));
      expect(app.frame()).toContain("Post it?");
      expect(app.frame()).not.toContain("Fix or stop?");

      // Clicking an option answers that run with that option.
      yield* app.click(6, app.lineOf("Stop here"));
      expect(app.acted()).toEqual([{ _tag: "Answer", runId: "r2", value: "Stop here" }]);
    }),
  ));

test("a long question leaves the list some rows, and keeps the cursor in view", () =>
  runEffect(
    Effect.gen(function* () {
      // The question's region is a sibling of the list, so an option per line and no
      // ceiling meant a menu could take the whole pane and leave nothing of the list.
      const many = Array.from({ length: 8 }, (_, i) => ({
        id: `option-${i}`,
        title: `option number ${i}`,
      }));
      const app = yield* mount(
        appState({
          board: board({
            active: [
              run("r1", "Implement · one", {
                choice: { ...choice("r1", "Which one?"), items: many },
              }),
            ],
          }),
        }),
        100,
        20,
      );

      // The run it belongs to is still on screen: the list kept rows of its own.
      expect(app.frame()).toContain("Implement · one");
      expect(app.frame()).toContain("Which one?");

      // The cursor can be moved onto an option the region has scrolled past, and the
      // option it is on is one the human can see before pressing Enter.
      for (const _ of Array.from({ length: 7 })) {
        app.mockInput.pressArrow("down");
        yield* app.flush;
      }
      expect(app.frame()).toContain("option number 7");
      expect(app.frame()).toMatch(/❯ option number 7/);
    }),
  ));

test("every action the Selection offers is readable in a narrow pane", () =>
  runEffect(
    Effect.gen(function* () {
      // A finished merge-request run offers five, which do not fit one line of the 60
      // columns a Collie tab beside an editor has. They used to be clipped mid-button,
      // and the footer's key list no longer repeats them, so those actions were offered
      // nowhere on screen at all.
      const app = yield* mount(
        appState({
          board: board({
            recent: [
              run("r2", "Review · !42", {
                glyph: "✓",
                detail: "done",
                target: "mr:gitlab.example.com/g/p!42",
                fixable: true,
              }),
            ],
          }),
        }),
        60,
        24,
      );

      for (const label of [
        "[l log]",
        "[x fix what is open]",
        "[a review again]",
        "[o post to the MR]",
        "[w open in a browser]",
      ]) {
        expect(app.frame()).toContain(label);
      }
      // And each is clickable where it is drawn, wrapped line included.
      yield* app.click(app.columnOf("[w open", "[w open") + 2, app.lineOf("[w open"));
      expect(app.acted()).toEqual([{ _tag: "OpenMr", target: "mr:gitlab.example.com/g/p!42" }]);
    }),
  ));

test("no row moves when a question appears or its cursor walks the menu", () =>
  runEffect(
    Effect.gen(function* () {
      // What ticket 04 asks of the question's region: no row is shifted by it. It is
      // drawn over the bottom of the list rather than among its rows or beside them, so
      // the list's own share of the pane is the same whether or not a Run is asking —
      // and its height comes from how many options it has room for, which does not
      // depend on where the cursor is inside them.
      const many = Array.from({ length: 4 }, (_, i) => ({ id: `o${i}`, title: `option ${i}` }));
      const waiting = (asking: boolean) =>
        appState({
          board: board({
            active: [
              run("r1", "Implement · one"),
              run("r2", "Review · two", {
                choice: asking ? { ...choice("r2", "Which one?"), items: many } : null,
              }),
            ],
            recent: [run("r0", "Plan · three", { glyph: "✓", detail: "done" })],
          }),
        });
      const titles = ["Implement · one", "Review · two", "Plan · three"];
      const app = yield* mount(waiting(false));
      const where = () => titles.map((title) => app.lineOf(title));
      // The question belongs to the selected run, so the Selection goes there first.
      yield* app.click(4, app.lineOf("Review · two"));
      const before = where();

      // The run starts asking: the region opens under the list, and no row moves.
      yield* app.setState(waiting(true));
      expect(app.frame()).toContain("Which one?");
      expect(where()).toEqual(before);

      // And walking the cursor down the menu moves nothing either: how tall the region
      // is comes from how many options it has room for, not from where the cursor is.
      for (const _ of Array.from({ length: 3 })) {
        app.mockInput.pressArrow("down");
        yield* app.flush;
      }
      expect(app.frame()).toContain("❯ option 3");
      expect(where()).toEqual(before);
      // And the list gave up none of its rows for it: a region that took them changed
      // how much of the list there was to look at, which is how a row went out of view.
      expect(app.frame()).toContain("Plan · three");
    }),
  ));

test("a narrow pane keeps every region on screen while a question is up", () =>
  runEffect(
    Effect.gen(function* () {
      // At 60x20 a long menu used to draw through the list and push the footer off the
      // bottom. It is drawn over the list now, so nothing else on the pane gives up a
      // row for it — including the footer, which is how it is answered.
      const many = Array.from({ length: 8 }, (_, i) => ({ id: `o${i}`, title: `option ${i}` }));
      const app = yield* mount(
        appState({
          board: board({
            active: [
              run("r1", "Implement · one", {
                choice: { ...choice("r1", "Which one?"), items: many },
              }),
            ],
          }),
        }),
        60,
        20,
      );

      const lines = app.frame().split("\n");
      // The run being asked about, the question, and the footer's own keys are all on
      // screen, and the question's box is drawn whole.
      expect(app.frame()).toContain("Implement · one");
      expect(app.frame()).toContain("Which one?");
      expect(app.frame()).toContain("Esc leave the run open");
      // It covers the bottom of the list while it is up, and covers it opaquely: the
      // regions behind used to bleed through an unpainted box.
      expect(app.frame()).not.toContain("Detail");
      // Nothing overlaps: a region squeezed under its own border used to draw its text
      // through it, which shows up as box-drawing characters inside a line of text.
      const listRow = lines.find((line) => line.includes("Implement · one"))!;
      expect(listRow).not.toContain("─");
    }),
  ));

test("a question is answered from the keyboard too", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(
        appState({
          board: board({
            active: [run("r1", "Implement · one", { choice: choice("r1", "Fix or stop?") })],
          }),
        }),
      );

      app.mockInput.pressArrow("down");
      yield* app.flush;
      app.mockInput.pressEnter();
      yield* app.flush;

      expect(app.acted()).toEqual([{ _tag: "Answer", runId: "r1", value: "Stop here" }]);
    }),
  ));

test("below the column threshold the detail is a full-width overlay", () =>
  runEffect(
    Effect.gen(function* () {
      // Side by side: one screen row carries both region titles.
      const wide = yield* mount(appState({ board: BOARD }), 100, 26);
      const wideTop = wide.frame().split("\n")[1]!;
      expect(wideTop).toContain("Runs");
      expect(wideTop).toContain("Detail");

      // Stacked: the Detail box opens on a row of its own, under the whole list.
      const narrow = yield* mount(appState({ board: BOARD }), 60, 26);
      const narrowLines = narrow.frame().split("\n");
      expect(narrowLines[1]!).toContain("Runs");
      expect(narrowLines[1]!).not.toContain("Detail");
      expect(narrowLines.findIndex((l) => l.includes("Detail"))).toBeGreaterThan(1);
    }),
  ));

test("filtering narrows the list, and survives the keyboard leaving it", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ board: BOARD }));

      app.mockInput.pressKey("/");
      yield* Effect.promise(() => app.mockInput.typeText("worktree"));
      yield* app.flush;

      expect(app.frame()).toContain("Review · worktree");
      expect(app.frame()).not.toContain("Implement · add-a-picker");
      expect(app.frame()).toContain("/worktree");

      // Enter stops typing and keeps the filter: narrowing the list is how a row is
      // found, so an action key has to reach the Selection again, not the filter.
      app.mockInput.pressEnter();
      yield* app.flush;
      app.mockInput.pressKey("l");
      yield* app.flush;
      expect(app.acted()).toEqual([{ _tag: "OpenLog", runId: "r2" }]);
      expect(app.frame()).not.toContain("Implement · add-a-picker");

      app.mockInput.pressKey("/");
      for (const _ of "worktree") app.mockInput.pressBackspace();
      yield* app.flush;
      expect(app.frame()).toContain("Implement · add-a-picker");
      expect(app.frame()).not.toContain("/worktree");
    }),
  ));

const MR: MrDetails = {
  _tag: "Details",
  iid: "42",
  project: "gitlab.example.com/g/p",
  title: "Make the tab an application",
  state: "opened",
  author: "mk",
  sourceBranch: "collie-app",
  targetBranch: "master",
  pipeline: "success",
  approvals: "1 of 2 still needed",
  unresolved: true,
  notes: 7,
  headSha: "0123456",
  updatedAt: NOW,
  url: "https://gitlab.example.com/g/p/-/merge_requests/42",
};

function runDetail(over: Partial<RunDetail> = {}): RunDetail {
  return {
    id: "r2",
    dir: "/state/runs/r2",
    title: "Review · !42",
    status: "done",
    inputs: [{ name: "target", value: "mr:gitlab.example.com/g/p!42", source: "the branch's MR" }],
    steps: [{ id: "review", status: "done", note: "two reviewers agreed", agents: ["rev-1"] }],
    handoffs: [],
    review: {
      _tag: "Text",
      text: "# Review\n\nSummary.\n\n- [strong] a real one\n",
      truncated: false,
    },
    outputs: [],
    tail: null,
    finishedAt: NOW - 3_600_000,
    mr: null,
    ...over,
  };
}

function definition(over: Partial<DefinitionRow> = {}): DefinitionRow {
  return {
    name: "review",
    title: "review — look at a change",
    layer: "baseline",
    provenance: "",
    path: "/plugin/workflows/review.md",
    inputs: ["target"],
    steps: ["review · reviewer · claude/opus · 2 in parallel", "synthesize · reviewer"],
    decisions: [{ step: "post", titles: ["Post to MR", "Don't post"], hints: ["", ""] }],
    problems: [],
    ...over,
  };
}

const SETTINGS: SettingsView = {
  configPath: "/config/config.json",
  defaults: [
    { key: "harness", value: "claude" },
    { key: "model", value: "opus" },
  ],
  remembered: [{ key: "linear.team", value: "CEG" }],
  trust: { cwd: "/w/collie", state: "trusted" },
};

test("the nav switches views, and each view lists its own rows", () =>
  runEffect(
    Effect.gen(function* () {
      const history = [
        {
          id: "r9",
          dir: "/d/r9",
          glyph: "✓",
          title: "Review · !42",
          detail: "done · 2 finding(s) open",
          at: NOW - 86_400_000,
          target: "mr:gitlab.example.com/g/p!42",
          fixable: true,
          choice: null,
        },
      ];
      const app = yield* mount(appState({ board: BOARD, history }));

      // Tab asks for the next view; what is shown is state, so the app only asks.
      app.mockInput.pressTab();
      yield* app.flush;
      expect(app.acted()).toContainEqual({ _tag: "ShowView", view: "history" });

      yield* app.setState(appState({ view: "history", board: BOARD, history }));
      const frame = app.frame();
      expect(frame).toContain("[History]");
      expect(frame).toContain("Review · !42");
      // This Session's live work is the Runs view's; History is everything finished.
      expect(frame).not.toContain("Implement · add-a-picker");
    }),
  ));

test("an empty view says what to do rather than nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ view: "history", board: board(), history: [] }));
      expect(app.frame()).toContain("No finished runs for this checkout yet");
    }),
  ));

test("a selected run's review is readable without leaving the tab", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(
        appState({
          board: board({ recent: [run("r2", "Review · !42", { glyph: "✓", detail: "done" })] }),
          detail: runDetail(),
        }),
        100,
        44,
      );

      const said = app.said();
      expect(said).toContain("[strong] a real one");
      expect(said).toContain("review · done · two reviewers agreed");
      // The target and where it came from; the value itself hard-wraps in a column
      // this narrow, so the assertion is on the phrase rather than on the wrap.
      expect(said).toContain("target = mr:gitlab.");
      expect(said).toContain("(the branch's MR)");
    }),
  ));

test("the panel shows no detail for a selection whose detail has not been read yet", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(
        appState({
          board: board({
            recent: [
              run("r2", "Review · !42", { glyph: "✓", detail: "done" }),
              run("r3", "Plan · a thing", { glyph: "✓", detail: "done" }),
            ],
          }),
          detail: runDetail({ mr: MR }),
        }),
        100,
        60,
      );
      expect(app.said()).toContain("[strong] a real one");

      // The read for r3 is still in flight, so r2's review, Outputs and merge request
      // must not be shown under r3's heading.
      yield* app.click(4, app.lineOf("Plan · a thing"));
      const said = app.said();
      expect(said).not.toContain("[strong] a real one");
      expect(said).not.toContain("Make the tab an application");
    }),
  ));

test("a run with no review, and an Output nobody wrote, are stated and nothing breaks", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(
        appState({
          board: board({ recent: [run("r2", "Review · x", { glyph: "✓", detail: "done" })] }),
          detail: runDetail({
            review: { _tag: "None", reason: "this run wrote no review.md" },
            outputs: [
              {
                step: "review",
                where: "steps/review/opus/reviewed.json",
                state: "missing",
                text: "no Output at steps/review/opus/reviewed.json",
              },
            ],
          }),
        }),
        100,
        44,
      );

      const said = app.said();
      expect(said).toContain("this run wrote no review.md");
      // A long path hard-wraps mid-word in a narrow panel, so the state is what is
      // asserted rather than where the wrap fell.
      expect(said).toContain("· missing");
      expect(said).toContain("no Output at");
      // The rest of the panel is intact: this is a state, not a failure.
      expect(said).toContain("two reviewers agreed");
    }),
  ));

test("the log tails inside the panel, and l still opens it in a pane", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(
        appState({
          board: board({ recent: [run("r2", "Review · !42", { glyph: "✓", detail: "done" })] }),
          detail: runDetail({
            tail: { _tag: "Text", text: "step review: two reviewers agreed\n", truncated: true },
          }),
        }),
        100,
        60,
      );

      const said = app.said();
      expect(said).toContain("step review: two reviewers agreed");

      // The toggle is the panel's; the pane is still what `l` opens, because grepping
      // and copying belong in a pane.
      app.mockInput.pressKey("t");
      yield* app.flush;
      app.mockInput.pressKey("l");
      yield* app.flush;
      expect(app.acted()).toEqual([{ _tag: "ToggleTail" }, { _tag: "OpenLog", runId: "r2" }]);
    }),
  ));

test("the panel's own keys are offered only where they can act", () =>
  runEffect(
    Effect.gen(function* () {
      // A Settings row has no Run behind it: tailing a log and paging a review are both
      // about the selected Run's detail, so neither key is on the line or does anything.
      const settings = yield* mount(appState({ view: "settings", settings: SETTINGS }));
      expect(settings.frame()).not.toContain("t log tail");
      expect(settings.frame()).not.toContain("m more review");
      settings.mockInput.pressKey("t");
      yield* settings.flush;
      settings.mockInput.pressKey("m");
      yield* settings.flush;
      expect(settings.acted()).toEqual([]);

      // A Run whose review was not cut short: its log can be tailed, and there is no
      // more of the review to read.
      const whole = yield* mount(
        appState({
          board: board({ recent: [run("r2", "Review · !42", { glyph: "✓", detail: "done" })] }),
          detail: runDetail(),
        }),
        100,
        60,
      );
      expect(whole.frame()).toContain("t log tail");
      expect(whole.frame()).not.toContain("m more review");
      whole.mockInput.pressKey("m");
      yield* whole.flush;
      expect(whole.acted()).toEqual([]);
      whole.mockInput.pressKey("t");
      yield* whole.flush;
      expect(whole.acted()).toEqual([{ _tag: "ToggleTail" }]);
    }),
  ));

test("a review the panel cut short says how to read the rest of it", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(
        appState({
          board: board({ recent: [run("r2", "Review · !42", { glyph: "✓", detail: "done" })] }),
          detail: runDetail({
            review: { _tag: "Text", text: "# Review\n\nSummary.\n", truncated: true },
          }),
        }),
        100,
        60,
      );

      // Not "open the log": the log is the runner's, and the bytes left out of the
      // review are not in it.
      expect(app.said()).toContain("m reads more of it");
      expect(app.frame()).toContain("m more review");

      app.mockInput.pressKey("m");
      yield* app.flush;
      expect(app.acted()).toEqual([{ _tag: "MoreReview" }]);
    }),
  ));

test("a merge request panel says what it is and what has moved since the review", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(
        appState({
          board: board({ recent: [run("r2", "Review · !42", { glyph: "✓", detail: "done" })] }),
          detail: runDetail({ mr: MR }),
        }),
        100,
        44,
      );

      const said = app.said();
      expect(said).toContain("!42 · Make the tab an application");
      expect(said).toContain("opened · mk");
      expect(said).toContain("collie-app → master");
      expect(said).toContain("pipeline success");
      expect(said).toContain("1 of 2 still needed");
      expect(said).toContain("unresolved discussion(s)");
      // The line that decides whether to look again.
      expect(said).toContain("1h after this review");
    }),
  ));

test("no glab, or a merge request glab cannot read, is one line and no more", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(
        appState({
          board: board({ recent: [run("r2", "Review · !42", { glyph: "✓", detail: "done" })] }),
          detail: runDetail({ mr: { _tag: "Unavailable", reason: "glab is not installed" } }),
        }),
        100,
        // One row taller than the panel's content needs: the footer gives the
        // Selection's buttons two rows, because five of them do not fit one.
        45,
      );

      const said = app.said();
      expect(said).toContain("glab is not installed");
      // Everything else the panel had is still there.
      expect(said).toContain("[strong] a real one");
      expect(said).toContain("two reviewers agreed");
    }),
  ));

test("a run that stopped with findings offers to be built from, and one that did not does not", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(
        appState({
          board: board({
            recent: [
              run("r2", "Review · !42", {
                glyph: "✓",
                detail: "done",
                target: "mr:gitlab.example.com/g/p!42",
                fixable: true,
              }),
              run("r3", "Plan · a thing", { glyph: "✓", detail: "done" }),
            ],
          }),
        }),
      );

      yield* app.click(4, app.lineOf("Review · !42"));
      const frame = app.frame();
      expect(frame).toContain("[x fix what is open]");
      expect(frame).toContain("[a review again]");
      expect(frame).toContain("[o post to the MR]");

      app.mockInput.pressKey("x");
      yield* app.flush;
      app.mockInput.pressKey("a");
      yield* app.flush;
      app.mockInput.pressKey("o");
      yield* app.flush;
      expect(app.acted()).toEqual([
        { _tag: "FixFindings", runId: "r2" },
        { _tag: "ReviewAgain", target: "mr:gitlab.example.com/g/p!42" },
        { _tag: "PostReview", runId: "r2" },
      ]);

      // A run with no review has nothing to build from, so the key is not offered.
      yield* app.click(4, app.lineOf("Plan · a thing"));
      expect(app.frame()).not.toContain("fix what is open");
    }),
  ));

test("the Workflows view shows a broken fork's error without running it", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(
        appState({
          view: "workflows",
          definitions: {
            workflows: [
              definition(),
              definition({
                name: "broken",
                title: "broken — points at nothing",
                layer: "project",
                problems: ['workflow "broken" step "build": unknown persona "no-such-persona"'],
              }),
            ],
            errors: [],
          },
        }),
      );

      const frame = app.frame();
      expect(frame).toContain("[baseline]");
      expect(frame).toContain("[project]");
      expect(frame).toContain("1 problem(s)");

      // The detail spells it out, and a workflow row offers to run it.
      yield* app.click(4, app.lineOf("broken — points at nothing"));
      const after = app.frame();
      expect(after).toContain("unknown persona");
      expect(after).toContain("[Enter run]");

      app.mockInput.pressEnter();
      yield* app.flush;
      expect(app.acted()).toEqual([{ _tag: "RunWorkflow", workflow: "broken" }]);
    }),
  ));

test("a selected workflow's steps are part of what the panel shows", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(
        appState({
          view: "workflows",
          definitions: { workflows: [definition()], errors: [] },
        }),
        100,
        44,
      );

      const said = app.said();
      expect(said).toContain("review · reviewer · claude/opus · 2 in parallel");
      expect(said).toContain("synthesize · reviewer");
    }),
  ));

test("Settings gives a default a new value and asks for it to be written", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ view: "settings", settings: SETTINGS }));

      const frame = app.frame();
      expect(frame).toContain("harness");
      expect(frame).toContain("linear.team");
      expect(frame).toContain("trusted");

      // Clicking the footer's button and pressing the key are the same thing: the
      // button used to dispatch the command verbatim, and its "ask me first"
      // placeholder was an empty value — so a click on `[Enter set]` wrote the empty
      // string and unset the default it was labelled to set.
      yield* app.click(4, app.lineOf("model"));
      yield* app.click(app.columnOf("[Enter set]", "[Enter set]") + 2, app.lineOf("[Enter set]"));
      yield* app.flush;
      expect(app.acted()).toEqual([]);
      expect(app.frame()).toContain("model = opus");
      for (const _ of "opus") app.mockInput.pressBackspace();
      yield* Effect.promise(() => app.mockInput.typeText("sonnet"));
      yield* app.flush;
      expect(app.frame()).toContain("model = sonnet");

      app.mockInput.pressEnter();
      yield* app.flush;
      expect(app.acted()).toEqual([{ _tag: "SetDefault", key: "model", value: "sonnet" }]);
    }),
  ));

test("a filter that matches an agent keeps the run it works for above it", () =>
  runEffect(
    Effect.gen(function* () {
      // Filtering the nested rows one by one dropped the run and left its agent under
      // nothing, and an agent row no longer names its own run.
      const app = yield* mount(appState({ board: BOARD }));

      app.mockInput.pressKey("/");
      yield* Effect.promise(() => app.mockInput.typeText("Implementer"));
      yield* app.flush;

      expect(app.frame()).toContain("Implementer");
      expect(app.frame()).toContain("Implement · add-a-picker");
      // The run comes above its agent, not below it or somewhere else.
      expect(app.lineOf("Implement · add-a-picker")).toBeLessThan(app.lineOf("Implementer"));
      // And nothing else came with them.
      expect(app.frame()).not.toContain("Review · worktree");
    }),
  ));

test("filtering says how much is left, and a re-read can be asked for", () =>
  runEffect(
    Effect.gen(function* () {
      const app = yield* mount(appState({ board: BOARD }));

      app.mockInput.pressKey("/");
      yield* Effect.promise(() => app.mockInput.typeText("Review"));
      yield* app.flush;
      expect(app.frame()).toContain("1 row(s)");

      app.mockInput.pressEnter();
      yield* app.flush;
      app.mockInput.pressKey("R");
      yield* app.flush;
      expect(app.acted()).toContainEqual({ _tag: "Refresh" });
    }),
  ));

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
      expect(t.captureCharFrame()).toContain("stopped: a row rendered something");
    }),
  ));

function Broken() {
  throw new Error("a row rendered something impossible");
}

test("the render-error screen can do the one thing it offers, and gives the mouse back", () =>
  runEffect(
    Effect.gen(function* () {
      const quits: number[] = [];
      const t = yield* Effect.promise(() =>
        testRender(
          () => (
            <StoppedDrawing
              why="a row rendered something impossible"
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

test("a paste reaches whichever field owns the keyboard, and never submits it", () =>
  runEffect(
    Effect.gen(function* () {
      // Every field the tab types into, in the order the keyboard handler gives them
      // the keys: a paste that only worked in one of them would be the same bug again.
      const filtering = yield* mount(appState({ board: BOARD }));
      filtering.mockInput.pressKey("/");
      yield* Effect.promise(() => filtering.mockInput.pasteBracketedText("worktree\n"));
      yield* filtering.flush;
      expect(filtering.frame()).toContain("/worktree");
      expect(filtering.frame()).not.toContain("Implement · add-a-picker");

      const settings = yield* mount(appState({ view: "settings", settings: SETTINGS }));
      yield* settings.click(4, settings.lineOf("model"));
      yield* settings.click(
        settings.columnOf("[Enter set]", "[Enter set]") + 2,
        settings.lineOf("[Enter set]"),
      );
      for (const _ of "opus") settings.mockInput.pressBackspace();
      yield* Effect.promise(() => settings.mockInput.pasteBracketedText("sonnet\n"));
      yield* settings.flush;
      // The newline came with the paste and the value is still being edited: nothing
      // has been written until Enter is pressed for it.
      expect(settings.frame()).toContain("model = sonnet");
      expect(settings.acted()).toEqual([]);
      settings.mockInput.pressEnter();
      yield* settings.flush;
      expect(settings.acted()).toEqual([{ _tag: "SetDefault", key: "model", value: "sonnet" }]);

      const asking = yield* mount(
        appState({
          board: board({
            active: [
              run("r1", "Implement · one", {
                choice: { ...choice("r1", "Which merge request?"), kind: "ask", items: [] },
              }),
            ],
          }),
        }),
      );
      const url = "https://gitlab.cego.dk/cego/collie/-/merge_requests/7";
      yield* Effect.promise(() => asking.mockInput.pasteBracketedText(`${url}\n`));
      yield* asking.flush;
      expect(asking.frame()).toContain("merge_requests/7");
      expect(asking.acted()).toEqual([]);
      asking.mockInput.pressEnter();
      yield* asking.flush;
      expect(asking.acted()).toEqual([{ _tag: "Answer", runId: "r1", value: url }]);
    }),
  ));
