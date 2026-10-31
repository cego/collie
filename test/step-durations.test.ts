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
      expect(took).toBeLessThan(1_000);
    }).pipe(Effect.scoped),
  ));
