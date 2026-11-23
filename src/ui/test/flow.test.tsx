import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { createSignal } from "solid-js";
import { testRender } from "@opentui/solid";
import { runEffect } from "../../../test/support/effect";
import { Flow } from "../Flow";
import type { Pending } from "../prompts";
import { filterItems, itemHay } from "../state";
import { stringifyJson } from "../../json";

const WORKFLOWS = [
  { id: "architecture", title: "architecture — look at the whole thing", subtitle: "[baseline]" },
  { id: "implement", title: "implement — build the plan", subtitle: "[baseline]" },
  { id: "plan", title: "plan — grill me first", subtitle: "[baseline]" },
  { id: "review", title: "review — look at a change", subtitle: "[project]" },
];

const mount = Effect.fn("flow.mount")(function* (ask: Pending["ask"], width = 80, height = 16) {
  const answers: Array<string | null> = [];
  const [pending] = createSignal<Pending>({ ask, answer: (value) => answers.push(value) });
  const t = yield* Effect.promise(() =>
    testRender(() => <Flow pending={pending()} />, { width, height }),
  );
  const flush = Effect.promise(() => t.flush());
  yield* flush;
  return {
    answers,
    flush,
    frame: () => t.captureCharFrame(),
    mockInput: t.mockInput,
    click: (x: number, y: number) =>
      Effect.andThen(
        Effect.promise(() => t.mockMouse.click(x, y)),
        flush,
      ),
    lineOf(text: string) {
      const y = Option.getOrElse(
        Arr.findFirstIndex(Str.split(t.captureCharFrame(), "\n"), (l) =>
          pipe(l, Str.includes(text)),
        ),
        () => -1,
      );
      if (y < 0) {
        throw new Error(`no line containing ${stringifyJson(text)}`);
      }
      return y;
    },
  };
});

function menu() {
  const returned: Pending["ask"] = {
    _tag: "Menu",
    header: "Workflows — /w/collie",
    footer: "↑↓ move · type to filter · Enter choose · Esc cancel",
    items: WORKFLOWS,
  };
  return returned;
}

test("a name prefix beats a substring, which beats characters in order", () => {
  const items = [
    {
      id: "implement",
      title: "implement — build from a plan, review in parallel",
      subtitle: "[baseline]",
    },
    { id: "plan", title: "plan — interview me", subtitle: "[baseline]" },
    { id: "review", title: "review — an MR", subtitle: "[user]" },
  ];
  const ranked = (query: string) => Arr.map(filterItems(items, query, itemHay), (i) => i.id);

  expect(ranked("plan")).toEqual(["plan", "implement"]);
  expect(ranked("review")).toEqual(["review", "implement"]);
  expect(ranked("ipm")).toEqual(["implement"]);
  expect(ranked("user")).toEqual(["review"]);
  expect(ranked("zz")).toEqual([]);
  expect(filterItems(items, "", itemHay)).toEqual(items);
});

test("the menu marks the row the cursor is on and shows what has been typed", () =>
  runEffect(
    Effect.gen(function* () {
      const flow = yield* mount({
        _tag: "Menu",
        header: "Workflows",
        footer: "Enter run",
        items: [
          { id: "plan", title: "plan", subtitle: "[baseline]" },
          { id: "review", title: "review", subtitle: "[user]" },
        ],
      });

      let lines = Str.split(flow.frame(), "\n");
      expect(lines[flow.lineOf("plan")]).toContain("❯");
      expect(lines[flow.lineOf("review")]).not.toContain("❯");

      flow.mockInput.pressArrow("down");
      yield* Effect.promise(() => flow.mockInput.typeText("re"));
      yield* flow.flush;

      lines = Str.split(flow.frame(), "\n");
      expect(lines[0]).toContain("Workflows");
      expect(lines[1]).toContain("> re");
      expect(lines[flow.lineOf("review")]).toContain("❯");
      expect(lines[flow.lineOf("review")]).toContain("[user]");
      expect(flow.frame()).not.toContain("plan");
      expect(flow.frame()).toContain("Enter run");
    }),
  ));

test("typing filters the menu and Enter chooses what the cursor is on", () =>
  runEffect(
    Effect.gen(function* () {
      const flow = yield* mount(menu());
      expect(flow.frame()).toContain("Workflows — /w/collie");
      expect(flow.frame()).toContain("architecture —");

      yield* Effect.promise(() => flow.mockInput.typeText("impl"));
      yield* flow.flush;
      const frame = flow.frame();
      expect(frame).toContain("implement — build the plan");
      expect(frame).not.toContain("architecture —");
      expect(frame).not.toContain("review —");
      expect(frame).toContain("> impl");

      flow.mockInput.pressEnter();
      yield* flow.flush;
      expect(flow.answers).toEqual(["implement"]);
    }),
  ));

test("a filter that empties the list chooses nothing rather than the wrong thing", () =>
  runEffect(
    Effect.gen(function* () {
      const flow = yield* mount(menu());

      yield* Effect.promise(() => flow.mockInput.typeText("zzz"));
      yield* flow.flush;
      expect(flow.frame()).toContain("(nothing matches)");

      flow.mockInput.pressEnter();
      yield* flow.flush;
      expect(flow.answers).toEqual([]);
    }),
  ));

test("the cursor moves, and follows the list when the filter shortens it", () =>
  runEffect(
    Effect.gen(function* () {
      const flow = yield* mount(menu());

      for (let n = 0; n < 3; n++) {
        flow.mockInput.pressArrow("down");
      }
      yield* flow.flush;
      expect(Str.split(flow.frame(), "\n")[flow.lineOf("review —")]).toContain("❯");

      yield* Effect.promise(() => flow.mockInput.typeText("grill"));
      yield* flow.flush;
      flow.mockInput.pressEnter();
      yield* flow.flush;
      expect(flow.answers).toEqual(["plan"]);
    }),
  ));

test("clicking a row answers with that row", () =>
  runEffect(
    Effect.gen(function* () {
      const flow = yield* mount(menu());

      yield* flow.click(4, flow.lineOf("review —"));

      expect(flow.answers).toEqual(["review"]);
    }),
  ));

test("a question hands back what was typed, and backspace takes it away again", () =>
  runEffect(
    Effect.gen(function* () {
      const flow = yield* mount({
        _tag: "Question",
        header: "What is the goal?",
        footer: "type an answer · Enter send · Esc cancel",
        initial: "",
      });
      expect(flow.frame()).toContain("What is the goal?");

      yield* Effect.promise(() => flow.mockInput.typeText("Add a pickerx"));
      flow.mockInput.pressBackspace();
      yield* flow.flush;
      expect(flow.frame()).toContain("> Add a picker");

      flow.mockInput.pressEnter();
      yield* flow.flush;
      expect(flow.answers).toEqual(["Add a picker"]);
    }),
  ));

test("Ctrl-C cancels a menu and a question alike, and answers nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const asMenu = yield* mount(menu());
      asMenu.mockInput.pressCtrlC();
      yield* asMenu.flush;
      expect(asMenu.answers).toEqual([null]);

      const asQuestion = yield* mount({
        _tag: "Question",
        header: "What is the goal?",
        footer: "",
        initial: "",
      });
      asQuestion.mockInput.pressCtrlC();
      yield* asQuestion.flush;
      expect(asQuestion.answers).toEqual([null]);
    }),
  ));

test("a pasted answer fills the field, and its newline does not send it", () =>
  runEffect(
    Effect.gen(function* () {
      const url = "https://gitlab.cego.dk/cego/collie/-/merge_requests/7";
      const flow = yield* mount({
        _tag: "Question",
        header: "Which merge request?",
        footer: "",
        initial: "",
      });

      yield* Effect.promise(() => flow.mockInput.pasteBracketedText(`${url}\n`));
      yield* flow.flush;
      expect(flow.frame()).toContain(url);
      expect(flow.answers).toEqual([]);

      flow.mockInput.pressEnter();
      yield* flow.flush;
      expect(flow.answers).toEqual([url]);
    }),
  ));

test("a pasted query filters the menu", () =>
  runEffect(
    Effect.gen(function* () {
      const flow = yield* mount(menu());

      yield* Effect.promise(() => flow.mockInput.pasteBracketedText("implement"));
      yield* flow.flush;
      expect(flow.frame()).toContain("> implement");
      expect(flow.frame()).not.toContain("architecture —");
    }),
  ));
