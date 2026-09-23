// The taxonomy is the contract: what is sent, how it is titled, and how often.

import { expect, test } from "bun:test";
import { NOTIFICATION_KINDS, notificationTitle, wanted } from "../src/notify";

test("every kind names the repo and the run, and none of them is a bare slug", () => {
  // One herdr session runs several checkouts, so `review-mr-123 needs you` does not
  // say which one.
  for (const kind of NOTIFICATION_KINDS) {
    const title = notificationTitle(kind, "/home/mk/work/collie", "review-mr-2");
    expect(title.startsWith("collie · review-mr-2 ")).toBe(true);
  }
  expect(notificationTitle("run-done", "/home/mk/work/collie/", "review-mr-2")).toBe(
    "collie · review-mr-2 finished",
  );
  expect(notificationTitle("decision-lost", "/x/repo", "s")).toBe("repo · s is asking after all");
});

test("a kind turned off in settings is not sent, and everything else is", () => {
  expect(wanted({}, "run-done")).toBe(true);
  expect(wanted({ "run-done": true }, "run-done")).toBe(true);
  expect(wanted({ "run-done": false }, "run-done")).toBe(false);
  expect(wanted({ "run-done": false }, "needs-you")).toBe(true);
});
