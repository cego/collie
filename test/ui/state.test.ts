import { expect, test } from "bun:test";
import {
  actionsFor,
  runIdOf,
  answerFor,
  clampSelection,
  keyboardOn,
  matching,
  optionWindow,
  pasteInto,
  rereads,
  retarget,
  rowsOf,
  type Row,
} from "../../src/ui/state";
import { DateTime } from "effect";
import { ago, agoShort } from "../../src/time";
import type { PendingChoice } from "../../src/driver";
import type { WorkspaceView } from "../../src/workspace";
import { focus } from "../support/focus";

/** A fixed clock: relative times are the point, so they must not depend on the wall. */
const NOW = Date.parse("2026-09-02T12:00:00.000Z");
/** `ago` takes an ISO string and `agoShort` epoch millis; this is the one clock in both. */
const FIXED_ISO = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

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

function run(id: string, over: Partial<WorkspaceView["active"][number]> = {}) {
  return {
    id,
    dir: `/state/runs/${id}`,
    glyph: "⚙",
    title: `Implement · ${id}`,
    detail: "build",
    at: NOW - 120_000,
    target: null,
    fixable: false,
    choice: null,
    ...over,
  };
}

function agent(key: string, name: string, run: string) {
  return { key, name, agent: `${name.toLowerCase()}-1`, status: "working", run };
}

const MENU: PendingChoice = {
  id: "c1",
  kind: "menu",
  run: "r1",
  step: "next",
  header: "What next?",
  footer: "↑↓ move",
  items: [
    { id: "Implement now", title: "Implement now" },
    { id: "Stop here", title: "Stop here" },
  ],
};

test("every row carries the stable id its actions are aimed at", () => {
  const rows = rowsOf(
    board({
      agents: [{ key: "1", name: "Implementer", agent: "impl-1", status: "working", run: "r1" }],
      active: [run("r1")],
      recent: [run("r0", { glyph: "✓", detail: "done" })],
    }),
  );

  expect(rows.map((r) => [r.kind, r.id])).toEqual([
    ["active", "run:r1"],
    ["agent", "agent:impl-1"],
    ["recent", "run:r0"],
  ]);
  // Ids never carry a position: the list re-sorts every refresh and an index
  // would silently retarget the action.
  expect(rows.map((r) => r.id)).not.toContain("0");
});

test("an agent is listed under the run it works for", () => {
  // A run's steps used to float above every run, so which run an agent belonged to was
  // in the detail column or nowhere. They hang off their run now.
  const rows = rowsOf(
    board({
      agents: [
        agent("1", "Implementer", "r1"),
        agent("2", "Reviewer", "r1"),
        agent("3", "Planner", "r2"),
      ],
      active: [run("r1"), run("r2")],
      recent: [run("r0", { glyph: "✓", detail: "done" })],
    }),
  );

  expect(rows.map((r) => [r.kind, r.title])).toEqual([
    ["active", "Implement · r1"],
    ["agent", "├ Implementer"],
    ["agent", "└ Reviewer"],
    ["active", "Implement · r2"],
    ["agent", "└ Planner"],
    ["recent", "Implement · r0"],
  ]);
  // The run above it says which run it is, so the detail column says what it is doing
  // instead of repeating the name.
  expect(rows[1]!.detail).toBe("working");
  // Every agent row keeps what a key and an action are aimed at.
  expect(rows[1]!.agent).toBe("implementer-1");
  expect(rows[1]!.key).toBe("1");
  expect(actionsFor(rows[1]!).map((a) => a.key)).toEqual(["1"]);
});

test("an agent whose run is not on the board goes in a group of its own", () => {
  const rows = rowsOf(
    board({
      agents: [
        agent("1", "Implementer", "r1"),
        // A finished run keeps its agents: the implementer a hand-off names outlives the
        // run it was started for, so it hangs off that run like any other.
        agent("2", "Reviewer", "r0"),
        agent("3", "Stray", "gone"),
      ],
      active: [run("r1")],
      recent: [run("r0", { glyph: "✓", detail: "done" })],
    }),
  );

  expect(rows.map((r) => [r.kind, r.title])).toEqual([
    ["active", "Implement · r1"],
    ["agent", "└ Implementer"],
    ["recent", "Implement · r0"],
    ["agent", "└ Reviewer"],
    ["header", "agents with no run here"],
    ["agent", "└ Stray"],
  ]);
  // An orphan has no run above it, so its own row is the only place the run can be said.
  expect(rows.find((r) => r.agent === "stray-1")!.detail).toBe("working · gone");
  // The header names a group; it is not a row anything can be asked of.
  expect(actionsFor(rows.find((r) => r.kind === "header")!)).toEqual([]);
});

test("a re-sorted list keeps the same run selected", () => {
  const before = rowsOf(board({ active: [run("r1"), run("r2")] }));
  const after = rowsOf(board({ active: [run("r2"), run("r1")] }));

  expect(clampSelection("run:r1", before, after)).toBe("run:r1");
});

test("a selection that finishes lands on the row that took its place", () => {
  const before = rowsOf(board({ active: [run("r1"), run("r2"), run("r3")] }));
  const after = rowsOf(board({ active: [run("r1"), run("r3")] }));

  // r2 was second; second is now r3.
  expect(clampSelection("run:r2", before, after)).toBe("run:r3");
  // The last row going leaves the new last row selected, not nothing.
  expect(clampSelection("run:r3", before, rowsOf(board({ active: [run("r1")] })))).toBe("run:r1");
  expect(clampSelection("run:r1", before, rowsOf(board()))).toBeNull();
});

test("an empty board selects nothing, and a fresh board selects its first row", () => {
  expect(clampSelection(null, [], rowsOf(board({ active: [run("r1")] })))).toBe("run:r1");
  expect(clampSelection(null, [], [])).toBeNull();
});

test("a row's actions name the row, not the newest run", () => {
  const rows = rowsOf(
    board({
      agents: [{ key: "3", name: "Reviewer", agent: "rev-1", status: "idle", run: "r1" }],
      active: [run("r1")],
      recent: [run("r0")],
    }),
  );
  expect(rows).toHaveLength(3);
  // SAFETY: one active run with one agent under it and one recent run went in, and the
  // length is asserted above, so the three rows are there in that order.
  const [active, working, recent] = rows as [Row, Row, Row];

  expect(actionsFor(working).map((a) => [a.key, a.command])).toEqual([
    ["3", { _tag: "FocusAgent", agent: "rev-1" }],
  ]);
  expect(actionsFor(active).map((a) => [a.key, a.command])).toEqual([
    ["l", { _tag: "OpenLog", runId: "r1" }],
    ["k", { _tag: "StopRun", runId: "r1" }],
  ]);
  // A finished run has no driver to stop; offering the key would be a lie.
  expect(actionsFor(recent).map((a) => a.key)).toEqual(["l"]);
});

test("a clean review can still be opened in a browser", () => {
  const target = "mr:gitlab.example.com/g/p!42";
  // SAFETY: one recent row goes into each board, so each list has exactly that row.
  const [clean] = rowsOf(board({ recent: [run("r0", { target, fixable: false })] })) as [Row];
  // SAFETY: as above — one row in, one row out.
  const [withFindings] = rowsOf(board({ recent: [run("r1", { target, fixable: true })] })) as [Row];

  // Nothing to fix and nothing to post, but the merge request is still there to look at:
  // opening it has nothing to do with whether the review found anything.
  expect(actionsFor(clean).map((a) => a.key)).toEqual(["l", "a", "w"]);
  expect(actionsFor(withFindings).map((a) => a.key)).toEqual(["l", "x", "a", "o", "w"]);
});

test("one thing owns the keyboard, in one order", () => {
  // Three things have to agree about which field the keyboard is on: the keys, a paste
  // and what the footer offers. They each used to work it out again.
  const setting = { key: "model", value: "opus" };
  const all = { flow: true, choice: MENU, filtering: true, setting };

  expect(keyboardOn(all)._tag).toBe("Flow");
  expect(keyboardOn({ ...all, flow: false })).toEqual({ _tag: "Choice", choice: MENU });
  expect(keyboardOn({ ...all, flow: false, choice: null })._tag).toBe("Filter");
  expect(keyboardOn({ ...all, flow: false, choice: null, filtering: false })).toEqual({
    _tag: "Setting",
    setting,
  });
  // Nothing is taking typing, so the board's own keys are the ones that act.
  expect(keyboardOn({ flow: false, choice: null, filtering: false, setting: null })._tag).toBe(
    "Board",
  );
});

test("a menu is answered by the option the cursor is on", () => {
  const start = { index: 0, typed: "" };
  expect(answerFor(MENU, start, "\x1b[B").asking.index).toBe(1);
  // The cursor stops at the ends rather than wrapping past them.
  expect(answerFor(MENU, { index: 1, typed: "" }, "\x1b[B").asking.index).toBe(1);
  expect(answerFor(MENU, start, "\x1b[A").asking.index).toBe(0);
  expect(answerFor(MENU, { index: 1, typed: "" }, "\r").value).toBe("Stop here");
  // Esc leaves the run open, which is an empty answer rather than no answer.
  expect(answerFor(MENU, start, "\x1b").value).toBe("");
  expect(answerFor(MENU, start, "x").value).toBeNull();
});

test("a filter keeps a matching agent under the run it works for", () => {
  // The rows are already nested when the filter sees them, so filtering them one by one
  // could drop a run and leave its agent behind — and an agent row no longer names its
  // own run, so that row would say nothing about what it belongs to.
  const rows = rowsOf(
    board({
      agents: [agent("1", "Reviewer", "r1"), agent("2", "Planner", "r2")],
      active: [run("r1"), run("r2")],
      recent: [],
    }),
  );

  // The agent matches and its run does not, so the run comes with it, above it.
  expect(matching(rows, "Reviewer").map((r) => [r.kind, r.title])).toEqual([
    ["active", "Implement · r1"],
    ["agent", "└ Reviewer"],
  ]);
  // A run that matches brings only itself: its agents are not what was asked for.
  expect(matching(rows, "r2").map((r) => [r.kind, r.title])).toEqual([
    ["active", "Implement · r2"],
  ]);
  // The order is the board's, whatever order the matches were ranked in: a pick list
  // wants the best match first, and here that would lift an agent above its own run.
  const order = (kept: Row[]) => kept.map((r) => rows.indexOf(r));
  expect(order(matching(rows, "Planner"))).toEqual([2, 3]);
  expect(order(matching(rows, "r"))).toEqual([0, 1, 2, 3]);
  expect(matching(rows, "")).toEqual(rows);
  expect(matching(rows, "zzz")).toEqual([]);
});

test("a filter keeps a matching orphan under its header", () => {
  const rows = rowsOf(
    board({
      agents: [agent("1", "Stray", "gone")],
      active: [run("r1")],
      recent: [],
    }),
  );

  expect(matching(rows, "Stray").map((r) => [r.kind, r.title])).toEqual([
    ["header", "agents with no run here"],
    ["agent", "└ Stray"],
  ]);
});

test("a header is never kept without the group it names", () => {
  const rows = rowsOf(
    board({
      agents: [agent("1", "Stray", "gone")],
      active: [run("r1")],
      recent: [],
    }),
  );

  // The header's own words match, and every agent under it does not: a group heading
  // with no group under it is a line that says nothing.
  expect(matching(rows, "agents with no run")).toEqual([]);
  expect(matching(rows, "no run here")).toEqual([]);
  // It comes back the moment something in its group does match.
  expect(matching(rows, "Stray").map((r) => r.kind)).toEqual(["header", "agent"]);
});

test("a capped question shows a window of options that follows the cursor", () => {
  const items = ["a", "b", "c", "d", "e"];
  const shown = (at: number, room: number) => optionWindow(items, at, room);

  // Room for everything: no window at all.
  expect(shown(0, 5)).toEqual({ shown: items, hidden: 0 });
  // The cursor at the top, and then walked past the bottom of the window: it stays in
  // what is shown, because an option nobody can see is one nobody can knowingly choose.
  expect(shown(0, 3)).toEqual({ shown: ["a", "b", "c"], hidden: 2 });
  expect(shown(2, 3)).toEqual({ shown: ["a", "b", "c"], hidden: 2 });
  expect(shown(3, 3)).toEqual({ shown: ["b", "c", "d"], hidden: 2 });
  expect(shown(4, 3)).toEqual({ shown: ["c", "d", "e"], hidden: 2 });
  // A pane with room for one still shows the one the cursor is on.
  expect(shown(4, 1)).toEqual({ shown: ["e"], hidden: 4 });
});

test("a question is answered by what was typed", () => {
  const ask: PendingChoice = { ...MENU, kind: "ask", items: [] };
  expect(answerFor(ask, { index: 0, typed: "" }, "h").asking.typed).toBe("h");
  expect(answerFor(ask, { index: 0, typed: "hi" }, "\x7f").asking.typed).toBe("h");
  expect(answerFor(ask, { index: 0, typed: "hi" }, "\r").value).toBe("hi");
  // A menu key means nothing here and must not be typed into the answer.
  expect(answerFor(ask, { index: 0, typed: "hi" }, "\x1b[B").asking.typed).toBe("hi");
});

test("a paste fills a field and never submits it", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  const url = "https://gitlab.cego.dk/cego/collie/-/merge_requests/7";

  expect(pasteInto("", bytes(url))).toBe(url);
  expect(pasteInto("https://", bytes("gitlab.cego.dk"))).toBe("https://gitlab.cego.dk");
  // A copied line brings its newline with it, and a newline is the submit key: it has
  // to reach the field as nothing at all.
  expect(pasteInto("", bytes(`${url}\n`))).toBe(url);
  expect(pasteInto("", bytes(`one\r\ntwo\n`))).toBe("onetwo");
  // Escape sequences and every other control character go the same way; a pasted
  // branch name keeps its non-ASCII letters.
  expect(pasteInto("", bytes("\x1b[Bfix-\x07caf\u00e9"))).toBe("[Bfix-caf\u00e9");
});

test("a row says how long it has been like this, not when", () => {
  expect(agoShort(NOW, NOW)).toBe("now");
  expect(agoShort(NOW - 45_000, NOW)).toBe("45s ago");
  expect(agoShort(NOW - 120_000, NOW)).toBe("2m ago");
  expect(agoShort(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
  expect(agoShort(NOW - 4 * 86_400_000, NOW)).toBe("4d ago");
  // A run whose record never said when has no time to show rather than 1970.
  expect(agoShort(0, NOW)).toBe("");
  // A clock that ran backwards between the record and the read is not the future.
  expect(agoShort(NOW + 5_000, NOW)).toBe("now");
});

test("the long and short renderings never disagree about the unit", () => {
  // Both are on screen in one session — the resume menu's subtitles and the tab's row
  // list — so the same instant must not read as an hour in one and a day in the other.
  for (const seconds of [0, 59, 60, 3_599, 3_600, 86_399, 86_400, 200_000]) {
    const at = NOW - seconds * 1000;
    const long = ago(FIXED_ISO(at), NOW);
    const short = agoShort(at, NOW);
    const unit = long.includes("day") ? "d" : long.includes("hour") ? "h" : "m";
    if (long === "just now") continue;
    expect([seconds, short.includes(unit)]).toEqual([seconds, true]);
  }
});

test("the list carries the relative time each row is asked about", () => {
  const rows = rowsOf(board({ active: [run("r1", { at: NOW - 3_600_000 })] }));
  expect(rows[0]!.ago).toBe("1h ago");
});

test("one focus command changes only what it names", () => {
  const at = focus();

  expect(retarget(at, { _tag: "Select", id: "run:r1" }).selected).toBe("run:r1");
  expect(retarget(at, { _tag: "ToggleTail" }).tail).toBe(true);
  expect(retarget({ ...at, tail: true }, { _tag: "ToggleTail" }).tail).toBe(false);
  expect(retarget(at, { _tag: "Refresh" }).nonce).toBe(1);
  // Another page of a capped review, and a new Selection starts from the first page
  // again rather than inheriting how far the last one had been paged.
  expect(retarget(at, { _tag: "MoreReview" }).reviewPages).toBe(2);
  expect(retarget({ ...at, reviewPages: 4 }, { _tag: "Select", id: "run:r2" }).reviewPages).toBe(1);

  // A View shown once is kept fresh from then on; one already shown is not listed twice.
  const shown = retarget(at, { _tag: "ShowView", view: "history" });
  expect(shown.view).toBe("history");
  expect(shown.shown).toEqual(["runs", "history"]);
  expect(retarget(shown, { _tag: "ShowView", view: "runs" }).shown).toEqual(["runs", "history"]);
});

test("moving the Selection reuses the board; anything else re-reads it", () => {
  const at = focus({ selected: "run:r1" });

  // The first read has nothing to reuse.
  expect(rereads(null, at)).toEqual({ reuse: false, forceMr: false });

  // Moving the cursor is not a change in the world.
  expect(rereads(at, { ...at, selected: "run:r2" })).toEqual({ reuse: true, forceMr: false });

  // A Refresh, and the read after a command, go past the merge-request cache.
  expect(rereads(at, { ...at, nonce: 1 })).toEqual({ reuse: false, forceMr: true });
  expect(rereads(at, { ...at, selected: "run:r2", nonce: 1 })).toEqual({
    reuse: false,
    forceMr: true,
  });

  // Showing another View, and toggling the log tail, are both reads of their own.
  expect(rereads(at, { ...at, view: "history", shown: ["runs", "history"] }).reuse).toBe(false);
  expect(rereads(at, { ...at, tail: true }).reuse).toBe(false);
  expect(rereads(at, { ...at, reviewPages: 2 }).reuse).toBe(false);
});

test("a row id says whether it is a Run, and which one", () => {
  expect(runIdOf("run:review-17-20260902")).toBe("review-17-20260902");
  // Every other Selection has no Run behind it, so nothing is read for one.
  expect(runIdOf("agent:impl-1")).toBeNull();
  expect(runIdOf("workflow:review")).toBeNull();
  expect(runIdOf(null)).toBeNull();
  // The row ids the board mints are the ones this reads back.
  expect(runIdOf(rowsOf(board({ recent: [run("r1")] }))[0]!.id)).toBe("r1");
});
