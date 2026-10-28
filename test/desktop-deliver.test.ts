// Desktop sends a Run's review comments as one `deliver`, word for word, at any length:
// the host, not Desktop, signs it as the human in Desktop and keeps one over the paste budget
// as a file in the Run (test/finished-steer.test.ts).

import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcTest from "effect/rpc/RpcTest";
import { act } from "../desktop/src/bun/machine";
import { ActionFailed, type DesktopAction } from "../desktop/src/shared/flock";
import { ActionSchema } from "../src/actions";
import { type ActionResult, FrontDoorRpcs } from "../src/board-model";

const machine = { profile: "vm", name: "vm-mk" };

type Called = Extract<RpcGroup.Rpcs<typeof FrontDoorRpcs>, { readonly _tag: "act" | "invoke" }>;
const Calls = RpcGroup.make(
  ...[...FrontDoorRpcs.requests.values()].filter(
    (rpc): rpc is Called => rpc._tag === "act" || rpc._tag === "invoke",
  ),
);

/**
 * `action` asked through the host's own `act` client, so its payload meets the wire's schema,
 * and what the host decodes of it with `ActionSchema`.
 */
const sent = (action: DesktopAction, result: ActionResult, request = "send-1") =>
  Effect.gen(function* () {
    const decoded: unknown[] = [];
    const said = yield* Effect.gen(function* () {
      const desktop = yield* RpcTest.makeClient(Calls);
      // SAFETY: Desktop's `act` and `invoke` are the only calls these actions make.
      return yield* act({ machine, desktop: desktop as never }, request, action);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Calls.toLayer({
          act: ({ actions }) =>
            Schema.decodeUnknownEffect(Schema.Array(ActionSchema))(actions).pipe(
              Effect.orDie,
              Effect.map((each) => {
                decoded.push(...each);
                return [result];
              }),
            ),
          invoke: () => Effect.die("not asked"),
        }),
      ),
    );
    return { said, decoded };
  });

const applied = { kind: "deliver", state: "applied", note: "plan-2" };

test("review comments reach the chosen agent word for word as one delivery, at any length", () =>
  Effect.runPromise(
    Effect.forEach(
      ["1. the plan's `SPEC.md`\n> x\n\nWhy?", `${"é".repeat(5_000)}\n  kept as typed  `],
      (text) =>
        Effect.gen(function* () {
          const { said, decoded } = yield* sent(
            { _tag: "Deliver", runId: "r-1", agent: "plan-2", text },
            applied,
          );
          expect(said).toBe("plan-2");
          expect(decoded).toEqual([
            { kind: "deliver", run: "r-1", agent: "plan-2", text, mode: "now" },
          ]);
        }),
    ),
  ));

test("review comments to a role, or to the agent at work, name only who they are for", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const toRole = yield* sent(
        { _tag: "Deliver", runId: "r-1", to: "planner", text: "Why?" },
        applied,
      );
      expect(toRole.decoded).toEqual([
        { kind: "deliver", run: "r-1", to: "planner", text: "Why?", mode: "now" },
      ]);
      const atWork = yield* sent({ _tag: "Deliver", runId: "r-1", text: "Why?" }, applied);
      expect(atWork.decoded).toEqual([{ kind: "deliver", run: "r-1", text: "Why?", mode: "now" }]);
    }),
  ));

test("a note on a step still names its step", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { decoded } = yield* sent(
        { _tag: "Deliver", runId: "r-1", step: "build", text: "and the tests" },
        applied,
      );
      expect(decoded).toEqual([
        { kind: "deliver", run: "r-1", step: "build", text: "and the tests", mode: "now" },
      ]);
    }),
  ));

test("a delivery the host did not apply fails in the host's words, under its request", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const failed = yield* sent(
        { _tag: "Deliver", runId: "r-1", agent: "plan-1", text: "x" },
        {
          kind: "deliver",
          state: "failed",
          note: "r-1 is finished; start a follow-up with `collie run followup r-1`",
        },
        "send-2",
      ).pipe(Effect.flip);
      expect(failed).toEqual(
        new ActionFailed({
          request: "send-2",
          reason: "r-1 is finished; start a follow-up with `collie run followup r-1`",
        }),
      );
    }),
  ));

test("a request its host's call cannot carry is said with what failed where, under its request", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const failed = yield* sent(
        {
          _tag: "Invoke",
          runId: "r-1",
          offer: "o-1",
          // SAFETY: a value no JSON holds, as Deliver's absent step once was.
          input: { left: undefined as never },
        },
        applied,
        "send-3",
      ).pipe(Effect.flip);
      expect(failed).toEqual(
        new ActionFailed({
          request: "send-3",
          reason: `The call to vm-mk did not fit its schema: Expected JSON value at ["input"]["left"]`,
        }),
      );
    }),
  ));
