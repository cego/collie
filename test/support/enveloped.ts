import { Effect, Schema } from "effect";
import * as Workflow from "effect/workflow/Workflow";
import { Run, WorkflowError } from "../../src/sdk";

export const enveloped = <Input extends Schema.Struct.Fields, Success extends Schema.Top>(options: {
  readonly name: string;
  readonly input: Input;
  readonly success: Success;
}) =>
  Workflow.make(options.name, {
    payload: { runId: Schema.String, input: Schema.Struct(options.input) },
    idempotencyKey: (payload) => payload.runId,
    success: options.success,
    error: WorkflowError,
  });

export const asRun =
  (payload: { readonly runId: string }, workflow = "test") =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(Run, Run.of({ id: payload.runId, workflow })));
