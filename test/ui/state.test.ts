import { expect, test } from "bun:test";
import {
  actionsFor,
  dispositionsFor,
  menuFor,
  primaryFor,
  olderFinished,
  ALL_KEYS,
  footerKeys,
  keyIntent,
  markdownLines,
  needsYouStatus,
  nextQuestionId,
  runIdOf,
  runsRows,
  answerFor,
  clampSelection,
  keyboardOn,
  matching,
  optionWindow,
  pasteInto,
  rereads,
  sessionLocal,
  type Filter,
  retarget,
  rowsOf,
  NEEDS_YOU,
  selectableRows,
  viewRows,
  wideRows,
  type KeyContext,
  type Keypress,
  type AppState,
  type Row,
} from "../../src/ui/state";
import { NO_MARKS } from "../../src/lines";
import { DateTime } from "effect";
import { ago, agoShort, took } from "../../src/time";
import type { PendingChoice } from "../../src/board";
import type { WideGroup, WideView, WorkspaceView } from "../../src/workspace";
import { NO_OUTCOME } from "../../src/workspace";
import { focus } from "../support/focus";
import { task } from "../support/task";

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
    children: [],
    fixable: false,
    choice: null,
    needsYou: false,
    ...NO_OUTCOME,
    ...over,
  };
}

function agent(key: string, name: string, run: string, now: string | null = null) {
  return { key, name, agent: `${name.toLowerCase()}-1`, status: "working", run, now };
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
      agents: [
        { key: "1", name: "Implementer", agent: "impl-1", status: "working", run: "r1", now: null },
      ],
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
  expect(actionsFor(rows[1]!, HERE).map((a) => a.key)).toEqual(["1"]);
});

test("a run's children are listed under it, and its agents under those", () => {
  // A plan run that fanned out is one thing with several runs inside it, so its
  // repository runs hang off it the way its agents do rather than floating beside it.
  const rows = rowsOf(
    board({
      agents: [agent("1", "Implementer", "child-api")],
      active: [
        run("plan-1", { detail: "wave 1/2 · waiting on cego/api", children: ["child-api"] }),
        run("child-api"),
      ],
    }),
  );

  expect(rows.map((r) => [r.kind, r.title, r.depth])).toEqual([
    ["active", "Implement · plan-1", 0],
    ["active", "Implement · child-api", 1],
    ["agent", "└ Implementer", 1],
  ]);
  // Enter on a child still goes to that child's own run.
  expect(rows[1]!.jump).toMatchObject({ kind: "run", runId: "child-api" });
});

test("an ordinary chain's child is a row of its own, not nested under a finished parent", () => {
  // A `plan` run that chained finishes the moment its child has a Driver, so the child
  // is a live run and the parent is a finished one. Nesting on parentage drew that live
  // run inside the finished region — and moved it back out when the parent aged off.
  const rows = rowsOf(
    board({
      active: [run("implement-1")],
      recent: [run("plan-1", { glyph: "✓", detail: "done" })],
    }),
  );

  expect(rows.map((r) => [r.kind, r.title, r.depth])).toEqual([
    ["active", "Implement · implement-1", 0],
    ["recent", "Implement · plan-1", 0],
  ]);
});

test("a run that needs you is under the header, and the header only when one is", () => {
  // The header is drawn from the rows that will be, not from the list before nesting
  // took some of them away: it used to sit over nothing when the only run needing an
  // answer was a repository run of a fan-out.
  const nestedOnly = rowsOf(
    board({
      active: [
        run("plan-1", { children: ["child-api"] }),
        run("child-api", { needsYou: true, choice: MENU }),
      ],
    }),
  );

  expect(nestedOnly.map((r) => r.kind)).toEqual(["active", "active"]);
  expect(nestedOnly.map((r) => r.title)).not.toContain(NEEDS_YOU);

  // And a top-level run that needs you still gets it.
  const asking = rowsOf(board({ active: [run("r1", { needsYou: true, choice: MENU })] }));
  expect(asking[0]!.title).toBe(NEEDS_YOU);
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
  expect(
    actionsFor(
      rows.find((r) => r.kind === "header")!,
      HERE,
    ),
  ).toEqual([]);
});

/** One workspace of the wide board: what is in it, and what its group row says. */
function group(label: string, over: Partial<WideGroup> = {}): WideGroup {
  return {
    workspaceId: `w${label.length}`,
    label,
    glyph: "⚙",
    running: over.active?.length ?? 0,
    needsYou: 0,
    summary: "1 running · build",
    active: [],
    recent: [],
    agents: [],
    ...over,
  };
}

function wideView(groups: WideGroup[], quiet: string[] = []): WideView {
  return { groups, quiet, now: NOW };
}

test("the wide board is one tree: workspaces, their runs, and each run's agents", () => {
  const rows = wideRows(
    wideView(
      [
        group("Implement · glass", {
          agents: [agent("1", "Implementer", "r1"), agent("2", "Reviewer", "r1")],
          active: [run("r1")],
          recent: [run("r0", { glyph: "✓", detail: "done" })],
        }),
        group("Collie", {
          summary: "nothing running · done",
          recent: [run("r9", { glyph: "✓", detail: "done" })],
        }),
      ],
      ["Env", "gitlab.cego.dk"],
    ),
  );

  expect(rows.map((r) => [r.kind, r.depth, r.title])).toEqual([
    ["group", 0, "Implement · glass"],
    // Named by workflow alone: the group row above already says what it is for.
    ["active", 1, "Implement"],
    ["agent", 2, "├ Implementer"],
    ["agent", 2, "└ Reviewer"],
    ["recent", 1, "Implement"],
    // A blank line between workspaces, and nothing selectable on it.
    ["header", 0, ""],
    ["group", 0, "Collie"],
    ["recent", 1, "Implement"],
    ["header", 0, ""],
    // The rest of the session: named, so nothing is hidden, and out of the way.
    ["header", 0, "2 more workspace(s)"],
  ]);
  // A group row is selectable and a spacer is not, so the arrows walk workspaces.
  expect(selectableRows(rows).map((r) => r.kind)).toEqual([
    "group",
    "active",
    "agent",
    "agent",
    "recent",
    "group",
    "recent",
  ]);
  // The group row is the whole triage: what it is, how much is going, and the leading
  // run's step.
  expect(rows[0]!.glyph).toBe("⚙");
  expect(rows[0]!.detail).toBe("1 running · build");
  expect(rows.at(-1)!.detail).toBe("nothing of Collie's in them · Env · gitlab.cego.dk");
  // The agents keep the digit that focuses them.
  expect(rows[2]!.key).toBe("1");
});

test("the digits are numbered across the tree, so one names the row it is on", () => {
  // Every group numbers its own agents from 1, so without renumbering each workspace
  // showed a `1` and `keyIntent` — which takes the first row with that digit — focused
  // the first workspace's agent wherever the cursor was.
  const rows = wideRows(
    wideView([
      group("Implement · glass", {
        agents: [agent("1", "Implementer", "r1"), agent("2", "Reviewer", "r1")],
        active: [run("r1")],
      }),
      group("Collie", { agents: [agent("1", "Planner", "r2")], active: [run("r2")] }),
    ]),
  );

  const digits = rows.filter((r) => r.kind === "agent").map((r) => [r.title, r.key]);
  expect(digits).toEqual([
    ["├ Implementer", "1"],
    ["└ Reviewer", "2"],
    ["└ Planner", "3"],
  ]);
  // Past the ninth the row stays and the digit goes, as on the local board: there are
  // nine digits, and a board of every workspace can hold more agents than that.
  const many = wideRows(
    wideView([
      group("Implement · glass", {
        agents: Array.from({ length: 10 }, (_, i) => agent("", `Agent ${i}`, "r1")),
        active: [run("r1")],
      }),
    ]),
  ).filter((r) => r.kind === "agent");
  expect(many).toHaveLength(10);
  expect(many.map((r) => r.key)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", null]);

  // And the digit reaches that agent: the second workspace's is `3`, not another `1`.
  const context = keys({ rows, row: rows[0]! });
  expect(keyIntent(context, press("3"))).toEqual({
    _tag: "Do",
    command: { _tag: "FocusAgent", agent: "planner-1" },
  });
});

test("an agent in the tree keeps the model that tells two variants apart", () => {
  // `agentTitle` appends the model where a step ran several, and the tree used to take
  // everything after the first ` · ` off every nested row — so two reviewers of one
  // step became two rows both reading `Review`.
  const rows = wideRows(
    wideView([
      group("Implement · glass", {
        agents: [agent("1", "Review · Opus", "r1"), agent("2", "Review · Sonnet", "r1")],
        active: [run("r1")],
      }),
    ]),
  );

  expect(rows.map((r) => r.title)).toEqual([
    "Implement · glass",
    // The run is still named by its workflow alone.
    "Implement",
    "├ Review · Opus",
    "└ Review · Sonnet",
  ]);
});

test("an Elsewhere run keeps what it is pointed at, because its group names several", () => {
  const rows = wideRows(
    wideView([
      group("Elsewhere · one · two", {
        workspaceId: null,
        active: [run("r1"), { ...run("r2"), title: "Implement · two" }],
      }),
    ]),
  );

  // The group row names both checkouts, so the run rows are what say which is which.
  expect(rows.map((r) => r.title)).toEqual([
    "Elsewhere · one · two",
    "Implement · r1",
    "Implement · two",
  ]);
});

test("the wide board names workspaces, and never a herdr id", () => {
  const rows = wideRows(
    wideView(
      [
        group("Implement · glass", {
          workspaceId: "w28",
          agents: [agent("1", "Implementer", "r1")],
          active: [run("r1")],
        }),
      ],
      ["Env"],
    ),
  );

  // A herdr id is `w28`, `w28:t3` or `1-4`, and none of them is anything a human reads.
  for (const row of rows) {
    for (const text of [row.title, row.detail, row.ago]) {
      expect(text).not.toMatch(/\bw\d+(:[a-z]\d+)?\b|\b\d+-\d+\b/);
    }
  }
  // The id is on the row all the same: it is what a jump is resolved from.
  expect(rows[0]!.id).toBe("group:w28");
});

test("a group keeps a run's question, so it is answered where it is seen", () => {
  const asking = run("r1", { choice: MENU, needsYou: true });
  const rows = wideRows(
    wideView([
      group("Implement · glass", {
        needsYou: 1,
        active: [run("r2"), asking],
      }),
    ]),
  );

  // The waiting run first inside its group, and its question travels with the row —
  // the same rendering the local board gives it.
  expect(rows.map((r) => r.runId)).toEqual([null, "r1", "r2"]);
  expect(rows[1]!.choice).toBe(MENU);
  // How many of its runs are waiting is in the group row's own summary, and not on it
  // as `needsYou`: the footer counts those, and a workspace counted beside its own
  // waiting run made "1 run(s) need you" read as two.
  expect(rows[0]!.detail).toContain("1 running");
  expect(needsYouStatus(rows, null)).toBe("1 run(s) need you");
});

test("Enter on a row says where to go, from a key rather than a cached id", () => {
  const rows = wideRows(
    wideView([
      group("Implement · glass", {
        workspaceId: "w28",
        agents: [agent("1", "Implementer", "r1")],
        active: [run("r1")],
      }),
    ]),
  );
  const [workspace, active, agentRow] = rows;

  // A workspace, a run and an agent each point at what they are, by the one key that
  // survives a redraw: herdr compacts tab and pane ids, so nothing carries one.
  expect(workspace!.jump).toEqual({
    kind: "workspace",
    workspaceId: "w28",
    label: "Implement · glass",
  });
  // The run's own name, not the one its group row shortened it to: the footer says
  // where you went, and "went to Implement" says less than the run's whole name.
  expect(active!.jump).toEqual({ kind: "run", runId: "r1", label: "Implement · r1" });
  expect(agentRow!.jump).toEqual({ kind: "agent", agent: "implementer-1", label: "Implementer" });
  // Enter is what does it, on a run and on an agent alike, and it is the same key on
  // every row rather than one of the row's own actions. A workspace row is the one
  // exception: it is a filter, so Enter narrows the board to it instead.
  for (const row of [active, agentRow]) {
    expect(keyIntent(keys({ row }), press("\r", { name: "return" }))).toEqual({
      _tag: "Do",
      command: { _tag: "Jump", jump: row!.jump! },
    });
  }
  expect(keyIntent(keys({ row: workspace }), press("\r", { name: "return" }))).toEqual({
    _tag: "Do",
    command: { _tag: "SetFilter", filter: { kind: "workspace", id: "w28" } },
  });
});

test("nothing under Elsewhere is somewhere this session can go", () => {
  const rows = wideRows(
    wideView([
      group("Elsewhere · collie-mr-roles-wt", {
        workspaceId: null,
        active: [run("r1")],
      }),
    ]),
  );

  for (const row of rows) expect(row.jump?.kind ?? "none").toBe("none");
  // Enter still answers: a key that silently does nothing reads as a broken board, so
  // the jump is dispatched and it is the operation that says there is nowhere to go.
  expect(keyIntent(keys({ row: rows[0]! }), press("\r", { name: "return" }))).toEqual({
    _tag: "Do",
    command: { _tag: "Jump", jump: rows[0]!.jump! },
  });
});

test("Enter goes to it in the local scope too", () => {
  const rows = rowsOf(
    board({
      agents: [agent("1", "Implementer", "r1")],
      active: [run("r1")],
      recent: [run("r0", { glyph: "✓", detail: "done" })],
    }),
  );

  expect(rows.map((r) => r.jump?.kind)).toEqual(["run", "agent", "run"]);
});

test("a History row is not somewhere to jump: its run is a record, not a pane", () => {
  const rows = viewRows({
    view: "history",
    filter: { kind: "workspace", id: "w1" },
    tasks: [],
    now: 0,
    density: "comfortable",
    wide: null,
    board: board(),
    note: null,
    history: [run("r9", { glyph: "✓", detail: "done" })],
    definitions: null,
    settings: null,
    detail: null,
    marks: {},
    live: null,
    previewing: null,
    stopping: [],
  });

  expect(rows[0]!.jump).toBeNull();
});

test("the keys that start something are this Session's, not a wide board's", () => {
  // They act on this workspace's checkout rather than on the selected row, so the spec
  // keeps them on the local board — where `g local` is how you get back to one.
  const row = rowsOf(board({ active: [run("r1")] }))[0]!;

  for (const key of ["p", "u", "f", "s"]) {
    expect(keyIntent(keys({ row, filter: HERE }), press(key))).not.toBeNull();
    expect(keyIntent(keys({ row, filter: EVERYWHERE }), press(key))).toBeNull();
  }
  // What a wide row can still be asked for goes through, so gating them is not a gate
  // on everything after.
  expect(keyIntent(keys({ row, filter: EVERYWHERE }), press("l"))).toEqual({
    _tag: "Do",
    command: { _tag: "OpenLog", runId: "r1" },
  });
  expect(keyIntent(keys({ row, filter: EVERYWHERE }), press("\r", { name: "return" }))).toEqual({
    _tag: "Do",
    command: { _tag: "Jump", jump: row.jump! },
  });
});

test("starting a workflow is this Session's, so a wide row is not offered one", () => {
  // A fix round and a second review both run in *this* workspace's checkout. Offered
  // on another workspace's run they would build from its run directory against the
  // wrong repository, which is what the spec keeps Session-local.
  const target = "mr:gitlab.example.com/g/p!42";
  // SAFETY: one recent row goes in, so one row comes out.
  const [row] = rowsOf(board({ recent: [run("r0", { target, fixable: true })] })) as [Row];

  expect(actionsFor(row, HERE).map((a) => a.key)).toEqual(["l", "x", "o", "w"]);
  // The merge request is still the run's own: opening it and posting its review act on
  // the run, not on this checkout.
  expect(actionsFor(row, EVERYWHERE).map((a) => a.key)).toEqual(["l", "o", "w"]);
  // And the keys go with the buttons, so neither can be pressed from a wide board.
  expect(keyIntent(keys({ row, filter: HERE }), press("x"))).toEqual({
    _tag: "Do",
    command: { _tag: "ChooseOffer", runId: "r0" },
  });
  expect(keyIntent(keys({ row, filter: EVERYWHERE }), press("x"))).toBeNull();
});

test("a hand-off is this Session's, so it is not offered from a board of all of them", () => {
  const row = rowsOf(board({ active: [run("r1")] }))[0]!;
  const key = press("s");

  expect(keyIntent(keys({ row, filter: HERE }), key)).toEqual({
    _tag: "Do",
    command: { _tag: "SendReview", runId: "r1" },
  });
  // Nothing moves the register or a hand-off across workspaces, so `s` on a wide board
  // would act on this Session with another workspace's review.
  expect(keyIntent(keys({ row, filter: EVERYWHERE }), key)).toBeNull();
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
      agents: [
        { key: "3", name: "Reviewer", agent: "rev-1", status: "idle", run: "r1", now: null },
      ],
      active: [run("r1")],
      recent: [run("r0")],
    }),
  );
  expect(rows).toHaveLength(3);
  // SAFETY: one active run with one agent under it and one recent run went in, and the
  // length is asserted above, so the three rows are there in that order.
  const [active, working, recent] = rows as [Row, Row, Row];

  expect(actionsFor(working, HERE).map((a) => [a.key, a.command])).toEqual([
    ["3", { _tag: "FocusAgent", agent: "rev-1" }],
  ]);
  expect(actionsFor(active, HERE).map((a) => [a.key, a.command])).toEqual([
    ["l", { _tag: "OpenLog", runId: "r1" }],
    ["k", { _tag: "StopRun", runId: "r1" }],
  ]);
  // A finished run has nothing to stop; what it offers next is its module's to say.
  expect(actionsFor(recent, HERE).map((a) => a.key)).toEqual(["l", "x"]);
});

test("a clean review can still be opened in a browser", () => {
  const target = "mr:gitlab.example.com/g/p!42";
  // SAFETY: one recent row goes into each board, so each list has exactly that row.
  const [clean] = rowsOf(board({ recent: [run("r0", { target, fixable: false })] })) as [Row];
  // SAFETY: as above — one row in, one row out.
  const [withFindings] = rowsOf(board({ recent: [run("r1", { target, fixable: true })] })) as [Row];

  // Nothing to fix and nothing to post, but the merge request is still there to look at:
  // opening it has nothing to do with whether the review found anything.
  expect(actionsFor(clean, HERE).map((a) => a.key)).toEqual(["l", "x", "w"]);
  expect(actionsFor(withFindings, HERE).map((a) => a.key)).toEqual(["l", "x", "o", "w"]);
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

test("a filtered wide board keeps the workspace a matching run is in", () => {
  const rows = wideRows(
    wideView([
      group("Implement · glass", {
        agents: [agent("1", "Implementer", "r1")],
        active: [run("r1")],
      }),
      group("Collie", { active: [run("r2")] }),
    ]),
  );

  // A run in the wide board is named by its workflow alone, so the row that says which
  // workspace it is in is the one thing a filtered list cannot drop.
  const byAgent = matching(rows, "Implementer");
  expect(byAgent.map((r) => [r.kind, r.title])).toEqual([
    ["group", "Implement · glass"],
    ["active", "Implement"],
    ["agent", "└ Implementer"],
  ]);
  // And a workspace that matched brings what is in it along: narrowing to a workspace
  // means its runs, not one row saying its name.
  expect(matching(rows, "Collie").map((r) => r.kind)).toEqual(["group", "active"]);
  expect(matching(rows, "glass").map((r) => r.kind)).toEqual(["group", "active", "agent"]);
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

  expect(retarget(at, { _tag: "Select", id: "run:r1", on: null }).selected).toBe("run:r1");
  expect(retarget(at, { _tag: "ToggleTail" }).tail).toBe(true);
  expect(retarget({ ...at, tail: true }, { _tag: "ToggleTail" }).tail).toBe(false);
  expect(retarget(at, { _tag: "Refresh" }).nonce).toBe(1);
  // Another page of a capped review, and a new Selection starts from the first page
  // again rather than inheriting how far the last one had been paged.
  expect(retarget(at, { _tag: "MoreReview" }).reviewPages).toBe(2);
  expect(
    retarget({ ...at, reviewPages: 4 }, { _tag: "Select", id: "run:r2", on: null }).reviewPages,
  ).toBe(1);

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

test("an agent's row says what it is doing, and its run only where that is all it has", () => {
  // Nested under its run, so which run it belongs to is the row above it: the detail is
  // what the agent is actually on, from the terminal title its harness publishes.
  const rows = rowsOf(
    board({
      agents: [agent("1", "Implementer", "r1", "Simplify cego.collie plugin")],
      active: [run("r1")],
    }),
  );
  expect(rows.map((r) => r.detail)).toEqual(["build", "working · Simplify cego.collie plugin"]);

  // A harness that publishes no title leaves the status alone.
  const quiet = rowsOf(board({ agents: [agent("1", "Reviewer", "r1")], active: [run("r1")] }));
  expect(quiet[1]!.detail).toBe("working");

  // An orphan has no run above it, so its own row says which one it names — and still
  // says what it is doing.
  const orphans = rowsOf(board({ agents: [agent("1", "Planner", "r9", "Write the spec")] }));
  expect(orphans[1]!.detail).toBe("working · Write the spec · r9");
});

test("a run that needs you is listed first, under a header saying so", () => {
  const rows = rowsOf(
    board({
      agents: [agent("1", "Implementer", "r2")],
      active: [run("r1"), run("r2", { needsYou: true, choice: MENU }), run("r3")],
    }),
  );

  // The waiting run first, its own agents still nested under it.
  expect(rows.map((r) => [r.kind, r.id])).toEqual([
    ["header", "header:Needs you"],
    ["active", "run:r2"],
    ["agent", "agent:implementer-1"],
    ["active", "run:r1"],
    ["active", "run:r3"],
  ]);
  expect(rows[0]!.title).toBe("Needs you");
  // No header where nothing is waiting: an empty section is noise on every refresh.
  expect(rowsOf(board({ active: [run("r1")] })).map((r) => r.kind)).toEqual(["active"]);
});

test("nothing acts on a header row", () => {
  const rows = rowsOf(board({ active: [run("r1"), run("r2", { needsYou: true })] }));

  // It is a name for the group under it: selectable like every row, and inert, so no
  // key and no button is ever offered for one.
  expect(rows[0]!.kind).toBe("header");
  expect(actionsFor(rows[0]!, HERE)).toEqual([]);
});

test("the footer counts the runs waiting on you, and only while the Selection is elsewhere", () => {
  const waiting = [run("r1", { needsYou: true }), run("r2", { needsYou: true }), run("r3")];

  expect(needsYouStatus(rowsOf(board({ active: waiting })), "run:r3")).toBe("2 run(s) need you");
  // Standing on one of them: the question itself is on screen, so the count would
  // be telling the human about the row they are already answering.
  expect(needsYouStatus(rowsOf(board({ active: waiting })), "run:r1")).toBeNull();
  expect(needsYouStatus(rowsOf(board({ active: [run("r1")] })), "run:r1")).toBeNull();
});

test("how long something took reads in the coarsest unit that still says it", () => {
  expect(took(45_000)).toBe("45s");
  expect(took(12 * 60_000)).toBe("12m");
  // An hour is two units, because "63m" is a number to divide in your head.
  expect(took(63 * 60_000)).toBe("1h03m");
  expect(took(24 * 3_600_000)).toBe("24h00m");
  // Under a second, and a clock that went backwards: neither is a duration to show.
  expect(took(400)).toBe("0s");
  expect(took(-5_000)).toBe("0s");
});

test("the footer offers the panel's keys and the globals, and no more", () => {
  const globals = "g all · p run · ? keys · q close";
  expect(footerKeys({ panel: [], on: { _tag: "Board" }, filter: HERE })).toBe(globals);
  expect(footerKeys({ panel: ["t log tail"], on: { _tag: "Board" }, filter: HERE })).toBe(
    `t log tail · ${globals}`,
  );
  // `g` names where it goes, not where it is: the nav is what says which scope this is.
  // And starting a run is this Session's, so a board of every workspace does not offer
  // it — the key is gated the same way.
  expect(footerKeys({ panel: [], on: { _tag: "Board" }, filter: EVERYWHERE })).toBe(
    "g local · ? keys · q close",
  );
});

test("a field that has taken the keys says what they do instead", () => {
  // Every other key is inert while one of these has the keyboard, so offering the
  // board's would be a lie — `k` typed a `k` while `[k stop]` stopped the run.
  expect(footerKeys({ panel: [], on: { _tag: "Choice", choice: MENU }, filter: HERE })).toBe(
    "↑↓ move · Enter choose · Esc leave the run open",
  );
  expect(
    footerKeys({
      panel: [],
      on: { _tag: "Setting", setting: { key: "model", value: "opus" } },
      filter: HERE,
    }),
  ).toBe("type a value · Enter set it · Esc leave it");
  expect(footerKeys({ panel: [], on: { _tag: "Filter" }, filter: HERE })).toBe(
    "type to narrow · Enter keep it · Esc drop it",
  );
});

test("the help overlay lists every key the board handles, each with what it does", () => {
  const keys = ALL_KEYS.map((k) => k.key);
  for (const key of ["Tab", "/", "Esc", "m", "r", "?", "q"]) expect(keys).toContain(key);
  expect(ALL_KEYS.every((k) => k.what !== "")).toBe(true);
});

test("markdown lines carry the one thing that makes a long review skimmable", () => {
  const lines = markdownLines(
    [
      "# Review",
      "",
      "Summary of it.",
      "- [strong] a real one",
      "  * nested",
      "```ts",
      "# not a heading",
      "```",
      "after",
    ].join("\n"),
  );

  expect(lines.map((l) => l.style)).toEqual([
    "heading",
    "plain",
    "plain",
    "list",
    "list",
    "code",
    "code",
    "code",
    "plain",
  ]);
  // The text is untouched: this decides how a line is drawn, never what it says.
  expect(lines.map((l) => l.text)).toEqual([
    "# Review",
    "",
    "Summary of it.",
    "- [strong] a real one",
    "  * nested",
    "```ts",
    "# not a heading",
    "```",
    "after",
  ]);

  // Every heading level, and a fence left open to the end of the file.
  expect(markdownLines("### Findings").map((l) => l.style)).toEqual(["heading"]);
  expect(markdownLines("```\nstill code").map((l) => l.style)).toEqual(["code", "code"]);
  // A hash with no space is a comment in whatever the agent pasted, not a heading.
  expect(markdownLines("#!/bin/sh").map((l) => l.style)).toEqual(["plain"]);
});

/** The two boards the Session-local keys distinguish: this workspace's, and the Herd's. */
const HERE: Filter = { kind: "workspace", id: "w1" };
const EVERYWHERE: Filter = { kind: "all" };

/** The board as the keyboard sees it, with only what a test cares about set. */
function keys(over: Partial<KeyContext> = {}): KeyContext {
  return {
    on: { _tag: "Board" },
    view: "runs",
    filter: HERE,
    helping: false,
    asking: { index: 0, typed: "" },
    query: "",
    scrollable: false,
    row: null,
    rows: [],
    cutShort: false,
    mrUrl: null,
    ...over,
  };
}

/** The whole of what the app draws, with everything a test does not care about empty. */
function state(): AppState {
  return {
    view: "runs",
    filter: { kind: "all" },
    tasks: [],
    now: 0,
    density: "comfortable",
    wide: null,
    board: board(),
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
}

/** A bare Row, for the keys that only need one to exist. */
const ROW: Row = rowsOf(board({ active: [run("r1")] }))[0]!;

/** One keypress, as OpenTUI reports one. */
function press(sequence: string, over: Omit<Keypress, "sequence"> = {}) {
  return { sequence, ...over };
}

test("the help overlay owns the keyboard, then a flow, then the board", () => {
  // A flow running inline has its own handler; a key that also moved the Selection
  // underneath would act on a board nobody is looking at.
  expect(keyIntent(keys({ on: { _tag: "Flow" } }), press("q", { name: "q" }))).toBeNull();
  // `?` during a flow is the flow's, not the board's.
  expect(keyIntent(keys({ on: { _tag: "Flow" } }), press("?"))).toBeNull();

  // Any key closes the overlay and does nothing else — including a key the board would
  // otherwise have acted on.
  expect(keyIntent(keys({ helping: true }), press("k", { name: "k" }))).toEqual({
    _tag: "Help",
    open: false,
  });
  expect(keyIntent(keys(), press("?"))).toEqual({ _tag: "Help", open: true });

  // The overlay beats a flow, because that is the order App draws them in: it hides the
  // Flow behind the overlay, so a flow that became pending while help was open used to
  // take the keyboard for a component nobody could see — and every key returned nothing,
  // leaving a visible overlay that could not be closed.
  expect(
    keyIntent(keys({ on: { _tag: "Flow" }, helping: true }), press("k", { name: "k" })),
  ).toEqual({
    _tag: "Help",
    open: false,
  });
});

test("a literal question mark reaches the text it was typed into", () => {
  // `?` opens the overlay only where the board owns the keyboard. Every printable
  // character belongs to whatever is taking text: a free-text answer to a run's own
  // question, the filter, and a Settings value are all things a `?` belongs in.
  const asked: PendingChoice = { ...MENU, kind: "ask", items: [] };
  expect(
    keyIntent(
      keys({ on: { _tag: "Choice", choice: asked }, asking: { index: 0, typed: "why" } }),
      press("?"),
    ),
  ).toEqual({ _tag: "Answered", asking: { index: 0, typed: "why?" }, value: null });
  expect(keyIntent(keys({ on: { _tag: "Filter" }, query: "why" }), press("?"))).toEqual({
    _tag: "Filtering",
    filter: "why?",
    typing: true,
  });
  expect(
    keyIntent(
      keys({ on: { _tag: "Setting", setting: { key: "model", value: "why" } } }),
      press("?"),
    ),
  ).toEqual({
    _tag: "Editing",
    editing: { key: "model", value: "why?" },
  });
});

test("the filter keeps the keyboard until Enter or Esc, and Enter keeps the text", () => {
  const typing = keys({ on: { _tag: "Filter" }, query: "revi" });

  expect(keyIntent(typing, press("e"))).toEqual({
    _tag: "Filtering",
    filter: "revie",
    typing: true,
  });
  // Enter stops typing and keeps the text: `/` narrows the list so a row can then be
  // acted on, which is only possible once the keys mean the board again.
  expect(keyIntent(typing, press("\r", { name: "return" }))).toEqual({
    _tag: "Filtering",
    filter: "revi",
    typing: false,
  });
  // Only Esc drops it.
  expect(keyIntent(typing, press("\x1b", { name: "escape" }))).toEqual({
    _tag: "Filtering",
    filter: "",
    typing: false,
  });
  // And a key the board owns is text while the filter has the keyboard.
  expect(keyIntent(typing, press("R"))).toEqual({
    _tag: "Filtering",
    filter: "reviR",
    typing: true,
  });
});

test("Esc on the board drops a filter it is still narrowed by, and nothing else", () => {
  const narrowed = keys({ query: "gitlab" });
  const esc = press("\x1b", { name: "escape" });

  expect(keyIntent(narrowed, esc)).toEqual({ _tag: "Filtering", filter: "", typing: false });
  // With nothing set it is not the filter's key at all, so the board does what it did
  // before: nothing.
  // With none set it widens the board instead: narrowing to one workspace is a filter
  // too, and the way out of both has to be the same key.
  expect(keyIntent(keys({ query: "" }), esc)).toEqual({
    _tag: "Do",
    command: { _tag: "SetFilter", filter: { kind: "all" } },
  });
});

test("a Settings row being edited owns the keyboard until it is sent or abandoned", () => {
  const editing = keys({ on: { _tag: "Setting", setting: { key: "model", value: "opu" } } });

  expect(keyIntent(editing, press("s"))).toEqual({
    _tag: "Editing",
    editing: { key: "model", value: "opus" },
  });
  // Enter both sends the value and closes the editor: one key, two effects, the way
  // `Answered` carries the new asking state and the answer together. Returning a bare
  // command left the footer in editor mode with every later key still editing.
  expect(keyIntent(editing, press("\r", { name: "return" }))).toEqual({
    _tag: "Submitted",
    command: { _tag: "SetDefault", key: "model", value: "opu" },
  });
  expect(keyIntent(editing, press("\x1b", { name: "escape" }))).toEqual({
    _tag: "Editing",
    editing: null,
  });
});

test("the panel's scroll keys do not fight the list's arrows", () => {
  const scrollable = keys({ scrollable: true });

  expect(keyIntent(scrollable, press("\x1b[6~", { name: "pagedown" }))).toEqual({
    _tag: "Scroll",
    by: 1,
    unit: "page",
  });
  expect(keyIntent(scrollable, press("\x1b[B", { name: "down", shift: true }))).toEqual({
    _tag: "Scroll",
    by: 1,
    unit: "line",
  });
  // A bare arrow is still the Selection's, panel or no panel.
  expect(keyIntent(scrollable, press("\x1b[B", { name: "down" }))).toEqual({ _tag: "Move", by: 1 });
  // And with no panel on screen the scroll keys do nothing rather than moving the row.
  expect(keyIntent(keys(), press("\x1b[6~", { name: "pagedown" }))).toBeNull();
});

test("a key with nothing to act on does nothing, rather than acting on something else", () => {
  // `t` needs a Run, `m` needs something cut short, `c` needs a merge request.
  expect(keyIntent(keys(), press("t"))).toBeNull();
  expect(keyIntent(keys(), press("m"))).toBeNull();
  expect(keyIntent(keys(), press("c"))).toBeNull();

  // SAFETY: one active run went in, so one row comes out.
  const [row] = rowsOf(board({ active: [run("r1")] })) as [Row];
  expect(keyIntent(keys({ row }), press("t"))).toEqual({
    _tag: "Do",
    command: { _tag: "ToggleTail" },
  });
  expect(keyIntent(keys({ cutShort: true }), press("m"))).toEqual({
    _tag: "Do",
    command: { _tag: "MoreReview" },
  });
  expect(keyIntent(keys({ mrUrl: "https://host/g/p/-/merge_requests/42" }), press("c"))).toEqual({
    _tag: "Copy",
    text: "https://host/g/p/-/merge_requests/42",
  });
});

test("a digit focuses that agent wherever the Selection is", () => {
  const rows = rowsOf(
    board({
      agents: [
        { key: "1", name: "Implementer", agent: "impl-1", status: "working", run: "r1", now: null },
      ],
      recent: [run("r0")],
    }),
  );
  // The Selection is the finished run, and the digit still reaches the agent: those
  // keys are the board's shortcut into a pane, not an action on a row.
  expect(keyIntent(keys({ rows, row: rows[1]! }), press("1"))).toEqual({
    _tag: "Do",
    command: { _tag: "FocusAgent", agent: "impl-1" },
  });
  // A digit no agent answers to does nothing.
  expect(keyIntent(keys({ rows, row: rows[1]! }), press("4"))).toBeNull();
});

test("the row's own actions are the last thing a key is tried against", () => {
  // SAFETY: one active run went in, so one row comes out.
  const [row] = rowsOf(board({ active: [run("r1")] })) as [Row];

  expect(keyIntent(keys({ row }), press("k", { name: "k" }))).toEqual({
    _tag: "Do",
    command: { _tag: "StopRun", runId: "r1" },
  });
  // `s` hands off the Selection's review, and names it: an argument-less send meant the
  // newest run in the Session.
  expect(keyIntent(keys({ row }), press("s"))).toEqual({
    _tag: "Do",
    command: { _tag: "SendReview", runId: "r1" },
  });
  expect(keyIntent(keys(), press("s"))).toEqual({
    _tag: "Do",
    command: { _tag: "SendReview", runId: null },
  });
});

test("a Task pointed at a merge request can open it, however it got there", () => {
  // A `review` Run is given one and opens none; an `implement` Run opens one. Both are
  // a merge request the human can ask for from the card.
  const given = menuFor(task({ mr: "mr:gitlab.cego.dk/mk/collie!151" }));
  expect(given.map((one) => one.label)).toContain("Open merge request");
  expect(given.find((one) => one.label === "Open merge request")?.command).toMatchObject({
    _tag: "OpenMr",
    target: "mr:gitlab.cego.dk/mk/collie!151",
  });
});

test("every key a card's menu offers is one the overlay advertises", () => {
  // Two lists that have to agree: the menu is built per Task state, and a key offered
  // on a card and missing from `?` is a key nobody can look up.
  const advertised = new Set(ALL_KEYS.map((entry) => entry.key));
  const states = ["blocked", "active", "quiet", "failed", "stopped", "done"] as const;
  const offered = new Set(
    states.flatMap((state) =>
      menuFor(task({ state, mr: "https://host/g/p/-/merge_requests/42" })).map((item) => item.key),
    ),
  );
  expect(offered.size).toBeGreaterThan(4);
  expect([...offered].filter((key) => !advertised.has(key))).toEqual([]);
});

test("a filter keeps a matching agent under a finished run too", () => {
  // A finished run keeps its agents, so it opens a group exactly as an active one does:
  // filtering by the agent alone left it hanging under nothing.
  const rows = rowsOf(
    board({
      agents: [agent("1", "Reviewer", "r1")],
      active: [],
      recent: [run("r1")],
    }),
  );

  expect(matching(rows, "Reviewer").map((r) => [r.kind, r.title])).toEqual([
    ["recent", "Implement · r1"],
    ["agent", "└ Reviewer"],
  ]);
});

test('the "Needs you" header survives a filter its runs match', () => {
  // The group under this header is runs, not agents, so a scan that stopped at the
  // first non-agent row could never judge it a match.
  const rows = rowsOf(
    board({
      agents: [],
      active: [run("r1", { needsYou: true }), run("r2")],
      recent: [],
    }),
  );

  expect(matching(rows, "r1").map((r) => [r.kind, r.title])).toEqual([
    ["header", "Needs you"],
    ["active", "Implement · r1"],
  ]);
  // A run outside the group does not bring the header with it.
  expect(matching(rows, "r2").map((r) => [r.kind, r.title])).toEqual([
    ["active", "Implement · r2"],
  ]);
});

test("the next unanswered question is the one after the Selection, wrapping once", () => {
  const rows = rowsOf(
    board({
      active: [
        run("r1", { choice: { ...MENU, id: "c1", run: "r1" }, needsYou: true }),
        run("r2"),
        run("r3", { choice: { ...MENU, id: "c3", run: "r3" }, needsYou: true }),
      ],
    }),
  );
  const ids = selectableRows(rows).map((r) => r.id);
  const [first, middle, last] = [ids[0]!, ids[1]!, ids[2]!];

  // Runs that need you sort to the top, so the two asking rows bracket the third.
  expect(nextQuestionId(rows, first)).toBe(middle === last ? last : ids[1]!);
  // From the last question it wraps back to the first rather than stopping.
  expect(nextQuestionId(rows, last)).toBe(first);
  // With nothing selected, or a Selection that is not on this board, it starts at the
  // top rather than skipping the first question.
  expect(nextQuestionId(rows, null)).toBe(first);
  expect(nextQuestionId(rows, "run:gone")).toBe(first);
});

test("with no question anywhere there is nowhere to go, and the Selection stays", () => {
  const rows = rowsOf(board({ active: [run("r1"), run("r2")] }));

  expect(nextQuestionId(rows, selectableRows(rows)[0]!.id)).toBe(null);
  expect(nextQuestionId([], null)).toBe(null);
});

test("the next-question key is the board's, unless a field is taking text", () => {
  const asking = keys({ row: null });

  expect(keyIntent(asking, press("n", { name: "n" }))).toEqual({ _tag: "NextQuestion" });
  // A menu is not a text field: `n` is not one of its options, so it still navigates.
  expect(
    keyIntent(keys({ on: { _tag: "Choice", choice: MENU } }), press("n", { name: "n" })),
  ).toEqual({ _tag: "NextQuestion" });

  // Everything that takes text keeps the character. A free-text question, the filter
  // and a Settings value each own `n` while the cursor is in them.
  expect(
    keyIntent(
      keys({ on: { _tag: "Choice", choice: { ...MENU, kind: "ask", items: [] } } }),
      press("n", { name: "n" }),
    ),
  ).toEqual({ _tag: "Answered", asking: { index: 0, typed: "n" }, value: null });
  expect(keyIntent(keys({ on: { _tag: "Filter" } }), press("n", { name: "n" }))).toEqual({
    _tag: "Filtering",
    filter: "n",
    typing: true,
  });
  expect(
    keyIntent(
      keys({ on: { _tag: "Setting", setting: { key: "model", value: "opu" } } }),
      press("n", { name: "n" }),
    ),
  ).toEqual({ _tag: "Editing", editing: { key: "model", value: "opun" } });
});

// --- The Home board's filter ---------------------------------------------------------

test("the filter says which board this is, and the Session-local keys read it", () => {
  // Narrowed either way is one Session's: a Run belongs to the workspace it was started
  // in, so a board filtered to one is as local as a board filtered to that workspace.
  expect(sessionLocal({ kind: "all" })).toBe(false);
  expect(sessionLocal({ kind: "workspace", id: "w1" })).toBe(true);
  expect(sessionLocal({ kind: "run", id: "r1" })).toBe(true);
});

test("g toggles between the whole Herd and the workspace the board was opened from", () => {
  const home = focus({ filter: { kind: "all" }, origin: "w1" });
  expect(retarget(home, { _tag: "ToggleFilter" }).filter).toEqual({
    kind: "workspace",
    id: "w1",
  });
  const narrowed = focus({ filter: { kind: "workspace", id: "w1" }, origin: "w1" });
  expect(retarget(narrowed, { _tag: "ToggleFilter" }).filter).toEqual({ kind: "all" });
  // A run filter widens rather than toggling into a workspace nobody named.
  const onRun = focus({ filter: { kind: "run", id: "r1" }, origin: "w1" });
  expect(retarget(onRun, { _tag: "ToggleFilter" }).filter).toEqual({ kind: "all" });
  // Nothing to narrow to: a board with no origin stays where it is rather than
  // narrowing to a workspace it would have to invent.
  const nowhere = focus({ filter: { kind: "all" }, origin: null });
  expect(retarget(nowhere, { _tag: "ToggleFilter" }).filter).toEqual({ kind: "all" });
});

test("a new filter starts the Selection again", () => {
  const at = focus({ filter: { kind: "all" }, selected: "run:r1" });
  const set = retarget(at, { _tag: "SetFilter", filter: { kind: "workspace", id: "w2" } });
  expect(set.filter).toEqual({ kind: "workspace", id: "w2" });
  expect(set.selected).toBeNull();
});

test("the proposal being previewed costs no read", () => {
  const at = focus({ selected: "run:r1" });
  expect(rereads(at, { ...at, previewing: "p1" }).reuse).toBe(true);
  // The filter is a different board, so it is read again.
  expect(rereads(at, { ...at, filter: { kind: "all" } }).reuse).toBe(false);
});

test("a row says what steering has found about its Run, worst mark first", () => {
  const marks = {
    r1: { ...NO_MARKS, drift: true, tryIt: true },
    r2: { ...NO_MARKS, held: true },
    r3: { ...NO_MARKS, override: true, proposal: true },
  };
  const rows = rowsOf(
    board({ active: [run("r1"), run("r2"), run("r3")], agents: [agent("1", "Fix", "r3")] }),
    marks,
  );
  const marked = (id: string) => rows.find((r) => r.id === id)!.marks;
  expect(marked("run:r1")).toBe("↯ ▶");
  expect(marked("run:r2")).toBe("⏸");
  expect(marked("run:r3")).toBe("⚠ manual !");
  // The override is a fact about the agents a human typed at, so their rows carry it.
  expect(marked("agent:fix-1")).toBe("⚠ manual");
  // A Run nothing has found anything about is unmarked.
  expect(rowsOf(board({ active: [run("r4")] }))[0]!.marks).toBe("");
});

test("a workspace row inherits the worst mark of the runs under it", () => {
  const wide: WideView = {
    groups: [
      {
        workspaceId: "w1",
        label: "collie",
        glyph: "⚙",
        running: 2,
        needsYou: 0,
        summary: "2 running",
        active: [run("r1"), run("r2")],
        recent: [],
        agents: [],
      },
    ],
    quiet: [],
    now: NOW,
  };
  const rows = wideRows(wide, {
    r1: { ...NO_MARKS, proposal: true },
    r2: { ...NO_MARKS, drift: true },
  });
  expect(rows.find((r) => r.id === "group:w1")!.marks).toBe("↯");
});

test("`:` is no longer a mode: the board keeps its keys", () => {
  // The composer is gone; talking to Collie is the native pane beside the board.
  expect(
    keyIntent(keys({ row: { ...ROW, kind: "active" as const, runId: "r1" } }), press(":")),
  ).toBeNull();
});

test("a proposal on screen takes Enter and Esc, and nothing else", () => {
  const previewing = keys({
    row: { ...ROW, kind: "active" as const, runId: "r1" },
    on: { _tag: "Proposal", proposal: { id: "p1", hash: "deadbeef" } },
  });
  expect(keyIntent(previewing, press("\r", { name: "return" }))).toEqual({
    _tag: "Do",
    command: { _tag: "ConfirmProposal", id: "p1", hash: "deadbeef" },
  });
  expect(keyIntent(previewing, press("\x1b", { name: "escape" }))).toEqual({
    _tag: "Do",
    command: { _tag: "DeclineProposal", id: "p1" },
  });
  expect(keyIntent(previewing, press("k"))).toBeNull();
});

test("Esc drops the filter text first, and widens the board once there is none", () => {
  const narrowed = keys({
    row: null,
    filter: HERE,
    query: "picker",
  });
  expect(keyIntent(narrowed, press("\x1b", { name: "escape" }))).toEqual({
    _tag: "Filtering",
    filter: "",
    typing: false,
  });
  expect(keyIntent(keys({ row: null, filter: HERE }), press("\x1b", { name: "escape" }))).toEqual({
    _tag: "Do",
    command: { _tag: "SetFilter", filter: { kind: "all" } },
  });
});

test("Enter on a workspace nobody can reach still answers", () => {
  const [away] = wideRows(
    wideView([group("Elsewhere", { workspaceId: null, active: [run("r1")] })]),
  );
  expect(
    keyIntent(keys({ row: away, filter: EVERYWHERE }), press("\r", { name: "return" })),
  ).toEqual({
    _tag: "Do",
    command: { _tag: "Jump", jump: away!.jump! },
  });
});

test("a run filter keeps that run's agents and its repository runs", () => {
  const rows = runsRows({
    ...state(),
    filter: { kind: "run", id: "r1" },
    board: board({
      active: [run("r1"), run("r2")],
      agents: [agent("1", "Implementer", "r1"), agent("2", "Reviewer", "r2")],
    }),
  });

  // The run, and what hangs off it. On the local board an agent sits at its run's own
  // depth — the connector is what joins them — so depth alone cannot say where the
  // group ends.
  expect(rows.map((r) => r.id)).toEqual(["run:r1", "agent:implementer-1"]);
});

test("a card's menu offers only what that Task can be asked for", () => {
  const working = menuFor(task());
  expect(working.map((item) => [item.key, item.label])).toEqual([
    ["enter", "Open record"],
    ["g", "Go to its tab"],
    ["s", "Steer…"],
    ["o", "What it offers…"],
    ["k", "Stop run"],
  ]);
  expect(working[0]!.command).toEqual({ _tag: "OpenRecord", id: "t1" });
  expect(working[1]!.command).toEqual({
    _tag: "Jump",
    jump: { kind: "run", runId: "r1", label: "Strapi prod seeder" },
  });
  expect(working[3]!.command).toEqual({ _tag: "ChooseOffer", runId: "r1" });
  expect(working[4]!.command).toEqual({ _tag: "StopRun", runId: "r1" });

  // A run nobody is driving cannot be stopped or steered; it can be taken up again.
  expect(menuFor(task({ state: "failed" })).map((item) => item.label)).toEqual([
    "Open record",
    "Go to its tab",
    "What it offers…",
    "Resume run",
  ]);
  expect(menuFor(task({ state: "stopped" })).map((item) => item.label)).toContain("Resume run");
  // Only a run that finished has work to build on.
  expect(menuFor(task({ state: "done" })).map((item) => item.label)).toEqual([
    "Open record",
    "Go to its tab",
    "What it offers…",
    "Follow-up run",
  ]);
});

test("a ready plan's first action is the offer its module declares, under its own title", () => {
  const offer = { id: "build-it", title: "Build these tickets" };
  const ready = task({ state: "done", landed: false, planReady: true, offer });
  expect(primaryFor(ready)).toEqual({
    key: "i",
    label: "Build these tickets",
    command: { _tag: "InvokeOffer", runId: "r1", offer: "build-it" },
  });
  expect(menuFor(ready).map((item) => item.label)).toContain("Build these tickets");
  // A plan whose module offers nothing gets no button for something nobody declared.
  const undeclared = task({ state: "done", landed: false, planReady: true, offer: null });
  expect(primaryFor(undeclared)).toBeNull();
  expect(menuFor(undeclared).map((item) => item.label)).not.toContain("Implement now");
});

test("the merge request is offered when there is one to open, named the way glab takes it", () => {
  const withMr = task({ mr: "https://gitlab.cego.dk/mk/collie/-/merge_requests/151" });
  const item = menuFor(withMr).find((one) => one.label === "Open merge request");
  expect(item?.key).toBe("w");
  expect(item?.command).toEqual({
    _tag: "OpenMr",
    target: "mr:gitlab.cego.dk/mk/collie!151",
    runId: "r1",
  });
  // A URL nothing can resolve is not offered: a menu item that would fail is worse than
  // none at all.
  expect(menuFor(task({ mr: "see the ticket" })).map((one) => one.label)).not.toContain(
    "Open merge request",
  );
});

test("what became of the work is offered once the work is over, with its MR as the reference", () => {
  expect(dispositionsFor(task())).toEqual([]);
  const done = task({ state: "done", mr: "https://gitlab.cego.dk/mk/collie/-/merge_requests/151" });
  expect(dispositionsFor(done)).toEqual([
    {
      key: "M",
      label: "Mark merged",
      command: { _tag: "RecordDisposition", runId: "r1", kind: "merged", ref: "collie!151" },
    },
    {
      key: "A",
      label: "Mark abandoned",
      command: { _tag: "RecordDisposition", runId: "r1", kind: "abandoned", ref: "" },
    },
  ]);
  // Stopped and failed work can also have been landed by hand.
  expect(dispositionsFor(task({ state: "failed" }))[0]!.command).toEqual({
    _tag: "RecordDisposition",
    runId: "r1",
    kind: "merged",
    ref: "",
  });
});

test("older… offers the finished runs of this checkout the board is not already showing", () => {
  const history = [run("r1"), run("r2"), run("r3"), run("r4")];
  const onBoard = [task({ id: "t1", state: "done", run: "r1", runs: ["r1", "r2"] })];

  // Nothing read yet: the link is there, because asking for it is what reads it.
  expect(olderFinished(null, onBoard, 1)).toEqual({ rows: [], more: true });

  // A run already on the board as a card is not repeated under it.
  const first = olderFinished(history, onBoard, 1, 1);
  expect(first.rows.map((row) => row.id)).toEqual(["r3"]);
  expect(first.more).toBe(true);

  const second = olderFinished(history, onBoard, 2, 1);
  expect(second.rows.map((row) => row.id)).toEqual(["r3", "r4"]);
  expect(second.more).toBe(false);

  // Before anyone asks, none of it is drawn.
  expect(olderFinished(history, onBoard, 0)).toEqual({ rows: [], more: true });
});
