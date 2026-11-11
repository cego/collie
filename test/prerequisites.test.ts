// Whether the Changes a ticket needs merged have landed, judged from what the host gathered.

import { expect, test } from "bun:test";
import { judgePrerequisites, type MrLanding, type RunDetail } from "../src/prerequisites";

const MR = "https://gitlab.example.com/group/app/-/merge_requests/7";
const OTHER_MR = "https://gitlab.example.com/group/app/-/merge_requests/9";

const rows = [
  { run: "run-plan", parent: null },
  { run: "run-plan.implement", parent: "run-plan" },
  { run: "run-other", parent: null },
  { run: "run-other.implement", parent: "run-other" },
  { run: "run-third", parent: null },
];

const detail = (over: Partial<RunDetail> = {}): RunDetail => ({
  repo: ".",
  change: null,
  ended: false,
  mr: null,
  ...over,
});

const judged = (
  needs: ReadonlyArray<{ run: string; change: string | null }>,
  details: ReadonlyArray<readonly [string, RunDetail]>,
  landings: ReadonlyArray<readonly [string, MrLanding]> = [],
) =>
  judgePrerequisites({
    asking: { run: "run-plan.implement", repo: "." },
    prerequisites: needs,
    rows,
    details: new Map(details),
    landings: new Map(landings),
  });

test("a Run this host does not know can never land", () => {
  expect(judged([{ run: "run-gone", change: "card" }], [])).toEqual({
    _tag: "Never",
    why: "run-gone is not a Run on this host, so its card cannot be waited on",
  });
});

test("this Run or one of its ancestors can never land before it", () => {
  for (const run of ["run-plan.implement", "run-plan"])
    expect(judged([{ run, change: null }], [[run, detail()]])).toEqual({
      _tag: "Never",
      why: `${run} is this Run or one it came out of, so its Change cannot be waited on: name a ticket of this plan on **Blocked by:** instead`,
    });
});

test("no merge request yet while the named Run goes on is waiting", () => {
  expect(
    judged(
      [{ run: "run-other", change: null }],
      [
        ["run-other", detail()],
        ["run-other.implement", detail()],
      ],
    )._tag,
  ).toBe("Waiting");
});

test("an ended Run with no merge request for the Change can never land", () => {
  expect(
    judged(
      [{ run: "run-other", change: "card" }],
      [
        ["run-other", detail({ ended: true })],
        ["run-other.implement", detail({ ended: true, mr: OTHER_MR })],
      ],
    ),
  ).toEqual({
    _tag: "Never",
    why: "run-other ended with no merge request for its card, so it can never land",
  });
});

test("a merge request closed without merging can never land", () => {
  expect(
    judged(
      [{ run: "run-other", change: "card" }],
      [
        ["run-other", detail()],
        ["run-other.implement", detail({ change: "card", mr: MR })],
      ],
      [[MR, { _tag: "Closed" }]],
    ),
  ).toEqual({
    _tag: "Never",
    why: "group/app!7, run-other's card, was closed without merging, so it can never land",
  });
});

test("merged but not on the default branch is still waiting; on it, landed", () => {
  const needs = [{ run: "run-other", change: null }];
  const details = [
    ["run-other", detail()],
    ["run-other.implement", detail({ mr: MR })],
  ] as const;
  expect(judged(needs, details, [[MR, { _tag: "Merged", onDefault: false }]])._tag).toBe("Waiting");
  expect(judged(needs, details, [[MR, { _tag: "Merged", onDefault: true }]])).toEqual({
    _tag: "Landed",
  });
});

test("a candidate is the named Run or a descendant in the asking Run's repository and Change", () => {
  const needs = [{ run: "run-other", change: "card" }];
  expect(
    judged(
      needs,
      [
        ["run-other", detail({ change: "card", repo: "api", mr: OTHER_MR })],
        ["run-other.implement", detail({ change: "card", mr: MR })],
      ],
      [
        [OTHER_MR, { _tag: "Closed" }],
        [MR, { _tag: "Merged", onDefault: true }],
      ],
    ),
  ).toEqual({ _tag: "Landed" });
});

test("a ticket is Never before Waiting before Landed, and Landed when it names nothing", () => {
  const details = [
    ["run-other", detail()],
    ["run-other.implement", detail({ mr: MR })],
    ["run-third", detail()],
  ] as const;
  const landed = [[MR, { _tag: "Merged", onDefault: true }]] as const;
  expect(judged([], [])).toEqual({ _tag: "Landed" });
  expect(judged([{ run: "run-other", change: null }], details, landed)).toEqual({
    _tag: "Landed",
  });
  expect(
    judged(
      [
        { run: "run-other", change: null },
        { run: "run-third", change: null },
      ],
      details,
      landed,
    )._tag,
  ).toBe("Waiting");
  expect(
    judged(
      [
        { run: "run-third", change: null },
        { run: "run-gone", change: null },
        { run: "run-other", change: null },
      ],
      details,
      landed,
    ),
  ).toEqual({
    _tag: "Never",
    why: "run-gone is not a Run on this host, so its Change cannot be waited on",
  });
});

test("the Awaiting line names each Change still waiting, and who is the first merge request", () => {
  const waiting = (
    needs: ReadonlyArray<{ run: string; change: string | null }>,
    details: ReadonlyArray<readonly [string, RunDetail]>,
  ) => judged(needs, details, [[MR, { _tag: "Open" }]]);
  expect(
    waiting([{ run: "run-other", change: "card" }], [["run-other", detail({ change: "card" })]]),
  ).toEqual({ _tag: "Waiting", on: "run-other's card to merge", who: "run-other" });
  expect(waiting([{ run: "run-other", change: null }], [["run-other", detail()]])).toEqual({
    _tag: "Waiting",
    on: "run-other's Change to merge",
    who: "run-other",
  });
  expect(
    waiting(
      [
        { run: "run-third", change: null },
        { run: "run-other", change: "card" },
        { run: "run-other.implement", change: null },
      ],
      [
        ["run-third", detail()],
        ["run-other", detail()],
        ["run-other.implement", detail({ change: "card", mr: MR })],
      ],
    ),
  ).toEqual({
    _tag: "Waiting",
    on: "run-third's Change, run-other's card and run-other.implement's Change to merge",
    who: "group/app!7",
  });
});
