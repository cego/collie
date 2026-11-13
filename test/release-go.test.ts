// The go a human's Release gives a Release Run, and when it still holds.

import { expect, test } from "bun:test";
import { givenAt, holdsFor } from "../workflows/release-go";

const ready = (head: string, approvers: ReadonlyArray<string>) =>
  ({ _tag: "Ready", head, approvers }) as const;

test("the go keeps who had approved while the merge request still waits on its pipeline", () => {
  expect(
    givenAt("abc", { _tag: "Waiting", why: ["the pipeline at abc"], approvers: ["alice"] }),
  ).toEqual({ head: "abc", approvers: ["alice"] });
  expect(
    givenAt("abc", { _tag: "Unanswered", head: "abc", comments: [], approvers: ["bob"] }),
  ).toEqual({ head: "abc", approvers: ["bob"] });
  expect(givenAt("abc", ready("abc", ["carol"]))).toEqual({ head: "abc", approvers: ["carol"] });
});

test("a standing that names nobody, or none at all, gives a go with no approvers", () => {
  expect(givenAt("abc", { _tag: "Waiting", why: ["the approval (none yet)"] })).toEqual({
    head: "abc",
    approvers: [],
  });
  expect(givenAt("abc", null)).toEqual({ head: "abc", approvers: [] });
});

test("the go holds at its head while every approver of it still approves, whoever joined since", () => {
  const go = { head: "abc", approvers: ["alice"] };
  expect(holdsFor(go, ready("abc", ["alice"]))).toBe(true);
  expect(holdsFor(go, ready("abc", ["alice", "bob"]))).toBe(true);
});

test("the go no longer holds once its head moved or an approver of it is gone", () => {
  const go = { head: "abc", approvers: ["alice"] };
  expect(holdsFor(go, ready("def", ["alice"]))).toBe(false);
  expect(holdsFor(go, ready("abc", ["bob"]))).toBe(false);
});
