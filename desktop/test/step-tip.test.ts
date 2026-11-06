import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import {
  CLOSED,
  tipAfter,
  type StepTip,
  type TipEvent,
  type TipNext,
} from "../src/shared/step-tip";

/** The tip after each event in turn, with the wait the last one asked for. */
const after = (events: ReadonlyArray<TipEvent>, from: StepTip = CLOSED) => {
  const start: TipNext = { tip: from, wait: null };
  return Arr.reduce(events, start, ({ tip }, event) => tipAfter(tip, event));
};

test("hovering a Step shows its tip once the delay has passed, and not before", () => {
  const entered = after([{ kind: "enter", step: "a", at: 0 }]);
  expect(entered.tip.open).toBeNull();
  expect(entered.wait).toBe(300);
  expect(after([{ kind: "due", step: "a" }], entered.tip).tip.open).toBe("a");
});

test("a delay that ends after the pointer left, or moved on, shows nothing", () => {
  expect(
    after([
      { kind: "enter", step: "a", at: 0 },
      { kind: "leave", at: 100 },
      { kind: "due", step: "a" },
    ]).tip.open,
  ).toBeNull();
  const moved = after([
    { kind: "enter", step: "a", at: 0 },
    { kind: "leave", at: 100 },
    { kind: "enter", step: "b", at: 120 },
    { kind: "due", step: "a" },
  ]);
  expect(moved.tip.open).toBeNull();
  expect(after([{ kind: "due", step: "b" }], moved.tip).tip.open).toBe("b");
});

test("moving from one shown tip to the next Step shows it at once, until the skip has passed", () => {
  const shown = after([
    { kind: "enter", step: "a", at: 0 },
    { kind: "due", step: "a" },
    { kind: "leave", at: 1000 },
  ]).tip;
  const soon = after([{ kind: "enter", step: "b", at: 1200 }], shown);
  expect(soon.tip.open).toBe("b");
  expect(soon.wait).toBeNull();
  const late = after([{ kind: "enter", step: "b", at: 1400 }], shown);
  expect(late.tip.open).toBeNull();
  expect(late.wait).toBe(300);
});

test("a keyboard focus shows the tip at once, and a press closes it and is not a focus", () => {
  expect(after([{ kind: "focus", step: "a" }]).tip.open).toBe("a");
  const pressed = after([
    { kind: "focus", step: "a" },
    { kind: "press", at: 10 },
    { kind: "focus", step: "b" },
  ]).tip;
  expect(pressed.open).toBeNull();
  expect(after([{ kind: "release" }, { kind: "focus", step: "b" }], pressed).tip.open).toBe("b");
});

test("blur and Escape close the tip", () => {
  for (const kind of ["blur", "dismiss"] as const)
    expect(
      after([
        { kind: "focus", step: "a" },
        { kind, at: 5 },
      ]).tip.open,
    ).toBeNull();
});
