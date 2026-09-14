// A card's job is to say how far the evidence goes and no further, and to decide whether
// something is worth interrupting a human for by rules over facts. Both of those are what
// is tested here — including the one thing a model must not be able to do, which is make
// its own work look more important by describing it that way.

import { Effect, FileSystem, Path } from "effect";
import { expect, test } from "bun:test";
import {
  appendCard,
  buildCard,
  inspectFor,
  newest,
  readCards,
  readCheckpoints,
  readiness,
  significance,
  verificationOn,
  type Card,
  type SignificanceFacts,
} from "../src/cards";
import type { Verification } from "../src/verify";
import { runEffect } from "./support/effect";

const revision = { branch: "feat/picker", head_sha: "abc", fingerprint: "f1", dirty: false };

const facts = (over: Partial<SignificanceFacts> = {}): SignificanceFacts => ({
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

const verification = (over: Partial<Verification> = {}): Verification => ({
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
  // An agent's word for it, and nothing to look at.
  expect(readiness({ claimed: true, changed: false, verifiedHere: false })).toBe("claimed");
  // Something changed, and somebody said it was done: a human can go and look.
  expect(readiness({ claimed: true, changed: true, verifiedHere: false })).toBe("inspect-ready");
  // A command Collie watched passed on this tree.
  expect(readiness({ claimed: true, changed: true, verifiedHere: true })).toBe("verified");
  // Nobody claimed anything: a change on its own is not a slice that is ready.
  expect(readiness({ claimed: false, changed: true, verifiedHere: false })).toBe("claimed");
});

test("a verification from another revision is stale, not a pass for this one", () => {
  expect(verificationOn(verification(), revision).result).toBe("pass");
  // The same run, a moved tree: it says nothing about what this card describes.
  expect(
    verificationOn(verification({ end: { head_sha: "def", fingerprint: "f1" } }), revision).result,
  ).toBe("stale");
  expect(
    verificationOn(verification({ end: { head_sha: "abc", fingerprint: "f2" } }), revision).result,
  ).toBe("stale");
  // A failure is a failure, not staleness.
  expect(verificationOn(verification({ result: "fail", exit: 1 }), revision).result).toBe("fail");
});

test("significance is rules over facts, in the order that puts the human first", () => {
  expect(significance(facts())).toBe("routine");
  // Something to try.
  expect(significance(facts({ readiness: "inspect-ready" }))).toBe("try-it");
  expect(significance(facts({ mrTouched: true }))).toBe("try-it");
  // Something happened that the human should know about.
  expect(significance(facts({ blockingDrift: true }))).toBe("consequential");
  expect(significance(facts({ correctionSent: true }))).toBe("consequential");
  expect(significance(facts({ intentChanged: true }))).toBe("consequential");
  expect(significance(facts({ ended: "failed" }))).toBe("consequential");
  // Something is waiting for the human, which outranks being told about anything.
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
  // There is no route from what a model wrote to whether anybody is interrupted.
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
    // Passed, but on a different tree.
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
  // The agent's words are claims, and they are never among the verifications.
  expect(built.claims.map((claim) => claim.text)).toEqual(["the tests pass"]);
  expect(built.verifications.map((entry) => entry.name)).toEqual(["tests"]);
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
  const entries = inspectFor({ worktree: "/repo/wt", base: "abc", mr: "!42" });
  expect(entries.map((entry) => entry.what)).toEqual(["what changed", "the merge request"]);
  expect(entries[0]?.how).toBe("git -C /repo/wt diff abc..HEAD");
  expect(inspectFor({ worktree: null, base: "abc", mr: null })).toEqual([]);
});

test("cards.ts never focuses anything", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const source = new URL("../src/cards.ts", import.meta.url).pathname;
      const text = yield* fs.readFileString(source);
      // A card arriving must not move a human off what they are doing. The only thing
      // that still takes focus is a pending question.
      expect(text).not.toContain("agentFocus");
      expect(text).not.toContain("tabFocus");
      expect(text).not.toContain("callAttention");
    }),
  ));

test("the newest card per slice is what a reader sees, and the journal keeps the rest", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectory({ prefix: "hw-cards-" });
      const base = (over: Partial<Card>): Card => ({
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

      yield* appendCard(dir, base({}));
      yield* appendCard(dir, base({ id: "c2", at: "t2", readiness: "verified" }));
      yield* appendCard(dir, base({ id: "c3", step: "review", kind: "review" }));

      expect(yield* readCards(dir)).toHaveLength(3);
      const shown = newest(yield* readCards(dir));
      expect(shown.map((card) => card.id)).toEqual(["c2", "c3"]);

      yield* fs.remove(dir, { recursive: true, force: true });
    }),
  ));

test("a checkpoint is read as claims, and one nobody can decode is skipped", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectory({ prefix: "hw-checkpoints-" });
      const progress = path.join(dir, "steering", "progress");
      yield* fs.makeDirectory(progress, { recursive: true });
      yield* fs.writeFileString(
        path.join(progress, "001-intent.json"),
        `{"ticket":"001-intent.md","status":"done","claims":["the schema round trips"],"at":"t"}`,
      );
      yield* fs.writeFileString(path.join(progress, "broken.json"), "not json");

      const found = yield* readCheckpoints(dir);
      expect(found.map((entry) => entry.checkpoint.ticket)).toEqual(["001-intent.md"]);
      expect(found[0]?.checkpoint.claims).toEqual(["the schema round trips"]);

      yield* fs.remove(dir, { recursive: true, force: true });
    }),
  ));
