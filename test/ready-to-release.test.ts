// Ready to release as `run show` and `run wait` read it from a real host: the same fact the
// board's column is, and a wait that knows when only a human can move it.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { stopHost } from "./support/host";
import { collie, proves } from "./support/world";

const Missing = Schema.Struct({
  fact: Schema.String,
  said: Schema.String,
  settling: Schema.Boolean,
});
const Payload = Schema.Struct({
  runId: Schema.optional(Schema.String),
  run: Schema.optional(
    Schema.Struct({
      status: Schema.Struct({ status: Schema.String }),
      parked: Schema.NullOr(Schema.String),
    }),
  ),
  ready: Schema.optional(
    Schema.NullOr(Schema.Struct({ ready: Schema.Boolean, missing: Schema.Array(Missing) })),
  ),
});
const payloadOf = (envelope: { readonly data?: unknown }) =>
  Schema.decodeUnknownEffect(Payload)(envelope.data).pipe(Effect.orDie);

test(
  "a park whose status is still pending stops attention and needs-human, and show says it is not ready",
  () =>
    proves(
      "collie-ready-parked-",
      (world) =>
        Effect.gen(function* () {
          const started = yield* collie(world, [
            "run",
            "start",
            "parked-pending",
            "--input",
            "goal=park",
          ]);
          const runId = (yield* payloadOf(started.envelope)).runId ?? "";

          const attention = yield* collie(world, ["run", "wait", runId, "--until", "attention"]);
          expect(attention.exit).toBe(0);
          const parked = (yield* payloadOf(attention.envelope)).run;
          expect(parked?.status.status).toBe("pending");
          expect(parked?.parked).toBe("the pane will not take a prompt");

          const human = yield* collie(world, ["run", "wait", runId, "--until", "needs-human"]);
          expect(human.exit).toBe(0);
          expect((yield* payloadOf(human.envelope)).ready?.ready).toBe(false);

          const shown = yield* collie(world, ["run", "show", runId]);
          const ready = (yield* payloadOf(shown.envelope)).ready;
          expect(ready?.ready).toBe(false);
          expect(
            Option.getOrUndefined(
              Option.map(Option.fromNullishOr(ready), (present) =>
                Arr.map(present.missing, (one) => one.fact),
              ),
            ),
          ).toEqual(["succeeded", "mr-open"]);
          yield* stopHost(world.state);
        }),
      ["parked-pending.workflow.ts"],
    ),
  240_000,
);

test(
  "a Run that ended where nothing will make it ready ends a ready wait with the reason",
  () =>
    proves(
      "collie-ready-ended-",
      (world) =>
        Effect.gen(function* () {
          const started = yield* collie(world, ["run", "start", "plain", "--input", "note=x"]);
          const runId = (yield* payloadOf(started.envelope)).runId ?? "";
          yield* collie(world, ["run", "wait", runId]);

          const ready = yield* collie(world, ["run", "wait", runId, "--until", "ready"]);
          expect(ready.exit).not.toBe(0);
          expect(ready.envelope.error?.code).toBe("invalid_state");
          expect(ready.envelope.error?.message).toContain("will not become ready by itself");

          const human = yield* collie(world, ["run", "wait", runId, "--until", "needs-human"]);
          expect(human.exit).toBe(0);
          const shown = (yield* payloadOf(human.envelope)).ready;
          expect(
            Option.getOrUndefined(
              Option.map(Option.fromNullishOr(shown), (present_) =>
                Arr.every(present_.missing, (one) => !one.settling),
              ),
            ),
          ).toBe(true);

          const bad = yield* collie(world, ["run", "wait", runId, "--until", "someday"]);
          expect(bad.envelope.error?.message).toContain("terminal, attention, ready, needs-human");
          yield* stopHost(world.state);
        }),
      ["plain.workflow.ts"],
    ),
  240_000,
);
