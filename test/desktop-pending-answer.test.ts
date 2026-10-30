import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import type { Question } from "../src/board-model";
import { applyItem, EMPTY_FLOCK, type FlockItem, flockCards } from "../desktop/src/shared/flock";
import {
  type Answering,
  answerKey,
  answerSent,
  answersSettled,
  answerTried,
  cardQuestion,
  draftOf,
  draftTyped,
  type InFlight,
  nothingAnswered,
  openQuestions,
  type Sitting,
  sittingAnswered,
  sittingMoved,
  sittingSees,
  sittingStarts,
  sittingView,
} from "../desktop/src/shared/pending-answer";
import { task } from "./support/task";

const question = (id: string, run = "r-1"): Question => ({
  kind: "question",
  run,
  id,
  step: "plan",
  topic: id,
  text: `About ${id}?`,
  options: [],
});
const A = question("a");
const B = question("b");
const C = question("c", "r-2");
const keyOf = (asked: Question) => answerKey("vm", asked.run, asked.id);

let sends = 0;
/** An answer as the dialog sends it: what is shown, to which Machine, and which send it is. */
const sent = (shown: string): Omit<InFlight, "confirmed"> => ({
  shown,
  machine: "vm-mk",
  send: ++sends,
});
const sending = (state: Answering, asked: Question, shown: string) => {
  const answer = sent(shown);
  return { state: answerSent(state, keyOf(asked), answer), answer };
};
/** A board of one Task on Machine "vm", with `open` its open questions. */
const shownBy = (state: Answering, open: ReadonlyArray<Question>) =>
  answersSettled(state, [{ installation: "vm", task: { decision: null, questions: open } }]);

const now = (open: ReadonlyArray<Question>, answering: Answering) => ({
  installation: "vm",
  open,
  answering,
});

test("an answer is sending, then waits for the board once confirmed, and a failure takes it back", () => {
  const { state, answer } = sending(nothingAnswered, A, "Ship it");
  expect(cardQuestion({ decision: A, questions: [A] }, "vm", state)).toEqual({
    text: "About a?",
    label: null,
    pending: "Sending Ship it to vm-mk…",
  });
  const confirmed = answerTried(state, keyOf(A), answer, true);
  expect(cardQuestion({ decision: A, questions: [A] }, "vm", confirmed)?.pending).toBe(
    "Answered Ship it; waiting for vm-mk's board",
  );
  const failed = answerTried(state, keyOf(A), answer, false);
  expect(cardQuestion({ decision: A, questions: [A] }, "vm", failed)).toEqual({
    text: "About a?",
    label: "Answer…",
    pending: null,
  });
});

test("answers are per question: confirming, failing or retrying one leaves the others as they were", () => {
  const first = sending(nothingAnswered, A, "yes");
  const second = sending(first.state, B, "no");
  const confirmedA = answerTried(second.state, keyOf(A), first.answer, true);
  expect(confirmedA.answers.get(keyOf(B))?.confirmed).toBe(false);
  const failedB = answerTried(confirmedA, keyOf(B), second.answer, false);
  expect(failedB.answers.get(keyOf(A))?.confirmed).toBe(true);
  expect(failedB.answers.has(keyOf(B))).toBe(false);
  // Try again of B shows B sending again and nothing else.
  const retried = answerTried(failedB, keyOf(B), second.answer, null);
  expect(retried.answers.get(keyOf(B))).toEqual({ ...second.answer, confirmed: false });
  expect(retried.answers.get(keyOf(A))?.confirmed).toBe(true);
});

test("a try of an answer a newer one to the same question replaced changes nothing", () => {
  const older = sending(nothingAnswered, A, "yes");
  const failed = answerTried(older.state, keyOf(A), older.answer, false);
  const newer = sending(failed, A, "no");
  expect(answerTried(newer.state, keyOf(A), older.answer, null)).toEqual(newer.state);
  expect(answerTried(newer.state, keyOf(A), older.answer, true)).toEqual(newer.state);
  expect(newer.state.answers.get(keyOf(A))?.shown).toBe("no");
});

test("an answer whose question left the board is dropped, and a late try of it changes nothing", () => {
  const { state, answer } = sending(shownBy(nothingAnswered, [A, B]), A, "yes");
  const settled = shownBy(state, [B]);
  expect(settled.answers.has(keyOf(A))).toBe(false);
  expect(settled.latest.has(keyOf(A))).toBe(false);
  expect(answerTried(settled, keyOf(A), answer, null)).toEqual(settled);
  expect(answerTried(settled, keyOf(A), answer, true)).toEqual(settled);
  expect(shownBy(settled, [B])).toBe(settled);
});

test("a question another Task or Machine still has open keeps what is held for it", () => {
  const typed = draftTyped(
    draftTyped(nothingAnswered, keyOf(A), "half"),
    answerKey("vm-other", A.run, A.id),
    "keep me",
  );
  const { state } = sending(typed, A, "yes");
  const board = (installation: string, open: ReadonlyArray<Question>) => ({
    installation,
    task: { decision: null, questions: open },
  });
  const moved = answersSettled(state, [board("vm", []), board("vm", [A]), board("vm-other", [A])]);
  expect(moved).toBe(state);
  const elsewhere = answersSettled(state, [board("vm-other", [A])]);
  expect(elsewhere.answers.has(keyOf(A))).toBe(false);
  expect(draftOf(elsewhere, keyOf(A))).toBe("");
  expect(draftOf(elsewhere, answerKey("vm-other", A.run, A.id))).toBe("keep me");
});

test("a Task that leaves its Machine's board, by a Snapshot without it or a Remove, drops its answers and drafts", () => {
  const machine = { installation: "vm", profile: "remote", name: "vm-mk" };
  const asked = question("scope");
  const snapshot = (tasks: ReadonlyArray<ReturnType<typeof task>>, seq: number): FlockItem => ({
    machine,
    message: {
      _tag: "Snapshot",
      installation: "vm",
      build: "0.1.0",
      protocol: 1,
      herds: [],
      tasks,
      seq,
    },
  });
  const start = applyItem(
    EMPTY_FLOCK,
    snapshot([task({ id: "t-1", state: "blocked", decision: asked, questions: [asked] })], 1),
  );
  const settledOn = (state: Answering, flock: typeof start) => {
    const board = flockCards(flock);
    return answersSettled(state, Arr.map(board.tasks, board.placedOf));
  };
  const observed = settledOn(nothingAnswered, start);
  const { state, answer } = sending(draftTyped(observed, keyOf(asked), "api"), asked, "api");
  expect(settledOn(state, start)).toBe(state);
  for (const gone of [
    applyItem(start, snapshot([], 2)),
    applyItem(start, { machine, message: { _tag: "Remove", seq: 2, id: "t-1" } }),
  ]) {
    const settled = settledOn(state, gone);
    expect(settled.answers.size).toBe(0);
    expect(settled.latest.size).toBe(0);
    expect(settled.drafts.size).toBe(0);
    expect(answerTried(settled, keyOf(asked), answer, null)).toBe(settled);
  }
});

test("the card counts only questions with no answer in flight, and shows the first of those", () => {
  const card = { decision: A, questions: [A, B, C] };
  expect(cardQuestion(card, "vm", nothingAnswered)).toEqual({
    text: "About a?",
    label: "Answer 3 questions…",
    pending: null,
  });
  const { state } = sending(nothingAnswered, A, "yes");
  expect(cardQuestion(card, "vm", state)).toEqual({
    text: "About b?",
    label: "Answer 2 questions…",
    pending: null,
  });
  const two = sending(state, B, "no").state;
  expect(cardQuestion(card, "vm", two)?.label).toBe("Answer…");
});

test("with every question's answer in flight, the card says how many are sending, then how many wait", () => {
  const card = { decision: A, questions: [A, B] };
  const a = sending(nothingAnswered, A, "yes");
  const b = sending(a.state, B, "no");
  expect(cardQuestion(card, "vm", b.state)).toEqual({
    text: "About a?",
    label: null,
    pending: "Sending 2 answers to vm-mk…",
  });
  const oneConfirmed = answerTried(b.state, keyOf(A), a.answer, true);
  expect(cardQuestion(card, "vm", oneConfirmed)?.pending).toBe("Sending 2 answers to vm-mk…");
  const both = answerTried(oneConfirmed, keyOf(B), b.answer, true);
  expect(cardQuestion(card, "vm", both)?.pending).toBe(
    "Answered 2 questions; waiting for vm-mk's board",
  );
  // A refusal brings the button back.
  expect(cardQuestion(card, "vm", answerTried(both, keyOf(B), b.answer, false))?.label).toBe(
    "Answer…",
  );
});

test("an older host's card, with no questions listed, answers its decision; a Proposal card has no question", () => {
  expect(openQuestions({ decision: A })).toEqual([A]);
  expect(openQuestions({ decision: null })).toEqual([]);
  expect(cardQuestion({ decision: A }, "vm", nothingAnswered)?.label).toBe("Answer…");
  const sitting = sittingStarts(now(openQuestions({ decision: A }), nothingAnswered));
  expect(sittingView(sitting, now([A], nothingAnswered))).toMatchObject({ k: 1, n: 1 });

  const proposal = {
    kind: "proposal" as const,
    id: "p-1",
    hash: "h",
    text: "Stop it?",
    actions: [],
  };
  expect(cardQuestion({ decision: proposal, questions: [A] }, "vm", nothingAnswered)).toBeNull();
});

test("the sitting counts k of N, and Back and Next move without answering and never wrap", () => {
  const open = [A, B, C];
  const start = sittingStarts(now(open, nothingAnswered));
  expect(sittingView(start, now(open, nothingAnswered))).toMatchObject({
    k: 1,
    n: 3,
    question: A,
    condition: { kind: "unanswered" },
    back: false,
    next: true,
  });
  const last = sittingMoved(sittingMoved(start, 1), 1);
  expect(sittingView(last, now(open, nothingAnswered))).toMatchObject({ k: 3, next: false });
  expect(sittingMoved(last, 1)).toEqual(last);
  expect(sittingMoved(start, -1)).toEqual(start);
});

test("answering moves to the next unanswered question after it, wrapping round", () => {
  const open = [A, B, C];
  let sitting = sittingMoved(sittingStarts(now(open, nothingAnswered)), 1);
  let state = sending(nothingAnswered, B, "no").state;
  sitting = sittingAnswered(sitting, now(open, state));
  expect(sittingView(sitting, now(open, state)).question).toEqual(C);
  state = sending(state, C, "maybe").state;
  sitting = sittingAnswered(sitting, now(open, state));
  expect(sittingView(sitting, now(open, state)).question).toEqual(A);
  state = sending(state, A, "yes").state;
  sitting = sittingAnswered(sitting, now(open, state));
  // Nothing is left unanswered: the cursor stays where it is.
  expect(sittingView(sitting, now(open, state))).toMatchObject({
    question: A,
    condition: { kind: "answered", said: "Sending yes to vm-mk…", sending: true },
  });
});

test("a question arriving while the dialog is open joins it, and the dialog moves to it from a question it cannot answer", () => {
  const first = sending(nothingAnswered, A, "yes");
  let sitting = sittingStarts(now([A], nothingAnswered));
  sitting = sittingAnswered(sitting, now([A], first.state));
  sitting = sittingSees(sitting, now([A, B], first.state));
  expect(sittingView(sitting, now([A, B], first.state))).toMatchObject({ k: 2, n: 2, question: B });
});

test("an arrival leaves the dialog where it is while that question can still be answered", () => {
  let sitting = sittingStarts(now([A], nothingAnswered));
  sitting = sittingSees(sitting, now([A, B], nothingAnswered));
  expect(sittingView(sitting, now([A, B], nothingAnswered))).toMatchObject({ k: 1, n: 2 });
});

test("a question answered elsewhere stays, as no longer open; one this dialog answered still reads answered", () => {
  const confirmed = (() => {
    const a = sending(shownBy(nothingAnswered, [A, B]), A, "yes");
    return answerTried(a.state, keyOf(A), a.answer, true);
  })();
  let sitting = sittingStarts(now([A, B], nothingAnswered));
  sitting = sittingAnswered(sitting, now([A, B], confirmed));
  // The board drops both: A because its answer landed, B because it was answered elsewhere.
  const settled = shownBy(confirmed, []);
  sitting = sittingSees(sitting, now([], settled));
  const shown = (k: number) =>
    sittingView(sittingMoved(sitting, k - 1 - sitting.cursor), now([], settled));
  expect(shown(1)).toMatchObject({ n: 2, condition: { kind: "answered", said: "Answered yes" } });
  expect(shown(2)).toMatchObject({ n: 2, condition: { kind: "gone" } });
});

test("an answer still sending when its question leaves the board reads no longer open, not answered", () => {
  const a = sending(shownBy(nothingAnswered, [A, B]), A, "yes");
  let sitting = sittingStarts(now([A, B], nothingAnswered));
  sitting = sittingAnswered(sitting, now([A, B], a.state));
  // Another client answered A, so the board drops it before this send's refusal arrives.
  const settled = shownBy(a.state, [B]);
  const refused = answerTried(settled, keyOf(A), a.answer, false);
  sitting = sittingSees(sitting, now([B], refused));
  const onA = sittingMoved(sitting, -sitting.cursor);
  expect(sittingView(onA, now([B], refused))).toMatchObject({
    question: A,
    condition: { kind: "gone" },
  });
});

test("a failed answer gives its question its controls back, and brings the dialog to it", () => {
  const a = sending(nothingAnswered, A, "yes");
  let sitting = sittingStarts(now([A, B], nothingAnswered));
  sitting = sittingAnswered(sitting, now([A, B], a.state));
  const b = sending(a.state, B, "no");
  sitting = sittingAnswered(sitting, now([A, B], b.state));
  expect(sitting.cursor).toBe(1);
  const failed = answerTried(b.state, keyOf(A), a.answer, false);
  sitting = sittingSees(sitting, now([A, B], failed));
  expect(sittingView(sitting, now([A, B], failed))).toMatchObject({
    question: A,
    condition: { kind: "unanswered" },
    done: false,
  });
});

test("a Try again makes its question answered again without moving the dialog", () => {
  const a = sending(nothingAnswered, A, "yes");
  const failed = answerTried(a.state, keyOf(A), a.answer, false);
  let sitting = sittingStarts(now([A, B], failed));
  sitting = sittingMoved(sitting, 1);
  const retried = answerTried(failed, keyOf(A), a.answer, null);
  sitting = sittingSees(sitting, now([A, B], retried));
  expect(sitting.cursor).toBe(1);
  expect(sittingView(sittingMoved(sitting, -1), now([A, B], retried)).condition).toEqual({
    kind: "answered",
    said: "Sending yes to vm-mk…",
    sending: true,
  });
});

test("the sitting is done only once nothing is unanswered and nothing is still sending", () => {
  const a = sending(nothingAnswered, A, "yes");
  let sitting = sittingStarts(now([A], nothingAnswered));
  expect(sittingView(sitting, now([A], nothingAnswered)).done).toBe(false);
  sitting = sittingAnswered(sitting, now([A], a.state));
  expect(sittingView(sitting, now([A], a.state)).done).toBe(false);
  const confirmed = answerTried(a.state, keyOf(A), a.answer, true);
  expect(sittingView(sittingSees(sitting, now([A], confirmed)), now([A], confirmed)).done).toBe(
    true,
  );
});

test("closed and reopened while an answer is sending, the dialog waits for it, and closes once it is confirmed", () => {
  const a = sending(shownBy(nothingAnswered, [A, B]), A, "yes");
  // Reopened: A is still sending.
  let sitting = sittingStarts(now([A, B], a.state));
  expect(sittingView(sitting, now([A, B], a.state))).toMatchObject({ k: 2, question: B });
  expect(sittingView(sittingMoved(sitting, -1), now([A, B], a.state)).condition).toEqual({
    kind: "answered",
    said: "Sending yes to vm-mk…",
    sending: true,
  });
  const b = sending(a.state, B, "no");
  sitting = sittingAnswered(sitting, now([A, B], b.state));
  const bConfirmed = answerTried(b.state, keyOf(B), b.answer, true);
  sitting = sittingSees(sitting, now([A, B], bConfirmed));
  expect(sittingView(sitting, now([A, B], bConfirmed))).toMatchObject({ question: B, done: false });

  const aConfirmed = answerTried(bConfirmed, keyOf(A), a.answer, true);
  expect(
    sittingView(sittingSees(sitting, now([A, B], aConfirmed)), now([A, B], aConfirmed)).done,
  ).toBe(true);
  // A leaving the board does too.
  const aGone = shownBy(bConfirmed, [B]);
  expect(sittingView(sittingSees(sitting, now([B], aGone)), now([B], aGone)).done).toBe(true);
});

test("closed and reopened while an answer is sending, its failure brings the reopened dialog to it", () => {
  const a = sending(nothingAnswered, A, "yes");
  const typed = draftTyped(a.state, keyOf(A), "yes");
  let sitting = sittingStarts(now([A, B], typed));
  const b = sending(typed, B, "no");
  sitting = sittingAnswered(sitting, now([A, B], b.state));
  const bConfirmed = answerTried(b.state, keyOf(B), b.answer, true);
  sitting = sittingSees(sitting, now([A, B], bConfirmed));
  const aFailed = answerTried(bConfirmed, keyOf(A), a.answer, false);
  sitting = sittingSees(sitting, now([A, B], aFailed));
  expect(sittingView(sitting, now([A, B], aFailed))).toMatchObject({
    k: 1,
    question: A,
    condition: { kind: "unanswered" },
    done: false,
  });
  expect(draftOf(aFailed, keyOf(A))).toBe("yes");
});

test("a draft starts empty per question, is kept through a failure, and is dropped once confirmed or gone", () => {
  expect(draftOf(nothingAnswered, keyOf(A))).toBe("");
  const shown = shownBy(nothingAnswered, [A, B]);
  const typed = draftTyped(draftTyped(shown, keyOf(A), "half"), keyOf(B), "other");
  expect(draftOf(typed, keyOf(A))).toBe("half");
  const a = sending(typed, A, "half");
  expect(draftOf(answerTried(a.state, keyOf(A), a.answer, false), keyOf(A))).toBe("half");
  const confirmed = answerTried(a.state, keyOf(A), a.answer, true);
  expect(draftOf(confirmed, keyOf(A))).toBe("");
  expect(draftOf(confirmed, keyOf(B))).toBe("other");
  expect(draftOf(shownBy(typed, [A]), keyOf(B))).toBe("");
  expect(draftOf(shownBy(typed, [A]), keyOf(A))).toBe("half");
});

test("a sitting's question is the one the board shows now, and N never shrinks", () => {
  const sitting: Sitting = sittingStarts(now([A, B, C], nothingAnswered));
  const after = sittingSees(sitting, now([C], nothingAnswered));
  expect(sittingView(after, now([C], nothingAnswered)).n).toBe(3);
});
