// What a card's record decides about its Terminal tab.

import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Effect } from "effect";
import {
  agentTabs,
  askedFor,
  atWork,
  offersTerminal,
  opensHerdrForNoPane,
  shownAgent,
  opensHerdrWithoutPane,
  deliveryChoices,
  recipients,
  switches,
} from "../src/shared/record-terminal";

test("the Terminal tab is offered on a reached Machine and kept while shown after it drops", () => {
  expect(offersTerminal(null, undefined)).toBe(true);
  expect(offersTerminal(1_791_000_000_000, "terminal")).toBe(true);
  expect(offersTerminal(1_791_000_000_000, "log")).toBe(false);
});

test("only Go to pane falls back to herdr's own client where there is no pane", () => {
  expect(opensHerdrWithoutPane("terminal")).toBe(true);
  expect(opensHerdrWithoutPane("diff")).toBe(false);
});

const live = (name: string, role: string | undefined, status = "idle", run = "run-1") => {
  const agent = { name, status, now: `${name}'s title`, run };
  return role === undefined ? agent : { ...agent, role };
};

test.each([
  {
    case: "each agent is its role, and a shared role is numbered in the board's order",
    agents: [
      live("plan-1", "planner"),
      live("review-1", "reviewer", "working", "run-1.implement"),
      live("impl-1", "implementer", "blocked", "run-1.implement"),
      live("review-2", "reviewer", "done", "run-1.implement"),
    ],
    shown: null,
    entries: [
      ["plan-1", "run-1", "planner", "idle", false],
      ["review-1", "run-1.implement", "reviewer 1", "working", false],
      ["impl-1", "run-1.implement", "implementer", "blocked", false],
      ["review-2", "run-1.implement", "reviewer 2", "done", false],
    ],
  },
  {
    case: "an agent from an older host, with no role, is its herdr name",
    agents: [live("impl-1", undefined, "unknown"), live("impl-2", undefined)],
    shown: null,
    entries: [
      ["impl-1", "run-1", "impl-1", "unknown", false],
      ["impl-2", "run-1", "impl-2", "idle", false],
    ],
  },
  {
    case: "the agent the host focused is the one marked as shown",
    agents: [live("impl-1", "implementer", "working"), live("review-1", "reviewer")],
    shown: live("review-1", "reviewer"),
    entries: [
      ["impl-1", "run-1", "implementer", "working", false],
      ["review-1", "run-1", "reviewer", "idle", true],
    ],
  },
  {
    case: "the agent shown stays listed, ended, once the board no longer has it",
    agents: [live("impl-1", "implementer", "working"), live("review-1", "reviewer")],
    shown: live("review-2", "reviewer", "working"),
    entries: [
      ["impl-1", "run-1", "implementer", "working", false],
      ["review-1", "run-1", "reviewer 1", "idle", false],
      ["review-2", "run-1", "reviewer 2", "ended", true],
    ],
  },
])("$case", ({ agents, shown, entries }) => {
  expect(
    Arr.map(agentTabs(agents, shown), (one) => [
      one.name,
      one.run,
      one.label,
      one.state,
      one.shown,
    ]),
  ).toEqual(Arr.map(entries, (entry) => [...entry]));
});

test.each([
  {
    case: "a blocked agent is chosen over a working one listed after it",
    agents: [live("plan-1", "planner", "blocked"), live("impl-1", "implementer", "working")],
    chosen: "plan-1",
  },
  {
    case: "a blocked agent is chosen over a working one listed before it",
    agents: [live("impl-1", "implementer", "working"), live("plan-1", "planner", "blocked")],
    chosen: "plan-1",
  },
  {
    case: "another Run's blocked agent is chosen over the card's Run's working one",
    agents: [
      live("impl-1", "implementer", "blocked", "run-2.implement"),
      live("review-1", "reviewer", "working"),
    ],
    chosen: "impl-1",
  },
  {
    case: "a working agent is chosen over idle, done and unknown ones",
    agents: [
      live("plan-1", "planner", "idle"),
      live("impl-1", "implementer", "working", "run-1.implement"),
      live("review-1", "reviewer", "done"),
      live("review-2", "reviewer", "unknown"),
    ],
    chosen: "impl-1",
  },
  {
    case: "among several working, the card's Run's last-listed agent is chosen over another Run's",
    agents: [
      live("review-1", "reviewer", "working"),
      live("review-2", "reviewer", "working"),
      live("impl-1", "implementer", "working", "run-1.implement"),
    ],
    chosen: "review-2",
  },
  {
    case: "with no candidate of the card's Run, the last-listed candidate is chosen",
    agents: [
      live("plan-1", "planner", "idle"),
      live("impl-1", "implementer", "working", "run-1.implement"),
      live("review-1", "reviewer", "working", "run-1.implement"),
    ],
    chosen: "review-1",
  },
  {
    case: "all idle names no agent",
    agents: [live("plan-1", "planner"), live("impl-1", "implementer", "idle", "run-1.implement")],
    chosen: null,
  },
  { case: "no agents names no agent", agents: [], chosen: null },
  {
    case: "an agent from an older host, with no role, is still chosen by its status",
    agents: [live("impl-1", undefined, "idle"), live("impl-2", undefined, "working")],
    chosen: "impl-2",
  },
])("the tab opens on the agent at work: $case", ({ agents, chosen }) => {
  expect(atWork(agents, "run-1")?.name ?? null).toBe(chosen);
});

test("a pick is asked for over the agent at work, which is asked for as its tab, and else none", () => {
  const agents = [live("plan-1", "planner"), live("impl-1", "implementer", "working")];
  const [planner, implementer] = agentTabs(agents, null);
  expect(askedFor(agents, "run-1", planner!)).toEqual(planner!);
  expect(askedFor(agents, "run-1", null)).toEqual(implementer!);
  expect(askedFor([live("plan-1", "planner")], "run-1", null)).toBeNull();
});

test("a Step's agent is asked for exactly, even if it ended before the pane opened", () => {
  const agents = [live("plan-1", "planner"), live("impl-1", "implementer", "working")];
  expect(askedFor(agents, "run-1", null, "plan-1")?.name).toBe("plan-1");
  expect(askedFor(agents, "run-1", null, "ended-builder")).toMatchObject({
    name: "ended-builder",
    run: "run-1",
    state: "ended",
  });
});

test("a pane not found opens herdr's client only for Go to pane before a pick", () => {
  const picked = agentTabs([live("impl-1", "implementer", "working")], null)[0]!;
  expect(opensHerdrForNoPane(true, null)).toBe(true);
  expect(opensHerdrForNoPane(true, picked)).toBe(false);
  expect(opensHerdrForNoPane(false, null)).toBe(false);
});

test("the agent shown is the board's entry for it, kept once it leaves, and none before it arrives", () => {
  const review = live("review-1", "reviewer", "working");
  const later = { ...review, status: "idle" };
  expect(shownAgent([review], "review-1", null)).toEqual(review);
  expect(shownAgent([later], "review-1", review)).toEqual(later);
  expect(shownAgent([], "review-1", later)).toEqual(later);
  expect(shownAgent([], "review-1", null)).toBeNull();
  expect(shownAgent([review], undefined, review)).toBeNull();
});

const switching = (log: string[]) =>
  switches(() => {
    log.push("let go");
    return Effect.runPromise(Effect.sleep("1 millis"));
  });

test("a switch opens only after the pane shown is let go, and only the newest of those waiting", () => {
  const log: string[] = [];
  const tab = switching(log);
  return Effect.runPromise(
    Effect.promise(() =>
      Promise.all([tab.to(() => log.push("review-1")), tab.to(() => log.push("impl-1"))]),
    ).pipe(Effect.map(() => expect(log).toEqual(["let go", "let go", "impl-1"]))),
  );
});

test("a switch still waiting when the tab closes never opens", () => {
  const log: string[] = [];
  const tab = switching(log);
  return Effect.runPromise(
    Effect.promise(() => Promise.all([tab.to(() => log.push("review-1")), tab.stop()])).pipe(
      Effect.map(() => expect(log).toEqual(["let go", "let go"])),
    ),
  );
});

const launched = (...agents: string[]) => Arr.map(agents, (agent) => ({ agent }));

test.each([
  {
    case: "the Run's agents herdr still has, in launch order, newest last",
    launches: launched("plan-1", "review-1", "plan-2"),
    live: [live("plan-1", "planner"), live("plan-2", "planner"), live("other-1", "reviewer")],
    offered: [
      ["plan-1", "planner 1"],
      ["plan-2", "planner 2"],
    ],
  },
  {
    case: "an agent the board lists under another of the Task's Runs is still this Run's",
    launches: launched("plan-1"),
    live: [live("plan-1", "planner", "idle", "run-1.implement")],
    offered: [["plan-1", "planner"]],
  },
  {
    case: "an agent launched again counts at its newest launch",
    launches: launched("plan-1", "review-1", "plan-1"),
    live: [live("plan-1", "planner"), live("review-1", "reviewer")],
    offered: [
      ["review-1", "reviewer"],
      ["plan-1", "planner"],
    ],
  },
  {
    case: "a live agent of the Task the Run never launched is not offered",
    launches: launched("plan-1"),
    live: [live("impl-1", "implementer")],
    offered: [],
  },
  {
    case: "a Run whose details name no agents has none",
    launches: undefined,
    live: [live("impl-1", "implementer")],
    offered: [],
  },
])("$case", ({ launches, live: agents, offered }) => {
  expect(Arr.map(recipients(launches, agents), (one) => [one.name, one.label])).toEqual(
    Arr.map(offered, (entry) => [...entry]),
  );
});

const choicesOf = (protocol: number | null) =>
  Arr.map(
    deliveryChoices(
      launched("build-1", "review-1"),
      [live("build-1", "implementer", "working"), live("review-1", "reviewer")],
      protocol,
    ),
    ({ key, to, agent }) => [key, to ?? agent ?? null],
  );

test.each([3, 4, null])(
  "plan comments prefer the planner even after a second opinion on protocol %p",
  (protocol) => {
    const offered = deliveryChoices(
      launched("plan-1", "review-1"),
      [live("plan-1", "planner"), live("review-1", "reviewer", "working")],
      protocol,
      "planner",
    );
    expect(offered[0]?.to ?? offered[0]?.agent).toBe(protocol === 4 ? "planner" : "plan-1");
    expect(Arr.some(offered, (one) => one.agent === "review-1")).toBe(true);
  },
);

test("review comments go by default to the agent at work, and may name a role the Run has or an agent", () => {
  const offered = [
    ["@work", null],
    ["@builder", "builder"],
    ["@reviewer", "reviewer"],
    ["build-1", "build-1"],
    ["review-1", "review-1"],
  ];
  expect(choicesOf(4)).toEqual(offered);
  expect(choicesOf(5)).toEqual(offered);
  expect(deliveryChoices(launched("gone"), [live("build-1", "implementer")], 4)).toEqual([]);
});

test.each([3, null])(
  "a Machine on protocol %p is offered only the live agents by name, the newest first",
  (protocol) => {
    expect(choicesOf(protocol)).toEqual([
      ["review-1", "review-1"],
      ["build-1", "build-1"],
    ]);
  },
);
