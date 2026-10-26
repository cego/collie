import { expect, test } from "bun:test";
import {
  flowAnnouncements,
  flowKey,
  inspectorOf,
  nodeName,
  openIn,
  rowOrigin,
  selectEntry,
  selectNode,
} from "../desktop/src/shared/flow";
import { flowNode, mainFlow } from "./support/flow";
import { epochMs } from "../src/time";

test("the inspector can follow either the requesting Run or its Task parent", () => {
  const flow = mainFlow();
  const child = {
    ...flow,
    lanes: flow.lanes.map((lane) => ({ ...lane, startedBy: { run: "parent", step: "build" } })),
  };
  expect(rowOrigin(child, "build-run")).toEqual({ run: "parent", machine: "laptop" });
  const requested = {
    ...flow,
    lanes: flow.lanes.map((lane) => ({
      ...lane,
      requestedBy: {
        run: "requester",
        agent: "builder",
        machine: { installation: "vm-id", name: "vm" },
      },
    })),
  };
  expect(rowOrigin(requested, "build-run")).toEqual({ run: "requester", machine: "vm" });
});

test("selecting a Step toggles its inspector, and an earlier Run switches the record", () => {
  const flow = mainFlow();
  expect(selectNode(flow, { run: "build-run", node: "build" }, null, [])).toEqual({
    kind: "inspect",
    run: "build-run",
    selection: { run: "build-run", node: "build", item: null },
  });
  expect(
    selectNode(
      flow,
      { run: "build-run", node: "build" },
      { run: "build-run", node: "build", item: null },
      [],
    ),
  ).toEqual({ kind: "close" });
  expect(selectNode(flow, { run: "plan-run", node: "spec" }, null, [])).toMatchObject({
    kind: "inspect",
    run: "plan-run",
  });
});

test("Flow keys move by position between rows and stay at the ends", () => {
  const flow = mainFlow();
  const build = { run: "build-run", node: "build" };
  expect(flowKey(flow, build, "ArrowDown", false)?.focus).toEqual({ run: "release", node: "ci" });
  expect(flowKey(flow, build, "ArrowUp", false)?.focus).toEqual({ run: "plan-run", node: "grill" });
  const last = flowKey(flow, build, "End", false)!.focus;
  expect(last).toEqual({ run: "build-run", node: "mr" });
  expect(flowKey(flow, last, "ArrowRight", false)?.focus).toEqual(last);
  expect(flowKey(flow, build, "Escape", true)).toEqual({
    focus: build,
    close: true,
    select: false,
  });
  expect(flowKey(flow, last, "Home", false)?.focus).toEqual(build);
  expect(flowKey(flow, build, "Enter", false)?.select).toBe(true);
});

test("Shift Enter takes the node's primary and the menu keys open its menu", () => {
  const flow = mainFlow();
  const at = { run: "build-run", node: "build" };
  expect(flowKey(flow, at, "Enter", false, true)).toMatchObject({ primary: true, select: false });
  expect(flowKey(flow, at, "F10", false, true)).toMatchObject({ menu: true });
  expect(flowKey(flow, at, "ContextMenu", false)).toMatchObject({ menu: true });
});

test("node names include state, fact and a missing link's destination or saved timestamp", () => {
  const build = mainFlow().lanes[1]!.nodes[0]!;
  expect(nodeName(build)).toBe("Build, running, Slice 4 of 6");
  const linked = flowNode("linked", {
    kind: "link",
    link: {
      run: "absent",
      machine: "vm",
      asOf: "2026-10-23T09:14:00.000Z",
      state: "running",
      said: null,
    },
  });
  expect(nodeName(linked, { missing: true })).toContain("not on the board");
  expect(nodeName(linked, { notLive: true })).toContain("as of 2026-10-23T09:14:00.000Z");
});

test("Flow announces a new current Step or needs-you transition once", () => {
  const before = mainFlow();
  const after = { ...before, current: { run: "build-run", node: "review" } };
  expect(flowAnnouncements(before, after)).toEqual(["Review, expected"]);
  expect(flowAnnouncements(after, after)).toEqual([]);
  const asking = {
    ...after,
    lanes: after.lanes.map((lane) => ({
      ...lane,
      nodes: lane.nodes.map((node) =>
        node.id === "review"
          ? { ...node, state: "needs-you" as const, said: "Asked 1 min ago" }
          : node,
      ),
    })),
  };
  expect(flowAnnouncements(after, asking)).toEqual(["Review, needs you, Asked 1 min ago"]);
  expect(flowAnnouncements(asking, asking)).toEqual([]);
});

test("the inspector folds completed Slices and scopes its header to a picked Slice", () => {
  const flow = mainFlow();
  const selection = { run: "build-run", node: "build", item: null };
  const now = epochMs("2026-10-23T09:09:00.000Z");
  const whole = inspectorOf(flow, selection, now)!;
  expect(whole.lines).toContain("builder · claude/opus");
  expect(whole.lines).toContain("4 min so far");
  expect(whole.description).toBe("Work on the current Slice.");
  expect(whole.entries.map((entry) => entry.title)).toEqual(["3 done", "04", "05", "06"]);
  const picked = inspectorOf(flow, { ...selection, item: "build@04" }, now)!;
  expect(picked.title).toBe("04");
  expect(picked.lines).toContain("builder · codex/default");
  expect(picked.lines).toContain("4 min so far");
});

test.each(["done", "expected"] as const)(
  "the inspector groups Repo runs by Wave when the last repository is %s",
  (state) => {
    const repos = flowNode("repos", {
      kind: "workflow",
      runs: [
        flowNode("r-a", {
          title: "a",
          kind: "link",
          wave: 1,
          state: "done",
          link: { run: "r-a", machine: "laptop", state: "done", said: "!12 merged" },
        }),
        flowNode("r-b", {
          title: "b",
          kind: "link",
          wave: 1,
          state: "done",
          link: { run: "r-b", machine: "laptop", state: "done", said: null },
        }),
        flowNode("repo:c", {
          title: "c",
          kind: "link",
          wave: 2,
          state,
          link: { run: null, machine: null, state, said: null },
        }),
      ],
    });
    const flow = mainFlow([repos]);
    const selection = { run: "build-run", node: "repos", item: null };
    const entries = inspectorOf(flow, selection, 0)!.entries;
    expect(
      entries.map((entry) => ({
        title: entry.title,
        wave: entry.wave,
        folded: entry.folded,
        repos: entry.nodes.map((node) => [node.title, node.link?.run]),
      })),
    ).toEqual([
      {
        title: "Wave 1",
        wave: 1,
        folded: false,
        repos: [
          ["a", "r-a"],
          ["b", "r-b"],
        ],
      },
      { title: "Wave 2", wave: 2, folded: false, repos: [["c", null]] },
    ]);
    expect(
      selectEntry(flow, selection, "r-b", [{ key: "local:b", machine: "laptop", runs: ["r-b"] }]),
    ).toEqual({ kind: "open", card: "local:b", run: "r-b" });
  },
);

test("picking an inspector entry scopes a Slice or opens its linked Task", () => {
  const selection = { run: "build-run", node: "build", item: null };
  expect(selectEntry(mainFlow(), selection, "build@04", [])).toMatchObject({
    kind: "inspect",
    selection: { ...selection, item: "build@04" },
  });
  const node = flowNode("improvements", {
    links: [
      flowNode("child", {
        link: { run: "child-run", machine: "vm", state: "running", said: null },
      }),
    ],
  });
  expect(
    selectEntry(mainFlow([node]), { ...selection, node: "improvements" }, "child", [
      { key: "vm:child", machine: "vm", runs: ["child-run"] },
    ]),
  ).toEqual({ kind: "open", card: "vm:child", run: "child-run" });
});

test("the inspector preserves retry causes, fallback words and question attribution", () => {
  const node = flowNode("retry", {
    state: "done",
    ranOn: "codex/default (fell back from claude/opus: weekly limit)",
    started: "2026-10-23T09:00:00.000Z",
    ended: "2026-10-23T09:12:00.000Z",
    attempts: [
      { at: "2026-10-23T09:00:00.000Z", cause: null },
      { at: "2026-10-23T09:04:00.000Z", cause: "resumed" },
    ],
    questions: [
      {
        name: "go",
        asked: "2026-10-23T09:01:00.000Z",
        answered: "2026-10-23T09:03:00.000Z",
        by: "mk",
      },
    ],
  });
  const info = inspectorOf(mainFlow([node]), { run: "build-run", node: "retry", item: null }, 0)!;
  expect(info.lines).toContain(
    "builder · codex/default (fell back from claude/opus: weekly limit)",
  );
  expect(info.lines).toContain("Attempt 2 · resumed · 2026-10-23T09:04:00.000Z");
  expect(info.lines).toContain("Answered 2026-10-23T09:03:00.000Z by mk");
});

test.each([
  [{ produces: "plan" }, "plan"],
  [{ produces: "review" }, "review"],
  [{ kind: "check" }, "evidence"],
  [{ produces: "evidence" }, "evidence"],
  [{ kind: "release" }, "mr"],
  [{ produces: "merge-request" }, "mr"],
  [{ kind: "agent", state: "running" }, "terminal"],
  [{ kind: "question" }, "log"],
] as const)("Open in follows the work %j to %s on its own Run", (over, tab) => {
  expect(openIn(flowNode("work", over), "plan-run")).toEqual({ run: "plan-run", tab });
});

test("a linked Run opens its card, an absent Run opens nothing, and an offer opens its dialog", () => {
  const flow = mainFlow([
    flowNode("linked", {
      kind: "link",
      link: { run: "remote-run", machine: "vm", state: "running", said: null },
    }),
    flowNode("offer:implement", { kind: "offer" }),
  ]);
  const spot = { run: "build-run", node: "linked" };
  expect(
    selectNode(flow, spot, null, [{ key: "vm:task", machine: "vm", runs: ["remote-run"] }]),
  ).toEqual({ kind: "open", card: "vm:task", run: "remote-run" });
  expect(selectNode(flow, spot, null, [])).toEqual({ kind: "none" });
  expect(selectNode(flow, { run: "build-run", node: "offer:implement" }, null, [])).toEqual({
    kind: "offer",
    run: "build-run",
    offer: "implement",
  });
});
