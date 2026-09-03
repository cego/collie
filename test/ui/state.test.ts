import { expect, test } from "bun:test";
import {
  actionsFor,
  runIdOf,
  answerFor,
  clampSelection,
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
    ["agent", "agent:impl-1"],
    ["active", "run:r1"],
    ["recent", "run:r0"],
  ]);
  // Ids never carry a position: the list re-sorts every refresh and an index
  // would silently retarget the action.
  expect(rows.map((r) => r.id)).not.toContain("0");
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
  // SAFETY: one agent, one active and one recent row went in, and the length is
  // asserted above, so the three rows are there in that order.
  const [agent, active, recent] = rows as [Row, Row, Row];

  expect(actionsFor(agent).map((a) => [a.key, a.command])).toEqual([
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

test("a question is answered by what was typed", () => {
  const ask: PendingChoice = { ...MENU, kind: "ask", items: [] };
  expect(answerFor(ask, { index: 0, typed: "" }, "h").asking.typed).toBe("h");
  expect(answerFor(ask, { index: 0, typed: "hi" }, "\x7f").asking.typed).toBe("h");
  expect(answerFor(ask, { index: 0, typed: "hi" }, "\r").value).toBe("hi");
  // A menu key means nothing here and must not be typed into the answer.
  expect(answerFor(ask, { index: 0, typed: "hi" }, "\x1b[B").asking.typed).toBe("hi");
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
