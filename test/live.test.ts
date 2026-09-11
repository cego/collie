// What the Home board's Live region is given, and what a row's marks say. Both are reads
// of journals other tickets write, so the discipline here is the same as the cards':
// nothing is inferred that the files do not say, and a Run nothing has found anything
// about is unmarked rather than reassuringly marked clean.

import { Effect, FileSystem, Path, Schema } from "effect";
import { DriftReportSchema } from "../src/evaluator";
import { expect, test } from "bun:test";
import { appendCard, type Card } from "../src/cards";
import { appendDrift } from "../src/drift";
import { appendLine, ledgerPath } from "./support/live-paths";
import { liveFor, pendingReportsPath, readPendingReports } from "../src/live";
import { DEFAULT_AUTHORITY, seedIntent, writeIntent } from "../src/intent";
import { marksOf } from "../src/lines";
import { runEffect } from "./support/effect";

const encodeReport = Schema.encodeSync(Schema.fromJsonString(DriftReportSchema));

const REVISION = { branch: "main", head_sha: "abc1234def", fingerprint: "f1", dirty: false };

function card(over: Partial<Card> = {}): Card {
  return {
    id: "c1",
    run: "r1",
    kind: "slice",
    at: "2026-09-10T10:00:00.000Z",
    step: "build",
    iteration: 1,
    intent_version: 1,
    revision: REVISION,
    changes: { files: ["src/live.ts"], commits: ["abc1234"] },
    requested: { goal: "the Live region", constraints: [] },
    readiness: "inspect-ready",
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
    significance: "try-it",
    ...over,
  };
}

const rig = Effect.fn("live.rig")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = yield* fs.makeTempDirectory();
  const runDir = path.join(stateDir, "runs", "r1");
  yield* fs.makeDirectory(runDir, { recursive: true });
  return { stateDir, runDir };
});

test("the Live region is the Selection's own cards, drift and deliveries", () =>
  runEffect(
    Effect.gen(function* () {
      const { stateDir, runDir } = yield* rig();
      yield* appendCard(runDir, card());
      yield* appendDrift(runDir, {
        id: "d1",
        at: "2026-09-10T10:01:00.000Z",
        run: "r1",
        intent_version: 1,
        constraint: "do not touch src/herdr.ts",
        kind: "rule",
        severity: "warn",
        evidence: [],
        evidence_truncated: false,
        resolution: "open",
      });

      const { live } = yield* liveFor({
        stateDir,
        socketPath: null,
        run: { id: "r1", dir: runDir },
        runs: [{ id: "r1", dir: runDir, awaiting: null, harnesses: [] }],
        ownership: null,
        region: true,
      });

      expect(live!.cards.map((c) => c.id)).toEqual(["c1"]);
      expect(live!.drift.map((d) => d.id)).toEqual(["d1"]);
      // No Herd — no socket — is no conversation and no proposals, not a failed read.
      expect(live!.conversation).toEqual([]);
      expect(live!.proposals).toEqual([]);
    }),
  ));

test("one pass answers both: the region and the row's marks", () =>
  runEffect(
    Effect.gen(function* () {
      const { stateDir, runDir } = yield* rig();
      yield* appendCard(runDir, card({ significance: "try-it" }));
      yield* appendDrift(runDir, {
        id: "d1",
        at: "2026-09-10T10:01:00.000Z",
        run: "r1",
        intent_version: 1,
        constraint: "do not touch src/herdr.ts",
        kind: "rule",
        severity: "warn",
        evidence: [],
        evidence_truncated: false,
        resolution: "open",
      });

      // The same journals say what the region draws and what the row is marked with, so
      // asking twice was reading each Run's cards and drift twice a tick.
      const { live, marks } = yield* liveFor({
        stateDir,
        socketPath: null,
        run: { id: "r1", dir: runDir },
        runs: [{ id: "r1", dir: runDir, awaiting: null, harnesses: [] }],
        ownership: null,
        region: true,
      });

      expect(live!.drift.map((d) => d.id)).toEqual(["d1"]);
      expect(marks.r1).toEqual({
        tryIt: true,
        drift: true,
        held: false,
        override: false,
        unattributed: false,
        proposal: false,
      });
    }),
  ));

test("a Run's marks come from its own journals and nowhere else", () =>
  runEffect(
    Effect.gen(function* () {
      const { stateDir, runDir } = yield* rig();
      yield* appendCard(runDir, card({ significance: "try-it" }));
      yield* appendDrift(runDir, {
        id: "d1",
        at: "2026-09-10T10:01:00.000Z",
        run: "r1",
        intent_version: 1,
        constraint: "keep the docs with the behaviour",
        kind: "rule",
        severity: "block",
        evidence: [],
        evidence_truncated: false,
        resolution: "open",
      });
      const ledger = yield* ledgerPath(stateDir, "t1");
      yield* appendLine(ledger, {
        id: "s1",
        at: "2026-09-10T10:02:00.000Z",
        run: "r1",
        incarnation: "t1",
        agent: "implementer",
        causal_key: "k1",
        request_id: "q1",
        cause: { kind: "steer", ref: "turn-1" },
        mode: "boundary",
        text_hash: "h1",
        intent_version: 1,
        attempt: 1,
        state: "submitted",
      });
      yield* appendLine(ledger, {
        kind: "manual_override",
        at: "2026-09-10T10:03:00.000Z",
        incarnation: "t1",
        by: "human",
      });

      // The marks are read whether or not the region is on screen: they are on a
      // History row too, and a View that draws no region still draws those.
      const { live, marks } = yield* liveFor({
        stateDir,
        socketPath: null,
        run: null,
        runs: [{ id: "r1", dir: runDir, awaiting: "hold", harnesses: [] }],
        ownership: null,
        region: false,
      });
      expect(live).toBeNull();

      expect(marks.r1).toEqual({
        tryIt: true,
        drift: true,
        held: true,
        override: true,
        unattributed: false,
        proposal: false,
      });
    }),
  ));

test("correcting a Run nobody can prove they own says so on the row, permanently", () =>
  runEffect(
    Effect.gen(function* () {
      const { stateDir, runDir } = yield* rig();
      // SPEC §7.5: without attribution, `auto_correct` is honoured only with
      // `exclusive_steering` **plus** a permanent row warning. The gate was there; the
      // disclosure was not, so a human could receive automatic corrections to an agent
      // nobody can prove they are alone at without ever being told.
      const granted = seedIntent("r1", {
        defaults: {
          constraints: [],
          authority: { ...DEFAULT_AUTHORITY, auto_correct: true, exclusive_steering: true },
        },
      });
      yield* writeIntent(runDir, granted);

      const marked = { id: "r1", dir: runDir, awaiting: null, harnesses: ["claude"] };
      const on = yield* liveFor({
        stateDir,
        socketPath: null,
        run: null,
        runs: [marked],
        ownership: null,
        region: false,
      });
      expect(on.marks.r1?.unattributed).toBe(true);
      // Words, not a glyph: the row has to be readable as the disclosure it is.
      expect(marksOf(on.marks.r1!)).toContain("⚠ unattributed");

      // Not granted is not a warning: nothing is being corrected, so there is nothing to
      // disclose and a mark would make every Run look like it was being argued with.
      yield* writeIntent(runDir, seedIntent("r1", {}));
      const off = yield* liveFor({
        stateDir,
        socketPath: null,
        run: null,
        runs: [marked],
        ownership: null,
        region: false,
      });
      expect(off.marks.r1).toBeUndefined();
    }),
  ));

test("a Run with nothing recorded about it has no marks at all", () =>
  runEffect(
    Effect.gen(function* () {
      const { stateDir, runDir } = yield* rig();
      const { marks } = yield* liveFor({
        stateDir,
        socketPath: null,
        run: null,
        runs: [{ id: "r1", dir: runDir, awaiting: null, harnesses: [] }],
        ownership: null,
        region: false,
      });
      expect(marks.r1).toBeUndefined();
    }),
  ));

test("an undelivered report is read for its Run and never delivered by reading it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { stateDir } = yield* rig();
      const file = yield* pendingReportsPath(stateDir, "herd1", "r1");
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(
        file,
        `${encodeReport({
          id: "d9",
          at: "2026-09-10T11:00:00.000Z",
          run: "r1",
          intent_version: 2,
          constraint: "the sibling repo's API must not change",
          kind: "semantic",
          severity: "warn",
          evidence: [],
          evidence_truncated: false,
          resolution: "open",
        })}\n`,
      );
      const reports = yield* readPendingReports(stateDir, "herd1", "r1");
      expect(reports.map((r) => r.constraint)).toEqual(["the sibling repo's API must not change"]);
      // Reading it changed nothing: the file is still there, with the entry still in it.
      expect(yield* fs.exists(file)).toBe(true);
    }),
  ));
