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
  MrRead,
  PinnedHead,
  agentWork,
  ask,
  askWhileWatching,
  defineWorkflow,
  isBlocking,
  mrLabel,
  watch,
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
  type Woke,
  type Answered,
} from "collie";
import { Effect, FileSystem, Schema } from "effect";
import { connection } from "./connections.ts";
import { reassess, repliesTo, formatReplies } from "./reassessment.ts";
import * as Activity from "effect/workflow/Activity";
import {
  DEFAULT_BASE,
  FIX_PROMPT,
  HEAD_MOVED,
  MR_ENDED,
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
const FOLLOW = "review.follow_through";
const APPROVE = "Approve";
const NOT_NOW = "Not now";
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
      slack: {
        with: "Reacts to the merge request's message as you",
        without: "Reviews without Slack reactions",
      },
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
    slack: Schema.optionalKey(Schema.String),
    improving: Schema.optionalKey(Schema.Boolean),
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
  hints: { target: "diff-target", improving: "internal" },
  follows: FOLLOW,
  // A review proves it wrote a review a human can read; nobody chooses that.
  outcome: { fixed: "review" },
  // What a finished review offers to do next. Declared here because it is this workflow
  // that knows a review can be fixed and re-run — Collie only carries the offer.
  actions: [
    {
      id: "improve",
      title: "Improve",
      workflow: "review-improve",
      arguments: {},
      inputs: { target: "diff-target", previous: "run-id" },
      eligible: (facts) => {
        if (facts.review?.owned !== true)
          throw new Error("Collie never pushes to someone else's branch");
        if (
          facts.openFindings === 0 ||
          facts.review.head === "" ||
          facts.review.head !== facts.review.reviewed
        )
          throw new Error("no finding is open at the current head");
        return true;
      },
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
      const improving = requested.improving === true;
      const fixContext =
        kind === "mr"
          ? yield* Activity.make({
              name: improving ? "improve-eligibility" : "fix-ownership",
              success: Schema.Struct({
                owned: Schema.Boolean,
                head: Schema.String,
                reviewed: Schema.String,
                lineage: Schema.Array(Schema.String),
                following: Schema.Boolean,
              }),
              execute: host.reviewFix(improving ? previous : run.id, asked.target),
            })
          : null;
      if (
        improving &&
        (fixContext?.owned !== true ||
          fixContext.head !== earlierHead ||
          !Arr.some(
            ledger ?? [],
            (one) => (one.status ?? "open") === "open" && one.head === earlierHead,
          ))
      )
        return yield* new WorkflowError({
          reason: "Improve requires open findings at the current head on your own branch",
        });
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
      // Journaled, so a replay takes the road the round took whatever the setting says now.
      const following = (round: number) =>
        kind !== "mr"
          ? Effect.succeed(false)
          : Activity.make({
              name: `follow-through-${round}`,
              success: Schema.Boolean,
              execute: host.config(FOLLOW).pipe(Effect.map((value) => Str.trim(value) === "true")),
            });
      const fact = (name: string, line: string) =>
        Activity.make({ name, execute: host.record(run.id, line) });
      // Null where the head moved under it and `carry` keeps the findings for the next round.
      const roundAt = (
        round: number,
        changes: string,
        carry: boolean,
        assessment?: {
          readonly findings: ReadonlyArray<Finding>;
          readonly replies: NonNullable<MrRead["replies"]>;
        },
      ) =>
        Effect.gen(function* () {
          const previous =
            round === 1
              ? before
              : yield* fs
                  .readFileString(`${place.dir}/${REVIEW_FILE}`)
                  .pipe(Effect.orElseSucceed(() => ""));
          return yield* reviewRound(
            (assessment === undefined
              ? reviewPass({
                  target: asked.target,
                  plan: asked.plan ?? "",
                  proves: asked.proves ?? "",
                  previous,
                  ledger: ledger ?? [],
                  head,
                  changes,
                  answered: "",
                  risks: place.options.risks ?? "",
                  at: round,
                  of: round,
                  disputed: [],
                })
              : reassess({
                  target: asked.target,
                  head,
                  at: round,
                  ledger: ledger ?? [],
                  ...assessment,
                })
            ).pipe(
              Effect.catchIf(
                (failure) => carry && Str.startsWith(HEAD_MOVED)(failure.reason),
                () =>
                  findingsIn(place.dir).pipe(
                    Effect.tap((findings) =>
                      Effect.sync(() => {
                        ledger = findings;
                      }),
                    ),
                    Effect.as(null),
                  ),
              ),
            ),
            { round },
          );
        });
      const slackAt = (round: number, stage: string, wanted: ReadonlyArray<string>) =>
        Activity.make({
          name: `follow-slack-${round}-${stage}`,
          error: WorkflowError,
          execute: Effect.gen(function* () {
            if (
              wanted.includes("white_check_mark") &&
              !(yield* host.approvedAt({ target: asked.target, cwd: place.cwd, head }))
            )
              return;
            const message = yield* host.reviewSlack({
              runId: run.id,
              target: asked.target,
              cwd: place.cwd,
              permalink: asked.slack,
              wanted,
            });
            yield* host.record(run.id, message);
          }),
        });
      const postedAt = (review: SynthesisReport, round: number) =>
        Effect.gen(function* () {
          const note = reviewNote(review, ledger, head);
          if (note === "") {
            yield* fact(`follow-posted-${round}`, "no findings changed; no review note posted");
            return review;
          }
          const noteFile = `${place.dir}/review-note-${round}.md`;
          yield* fs.writeFileString(noteFile, note).pipe(Effect.orDie);
          const answer = yield* Activity.make({
            name: `follow-post-${round}`,
            success: Posted,
            execute: host.post({
              runId: run.id,
              target: asked.target,
              cwd: place.cwd,
              file: noteFile,
              head,
              round,
            }),
          });
          yield* fact(`follow-posted-${round}`, answer.message);
          const signature = answer.ok ? answer.signature : undefined;
          if (signature === undefined) return review;
          const signed = {
            ...review,
            findings: Arr.map(review.findings, (one) => ({ ...one, note: one.note || signature })),
          };
          yield* leaveReview(place.dir, signed);
          if (signed.findings.length > 0) yield* slackAt(round, "posted", ["memo"]);
          return signed;
        });
      const cleanAt = (review: SynthesisReport) =>
        head !== "" &&
        Arr.every(
          review.findings,
          (one) =>
            one.status === "fixed" ||
            one.status === "obsolete" ||
            (one.status !== "disputed" && !isBlocking(one)),
        );

      const followThrough = Effect.gen(function* () {
        const label = mrLabel(asked.target);
        const readAt = (round: number) =>
          Activity.make({
            name: `follow-read-${round}`,
            success: MrRead,
            error: WorkflowError,
            execute: host.mrReading({ target: asked.target, cwd: place.cwd, replies: round > 1 }),
          });
        let reading = yield* readAt(1);
        let reviewedAt = earlierHead;
        let forcePush = false;
        let last: SynthesisReport | null = null;
        let commentsOnly = false;
        let changedComments: ReadonlyArray<string> = [];
        const droppedByHuman = new Set<string>();
        for (let round = 1; ; round += 1) {
          if (reading.state !== "open") return { done: `${label} is ${reading.state}` };
          head = reading.head;
          if (head !== reviewedAt) droppedByHuman.clear();
          const replies = reading.replies ?? [];
          const affected = Arr.filter(
            ledger ?? [],
            (one) =>
              !droppedByHuman.has(one.id ?? one.title) &&
              Arr.some(repliesTo(one, replies, run.id), (reply) =>
                changedComments.includes(reply.id),
              ),
          );
          const attached = Arr.filter(replies, (reply) =>
            Arr.some(commentsOnly ? affected : (ledger ?? []), (one) =>
              repliesTo(one, replies, run.id).includes(reply),
            ),
          );
          const changes = (at: number) =>
            forcePush || reviewedAt === "" ? Effect.succeed("") : changesAt(at, reviewedAt);
          if (round > 1 && !(yield* following(round))) {
            yield* fact(`follow-off-${round}`, `${FOLLOW} is off: back to asking what next`);
            const review = yield* roundAt(round, yield* changes(round), false);
            return { menu: review ?? last, at: round };
          }
          yield* slackAt(round, "started", ["eyes"]);
          const watching = {
            name: `follow-${round}`,
            target: asked.target,
            cwd: place.cwd,
            cursor: { head, seen: reading.comments, pipeline: reading.pipeline },
            author: `@${reading.author}`,
          };
          const maintained: ReadonlyArray<Finding> = commentsOnly
            ? Arr.filter(affected, (one) => one.status === "disputed" && Boolean(one.rebuttal))
            : [];
          let woke: Woke;
          if (maintained.length > 0 && last !== null) {
            let settled: SynthesisReport = last;
            let interrupted: Woke | null = null;
            let kept = false;
            for (const [index, finding] of maintained.entries()) {
              const identity = finding.id ?? finding.title;
              const keep = `Keep ${identity} (no approval)`;
              const drop = `Drop it (approve ${head})`;
              const decision: Woke | Answered = yield* askWhileWatching(
                {
                  prompt: `${keep} / ${drop}?`,
                  options: [{ id: keep, recommended: true }, drop],
                },
                {
                  ...watching,
                  name: `dispute-${round}-${index + 1}`,
                  cursor: { ...watching.cursor, headOnly: true },
                },
              );
              if (decision._tag !== "Answered") {
                interrupted = decision;
                break;
              }
              kept ||= decision.answer === keep;
              if (decision.answer === drop) {
                droppedByHuman.add(identity);
                ledger = Arr.map(ledger ?? [], (one): Finding =>
                  (one.id ?? one.title) === identity
                    ? {
                        ...one,
                        status: "obsolete",
                        head,
                        reason: `Dropped by the human at ${head}`,
                      }
                    : one,
                );
                settled = {
                  ...settled,
                  findings: ledger,
                  verdict: Arr.some(
                    ledger,
                    (one) => one.status === "open" || one.status === "disputed",
                  )
                    ? "findings"
                    : "clean",
                };
                yield* leaveReview(place.dir, settled);
              }
              yield* fact(`dispute-said-${round}-${index + 1}`, `${identity}: ${decision.answer}`);
            }
            last = settled;
            if (interrupted !== null) woke = interrupted;
            else {
              const canApprove: boolean = !kept && cleanAt(settled);
              if (canApprove) {
                const approved = yield* Activity.make({
                  name: `dispute-approve-${round}`,
                  success: Posted,
                  execute: host.approveReview({ target: asked.target, cwd: place.cwd, head }),
                });
                yield* fact(`dispute-approved-${round}`, approved.message);
                if (!approved.ok) return yield* new WorkflowError({ reason: approved.message });
                yield* slackAt(round, "dispute-approved", ["white_check_mark"]);
              }
              const resumed = { ...watching, cursor: { ...watching.cursor, headOnly: kept } };
              woke = yield* watch(canApprove ? { ...resumed, approved: head } : resumed);
            }
          } else {
            const pinned = yield* Activity.make({
              name: `follow-pin-${round}`,
              success: PinnedHead,
              error: WorkflowError,
              execute: host.pinHead({ runId: run.id, target: asked.target, head }),
            });
            if ("refused" in pinned)
              return yield* new WorkflowError({
                reason: `no checkout of ${label} at ${head}: ${pinned.refused}`,
              });
            const reviewed: SynthesisReport | null =
              "moved" in pinned
                ? null
                : commentsOnly && affected.length === 0
                  ? last
                  : yield* roundAt(
                      round,
                      commentsOnly
                        ? ""
                        : `${yield* changes(round)}${attached.length === 0 ? "" : `\n\n${formatReplies(attached)}`}`,
                      true,
                      commentsOnly ? { findings: affected, replies: attached } : undefined,
                    );
            yield* Activity.make({
              name: `follow-close-${round}`,
              execute: Agents.pipe(
                Effect.flatMap((agents) => agents.halt(run.id)),
                Effect.asVoid,
              ),
            });
            if (reviewed === null)
              yield* fact(
                `follow-moved-${round}`,
                `the head of ${label} moved while reviewing ${head}; nothing posted, the findings carry to the next round`,
              );
            else {
              last = yield* postedAt(reviewed, round);
              ledger = last.findings;
              reviewedAt = head;
            }
            if (reviewed === null || !cleanAt(reviewed)) woke = yield* watch(watching);
            else if (
              yield* Activity.make({
                name: `follow-approved-${round}`,
                success: Schema.Boolean,
                error: WorkflowError,
                execute: host.approvedAt({ target: asked.target, cwd: place.cwd, head }),
              })
            ) {
              yield* slackAt(round, "already-approved", ["white_check_mark"]);
              woke = yield* watch({ ...watching, approved: head });
            } else {
              const said = yield* askWhileWatching(
                {
                  prompt: `Approve ${label} at ${head}?`,
                  options: [{ id: APPROVE, recommended: true }, NOT_NOW],
                },
                { ...watching, name: `approve-${round}` },
              );
              if (said._tag !== "Answered") woke = said;
              else {
                const approved =
                  said.answer === APPROVE
                    ? yield* Activity.make({
                        name: `follow-approve-${round}`,
                        success: Posted,
                        execute: host.approveReview({ target: asked.target, cwd: place.cwd, head }),
                      })
                    : null;
                if (approved !== null) {
                  yield* fact(`approve-said-${round}`, approved.message);
                  if (!approved.ok) return yield* new WorkflowError({ reason: approved.message });
                  yield* slackAt(round, "approved", ["white_check_mark"]);
                }
                woke = yield* watch(
                  approved?.ok === true ? { ...watching, approved: head } : watching,
                );
              }
            }
          }
          if (woke._tag === "Ended") return { done: `${label} was ${woke.state}` };
          forcePush = woke.change.forcePush === true;
          commentsOnly = !woke.change.newHead && woke.change.pipeline === null;
          changedComments = woke.change.comments;
          reading = yield* readAt(round + 1);
        }
      });

      // The first review; "Fix findings" below rallies from it.
      const followed =
        !improving && (yield* following(1))
          ? yield* followThrough.pipe(
              Effect.catchIf(
                (failure) => Str.startsWith(MR_ENDED)(failure.reason),
                (failure) =>
                  Effect.succeed({
                    done: `${mrLabel(asked.target)} was ${Str.slice(MR_ENDED.length)(failure.reason)}`,
                  }),
              ),
            )
          : null;
      if (followed?.done !== undefined) return followed.done;
      let synthesis: SynthesisReport = improving
        ? {
            verdict: "findings",
            summary: "Earlier findings to improve",
            findings: [...(ledger ?? [])],
            dropped: [],
            fixed: [],
            disputed: [],
          }
        : (followed?.menu ??
          (yield* reviewRound(
            reviewPass({
              target: asked.target,
              plan: asked.plan ?? "",
              proves: asked.proves ?? "",
              previous: before,
              ledger: kind === "mr" ? (ledger ?? []) : undefined,
              head,
              changes: yield* changesAt(1, earlierHead),
              answered: "",
              risks: place.options.risks ?? "",
              at: 1,
              of: 1,
              disputed: [],
            }),
            { round: 1 },
          )));

      if (improving) {
        yield* leaveReview(place.dir, synthesis);
        yield* fs.writeFileString(`${place.dir}/review-head`, head).pipe(Effect.orDie);
      }

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
              reviewers: improving ? `improve-${at}-` : undefined,
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
      const owned = kind !== "mr" || fixContext?.owned === true;
      let unfixable = !owned
        ? "Collie never pushes to someone else's branch"
        : "refused" in fixable
          ? fixable.refused
          : "";
      // A hand-off needs no checkout, so a live implementer in the lineage may still take one.
      let handOff = owned && place.lineage.length > 1;

      let handed = false;
      // Reviews are numbered by how many there have been, not by how often the menu came.
      let reviews = followed?.at ?? 1;
      let fixes = 0;
      let asks = 0;
      // Set by the human's "Fix findings": the rally then goes on by itself, through the
      // same `settleRound` implement's does, and asks again once it settles or runs out.
      let fixing = improving;
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
            if (improving) return settled;
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
          lineage: improving ? fixContext?.lineage : undefined,
        });
        if (to !== null) {
          yield* host.record(run.id, `${operation}: handed the findings to ${to}`);
          if (improving) {
            const changed = yield* watch({
              name: "improved-head",
              target: asked.target,
              cwd: place.cwd,
              cursor: { head, seen: [], pipeline: "none", headOnly: true },
              author: to,
            });
            if (changed._tag === "Ended") return `${mrLabel(asked.target)} was ${changed.state}`;
            if (fixContext?.following)
              return `findings handed to ${to}; the Follow-through reviews its push`;
            synthesis = yield* reviewedAgain((reviews += 1), "");
            continue;
          }
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
        if (improving && fixContext?.following)
          return `fixed ${fixed.fixed.length}; the Follow-through reviews the pushed head`;
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
        ...Arr.map(
          changed,
          (one) =>
            `- ${one.id}: ${one.status}${one.rebuttal || one.reason ? ` — ${one.rebuttal || one.reason}` : ""}`,
        ),
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
