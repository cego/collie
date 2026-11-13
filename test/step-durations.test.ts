import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { expect, test } from "bun:test";
import { Clock, Effect, FileSystem } from "effect";
import { rememberStepDurations, usualStepTimes } from "../src/step-durations";
import type { StepLine } from "../src/steps";
import { runEffect } from "./support/effect";

const at = (minute: number) => `2026-10-01T00:${Str.padStart(2, "0")(String(minute))}:00.000Z`;
const stepsOf = (count: number, minutes: number): ReadonlyArray<StepLine> =>
  Arr.flatMap(Arr.range(1, count), (n) => [
    {
      kind: "enter" as const,
      key: `s${n}`,
      step: {
        id: `s${n}`,
        title: "",
        description: "",
        kind: "agent" as const,
        role: null,
        produces: null,
      },
      place: null,
      at: at(0),
    },
    { kind: "leave" as const, key: `s${n}`, at: at(minutes) },
  ]);

test("a Run's steps are remembered at a storm's pace beside ten Runs of 220 steps", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-durations-" });
      for (const n of Arr.range(1, 10))
        yield* rememberStepDurations(dir, `large-${n}`, "large", stepsOf(220, n));
      const began = yield* Clock.currentTimeMillis;
      for (const n of Arr.range(1, 30)) {
        yield* rememberStepDurations(dir, `small-${n}`, "small", stepsOf(6, 2));
        yield* usualStepTimes(dir, "small");
      }
      const took = (yield* Clock.currentTimeMillis) - began;

      expect((yield* usualStepTimes(dir, "large")).get("s220")).toBe(330_000);
      expect((yield* usualStepTimes(dir, "small")).get("s6")).toBe(120_000);
      // The quadratic upkeep it replaced took 3.6 s locally, this 0.3 s; CI runners are slower.
      expect(took).toBeLessThan(2_500);
    }).pipe(Effect.scoped),
  ));

test("durations use the first entry for a key and skip incomplete or invalid pairs", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-durations-" });
      const enter = (key: string, at: string): StepLine => ({
        kind: "enter",
        key,
        at,
        step: { id: key, title: "", description: "", kind: "check", role: null, produces: null },
        place: null,
      });
      const leave = (key: string, at: string): StepLine => ({ kind: "leave", key, at });
      const lines = [
        leave("replayed", at(4)),
        enter("replayed", at(1)),
        enter("replayed", at(2)),
        leave("missing", at(3)),
        enter("incomplete", at(1)),
        enter("negative", at(5)),
        leave("negative", at(4)),
        enter("invalid", "not a date"),
        leave("invalid", at(4)),
        enter("zero", at(4)),
        leave("zero", at(4)),
      ];
      for (const run of ["one", "two", "three"])
        yield* rememberStepDurations(dir, run, "pairs", lines);
      expect(yield* usualStepTimes(dir, "pairs")).toEqual(
        new Map([
          ["replayed", 180_000],
          ["zero", 0],
        ]),
      );
    }).pipe(Effect.scoped),
  ));
