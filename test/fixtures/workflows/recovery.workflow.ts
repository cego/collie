import { defineWorkflow, WorkflowError, Host, Run, step } from "collie";
import { Effect, Schema } from "effect";

const checks = step({ id: "checks", title: "Checks", kind: "check" });
export default defineWorkflow({
  id: "recovery",
  input: Schema.Struct({
    goal: Schema.String,
    succeed: Schema.optionalKey(Schema.Boolean),
    recovery: Schema.optionalKey(Schema.String),
  }),
  output: Schema.String,
  hints: { goal: "work-source" },
  checkout: "branch",
  path: [checks],
  followUps: [
    {
      id: "recover",
      title: "Recover",
      workflow: "self",
      when: "always",
      inputs: { goal: "started-with", recovery: "run-dir" },
      entry: (facts) =>
        facts.recovery?.review != null
          ? "Checks"
          : facts.recovery?.implementation
            ? "Review"
            : "Build",
    },
  ],
  run: ({ input }) =>
    Effect.gen(function* () {
      if (input.recovery === undefined)
        return input.succeed ? "done" : yield* new WorkflowError({ reason: "integration stopped" });
      const host = yield* Host;
      const { id } = yield* Run;
      const facts = yield* host.recovery(id, input.recovery, input.goal);
      if (facts.review === null)
        return yield* new WorkflowError({ reason: "A review is required" });
      yield* checks(
        Effect.gen(function* () {
          for (const spec of yield* host.approved(id))
            yield* host.verify({ runId: id, cwd: (yield* host.place(id)).cwd, name: spec.name });
        }),
      );
      return "Checked existing head";
    }),
});
