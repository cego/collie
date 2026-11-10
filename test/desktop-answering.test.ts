import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import type { Question } from "../src/board-model";
import { ActionFailed, type DesktopAction } from "../desktop/src/shared/flock";
import { HOLD, questionnaireView } from "../desktop/src/shared/questionnaire";
import { type Act, useAnswering } from "../desktop/view/app/composables/useAnswering";

const asked = (id: string): Question => ({
  kind: "question",
  run: "r-1",
  id,
  step: "decide",
  topic: id,
  text: "Go on?",
  options: [
    { id: "go", title: "Go on", subtitle: null, recommended: true },
    { id: "stop", title: "Stop", subtitle: null },
  ],
  hold: { offered: true, why: null },
  steer: { agent: "r-1-build-r1", why: null },
});
const boardOf = (installation: string, ...questions: Question[]) => [
  { installation, task: { decision: questions[0] ?? null, questions } },
];

/** An act whose replies the test gives, one per try, and the actions it was handed. */
const replying = () => {
  const sent: DesktopAction[] = [];
  let reply: Parameters<Act>[2] = () => {};
  const act: Act = (action, _request, tried) => {
    sent.push(action);
    tried(null);
    reply = tried;
    return Promise.resolve(true);
  };
  return { act, sent, reply: (...args: Parameters<Parameters<Act>[2]>) => reply(...args) };
};

const REFUSAL = '"decide" was already answered "stop" by cli';
const refuse = new ActionFailed({ reason: REFUSAL, refused: true });

test.each(["Answer", "Hold", "Deliver"] as const)(
  "a refused %s keeps the host's reason whether the board drops the question before or after it",
  (kind) => {
    for (const order of ["reply first", "removal first"] as const) {
      const installation = `${kind} ${order}`;
      const question = asked("decide");
      const answering = useAnswering();
      const { act, sent, reply } = replying();
      answering.settle(boardOf(installation, question));
      const first =
        kind === "Deliver"
          ? { kind: "draft" as const, text: "use a schema" }
          : { kind: "pick" as const, id: kind === "Hold" ? HOLD : "go" };
      answering.step(installation, "mk-pc", question, first, act);
      answering.step(
        installation,
        "mk-pc",
        question,
        kind === "Deliver" ? { kind: "steer", request: "s-1" } : { kind: "submit", request: "s-1" },
        act,
      );
      if (order === "removal first") answering.settle(boardOf(installation));
      reply(false, refuse);
      answering.settle(boardOf(installation));
      answering.settle(boardOf(installation));
      const view = questionnaireView(answering.of(installation, question));
      expect({ order, status: view.status, submit: view.submit }).toEqual({
        order,
        status: REFUSAL,
        submit: false,
      });
      expect(Arr.map(sent, (action) => action._tag)).toEqual([kind === "Hold" ? "Control" : kind]);
    }
  },
);

test("a question replaced while its answer is in flight settles, and its replacement opens empty", () => {
  const installation = "replaced";
  const before = asked("decide");
  const revised = asked("decide-2");
  const answering = useAnswering();
  const { act, reply } = replying();
  answering.settle(boardOf(installation, before));
  answering.step(installation, "mk-pc", before, { kind: "pick", id: "go" }, act);
  answering.step(installation, "mk-pc", before, { kind: "submit", request: "s-1" }, act);
  answering.settle(boardOf(installation, revised));
  reply(true);
  answering.settle(boardOf(installation, revised));
  expect(questionnaireView(answering.of(installation, before)).status).toBe("Answered: Go on");
  const opened = questionnaireView(answering.of(installation, revised));
  expect({ status: opened.status, checked: Arr.filter(opened.rows, (row) => row.checked) }).toEqual(
    {
      status: null,
      checked: [],
    },
  );
});

test("a question gone from the board before its first gesture sends nothing", () => {
  const installation = "gone untouched";
  const question = asked("decide");
  const answering = useAnswering();
  const { act, sent } = replying();
  answering.settle(boardOf(installation, question));
  answering.settle(boardOf(installation));
  for (const event of [
    { kind: "pick", id: "go" },
    { kind: "submit", request: "s-1" },
    { kind: "pick", id: HOLD },
    { kind: "submit", request: "s-2" },
    { kind: "draft", text: "use a schema" },
    { kind: "steer", request: "s-3" },
  ] as const)
    answering.step(installation, "mk-pc", question, event, act);
  expect(questionnaireView(answering.of(installation, question)).status).toBe("No longer open");
  expect(sent).toEqual([]);
});

test("of two tries of one answer, a failed one leaves the confirmed one standing", () => {
  const installation = "overlapping tries";
  const question = asked("decide");
  const answering = useAnswering();
  const { act, reply } = replying();
  answering.settle(boardOf(installation, question));
  answering.step(installation, "mk-pc", question, { kind: "pick", id: "go" }, act);
  answering.step(installation, "mk-pc", question, { kind: "submit", request: "s-1" }, act);
  reply(null);
  reply(false, new ActionFailed({ reason: "connection renewed", refused: false }));
  reply(true);
  expect(questionnaireView(answering.of(installation, question)).status).toBe("Answered: Go on");
});

test("a question that returns to the board after a gesture made while it was gone opens again", () => {
  const installation = "returns";
  const question = asked("decide");
  const answering = useAnswering();
  const { act, sent } = replying();
  answering.settle(boardOf(installation, question));
  answering.settle(boardOf(installation));
  answering.step(installation, "mk-pc", question, { kind: "pick", id: "go" }, act);
  answering.settle(boardOf(installation, question));
  answering.step(installation, "mk-pc", question, { kind: "pick", id: "go" }, act);
  answering.step(installation, "mk-pc", question, { kind: "submit", request: "s-1" }, act);
  expect(Arr.map(sent, (action) => action._tag)).toEqual(["Answer"]);
});
