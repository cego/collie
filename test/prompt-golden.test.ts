import { expect, test } from "bun:test";
import { pipe } from "effect";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { drift, GOLDEN, REGENERATE } from "../tools/prompt-golden";

const golden = await Bun.file(GOLDEN).text();

test("a rendered prompt one word off its golden is drift, naming the golden, the line and how to regenerate it", () => {
  const found = drift(pipe(golden, Str.replace("Project root", "Project base")), golden);
  expect(Option.isSome(found)).toBe(true);
  const { message } = Option.getOrThrow(found);
  expect(message).toContain(
    `${GOLDEN} differs from the rendered plain-ticket build prompt at line 3:`,
  );
  expect(message).toContain("rendered: Project base: <root>/project");
  expect(message).toContain(REGENERATE);
});

test("a rendered prompt identical to its golden is no drift", () => {
  expect(drift(golden, golden)).toEqual(Option.none());
});
