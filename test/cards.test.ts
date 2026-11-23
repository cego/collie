import * as Arr from "effect/Array";
import { Effect, FileSystem, Option } from "effect";
import { expect, test } from "bun:test";
import {
  appendCard,
  cardsPath,
  buildCard,
  finishedOnRecord,
  inspectFor,
  newest,
  readCards,
  readFinalCard,
  readCheckpoints,
  writeCheckpoint,
  readiness,
  significance,
  verificationOn,
  type Card,
  type SignificanceFacts,
} from "../src/cards";
import type { Verification } from "../src/verify";
import { RunRecords } from "../src/run-records";
import { runEffect } from "./support/effect";

const revision = { branch: "feat/picker", head_sha: "abc", fingerprint: "f1", dirty: false };

const facts: (over?: Partial<SignificanceFacts>) => SignificanceFacts = (over = {}) => ({
  readiness: "claimed",
  mrTouched: false,
  pendingChoice: false,
  driftUnresolved: false,
  pendingProposal: false,
  correctionUnacknowledged: false,
  blockingDrift: false,
  correctionSent: false,
  intentChanged: false,
  ended: null,
  ...over,
});

const verification: (over?: Partial<Verification>) => Verification = (over = {}) => ({
  id: "v1",
  run: "r1",
  name: "tests",
  executable: "/usr/bin/true",
  argv: [],
  cwd: "/repo",
  start: { head_sha: "abc", fingerprint: "f1" },
  end: { head_sha: "abc", fingerprint: "f1" },
  exit: 0,
  seconds: 1,
  expect: "pass",
  tail: { stdout: "", stderr: "" },
  result: "pass",
  at: "2026-09-09T10:00:00Z",
  by: "agent",
  ...over,
});

test("readiness never says more than the evidence does", () => {
  expect(readiness({ claimed: true, changed: false, verifiedHere: false })).toBe("claimed");
  expect(readiness({ claimed: true, changed: true, verifiedHere: false })).toBe("inspect-ready");
  expect(readiness({ claimed: true, changed: true, verifiedHere: true })).toBe("verified");
  expect(readiness({ claimed: false, changed: true, verifiedHere: false })).toBe("claimed");
});

test("a verification on other bytes is stale, and one on the same bytes at another commit is a pass for this one", () => {
  expect(verificationOn(verification(), revision).result).toBe("pass");
  // WARNING: A new commit of the same bytes is the same tree, not a stale one.
  expect(
    verificationOn(verification({ end: { head_sha: "def", fingerprint: "f1" } }), revision).result,
  ).toBe("pass");
  expect(
    verificationOn(verification({ end: { head_sha: "abc", fingerprint: "f2" } }), revision).result,
  ).toBe("stale");
  expect(verificationOn(verification({ result: "fail", exit: 1 }), revision).result).toBe("fail");
});

test("significance is rules over facts, in the order that puts the human first", () => {
  expect(significance(facts())).toBe("routine");
  expect(significance(facts({ readiness: "inspect-ready" }))).toBe("try-it");
  expect(significance(facts({ mrTouched: true }))).toBe("try-it");
  expect(significance(facts({ blockingDrift: true }))).toBe("consequential");
  expect(significance(facts({ correctionSent: true }))).toBe("consequential");
  expect(significance(facts({ intentChanged: true }))).toBe("consequential");
  expect(significance(facts({ ended: "failed" }))).toBe("consequential");
  expect(significance(facts({ pendingChoice: true, blockingDrift: true }))).toBe("decision");
  expect(significance(facts({ driftUnresolved: true }))).toBe("decision");
  expect(significance(facts({ pendingProposal: true }))).toBe("decision");
  expect(significance(facts({ correctionUnacknowledged: true }))).toBe("decision");
});

test("a narrative cannot make a card matter more", () => {
  const shared = {
    run: "r1",
    kind: "slice" as const,
    step: "build",
    iteration: 1,
    at: "2026-09-09T10:00:00Z",
    intentVersion: 1,
    revision,
    changes: { files: [], commits: [] },
    requested: { goal: null, constraints: [] },
    verifications: [],
    claims: [],
    missing: [],
    inspect: [],
    links: {},
    drift: [],
    deliveries: [],
    aligned: "unverified" as const,
    crossRun: "none" as const,
    significance: facts(),
  };
  const quiet = buildCard({ ...shared, narrative: null });
  const loud = buildCard({
    ...shared,
    narrative: "URGENT: this is critical and blocks everything, a human must act now",
  });
  expect(quiet.significance).toBe("routine");
  expect(loud.significance).toBe("routine");
  expect(loud.narrative).toContain("URGENT");
});

test("a card computes its own readiness, so it cannot be told it is verified", () => {
  const built = buildCard({
    run: "r1",
    kind: "slice",
    step: "build",
    iteration: 1,
    at: "2026-09-09T10:00:00Z",
    intentVersion: 1,
    revision,
    changes: { files: ["src/a.ts"], commits: ["abc first"] },
    requested: { goal: "add a picker", constraints: ["stay in src"] },
    verifications: [verification({ end: { head_sha: "def", fingerprint: "zz" } })],
    claims: [{ text: "the tests pass", ref: "r1:build" }],
    missing: ["no verification named typecheck"],
    inspect: [],
    links: {},
    drift: [],
    deliveries: [],
    aligned: "unverified",
    crossRun: "none",
    significance: facts(),
    narrative: null,
  });
  expect(built.verifications[0]?.result).toBe("stale");
  expect(built.readiness).toBe("inspect-ready");
  // WARNING: Agent claims are never among the verifications.
  expect(Arr.map(built.claims, (claim) => claim.text)).toEqual(["the tests pass"]);
  expect(Arr.map(built.verifications, (entry) => entry.name)).toEqual(["tests"]);
  expect(built.missing).toEqual(["no verification named typecheck"]);
  expect(built.significance).toBe("try-it");
});

test("a credential in a claim does not reach the card", () => {
  const built = buildCard({
    run: "r1",
    kind: "slice",
    step: "build",
    iteration: 1,
    at: "t",
    intentVersion: 1,
    revision,
    changes: { files: [], commits: [] },
    requested: { goal: null, constraints: [] },
    verifications: [],
    claims: [{ text: "deployed with glpat-abcdefghij1234567890", ref: "r1:build" }],
    missing: [],
    inspect: [],
    links: {},
    drift: [],
    deliveries: [],
    aligned: "unverified",
    crossRun: "none",
    significance: facts(),
    narrative: "used glpat-abcdefghij1234567890 to push",
  });
  expect(built.claims[0]?.text).toContain("<gitlab token>");
  expect(built.narrative).toContain("<gitlab token>");
  expect(`${built.claims[0]?.text}${built.narrative}`).not.toContain("glpat-abcdefghij");
});

test("inspect entries are suggestions, and nothing here runs them", () => {
  const entries = inspectFor({
    worktree: "/repo/wt",
    base: "abc",
    mr: "https://gitlab.example.com/group/app/-/merge_requests/42",
  });
  expect(Arr.map(entries, (entry) => entry.what)).toEqual(["what changed", "the merge request"]);
  expect(entries[0]?.how).toBe("git -C /repo/wt diff abc..HEAD");
  expect(entries[1]?.how).toBe("glab mr view 42 --repo gitlab.example.com/group/app --comments");
  const pull = inspectFor({
    worktree: null,
    base: "abc",
    mr: "https://github.com/cego/collie/pull/30",
  });
  expect(pull).toEqual([
    {
      what: "the pull request",
      how: "gh pr view 30 --repo cego/collie --comments",
      note: "what the reviewers will read",
    },
  ]);
  expect(inspectFor({ worktree: null, base: "abc", mr: null })).toEqual([]);
});

test("cards.ts never focuses anything", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const source = new URL("../src/cards.ts", import.meta.url).pathname;
      const text = yield* fs.readFileString(source);
      expect(text).not.toContain("agentFocus");
      expect(text).not.toContain("tabFocus");
      expect(text).not.toContain("callAttention");
    }),
  ));

test("the newest card per slice is what a reader sees, and the journal keeps the rest", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "hw-cards-" });
      const base: (over: Partial<Card>) => Card = (over) => ({
        id: "c1",
        run: "r1",
        kind: "slice",
        at: "t1",
        step: "build",
        iteration: 1,
        intent_version: 1,
        revision,
        changes: { files: [], commits: [] },
        requested: { goal: null, constraints: [] },
        readiness: "claimed",
        verifications: [],
        claims: [],
        missing: [],
        inspect: [],
        links: {},
        drift: [],
        deliveries: [],
        narrative: null,
        aligned: "unverified",
        cross_run: "none",
        significance: "routine",
        ...over,
      });

      expect(yield* finishedOnRecord(dir)).toBeNull();
      yield* appendCard(dir, base({}));
      yield* appendCard(dir, base({ id: "c2", at: "t2", readiness: "verified" }));
      yield* appendCard(dir, base({ id: "c3", step: "review", kind: "review" }));

      expect(yield* readCards(dir)).toHaveLength(3);
      const shown = newest(yield* readCards(dir));
      expect(Arr.map(shown, (card) => card.id)).toEqual(["c2", "c3"]);
      expect(yield* finishedOnRecord(dir)).toBeNull();
      yield* appendCard(dir, base({ id: "old-final", kind: "final", at: "t9" }));
      yield* appendCard(dir, base({ id: "new-final", kind: "final", at: "t4" }));
      yield* appendCard(dir, base({ id: "followup", kind: "followup", at: "t5" }));
      yield* (yield* RunRecords).append(cardsPath(dir).run, cardsPath(dir).name, [
        "",
        '{"kind":"final","at":"t6"}',
        "{incomplete",
      ]);
      expect(yield* finishedOnRecord(dir)).toBe("t4");
      expect(yield* readFinalCard(dir)).toEqual(
        Option.some(base({ id: "new-final", kind: "final", at: "t4" })),
      );
    }),
  ));

test("a checkpoint is read as claims, and one nobody can decode is skipped", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = "/state/runs/r-checkpoints";
      yield* writeCheckpoint(dir, {
        ticket: "001-intent.md",
        status: "done",
        claims: ["the schema round trips"],
        at: "t",
      });
      yield* RunRecords.use((records) =>
        records.put("r-checkpoints", "steering/progress/broken.json", "not json"),
      );

      const found = yield* readCheckpoints(dir);
      expect(Arr.map(found, (entry) => entry.checkpoint.ticket)).toEqual(["001-intent.md"]);
      expect(found[0]?.checkpoint.claims).toEqual(["the schema round trips"]);
      expect(found[0]?.file).toBe(`${dir}/steering/progress/001-intent.json`);
    }),
  ));
