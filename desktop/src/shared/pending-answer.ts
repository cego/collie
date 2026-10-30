// A card's questions and answers in flight; no Bun-only import, as the view bundles this.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import type { Decision, Question, TaskView } from "../../../src/board-model";

export interface InFlight {
  /** The option's title or the typed value. */
  readonly shown: string;
  readonly machine: string;
  /** Whether the host has replied that it took it. */
  readonly confirmed: boolean;
  /** Which send this is, so a try of one a newer answer replaced changes nothing. */
  readonly send: number;
}

/** View-wide, keyed by `answerKey`; nothing here is written to a host. */
export interface Answering {
  readonly answers: ReadonlyMap<string, InFlight>;
  /** The newest send per question. */
  readonly latest: ReadonlyMap<string, number>;
  readonly drafts: ReadonlyMap<string, string>;
}

export const nothingAnswered: Answering = {
  answers: new Map(),
  latest: new Map(),
  drafts: new Map(),
};

export const answerKey = (installation: string, runId: string, questionId: string) =>
  `${installation}\u0000${runId}\u0000${questionId}`;

const without = <A>(map: ReadonlyMap<string, A>, key: string) => {
  const next = new Map(map);
  next.delete(key);
  return next;
};
const withOne = <A>(map: ReadonlyMap<string, A>, key: string, value: A) =>
  new Map(map).set(key, value);

/** A new answer to a question, sending, which replaces any earlier one to it. */
export const answerSent = (
  state: Answering,
  key: string,
  sent: Omit<InFlight, "confirmed">,
): Answering => ({
  ...state,
  answers: withOne(state.answers, key, { ...sent, confirmed: false }),
  latest: withOne(state.latest, key, sent.send),
});

/** A try of `sent` starting (null), confirmed, or failed. */
export const answerTried = (
  state: Answering,
  key: string,
  sent: Omit<InFlight, "confirmed">,
  done: boolean | null,
): Answering => {
  if (state.latest.get(key) !== sent.send) return state;
  if (done === false) return { ...state, answers: without(state.answers, key) };
  return {
    ...state,
    answers: withOne(state.answers, key, { ...sent, confirmed: done === true }),
    drafts: done === true ? without(state.drafts, key) : state.drafts,
  };
};

export const draftOf = (state: Answering, key: string) => state.drafts.get(key) ?? "";
export const draftTyped = (state: Answering, key: string, text: string): Answering => ({
  ...state,
  drafts: withOne(state.drafts, key, text),
});

/** Drops what is held for each question no Task on the Flock's board has open. */
export const answersSettled = (
  state: Answering,
  board: ReadonlyArray<{ readonly installation: string; readonly task: QuestionsOf }>,
): Answering => {
  const open = new Set(
    Arr.flatMap(board, ({ installation, task }) =>
      Arr.map(openQuestions(task), (asked) => answerKey(installation, asked.run, asked.id)),
    ),
  );
  const held = [...state.answers.keys(), ...state.latest.keys(), ...state.drafts.keys()];
  if (Arr.every(held, (key) => open.has(key))) return state;
  const settle = <A>(map: ReadonlyMap<string, A>) =>
    new Map(Arr.filter([...map], ([key]) => open.has(key)));
  return {
    answers: settle(state.answers),
    latest: settle(state.latest),
    drafts: settle(state.drafts),
  };
};

type QuestionsOf = Pick<TaskView, "decision"> & { readonly questions?: ReadonlyArray<Question> };

/** A card's open questions; an older host lists none, so its question decision stands alone. */
export const openQuestions = (task: QuestionsOf): ReadonlyArray<Question> =>
  task.questions ?? (task.decision?.kind === "question" ? [task.decision] : []);

const sendingSaid = (answer: InFlight) =>
  answer.confirmed
    ? `Answered ${answer.shown}; waiting for ${answer.machine}'s board`
    : `Sending ${answer.shown} to ${answer.machine}…`;

/**
 * The card's question block: the text, and the Answer button's label or, with every open
 * question's answer in flight, the pending line. Null where its decision is no question.
 */
export const cardQuestion = (
  task: { readonly decision: Decision | null; readonly questions?: ReadonlyArray<Question> },
  installation: string,
  state: Answering,
) => {
  if (task.decision?.kind !== "question") return null;
  const open = openQuestions(task);
  const answerOf = (asked: Question) =>
    state.answers.get(answerKey(installation, asked.run, asked.id));
  const unanswered = Arr.filter(open, (asked) => answerOf(asked) === undefined);
  const text = (unanswered[0] ?? open[0] ?? task.decision).text;
  if (unanswered.length > 0 || open.length === 0)
    return {
      text,
      label: unanswered.length > 1 ? `Answer ${unanswered.length} questions…` : "Answer…",
      pending: null,
    };
  const answers = Arr.map(open, (asked) => answerOf(asked)!);
  const machine = answers[0]!.machine;
  return {
    text,
    label: null,
    pending:
      answers.length === 1
        ? sendingSaid(answers[0]!)
        : Arr.some(answers, (answer) => !answer.confirmed)
          ? `Sending ${answers.length} answers to ${machine}…`
          : `Answered ${answers.length} questions; waiting for ${machine}'s board`,
  };
};

export type Condition =
  | { readonly kind: "unanswered" }
  | { readonly kind: "answered"; readonly said: string; readonly sending: boolean }
  | { readonly kind: "gone" };

export interface SittingEntry {
  /** As last seen on the board, so it is still drawn after it leaves. */
  readonly question: Question;
  /** The last answer the sitting saw in flight for it. */
  readonly seen: Pick<InFlight, "shown" | "machine" | "confirmed"> | null;
  readonly was: Condition["kind"];
}

/** One opening of the dialog: its questions, which never leave it, and where it is. */
export interface Sitting {
  readonly entries: ReadonlyArray<SittingEntry>;
  readonly cursor: number;
}

/** The board and the answers as they stand. */
export interface Now {
  readonly installation: string;
  readonly open: ReadonlyArray<Question>;
  readonly answering: Answering;
}

const sameQuestion = (one: Question, other: Question) =>
  one.run === other.run && one.id === other.id;

const conditionOf = (entry: SittingEntry, now: Now): Condition => {
  const open = Arr.some(now.open, (asked) => sameQuestion(asked, entry.question));
  const answer = now.answering.answers.get(
    answerKey(now.installation, entry.question.run, entry.question.id),
  );
  if (open && answer !== undefined)
    return { kind: "answered", said: sendingSaid(answer), sending: !answer.confirmed };
  if (open) return { kind: "unanswered" };
  return entry.seen?.confirmed !== true
    ? { kind: "gone" }
    : { kind: "answered", said: `Answered ${entry.seen.shown}`, sending: false };
};

/** Each entry as the board and answers have it now, and the questions new to the board. */
const refreshed = (entries: ReadonlyArray<SittingEntry>, now: Now) =>
  Arr.map(
    [
      ...entries,
      ...Arr.map(
        Arr.filter(
          now.open,
          (asked) => !Arr.some(entries, (entry) => sameQuestion(entry.question, asked)),
        ),
        (question): SittingEntry => ({ question, seen: null, was: "gone" }),
      ),
    ],
    (entry): SittingEntry => {
      const question = Option.getOrUndefined(
        Arr.findFirst(now.open, (asked) => sameQuestion(asked, entry.question)),
      );
      if (question === undefined) return entry;
      const answer = now.answering.answers.get(
        answerKey(now.installation, question.run, question.id),
      );
      return {
        question,
        seen:
          answer === undefined
            ? null
            : { shown: answer.shown, machine: answer.machine, confirmed: answer.confirmed },
        was: entry.was,
      };
    },
  );

const settledWas = (entries: ReadonlyArray<SittingEntry>, now: Now) =>
  Arr.map(entries, (entry) => ({ ...entry, was: conditionOf(entry, now).kind }));

/** The card's open questions, on the first that is unanswered. */
export const sittingStarts = (now: Now): Sitting => {
  const entries = settledWas(refreshed([], now), now);
  return {
    entries,
    cursor: Math.max(
      0,
      Option.getOrElse(
        Arr.findFirstIndex(entries, (entry) => entry.was === "unanswered"),
        () => -1,
      ),
    ),
  };
};

/**
 * The board or the answers changed: arrivals join, and from a question it cannot answer the
 * dialog moves to the first that has just become answerable.
 */
export const sittingSees = (sitting: Sitting, now: Now): Sitting => {
  const entries = refreshed(sitting.entries, now);
  const current = entries[sitting.cursor];
  const answerable = (entry: SittingEntry) =>
    entry.was !== "unanswered" && conditionOf(entry, now).kind === "unanswered";
  const moveTo =
    current !== undefined && conditionOf(current, now).kind !== "unanswered"
      ? Option.getOrElse(Arr.findFirstIndex(entries, answerable), () => -1)
      : -1;
  return { entries: settledWas(entries, now), cursor: moveTo === -1 ? sitting.cursor : moveTo };
};

/** The question at the cursor was just answered: on to the next unanswered, wrapping round. */
export const sittingAnswered = (sitting: Sitting, now: Now): Sitting => {
  const entries = settledWas(refreshed(sitting.entries, now), now);
  const order = Arr.map(entries, (_, at) => (sitting.cursor + 1 + at) % entries.length);
  const next = Option.getOrUndefined(
    Arr.findFirst(order, (at) => entries[at]!.was === "unanswered"),
  );
  return { entries, cursor: next ?? sitting.cursor };
};

/** Back (-1) or Next (1), which never wrap. */
export const sittingMoved = (sitting: Sitting, by: number): Sitting => ({
  ...sitting,
  cursor: Math.min(Math.max(sitting.cursor + by, 0), Math.max(sitting.entries.length - 1, 0)),
});

/** What the dialog draws: "Question k of N", the question, its condition, and whether it is done. */
export const sittingView = (sitting: Sitting, now: Now) => {
  const entry = sitting.entries[sitting.cursor];
  const conditions = Arr.map(sitting.entries, (one) => conditionOf(one, now));
  return {
    k: sitting.cursor + 1,
    n: sitting.entries.length,
    question: entry?.question ?? null,
    condition: entry === undefined ? null : conditionOf(entry, now),
    back: sitting.cursor > 0,
    next: sitting.cursor < sitting.entries.length - 1,
    done: Arr.every(
      conditions,
      (condition) =>
        condition.kind === "gone" || (condition.kind === "answered" && !condition.sending),
    ),
  };
};
