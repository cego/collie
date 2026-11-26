import { expect, test } from "bun:test";
import { Result } from "effect";
import { isoOf, nextOccurrence, onWake, parseSchedule } from "../src/schedule-model";
import { epochMs } from "../src/time";

const cron = (expression: string, tz = "UTC") =>
  Result.getOrThrow(parseSchedule(expression, tz, { seconds: false }));

const at = epochMs;
const daily = cron("0 7 * * *");
const active = { paused: false, epoch: "add-1" };

test.each([
  ["removed", null, "add-1", { _tag: "end", why: "removed" }],
  ["paused", { paused: true, epoch: "add-1" }, "add-1", { _tag: "end", why: "paused" }],
  [
    "resumed under another epoch",
    { paused: false, epoch: "resume-2" },
    "add-1",
    {
      _tag: "end",
      why: "superseded",
    },
  ],
] as const)(
  "a %s Schedule ends its waking occurrence without a start",
  (_, schedule, epoch, want) => {
    expect(
      onWake({
        cron: daily,
        schedule,
        epoch,
        occurrence: at("2026-10-12T07:00:00Z"),
        now: at("2026-10-12T07:00:01Z"),
      }),
    ).toEqual(want);
  },
);

test.each([
  ["on time", "2026-10-12T07:00:00.200Z", "2026-10-12T07:00:00.000Z"],
  [
    "three days late, after the Machine was off",
    "2026-10-15T09:30:00Z",
    "2026-10-15T07:00:00.000Z",
  ],
  ["late, before that day's occurrence", "2026-10-15T06:59:00Z", "2026-10-14T07:00:00.000Z"],
])("a clock delivered %s starts only the latest occurrence due", (_, now, starts) => {
  const woke = onWake({
    cron: daily,
    schedule: active,
    epoch: "add-1",
    occurrence: at("2026-10-12T07:00:00Z"),
    now: at(now),
  });
  expect(woke._tag === "start" && isoOf(woke.occurrence)).toBe(starts);
});

test.each([
  [
    "an occurrence fell while the Run was going, so it starts at once",
    "2026-10-13T08:15:00Z",
    "2026-10-13T07:00:00.000Z",
  ],
  ["several fell, and only the latest starts", "2026-10-16T08:15:00Z", "2026-10-16T07:00:00.000Z"],
  ["none fell, so the next cron time", "2026-10-12T09:00:00Z", "2026-10-13T07:00:00.000Z"],
  [
    "the Run ended just before the next one, which is waited for",
    "2026-10-13T06:59:59Z",
    "2026-10-13T07:00:00.000Z",
  ],
])("after an occurrence: %s", (_, now, next) => {
  expect(isoOf(nextOccurrence(daily, at("2026-10-12T07:00:00Z"), at(now)))).toBe(next);
});

test("a resume never catches up: its first occurrence is the next cron time after now", () => {
  expect(nextOccurrence(daily, at("2026-10-16T08:00:00Z"), at("2026-10-16T08:00:00Z"))).toEqual(
    at("2026-10-17T07:00:00Z"),
  );
});

test("07:00 in a time zone stays 07:00 there across a change of daylight saving time", () => {
  const copenhagen = cron("0 7 * * *", "Europe/Copenhagen");
  const before = nextOccurrence(copenhagen, at("2026-10-24T05:00:00Z"), at("2026-10-24T05:00:00Z"));
  expect(before).toEqual(at("2026-10-25T06:00:00Z"));
  const late = onWake({
    cron: copenhagen,
    schedule: active,
    epoch: "add-1",
    occurrence: at("2026-10-24T05:00:00Z"),
    now: at("2026-10-26T12:00:00Z"),
  });
  expect(late._tag === "start" && late.occurrence).toEqual(at("2026-10-26T06:00:00Z"));
});

test.each([
  ["six fields where minutes are the resolution", "*/5 * * * * *", "UTC"],
  ["a field out of range", "61 * * * *", "UTC"],
  ["a time zone nobody has", "0 7 * * *", "Mars/Olympus"],
])("refuses %s", (_, expression, tz) => {
  expect(Result.isFailure(parseSchedule(expression, tz, { seconds: false }))).toBe(true);
});

test("a host told seconds are allowed takes a sixth field", () => {
  expect(Result.isSuccess(parseSchedule("*/5 * * * * *", "UTC", { seconds: true }))).toBe(true);
});
