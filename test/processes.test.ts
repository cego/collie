import { expect, test } from "bun:test";
import { Effect } from "effect";
import { commandOf, processOf, startedOf } from "../src/processes";
import { runEffect } from "./support/effect";

test("a process's command and start time read alone are what reading it whole says", () =>
  runEffect(
    Effect.gen(function* () {
      const whole = (yield* processOf(process.pid))!;
      expect(yield* commandOf(process.pid)).toBe(whole.command);
      expect(yield* startedOf(process.pid)).toBe(whole.started);
    }),
  ));

test("a process that is not running has no start time", () =>
  runEffect(Effect.map(startedOf(2 ** 22 + 1), (started) => expect(started).toBeNull())));
