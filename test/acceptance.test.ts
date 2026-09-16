// The acceptance gate's own judgements. All three exist to stop one thing — a promise
// nobody ran being counted as a promise kept — so each is tested where it would be
// generous, not only where it is strict.

import { expect, test } from "bun:test";
import {
  CHECKS,
  acceptanceExitCode,
  classify,
  fromEvidence,
  reaches,
  validateEvidence,
  type Tree,
} from "../tools/acceptance";

const CLEAN: Tree = { revision: "a".repeat(40), dirty: false };

test("unrecorded manual checks are reported, not a mandatory sign-off", () => {
  expect(acceptanceExitCode({ pass: 10, fail: 0, pending: 3 })).toBe(0);
  expect(acceptanceExitCode({ pass: 10, fail: 0, pending: 0 })).toBe(0);
  expect(acceptanceExitCode({ pass: 10, fail: 1, pending: 3 })).toBe(1);
});

test("a test that does not exist yet is pending, not a failure, and never a pass", () => {
  expect(classify(1, 'error: regex "x" matched 0 tests. Searched 1 file')).toBe("pending");
  expect(classify(1, 'note: Tests need ".test", "_test_", ".spec"')).toBe("pending");
  expect(classify(1, 'Test filter "./test/gone.test.ts" had no matches in --cwd="/x"')).toBe(
    "pending",
  );
});

test("a run that passed nothing is pending; one that passed something is a pass", () => {
  expect(classify(0, "Ran 0 tests across 0 files.")).toBe("pending");
  expect(classify(0, " 1 pass\n 0 fail\nRan 1 test across 1 file.")).toBe("pass");
  expect(classify(1, " 0 pass\n 1 fail\nRan 1 test across 1 file.")).toBe("fail");
});

test("a backend proof does not settle a front-door promise", () => {
  const backend = { kind: "test", layer: "backend", file: "f", name: "n" } as const;
  const ui = { kind: "test", layer: "ui", file: "f", name: "n" } as const;
  const operator = { kind: "operator", how: "look" } as const;

  expect(reaches("backend", backend)).toBe(true);
  expect(reaches("ui", backend)).toBe(false);
  // A UI path that works has exercised what it calls, so it reaches down but not sideways.
  expect(reaches("ui", ui)).toBe(true);
  expect(reaches("backend", ui)).toBe(true);
  // Nothing automated stands in for a person at a terminal, and vice versa.
  expect(reaches("operator", ui)).toBe(false);
  expect(reaches("operator", operator)).toBe(true);
  expect(reaches("ui", operator)).toBe(false);
  expect(reaches("backend", { kind: "none" })).toBe(false);
});

test("an operator result counts only against a clean tree at the revision it names", () => {
  const recorded = { result: "pass", revision: "a".repeat(40), by: "mk" };
  expect(fromEvidence(recorded, CLEAN)).toEqual({ state: "pass", note: "recorded by mk" });

  // A dirty tree has no identity: the sha says one thing and the files say another.
  expect(fromEvidence(recorded, { revision: "a".repeat(40), dirty: true }).state).toBe("pending");
  // Neither has one git would not answer for.
  expect(fromEvidence(recorded, { revision: null, dirty: false }).state).toBe("pending");
  expect(fromEvidence(recorded, { revision: "a".repeat(40), dirty: null }).state).toBe("pending");

  expect(fromEvidence(recorded, { revision: "b".repeat(40), dirty: false }).state).toBe("pending");
  expect(fromEvidence(undefined, CLEAN)).toEqual({ state: "pending", note: "not run" });
  expect(fromEvidence({ result: "fail", revision: "a".repeat(40) }, CLEAN).state).toBe("fail");
});

test("evidence that does not say what it means stops the gate rather than being skipped", () => {
  const id = CHECKS.find((check) => check.proof.kind === "operator")!.id;
  expect(validateEvidence({ [id]: { result: "pass", revision: "a".repeat(40) } })).toEqual([]);

  expect(validateEvidence([])).toEqual([
    "the evidence file must be a JSON object keyed by check id",
  ]);
  expect(validateEvidence({ [id]: { result: "yes", revision: "a".repeat(40) } })).toEqual([
    `${id}: "result" must be "pass" or "fail"`,
  ]);
  // A short sha names no tree exactly, so it is refused rather than compared loosely.
  expect(validateEvidence({ [id]: { result: "pass", revision: "abc1234" } })).toEqual([
    `${id}: "revision" must be a full 40-character commit sha`,
  ]);
  expect(
    validateEvidence({ "no/such/check": { result: "pass", revision: "a".repeat(40) } }),
  ).toContain("no/such/check: not a check in this registry");
  expect(validateEvidence({ [id]: { result: "pass", revision: "a".repeat(40), by: 7 } })).toEqual([
    `${id}: "by" must be a string when present`,
  ]);
});

test("every check names an owner, a distinct id, and the layer that can settle it", () => {
  expect(new Set(CHECKS.map((c) => c.id)).size).toBe(CHECKS.length);
  expect(CHECKS.filter((c) => c.owner.trim() === "")).toEqual([]);
  expect(CHECKS.filter((c) => c.statement.trim() === "")).toEqual([]);
  // The rule the registry got wrong first: nothing in front of a person is settled from
  // underneath it.
  expect(
    CHECKS.filter((c) => c.id.startsWith("front-door/") && c.needs === "backend").map((c) => c.id),
  ).toEqual([]);
});
