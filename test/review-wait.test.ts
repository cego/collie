// One read of a merge request's review, judged against the head a Release Run proved.

import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import type { ReviewComment, ReviewRead } from "../src/forge/review";
import { reviewWaitOf, settleAnswers, standingOf, waitsOnApproval } from "../src/review-wait";

const HEAD = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";
const MOVED = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";

const read = (over: Partial<Extract<ReviewRead, { ok: true }>> = {}): ReviewRead => ({
  ok: true,
  login: "collie",
  state: "open",
  head: HEAD,
  merged: null,
  approved: true,
  unapproved: "",
  approvers: ["alice"],
  changesRequested: false,
  mergeable: { state: "mergeable", said: "mergeable" },
  pipeline: { state: "passed" },
  comments: [],
  ...over,
});

const comment = (id: string, over: Partial<ReviewComment> = {}): ReviewComment => ({
  id,
  url: `https://gitlab.example.com/group/app/-/merge_requests/30#note_${id}`,
  thread: null,
  author: "bob",
  kind: "person",
  at: "2026-10-20T11:00:00Z",
  body: "rename this",
  file: null,
  line: null,
  external: true,
  answered: false,
  ...over,
});

const at = { proved: HEAD, seen: [] };

test("an approved, answered, green and mergeable merge request at the proved head is ready", () => {
  expect(standingOf(read(), at)).toEqual({ _tag: "Ready", head: HEAD, approvers: ["alice"] });
});

test("a moved head is moved before it is anything else, even approved and green", () => {
  expect(standingOf(read({ head: MOVED }), at)).toEqual({ _tag: "Moved", head: MOVED });
  expect(standingOf(read({ head: MOVED, comments: [comment("1")] }), at)._tag).toBe("Moved");
});

test("merged and closed are said whatever the head", () => {
  const merged = { sha: "35ae2cea", by: "alice", at: "2026-10-20T11:30:00Z" };
  expect(standingOf(read({ state: "merged", head: MOVED, merged }), at)).toEqual({
    _tag: "Merged",
    ...merged,
  });
  expect(standingOf(read({ state: "closed" }), at)).toEqual({ _tag: "Closed" });
});

test("only an unanswered external comment not seen before is returned", () => {
  const comments = [
    comment("1"),
    comment("2", { answered: true }),
    comment("3", { external: false }),
  ];
  expect(standingOf(read({ comments }), at)).toEqual({
    _tag: "Unanswered",
    head: HEAD,
    comments: [
      {
        id: "1",
        url: comments[0]!.url,
        author: "bob",
        at: "2026-10-20T11:00:00Z",
        body: "rename this",
        thread: null,
        file: null,
        line: null,
      },
    ],
  });
  expect(standingOf(read({ comments }), { proved: HEAD, seen: ["1"] })).toEqual({
    _tag: "Waiting",
    why: ["1 unanswered comment"],
  });
});

test("what is missing is said, every piece of it", () => {
  expect(
    standingOf(
      read({
        approved: false,
        unapproved: "1 of 2 approvals",
        pipeline: { state: "failed", name: "lint" },
        mergeable: { state: "blocked", said: "conflict" },
      }),
      at,
    ),
  ).toEqual({
    _tag: "Waiting",
    why: [
      "the approval (1 of 2 approvals)",
      "the pipeline at 1a2b3c4d, whose lint failed",
      "mergeability (conflict)",
    ],
  });
  expect(standingOf(read({ pipeline: { state: "running" }, mergeable: null }), at)).toEqual({
    _tag: "Waiting",
    why: ["the pipeline at 1a2b3c4d", "mergeability (the forge has not said)"],
  });
});

test("a standing waits on a teammate's approval only while the approval is what is missing", () => {
  const standing = (over: Partial<Extract<ReviewRead, { ok: true }>>) => standingOf(read(over), at);
  expect(waitsOnApproval(standing({ approved: false, unapproved: "1 of 2 approvals" }))).toBe(true);
  expect(
    waitsOnApproval(standing({ approved: false, pipeline: { state: "running" }, mergeable: null })),
  ).toBe(true);
  expect(waitsOnApproval(standing({ pipeline: { state: "failed", name: "approval" } }))).toBe(
    false,
  );
  expect(waitsOnApproval(standing({ pipeline: { state: "running" } }))).toBe(false);
  expect(waitsOnApproval(standing({ approved: false, head: MOVED }))).toBe(false);
  expect(waitsOnApproval(standing({}))).toBe(false);
});

test("a repository with no pipeline has none to wait for", () => {
  expect(standingOf(read({ pipeline: { state: "none" } }), at)._tag).toBe("Ready");
});

test("a forge that cannot be read is said", () => {
  expect(standingOf({ ok: false, reason: "glab is not logged in" }, at)).toEqual({
    _tag: "Unreadable",
    reason: "glab is not logged in",
  });
});

const MR = "https://gitlab.example.com/spilnu/frontend/monorepo/-/merge_requests/345";

test("CI running and a missing approval are awaited, on a teammate, and say what on", () => {
  expect(
    reviewWaitOf(
      MR,
      read({
        approved: false,
        unapproved: "none yet",
        pipeline: { state: "running" },
        mergeable: { state: "blocked", said: "ci still running" },
      }),
    ),
  ).toEqual({
    _tag: "Awaiting",
    on: "CI and a teammate's approval on spilnu/frontend/monorepo!345",
    who: "a teammate",
  });
});

test("CI alone is awaited on nobody", () => {
  expect(reviewWaitOf(MR, read({ pipeline: { state: "running" }, mergeable: null }))).toEqual({
    _tag: "Awaiting",
    on: "CI and the forge to say it can merge on spilnu/frontend/monorepo!345",
    who: null,
  });
});

test("unresolved review threads are awaited on a teammate", () => {
  expect(
    reviewWaitOf(MR, read({ mergeable: { state: "blocked", said: "discussions not resolved" } })),
  ).toEqual({
    _tag: "Awaiting",
    on: "the review threads to be resolved on spilnu/frontend/monorepo!345",
    who: "a teammate",
  });
});

test("a red pipeline, changes requested or a merge the forge refuses blocks, whatever else is awaited", () => {
  expect(
    reviewWaitOf(
      MR,
      read({
        approved: false,
        changesRequested: true,
        pipeline: { state: "failed", name: "lint" },
        mergeable: { state: "blocked", said: "conflict" },
      }),
    ),
  ).toEqual({
    _tag: "Blocked",
    why: [
      "the pipeline at 1a2b3c4d failed (lint)",
      "changes are requested",
      "the forge will not merge it: conflict",
    ],
  });
  expect(reviewWaitOf(MR, read({ mergeable: { state: "blocked", said: "blocked" } }))._tag).toBe(
    "Blocked",
  );
});

test("a forge that cannot be read is awaited on nobody", () => {
  expect(reviewWaitOf(MR, { ok: false, reason: "a timeout" })).toEqual({
    _tag: "Awaiting",
    on: "the forge to answer about spilnu/frontend/monorepo!345 (a timeout)",
    who: null,
  });
});

test("changes requested keep a merge request from being ready", () => {
  expect(standingOf(read({ changesRequested: true }), at)).toEqual({
    _tag: "Waiting",
    why: ["changes requested"],
  });
});

const open = (id: string) => {
  const { kind: _kind, external: _external, answered: _answered, ...rest } = comment(id);
  return rest;
};
const FIX = "c0ffee1234567890c0ffee1234567890c0ffee12";

test("a fixed answer is replied to with its commit only where the head carries it, linking the comment", () => {
  const given = [open("1"), open("2")];
  const settled = settleAnswers({
    given,
    answers: [
      { id: "1", answer: "fixed", commit: FIX, note: "renamed it" },
      { id: "2", answer: "fixed", commit: "deadbeef", note: "moved it" },
    ],
    onHead: [FIX],
    open: ["1", "2"],
  });
  expect(settled.replies).toEqual([
    { id: "1", kind: "fixed", body: `${given[0]!.url}\n\nFixed in \`c0ffee12\`: renamed it` },
  ]);
  expect(Arr.map(settled.carried, (one) => one.id)).toEqual(["2"]);
});

test("a disputed answer is replied to with its reason, and one left out is carried", () => {
  const given = [open("1"), open("2")];
  const settled = settleAnswers({
    given,
    answers: [{ id: "1", answer: "disputed", note: "the name is the domain's" }],
    onHead: [],
    open: ["1", "2"],
  });
  expect(settled.replies).toEqual([
    {
      id: "1",
      kind: "disputed",
      body: `${given[0]!.url}\n\nNot changed: the name is the domain's`,
    },
  ]);
  expect(Arr.map(settled.carried, (one) => one.id)).toEqual(["2"]);
});

test("a comment answered on the forge since is neither replied to nor carried", () => {
  const settled = settleAnswers({ given: [open("1")], answers: [], onHead: [], open: [] });
  expect(settled).toEqual({ replies: [], carried: [] });
});
