// One complete review of a target, reconciled into the one review a human reads.
//
// A reviewer per seat of the reviewer panel the definition declares — one by default, and a
// second is a seat in a fork rather than a new step — then the synthesis that reconciles
// them, written into the Run's own directory as prose for the human and findings for the
// card.
//
// Shared, because the workflow that reviews and the workflow that builds want the same
// pass: an ordinary function over the same content and the same schemas, not a step one
// of them copied from the other. The Markdown beside this file is the content.

import {
  Agents,
  Host,
  ReviewOutputSchema,
  Run,
  SynthesisSchema,
  agentWork,
  contentOf,
  panelOf,
  formatFindings,
  leaveReview,
  mrForgeFacts,
  parseMrTarget,
  renderRecordedChecks,
  repoArgs,
  riskLine,
  step,
  targetKind,
  type Finding,
  type SynthesisReport,
} from "collie";
import { Effect, Schema } from "effect";
import markdown from "./review.md" with { type: "text" };

const content = contentOf(markdown);
const text = Schema.String;

/** What every review prompt is told: the change, what it is held to, and where it lives. */
const change = {
  inputs: Schema.Struct({ target: text, target_kind: text, plan: text, outcome: text }),
  target_repo: text,
  mr: Schema.Struct({ forge: text, noun: text, diff: text, view: text, checkout: text }),
  base: text,
};

/** What a prompt is told of a target that is not a merge request. */
export const NO_MR = { forge: "", noun: "", diff: "", view: "", checkout: "" };

/** What a worktree's change is measured against where nothing integrated the default branch. */
export const DEFAULT_BASE = "<default-branch>";

/** A reviewer's round: the one before it, what was disputed, and where this Run keeps its work. */
export const REVIEW = content.template("review", {
  ...change,
  run: Schema.Struct({ dir: text, id: text }),
  previous: Schema.Struct({ review: text, fix: text }),
  iteration: text,
  max_iterations: text,
  disputed: text,
  risks: text,
  obstacle: text,
  checks: text,
  criteria: text,
});

/** The reviews to reconcile, and the one before them. */
const SYNTHESIZE = content.template("synthesize", {
  ...change,
  run: Schema.Struct({ dir: text, id: text }),
  previous: Schema.Struct({ review: text }),
  fan_in: text,
  obstacle: text,
});

/** An implementer fixing what a review found. */
export const FIX_PROMPT = content.template("fix", {
  ...change,
  run: Schema.Struct({ dir: text, id: text }),
  branch: text,
  iteration: text,
  max_iterations: text,
  findings: text,
  disputed: text,
});

/**
 * The reviewer panel's one seat, as a definition declares it for the role rather than as
 * the work pins it, so a fork's `agents.roles.reviewer` reaches every reviewer and the
 * synthesis. A second reviewer is what a specialist axis or a fork is for, not what every
 * change gets.
 */
export const REVIEWER = { harness: "claude", model: "opus", effort: "high" };

/** The implementer's seat: implement's builder, and whoever fixes what a review found. */
export const IMPLEMENTER = { harness: "claude", model: "opus", effort: "high" };

/** A round of review and the fix after it, which every Workflow that reviews makes the same way. */
export const reviewRound = step({
  id: "review",
  title: "Review",
  description: "Reviewers read the change, and what blocks goes back to be fixed.",
  kind: "agent",
  role: "reviewer",
  produces: "review",
});

export const synthesisStep = step({
  id: "synthesis",
  title: "Synthesis",
  description: "Reconcile the reviewers' findings into one report.",
  kind: "agent",
  role: "reviewer",
  produces: "review",
});

/** What one pass is about, and where in a rally it stands. */
export interface ReviewAsk {
  readonly target: string;
  /** The spec the change is held to, where whoever asked for this has one. */
  readonly plan: string;
  /** What the change under review has to prove, which decides one judgement field. */
  readonly proves: string;
  /** The review before this one, for the reviewers to read rather than repeat. */
  readonly previous: string;
  /** Where the implementer's account of that review is; empty where nobody fixed one. */
  readonly answered: string;
  /** The extra axes a human asked for, where they asked for any. */
  readonly risks: string;
  /** Which round this is, and how many there may be. It also names the round's work. */
  readonly at: number;
  readonly of: number;
  /** What the implementer has already stood on, so a reviewer answers it or drops it. */
  readonly disputed: ReadonlyArray<Finding>;
  readonly prefix?: string;
  readonly obstacle?: string;
  /** The commit a worktree's change is diffed against: the default branch as last integrated. */
  readonly base?: string;
  /** What the builder says of each criterion, and its assumptions, for the reviewer to check. */
  readonly criteria?: string;
}

/** What the reviewers and the synthesis are both told, beside the section they are given. */
export const told = (ask: ReviewAsk, run: { readonly dir: string; readonly id: string }) => ({
  inputs: {
    target: ask.target,
    target_kind: targetKind(ask.target),
    plan: ask.plan,
    // What the change has to prove, under the name the prose asks for it by.
    outcome: ask.proves,
  },
  run,
  previous: { review: ask.previous, fix: ask.answered },
  iteration: String(ask.at),
  max_iterations: String(ask.of),
  disputed: formatFindings(ask.disputed),
  risks: riskLine(ask.risks),
  target_repo: repoArgs(parseMrTarget(ask.target)?.project ?? null).join(" "),
  mr: mrForgeFacts(ask.target) ?? NO_MR,
  base: ask.base || DEFAULT_BASE,
  obstacle: ask.obstacle ?? "",
});

/**
 * Every reviewer, then the one review that comes out of them — left behind as the prose a
 * human reads and the findings whatever comes next counts.
 */
export const reviewPass = (ask: ReviewAsk) =>
  Effect.gen(function* () {
    const agents = yield* Agents;
    const { id } = yield* Run;
    const host = yield* Host;
    const { dir, cwd } = yield* host.place(id);
    const input = told(ask, { dir, id });
    // A check left to CI is read from the forge where the Run has a merge request, never run.
    const leftToCi = yield* Effect.forEach(
      (yield* host.approved(id)).filter((spec) => spec.ci !== undefined),
      (spec) =>
        Effect.map(host.ciJob({ runId: id, cwd, name: spec.name }), (read) => ({
          name: spec.name,
          job: spec.ci ?? "",
          state: "proved" in read ? "passed" : read.state,
        })),
    );
    const checks = renderRecordedChecks(yield* host.evidence(id, cwd), leftToCi);
    // The round comes first, and the first round keeps the plain names: a Run with one
    // review reads as one, and a rally's rounds sort in the order they happened.
    const prefix = ask.prefix ?? "";
    const reviewOp = (seat: string) =>
      `${prefix}${ask.at === 1 ? `review-${seat}` : `review-${ask.at}-${seat}`}`;
    const synthesis = `${prefix}${ask.at === 1 ? "synthesize" : `synthesize-${ask.at}`}`;

    const seats = (yield* panelOf("reviewer")).map((seat, at) => ({
      seat,
      operation: reviewOp(seat.name ?? String(at + 1)),
    }));
    // One seat is one review, already the one the human reads: its prompt asks a lone
    // reviewer for the synthesis's own fields, so a second agent would only copy it.
    if (seats.length === 1) {
      const [only] = seats;
      const alone: SynthesisReport = yield* agentWork({
        operation: only!.operation,
        role: "reviewer",
        seat: only!.seat,
        instructions: REVIEW,
        input: { ...input, checks, criteria: ask.criteria ?? "" },
        output: SynthesisSchema,
      });
      yield* leaveReview(dir, alone);
      return alone;
    }
    yield* Effect.forEach(
      seats,
      ({ seat, operation }) =>
        agentWork({
          operation,
          role: "reviewer",
          seat,
          instructions: REVIEW,
          input: { ...input, checks, criteria: ask.criteria ?? "" },
          output: ReviewOutputSchema,
        }),
      { concurrency: "unbounded" },
    );

    const reconciled: SynthesisReport = yield* synthesisStep(
      agentWork({
        operation: synthesis,
        role: "reviewer",
        instructions: SYNTHESIZE,
        input: {
          ...input,
          fan_in: seats.map(({ operation }) => `- ${agents.outputFor(id, operation)}`).join("\n"),
        },
        output: SynthesisSchema,
      }),
    );
    // The prose a human reads and the findings a card counts, where both are looked for.
    yield* leaveReview(dir, reconciled);
    return reconciled;
  });
