import { Children, Host, Run, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "delivers",
  title: "Deliver a merge request",
  input: Schema.Struct({
    mr: Schema.String,
    ships: Schema.optional(Schema.Boolean),
  }),
  hints: { mr: "goal" },
  output: Schema.String,
  followUps: [
    {
      id: "ship",
      title: "Ship",
      workflow: "ships",
      when: "succeeded",
      inputs: { mr: "merge-request" },
      eligible: (facts) => facts.mrUrl !== null,
    },
    {
      id: "stage",
      title: "Stage",
      workflow: "stages",
      when: "succeeded",
      inputs: { mr: "merge-request" },
      eligible: (facts) => facts.mrUrl !== null,
    },
  ],
  run: ({ input }) =>
    Effect.gen(function* () {
      yield* (yield* Host).mergeRequest((yield* Run).id, input.mr);
      if (input.ships !== true) return input.mr;
      const children = yield* Children;
      const child = yield* children.start({
        invocation: "ship",
        workflow: "ships",
        input: { mr: input.mr },
      });
      return String(yield* children.result(child));
    }),
});
