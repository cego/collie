// One complete review of a target, and then what to do about it.
//
// The pass itself is `reviewing.ts`, shared with the workflow that builds: the same
// reviewers, the same synthesis, the same review left behind. What is here is what a
// standalone review adds — the menu after it, which comes back until something terminal
// happens, because a note that did not land is not an answer.
//
// The Markdown beside this file is the content: how to read each kind of target, what a
// reviewer is asked for, and what the fix is told about where it stands.

import {
  Agents,
  FINDINGS_FILE,
  FixOutputSchema,
  Children,
  Host,
  REVIEW_FILE,
  Run,
  agentWork,
  ask,
  defineWorkflow,
  formatFindings,
  handOffWork,
  parseMrTarget,
  repoArgs,
  riskLine,
  findingKey,
  settleRound,
  splitDisputed,
  targetKind,
  type Finding,
} from "collie";
import { Effect, FileSystem, Schema } from "effect";
import { FIX_PROMPT, IMPLEMENTER, REVIEWER, reviewPass } from "./reviewing.ts";

const FIX = "Fix findings";
const IMPLEMENT = "Fix findings in a full implement run";
const POST = "Post to MR";
const DONE = "Don't post";
const AGAIN = "Review again";

/** How many fix rounds one "Fix findings" may run before the human is asked again. */
const ROUNDS = 4;

export default defineWorkflow({
  id: "review",
  title: "review — an MR, a branch diff, or the working tree",
  description:
    "You pick the target — an MR, a branch diff or the working tree — one complete review comes out, and what happens next is your call: fix the findings here, hand them to a live implementer, run a full implement, or post the review to somebody else's merge request.",
  input: Schema.Struct({
    target: Schema.String,
    /** Empty unless a workflow embedding this one has a spec to hold the change to. */
    plan: Schema.optionalKey(Schema.String),
    /**
     * What kind of result the change under review has to prove, which decides the one
     * judgement field the reviewer is asked for. Not `outcome`: that is what this Run
     * proves, and a review always proves a review.
     */
    proves: Schema.optionalKey(Schema.String),
  }),
  output: Schema.String,
  agents: { roles: { implementer: IMPLEMENTER, reviewer: REVIEWER } },
  hints: { target: "diff-target" },
  // A review proves it wrote a review a human can read; nobody chooses that.
  outcome: { fixed: "review" },
  // What a finished review offers to do next. Declared here because it is this workflow
  // that knows a review can be fixed and re-run — Collie only carries the offer.
  actions: [
    {
      id: "fix-open",
      title: "Fix what is open",
      workflow: "implement",
      arguments: {},
      inputs: { plan: "run-dir" },
      eligible: (facts) => facts.openFindings > 0,
    },
    {
      id: "run-again",
      title: "Review again",
      workflow: "self",
      arguments: {},
      inputs: { target: "diff-target" },
      eligible: (facts) => facts.diffTarget !== null,
    },
  ],
  run: ({ input: asked }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const children = yield* Children;
      const fs = yield* FileSystem.FileSystem;
      const run = yield* Run;
      const place = yield* host.place(run.id);
      const kind = targetKind(asked.target);

      // The extra axes and the earlier review are the host's own — a caller attaches them
      // to the work rather than declaring them here, and `previous` names the Run whose
      // review this one is a follow-up to.
      const previous = place.options.previous ?? "";
      const before =
        previous === ""
          ? ""
          : yield* fs
              .readFileString(`${(yield* host.place(previous)).dir}/${REVIEW_FILE}`)
              .pipe(Effect.orElseSucceed(() => ""));

      // The first review; "Fix findings" below rallies from it.
      let synthesis = yield* reviewPass({
        target: asked.target,
        plan: asked.plan ?? "",
        proves: asked.proves ?? "",
        previous: before,
        answered: "",
        risks: place.options.risks ?? "",
        at: 1,
        of: 1,
        disputed: [],
      });

      const inputs = {
        target: asked.target,
        target_kind: kind,
        plan: asked.plan ?? "",
        outcome: asked.proves ?? "",
      };
      const input = {
        run: { dir: place.dir, id: run.id },
        previous: { review: before, fix: "" },
        iteration: "1",
        max_iterations: "1",
        disputed: formatFindings([]),
        risks: riskLine(place.options.risks ?? ""),
        target_repo: repoArgs(parseMrTarget(asked.target)?.project ?? null).join(" "),
        obstacle: "",
      };

      const agents = yield* Agents;
      // The fix and the review after it are one round of a rally, as in implement: a fix
      // Collie ran is reviewed again at once, and one handed to an agent Collie does not
      // watch waits for the human to say it is ready to look at.
      const reviewedAgain = (at: number, answered: string) =>
        Effect.gen(function* () {
          const last = yield* fs
            .readFileString(`${place.dir}/${REVIEW_FILE}`)
            .pipe(Effect.orElseSucceed(() => ""));
          return yield* reviewPass({
            target: asked.target,
            plan: asked.plan ?? "",
            proves: asked.proves ?? "",
            previous: last,
            answered,
            risks: place.options.risks ?? "",
            at,
            // This review, and one for every fix round the rally may still run after it.
            of: at + (fixing ? ROUNDS - rallied : 0),
            disputed: [...disputed],
          });
        });

      let handed = false;
      // Reviews are numbered by how many there have been, not by how often the menu came.
      let reviews = 1;
      let fixes = 0;
      let asks = 0;
      // Set by the human's "Fix findings": the rally then goes on by itself, through the
      // same `settleRound` implement's does, and asks again once it settles or runs out.
      let fixing = false;
      let rallied = 0;
      let seen: { readonly at: number; readonly keys: ReadonlyArray<string> } | null = null;
      let settled = "";
      // A dispute is carried into the next review rather than re-argued, as in implement.
      let disputed: ReadonlyArray<Finding> = [];
      for (;;) {
        const split = splitDisputed(synthesis.findings, disputed);
        const round = settleRound({ live: split.live, disputed, at: reviews, seen });
        let chosen: string = FIX;
        if (fixing) {
          if (round.go !== "fix" || rallied >= ROUNDS) {
            fixing = false;
            settled =
              round.go === "halt"
                ? `${round.halt}: ${round.reason}`
                : round.go === "clean"
                  ? "nothing blocking is left"
                  : `the rally ran ${ROUNDS} rounds and findings remain`;
            yield* host.record(run.id, `rally settled after review ${reviews}: ${settled}`);
          }
        }
        // Posting is offered for a merge request and nothing else; whether this is one to
        // post to is decided when it is invoked, by whoever can actually see GitLab.
        if (!fixing) {
          chosen = yield* ask({
            name: `post-${(asks += 1)}`,
            prompt: settled === "" ? "What next?" : `What next? The rally stopped: ${settled}.`,
            options: [
              ...(handed ? [AGAIN] : split.live.length > 0 ? [FIX] : []),
              IMPLEMENT,
              ...(kind === "mr" ? [POST] : []),
              DONE,
            ],
          });
          settled = "";
          if (chosen === FIX) {
            fixing = true;
            rallied = 0;
            seen = null;
          }
        }
        // What this fix is for, so a review that raises the same blockers again halts.
        if (chosen === FIX && round.go === "fix") seen = { at: reviews, keys: round.keys };
        if (chosen === DONE) return `${synthesis.findings.length} finding(s), not posted`;

        if (chosen === POST) {
          const posted = yield* host.post({
            runId: run.id,
            target: asked.target,
            cwd: place.cwd,
            file: `${place.dir}/${REVIEW_FILE}`,
          });
          yield* host.record(run.id, posted.message);
          // A note that did not land is not an answer, so the menu comes back.
          if (posted.ok) return posted.message;
          continue;
        }

        if (chosen === IMPLEMENT) {
          // This review is the work source; the branch it reviewed is read from it.
          const child = yield* children.start({
            invocation: "implement",
            workflow: "implement",
            input: { plan: place.dir },
          });
          yield* children.result(child);
          return `${synthesis.findings.length} finding(s), fixed in ${child.runId}`;
        }

        if (chosen === AGAIN) {
          handed = false;
          synthesis = yield* reviewedAgain((reviews += 1), "");
          continue;
        }

        // The live implementer of the Run this review came from is building this work, so
        // it is the one to fix it: a second agent on the same checkout would be two hands
        // on one index.
        // Recorded, so a replay takes the same road rather than asking again.
        fixes += 1;
        rallied += 1;
        const operation = fixes === 1 ? "fix" : `fix-${fixes}`;
        const to = yield* handOffWork({
          operation,
          role: "implementer",
          text: handOffText(place.dir),
        });
        if (to !== null) {
          yield* host.record(run.id, `${operation}: handed the findings to ${to}`);
          handed = true;
          fixing = false;
          continue;
        }
        const fixed = yield* agentWork({
          operation,
          role: "implementer",
          instructions: FIX_PROMPT,
          input: {
            inputs,
            ...input,
            iteration: String(rallied),
            max_iterations: String(ROUNDS),
            // What the rally is fixing: a dispute raised again with no rebuttal is not work.
            findings: formatFindings(split.live),
            disputed: formatFindings(disputed),
          },
          output: FixOutputSchema,
        });
        yield* host.record(
          run.id,
          `${operation}: fixed ${fixed.fixed.length}, disputed ${fixed.disputed.length}`,
        );
        const known = new Set(disputed.map(findingKey));
        disputed = [...disputed, ...fixed.disputed.filter((one) => !known.has(findingKey(one)))];
        synthesis = yield* reviewedAgain((reviews += 1), agents.outputFor(run.id, operation));
      }
    }),
});

/** What the live implementer is told: where the review is, and that this is a fix round. */
const handOffText = (dir: string) =>
  [
    `A review of this work is ready in ${dir}/${REVIEW_FILE}, with its findings as JSON in`,
    `${dir}/${FINDINGS_FILE}. Apply it as a fix round: fix what it found, commit as you go,`,
    "and where you disagree with a finding say so with a reason rather than dropping it.",
  ].join(" ");
