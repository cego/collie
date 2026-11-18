// What self-improve measures of the questions its window's Runs asked.

import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import { expect, test } from "bun:test";
import {
  commentOf,
  namedIn,
  questionMeasures,
  releasedFix,
  repeatedAnswers,
  sortOut,
  summaryOf,
  type AskingRun,
  type Finding,
} from "../workflows/retrospective";

const asking = (over: Partial<AskingRun> & { runId: string }): AskingRun => ({
  workflow: "implement",
  status: "complete",
  mr: null,
  merged: false,
  questions: [],
  ...over,
});

const asked = (name: string, answer: string | null) => ({ name, answer });

test("a retrospective saved without question measures reports them as unrecorded, not zero", () => {
  const summary = summaryOf({
    runId: "r-before-measures",
    since: "2026-11-10T19:00:00.000Z",
    questions: undefined,
    acted: [],
    improvements: [],
    leftOut: [],
  });
  expect(summary).toContain("Question measures were not recorded for this retrospective window.");
  expect(summary).not.toContain("0 questions asked");
  expect(summary).not.toContain("0 of 0");
});

test("questions per landed merge request count every question over the distinct merge requests that merged", () => {
  const measures = questionMeasures([
    asking({ runId: "a", mr: "https://mr/1", merged: true, questions: [asked("next", "Finish")] }),
    asking({
      runId: "b",
      workflow: "release",
      mr: "https://mr/1",
      merged: true,
      questions: [asked("go-1", "Merge"), asked("go-2", null)],
    }),
    asking({ runId: "c", mr: "https://mr/2", merged: true }),
    asking({ runId: "d", workflow: "plan", questions: [asked("approve", "Build it")] }),
    asking({ runId: "e", mr: "https://mr/3" }),
  ]);
  expect(measures.asked).toBe(4);
  expect(measures.landed).toBe(2);
  expect(measures.perLanded).toBe(2);
});

test("with nothing landed there is no per merge request figure, rather than a division by zero", () => {
  expect(questionMeasures([asking({ runId: "a", questions: [asked("next", "x")] })])).toMatchObject(
    {
      asked: 1,
      landed: 0,
      perLanded: null,
    },
  );
});

test("an implement Run reached its merge request when it recorded one and did not fail; one still going without one is not counted", () => {
  const measures = questionMeasures([
    asking({ runId: "reached", mr: "https://mr/1" }),
    asking({ runId: "waiting-at-mr", status: "suspended", mr: "https://mr/2" }),
    asking({ runId: "failed-after", status: "failed", mr: "https://mr/3" }),
    asking({ runId: "failed-before", status: "failed" }),
    asking({ runId: "ended-without", status: "complete" }),
    asking({ runId: "still-building", status: "pending" }),
    asking({ runId: "plan", workflow: "plan", mr: "https://mr/4" }),
  ]);
  expect(measures.implement).toEqual({ reached: 2, of: 5 });
});

const answers = (workflow: string, name: string, list: ReadonlyArray<string | null>) =>
  Arr.map(list, (answer, index) =>
    asking({ runId: `${workflow}-${name}-${index}`, workflow, questions: [asked(name, answer)] }),
  );

test("a question class answered the same at least nine times in ten over ten askings is a finding about Collie", () => {
  const runs = answers("implement", "next", [...Arr.replicate("Release", 9), "Finish"]);
  const [finding, ...rest] = repeatedAnswers(runs);
  expect(rest).toEqual([]);
  expect(finding).toMatchObject({
    key: "repeated-answer-implement-next",
    category: "defect",
    issue: null,
    records: [],
  });
  expect(finding?.runs).toEqual(Arr.map(runs, ({ runId }) => runId));
  expect(finding?.title).toContain('"Release"');
  expect(finding?.body).toContain("9 of 10");
});

test("numbered askings of one question are one class, wherever in the Run they were asked", () => {
  const runs = Arr.map(Arr.range(0, 9), (index) =>
    asking({
      runId: `r${index}`,
      workflow: "release",
      questions: [asked(index % 2 === 0 ? `go-${index}` : `slice-0${index}.go-1`, "Merge")],
    }),
  );
  expect(Arr.map(repeatedAnswers(runs), ({ key }) => key)).toEqual(["repeated-answer-release-go"]);
});

test("under either threshold, or with the same name in another workflow, there is no finding", () => {
  expect(repeatedAnswers(answers("implement", "next", Arr.replicate("Release", 9)))).toEqual([]);
  expect(
    repeatedAnswers(
      answers("implement", "next", [...Arr.replicate("Release", 8), "Finish", "Finish"]),
    ),
  ).toEqual([]);
  expect(
    repeatedAnswers([
      ...answers("implement", "next", Arr.replicate("Release", 5)),
      ...answers("plan", "next", Arr.replicate("Release", 5)),
    ]),
  ).toEqual([]);
});

test("a question still open is not an answer, so it counts toward neither threshold", () => {
  expect(
    repeatedAnswers(answers("implement", "next", [...Arr.replicate("Release", 9), null, null])),
  ).toEqual([]);
});

const found = (over: Partial<Finding> & Pick<Finding, "key">): Finding => ({
  category: "navigation",
  title: `Project ${over.key}`,
  body: `What the Runs did: ${over.key}.`,
  severity: "high",
  runs: ["r-a", "r-b"],
  records: [],
  issue: null,
  ...over,
});

const WINDOW = new Set(["r-a", "r-b", "r-c"]);
const TAGS = [
  { tag: "1.0.21", at: "2026-11-17T12:00:00.000Z" },
  { tag: "1.0.20", at: "2026-11-10T12:00:00.000Z" },
];
const closedIssue = (number: number, key: string, closedAt: string) => ({
  number,
  title: `Issue ${number}`,
  url: `https://forge.example/issues/${number}`,
  keys: [key],
  closedAt,
});

test("a finding whose issue was closed after the last release tag is left out as fixed but unreleased, and nothing is filed", () => {
  const { kept, leftOut } = sortOut([found({ key: "slow-boot" })], WINDOW, [], false, {
    closed: [closedIssue(7, "slow-boot", "2026-11-17T15:00:00.000Z")],
    releases: TAGS,
    underway: [],
  });
  expect(kept).toEqual([]);
  expect(leftOut).toEqual([
    { what: "Project slow-boot", why: "fixed on master since 1.0.21, not yet released" },
  ]);
});

test("Runs created after an unreleased fix that still show the failure leave it out the same way, with no comment on the closed issue", () => {
  const runs = { "r-a": "2026-11-17T16:00:00.000Z", "r-b": "2026-11-17T17:00:00.000Z" };
  const matching = {
    closed: [closedIssue(7, "slow-boot", "2026-11-17T15:00:00.000Z")],
    releases: TAGS,
    underway: [],
  };
  const { kept, leftOut } = sortOut(
    [found({ key: "slow-boot", issue: 7 })],
    WINDOW,
    [],
    false,
    matching,
  );
  expect(kept).toEqual([]);
  expect(leftOut[0]?.why).toBe("fixed on master since 1.0.21, not yet released");
  expect(releasedFix(found({ key: "slow-boot", issue: 7 }), matching, runs)).toBeNull();
});

test("a finding on an issue closed since the last tag is left out even where an open issue also carries its key, so nothing is commented there", () => {
  const { kept, leftOut } = sortOut(
    [found({ key: "slow-boot" })],
    WINDOW,
    [{ number: 9, title: "Issue 9", url: "https://forge.example/issues/9", keys: ["slow-boot"] }],
    false,
    {
      closed: [closedIssue(5, "slow-boot", "2026-11-17T15:00:00.000Z")],
      releases: TAGS,
      underway: [],
    },
  );
  expect(kept).toEqual([]);
  expect(leftOut).toEqual([
    { what: "Project slow-boot", why: "fixed on master since 1.0.21, not yet released" },
  ]);
});

test("a finding an active Run's goal or plan names, and one an open merge request carries, are left out naming who is fixing it", () => {
  const { kept, leftOut } = sortOut(
    [
      found({ key: "slow-boot" }),
      found({ key: "lost-log", issue: 12 }),
      found({ key: "flaky-ci" }),
    ],
    WINDOW,
    [],
    false,
    {
      closed: [],
      releases: TAGS,
      underway: [
        { by: "run-1234", keys: ["slow-boot"], issues: [] },
        { by: "run-5678", keys: [], issues: [12] },
        { by: "https://forge.example/mr/3", keys: ["flaky-ci"], issues: [] },
      ],
    },
  );
  expect(kept).toEqual([]);
  expect(leftOut).toEqual([
    { what: "Project slow-boot", why: "being fixed by run-1234" },
    { what: "Project lost-log", why: "being fixed by run-5678" },
    { what: "Project flaky-ci", why: "being fixed by https://forge.example/mr/3" },
  ]);
});

test("a goal or plan names a key as a word, or an issue by its number", () => {
  expect(namedIn("Fix slow-boot and #12 today", ["slow-boot", "slow", "boot-x"], [12, 1])).toEqual({
    keys: ["slow-boot"],
    issues: [12],
  });
  expect(namedIn("see slow-booting and #120", ["slow-boot"], [12])).toEqual({
    keys: [],
    issues: [],
  });
});

test("a fix released mid-window records its key's occurrences per Run before and after the release, in the report and the issue's comment", () => {
  const before = Arr.map(
    Arr.range(1, 10),
    (n) => [`b${n}`, `2026-11-17T0${n % 10}:00:00.000Z`] as const,
  );
  const after = Arr.map(
    Arr.range(1, 10),
    (n) => [`a${n}`, `2026-11-17T${12 + (n % 10)}:30:00.000Z`] as const,
  );
  const created = Rec.fromEntries([...before, ...after]);
  const finding = found({ key: "slow-boot", runs: ["b1", "b2", "b3", "b4", "a1"] });
  const fixed = closedIssue(7, "slow-boot", "2026-11-17T10:00:00.000Z");
  const matching = { closed: [fixed], releases: TAGS, underway: [] };
  const window = new Set(Rec.keys(created));
  const { kept } = sortOut([finding], window, [], false, matching);
  expect(Arr.map(kept, ({ key }) => key)).toEqual(["slow-boot"]);
  const fix = releasedFix(finding, matching, created);
  expect(fix).toEqual({
    issue: fixed,
    effect: {
      key: "slow-boot",
      release: "1.0.21",
      before: { seen: 4, of: 10 },
      after: { seen: 1, of: 10 },
    },
  });
  const line = "slow-boot: 4/10 Runs before 1.0.21, 1/10 after";
  expect(
    commentOf({ finding, runId: "r-day", machine: "m", effect: fix?.effect ?? null }),
  ).toContain(line);
  const summary = summaryOf({
    runId: "r-day",
    since: "2026-11-17T00:00:00.000Z",
    questions: undefined,
    acted: [
      { finding, outcome: { kind: "commented", number: 7, url: "https://forge.example/issues/7" } },
    ],
    improvements: [],
    leftOut: [],
    effects: fix === null ? [] : [fix.effect],
  });
  expect(summary).toContain(line);
});

test("a key whose fix is not released records no figures", () => {
  const matching = {
    closed: [closedIssue(7, "slow-boot", "2026-11-17T15:00:00.000Z")],
    releases: TAGS,
    underway: [],
  };
  expect(
    releasedFix(found({ key: "slow-boot" }), matching, { "r-a": "2026-11-17T16:00:00.000Z" }),
  ).toBeNull();
  expect(
    commentOf({ finding: found({ key: "slow-boot" }), runId: "r-day", machine: "m", effect: null }),
  ).not.toContain("Runs before");
});
