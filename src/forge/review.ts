// A merge request's review as Collie reads it from either forge, a merge's answer, and the
// one rule that decides which comments are external and which are answered.

import * as Num from "effect/Number";
import * as Arr from "effect/Array";

import type { ForgeChecks, Mergeability } from "../board-model";
import { epochMs } from "../time";

export type CommentKind = "person" | "bot" | "system";

/** One comment as a forge lists it. */
export interface ForgeComment {
  readonly id: string;
  readonly url: string;
  /** GitLab's discussion, or the first comment of a GitHub review thread; null for one on its own. */
  readonly thread: string | null;
  readonly author: string;
  readonly kind: CommentKind;
  readonly at: string;
  readonly body: string;
  readonly file: string | null;
  readonly line: number | null;
}

export interface ReviewComment extends ForgeComment {
  readonly external: boolean;
  readonly answered: boolean;
}

/** A merge request's review state at one read, or why the forge could not say. */
export type ReviewRead =
  | {
      readonly ok: true;
      /** Collie's own login on this forge. */
      readonly login: string;
      readonly state: "open" | "merged" | "closed";
      readonly head: string;
      readonly merged: { readonly sha: string; readonly by: string; readonly at: string } | null;
      /** The forge's rules are met without Collie's own approval. */
      readonly approved: boolean;
      /** Why it is not approved; empty where it is. */
      readonly unapproved: string;
      /** Who approved it, Collie's login left out. */
      readonly approvers: ReadonlyArray<string>;
      readonly changesRequested: boolean;
      readonly mergeable: Mergeability | null;
      readonly pipeline: ForgeChecks;
      readonly comments: ReadonlyArray<ReviewComment>;
    }
  | { readonly ok: false; readonly reason: string };

/** What a merge at a given head came to. */
export type MergeAnswer =
  | { readonly _tag: "Merged"; readonly merged: string }
  | {
      readonly _tag: "AlreadyMerged";
      readonly merged: string;
      readonly head: string;
      readonly by: string;
      readonly at: string;
    }
  | { readonly _tag: "HeadMoved"; readonly head: string }
  | { readonly _tag: "Refused"; readonly reason: string };

/**
 * External: a person's comment by anyone but `login`. Answered: its thread is resolved, a
 * later comment in its thread is by `login`, or a comment by `login` links it.
 */
export function judgeComments(
  comments: ReadonlyArray<ForgeComment>,
  login: string,
  resolved: ReadonlySet<string>,
): ReadonlyArray<ReviewComment> {
  const timed = Arr.map(comments, (comment, at) => ({ comment, at, ms: epochMs(comment.at) }));
  const sorted = Arr.sortWith(
    timed,
    (value) => value,
    (a, b) => Num.sign(a.ms - b.ms || a.at - b.at),
  );
  const ordered = Arr.map(sorted, ({ comment }) => comment);
  const mine = Arr.flatMap(ordered, (comment, at) =>
    comment.author === login ? [{ comment, at }] : [],
  );
  return Arr.map(ordered, (comment, at) => ({
    ...comment,
    external: comment.kind === "person" && comment.author !== login,
    answered:
      (comment.thread !== null && resolved.has(comment.thread)) ||
      Arr.some(
        mine,
        (reply) =>
          (comment.thread !== null && reply.comment.thread === comment.thread && reply.at > at) ||
          links(reply.comment.body, comment.url),
      ),
  }));
}

/** `body` names `url` whole: `#note_1` is not linked by `#note_12`. */
export function links(body: string, url: string): boolean {
  return url !== "" && new RegExp(`${RegExp.escape(url)}(?!\\w)`).test(body);
}
