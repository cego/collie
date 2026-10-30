// A merge request's review as a Release Run waits on it: one read of the forge, judged
// against the head the Run's Checks were proved on.

import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Schema } from "effect";
import { mrLabel, type Mergeability } from "./board-model";
import type { ReviewRead } from "./forge/review";

/** An external comment nobody has answered yet. */
export const OpenCommentSchema = Schema.Struct({
  id: Schema.String,
  url: Schema.String,
  author: Schema.String,
  at: Schema.String,
  body: Schema.String,
  thread: Schema.NullOr(Schema.String),
  file: Schema.NullOr(Schema.String),
  line: Schema.NullOr(Schema.Finite),
});
export type OpenComment = typeof OpenCommentSchema.Type;

/**
 * Where the review stands. A wait returns every one but `Waiting` and `Unreadable`, which it
 * waits through; `Held` is a Hold or a Stop that ended the wait.
 */
export const ReviewStandingSchema = Schema.Union([
  Schema.TaggedStruct("Ready", { head: Schema.String, approvers: Schema.Array(Schema.String) }),
  Schema.TaggedStruct("Unanswered", {
    head: Schema.String,
    comments: Schema.Array(OpenCommentSchema),
  }),
  Schema.TaggedStruct("Moved", { head: Schema.String }),
  Schema.TaggedStruct("Merged", { sha: Schema.String, by: Schema.String, at: Schema.String }),
  Schema.TaggedStruct("Closed", {}),
  Schema.TaggedStruct("Held", {}),
  Schema.TaggedStruct("Waiting", { why: Schema.Array(Schema.String) }),
  Schema.TaggedStruct("Unreadable", { reason: Schema.String }),
]);
export type ReviewStanding = typeof ReviewStandingSchema.Type;

const plural = (count: number, one: string) => `${count} ${one}${count === 1 ? "" : "s"}`;

const UNAPPROVED = "the approval";

/** Whether a standing is still waiting on a teammate's approval, among whatever else. */
export const waitsOnApproval = (standing: ReviewStanding) =>
  standing._tag === "Waiting" &&
  Arr.some(standing.why, (one) => pipe(one, Str.startsWith(`${UNAPPROVED} (`)));

/**
 * Ready means approved, nothing external unanswered, the pipeline passed, mergeable, all at
 * `proved`. A moved head is checked first, so a new head that is ready still moved; a
 * comment already in `seen` keeps the wait waiting rather than returning it again.
 */
export function standingOf(
  read: ReviewRead,
  against: { readonly proved: string; readonly seen: ReadonlyArray<string> },
): ReviewStanding {
  if (!read.ok) return { _tag: "Unreadable", reason: read.reason };
  if (read.state === "merged")
    return {
      _tag: "Merged",
      sha: read.merged?.sha ?? "",
      by: read.merged?.by ?? "",
      at: read.merged?.at ?? "",
    };
  if (read.state === "closed") return { _tag: "Closed" };
  if (read.head !== against.proved) return { _tag: "Moved", head: read.head };
  const open = Arr.filter(read.comments, (one) => one.external && !one.answered);
  const fresh = Arr.filter(open, (one) => !against.seen.includes(one.id));
  if (fresh.length > 0)
    return {
      _tag: "Unanswered",
      head: read.head,
      comments: Arr.map(fresh, ({ id, url, author, at, body, thread, file, line }) => ({
        id,
        url,
        author,
        at,
        body,
        thread,
        file,
        line,
      })),
    };
  const short = pipe(read.head, Str.slice(0, 8));
  const why = [
    ...(read.approved ? [] : [`${UNAPPROVED} (${read.unapproved || "none yet"})`]),
    ...(read.changesRequested ? ["changes requested"] : []),
    ...(open.length === 0 ? [] : [plural(open.length, "unanswered comment")]),
    ...(read.pipeline.state === "passed" || read.pipeline.state === "none"
      ? []
      : read.pipeline.state === "failed"
        ? [`the pipeline at ${short}, whose ${read.pipeline.name} failed`]
        : [`the pipeline at ${short}`]),
    ...(read.mergeable?.state === "mergeable"
      ? []
      : conflictsWithTarget(read.mergeable)
        ? [CONFLICTS]
        : [`mergeability (${read.mergeable?.said || "the forge has not said"})`]),
  ];
  return why.length === 0
    ? { _tag: "Ready", head: read.head, approvers: read.approvers }
    : { _tag: "Waiting", why };
}

/** The merge request's head, which of a round's commits it carries, and its open external comments. */
export const ReviewHeadSchema = Schema.Struct({
  head: Schema.String,
  carries: Schema.Array(Schema.String),
  open: Schema.Array(Schema.String),
});
export type ReviewHead = typeof ReviewHeadSchema.Type;

/** One comment a comment round answered: `fixed` in `commit`, or `disputed`. */
export const AnswerSchema = Schema.Struct({
  id: Schema.String.annotate({ description: "the comment's id, as given" }),
  answer: Schema.Literals(["fixed", "disputed"]),
  commit: Schema.optionalKey(Schema.String).annotate({
    description: "the pushed commit that fixes it, where fixed",
  }),
  note: Schema.String.annotate({
    description: "what the fix changed, or why nothing changed",
  }),
});
export type Answer = typeof AnswerSchema.Type;

/** The replies a round's answers earn, and the comments handed to the next round. */
export const SettledAnswersSchema = Schema.Struct({
  replies: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      /** Absent from a round settled before replies were recorded. */
      kind: Schema.optionalKey(Schema.Literals(["fixed", "disputed"])),
      body: Schema.String,
    }),
  ),
  carried: Schema.Array(OpenCommentSchema),
});
export type SettledAnswers = typeof SettledAnswersSchema.Type;

/**
 * A `fixed` answer counts only where its commit is in `onHead`, the commits the merge
 * request's head carries by the forge's word; a comment no longer in `open` was answered on
 * the forge meanwhile. Everything else given is carried.
 */
export function settleAnswers(round: {
  readonly given: ReadonlyArray<OpenComment>;
  readonly answers: ReadonlyArray<Answer>;
  readonly onHead: ReadonlyArray<string>;
  readonly open: ReadonlyArray<string>;
}): SettledAnswers {
  const replies: Array<SettledAnswers["replies"][number]> = [];
  const carried: OpenComment[] = [];
  for (const comment of Arr.filter(round.given, (one) => round.open.includes(one.id))) {
    const answer = Option.getOrUndefined(
      Arr.findFirst(round.answers, (one) => one.id === comment.id),
    );
    const says =
      answer?.answer === "disputed"
        ? `Not changed: ${answer.note}`
        : answer?.commit !== undefined && round.onHead.includes(answer.commit)
          ? `Fixed in \`${pipe(answer.commit, Str.slice(0, 8))}\`: ${answer.note}`
          : null;
    if (says === null) carried.push(comment);
    else
      replies.push({
        id: comment.id,
        kind: answer!.answer,
        body: `${comment.url}\n\n${says}`,
      });
  }
  return { replies, carried };
}

/** A review not yet ready: `Awaiting` what ends by itself, `Blocked` what needs a repair. */
export type ReviewWait =
  | { readonly _tag: "Awaiting"; readonly on: string; readonly who: string | null }
  | { readonly _tag: "Blocked"; readonly why: ReadonlyArray<string> };

const TEAMMATE = "a teammate";
const CI = "CI";
const APPROVAL = "a teammate's approval";
const THREADS = "the review threads to be resolved";

/** The forge's words for a merge it holds back until something already awaited comes; `blocked` is GitHub's. */
const HELD_FOR = new Map<string, string | null>([
  ["ci still running", CI],
  ["ci must pass", CI],
  ["not approved", APPROVAL],
  ["discussions not resolved", THREADS],
  ["blocked", null],
]);

/** The forge's words for a merge request whose branch conflicts with its target branch. */
const CONFLICTING = new Set(["conflicting", "dirty", "conflict", "cannot be merged"]);

export const conflictsWithTarget = (mergeable: Mergeability | null | undefined) =>
  mergeable?.state === "blocked" && CONFLICTING.has(mergeable.said);

export const CONFLICTS = "it conflicts with its target branch, and its branch must take the target";

export function reviewWaitOf(mr: string, read: ReviewRead): ReviewWait {
  const label = mrLabel(mr);
  if (!read.ok)
    return {
      _tag: "Awaiting",
      on: `the forge to answer about ${label} (${read.reason})`,
      who: null,
    };
  const mergeable = read.mergeable;
  const held = mergeable?.state === "blocked" ? HELD_FOR.get(mergeable.said) : undefined;
  const blocked = [
    ...(read.pipeline.state === "failed"
      ? [`the pipeline at ${pipe(read.head, Str.slice(0, 8))} failed (${read.pipeline.name})`]
      : []),
    ...(read.changesRequested ? ["changes are requested"] : []),
    ...(conflictsWithTarget(mergeable)
      ? [CONFLICTS]
      : mergeable?.state === "blocked" && held === undefined
        ? [`the forge will not merge it: ${mergeable.said}`]
        : []),
  ];
  const open = Arr.filter(read.comments, (one) => one.external && !one.answered).length;
  const on = [
    ...new Set([
      ...(read.pipeline.state === "running" || read.pipeline.state === "unknown" ? [CI] : []),
      ...(read.approved ? [] : [APPROVAL]),
      ...(open === 0 ? [] : [`answers to ${plural(open, "comment")}`]),
      ...(held === undefined || held === null ? [] : [held]),
      ...(mergeable === null || mergeable.state === "unknown"
        ? ["the forge to say it can merge"]
        : []),
    ]),
  ];
  if (blocked.length > 0 || on.length === 0)
    return {
      _tag: "Blocked",
      why: blocked.length > 0 ? blocked : [`the forge will not merge it: ${mergeable?.said ?? ""}`],
    };
  return {
    _tag: "Awaiting",
    on: `${Arr.join(on, " and ")} on ${label}`,
    who: Arr.some(on, (one) => one === APPROVAL || one === THREADS) ? TEAMMATE : null,
  };
}

/** The card's line while a person has to repair what holds the release back. */
export const blockedLine = (mr: string, why: ReadonlyArray<string>) =>
  `${mrLabel(mr)} cannot be released: ${Arr.join(why, "; ")}. The Run goes on once that is repaired.`;
