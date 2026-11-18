import * as Num from "effect/Number";
import * as Arr from "effect/Array";

import type { ForgeChecks, Mergeability } from "../board-model";
import { epochMs } from "../time";

export type CommentKind = "person" | "bot" | "system";

export interface ForgeComment {
  readonly id: string;
  readonly url: string;
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

export type ReviewRead =
  | {
      readonly ok: true;
      readonly login: string;
      readonly state: "open" | "merged" | "closed";
      readonly head: string;
      readonly merged: { readonly sha: string; readonly by: string; readonly at: string } | null;
      readonly approved: boolean;
      readonly unapproved: string;
      readonly approvers: ReadonlyArray<string>;
      readonly changesRequested: boolean;
      readonly mergeable: Mergeability | null;
      readonly pipeline: ForgeChecks;
      readonly comments: ReadonlyArray<ReviewComment>;
    }
  | { readonly ok: false; readonly reason: string };

export const QUEUE_MERGERS: ReadonlySet<string> = new Set([
  "github-merge-queue",
  "github-merge-queue[bot]",
]);

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

export function judgeComments(
  comments: ReadonlyArray<ForgeComment>,
  login: string,
  resolved: ReadonlySet<string>,
) {
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

export function links(body: string, url: string) {
  return url !== "" && new RegExp(`${RegExp.escape(url)}(?!\\w)`).test(body);
}
