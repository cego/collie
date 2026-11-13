// A failed test is the branch's own when the branch adds or changes its file, or adds a
// string its name holds.

import { expect, test } from "bun:test";
import { ownTests } from "../src/own-tests";

const CHANGE = {
  paths: ["test/new-thing.test.ts", "test/ci-job.test.ts", "test/support/baseline.ts"],
  added: [
    `scenario("a retried pass of the branch's own test is a failed job", () =>`,
    `  const short = "tiny name";`,
  ],
};

test("a test in a file the branch adds or modifies is its own", () => {
  expect(
    ownTests(
      [
        { name: "a new thing works", file: "test/new-thing.test.ts" },
        { name: "an old ci-job behaviour", file: "test/ci-job.test.ts" },
      ],
      CHANGE,
    ),
  ).toEqual([
    { name: "a new thing works", file: "test/new-thing.test.ts" },
    { name: "an old ci-job behaviour", file: "test/ci-job.test.ts" },
  ]);
});

test("a test elsewhere whose name holds a long string the branch adds, CI's suffix and all, is its own", () => {
  const failed = {
    name: "a retried pass of the branch's own test is a failed job [shard 3]",
    file: null,
  };
  expect(ownTests([failed], CHANGE)).toEqual([failed]);
});

test("a test whose name only holds a string shorter than 16 characters, or that the branch does not touch, is not its own", () => {
  expect(
    ownTests(
      [
        { name: "the tiny name test", file: "test/other.test.ts" },
        { name: "an untouched test fails", file: "test/untouched.test.ts" },
        { name: "an unpaired test fails", file: null },
      ],
      CHANGE,
    ),
  ).toEqual([]);
});
