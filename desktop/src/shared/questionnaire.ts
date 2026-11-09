// One question as a questionnaire: what is checked, what Submit and the steering entry
// send, and the status line. The dialog and the Flow decision only draw it; no Bun-only
// import, as the view bundles this.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import type { Question } from "../../../src/board-model";
import type { DesktopAction } from "./flock";

/** The row id of Hold the Run, which no host option can take. */
export const HOLD = "\u0000hold";

type Status =
  | { readonly kind: "open" }
  | { readonly kind: "sending" }
  | { readonly kind: "answered"; readonly title: string }
  | { readonly kind: "held" }
  | { readonly kind: "steered" }
  | { readonly kind: "failed"; readonly reason: string }
  | { readonly kind: "gone" };

export interface Questionnaire {
  readonly question: Question;
  readonly checked: string | null;
  readonly focus: number;
  /** A value input's words. */
  readonly typed: string;
  readonly draft: string;
  /** What is in flight, or was and may be tried again: one request until the host settles it. */
  readonly pending: {
    readonly request: string;
    readonly sends: string;
    readonly answer: string | null;
  } | null;
  readonly status: Status;
  /** Whether the board still asks it; a send in flight is still settled by its reply. */
  readonly onBoard: boolean;
}

export type Event =
  | { readonly kind: "seen"; readonly question: Question | null }
  | { readonly kind: "pick"; readonly id: string }
  | {
      readonly kind: "key";
      readonly key: string;
      /** Ctrl, or Cmd on a Mac. */
      readonly mod: boolean;
      readonly where: "group" | "steer" | "answer";
    }
  | { readonly kind: "type"; readonly text: string }
  | { readonly kind: "draft"; readonly text: string }
  | { readonly kind: "submit"; readonly request: string }
  | { readonly kind: "steer"; readonly request: string }
  /** A try of `request` starting, as Try again starts one. */
  | { readonly kind: "trying"; readonly request: string }
  | {
      readonly kind: "replied";
      readonly request: string;
      readonly ok: true;
      readonly fresh: boolean;
    }
  | {
      readonly kind: "replied";
      readonly request: string;
      readonly ok: false;
      /** The host said no, so the same request would be refused again. */
      readonly refused: boolean;
      readonly reason: string;
    };

export type Effect =
  | { readonly kind: "send"; readonly request: string; readonly action: DesktopAction }
  /** A key asking for Submit or Send, which then takes a request. */
  | { readonly kind: "submit" }
  | { readonly kind: "steer" }
  | { readonly kind: "close" }
  /** A key that must do nothing, not even its default. */
  | { readonly kind: "swallow" };

/** A questionnaire after one event, and what that event asks Desktop to do. */
export interface Stepped {
  readonly state: Questionnaire;
  readonly does: Effect | null;
}

export const questionnaire = (question: Question): Questionnaire => ({
  question,
  checked: null,
  focus: 0,
  typed: "",
  draft: "",
  pending: null,
  status: { kind: "open" },
  onBoard: true,
});

interface Row {
  readonly id: string;
  readonly title: string;
  readonly detail: string | null;
  readonly recommended: boolean;
  readonly disabled: boolean;
  readonly why: string | null;
}

const rowsOf = (question: Question): ReadonlyArray<Row> => [
  ...Arr.map(question.options, (option) => ({
    id: option.id,
    title: option.title,
    detail: option.detail ?? option.subtitle,
    recommended: option.recommended === true,
    disabled: false,
    why: null,
  })),
  ...(question.hold === undefined || question.options.length === 0
    ? []
    : [
        {
          id: HOLD,
          title: "Hold the Run",
          detail: "Answers nothing; the question stays open until you release.",
          recommended: false,
          disabled: !question.hold.offered,
          why: question.hold.why,
        },
      ]),
];

const inFlight = (state: Questionnaire) => state.status.kind === "sending";
const settled = (state: Questionnaire) =>
  !state.onBoard || state.status.kind === "answered" || state.status.kind === "gone";

const submission = (state: Questionnaire) => {
  if (inFlight(state) || settled(state)) return null;
  if (state.question.options.length === 0) {
    const words = Str.trim(state.typed);
    return words === "" ? null : words;
  }
  return state.checked;
};

const target = (state: Questionnaire) => {
  const steer = state.question.steer;
  return steer === undefined
    ? { agent: undefined, why: null }
    : { agent: steer.agent ?? null, why: steer.why };
};
const steerable = (state: Questionnaire) =>
  !inFlight(state) &&
  !settled(state) &&
  target(state).agent !== null &&
  Str.trim(state.draft) !== "";

const sent = (state: Questionnaire, sends: string, answer: string | null, request: string) => {
  const kept = state.pending?.sends === sends ? state.pending.request : request;
  return {
    state: { ...state, pending: { request: kept, sends, answer }, status: { kind: "sending" } },
    request: kept,
  } as const;
};

const actionFor = (state: Questionnaire, value: string): DesktopAction =>
  value === HOLD
    ? {
        _tag: "Control",
        runId: state.question.run,
        control: "hold",
        set: true,
        reason: `held at question ${state.question.id}`,
      }
    : { _tag: "Answer", runId: state.question.run, decision: state.question.id, value };

const titleOf = (state: Questionnaire, value: string) =>
  Option.getOrUndefined(Arr.findFirst(state.question.options, (option) => option.id === value))
    ?.title ?? value;

const moved = (state: Questionnaire, to: (rows: ReadonlyArray<Row>, from: number) => number) => {
  const rows = rowsOf(state.question);
  const enabled = Arr.filter(
    Arr.map(rows, (row, at) => ({ row, at })),
    ({ row }) => !row.disabled,
  );
  if (enabled.length === 0) return state;
  const from = Option.getOrElse(
    Arr.findFirstIndex(rows, (row) => row.id === state.checked),
    () => state.focus,
  );
  const at = to(rows, from);
  return { ...state, checked: rows[at]!.id, focus: at };
};

const stepThrough = (by: number) => (rows: ReadonlyArray<Row>, from: number) => {
  let at = from;
  do at = (at + by + rows.length) % rows.length;
  while (rows[at]!.disabled);
  return at;
};
const firstEnabled = (rows: ReadonlyArray<Row>) =>
  Option.getOrElse(
    Arr.findFirstIndex(rows, (row) => !row.disabled),
    () => 0,
  );
const lastEnabled = (rows: ReadonlyArray<Row>) =>
  Option.getOrElse(
    Arr.findLastIndex(rows, (row) => !row.disabled),
    () => 0,
  );

const keyed = (state: Questionnaire, event: Extract<Event, { kind: "key" }>): Stepped => {
  if (event.key === "Escape") return { state, does: { kind: "close" } };
  if (event.where === "steer")
    return event.key === "Enter"
      ? { state, does: event.mod && steerable(state) ? { kind: "steer" } : { kind: "swallow" } }
      : { state, does: null };
  if (event.key === "Enter")
    return {
      state,
      does:
        (event.mod || event.where === "answer") && submission(state) !== null
          ? { kind: "submit" }
          : null,
    };
  if (event.where === "answer") return { state, does: null };
  switch (event.key) {
    case "ArrowDown":
    case "ArrowRight":
      return { state: moved(state, stepThrough(1)), does: null };
    case "ArrowUp":
    case "ArrowLeft":
      return { state: moved(state, stepThrough(-1)), does: null };
    case "Home":
      return { state: moved(state, firstEnabled), does: null };
    case "End":
      return { state: moved(state, lastEnabled), does: null };
    case " ": {
      const row = rowsOf(state.question)[state.focus];
      return {
        state: row === undefined || row.disabled ? state : { ...state, checked: row.id },
        does: null,
      };
    }
    default:
      return { state, does: null };
  }
};

const replied = (state: Questionnaire, event: Extract<Event, { kind: "replied" }>) => {
  const pending = state.pending;
  if (!inFlight(state) || pending?.request !== event.request) return state;
  if (!event.ok)
    return {
      ...state,
      pending: event.refused ? null : pending,
      status: { kind: "failed", reason: event.reason } as const,
    };
  if (pending.answer === null)
    return {
      ...state,
      pending: null,
      draft: "",
      status: { kind: "steered" } as const,
    };
  return {
    ...state,
    pending: null,
    status:
      pending.answer === HOLD
        ? ({ kind: "held" } as const)
        : ({ kind: "answered", title: titleOf(state, pending.answer) } as const),
  };
};

const seen = (state: Questionnaire, question: Question | null): Questionnaire => {
  if (question === null) {
    // Already off the board: what its send came to stays shown.
    if (!state.onBoard) return state;
    const kind = state.status.kind;
    return kind === "sending" || kind === "answered" || kind === "steered"
      ? { ...state, onBoard: false }
      : { ...state, onBoard: false, status: { kind: "gone" } };
  }
  if (question.run !== state.question.run || question.id !== state.question.id)
    return questionnaire(question);
  const rows = rowsOf(question);
  const kept = Arr.some(rows, (row) => row.id === state.checked && !row.disabled);
  return {
    ...state,
    question,
    onBoard: true,
    checked: kept ? state.checked : null,
    focus: Math.min(state.focus, Math.max(rows.length - 1, 0)),
  };
};

export const stepped = (state: Questionnaire, event: Event): Stepped => {
  switch (event.kind) {
    case "seen":
      return { state: seen(state, event.question), does: null };
    case "pick": {
      const at = Arr.findFirstIndex(rowsOf(state.question), (row) => row.id === event.id);
      const row = Option.isSome(at) ? rowsOf(state.question)[at.value] : undefined;
      return {
        state:
          row === undefined || row.disabled || inFlight(state) || settled(state)
            ? state
            : { ...state, checked: row.id, focus: at.pipe(Option.getOrElse(() => 0)) },
        does: null,
      };
    }
    case "key":
      return keyed(state, event);
    case "type":
      return { state: { ...state, typed: event.text }, does: null };
    case "draft":
      return { state: { ...state, draft: event.text }, does: null };
    case "submit": {
      const value = submission(state);
      if (value === null) return { state, does: null };
      const go = sent(state, `answer:${value}`, value, event.request);
      return {
        state: go.state,
        does: { kind: "send", request: go.request, action: actionFor(state, value) },
      };
    }
    case "steer": {
      if (!steerable(state)) return { state, does: null };
      const text = Str.trim(state.draft);
      const go = sent(state, `steer:${text}`, null, event.request);
      const agent = target(state).agent;
      return {
        state: go.state,
        does: {
          kind: "send",
          request: go.request,
          action:
            agent === undefined || agent === null
              ? { _tag: "Deliver", runId: state.question.run, text }
              : { _tag: "Deliver", runId: state.question.run, agent, text },
        },
      };
    }
    case "trying":
      return {
        state:
          state.pending?.request === event.request
            ? { ...state, status: { kind: "sending" } }
            : state,
        does: null,
      };
    case "replied":
      return { state: replied(state, event), does: null };
  }
};

const statusSaid = (state: Questionnaire) => {
  const status = state.status;
  switch (status.kind) {
    case "open":
      return null;
    case "sending":
      return "Sending…";
    case "answered":
      return `Answered: ${status.title}`;
    case "held":
      return "Run held · question still open";
    case "steered":
      return `Sent to ${target(state).agent ?? "the Run's agent"}; the question is set aside`;
    case "failed":
      return status.reason;
    case "gone":
      return "No longer open";
  }
};

export const questionnaireView = (state: Questionnaire) => {
  const { agent, why } = target(state);
  return {
    text: state.question.text,
    shortfall: state.question.shortfall ?? null,
    /** A value input: a text answer instead of rows. */
    words: state.question.options.length === 0,
    rows: Arr.map(rowsOf(state.question), (row) => ({ ...row, checked: row.id === state.checked })),
    focus: state.focus,
    typed: state.typed,
    submit: submission(state) !== null,
    steer: {
      draft: state.draft,
      disabled: agent === null,
      why,
      send: steerable(state),
      label: agent === undefined || agent === null ? "Send" : `Send to ${agent}`,
    },
    status: statusSaid(state),
    sending: inFlight(state),
    /** Answered, or gone from the board: nothing more to send. */
    settled: settled(state) && !inFlight(state),
  };
};
