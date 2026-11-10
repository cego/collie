// The questionnaire a card's dialog and the record's Flow decision draw: each row is a
// question, the events Desktop feeds it, and what the human then sees and what is sent.
// Written as tables so the Rune view's reducer can be checked against them row by row.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { describe, expect, test } from "bun:test";
import type { Question } from "../src/board-model";
import {
  type Effect as Does,
  type Event,
  HOLD,
  type Stepped,
  questionnaire,
  questionnaireView,
  stepped,
} from "../desktop/src/shared/questionnaire";

const choice = (overrides: Partial<Question> = {}): Question => ({
  kind: "question",
  run: "r-1",
  id: "pick",
  step: "decide",
  topic: "pick",
  text: "Which database?",
  options: [
    {
      id: "pg",
      title: "Postgres",
      subtitle: null,
      detail: "Ops already runs it.",
      recommended: true,
    },
    { id: "sqlite", title: "SQLite", subtitle: null, detail: "No server." },
    { id: "jsonl", title: "Keep the JSONL file", subtitle: null },
  ],
  steer: { agent: "r-1-build-r1", why: null },
  ...overrides,
});

const TWO = choice({
  options: [
    { id: "go", title: "Go on", subtitle: null, recommended: true },
    { id: "stop", title: "Stop", subtitle: null },
  ],
  hold: { offered: true, why: null },
});
const HELD = choice({ ...TWO, hold: { offered: false, why: "Run already held" } });
const WORDS = choice({ id: "team", text: "Which team?", options: [], steer: undefined });
const LEGACY = choice({
  id: "first",
  text: "Which database should the ledger use?",
  options: [
    { id: "Go", title: "Go", subtitle: null },
    { id: "Wait", title: "Wait", subtitle: null },
  ],
  steer: undefined,
});
const NO_AGENT = choice({
  steer: {
    agent: null,
    why: "no agent of this Run is live to redirect: pick a solution or stop the Run",
  },
});

const key = (name: string, mod = false, where: "group" | "steer" | "answer" = "group"): Event => ({
  kind: "key",
  key: name,
  mod,
  where,
});

/** The events in order from a freshly opened question; the last step's effect with it. */
const run = (question: Question, events: ReadonlyArray<Event>) => {
  const opened: Stepped = { state: questionnaire(question), does: null };
  return Arr.reduce(events, opened, ({ state }, event) => stepped(state, event));
};
const viewAfter = (question: Question, events: ReadonlyArray<Event>) =>
  questionnaireView(run(question, events).state);
const checked = (question: Question, events: ReadonlyArray<Event>) =>
  Arr.map(
    Arr.filter(viewAfter(question, events).rows, (row) => row.checked),
    (row) => row.id,
  );

describe("order and selection", () => {
  test.each([
    {
      rule: "solutions in the host's order, the hold row last, nothing checked",
      question: TWO,
      rows: [
        { id: "go", title: "Go on", recommended: true, checked: false, disabled: false },
        { id: "stop", title: "Stop", recommended: false, checked: false, disabled: false },
        { id: HOLD, title: "Hold the Run", recommended: false, checked: false, disabled: false },
      ],
    },
    {
      rule: "a recommended solution authored later is not moved up",
      question: choice({
        options: [
          { id: "a", title: "A", subtitle: null },
          { id: "b", title: "B", subtitle: null, recommended: true },
          { id: "c", title: "C", subtitle: null },
        ],
      }),
      rows: [
        { id: "a", title: "A", recommended: false, checked: false, disabled: false },
        { id: "b", title: "B", recommended: true, checked: false, disabled: false },
        { id: "c", title: "C", recommended: false, checked: false, disabled: false },
      ],
    },
  ])("$rule", ({ question, rows }) => {
    expect(
      Arr.map(questionnaireView(questionnaire(question)).rows, (row) => ({
        id: row.id,
        title: row.title,
        recommended: row.recommended,
        checked: row.checked,
        disabled: row.disabled,
      })),
    ).toEqual([...rows]);
    expect(questionnaireView(questionnaire(question)).focus).toBe(0);
  });

  test.each([
    {
      rule: "the same question seen again keeps the selection",
      events: [
        { kind: "pick", id: "sqlite" },
        { kind: "seen", question: choice() },
      ],
      checked: ["sqlite"],
    },
    {
      rule: "a revision clears the selection",
      events: [
        { kind: "pick", id: "sqlite" },
        { kind: "seen", question: choice({ id: "pick-2" }) },
      ],
      checked: [],
    },
    {
      rule: "the selected option vanishing clears the selection",
      events: [
        { kind: "pick", id: "sqlite" },
        {
          kind: "seen",
          question: choice({ options: Arr.filter(choice().options, (one) => one.id !== "sqlite") }),
        },
      ],
      checked: [],
    },
    {
      rule: "another option vanishing keeps the selection",
      events: [
        { kind: "pick", id: "pg" },
        {
          kind: "seen",
          question: choice({ options: Arr.filter(choice().options, (one) => one.id !== "jsonl") }),
        },
      ],
      checked: ["pg"],
    },
  ] satisfies ReadonlyArray<{ rule: string; events: Event[]; checked: string[] }>)(
    "$rule",
    ({ events, checked: expected }) => {
      expect(checked(choice(), events)).toEqual(expected);
    },
  );
});

describe("submit", () => {
  test.each([
    { rule: "disabled with nothing selected", question: choice(), events: [], submit: false },
    {
      rule: "enabled with a selection",
      question: choice(),
      events: [{ kind: "pick", id: "pg" }],
      submit: true,
    },
    {
      rule: "disabled while the answer is in flight",
      question: choice(),
      events: [
        { kind: "pick", id: "pg" },
        { kind: "submit", request: "q-1" },
      ],
      submit: false,
    },
    {
      rule: "enabled again after a refusal, the selection kept",
      question: choice(),
      events: [
        { kind: "pick", id: "pg" },
        { kind: "submit", request: "q-1" },
        { kind: "replied", request: "q-1", ok: false, refused: true, reason: "no" },
      ],
      submit: true,
    },
    {
      rule: "disabled once answered",
      question: choice(),
      events: [
        { kind: "pick", id: "pg" },
        { kind: "submit", request: "q-1" },
        { kind: "replied", request: "q-1", ok: true, fresh: true },
      ],
      submit: false,
    },
    {
      rule: "a value input takes words, not blanks",
      question: WORDS,
      events: [{ kind: "type", text: "  \n " }],
      submit: false,
    },
    {
      rule: "a value input with words",
      question: WORDS,
      events: [{ kind: "type", text: "platform" }],
      submit: true,
    },
  ] satisfies ReadonlyArray<{
    rule: string;
    question: Question;
    events: Event[];
    submit: boolean;
  }>)("$rule", ({ question, events, submit }) => {
    expect(viewAfter(question, events).submit).toBe(submit);
  });

  test.each([
    {
      rule: "an answer names the option's id",
      question: choice(),
      events: [{ kind: "pick", id: "sqlite" }],
      request: "q-1",
      does: {
        kind: "send",
        request: "q-1",
        action: { _tag: "Answer", runId: "r-1", decision: "pick", value: "sqlite" },
      },
    },
    {
      rule: "Hold the Run holds through the control, giving the question",
      question: TWO,
      events: [{ kind: "pick", id: HOLD }],
      request: "q-1",
      does: {
        kind: "send",
        request: "q-1",
        action: {
          _tag: "Control",
          runId: "r-1",
          control: "hold",
          set: true,
          reason: "held at question pick",
        },
      },
    },
    {
      rule: "a value input sends the words trimmed",
      question: WORDS,
      events: [{ kind: "type", text: " platform " }],
      request: "q-1",
      does: {
        kind: "send",
        request: "q-1",
        action: { _tag: "Answer", runId: "r-1", decision: "team", value: "platform" },
      },
    },
    {
      rule: "nothing is sent with nothing selected",
      question: choice(),
      events: [],
      request: "q-1",
      does: null,
    },
  ] satisfies ReadonlyArray<{
    rule: string;
    question: Question;
    events: Event[];
    request: string;
    does: Does | null;
  }>)("$rule", ({ question, events, request, does }) => {
    expect(run(question, [...events, { kind: "submit", request }]).does).toEqual(does);
  });
});

describe("the request an answer goes under", () => {
  const requestOf = (events: ReadonlyArray<Event>) => {
    const { does } = run(choice(), events);
    return does?.kind === "send" ? does.request : null;
  };
  test.each([
    {
      rule: "a retry after the connection failed reuses the request",
      events: [
        { kind: "pick", id: "pg" },
        { kind: "submit", request: "q-1" },
        {
          kind: "replied",
          request: "q-1",
          ok: false,
          refused: false,
          reason: "vm-mk's connection was renewed",
        },
        { kind: "submit", request: "q-2" },
      ],
      request: "q-1",
    },
    {
      rule: "a second click while nothing replied reuses the request",
      events: [
        { kind: "pick", id: "pg" },
        { kind: "submit", request: "q-1" },
        { kind: "replied", request: "q-1", ok: false, refused: false, reason: "did not confirm" },
        { kind: "submit", request: "q-2" },
        { kind: "replied", request: "q-1", ok: false, refused: false, reason: "did not confirm" },
        { kind: "submit", request: "q-3" },
      ],
      request: "q-1",
    },
    {
      rule: "a new submit after a refusal is a new request",
      events: [
        { kind: "pick", id: "pg" },
        { kind: "submit", request: "q-1" },
        {
          kind: "replied",
          request: "q-1",
          ok: false,
          refused: true,
          reason: "no longer an option",
        },
        { kind: "submit", request: "q-2" },
      ],
      request: "q-2",
    },
    {
      rule: "another selection after a failure is a new request",
      events: [
        { kind: "pick", id: "pg" },
        { kind: "submit", request: "q-1" },
        { kind: "replied", request: "q-1", ok: false, refused: false, reason: "renewed" },
        { kind: "pick", id: "sqlite" },
        { kind: "submit", request: "q-2" },
      ],
      request: "q-2",
    },
  ] satisfies ReadonlyArray<{ rule: string; events: Event[]; request: string }>)(
    "$rule",
    ({ events, request }) => {
      expect(requestOf(events)).toBe(request);
    },
  );
});

describe("keyboard", () => {
  test.each([
    {
      rule: "Down from nothing checks the next row",
      events: [key("ArrowDown")],
      checked: ["sqlite"],
      focus: 1,
    },
    {
      rule: "Right moves as Down does",
      events: [key("ArrowRight")],
      checked: ["sqlite"],
      focus: 1,
    },
    {
      rule: "Up from the first wraps to the last",
      events: [key("ArrowUp")],
      checked: ["jsonl"],
      focus: 2,
    },
    { rule: "Left moves as Up does", events: [key("ArrowLeft")], checked: ["jsonl"], focus: 2 },
    {
      rule: "Down from the last wraps to the first",
      events: [key("End"), key("ArrowDown")],
      checked: ["pg"],
      focus: 0,
    },
    { rule: "End checks the last", events: [key("End")], checked: ["jsonl"], focus: 2 },
    { rule: "Home checks the first", events: [key("End"), key("Home")], checked: ["pg"], focus: 0 },
    { rule: "Space checks the focused row", events: [key(" ")], checked: ["pg"], focus: 0 },
    {
      rule: "Enter alone in the group checks nothing",
      events: [key("Enter")],
      checked: [],
      focus: 0,
    },
  ] satisfies ReadonlyArray<{ rule: string; events: Event[]; checked: string[]; focus: number }>)(
    "$rule",
    ({ events, checked: expected, focus }) => {
      expect(checked(choice(), events)).toEqual(expected);
      expect(viewAfter(choice(), events).focus).toBe(focus);
    },
  );

  test("arrows pass over Hold the Run where it is shown disabled", () => {
    expect(checked(HELD, [key("ArrowDown"), key("ArrowDown")])).toEqual(["go"]);
    expect(checked(HELD, [key("End")])).toEqual(["stop"]);
    expect(checked(HELD, [key("ArrowDown"), key("ArrowDown"), { kind: "pick", id: HOLD }])).toEqual(
      ["go"],
    );
  });

  test.each([
    {
      rule: "Ctrl/Cmd+Enter in the group submits a selection",
      events: [key("ArrowDown"), key("Enter", true)],
      does: { kind: "submit" },
    },
    {
      rule: "Ctrl/Cmd+Enter in the group with nothing selected does nothing",
      events: [key("Enter", true)],
      does: null,
    },
    {
      rule: "Ctrl/Cmd+Enter in the steering field sends its words",
      events: [{ kind: "draft", text: "use a schema" }, key("Enter", true, "steer")],
      does: { kind: "steer" },
    },
    {
      rule: "Enter alone in the steering field sends nothing",
      events: [{ kind: "draft", text: "use a schema" }, key("Enter", false, "steer")],
      does: { kind: "swallow" },
    },
    {
      rule: "Ctrl/Cmd+Enter in a blank steering field sends nothing",
      events: [{ kind: "draft", text: " \t" }, key("Enter", true, "steer")],
      does: { kind: "swallow" },
    },
    {
      rule: "Enter in a value input's field submits its words",
      events: [{ kind: "type", text: "platform" }, key("Enter", false, "answer")],
      does: { kind: "submit" },
      question: WORDS,
    },
    { rule: "Esc closes", events: [key("Escape")], does: { kind: "close" } },
  ] satisfies ReadonlyArray<{
    rule: string;
    events: Event[];
    does: Does | null;
    question?: Question;
  }>)("$rule", ({ events, does, question }) => {
    expect(run(question ?? choice(), events).does).toEqual(does);
  });

  test("Esc keeps the selection and the draft", () => {
    const events: Event[] = [
      key("ArrowDown"),
      { kind: "draft", text: "use a schema" },
      key("Escape"),
    ];
    expect(checked(choice(), events)).toEqual(["sqlite"]);
    expect(viewAfter(choice(), events).steer.draft).toBe("use a schema");
  });
});

describe("steering", () => {
  test.each([
    {
      rule: "the asking agent is named, and words send to it",
      question: choice(),
      events: [{ kind: "draft", text: "use the ops Postgres" }],
      steer: { shown: true, disabled: false, why: null, send: true, label: "Send to r-1-build-r1" },
    },
    {
      rule: "whitespace-only words are not sent",
      question: choice(),
      events: [{ kind: "draft", text: "  \n\t" }],
      steer: {
        shown: true,
        disabled: false,
        why: null,
        send: false,
        label: "Send to r-1-build-r1",
      },
    },
    {
      rule: "no live agent: shown disabled with the host's reason",
      question: NO_AGENT,
      events: [{ kind: "draft", text: "use the ops Postgres" }],
      steer: {
        shown: true,
        disabled: true,
        why: "no agent of this Run is live to redirect: pick a solution or stop the Run",
        send: false,
        label: "Send",
      },
    },
    {
      rule: "an older host names no target: the words go to the Run's agent at work",
      question: LEGACY,
      events: [{ kind: "draft", text: "wait for ops" }],
      steer: { shown: true, disabled: false, why: null, send: true, label: "Send" },
    },
  ] satisfies ReadonlyArray<{
    rule: string;
    question: Question;
    events: Event[];
    steer: {
      shown: boolean;
      disabled: boolean;
      why: string | null;
      send: boolean;
      label: string;
    };
  }>)("$rule", ({ question, events, steer }) => {
    const shown = viewAfter(question, events).steer;
    expect({
      shown: true,
      disabled: shown.disabled,
      why: shown.why,
      send: shown.send,
      label: shown.label,
    }).toEqual(steer);
  });

  test.each([
    {
      rule: "to the agent the host names",
      question: choice(),
      text: " use the ops Postgres ",
      does: {
        kind: "send",
        request: "s-1",
        action: {
          _tag: "Deliver",
          runId: "r-1",
          agent: "r-1-build-r1",
          text: "use the ops Postgres",
        },
      },
    },
    {
      rule: "to the agent at work where the host names none",
      question: LEGACY,
      text: "wait for ops",
      does: {
        kind: "send",
        request: "s-1",
        action: { _tag: "Deliver", runId: "r-1", text: "wait for ops" },
      },
    },
    { rule: "never blank", question: choice(), text: "   ", does: null },
    { rule: "never with no live agent", question: NO_AGENT, text: "go", does: null },
  ] satisfies ReadonlyArray<{ rule: string; question: Question; text: string; does: Does | null }>)(
    "$rule",
    ({ question, text, does }) => {
      expect(
        run(question, [
          { kind: "draft", text },
          { kind: "steer", request: "s-1" },
        ]).does,
      ).toEqual(does);
    },
  );
});

describe("hold", () => {
  test.each([
    {
      rule: "offered: a row that can be picked",
      question: TWO,
      hold: { id: HOLD, title: "Hold the Run", disabled: false, why: null },
    },
    {
      rule: "unavailable: shown disabled with the host's reason",
      question: HELD,
      hold: { id: HOLD, title: "Hold the Run", disabled: true, why: "Run already held" },
    },
    { rule: "not a path: no row", question: choice(), hold: undefined },
  ])("$rule", ({ question, hold }) => {
    const row = Option.getOrUndefined(
      Arr.findFirst(questionnaireView(questionnaire(question)).rows, (one) => one.id === HOLD),
    );
    expect(
      row === undefined
        ? undefined
        : { id: row.id, title: row.title, disabled: row.disabled, why: row.why },
    ).toEqual(hold);
  });
});

describe("status", () => {
  test.each([
    { rule: "nothing sent yet", question: choice(), events: [], status: null },
    {
      rule: "sending",
      question: choice(),
      events: [
        { kind: "pick", id: "pg" },
        { kind: "submit", request: "q-1" },
      ],
      status: "Sending…",
    },
    {
      rule: "confirmed",
      question: choice(),
      events: [
        { kind: "pick", id: "pg" },
        { kind: "submit", request: "q-1" },
        { kind: "replied", request: "q-1", ok: true, fresh: true },
      ],
      status: "Answered: Postgres",
    },
    {
      rule: "a reply the host had already taken reads answered too",
      question: choice(),
      events: [
        { kind: "pick", id: "pg" },
        { kind: "submit", request: "q-1" },
        { kind: "replied", request: "q-1", ok: true, fresh: false },
      ],
      status: "Answered: Postgres",
    },
    {
      rule: "refused: the host's reason",
      question: choice(),
      events: [
        { kind: "pick", id: "pg" },
        { kind: "submit", request: "q-1" },
        {
          kind: "replied",
          request: "q-1",
          ok: false,
          refused: true,
          reason: '"pick" was already answered "sqlite" by cli',
        },
      ],
      status: '"pick" was already answered "sqlite" by cli',
    },
    {
      rule: "held: the question stays open",
      question: TWO,
      events: [
        { kind: "pick", id: HOLD },
        { kind: "submit", request: "q-1" },
        { kind: "replied", request: "q-1", ok: true, fresh: true },
      ],
      status: "Run held · question still open",
    },
    {
      rule: "steered: the question is set aside",
      question: choice(),
      events: [
        { kind: "draft", text: "use a schema" },
        { kind: "steer", request: "s-1" },
        { kind: "replied", request: "s-1", ok: true, fresh: true },
      ],
      status: "Sent to r-1-build-r1; the question is set aside",
    },
    {
      rule: "replaced while open: no longer open",
      question: choice(),
      events: [
        { kind: "pick", id: "pg" },
        { kind: "seen", question: null },
      ],
      status: "No longer open",
    },
    {
      rule: "answered, then gone from the board: still answered",
      question: choice(),
      events: [
        { kind: "pick", id: "pg" },
        { kind: "submit", request: "q-1" },
        { kind: "replied", request: "q-1", ok: true, fresh: true },
        { kind: "seen", question: null },
      ],
      status: "Answered: Postgres",
    },
  ] satisfies ReadonlyArray<{
    rule: string;
    question: Question;
    events: Event[];
    status: string | null;
  }>)("$rule", ({ question, events, status }) => {
    expect(viewAfter(question, events).status).toBe(status);
  });

  test.each([
    {
      rule: "a reply to a request no longer pending changes nothing",
      question: TWO,
      events: [
        { kind: "pick", id: "go" },
        { kind: "submit", request: "q-1" },
        { kind: "replied", request: "q-1", ok: false, refused: false, reason: "renewed" },
        { kind: "pick", id: "stop" },
        { kind: "submit", request: "q-2" },
        { kind: "trying", request: "q-1" },
        { kind: "replied", request: "q-1", ok: true, fresh: true },
      ],
      status: "Sending…",
    },
    {
      rule: "the pending request's own refusal is still shown after a stale reply",
      question: TWO,
      events: [
        { kind: "pick", id: "go" },
        { kind: "submit", request: "q-1" },
        { kind: "replied", request: "q-1", ok: false, refused: false, reason: "renewed" },
        { kind: "pick", id: "stop" },
        { kind: "submit", request: "q-2" },
        { kind: "replied", request: "q-1", ok: true, fresh: true },
        {
          kind: "replied",
          request: "q-2",
          ok: false,
          refused: true,
          reason: '"pick" was already answered "go" by Desktop',
        },
      ],
      status: '"pick" was already answered "go" by Desktop',
    },
    {
      rule: "Try again under the kept request shows sending, and its reply settles it",
      question: choice(),
      events: [
        { kind: "pick", id: "pg" },
        { kind: "submit", request: "q-1" },
        { kind: "replied", request: "q-1", ok: false, refused: false, reason: "renewed" },
        { kind: "trying", request: "q-1" },
      ],
      status: "Sending…",
    },
    {
      rule: "Try again's success reads answered",
      question: choice(),
      events: [
        { kind: "pick", id: "pg" },
        { kind: "submit", request: "q-1" },
        { kind: "replied", request: "q-1", ok: false, refused: false, reason: "renewed" },
        { kind: "trying", request: "q-1" },
        { kind: "replied", request: "q-1", ok: true, fresh: false },
      ],
      status: "Answered: Postgres",
    },
    {
      rule: "Try again of a hold reads held",
      question: TWO,
      events: [
        { kind: "pick", id: HOLD },
        { kind: "submit", request: "h-1" },
        { kind: "replied", request: "h-1", ok: false, refused: false, reason: "renewed" },
        { kind: "trying", request: "h-1" },
        { kind: "replied", request: "h-1", ok: true, fresh: true },
      ],
      status: "Run held · question still open",
    },
    {
      rule: "Try again of a steer reads steered",
      question: choice(),
      events: [
        { kind: "draft", text: "use a schema" },
        { kind: "steer", request: "s-1" },
        { kind: "replied", request: "s-1", ok: false, refused: false, reason: "renewed" },
        { kind: "trying", request: "s-1" },
        { kind: "replied", request: "s-1", ok: true, fresh: true },
      ],
      status: "Sent to r-1-build-r1; the question is set aside",
    },
    {
      rule: "the board dropping a question while its answer is in flight still hears the reply",
      question: choice(),
      events: [
        { kind: "pick", id: "pg" },
        { kind: "submit", request: "q-1" },
        { kind: "seen", question: null },
        { kind: "replied", request: "q-1", ok: true, fresh: true },
      ],
      status: "Answered: Postgres",
    },
    {
      rule: "the board dropping a question while its answer is in flight shows the refusal",
      question: choice(),
      events: [
        { kind: "pick", id: "pg" },
        { kind: "submit", request: "q-1" },
        { kind: "seen", question: null },
        { kind: "replied", request: "q-1", ok: false, refused: true, reason: "superseded" },
      ],
      status: "superseded",
    },
    {
      rule: "a refusal heard off the board survives the board's next refresh",
      question: choice(),
      events: [
        { kind: "pick", id: "pg" },
        { kind: "submit", request: "q-1" },
        { kind: "seen", question: null },
        { kind: "replied", request: "q-1", ok: false, refused: true, reason: "superseded" },
        { kind: "seen", question: null },
      ],
      status: "superseded",
    },
    {
      rule: "a hold refused off the board survives the board's next refresh",
      question: TWO,
      events: [
        { kind: "pick", id: HOLD },
        { kind: "submit", request: "h-1" },
        { kind: "seen", question: null },
        { kind: "replied", request: "h-1", ok: false, refused: true, reason: "r-1 is finished" },
        { kind: "seen", question: null },
      ],
      status: "r-1 is finished",
    },
    {
      rule: "a steer refused off the board survives the board's next refresh",
      question: choice(),
      events: [
        { kind: "draft", text: "use a schema" },
        { kind: "steer", request: "s-1" },
        { kind: "seen", question: null },
        { kind: "replied", request: "s-1", ok: false, refused: true, reason: "no such agent" },
        { kind: "seen", question: null },
      ],
      status: "no such agent",
    },
    {
      rule: "a steer in flight when the question leaves the board reads steered once confirmed",
      question: choice(),
      events: [
        { kind: "draft", text: "use a schema" },
        { kind: "steer", request: "s-1" },
        { kind: "seen", question: null },
        { kind: "replied", request: "s-1", ok: true, fresh: true },
      ],
      status: "Sent to r-1-build-r1; the question is set aside",
    },
    {
      rule: "steered, then gone from the board: still steered",
      question: choice(),
      events: [
        { kind: "draft", text: "use a schema" },
        { kind: "steer", request: "s-1" },
        { kind: "replied", request: "s-1", ok: true, fresh: true },
        { kind: "seen", question: null },
      ],
      status: "Sent to r-1-build-r1; the question is set aside",
    },
  ] satisfies ReadonlyArray<{
    rule: string;
    question: Question;
    events: Event[];
    status: string | null;
  }>)("$rule", ({ question, events, status }) => {
    expect(viewAfter(question, events).status).toBe(status);
  });

  const answers: Event[] = [
    { kind: "pick", id: "go" },
    { kind: "submit", request: "r" },
  ];
  const holds: Event[] = [
    { kind: "pick", id: HOLD },
    { kind: "submit", request: "r" },
  ];
  const steers: Event[] = [
    { kind: "draft", text: "use a schema" },
    { kind: "steer", request: "r" },
  ];
  const refused: Event = {
    kind: "replied",
    request: "r",
    ok: false,
    refused: true,
    reason: '"pick" was already answered "stop" by cli',
  };
  const dropped: Event = {
    kind: "replied",
    request: "r",
    ok: false,
    refused: false,
    reason: "connection renewed",
  };
  const confirmed: Event = { kind: "replied", request: "r", ok: true, fresh: true };
  const gone: Event = { kind: "seen", question: null };

  test.each([
    {
      rule: "an answer refused, then the board drops it and refreshes: the host's reason",
      events: [...answers, refused, gone, gone],
      status: '"pick" was already answered "stop" by cli',
    },
    {
      rule: "a hold refused, then the board drops it and refreshes: the host's reason",
      events: [...holds, refused, gone, gone],
      status: '"pick" was already answered "stop" by cli',
    },
    {
      rule: "a steer refused, then the board drops it and refreshes: the host's reason",
      events: [...steers, refused, gone, gone],
      status: '"pick" was already answered "stop" by cli',
    },
    {
      rule: "an answer whose connection failed, then the board drops it: the failure",
      events: [...answers, dropped, gone, gone],
      status: "connection renewed",
    },
    {
      rule: "the board drops it, then the connection fails: the failure",
      events: [...answers, gone, dropped, gone],
      status: "connection renewed",
    },
    {
      rule: "the board drops it, the connection fails, and Try again is answered",
      events: [...answers, gone, dropped, gone, { kind: "trying", request: "r" }, confirmed, gone],
      status: "Answered: Go on",
    },
    {
      rule: "the board drops it, then a stale reply comes: the newer request still sends",
      events: [
        ...answers,
        dropped,
        { kind: "pick", id: "stop" },
        { kind: "submit", request: "r-2" },
        gone,
        confirmed,
      ],
      status: "Sending…",
    },
    {
      rule: "a hold confirmed, then the board drops it: no longer open",
      events: [...holds, confirmed, gone],
      status: "No longer open",
    },
    {
      rule: "a steer confirmed, then the board drops it and refreshes: still steered",
      events: [...steers, confirmed, gone, gone],
      status: "Sent to r-1-build-r1; the question is set aside",
    },
    {
      rule: "nothing sent, dropped, then back on the board: open again",
      events: [gone, { kind: "seen", question: TWO }],
      status: null,
    },
  ] satisfies ReadonlyArray<{ rule: string; events: Event[]; status: string | null }>)(
    "$rule",
    ({ events, status }) => {
      expect(viewAfter(TWO, events).status).toBe(status);
    },
  );

  test("a refusal heard before the board drops it takes nothing more", () => {
    const after = run(TWO, [...answers, refused, gone, { kind: "pick", id: "stop" }]);
    expect(questionnaireView(after.state).submit).toBe(false);
    expect(stepped(after.state, { kind: "submit", request: "r-2" }).does).toBeNull();
  });

  test("a question off the board takes nothing more once its send settles", () => {
    const events: Event[] = [
      { kind: "pick", id: "pg" },
      { kind: "submit", request: "q-1" },
      { kind: "seen", question: null },
      { kind: "replied", request: "q-1", ok: false, refused: true, reason: "superseded" },
      { kind: "draft", text: "anything" },
    ];
    expect(viewAfter(choice(), events).submit).toBe(false);
    expect(viewAfter(choice(), events).steer.send).toBe(false);
  });

  test("a refusal keeps the selection visible and sends nothing again", () => {
    const events: Event[] = [
      { kind: "pick", id: "pg" },
      { kind: "submit", request: "q-1" },
      { kind: "replied", request: "q-1", ok: false, refused: true, reason: "superseded" },
    ];
    expect(checked(choice(), events)).toEqual(["pg"]);
    expect(run(choice(), events).does).toBeNull();
  });

  test("held, the question can still be answered", () => {
    const events: Event[] = [
      { kind: "pick", id: HOLD },
      { kind: "submit", request: "q-1" },
      { kind: "replied", request: "q-1", ok: true, fresh: true },
      { kind: "seen", question: HELD },
      { kind: "pick", id: "go" },
    ];
    expect(viewAfter(TWO, events).submit).toBe(true);
    expect(viewAfter(TWO, events).status).toBe("Run held · question still open");
  });
});

describe("legacy and value inputs", () => {
  test.each([
    {
      rule: "plain titles: rows with no badge and no Hold",
      question: LEGACY,
      view: { words: false, rows: ["Go", "Wait"], recommended: [], shortfall: null },
    },
    {
      rule: "no options: the prompt and a text answer, no badge, no Hold",
      question: WORDS,
      view: { words: true, rows: [], recommended: [], shortfall: null },
    },
    {
      rule: "a question posted short says so",
      question: choice({ shortfall: "this workflow recommended none" }),
      view: {
        words: false,
        rows: ["Postgres", "SQLite", "Keep the JSONL file"],
        recommended: ["pg"],
        shortfall: "this workflow recommended none",
      },
    },
  ])("$rule", ({ question, view }) => {
    const shown = questionnaireView(questionnaire(question));
    expect({
      words: shown.words,
      rows: Arr.map(shown.rows, (row) => row.title),
      recommended: Arr.map(
        Arr.filter(shown.rows, (row) => row.recommended),
        (row) => row.id,
      ),
      shortfall: shown.shortfall,
    }).toEqual({ ...view, rows: [...view.rows], recommended: [...view.recommended] });
  });

  test("a legacy title answers by its title, and a value input by its words", () => {
    expect(
      run(LEGACY, [
        { kind: "pick", id: "Wait" },
        { kind: "submit", request: "q-1" },
      ]).does,
    ).toEqual({
      kind: "send",
      request: "q-1",
      action: { _tag: "Answer", runId: "r-1", decision: "first", value: "Wait" },
    });
    expect(viewAfter(WORDS, [{ kind: "draft", text: "x" }]).steer.disabled).toBe(false);
  });
});
