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
  formatFixBrief,
  formatFindings,
  isBlocking,
  settleFinalFix,
  settleRound,
  splitDisputed,
  template,
  type Finding,
  type Fixed,
} from "collie";
import { Effect, Schema } from "effect";

const REVIEW = template("Review {{target}}. Report every finding you can stand behind.", {
  target: Schema.String,
});
const FIX = template(
  "Fix what the review raised in {{target}}, or say why you will not.\n\n{{findings}}",
  {
    target: Schema.String,
    findings: Schema.String,
  },
);

const WAIVE = "Waive it";
const SEND_BACK = "Send it back";
const STOP = "Stop";

const DISPUTE_OPTIONS = [WAIVE, SEND_BACK, STOP];
const AGAIN_OPTIONS = [SEND_BACK, STOP];

export default defineWorkflow({
  id: "rally",
  title: "Review a change and fix it until it converges",
  description: "The review/fix rally, written as a loop rather than declared.",
  input: Schema.Struct({
    target: Schema.String,
    cwd: Schema.String,
    /** How many reviews at most. A rally that runs out says so rather than going again. */
    rounds: Schema.Int,
    /** What a person answers, one per Choice asked; a Choice with nothing left is Stop. */
    answers: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  output: Schema.String,
  hints: { target: "diff-target" },
  outcome: { fixed: "review" },
  run: ({ input: asked }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const runId = (yield* Run).id;
      const answers = [...(asked.answers ?? [])];
      const said: string[] = [];
      let disputed: Finding[] = [];
      let waived: Finding[] = [];
      let disputes = 0;
      let progress = 0;
      let unverified = 0;
      let handedUnverified = false;
      let sentBack = 0;
      let seen: {
        readonly at: number;
        readonly keys: ReadonlyArray<string>;
        readonly claimed?: ReadonlyArray<Fixed>;
        readonly handed?: ReadonlyArray<string>;
      } | null = null;

      const choose = (name: string, options: ReadonlyArray<string>) => {
        const answer = answers.shift() ?? STOP;
        said.push(`${name}: ${options.join(" | ")} → ${answer}`);
        return answer;
      };
      const suffix = () =>
        said.length === 0 && waived.length === 0
          ? ""
          : `; asked ${said.join(", ")}; waived ${waived.map((one) => one.title).join(", ") || "(none)"}`;

      const fixNow = (
        operation: string,
        at: number,
        findings: string,
        open: ReadonlyArray<Finding>,
      ) =>
        agentWork({
          operation,
          role: "implementer",
          cwd: asked.cwd,
          instructions: FIX,
          input: { target: asked.target, findings },
          output: FixOutputSchema,
        });

      const keep = (fixed: typeof FixOutputSchema.Type) => {
        const settled = new Set([...fixed.fixed, ...fixed.disputed].map(findingKey));
        disputed = [...disputed.filter((one) => !settled.has(findingKey(one))), ...fixed.disputed];
      };

      const waiveNow = (standing: ReadonlyArray<Finding>) => {
        waived = [
          ...waived,
          ...standing.map((one) => ({
            ...one,
            status: "disputed" as const,
            waived: { by: "a person", choice: `${disputes}` },
          })),
        ];
        const keys = new Set(standing.map(findingKey));
        disputed = disputed.filter((one) => !keys.has(findingKey(one)));
      };

      const finish = (live: ReadonlyArray<Finding>, first: typeof FixOutputSchema.Type) =>
        Effect.gen(function* () {
          let report = first;
          for (;;) {
            const judged = settleFinalFix(live, report, yield* host.evidence(runId, asked.cwd));
            if (judged.ok) {
              return `exhausted after ${asked.rounds} round(s): ${judged.attestation}${suffix()}`;
            }
            if (judged.halt === "dispute_unresolved") {
              const standing = judged.outstanding.filter(isBlocking);
              const answer = choose(`dispute-${++disputes}`, DISPUTE_OPTIONS);
              if (answer === WAIVE) {
                waiveNow(standing);
                return `exhausted after ${asked.rounds} round(s): ${judged.attestation}${suffix()}`;
              }
              if (answer !== SEND_BACK) {
                return `stopped: ${formatFindings(standing)}${suffix()}`;
              }
              report = yield* fixNow(
                `fix-${asked.rounds + 1}-back-${++sentBack}`,
                asked.rounds + 1,
                `A person declined the dispute, so it is open again.\n\n${formatFindings(standing)}`,
                standing,
              );
              continue;
            }
            if (!handedUnverified) {
              handedUnverified = true;
              said.push(`fix-${asked.rounds + 1}: handed back`);
              report = yield* fixNow(
                `fix-${asked.rounds + 1}`,
                asked.rounds + 1,
                `Your fix could not be verified:\n\n${judged.reasons.join("\n")}`,
                live,
              );
              continue;
            }
            const answer = choose(`fix-unverified-${++unverified}`, AGAIN_OPTIONS);
            if (answer !== SEND_BACK) {
              return `stopped: ${judged.reasons.join("; ")}${suffix()}`;
            }
            report = yield* fixNow(
              `fix-${asked.rounds + 1}-back-${++sentBack}`,
              asked.rounds + 1,
              "A person sent this back rather than stop the Run.",
              live,
            );
          }
        });

      for (let at = 1; at <= asked.rounds; at++) {
        const review = yield* agentWork({
          operation: `review-${at}`,
          role: "reviewer",
          cwd: asked.cwd,
          instructions: REVIEW,
          input: { target: asked.target },
          output: ReviewOutputSchema,
        });
        const waivedKeys = new Set(waived.map(findingKey));
        const split = splitDisputed(
          review.findings.filter((one) => !waivedKeys.has(findingKey(one))),
          disputed,
        );
        const rally = settleRound({ live: split.live, disputed, at, seen });
        if (rally.go === "halt" && rally.halt === "dispute_unresolved") {
          const standing = rally.outstanding.filter(isBlocking);
          const answer = choose(`dispute-${++disputes}`, DISPUTE_OPTIONS);
          if (answer === WAIVE) {
            waiveNow(standing);
            if (at < asked.rounds) {
              continue;
            }
            return `clean after ${at} round(s), 0 non-blocking left${suffix()}`;
          }
          if (answer !== SEND_BACK) {
            return `stopped: ${formatFindings(standing)}${suffix()}`;
          }
          const fixed = yield* fixNow(
            `fix-${at}-back-${++sentBack}`,
            at,
            `A person declined the dispute, so it is open again.\n\n${formatFindings(standing)}`,
            standing,
          );
          keep(fixed);
          if (at < asked.rounds) {
            continue;
          }
          return yield* finish(rally.live, fixed);
        }
        if (rally.go === "halt" && rally.halt === "no_progress") {
          const answer = choose(`no-progress-${++progress}`, AGAIN_OPTIONS);
          if (answer !== SEND_BACK) {
            return `stopped: ${rally.reason}${suffix()}`;
          }
          const fixed = yield* fixNow(
            `fix-${at}-back-${++sentBack}`,
            at,
            "A person sent these back rather than stop the Run.",
            rally.outstanding,
          );
          keep(fixed);
          if (at < asked.rounds) {
            continue;
          }
          return yield* finish(rally.live, fixed);
        }
        if (rally.go === "halt") {
          yield* host.record(runId, `halt ${rally.halt}`);
          return `${rally.halt}: ${rally.reason}`;
        }
        if (rally.go === "clean") {
          yield* host.record(runId, `clean after ${at}`);
          return `clean after ${at} round(s), ${rally.remaining.length} non-blocking left${suffix()}`;
        }
        const fixed = yield* fixNow(
          `fix-${at}`,
          at,
          formatFixBrief(rally.live, rally.handedBack),
          rally.live,
        );
        seen = { at, keys: rally.keys, handed: rally.handed, claimed: fixed.fixed };
        // A dispute is carried, not re-argued: the next review either answers it with a
        // rebuttal or it stops driving the loop.
        const known = new Set(disputed.map(findingKey));
        disputed = [...disputed, ...fixed.disputed.filter((one) => !known.has(findingKey(one)))];

        // The last round has no review after it, so this fix's own account is what is
        // left — judged against the checks the journal has, on this tree.
        if (at === asked.rounds) {
          return yield* finish(rally.live, fixed);
        }
      }
      return "exhausted before any review";
    }),
});
