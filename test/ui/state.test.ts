import * as Str from "effect/String";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { pipe } from "effect/Function";
import { expect, test } from "bun:test";
import {
  actionsFor,
  dispositionsFor,
  menuFor,
  mrChoices,
  primaryFor,
  olderFinished,
  ALL_KEYS,
  footerKeys,
  keyIntent,
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
  retarget,
  rowsOf,
  NEEDS_YOU,
  selectableRows,
  viewRows,
  wideRows,
} from "../../src/ui/state";
import type { Filter, KeyContext, MenuItem, Keypress, Row } from "../../src/ui/state";
import { NO_MARKS } from "../../src/lines";
import { DateTime } from "effect";
import { ago, agoShort, took, epochMs } from "../../src/time";
import type { PendingChoice } from "../../src/board";
import type { WideGroup, WideView, WorkspaceView } from "../../src/workspace";
import { NO_OUTCOME } from "../../src/workspace";
import { focus } from "../support/focus";
import { task, taskMr } from "../support/task";

const NOW = epochMs("2026-09-02T12:00:00.000Z");
const FIXED_ISO = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

function board(over: Partial<WorkspaceView> = {}) {
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
  return { key, name, agent: `${Str.toLowerCase(name)}-1`, status: "working", run, now };
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

  expect(Arr.map(rows, (r) => [r.kind, r.id])).toEqual([
    ["active", "run:r1"],
    ["agent", "agent:impl-1"],
    ["recent", "run:r0"],
  ]);
  // WARNING: ids carry no position; the list re-sorts each refresh and an index would silently retarget the action.
  expect(Arr.map(rows, (r) => r.id)).not.toContain("0");
});

test("an agent is listed under the run it works for", () => {
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

  expect(Arr.map(rows, (r) => [r.kind, r.title])).toEqual([
    ["active", "Implement · r1"],
    ["agent", "├ Implementer"],
    ["agent", "└ Reviewer"],
    ["active", "Implement · r2"],
    ["agent", "└ Planner"],
    ["recent", "Implement · r0"],
  ]);
  expect(rows[1]!.detail).toBe("working");
  expect(rows[1]!.agent).toBe("implementer-1");
  expect(rows[1]!.key).toBe("1");
  expect(Arr.map(actionsFor(rows[1]!, HERE), (a) => a.key)).toEqual(["1"]);
});

test("a run's children are listed under it, and its agents under those", () => {
  const rows = rowsOf(
    board({
      agents: [agent("1", "Implementer", "child-api")],
      active: [
        run("plan-1", { detail: "wave 1/2 · waiting on cego/api", children: ["child-api"] }),
        run("child-api"),
      ],
    }),
  );

  expect(Arr.map(rows, (r) => [r.kind, r.title, r.depth])).toEqual([
    ["active", "Implement · plan-1", 0],
    ["active", "Implement · child-api", 1],
    ["agent", "└ Implementer", 1],
  ]);
  expect(rows[1]!.jump).toMatchObject({ kind: "run", runId: "child-api" });
});

test("an ordinary chain's child is a row of its own, not nested under a finished parent", () => {
  const rows = rowsOf(
    board({
      active: [run("implement-1")],
      recent: [run("plan-1", { glyph: "✓", detail: "done" })],
    }),
  );

  expect(Arr.map(rows, (r) => [r.kind, r.title, r.depth])).toEqual([
    ["active", "Implement · implement-1", 0],
    ["recent", "Implement · plan-1", 0],
  ]);
});

test("a run that needs you is under the header, and the header only when one is", () => {
  const nestedOnly = rowsOf(
    board({
      active: [
        run("plan-1", { children: ["child-api"] }),
        run("child-api", { needsYou: true, choice: MENU }),
      ],
    }),
  );

  expect(Arr.map(nestedOnly, (r) => r.kind)).toEqual(["active", "active"]);
  expect(Arr.map(nestedOnly, (r) => r.title)).not.toContain(NEEDS_YOU);

  const asking = rowsOf(board({ active: [run("r1", { needsYou: true, choice: MENU })] }));
  expect(asking[0]!.title).toBe(NEEDS_YOU);
});

test("an agent whose run is not on the board goes in a group of its own", () => {
  const rows = rowsOf(
    board({
      agents: [
        agent("1", "Implementer", "r1"),
        // WARNING: a finished run keeps its agents; a hand-off names an implementer that outlives its run, so it hangs off that run.
        agent("2", "Reviewer", "r0"),
        agent("3", "Stray", "gone"),
      ],
      active: [run("r1")],
      recent: [run("r0", { glyph: "✓", detail: "done" })],
    }),
  );

  expect(Arr.map(rows, (r) => [r.kind, r.title])).toEqual([
    ["active", "Implement · r1"],
    ["agent", "└ Implementer"],
    ["recent", "Implement · r0"],
    ["agent", "└ Reviewer"],
    ["header", "agents with no run here"],
    ["agent", "└ Stray"],
  ]);
  expect(Option.getOrUndefined(Arr.findFirst(rows, (r) => r.agent === "stray-1"))!.detail).toBe(
    "working · gone",
  );
  expect(
    actionsFor(Option.getOrUndefined(Arr.findFirst(rows, (r) => r.kind === "header"))!, HERE),
  ).toEqual([]);
});

function group(label: string, over: Partial<WideGroup> = {}) {
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

function wideView(groups: Array<WideGroup>, quiet: Array<string> = []) {
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

  expect(Arr.map(rows, (r) => [r.kind, r.depth, r.title])).toEqual([
    ["group", 0, "Implement · glass"],
    ["active", 1, "Implement"],
    ["agent", 2, "├ Implementer"],
    ["agent", 2, "└ Reviewer"],
    ["recent", 1, "Implement"],
    ["header", 0, ""],
    ["group", 0, "Collie"],
    ["recent", 1, "Implement"],
    ["header", 0, ""],
    ["header", 0, "2 more workspace(s)"],
  ]);
  expect(Arr.map(selectableRows(rows), (r) => r.kind)).toEqual([
    "group",
    "active",
    "agent",
    "agent",
    "recent",
    "group",
    "recent",
  ]);
  expect(rows[0]!.glyph).toBe("⚙");
  expect(rows[0]!.detail).toBe("1 running · build");
  expect(rows.at(-1)!.detail).toBe("nothing of Collie's in them · Env · gitlab.cego.dk");
  expect(rows[2]!.key).toBe("1");
});

test("the digits are numbered across the tree, so one names the row it is on", () => {
  const rows = wideRows(
    wideView([
      group("Implement · glass", {
        agents: [agent("1", "Implementer", "r1"), agent("2", "Reviewer", "r1")],
        active: [run("r1")],
      }),
      group("Collie", { agents: [agent("1", "Planner", "r2")], active: [run("r2")] }),
    ]),
  );

  const digits = Arr.map(
    Arr.filter(rows, (r) => r.kind === "agent"),
    (r) => [r.title, r.key],
  );
  expect(digits).toEqual([
    ["├ Implementer", "1"],
    ["└ Reviewer", "2"],
    ["└ Planner", "3"],
  ]);
  // WARNING: past the ninth the row stays and the digit goes; there are nine digits and a board can hold more agents.
  const many = Arr.filter(
    wideRows(
      wideView([
        group("Implement · glass", {
          agents: Array.from({ length: 10 }, (_, i) => agent("", `Agent ${i}`, "r1")),
          active: [run("r1")],
        }),
      ]),
    ),
    (r) => r.kind === "agent",
  );
  expect(many).toHaveLength(10);
  expect(Arr.map(many, (r) => r.key)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", null]);

  const context = keys({ rows, row: rows[0]! });
  expect(keyIntent(context, press("3"))).toEqual({
    _tag: "Do",
    command: { _tag: "FocusAgent", agent: "planner-1" },
  });
});

test("an agent in the tree keeps the model that tells two variants apart", () => {
  const rows = wideRows(
    wideView([
      group("Implement · glass", {
        agents: [agent("1", "Review · Opus", "r1"), agent("2", "Review · Sonnet", "r1")],
        active: [run("r1")],
      }),
    ]),
  );

  expect(Arr.map(rows, (r) => r.title)).toEqual([
    "Implement · glass",
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

  expect(Arr.map(rows, (r) => r.title)).toEqual([
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

  for (const row of rows) {
    for (const text of [row.title, row.detail, row.ago]) {
      expect(text).not.toMatch(/\bw\d+(:[a-z]\d+)?\b|\b\d+-\d+\b/);
    }
  }
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

  expect(Arr.map(rows, (r) => r.runId)).toEqual([null, "r1", "r2"]);
  expect(rows[1]!.choice).toBe(MENU);
  // WARNING: waiting runs are counted in the group summary, not as needsYou, or the footer's count reads as two.
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

  // WARNING: herdr compacts tab and pane ids, so each row is keyed by the one key that survives a redraw.
  expect(workspace!.jump).toEqual({
    kind: "workspace",
    workspaceId: "w28",
    label: "Implement · glass",
  });
  expect(active!.jump).toEqual({ kind: "run", runId: "r1", label: "Implement · r1" });
  expect(agentRow!.jump).toEqual({ kind: "agent", agent: "implementer-1", label: "Implementer" });
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

  for (const row of rows) {
    expect(row.jump?.kind ?? "none").toBe("none");
  }
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

  expect(Arr.map(rows, (r) => r.jump?.kind)).toEqual(["run", "agent", "run"]);
});

test("a History row is not somewhere to jump: its run is a record, not a pane", () => {
  const rows = viewRows({
    view: "history",
    filter: { kind: "workspace", id: "w1" },
    tasks: [],
    now: 0,
    density: "comfortable",
    note: null,
    history: [run("r9", { glyph: "✓", detail: "done" })],
    definitions: null,
    settings: null,
    detail: null,
    live: null,
    previewing: null,
    stopping: [],
  });

  expect(rows[0]!.jump).toBeNull();
});

test("a setting a Desktop shares with the Flock says so, and a remembered one does not", () => {
  const rows = viewRows({
    view: "settings",
    filter: { kind: "workspace", id: "w1" },
    tasks: [],
    now: 0,
    density: "comfortable",
    note: null,
    history: null,
    definitions: null,
    settings: {
      configPath: "/u/config.json",
      defaults: [{ key: "model", value: "opus", multiline: false }],
      remembered: [{ key: "linear.team", value: "CEG" }],
      trust: { cwd: "/w", state: "trusted" },
      flock: "laptop",
    },
    detail: null,
    live: null,
    previewing: null,
    stopping: [],
  });

  expect(Arr.map(rows, (row) => row.detail)).toEqual([
    "opus · shared with the Flock by laptop",
    "CEG",
    "trusted · /w",
  ]);
});

test("the keys that start something are this Session's, not a wide board's", () => {
  const row = rowsOf(board({ active: [run("r1")] }))[0]!;

  for (const key of ["p", "u", "f", "s"]) {
    expect(keyIntent(keys({ row, filter: HERE }), press(key))).not.toBeNull();
    expect(keyIntent(keys({ row, filter: EVERYWHERE }), press(key))).toBeNull();
  }
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
  const target = "mr:gitlab.example.com/g/p!42";
  // WARNING: one recent row goes in, so one row comes out.
  const [row] = rowsOf(board({ recent: [run("r0", { target, fixable: true })] })) as [Row];

  expect(Arr.map(actionsFor(row, HERE), (a) => a.key)).toEqual(["l", "x", "o", "w"]);
  // WARNING: the merge request is still the run's own: opening and posting act on the run, not this checkout.
  expect(Arr.map(actionsFor(row, EVERYWHERE), (a) => a.key)).toEqual(["l", "o", "w"]);
  expect(keyIntent(keys({ row, filter: HERE }), press("x"))).toEqual({
    _tag: "Do",
    command: { _tag: "ChooseOffer", runId: "r0" },
  });
  expect(keyIntent(keys({ row, filter: EVERYWHERE }), press("x"))).toBeNull();
});

test("a re-sorted list keeps the same run selected", () => {
  const before = rowsOf(board({ active: [run("r1"), run("r2")] }));
  const after = rowsOf(board({ active: [run("r2"), run("r1")] }));

  expect(clampSelection("run:r1", before, after)).toBe("run:r1");
});

test("a selection that finishes lands on the row that took its place", () => {
  const before = rowsOf(board({ active: [run("r1"), run("r2"), run("r3")] }));
  const after = rowsOf(board({ active: [run("r1"), run("r3")] }));

  expect(clampSelection("run:r2", before, after)).toBe("run:r3");
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
  // WARNING: one active run with one agent under it and one recent run went in, and the length is asserted above, so the three rows are there in that order.
  const [active, working, recent] = rows as [Row, Row, Row];

  expect(Arr.map(actionsFor(working, HERE), (a) => [a.key, a.command])).toEqual([
    ["3", { _tag: "FocusAgent", agent: "rev-1" }],
  ]);
  expect(Arr.map(actionsFor(active, HERE), (a) => [a.key, a.command])).toEqual([
    ["l", { _tag: "OpenLog", runId: "r1" }],
    ["k", { _tag: "StopRun", runId: "r1" }],
  ]);
  expect(Arr.map(actionsFor(recent, HERE), (a) => a.key)).toEqual(["l", "x"]);
});

test("a clean review can still be opened in a browser", () => {
  // WARNING: a fix round and a second review run in this workspace's checkout, so they stay Session-local.
  const target = "mr:gitlab.example.com/g/p!42";
  // WARNING: one recent row goes into each board, so each list has exactly that row.
  const [clean] = rowsOf(board({ recent: [run("r0", { target, fixable: false })] })) as [Row];
  // WARNING: as above — one row in, one row out.
  const [withFindings] = rowsOf(board({ recent: [run("r1", { target, fixable: true })] })) as [Row];

  expect(Arr.map(actionsFor(clean, HERE), (a) => a.key)).toEqual(["l", "x", "w"]);
  expect(Arr.map(actionsFor(withFindings, HERE), (a) => a.key)).toEqual(["l", "x", "o", "w"]);
});

test("one thing owns the keyboard, in one order", () => {
  // WARNING: the keyboard, a paste and the footer must agree on the field; each used to work it out separately.
  const setting = { key: "model", value: "opus" };
  const all = { flow: true, choice: MENU, filtering: true, setting };

  expect(keyboardOn(all)._tag).toBe("Flow");
  expect(keyboardOn({ ...all, flow: false })).toEqual({ _tag: "Choice", choice: MENU });
  expect(keyboardOn({ ...all, flow: false, choice: null })._tag).toBe("Filter");
  expect(keyboardOn({ ...all, flow: false, choice: null, filtering: false })).toEqual({
    _tag: "Setting",
    setting,
  });
  expect(keyboardOn({ flow: false, choice: null, filtering: false, setting: null })._tag).toBe(
    "Board",
  );
});

test("a menu is answered by the option the cursor is on", () => {
  const start = { index: 0, typed: "" };
  expect(answerFor(MENU, start, "\u001b[B").asking.index).toBe(1);
  expect(answerFor(MENU, { index: 1, typed: "" }, "\u001b[B").asking.index).toBe(1);
  expect(answerFor(MENU, start, "\u001b[A").asking.index).toBe(0);
  expect(answerFor(MENU, { index: 1, typed: "" }, "\r").value).toBe("Stop here");
  expect(answerFor(MENU, start, "\u001b").value).toBe("");
  expect(answerFor(MENU, start, "x").value).toBeNull();
});

test("a filter keeps a matching agent under the run it works for", () => {
  const rows = rowsOf(
    board({
      agents: [agent("1", "Reviewer", "r1"), agent("2", "Planner", "r2")],
      active: [run("r1"), run("r2")],
      recent: [],
    }),
  );

  expect(Arr.map(matching(rows, "Reviewer"), (r) => [r.kind, r.title])).toEqual([
    ["active", "Implement · r1"],
    ["agent", "└ Reviewer"],
  ]);
  expect(Arr.map(matching(rows, "r2"), (r) => [r.kind, r.title])).toEqual([
    ["active", "Implement · r2"],
  ]);
  // WARNING: the order is the board's, not the match rank, or a pick list would lift an agent above its own run.
  const order = (kept: Array<Row>) => Arr.map(kept, (r) => rows.indexOf(r));
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

  expect(Arr.map(matching(rows, "Stray"), (r) => [r.kind, r.title])).toEqual([
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

  // WARNING: a wide run is named by its workflow alone, so the workspace row is the one thing a filter must not drop.
  const byAgent = matching(rows, "Implementer");
  expect(Arr.map(byAgent, (r) => [r.kind, r.title])).toEqual([
    ["group", "Implement · glass"],
    ["active", "Implement"],
    ["agent", "└ Implementer"],
  ]);
  expect(Arr.map(matching(rows, "Collie"), (r) => r.kind)).toEqual(["group", "active"]);
  expect(Arr.map(matching(rows, "glass"), (r) => r.kind)).toEqual(["group", "active", "agent"]);
});

test("a header is never kept without the group it names", () => {
  const rows = rowsOf(
    board({
      agents: [agent("1", "Stray", "gone")],
      active: [run("r1")],
      recent: [],
    }),
  );

  expect(matching(rows, "agents with no run")).toEqual([]);
  expect(matching(rows, "no run here")).toEqual([]);
  expect(Arr.map(matching(rows, "Stray"), (r) => r.kind)).toEqual(["header", "agent"]);
});

test("a capped question shows a window of options that follows the cursor", () => {
  const items = ["a", "b", "c", "d", "e"];
  const shown = (at: number, room: number) => optionWindow(items, at, room);

  expect(shown(0, 5)).toEqual({ shown: items, hidden: 0 });
  expect(shown(0, 3)).toEqual({ shown: ["a", "b", "c"], hidden: 2 });
  expect(shown(2, 3)).toEqual({ shown: ["a", "b", "c"], hidden: 2 });
  expect(shown(3, 3)).toEqual({ shown: ["b", "c", "d"], hidden: 2 });
  expect(shown(4, 3)).toEqual({ shown: ["c", "d", "e"], hidden: 2 });
  expect(shown(4, 1)).toEqual({ shown: ["e"], hidden: 4 });
});

test("a question is answered by what was typed", () => {
  const ask: PendingChoice = { ...MENU, kind: "ask", items: [] };
  expect(answerFor(ask, { index: 0, typed: "" }, "h").asking.typed).toBe("h");
  expect(answerFor(ask, { index: 0, typed: "hi" }, "\u007f").asking.typed).toBe("h");
  expect(answerFor(ask, { index: 0, typed: "hi" }, "\r").value).toBe("hi");
  expect(answerFor(ask, { index: 0, typed: "hi" }, "\u001b[B").asking.typed).toBe("hi");
});

test("a paste fills a field and never submits it", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);
  const url = "https://gitlab.cego.dk/cego/collie/-/merge_requests/7";

  expect(pasteInto("", bytes(url))).toBe(url);
  expect(pasteInto("https://", bytes("gitlab.cego.dk"))).toBe("https://gitlab.cego.dk");
  // WARNING: a pasted newline is the submit key, so it must reach the field as nothing at all.
  expect(pasteInto("", bytes(`${url}\n`))).toBe(url);
  expect(pasteInto("", bytes(`one\r\ntwo\n`))).toBe("onetwo");
  expect(pasteInto("", bytes("\u001b[Bfix-\u0007caf\u00e9"))).toBe("[Bfix-caf\u00e9");
});

test("a row says how long it has been like this, not when", () => {
  expect(agoShort(NOW, NOW)).toBe("now");
  expect(agoShort(NOW - 45_000, NOW)).toBe("45s ago");
  expect(agoShort(NOW - 120_000, NOW)).toBe("2m ago");
  expect(agoShort(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
  expect(agoShort(NOW - 4 * 86_400_000, NOW)).toBe("4d ago");
  expect(agoShort(0, NOW)).toBe("");
  expect(agoShort(NOW + 5000, NOW)).toBe("now");
});

test("the long and short renderings never disagree about the unit", () => {
  // WARNING: the resume menu and the tab's row list both show these, so one instant must read the same in both.
  for (const seconds of [0, 59, 60, 3599, 3600, 86_399, 86_400, 200_000]) {
    const at = NOW - seconds * 1000;
    const long = ago(FIXED_ISO(at), NOW);
    const short = agoShort(at, NOW);
    const unit = pipe(long, Str.includes("day"))
      ? "d"
      : pipe(long, Str.includes("hour"))
        ? "h"
        : "m";
    if (long === "just now") {
      continue;
    }
    expect([seconds, pipe(short, Str.includes(unit))]).toEqual([seconds, true]);
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
  // WARNING: a new Selection starts from the first page, not from how far the last one had been paged.
  expect(retarget(at, { _tag: "MoreReview" }).reviewPages).toBe(2);
  expect(
    retarget({ ...at, reviewPages: 4 }, { _tag: "Select", id: "run:r2", on: null }).reviewPages,
  ).toBe(1);

  const shown = retarget(at, { _tag: "ShowView", view: "history" });
  expect(shown.view).toBe("history");
  expect(shown.shown).toEqual(["runs", "history"]);
  expect(retarget(shown, { _tag: "ShowView", view: "runs" }).shown).toEqual(["runs", "history"]);
});

test("moving the Selection reuses the board; anything else re-reads it", () => {
  const at = focus({ selected: "run:r1" });

  expect(rereads(null, at)).toEqual({ reuse: false, forceMr: false });

  expect(rereads(at, { ...at, selected: "run:r2" })).toEqual({ reuse: true, forceMr: false });

  // WARNING: a Refresh and the read after a command go past the merge-request cache.
  expect(rereads(at, { ...at, nonce: 1 })).toEqual({ reuse: false, forceMr: true });
  expect(rereads(at, { ...at, selected: "run:r2", nonce: 1 })).toEqual({
    reuse: false,
    forceMr: true,
  });

  expect(rereads(at, { ...at, view: "history", shown: ["runs", "history"] }).reuse).toBe(false);
  expect(rereads(at, { ...at, tail: true }).reuse).toBe(false);
  expect(rereads(at, { ...at, reviewPages: 2 }).reuse).toBe(false);
});

test("a row id says whether it is a Run, and which one", () => {
  expect(runIdOf("run:review-17-20260902")).toBe("review-17-20260902");
  expect(runIdOf("agent:impl-1")).toBeNull();
  expect(runIdOf("workflow:review")).toBeNull();
  expect(runIdOf(null)).toBeNull();
  // WARNING: the row ids the board mints are the ones this reads back.
  expect(runIdOf(rowsOf(board({ recent: [run("r1")] }))[0]!.id)).toBe("r1");
});

test("an agent's row says what it is doing, and its run only where that is all it has", () => {
  const rows = rowsOf(
    board({
      agents: [agent("1", "Implementer", "r1", "Simplify cego.collie plugin")],
      active: [run("r1")],
    }),
  );
  expect(Arr.map(rows, (r) => r.detail)).toEqual([
    "build",
    "working · Simplify cego.collie plugin",
  ]);

  const quiet = rowsOf(board({ agents: [agent("1", "Reviewer", "r1")], active: [run("r1")] }));
  expect(quiet[1]!.detail).toBe("working");

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

  expect(Arr.map(rows, (r) => [r.kind, r.id])).toEqual([
    ["header", "header:Needs you"],
    ["active", "run:r2"],
    ["agent", "agent:implementer-1"],
    ["active", "run:r1"],
    ["active", "run:r3"],
  ]);
  expect(rows[0]!.title).toBe("Needs you");
  expect(Arr.map(rowsOf(board({ active: [run("r1")] })), (r) => r.kind)).toEqual(["active"]);
});

test("nothing acts on a header row", () => {
  const rows = rowsOf(board({ active: [run("r1"), run("r2", { needsYou: true })] }));

  expect(rows[0]!.kind).toBe("header");
  expect(actionsFor(rows[0]!, HERE)).toEqual([]);
});

test("the footer counts the runs waiting on you, and only while the Selection is elsewhere", () => {
  const waiting = [run("r1", { needsYou: true }), run("r2", { needsYou: true }), run("r3")];

  expect(needsYouStatus(rowsOf(board({ active: waiting })), "run:r3")).toBe("2 run(s) need you");
  expect(needsYouStatus(rowsOf(board({ active: waiting })), "run:r1")).toBeNull();
  expect(needsYouStatus(rowsOf(board({ active: [run("r1")] })), "run:r1")).toBeNull();
});

test("how long something took reads in the coarsest unit that still says it", () => {
  expect(took(45_000)).toBe("45s");
  expect(took(12 * 60_000)).toBe("12m");
  expect(took(63 * 60_000)).toBe("1h03m");
  expect(took(24 * 3_600_000)).toBe("24h00m");
  expect(took(400)).toBe("0s");
  expect(took(-5000)).toBe("0s");
});

test("the footer offers the panel's keys and the globals, and no more", () => {
  const globals = "g all · p run · ? keys · q close";
  expect(footerKeys({ panel: [], on: { _tag: "Board" }, filter: HERE })).toBe(globals);
  expect(footerKeys({ panel: ["t log tail"], on: { _tag: "Board" }, filter: HERE })).toBe(
    `t log tail · ${globals}`,
  );
  // WARNING: g names where it goes; starting a run is this Session's, so the all-workspaces board does not offer it.
  expect(footerKeys({ panel: [], on: { _tag: "Board" }, filter: EVERYWHERE })).toBe(
    "g local · ? keys · q close",
  );
});

test("a field that has taken the keys says what they do instead", () => {
  // WARNING: while a choice has the keyboard the board's keys are inert, so offering them would be a lie.
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
  const keys = Arr.map(ALL_KEYS, (k) => k.key);
  for (const key of ["Tab", "/", "Esc", "m", "r", "?", "q"]) {
    expect(keys).toContain(key);
  }
  expect(Arr.every(ALL_KEYS, (k) => k.what !== "")).toBe(true);
});

const HERE: Filter = { kind: "workspace", id: "w1" };
const EVERYWHERE: Filter = { kind: "all" };

function keys(over: Partial<KeyContext> = {}) {
  const returned: KeyContext = {
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
    mrs: [],
    ...over,
  };
  return returned;
}

function state() {
  return {
    view: "runs",
    filter: { kind: "all" },
    tasks: [],
    now: 0,
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
}

const ROW: Row = rowsOf(board({ active: [run("r1")] }))[0]!;

function press(sequence: string, over: Omit<Keypress, "sequence"> = {}) {
  return { sequence, ...over };
}

test("the help overlay owns the keyboard, then a flow, then the board", () => {
  // WARNING: a flow running inline has its own handler; a key that also moved the Selection would act on a hidden board.
  expect(keyIntent(keys({ on: { _tag: "Flow" } }), press("q", { name: "q" }))).toBeNull();
  expect(keyIntent(keys({ on: { _tag: "Flow" } }), press("?"))).toBeNull();

  expect(keyIntent(keys({ helping: true }), press("k", { name: "k" }))).toEqual({
    _tag: "Help",
    open: false,
  });
  expect(keyIntent(keys(), press("?"))).toEqual({ _tag: "Help", open: true });

  expect(
    keyIntent(keys({ on: { _tag: "Flow" }, helping: true }), press("k", { name: "k" })),
  ).toEqual({
    _tag: "Help",
    open: false,
  });
});

test("a literal question mark reaches the text it was typed into", () => {
  // WARNING: printable characters belong to whatever takes text; only the board owns the printable keys otherwise.
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
  expect(keyIntent(typing, press("\r", { name: "return" }))).toEqual({
    _tag: "Filtering",
    filter: "revi",
    typing: false,
  });
  expect(keyIntent(typing, press("\u001b", { name: "escape" }))).toEqual({
    _tag: "Filtering",
    filter: "",
    typing: false,
  });
  // WARNING: a key the board owns is text while the filter has the keyboard.
  expect(keyIntent(typing, press("R"))).toEqual({
    _tag: "Filtering",
    filter: "reviR",
    typing: true,
  });
});

test("Esc on the board drops a filter it is still narrowed by, and nothing else", () => {
  const narrowed = keys({ query: "gitlab" });
  const esc = press("\u001b", { name: "escape" });

  expect(keyIntent(narrowed, esc)).toEqual({ _tag: "Filtering", filter: "", typing: false });
  // WARNING: with no filter set Esc widens the board; narrowing to one workspace is a filter too, so both exits share a key.
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
  // WARNING: Enter sends the value and closes the editor in one intent; a bare command left the footer in editor mode.
  expect(keyIntent(editing, press("\r", { name: "return" }))).toEqual({
    _tag: "Submitted",
    command: { _tag: "SetDefault", key: "model", value: "opu" },
  });
  expect(keyIntent(editing, press("\u001b", { name: "escape" }))).toEqual({
    _tag: "Editing",
    editing: null,
  });
});

test("the panel's scroll keys do not fight the list's arrows", () => {
  const scrollable = keys({ scrollable: true });

  expect(keyIntent(scrollable, press("\u001b[6~", { name: "pagedown" }))).toEqual({
    _tag: "Scroll",
    by: 1,
    unit: "page",
  });
  expect(keyIntent(scrollable, press("\u001b[B", { name: "down", shift: true }))).toEqual({
    _tag: "Scroll",
    by: 1,
    unit: "line",
  });
  expect(keyIntent(scrollable, press("\u001b[B", { name: "down" }))).toEqual({
    _tag: "Move",
    by: 1,
  });
  expect(keyIntent(keys(), press("\u001b[6~", { name: "pagedown" }))).toBeNull();
});

test("a key with nothing to act on does nothing, rather than acting on something else", () => {
  expect(keyIntent(keys(), press("t"))).toBeNull();
  expect(keyIntent(keys(), press("m"))).toBeNull();
  expect(keyIntent(keys(), press("c"))).toBeNull();

  // WARNING: one active run went in, so one row comes out.
  const [row] = rowsOf(board({ active: [run("r1")] })) as [Row];
  expect(keyIntent(keys({ row }), press("t"))).toEqual({
    _tag: "Do",
    command: { _tag: "ToggleTail" },
  });
  expect(keyIntent(keys({ cutShort: true }), press("m"))).toEqual({
    _tag: "Do",
    command: { _tag: "MoreReview" },
  });
  const url = "https://host/g/p/-/merge_requests/42";
  expect(
    keyIntent(
      keys({ mrs: [{ short: "p!42", target: "mr:host/g/p!42", url, runId: null }] }),
      press("c"),
    ),
  ).toEqual({
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
  expect(keyIntent(keys({ rows, row: rows[1]! }), press("1"))).toEqual({
    _tag: "Do",
    command: { _tag: "FocusAgent", agent: "impl-1" },
  });
  expect(keyIntent(keys({ rows, row: rows[1]! }), press("4"))).toBeNull();
});

test("the row's own actions are the last thing a key is tried against", () => {
  // WARNING: one active run went in, so one row comes out.
  const [row] = rowsOf(board({ active: [run("r1")] })) as [Row];

  expect(keyIntent(keys({ row }), press("k", { name: "k" }))).toEqual({
    _tag: "Do",
    command: { _tag: "StopRun", runId: "r1" },
  });
  // WARNING: s names its review; an argument-less send meant the newest run in the Session.
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
  const given = menuFor(task({ mr: "mr:gitlab.cego.dk/mk/collie!151" }));
  expect(Arr.map(given, (one) => one.label)).toContain("Open merge request");
  expect(
    Option.getOrUndefined(Arr.findFirst(given, (one) => one.label === "Open merge request"))
      ?.command,
  ).toMatchObject({
    _tag: "OpenMr",
    target: "mr:gitlab.cego.dk/mk/collie!151",
  });
});

test("on a card of several merge requests, w and y ask which one, and each answer acts on its own", () => {
  const app = taskMr("spilnu/app", 12, { run: "r-app" });
  const api = taskMr("spilnu/api", 7, { run: "r-api" });
  const menu = menuFor(task({ mr: app.mr, mrs: [app, api] }));
  const chooser = (key: string) => {
    const command = Option.getOrUndefined(Arr.findFirst(menu, (one) => one.key === key))?.command;
    return command?._tag === "ChooseMr" ? mrChoices(command) : [];
  };

  expect(Arr.map(chooser("w"), (one) => [one.key, one.label, one.command])).toEqual([
    [
      "1",
      "Open MR app!12",
      { _tag: "OpenMr", target: "mr:gitlab.cego.dk/spilnu/app!12", runId: "r1" },
    ],
    [
      "2",
      "Open MR api!7",
      { _tag: "OpenMr", target: "mr:gitlab.cego.dk/spilnu/api!7", runId: "r1" },
    ],
  ]);
  expect(Arr.map(chooser("y"), (one) => [one.key, one.command])).toEqual([
    ["1", { _tag: "CopyLink", url: app.url ?? "" }],
    ["2", { _tag: "CopyLink", url: api.url ?? "" }],
  ]);
  const choice = (one: typeof app) => ({
    short: one.short,
    target: `mr:${one.id}`,
    url: one.url,
    runId: one.run,
  });
  expect(keyIntent(keys({ mrs: [choice(app)] }), press("c"))).toEqual({
    _tag: "Copy",
    text: app.url ?? "",
  });
  expect(keyIntent(keys({ mrs: [choice(app), choice(api)] }), press("c"))).toEqual({
    _tag: "Do",
    command: { _tag: "ChooseMr", copy: true, mrs: [choice(app), choice(api)] },
  });
});

test("a card of several merge requests with a check running gives each menu item a key of its own", () => {
  const app = taskMr("spilnu/app", 12, { run: "r-app" });
  const api = taskMr("spilnu/api", 7, { run: "r-api" });
  const check = {
    name: "test",
    pass: "gate",
    round: null,
    revision: "abc",
    base: null,
    elapsedMs: null,
    usualMs: null,
    others: 0,
    sentence: "Running test on the branch.",
    log: null,
    lastLines: [],
  } as const;
  const keyed = Arr.filter(
    Arr.map(menuFor(task({ mr: app.mr, mrs: [app, api], check })), (one) => one.key),
    (key) => key !== "",
  );
  expect(keyed).toContain("c");
  expect(new Set(keyed).size).toBe(keyed.length);
});

test("every one of more than nine merge requests is reachable from the chooser by its keys", () => {
  const mrs = Arr.map(Arr.range(1, 11), (iid) => ({
    short: `app!${iid}`,
    target: `mr:gitlab.cego.dk/spilnu/app!${iid}`,
    url: `https://gitlab.cego.dk/spilnu/app/-/merge_requests/${iid}`,
    runId: `r${iid}`,
  }));
  for (const copy of [false, true]) {
    const reached: Array<string> = [];
    let page: ReadonlyArray<MenuItem> = mrChoices({ _tag: "ChooseMr", copy, mrs });
    while (page.length > 0) {
      const keys = Arr.map(page, (one) => one.key);
      expect(Arr.every(keys, (key) => /^[1-9]$/.test(key))).toBe(true);
      expect(new Set(keys).size).toBe(keys.length);
      let next: ReadonlyArray<MenuItem> = [];
      for (const { command } of page) {
        if (command._tag === "ChooseMr") {
          next = mrChoices(command);
        }
        if (command._tag === "OpenMr") {
          reached.push(command.target);
        }
        if (command._tag === "CopyLink") {
          reached.push(command.url);
        }
      }
      page = next;
    }
    expect(reached).toEqual(Arr.map(mrs, (one) => (copy ? one.url : one.target)));
  }
});

test("every key a card's menu offers is one the overlay advertises", () => {
  // WARNING: a key offered on a card and missing from ? is a key nobody can look up.
  const advertised = new Set(Arr.map(ALL_KEYS, (entry) => entry.key));
  const states = ["blocked", "active", "quiet", "failed", "stopped", "done"] as const;
  const offered = new Set(
    Arr.flatMap(states, (state) =>
      Arr.map(
        menuFor(task({ state, mr: "https://host/g/p/-/merge_requests/42" })),
        (item) => item.key,
      ),
    ),
  );
  expect(offered.size).toBeGreaterThan(4);
  expect(Arr.filter([...offered], (key) => !advertised.has(key))).toEqual([]);
});

test("a filter keeps a matching agent under a finished run too", () => {
  const rows = rowsOf(
    board({
      agents: [agent("1", "Reviewer", "r1")],
      active: [],
      recent: [run("r1")],
    }),
  );

  expect(Arr.map(matching(rows, "Reviewer"), (r) => [r.kind, r.title])).toEqual([
    ["recent", "Implement · r1"],
    ["agent", "└ Reviewer"],
  ]);
});

test('the "Needs you" header survives a filter its runs match', () => {
  const rows = rowsOf(
    board({
      agents: [],
      active: [run("r1", { needsYou: true }), run("r2")],
      recent: [],
    }),
  );

  expect(Arr.map(matching(rows, "r1"), (r) => [r.kind, r.title])).toEqual([
    ["header", "Needs you"],
    ["active", "Implement · r1"],
  ]);
  expect(Arr.map(matching(rows, "r2"), (r) => [r.kind, r.title])).toEqual([
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
  const ids = Arr.map(selectableRows(rows), (r) => r.id);
  const [first, middle, last] = [ids[0]!, ids[1]!, ids[2]!];

  expect(nextQuestionId(rows, first)).toBe(middle === last ? last : ids[1]!);
  expect(nextQuestionId(rows, last)).toBe(first);
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
  expect(
    keyIntent(keys({ on: { _tag: "Choice", choice: MENU } }), press("n", { name: "n" })),
  ).toEqual({ _tag: "NextQuestion" });

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

test("the filter says which board this is, and the Session-local keys read it", () => {
  // WARNING: narrowed either way is one Session's, since a Run belongs to the workspace it was started in.
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
  const onRun = focus({ filter: { kind: "run", id: "r1" }, origin: "w1" });
  expect(retarget(onRun, { _tag: "ToggleFilter" }).filter).toEqual({ kind: "all" });
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
  const marked = (id: string) =>
    Option.getOrUndefined(Arr.findFirst(rows, (r) => r.id === id))!.marks;
  expect(marked("run:r1")).toBe("↯ ▶");
  expect(marked("run:r2")).toBe("⏸");
  expect(marked("run:r3")).toBe("⚠ manual !");
  expect(marked("agent:fix-1")).toBe("⚠ manual");
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
  expect(Option.getOrUndefined(Arr.findFirst(rows, (r) => r.id === "group:w1"))!.marks).toBe("↯");
});

test("`:` is no longer a mode: the board keeps its keys", () => {
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
  expect(keyIntent(previewing, press("\u001b", { name: "escape" }))).toEqual({
    _tag: "Do",
    command: { _tag: "DeclineProposal", id: "p1", hash: "deadbeef" },
  });
  expect(keyIntent(previewing, press("k"))).toBeNull();
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
    wide: null,
    marks: {},
    filter: { kind: "run", id: "r1" },
    board: board({
      active: [run("r1"), run("r2")],
      agents: [agent("1", "Implementer", "r1"), agent("2", "Reviewer", "r2")],
    }),
  });

  // WARNING: on the local board an agent sits at its run's depth, so depth alone cannot say where a group ends.
  expect(Arr.map(rows, (r) => r.id)).toEqual(["run:r1", "agent:implementer-1"]);
});

test("a card's menu offers only what that Task can be asked for", () => {
  const working = menuFor(task());
  expect(Arr.map(working, (item) => [item.key, item.label])).toEqual([
    ["enter", "Open record"],
    ["g", "Go to its tab"],
    ["s", "Steer…"],
    ["a", "Attach files…"],
    ["o", "What it offers…"],
    ["h", "Hold run"],
    ["k", "Stop run"],
  ]);
  expect(working[0]!.command).toEqual({ _tag: "OpenRecord", id: "t1" });
  expect(working[1]!.command).toEqual({
    _tag: "Jump",
    jump: { kind: "run", runId: "r1", label: "Strapi prod seeder" },
  });
  expect(working[3]!.command).toEqual({ _tag: "AttachFiles", runId: "r1" });
  expect(working[4]!.command).toEqual({ _tag: "ChooseOffer", runId: "r1" });
  expect(working[5]!.command).toEqual({ _tag: "HoldRun", runId: "r1", set: true });
  expect(working[6]!.command).toEqual({ _tag: "StopRun", runId: "r1" });
  expect(
    Option.getOrUndefined(
      Arr.findFirst(menuFor(task({ held: "⏸ Held." })), (item) => item.key === "h"),
    )?.command,
  ).toEqual({
    _tag: "HoldRun",
    runId: "r1",
    set: false,
  });

  expect(Arr.map(menuFor(task({ state: "failed" })), (item) => item.label)).toEqual([
    "Open record",
    "Go to its tab",
    "What it offers…",
    "Resume run",
  ]);
  expect(Arr.map(menuFor(task({ state: "stopped" })), (item) => item.label)).toContain(
    "Resume run",
  );
  expect(Arr.map(menuFor(task({ state: "done" })), (item) => item.label)).toEqual([
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
  expect(Arr.map(menuFor(ready), (item) => item.label)).toContain("Build these tickets");
  const undeclared = task({ state: "done", landed: false, planReady: true, offer: null });
  expect(primaryFor(undeclared)).toBeNull();
  expect(Arr.map(menuFor(undeclared), (item) => item.label)).not.toContain("Implement now");
});

test("a primary Release keeps its declared title and owning Run", () => {
  const offer = { id: "release", title: "Release after review", run: "r-owner" };
  const ready = task({ state: "done", landed: false, shipping: "merge", offer });
  expect(primaryFor(ready)).toEqual({
    key: "i",
    label: "Release after review",
    command: { _tag: "InvokeOffer", runId: "r-owner", offer: "release" },
  });
  expect(Arr.map(menuFor(ready), (item) => item.label)).toContain("Release after review");
});

test("the merge request is offered when there is one to open, named the way glab takes it", () => {
  const withMr = task({ mr: "https://gitlab.cego.dk/mk/collie/-/merge_requests/151" });
  const item = Option.getOrUndefined(
    Arr.findFirst(menuFor(withMr), (one) => one.label === "Open merge request"),
  );
  expect(item?.key).toBe("w");
  expect(item?.command).toEqual({
    _tag: "OpenMr",
    target: "mr:gitlab.cego.dk/mk/collie!151",
    runId: "r1",
  });
  expect(Arr.map(menuFor(task({ mr: "see the ticket" })), (one) => one.label)).not.toContain(
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
  // WARNING: stopped and failed work can also have been landed by hand.
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

  expect(olderFinished(null, onBoard, 1)).toEqual({ rows: [], more: true });

  const first = olderFinished(history, onBoard, 1, 1);
  expect(Arr.map(first.rows, (row) => row.id)).toEqual(["r3"]);
  expect(first.more).toBe(true);

  const second = olderFinished(history, onBoard, 2, 1);
  expect(Arr.map(second.rows, (row) => row.id)).toEqual(["r3", "r4"]);
  expect(second.more).toBe(false);

  expect(olderFinished(history, onBoard, 0)).toEqual({ rows: [], more: true });
});
