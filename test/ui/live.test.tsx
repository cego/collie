// What the Live region says, and what it must never say. Evidence and narrative have to
// look different on screen: a claim an agent wrote must not read as a pass, `missing` is
// always drawn, and the narrative is last and dim because it is the least of it.

import { expect, test } from "bun:test";
import { Effect } from "effect";
import type { JSX } from "solid-js";
import { testRender } from "@opentui/solid";
import { runEffect } from "../support/effect";
import { LiveRegion, SteerBox, ProposalPreview } from "../../src/ui/live";
import type { Card } from "../../src/cards";
import type { Live } from "../../src/live";
import type { ProposalRecord } from "../../src/proposals";

const REVISION = { branch: "main", head_sha: "abc1234def5678", fingerprint: "f1", dirty: false };

function card(over: Partial<Card> = {}): Card {
  return {
    id: "c1",
    run: "r1",
    kind: "slice",
    at: "2026-09-10T10:00:00.000Z",
    step: "build",
    iteration: 2,
    intent_version: 1,
    revision: REVISION,
    changes: { files: ["src/live.ts"], commits: ["abc1234"] },
    requested: { goal: "the Live region", constraints: ["keep the docs with it"] },
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

function live(over: Partial<Live> = {}): Live {
  return {
    run: "r1",
    cards: [],
    drift: [],
    deliveries: [],
    conversation: [],
    proposals: [],
    pending: [],
    ownership: null,
    ...over,
  };
}

/** A component drawn in a pane of its own, as the one run of words it puts on screen. */
const shown = Effect.fn("live.shown")(function* (node: () => JSX.Element, width = 90, height = 30) {
  const t = yield* Effect.promise(() => testRender(node, { width, height }));
  yield* Effect.promise(() => t.flush());
  return t
    .captureCharFrame()
    .replace(/[│┌┐└┘─]/g, " ")
    .replace(/\s+/g, " ");
});

test("a card says what was asked for, what changed, and what nobody checked", () =>
  runEffect(
    Effect.gen(function* () {
      const said = yield* shown(() => (
        <LiveRegion
          live={live({
            cards: [
              card({
                verifications: [{ id: "v1", name: "bun test", result: "pass", ref: "verify/v1" }],
                claims: [{ text: "the suite is green", ref: "output/build" }],
                missing: ["nobody ran the smoke test"],
                inspect: [{ what: "the diff", how: "git show abc1234", note: "" }],
                narrative: "This went smoothly.",
              }),
            ],
          })}
        />
      ));

      expect(said).toContain("slice · build · iteration 2 · abc1234 · try-it");
      expect(said).toContain("the Live region");
      expect(said).toContain("src/live.ts");
      expect(said).toContain("bun test pass");
      // A claim is never a verification: it is prefixed as a claim wherever it is drawn.
      expect(said).toContain("claimed: the suite is green");
      expect(said).toContain("nobody ran the smoke test");
      expect(said).toContain("git show abc1234");
      // The narrative is a model's prose and is marked as such, last.
      expect(said).toContain("Collie: This went smoothly.");
      expect(said.indexOf("Collie: This")).toBeGreaterThan(said.indexOf("bun test pass"));
    }),
  ));

test("what nobody checked is drawn even when there is nothing to say", () =>
  runEffect(
    Effect.gen(function* () {
      const said = yield* shown(() => <LiveRegion live={live({ cards: [card()] })} />);
      expect(said).toContain("missing: nothing was left unchecked");
    }),
  ));

test("drift and deliveries say what state they are in", () =>
  runEffect(
    Effect.gen(function* () {
      const said = yield* shown(() => (
        <LiveRegion
          live={live({
            drift: [
              {
                id: "d1",
                at: "2026-09-10T10:01:00.000Z",
                run: "r1",
                intent_version: 1,
                constraint: "do not touch src/herdr.ts",
                kind: "rule",
                severity: "block",
                evidence: [{ kind: "diff", path: "src/herdr.ts", line: 12 }],
                evidence_truncated: false,
                resolution: "open",
              },
            ],
            deliveries: [
              {
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
                state: "acknowledged",
              },
            ],
          })}
        />
      ));

      expect(said).toContain("block do not touch src/herdr.ts");
      expect(said).toContain("src/herdr.ts:12");
      expect(said).toContain("implementer acknowledged");
    }),
  ));

test("an undelivered report says so, and the ownership question names its remedy", () =>
  runEffect(
    Effect.gen(function* () {
      const said = yield* shown(() => (
        <LiveRegion
          live={live({
            pending: [
              {
                id: "d9",
                at: "2026-09-10T11:00:00.000Z",
                run: "r1",
                intent_version: 2,
                constraint: "the sibling's API must not change",
                kind: "semantic",
                severity: "warn",
                evidence: [],
                evidence_truncated: false,
                resolution: "open",
              },
            ],
            ownership: { why: "two workspaces carry this Herd's token", candidates: ["w1", "w2"] },
          })}
        />
      ));

      expect(said).toContain("pending report (undelivered)");
      expect(said).toContain("the sibling's API must not change");
      expect(said).toContain("collie home reconcile");
      expect(said).toContain("two workspaces carry this Herd's token");
    }),
  ));

test("the Steer box names what a steer would be about, and refuses without one", () =>
  runEffect(
    Effect.gen(function* () {
      const aimed = yield* shown(() => (
        <SteerBox draft="slow down" target="r1" turns={[]} pending={0} />
      ));
      expect(aimed).toContain("r1");
      expect(aimed).toContain("slow down");

      const nowhere = yield* shown(() => (
        <SteerBox draft="slow down" target={null} turns={[]} pending={0} />
      ));
      expect(nowhere).toContain("select the run this is about");
    }),
  ));

test("a proposal preview names every action, its id and its hash", () =>
  runEffect(
    Effect.gen(function* () {
      const proposal: ProposalRecord = {
        kind: "proposal",
        id: "p1",
        content_hash: "deadbeef",
        interpretation: "You want the implementer to slow down.",
        targets: [{ run: "r1" }],
        actions: [
          { kind: "deliver", run: "r1", agent: "implementer", text: "slow down", mode: "boundary" },
          { kind: "hold", run: "r1" },
        ],
        allowed_now: [0],
        created_at: "2026-09-10T10:00:00.000Z",
        expires_at: "2026-09-10T10:30:00.000Z",
        intent_versions: { r1: 1 },
        by: "board",
        state: "pending",
      };
      const said = yield* shown(() => <ProposalPreview proposal={proposal} />);

      expect(said).toContain("You want the implementer to slow down.");
      expect(said).toContain("deliver to implementer (boundary): slow down");
      expect(said).toContain("allowed now");
      expect(said).toContain("hold r1");
      expect(said).toContain("needs your yes");
      expect(said).toContain("p1");
      expect(said).toContain("deadbeef");
    }),
  ));
