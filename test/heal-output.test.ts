import { expect, test } from "bun:test";
import { Effect, Exit, FileSystem, Layer, Option, Schema } from "effect";
import * as Workflow from "effect/workflow/Workflow";
import heal, { Healed } from "../workflows/heal.workflow";
import { engineLayer } from "../src/engine";
import { runEffect } from "./support/effect";

const historical = {
  diagnosis: "The saved worker needs its server.",
  actions: ["Started the existing server."],
  result: "resumed" as const,
  finding: {
    collie_defect: true,
    key: "worker-server-absent",
    root_cause: "The worker server was absent.",
    fix: "Recover the server through its supported control.",
    regression: "A saved worker becomes observable after server recovery.",
  },
};

test("a completed historical Heal is readable after the workflow output gains issue fields", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-heal-output-" });
      const payload = { runId: "old-heal" };
      const previous = Workflow.make("heal@1", {
        payload: { runId: Schema.String },
        idempotencyKey: (input) => input.runId,
        success: Schema.Unknown,
      });
      const execution = yield* previous.executionId(payload);
      yield* previous
        .execute(payload)
        .pipe(
          Effect.provide(
            previous
              .toLayer(() => Effect.succeed(historical))
              .pipe(Layer.provideMerge(engineLayer({ dir }))),
          ),
          Effect.scoped,
        );

      const current = Workflow.make("heal@1", {
        payload: { runId: Schema.String },
        idempotencyKey: (input) => input.runId,
        success: heal.output!,
      });
      const result = yield* current
        .poll(execution)
        .pipe(Effect.provide(engineLayer({ dir })), Effect.scoped);
      expect(
        Option.isSome(result) && result.value._tag === "Complete" && result.value.exit,
      ).toEqual(Exit.succeed(historical));
    }).pipe(Effect.scoped),
  ));

test("a new healer still has to supply every current issue field", () => {
  const current = {
    ...historical,
    finding: {
      ...historical.finding,
      title: "Saved workers need server recovery",
      observed: "The worker could not be reached.",
      expected: "The saved worker can be observed.",
      issue: null,
    },
  };
  expect(Schema.decodeOption(Healed)(current)).toEqual(Option.some(current));
  expect(Schema.decodeOption(heal.output!)(current)).toEqual(Option.some(current));
  expect(Option.isNone(Schema.decodeUnknownOption(Healed)(historical))).toBe(true);
  for (const field of ["title", "observed", "expected", "issue"]) {
    const incomplete = { ...current, finding: { ...current.finding, [field]: undefined } };
    expect(Option.isNone(Schema.decodeOption(Healed)(incomplete))).toBe(true);
  }
});

test("an old escalated Heal still needs its reason for asking a person", () => {
  const escalated = { ...historical, result: "escalate" as const };
  expect(Option.isNone(Schema.decodeUnknownOption(heal.output!)(escalated))).toBe(true);
  const complete = { ...escalated, needs_person: "The server could not be recovered." };
  expect(Schema.decodeOption(heal.output!)(complete)).toEqual(Option.some(complete));
});
