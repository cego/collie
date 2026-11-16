// A wait nobody has to repair anything for, and when it has gone on too long to stay one.

import { expect, test } from "bun:test";
import { awaitingLine, overdueLine } from "../src/awaiting";
import { epochMs } from "../src/time";

const since = "2026-10-21T10:00:00.000Z";
const at = epochMs;

test("a wait says what it is waiting for", () => {
  expect(awaitingLine({ on: "CI on group/app!3", who: null, since })).toBe(
    "Waiting for CI on group/app!3.",
  );
});

test("a wait on nobody is overdue past two hours", () => {
  const wait = { on: "CI on group/app!3", who: null, since };
  expect(overdueLine(wait, at("2026-10-21T11:59:00.000Z"))).toBeNull();
  expect(overdueLine(wait, at("2026-10-21T12:01:00.000Z"))).toBe(
    "Waiting for CI on group/app!3 for over 2 hours, which is longer than it should take. See what holds it up.",
  );
});

test("a wait on a person is overdue past two days", () => {
  const wait = { on: "a teammate's approval on group/app!3", who: "a teammate", since };
  expect(overdueLine(wait, at("2026-10-23T09:00:00.000Z"))).toBeNull();
  expect(overdueLine(wait, at("2026-10-23T10:01:00.000Z"))).toBe(
    "Waiting for a teammate's approval on group/app!3 for over 2 days, which is longer than it should take. See what holds it up.",
  );
});

test("a wait on the author to change their merge request is never overdue", () => {
  const wait = { on: "the author to change group/app!3", who: "the author", since };
  expect(overdueLine(wait, at("2026-12-21T10:00:00.000Z"))).toBeNull();
});
