// What self-improve measures of the questions its window's Runs asked.

import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { questionMeasures, repeatedAnswers, type AskingRun } from "../workflows/retrospective";

const asking = (over: Partial<AskingRun> & { runId: string }): AskingRun => ({
  workflow: "implement",
  status: "complete",
  mr: null,
  merged: false,
  questions: [],
  ...over,
});

const asked = (name: string, answer: string | null) => ({ name, answer });

test("questions per landed merge request count every question over the distinct merge requests that merged", () => {
  const measures = questionMeasures([
    asking({ runId: "a", mr: "https://mr/1", merged: true, questions: [asked("next", "Finish")] }),
    asking({
      runId: "b",
      workflow: "release",
      mr: "https://mr/1",
      merged: true,
      questions: [asked("go-1", "Merge"), asked("go-2", null)],
    }),
    asking({ runId: "c", mr: "https://mr/2", merged: true }),
    asking({ runId: "d", workflow: "plan", questions: [asked("approve", "Build it")] }),
    asking({ runId: "e", mr: "https://mr/3" }),
  ]);
  expect(measures.asked).toBe(4);
  expect(measures.landed).toBe(2);
  expect(measures.perLanded).toBe(2);
});

test("with nothing landed there is no per merge request figure, rather than a division by zero", () => {
  expect(questionMeasures([asking({ runId: "a", questions: [asked("next", "x")] })])).toMatchObject(
    {
      asked: 1,
      landed: 0,
      perLanded: null,
    },
  );
});

test("an implement Run reached its merge request when it recorded one and did not fail; one still going without one is not counted", () => {
  const measures = questionMeasures([
    asking({ runId: "reached", mr: "https://mr/1" }),
    asking({ runId: "waiting-at-mr", status: "suspended", mr: "https://mr/2" }),
    asking({ runId: "failed-after", status: "failed", mr: "https://mr/3" }),
    asking({ runId: "failed-before", status: "failed" }),
    asking({ runId: "ended-without", status: "complete" }),
    asking({ runId: "still-building", status: "pending" }),
    asking({ runId: "plan", workflow: "plan", mr: "https://mr/4" }),
  ]);
  expect(measures.implement).toEqual({ reached: 2, of: 5 });
});

const answers = (workflow: string, name: string, list: ReadonlyArray<string | null>) =>
  Arr.map(list, (answer, index) =>
    asking({ runId: `${workflow}-${name}-${index}`, workflow, questions: [asked(name, answer)] }),
  );

test("a question class answered the same at least nine times in ten over ten askings is a finding about Collie", () => {
  const runs = answers("implement", "next", [...Arr.replicate("Release", 9), "Finish"]);
  const [finding, ...rest] = repeatedAnswers(runs);
  expect(rest).toEqual([]);
  expect(finding).toMatchObject({
    key: "repeated-answer-implement-next",
    category: "defect",
    issue: null,
    records: [],
  });
  expect(finding?.runs).toEqual(Arr.map(runs, ({ runId }) => runId));
  expect(finding?.title).toContain('"Release"');
  expect(finding?.body).toContain("9 of 10");
});

test("numbered askings of one question are one class, wherever in the Run they were asked", () => {
  const runs = Arr.map(Arr.range(0, 9), (index) =>
    asking({
      runId: `r${index}`,
      workflow: "release",
      questions: [asked(index % 2 === 0 ? `go-${index}` : `slice-0${index}.go-1`, "Merge")],
    }),
  );
  expect(Arr.map(repeatedAnswers(runs), ({ key }) => key)).toEqual(["repeated-answer-release-go"]);
});

test("under either threshold, or with the same name in another workflow, there is no finding", () => {
  expect(repeatedAnswers(answers("implement", "next", Arr.replicate("Release", 9)))).toEqual([]);
  expect(
    repeatedAnswers(
      answers("implement", "next", [...Arr.replicate("Release", 8), "Finish", "Finish"]),
    ),
  ).toEqual([]);
  expect(
    repeatedAnswers([
      ...answers("implement", "next", Arr.replicate("Release", 5)),
      ...answers("plan", "next", Arr.replicate("Release", 5)),
    ]),
  ).toEqual([]);
});

test("a question still open is not an answer, so it counts toward neither threshold", () => {
  expect(
    repeatedAnswers(answers("implement", "next", [...Arr.replicate("Release", 9), null, null])),
  ).toEqual([]);
});
