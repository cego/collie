import * as Arr from "effect/Array";
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
    lanes: Arr.map(flow.lanes, (lane) => ({
      ...lane,
      startedBy: { run: "parent", step: "build" },
    })),
  };
  expect(rowOrigin(child, "build-run")).toEqual({ run: "parent", machine: "laptop" });
  const requested = {
    ...flow,
    lanes: Arr.map(flow.lanes, (lane) => ({
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
    lanes: Arr.map(after.lanes, (lane) => ({
      ...lane,
      nodes: Arr.map(lane.nodes, (node) =>
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
  expect(whole.purpose).toBe("Work on the current Slice.");
  expect(Arr.map(whole.entries, (entry) => entry.title)).toEqual(["3 done", "04", "05", "06"]);
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
      Arr.map(entries, (entry) => ({
        title: entry.title,
        wave: entry.wave,
        folded: entry.folded,
        repos: Arr.map(entry.nodes, (node) => [node.title, node.link?.run]),
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
  const flow = mainFlow([node]);
  const selection = { run: "build-run", node: "retry", item: null };
  const sameDay = epochMs("2026-10-23T15:00:00.000Z");
  const info = inspectorOf(flow, selection, sameDay, "UTC")!;
  expect(info.lines).toContain(
    "builder · codex/default (fell back from claude/opus: weekly limit)",
  );
  expect(info.lines).toEqual(
    expect.arrayContaining([
      "Started 09:00",
      "Ended 09:12",
      "Attempt 2 · resumed · 09:04",
      "Answered 09:03 by mk",
    ]),
  );
  expect(inspectorOf(flow, selection, epochMs("2026-10-25T08:00:00.000Z"), "UTC")!.lines).toContain(
    "Started 23 Oct, 09:00",
  );
  expect(inspectorOf(flow, selection, epochMs("2027-01-02T08:00:00.000Z"), "UTC")!.lines).toContain(
    "Started 23 Oct 2026, 09:00",
  );
  expect(inspectorOf(flow, selection, sameDay, "Europe/Copenhagen")!.lines).toContain(
    "Started 11:00",
  );
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

test("the inspector names a Step's purpose and labels its facts in reading order", () => {
  const node = flowNode("assess", {
    title: "Assess",
    state: "done",
    description: "Whether the repository is an application,\nand its merge request's stage jobs.",
    role: "implementer",
    agent: "run-dd26b310-assess-r1",
    ranOn: "codex/default (fell back from claude/opus: weekly limit)",
    started: "2026-10-23T09:00:00.000Z",
    ended: "2026-10-23T09:12:00.000Z",
    attempts: [
      { at: "2026-10-23T09:00:00.000Z", cause: null },
      { at: "2026-10-23T09:04:00.000Z", cause: "resumed" },
      { at: "2026-10-23T09:06:00.000Z", cause: null },
    ],
    questions: [
      {
        name: "go",
        asked: "2026-10-23T09:01:00.000Z",
        answered: "2026-10-23T09:03:00.000Z",
        by: "mk",
      },
      {
        name: "why",
        asked: "2026-10-23T09:07:00.000Z",
        answered: "2026-10-23T09:08:00.000Z",
        by: null,
      },
    ],
  });
  const info = inspectorOf(
    mainFlow([node]),
    { run: "build-run", node: "assess", item: null },
    epochMs("2026-10-23T15:00:00.000Z"),
    "UTC",
  )!;
  expect(info.purpose).toBe(
    "Whether the repository is an application,\nand its merge request's stage jobs.",
  );
  expect(info.facts).toEqual([
    { label: "Role", value: "implementer" },
    { label: "Agent", value: "run-dd26b310-assess-r1" },
    {
      label: "Model",
      value: "codex/default (fell back from claude/opus: weekly limit)",
    },
    { label: "Started", value: "09:00" },
    { label: "Ended", value: "09:12" },
    { label: "Attempt 2", value: "resumed · 09:04" },
    { label: "Attempt 3", value: "retried · 09:06" },
    { label: "Answered", value: "09:03 by mk" },
    { label: "Answered", value: "09:08" },
  ]);
});

test("the inspector leaves out a Step's empty purpose and facts", () => {
  const node = flowNode("merged", {
    kind: "release",
    description: "  ",
    role: null,
  });
  const info = inspectorOf(mainFlow([node]), { run: "build-run", node: "merged", item: null }, 0)!;
  expect(info.purpose).toBeNull();
  expect(info.facts).toEqual([]);
  expect(info.status).toBeNull();
});

test("the inspector leaves out a blank role, agent and model", () => {
  const node = flowNode("merged", { kind: "release", role: "", agent: " ", ranOn: "\t" });
  const info = inspectorOf(mainFlow([node]), { run: "build-run", node: "merged", item: null }, 0)!;
  expect(info.facts).toEqual([]);
});

test("a picked Slice shows its own facts", () => {
  const info = inspectorOf(
    mainFlow(),
    { run: "build-run", node: "build", item: "build@04" },
    epochMs("2026-10-23T09:09:00.000Z"),
    "UTC",
  )!;
  expect(info.facts).toEqual([
    { label: "Role", value: "builder" },
    { label: "Model", value: "codex/default" },
    { label: "Started", value: "09:05" },
  ]);
});

test.each([
  [{ said: "Slice 4 of 6" }, "Slice 4 of 6 · 4 min so far"],
  [{ said: "Still running", wait: "ci" }, "Still running · 4 min so far"],
  [{ said: "4 min" }, "4 min so far"],
  [{ said: "1 h 5 min · 2nd attempt" }, "2nd attempt · 4 min so far"],
  [{ said: "Off the path · under a minute" }, "Off the path · 4 min so far"],
  [{ said: "Longer than usual", long: true }, "4 min so far"],
  [{ said: "Held by mk", started: null }, "Held by mk"],
  [{ said: null, started: null }, null],
] as const)("the inspector's status line for %j is %p", (over, status) => {
  const node = flowNode("work", {
    state: "running",
    started: "2026-10-23T09:05:00.000Z",
    ...over,
  });
  const info = inspectorOf(
    mainFlow([node]),
    { run: "build-run", node: "work", item: null },
    epochMs("2026-10-23T09:09:00.000Z"),
  )!;
  expect(info.status).toBe(status);
});
