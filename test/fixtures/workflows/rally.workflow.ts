// Review, fix, review again — as a module writes it: a loop in TypeScript over the same
// functions the engine uses for a declared one.
//
// Nothing here is a repeat declaration or a scheduler. `splitDisputed` decides what is
// still the implementer's, `settleRound` decides where the round goes, and
// `settleFinalFix` decides whether the last fix stands — with the checks it names read
// from the verification journal rather than from its own word for them.

import {
  FixOutputSchema,
  Host,
  ReviewOutputSchema,
  Run,
  agentWork,
  defineWorkflow,
  findingKey,
  settleFinalFix,
  settleRound,
  splitDisputed,
  type Finding,
} from "collie";
import { Effect, Schema } from "effect";

const REVIEW = "Review {{inputs.target}}. Report every finding you can stand behind.";
const FIX = "Fix what the review raised in {{inputs.target}}, or say why you will not.";

export default defineWorkflow({
  id: "rally",
  title: "Review a change and fix it until it converges",
  description: "The review/fix rally, written as a loop rather than declared.",
  input: Schema.Struct({
    target: Schema.String,
    cwd: Schema.String,
    /** How many reviews at most. A rally that runs out says so rather than going again. */
    rounds: Schema.Int,
  }),
  output: Schema.String,
  hints: { target: "diff-target" },
  outcome: { fixed: "review" },
  run: ({ input: asked }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const runId = (yield* Run).id;
      let disputed: Finding[] = [];
      let seen: { readonly at: number; readonly keys: ReadonlyArray<string> } | null = null;

      for (let at = 1; at <= asked.rounds; at++) {
        const review = yield* agentWork({
          operation: `review-${at}`,
          role: "reviewer",
          cwd: asked.cwd,
          instructions: REVIEW,
          inputs: { target: asked.target },
          output: ReviewOutputSchema,
        });
        const split = splitDisputed(review.findings, disputed);
        const rally = settleRound({ live: split.live, disputed, at, seen });
        if (rally.go === "halt") {
          yield* host.record(runId, `halt ${rally.halt}`);
          return `${rally.halt}: ${rally.reason}`;
        }
        if (rally.go === "clean") {
          yield* host.record(runId, `clean after ${at}`);
          return `clean after ${at} round(s), ${rally.remaining.length} non-blocking left`;
        }
        seen = { at, keys: rally.keys };

        const fix = yield* agentWork({
          operation: `fix-${at}`,
          role: "implementer",
          cwd: asked.cwd,
          instructions: FIX,
          inputs: { target: asked.target },
          output: FixOutputSchema,
        });
        // A dispute is carried, not re-argued: the next review either answers it with a
        // rebuttal or it stops driving the loop.
        const known = new Set(disputed.map(findingKey));
        disputed = [...disputed, ...fix.disputed.filter((one) => !known.has(findingKey(one)))];

        // The last round has no review after it, so this fix's own account is what is
        // left — judged against the checks the journal has, on this tree.
        if (at === asked.rounds) {
          const settled = settleFinalFix(rally.live, fix, yield* host.evidence(runId, asked.cwd));
          if (!settled.ok) {
            yield* host.record(runId, `halt ${settled.halt}`);
            return `${settled.halt}: ${settled.reasons.join("; ")}`;
          }
          return `exhausted after ${at} round(s): ${settled.attestation}`;
        }
      }
      return "exhausted before any review";
    }),
});
