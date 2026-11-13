// One complete review of a target, and then what to do about it.
//
// The pass itself is `reviewing.ts`, shared with the workflow that builds: the same
// reviewers, the same synthesis, the same review left behind. What is here is what a
// standalone review adds — the menu after it, which comes back until something terminal
// happens, because a note that did not land is not an answer.
//
// The Markdown beside this file is the content: how to read each kind of target, what a
// reviewer is asked for, and what the fix is told about where it stands.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import {
  Agents,
  FINDINGS_FILE,
  FixOutputSchema,
  Children,
  Host,
  REVIEW_FILE,
  Run,
  WorkflowError,
  agentWork,
  ask,
  defineWorkflow,
  formatFindings,
  findingsIn,
  leaveReview,
  renderReview,
  forgeOfRef,
  handOffWork,
  mrForgeFacts,
  parseMrTarget,
  repoArgs,
  riskLine,
  sameFinding,
  forecast,
  panelOf,
  remainingDisputes,
  settleRound,
  splitDisputed,
  step,
  targetKind,
  type Finding,
  type SynthesisReport,
} from "collie";
import { Effect, FileSystem, Schema } from "effect";
import { connection } from "./connections.ts";
import * as Activity from "effect/workflow/Activity";
import {
  DEFAULT_BASE,
  FIX_PROMPT,
  IMPLEMENTER,
  NO_MR,
  REVIEWER,
  reviewPass,
  reviewRound,
  synthesisStep,
} from "./reviewing.ts";

const FIX = "Fix findings";
const IMPLEMENT = "Fix findings in a full implement run";
const DONE = "Don't post";
const AGAIN = "Review again";
const Posted = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.String,
  signature: Schema.optionalKey(Schema.String),
});

/** How many fix rounds one "Fix findings" may run before the human is asked again. */
const ROUNDS = 4;

const ReviewedCheckout = Schema.Union([
  Schema.Struct({ cwd: Schema.String, branch: Schema.String }),
  Schema.Struct({ refused: Schema.String }),
]);

const menu = step({
  id: "menu",
  title: "What next",
  kind: "question",
  description: "Choose whether to fix, post, repeat or finish the review.",
});
const fixingStep = step({
  id: "fix",
  title: "Fix findings",
  kind: "agent",
  role: "implementer",
  description: "The implementer fixes the findings before the next review.",
});

const ReviewedBranch = Schema.Union([
  Schema.Struct({ branch: Schema.String }),
  Schema.Struct({ refused: Schema.String }),
]);

export default defineWorkflow({
  id: "review",
  connections: {
    uses: {
      gitlab: {
        with: "Reads and answers the merge request",
        without: "Reviews the local diff only",
      },
      github: {
        with: "Reads and answers the pull request",
        without: "Reviews the local diff only",
      },
    },
  },
  title: "review — an MR, a branch diff, or the working tree",
  description:
    "Reviews a change — an MR, a branch diff or the working tree — in one complete review, and what happens next is your call: fix the findings here, hand them to a live implementer, run a full implement, or post the review to somebody else's merge request.",
  input: Schema.Struct({
    target: Schema.String,
    plan: Schema.optionalKey(
      Schema.String.annotate({
        description: "The spec the change is held to; empty where there is none",
      }),
    ),
    // Not `outcome`: that is what this Run proves, and a review always proves a review.
    proves: Schema.optionalKey(
      Schema.String.annotate({
        description:
          "What kind of result the change has to prove (feature, bug, refactor, investigation, docs, migration), which decides the judgement the reviewer gives; empty for unclassified",
      }),
    ),
  }),
  output: Schema.String,
  agents: { roles: { implementer: IMPLEMENTER, reviewer: REVIEWER } },
  path: [reviewRound, menu],
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
      inputs: { target: "diff-target", previous: "run-id" },
      eligible: (facts) => facts.diffTarget !== null,
    },
  ],
  run: ({ input: requested }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const children = yield* Children;
      const fs = yield* FileSystem.FileSystem;
      const run = yield* Run;
      const place = yield* host.place(run.id);
      const ref = parseMrTarget(requested.target);
      const reading = ref === null ? null : yield* connection(forgeOfRef(ref));
      const asked =
        reading === null || reading.state === "ok"
          ? requested
          : { ...requested, target: "worktree" };
      if (reading !== null && reading.state !== "ok")
        yield* host.record(
          run.id,
          `Reviews the local diff only: ${reading.detail}. Fix: ${reading.fix}`,
        );
      if ((yield* panelOf("reviewer")).length > 1)
        yield* forecast([reviewRound, synthesisStep, menu]);
      const kind = targetKind(asked.target);
      const headAt = (round: number) =>
        Activity.make({
          name: `reviewed-head-${round}`,
          success: Schema.String,
          execute: host.reviewedHead({ target: asked.target, cwd: place.cwd }),
        });
      let head = kind === "mr" ? yield* headAt(1) : "";

      // The extra axes and the earlier review are the host's own — a caller attaches them
      // to the work rather than declaring them here, and `previous` names the Run whose
      // review this one is a follow-up to.
      const previous = place.options.previous ?? "";
      const earlierPlace = previous === "" ? null : yield* host.place(previous);
      const before =
        earlierPlace === null
          ? ""
          : yield* fs
              .readFileString(`${earlierPlace.dir}/${REVIEW_FILE}`)
              .pipe(Effect.orElseSucceed(() => ""));
      let ledger: ReadonlyArray<Finding> | undefined =
        earlierPlace === null
          ? undefined
          : Arr.map(yield* findingsIn(earlierPlace.dir), (one, index) => ({
              ...one,
              id: one.id ?? `${previous}-F${index + 1}`,
              status: one.status ?? "open",
            }));
      const earlierHead =
        earlierPlace === null
          ? ""
          : yield* fs
              .readFileString(`${earlierPlace.dir}/review-head`)
              .pipe(Effect.orElseSucceed(() => ledger?.[0]?.head ?? ""));
      const changesAt = (round: number, earlier: string) =>
        earlier === "" || kind !== "mr"
          ? Effect.succeed("")
          : Activity.make({
              name: `review-changes-${round}`,
              success: Schema.String,
              error: WorkflowError,
              execute: host.reviewChanges({
                target: asked.target,
                cwd: place.cwd,
                previous: earlier,
                head,
              }),
            });
      const changes = yield* changesAt(1, earlierHead);

      // The first review; "Fix findings" below rallies from it.
      let synthesis = yield* reviewRound(
        reviewPass({
          target: asked.target,
          plan: asked.plan ?? "",
          proves: asked.proves ?? "",
          previous: before,
          ledger: kind === "mr" ? (ledger ?? []) : undefined,
          head,
          changes,
          answered: "",
          risks: place.options.risks ?? "",
          at: 1,
          of: 1,
          disputed: [],
        }),
        { round: 1 },
      );

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
        target_repo: Arr.join(repoArgs(parseMrTarget(asked.target)?.project ?? null), " "),
        mr: mrForgeFacts(asked.target) ?? NO_MR,
        base: DEFAULT_BASE,
        obstacle: "",
      };

      const agents = yield* Agents;
      // The fix and the review after it are one round of a rally, as in implement: a fix
      // Collie ran is reviewed again at once, and one handed to an agent Collie does not
      // watch waits for the human to say it is ready to look at.
      const reviewedAgain = (at: number, answered: string) =>
        Effect.gen(function* () {
          ledger = synthesis.findings;
          const earlier = head;
          head = kind === "mr" ? yield* headAt(at) : "";
          const changes = yield* changesAt(at, earlier);
          const last = yield* fs
            .readFileString(`${place.dir}/${REVIEW_FILE}`)
            .pipe(Effect.orElseSucceed(() => ""));
          return yield* reviewRound(
            reviewPass({
              target: asked.target,
              plan: asked.plan ?? "",
              proves: asked.proves ?? "",
              previous: last,
              ledger: kind === "mr" ? ledger : undefined,
              head,
              changes,
              answered,
              risks: place.options.risks ?? "",
              at,
              // This review, and one for every fix round the rally may still run after it.
              of: at + (fixing ? ROUNDS - rallied : 0),
              disputed: [...disputed],
            }),
            { round: at },
          );
        });

      // Why no fix can run here, recorded inside its Activity so a replay logs it once.
      const fixable = yield* Activity.make({
        name: "fixable",
        success: ReviewedBranch,
        execute: (reading !== null && reading.state !== "ok"
          ? Effect.succeed({ refused: `the forge is unavailable: ${reading.detail}` })
          : host.reviewedBranch(run.id)
        ).pipe(
          Effect.tap((answer) =>
            "refused" in answer
              ? host.record(run.id, `no fix can run here: ${answer.refused}`)
              : Effect.void,
          ),
        ),
      });
      let unfixable = "refused" in fixable ? fixable.refused : "";
      // A hand-off needs no checkout, so a live implementer in the lineage may still take one.
      let handOff = place.lineage.length > 1;

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
        const resolved = Arr.filter(
          synthesis.findings,
          (one) => one.status === "fixed" || one.status === "obsolete",
        );
        disputed = Arr.filter(
          disputed,
          (one) => !Arr.some(resolved, (old) => sameFinding(old, one)),
        );
        disputed = remainingDisputes(disputed, synthesis);
        const split = splitDisputed(synthesis.findings, disputed);
        const round = settleRound({
          live: split.live,
          disputed: [...disputed, ...split.settled],
          at: reviews,
          seen,
        });
        const approve =
          Arr.every(
            synthesis.findings,
            (one) => one.status === "fixed" || one.status === "obsolete",
          ) &&
          disputed.length === 0 &&
          head !== "";
        const POST = approve ? `Post and approve ${Str.slice(0, 7)(head)}` : "Post";
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
          const fixOffered = unfixable === "" || handOff;
          const offered = [
            ...(handed ? [AGAIN] : split.live.length > 0 && fixOffered ? [FIX] : []),
            ...(unfixable === "" ? [IMPLEMENT] : []),
            ...(kind === "mr" ? [POST] : []),
            DONE,
          ];
          const [recommended] = Arr.filter(offered, (one) => one !== IMPLEMENT);
          chosen = yield* menu(
            ask({
              name: `post-${(asks += 1)}`,
              prompt: Arr.join(
                [
                  "What next?",
                  ...(settled === "" ? [] : [`The rally stopped: ${settled}.`]),
                  ...(unfixable === ""
                    ? []
                    : [
                        fixOffered
                          ? `Only a live implementer can take a fix: ${unfixable}.`
                          : `No fix is offered: ${unfixable}.`,
                      ]),
                ],
                " ",
              ),
              options: Arr.map(offered, (id) => ({ id, recommended: id === recommended })),
            }),
            { round: asks },
          );
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
          const note = reviewNote(synthesis, ledger, head);
          const noteFile = `${place.dir}/review-note.md`;
          if (note !== "") yield* fs.writeFileString(noteFile, note).pipe(Effect.orDie);
          const posted =
            note === ""
              ? { ok: true, message: "no findings changed; no review note posted" }
              : yield* Activity.make({
                  name: `post-review-${reviews}-${asks}`,
                  success: Posted,
                  execute: host.post({
                    runId: run.id,
                    target: asked.target,
                    cwd: place.cwd,
                    file: noteFile,
                    head,
                    round: reviews,
                  }),
                });
          if (posted.ok && "signature" in posted && posted.signature !== undefined) {
            const signature = posted.signature;
            synthesis = {
              ...synthesis,
              findings: Arr.map(synthesis.findings, (one) => ({
                ...one,
                note: one.note || signature,
              })),
            };
            yield* leaveReview(place.dir, synthesis);
          }
          yield* host.record(run.id, posted.message);
          if (posted.ok) {
            if (!approve) return posted.message;
            const approved = yield* Activity.make({
              name: `approve-review-${reviews}`,
              success: Posted,
              execute: host.approveReview({ target: asked.target, cwd: place.cwd, head }),
            });
            yield* host.record(run.id, approved.message);
            if (!approved.ok) return yield* new WorkflowError({ reason: approved.message });
            return `${posted.message}; ${approved.message}`;
          }
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
        // The fixer works in the reviewed branch's checkout, which is the Run's from now on.
        const reviewed = yield* Activity.make({
          name: `${operation}-checkout`,
          success: ReviewedCheckout,
          execute: host
            .checkoutReviewed(run.id)
            .pipe(
              Effect.tap((answer) =>
                "refused" in answer
                  ? host.record(run.id, `${operation}: nothing fixed, ${answer.refused}`)
                  : Effect.void,
              ),
            ),
        });
        if ("refused" in reviewed) {
          fixing = false;
          unfixable = reviewed.refused;
          handOff = false;
          continue;
        }
        const forge = yield* host.mr({ cwd: reviewed.cwd });
        const fixed = yield* fixingStep(
          agentWork({
            operation,
            role: "implementer",
            pushes: true,
            clears: [
              `pushing new commits to ${reviewed.branch} on origin${forge.url === undefined ? "" : ` (${forge.url})`} with a plain push`,
            ],
            instructions: FIX_PROMPT,
            input: {
              inputs,
              ...input,
              branch: reviewed.branch,
              iteration: String(rallied),
              max_iterations: String(ROUNDS),
              // What the rally is fixing: a dispute raised again with no rebuttal is not work.
              findings: formatFindings(split.live),
              disputed: formatFindings(disputed),
            },
            output: FixOutputSchema,
          }),
          { round: fixes },
        );
        yield* host.record(
          run.id,
          `${operation}: fixed ${fixed.fixed.length}, disputed ${fixed.disputed.length}`,
        );
        disputed = [
          ...disputed,
          ...Arr.filter(
            fixed.disputed,
            (one) => !Arr.some(disputed, (old) => sameFinding(old, one)),
          ),
        ];
        synthesis = yield* reviewedAgain((reviews += 1), agents.outputFor(run.id, operation));
      }
    }),
});

const reviewNote = (
  review: SynthesisReport,
  previous: ReadonlyArray<Finding> | undefined,
  head: string,
): string => {
  if (previous === undefined) return renderReview(review);
  const published = Arr.filter(previous, (one) => Boolean(one.note));
  if (previous.length > 0 && published.length === 0) return renderReview(review);
  const added = Arr.filter(
    review.findings,
    (one) => !Arr.some(published, (old) => old.id === one.id),
  );
  const changed = Arr.filter(review.findings, (one) =>
    Arr.some(published, (old) => old.id === one.id && old.status !== one.status),
  );
  if (added.length === 0 && changed.length === 0) return "";
  const stillOpen = Arr.filter(
    review.findings,
    (one) =>
      one.status === "open" &&
      Arr.some(published, (old) => old.id === one.id && old.status === "open"),
  );
  return (
    Arr.join(
      [
        ...(added.length === 0 ? [] : [formatFindings(added)]),
        ...Arr.map(changed, (one) => `- ${one.id}: ${one.status}`),
        ...Arr.map(stillOpen, (one) => `- ${one.id}: still open`),
        ...(Arr.every(review.findings, (one) => one.status === "fixed" || one.status === "obsolete")
          ? [`all findings fixed at \`${head}\``]
          : []),
      ],
      "\n\n",
    ) + "\n"
  );
};

/** What the live implementer is told: where the review is, and that this is a fix round. */
const handOffText = (dir: string) =>
  Arr.join(
    [
      `A review of this work is ready in ${dir}/${REVIEW_FILE}, with its findings as JSON in`,
      `${dir}/${FINDINGS_FILE}. Apply it as a fix round: fix what it found, commit as you go,`,
      "and where you disagree with a finding say so with a reason rather than dropping it.",
    ],
    " ",
  );
