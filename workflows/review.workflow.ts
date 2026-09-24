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
  targetKind,
} from "collie";
import { Effect, FileSystem, Schema } from "effect";
import { reviewPass, reviewText } from "./reviewing.ts";

const FIX = "Fix findings";
const IMPLEMENT = "Fix findings in a full implement run";
const POST = "Post to MR";
const DONE = "Don't post";

/** How often the menu may come back. A post that did not land asks again; not for ever. */
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

      // A standalone review is one round of one review: the rally belongs to whoever
      // embeds this, and the numbers say what is true here rather than what is usual.
      const synthesis = yield* reviewPass({
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
      const vars = {
        run: { dir: place.dir, id: run.id },
        previous: { review: before, fix: "" },
        iteration: "1",
        max_iterations: "1",
        disputed: formatFindings([]),
        risks: riskLine(place.options.risks ?? ""),
        target_repo: repoArgs(parseMrTarget(asked.target)?.project ?? null).join(" "),
        obstacle: "",
      };

      let fixes = 0;
      for (let round = 1; round <= ROUNDS; round++) {
        // Posting is offered for a merge request and nothing else; whether this is one to
        // post to is decided when it is invoked, by whoever can actually see GitLab.
        const chosen = yield* ask({
          name: `post-${round}`,
          prompt: "What next?",
          options: [FIX, IMPLEMENT, ...(kind === "mr" ? [POST] : []), DONE].filter(
            (one) => one !== FIX || fixes === 0,
          ),
        });
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

        fixes += 1;
        // An implementer already live here is building this work, so it is the one to
        // fix it: a second agent on the same checkout would be two hands on one index.
        // Recorded, so a replay takes the same road rather than asking again.
        const handed = yield* handOffWork({
          operation: "fix",
          role: "implementer",
          text: handOffText(place.dir),
        });
        if (handed !== null) {
          yield* host.record(run.id, `handed the findings to ${handed}`);
          continue;
        }
        const fixed = yield* agentWork({
          operation: "fix",
          role: "implementer",
          instructions: reviewText("fix"),
          inputs,
          vars,
          output: FixOutputSchema,
        });
        yield* host.record(
          run.id,
          `fixed ${fixed.fixed.length}, disputed ${fixed.disputed.length}`,
        );
      }
      return `${synthesis.findings.length} finding(s), asked ${ROUNDS} times what to do next`;
    }),
});

/** What the live implementer is told: where the review is, and that this is a fix round. */
const handOffText = (dir: string) =>
  [
    `A review of this work is ready in ${dir}/${REVIEW_FILE}, with its findings as JSON in`,
    `${dir}/${FINDINGS_FILE}. Apply it as a fix round: fix what it found, commit as you go,`,
    "and where you disagree with a finding say so with a reason rather than dropping it.",
  ].join(" ");
