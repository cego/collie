// Desktop sends a Run's review comments as one `deliver`, word for word, at any length:
// the host, not Desktop, signs it as the human in Desktop and keeps one over the paste budget
// as a file in the Run (test/finished-steer.test.ts).

import { expect, test } from "bun:test";
import { Effect } from "effect";
import { act, type Door } from "../desktop/src/bun/machine";
import { ActionFailed } from "../desktop/src/shared/flock";
import type { ActionResult } from "../src/board-model";

const machine = { profile: "vm", name: "vm-mk" };

/** A door whose `act` says `result` and keeps what it was asked. */
const acting = (result: ActionResult) => {
  const asked: Array<Parameters<Door["act"]>[0]> = [];
  const fake: Partial<Door> = {
    act: (payload) => {
      asked.push(payload);
      // SAFETY: `Deliver` never asks to discard the reply, so it is the results.
      return Effect.succeed([result] as never);
    },
  };
  // SAFETY: `Deliver` calls only `act`.
  const desktop = fake as Door;
  return { reached: { machine, desktop }, asked };
};

test("review comments reach the chosen agent word for word as one delivery, at any length", () =>
  Effect.runPromise(
    Effect.forEach(
      ["1. the plan's `SPEC.md`\n> x\n\nWhy?", `${"é".repeat(5_000)}\n  kept as typed  `],
      (text) =>
        Effect.gen(function* () {
          const door = acting({ kind: "deliver", state: "applied", note: "plan-2" });
          const said = yield* act(door.reached, "send-1", {
            _tag: "Deliver",
            runId: "r-1",
            agent: "plan-2",
            text,
          });
          expect(said).not.toBe("");
          expect(door.asked).toEqual([
            {
              actions: [{ kind: "deliver", run: "r-1", agent: "plan-2", text }],
              request: "send-1",
            },
          ]);
        }),
    ),
  ));

test("a delivery the host did not apply fails in the host's words, under its request", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const door = acting({
        kind: "deliver",
        state: "failed",
        note: "r-1 is finished; start a follow-up with `collie run followup r-1`",
      });
      const failed = yield* act(door.reached, "send-2", {
        _tag: "Deliver",
        runId: "r-1",
        agent: "plan-1",
        text: "x",
      }).pipe(Effect.flip);
      expect(failed).toEqual(
        new ActionFailed({
          request: "send-2",
          reason: "r-1 is finished; start a follow-up with `collie run followup r-1`",
        }),
      );
    }),
  ));
