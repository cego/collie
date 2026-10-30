// A benchmark plan decoded as the host measures by it, or refused in `collie measure`'s words.

import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { decodeBenchmarkPlan } from "../src/measurement-model";

const metric = (name: string, role: "primary" | "guardrail") => ({
  name,
  direction: "lower",
  role,
});
const minimal = {
  harness: { commits: [], paths: [] },
  commands: [{ name: "suite", executable: "bun", argv: ["test"] }],
  metrics: [metric("suite.wall_ms", "primary")],
};
const refusal = (plan: Schema.Json) => Effect.runSync(Effect.flip(decodeBenchmarkPlan(plan)));

test("a plan with two primary metrics, or none, is refused", () => {
  expect(
    refusal({
      ...minimal,
      metrics: [metric("suite.wall_ms", "primary"), metric("suite.cpu_ms", "primary")],
    }),
  ).toBe("a plan declares exactly one primary metric, not 2");
  expect(refusal({ ...minimal, metrics: [metric("suite.wall_ms", "guardrail")] })).toBe(
    "a plan declares exactly one primary metric, not 0",
  );
});

test("a plan without commands is not one", () => {
  const { commands: _, ...uncommanded } = minimal;
  expect(refusal(uncommanded)).toStartWith("the plan is not one: ");
});

test("a minimal plan takes the defaults for every key it leaves out", () => {
  expect<unknown>(Effect.runSync(decodeBenchmarkPlan(minimal))).toEqual({
    ...minimal,
    prepare: null,
    warmup: 1,
    samples: 10,
    limit: 600,
    threshold: 5,
    tolerance: 2,
  });
});
