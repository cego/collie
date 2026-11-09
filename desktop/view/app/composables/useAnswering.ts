// Answers in flight and each question's questionnaire, shared by every card and dialog for
// as long as Desktop runs.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { shallowRef } from "vue";
import type { Question } from "../../../../src/board-model";
import type { DesktopAction } from "../../../src/shared/flock";
import type { failureOf } from "../../../src/shared/actions";
import {
  type Answering,
  answerKey,
  answerSent,
  answersSettled,
  answerTried,
  nothingAnswered,
  openQuestions,
} from "../../../src/shared/pending-answer";
import {
  type Event,
  type Questionnaire,
  questionnaire,
  stepped,
} from "../../../src/shared/questionnaire";

/** Carries one action under `request`, hearing each try start (null) and end. */
export type Act = (
  action: DesktopAction,
  request: string,
  tried: (done: boolean | null, failed?: ReturnType<typeof failureOf>) => void,
) => Promise<boolean>;

const state = shallowRef<Answering>(nothingAnswered);
const asking = shallowRef<ReadonlyMap<string, Questionnaire>>(new Map());
let sends = 0;

const titleOf = (question: Question, action: DesktopAction) =>
  action._tag === "Answer"
    ? (Option.getOrUndefined(
        Arr.findFirst(question.options, (option) => option.id === action.value),
      )?.title ?? action.value)
    : "";

export const useAnswering = () => {
  const of = (installation: string, question: Question) =>
    asking.value.get(answerKey(installation, question.run, question.id)) ?? questionnaire(question);
  const put = (installation: string, question: Question, next: Questionnaire) =>
    (asking.value = new Map(asking.value).set(
      answerKey(installation, question.run, question.id),
      next,
    ));
  const apply = (installation: string, question: Question, event: Event) => {
    const { state: next, does } = stepped(of(installation, question), event);
    put(installation, question, next);
    return does;
  };

  return {
    state,
    asking,
    of,
    /**
     * Feeds the questionnaire one event, and carries what it sends through `act` under the
     * request it keeps; an answer also shows on its card while it is in flight.
     */
    step: (installation: string, machine: string, question: Question, event: Event, act: Act) => {
      const does = apply(installation, question, event);
      if (does?.kind !== "send") return does;
      const key = answerKey(installation, question.run, question.id);
      const answer =
        does.action._tag === "Answer"
          ? { shown: titleOf(question, does.action), machine, send: ++sends }
          : null;
      if (answer !== null) state.value = answerSent(state.value, key, answer);
      void act(does.action, does.request, (done, failed) => {
        if (answer !== null) state.value = answerTried(state.value, key, answer, done);
        if (done === null) return;
        apply(
          installation,
          question,
          done
            ? { kind: "replied", ok: true, fresh: true }
            : {
                kind: "replied",
                ok: false,
                refused: failed?.refused === true,
                reason: failed?.reason ?? "",
              },
        );
      });
      return does;
    },
    /** Called with every Task on the Flock's board, wherever it is drawn. */
    settle: (board: Parameters<typeof answersSettled>[1]) => {
      state.value = answersSettled(state.value, board);
      const open = new Map(
        Arr.flatMap(board, ({ installation, task }) =>
          Arr.map(
            openQuestions(task),
            (question) => [answerKey(installation, question.run, question.id), question] as const,
          ),
        ),
      );
      const seen = new Map(
        Arr.map([...asking.value], ([key, one]) => {
          const question = open.get(key) ?? null;
          return [
            key,
            question === one.question ? one : stepped(one, { kind: "seen", question }).state,
          ] as const;
        }),
      );
      asking.value = seen;
    },
  };
};
