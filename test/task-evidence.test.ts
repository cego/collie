import { expect, test } from "bun:test";
import type { Verification } from "../src/verify";
import { ticketsInSpec } from "../src/task-spec";
import { ticketEvidence } from "../src/task-context";
import { FIRST_SPEC } from "./task-context.fixture";

const spec = {
  task: "task-1",
  revision: 1,
  at: "2026-09-01T00:00:00.000Z",
  actor: "human",
  rationale: null,
  text: FIRST_SPEC,
  tickets: ticketsInSpec(FIRST_SPEC),
  source: null,
  digest: "d1",
};

const criterion = "A second refund of one order refunds once.";

const passed = (name: string, head: string) => {
  const returned: Verification = {
    id: `v-${name}`,
    run: "r1",
    name,
    executable: "/usr/bin/true",
    argv: [],
    cwd: "/project",
    start: { head_sha: head, fingerprint: "f" },
    end: { head_sha: head, fingerprint: "f" },
    exit: 0,
    seconds: 1,
    expect: "pass",
    tail: { stdout: "", stderr: "" },
    result: "pass",
    at: "2026-09-02T00:00:00.000Z",
    by: "collie",
  };
  return returned;
};

const entry = (over: { readonly verification?: Verification | undefined } = {}) => ({
  run: "r1",
  revision: 1,
  head: "abc123",
  answers: [{ criterion, met: "met: check" }],
  verifications: over.verification === undefined ? [] : [over.verification],
});

test("a builder's claim with no Verification at the revision it names stays unproved in the ticket view", () => {
  const shown = ticketEvidence(spec, [entry()]);
  const one = shown[0]?.criteria[0];
  expect(one?.claimed).toBe("met: check");
  expect(one?.proofs).toEqual([]);
  expect(one?.unproved).toBe(true);
  expect(shown[0]?.afterMerge).toEqual(["Observe a duplicate refund on a canary account."]);
});

test("a source-linked proof at the recorded revision changes the evidence the ticket shows", () => {
  const shown = ticketEvidence(spec, [entry({ verification: passed("check", "abc123") })]);
  const one = shown[0]?.criteria[0];
  expect(one?.proofs).toEqual([{ run: "r1", verification: "v-check" }]);
  expect(one?.unproved).toBe(false);
});

test("a Verification passing at another head does not prove the criterion at this revision", () => {
  const shown = ticketEvidence(spec, [entry({ verification: passed("check", "def456") })]);
  expect(shown[0]?.criteria[0]?.proofs).toEqual([]);
  expect(shown[0]?.criteria[0]?.unproved).toBe(true);
});

test("a Run admitted at another revision is not evidence of this revision's tickets", () => {
  const shown = ticketEvidence(spec, [
    { ...entry({ verification: passed("check", "abc123") }), revision: 2 },
  ]);
  expect(shown[0]?.criteria[0]?.claimed).toBeNull();
  expect(shown[0]?.criteria[0]?.unproved).toBe(true);
});
