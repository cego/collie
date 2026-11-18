import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { RunRecords } from "../src/run-records";
import { Store } from "../src/store";
import { stepTimesByWorkflow, usualStepTimes } from "../src/step-durations";
import { encodeStepLine, STEPS_FILE, type StepLine } from "../src/steps";
import { memoryRecords, runEffect } from "./support/effect";

const at = (minute: number) => `2026-10-01T00:${Str.padStart(2, "0")(String(minute))}:00.000Z`;
const meta = (id: string) => ({
  id,
  title: "",
  description: "",
  kind: "agent" as const,
  role: null,
  produces: null,
});

/** A Run of `workflow` admitted with these Step lines. */
const ran = (run: string, workflow: string, lines: ReadonlyArray<StepLine>) =>
  Effect.gen(function* () {
    yield* (yield* Store).admit({
      request: run,
      run,
      workflow,
      project: "/work",
      input: {},
      provenance: {},
      options: {},
      generation: `${workflow}@1`,
      execution: `execution-${run}`,
      task: null,
      parent: null,
    });
    yield* (yield* RunRecords).append(run, STEPS_FILE, Arr.map(lines, encodeStepLine));
  });

const took = (step: string, from: number, to: number, key = step) => {
  const returned: ReadonlyArray<StepLine> = [
    { kind: "enter", key, step: meta(step), place: null, at: at(from) },
    { kind: "leave", key, at: at(to) },
  ];
  return returned;
};

test("a Step's usual time is the median of its latest ten runs, from first entry to last leaving", () =>
  runEffect(
    Effect.gen(function* () {
      // Re-entered after a resume: timed from its first entry to its last leaving.
      yield* ran("r0", "implement", [
        ...took("build", 20, 23),
        { kind: "enter", key: "build", step: meta("build"), place: null, at: at(24) },
        { kind: "leave", key: "build", at: at(28) },
      ]);
      for (const n of Arr.range(1, 11)) yield* ran(`r${n}`, "implement", took("build", 10, 10 + n));
      yield* ran("other", "review", took("build", 0, 59));
      yield* ran("few", "review", took("read", 0, 1));

      // r1 and r2 are the oldest of twelve: r0 took 8 minutes and r3..r11 3 to 11, median 7.5.
      expect((yield* usualStepTimes("implement")).get("build")).toBe(7.5 * 60_000);
      // One or two samples are no usual time.
      expect((yield* stepTimesByWorkflow).get("review")).toEqual(new Map());
    }).pipe(Effect.provide(memoryRecords)),
  ));

test("a Step's usual time counts each run of it once, by its key", () =>
  runEffect(
    Effect.gen(function* () {
      yield* ran("r1", "plan", [
        ...took("draft", 0, 2, "draft"),
        ...took("draft", 0, 4, "draft~2"),
      ]);
      yield* ran("r2", "plan", took("draft", 0, 6));
      expect((yield* usualStepTimes("plan")).get("draft")).toBe(4 * 60_000);
    }).pipe(Effect.provide(memoryRecords)),
  ));
