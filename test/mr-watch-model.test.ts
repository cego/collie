import { expect, test } from "bun:test";
import { epochMs } from "../src/time";
import {
  collieRunOf,
  judge,
  type MrReading,
  type Observed,
  type WatchCursor,
} from "../src/mr-watch-model";

const H1 = "1111111111111111111111111111111111111111";
const H2 = "2222222222222222222222222222222222222222";
const MIN = 60_000;
const T0 = epochMs("2026-11-11T10:00:00Z");

const cursor: WatchCursor = { head: H1, seen: ["10"], pipeline: "passed" };
const reading = (over: Partial<MrReading> = {}): MrReading => ({
  state: "open",
  head: H1,
  pipeline: "passed",
  comments: [{ id: "10", body: "Please rename it." }],
  ...over,
});
const stood = (head: string, since: number, running: number | null = null): Observed => ({
  head,
  since,
  running,
});

test("the same head with only Collie-signed notes added is no change", () => {
  const signed = reading({
    comments: [
      { id: "10", body: "Please rename it." },
      {
        id: "11",
        body: `Review at ${H1}\n\nAll fixed.\n\nReview by Collie for @mk · run-1 round 2 at ${H1}`,
      },
      {
        id: "12",
        body: "Fixed in `1111111`.\n\nPosted by Collie's Run run-9 on vm-mk.",
      },
    ],
  });
  expect(judge({ cursor, observed: stood(H1, T0), reading: signed, now: T0 }).verdict).toEqual({
    _tag: "NoChange",
  });
});

test("a note by anyone else on the same head is a change, at once", () => {
  const replied = reading({
    comments: [
      { id: "10", body: "Please rename it." },
      { id: "13", body: "I disagree: Collie for @mk said so, but the name is fine." },
    ],
  });
  expect(judge({ cursor, observed: stood(H1, T0), reading: replied, now: T0 }).verdict).toEqual({
    _tag: "Changed",
    change: {
      head: H1,
      previous: H1,
      newHead: false,
      comments: ["13"],
      pipeline: null,
      forcePush: false,
    },
  });
});

test("a note signed by another Run's Collie is a change to this Run, and names its Run", () => {
  const replied = reading({
    comments: [
      { id: "10", body: "Please rename it." },
      { id: "11", body: "F1: noted.\n\nPosted by Collie's Run run-1 on vm-mk." },
      { id: "12", body: "F1: Fixed in `1111111`.\n\nPosted by Collie's Run run-9 on vm-ann." },
    ],
  });
  const verdict = judge({
    cursor,
    observed: stood(H1, T0),
    reading: replied,
    now: T0,
    run: "run-1",
  }).verdict;
  expect(verdict._tag === "Changed" && verdict.change.comments).toEqual(["12"]);
  expect(Array.from(replied.comments, (one) => collieRunOf(one.body))).toEqual([
    null,
    "run-1",
    "run-9",
  ]);
});

test("a head-only cursor sees neither comments nor a pipeline ending, only a new head", () => {
  const waiting = { ...cursor, pipeline: "running", headOnly: true };
  const replied = reading({ comments: [{ id: "13", body: "F1: please reconsider." }] });
  expect(
    judge({ cursor: waiting, observed: stood(H1, T0), reading: replied, now: T0 }).verdict,
  ).toEqual({ _tag: "NoChange" });
  const pushed = reading({ head: H2 });
  expect(
    judge({ cursor: waiting, observed: stood(H2, T0), reading: pushed, now: T0 + 5 * MIN }).verdict
      ._tag,
  ).toBe("Changed");
});

test("a new head younger than 5 minutes is not yet, and a change once it has stood 5 minutes", () => {
  const pushed = reading({ head: H2 });
  const first = judge({ cursor, observed: stood(H1, T0), reading: pushed, now: T0 + MIN });
  expect(first.verdict).toEqual({ _tag: "NotYet", until: T0 + 6 * MIN });
  expect(first.observed).toEqual(stood(H2, T0 + MIN));
  const later = judge({
    cursor,
    observed: first.observed,
    reading: pushed,
    now: T0 + 5 * MIN,
  });
  expect(later.verdict._tag).toBe("NotYet");
  const quiet = judge({
    cursor,
    observed: first.observed,
    reading: pushed,
    now: T0 + 6 * MIN,
    descends: true,
  });
  expect(quiet.verdict).toEqual({
    _tag: "Changed",
    change: {
      head: H2,
      previous: H1,
      newHead: true,
      comments: [],
      pipeline: "passed",
      forcePush: false,
    },
  });
});

test("a head pushed again within the quiet period starts it again", () => {
  const H3 = "3333333333333333333333333333333333333333";
  const again = judge({
    cursor,
    observed: stood(H2, T0),
    reading: reading({ head: H3 }),
    now: T0 + 4 * MIN,
  });
  expect(again.verdict).toEqual({ _tag: "NotYet", until: T0 + 9 * MIN });
});

test("a running pipeline is not yet until it ends, or until 30 minutes have passed", () => {
  const running = reading({ head: H2, pipeline: "running" });
  const seen = judge({ cursor, observed: stood(H1, T0), reading: running, now: T0 });
  expect(seen.observed).toEqual(stood(H2, T0, T0));
  const quiet = judge({ cursor, observed: seen.observed, reading: running, now: T0 + 10 * MIN });
  expect(quiet.verdict).toEqual({ _tag: "NotYet", until: T0 + 30 * MIN });
  const ended = judge({
    cursor,
    observed: quiet.observed,
    reading: reading({ head: H2, pipeline: "failed" }),
    now: T0 + 12 * MIN,
  });
  expect(ended.verdict._tag).toBe("Changed");
  expect(ended.verdict._tag === "Changed" && ended.verdict.change.pipeline).toBe("failed");
  const capped = judge({ cursor, observed: quiet.observed, reading: running, now: T0 + 30 * MIN });
  expect(capped.verdict._tag).toBe("Changed");
  expect(capped.verdict._tag === "Changed" && capped.verdict.change.pipeline).toBeNull();
});

test("the head's pipeline reaching a terminal state is a change", () => {
  const waiting = { ...cursor, pipeline: "running" };
  expect(
    judge({
      cursor: waiting,
      observed: stood(H1, T0, T0),
      reading: reading({ pipeline: "running" }),
      now: T0 + 40 * MIN,
    }).verdict,
  ).toEqual({ _tag: "NoChange" });
  expect(
    judge({
      cursor: waiting,
      observed: stood(H1, T0, T0),
      reading: reading({ pipeline: "passed" }),
      now: T0 + 40 * MIN,
    }).verdict,
  ).toEqual({
    _tag: "Changed",
    change: {
      head: H1,
      previous: H1,
      newHead: false,
      comments: [],
      pipeline: "passed",
      forcePush: false,
    },
  });
});

test("a new head that does not descend from the cursor's head is a force push; unread, it is unknown", () => {
  const pushed = {
    cursor,
    observed: stood(H2, T0),
    reading: reading({ head: H2 }),
    now: T0 + 5 * MIN,
  };
  const forced = judge({ ...pushed, descends: false }).verdict;
  expect(forced._tag === "Changed" && forced.change.forcePush).toBe(true);
  const unread = judge(pushed).verdict;
  expect(unread._tag === "Changed" && unread.change.forcePush).toBeNull();
});

test("a merged or closed merge request is ended, whatever else changed", () => {
  for (const state of ["merged", "closed"] as const)
    expect(
      judge({ cursor, observed: null, reading: reading({ state, head: H2 }), now: T0 }).verdict,
    ).toEqual({ _tag: "Ended", state });
});
