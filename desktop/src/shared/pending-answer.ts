import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import type { Decision, Question, TaskView } from "../../../src/board-model";

export interface InFlight {
  readonly shown: string;
  readonly machine: string;
  readonly confirmed: boolean;
  readonly send: number;
}

export interface Answering {
  readonly answers: ReadonlyMap<string, InFlight>;
  readonly latest: ReadonlyMap<string, number>;
}

export const nothingAnswered: Answering = {
  answers: new Map(),
  latest: new Map(),
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

export const answerSent = (state: Answering, key: string, sent: Omit<InFlight, "confirmed">) => ({
  ...state,
  answers: withOne(state.answers, key, { ...sent, confirmed: false }),
  latest: withOne(state.latest, key, sent.send),
});

export const answerTried = (
  state: Answering,
  key: string,
  sent: Omit<InFlight, "confirmed">,
  done: boolean | null,
) => {
  if (state.latest.get(key) !== sent.send) return state;
  if (done === false) return { ...state, answers: without(state.answers, key) };
  return {
    ...state,
    answers: withOne(state.answers, key, { ...sent, confirmed: done === true }),
  };
};

export const answersSettled = (
  state: Answering,
  board: ReadonlyArray<{ readonly installation: string; readonly task: QuestionsOf }>,
) => {
  const open = new Set(
    Arr.flatMap(board, ({ installation, task }) =>
      Arr.map(openQuestions(task), (asked) => answerKey(installation, asked.run, asked.id)),
    ),
  );
  const held = [...state.answers.keys(), ...state.latest.keys()];
  if (Arr.every(held, (key) => open.has(key))) return state;
  const settle = <A>(map: ReadonlyMap<string, A>) =>
    new Map(Arr.filter([...map], ([key]) => open.has(key)));
  return {
    answers: settle(state.answers),
    latest: settle(state.latest),
  };
};

type QuestionsOf = Pick<TaskView, "decision"> & { readonly questions?: ReadonlyArray<Question> };

export const openQuestions = (task: QuestionsOf) =>
  task.questions ?? (task.decision?.kind === "question" ? [task.decision] : []);

const sendingSaid = (answer: InFlight) =>
  answer.confirmed
    ? `Answered ${answer.shown}; waiting for ${answer.machine}'s board`
    : `Sending ${answer.shown} to ${answer.machine}…`;

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
  readonly question: Question;
  readonly seen: Pick<InFlight, "shown" | "machine" | "confirmed"> | null;
  readonly was: Condition["kind"];
}

export interface Sitting {
  readonly entries: ReadonlyArray<SittingEntry>;
  readonly cursor: number;
}

export interface Now {
  readonly installation: string;
  readonly open: ReadonlyArray<Question>;
  readonly answering: Answering;
}

const sameQuestion = (one: Question, other: Question) =>
  one.run === other.run && one.id === other.id;

const conditionOf: (entry: SittingEntry, now: Now) => Condition = (entry, now) => {
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

const refreshed = (entries: ReadonlyArray<SittingEntry>, now: Now) =>
  Arr.map(
    [
      ...entries,
      ...Arr.map(
        Arr.filter(
          now.open,
          (asked) => !Arr.some(entries, (entry) => sameQuestion(entry.question, asked)),
        ),
        (question) => {
          const returned: SittingEntry = { question, seen: null, was: "gone" };
          return returned;
        },
      ),
    ],
    (entry) => {
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

export const sittingStarts: (now: Now) => Sitting = (now) => {
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

export const sittingSees = (sitting: Sitting, now: Now) => {
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

export const sittingAnswered = (sitting: Sitting, now: Now) => {
  const entries = settledWas(refreshed(sitting.entries, now), now);
  const order = Arr.map(entries, (_, at) => (sitting.cursor + 1 + at) % entries.length);
  const next = Option.getOrUndefined(
    Arr.findFirst(order, (at) => entries[at]!.was === "unanswered"),
  );
  return { entries, cursor: next ?? sitting.cursor };
};

export const sittingMoved = (sitting: Sitting, by: number) => ({
  ...sitting,
  cursor: Math.min(Math.max(sitting.cursor + by, 0), Math.max(sitting.entries.length - 1, 0)),
});

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
