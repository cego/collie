import { Children, Host, Run, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "card-delivery",
  input: Schema.Struct({ mrs: Schema.Array(Schema.String) }),
  hints: { mrs: "goal" },
  output: Schema.String,
  followUps: [
    {
      id: "release",
      title: "Release",
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
      if (input.mrs.length === 1) {
        yield* (yield* Host).mergeRequest((yield* Run).id, input.mrs[0]!);
        return input.mrs[0]!;
      }
      const children = yield* Children;
      for (const [at, mr] of input.mrs.entries()) {
        const child = yield* children.start({
          invocation: `change-${at}`,
          workflow: "card-delivery",
          input: { mrs: [mr] },
        });
        yield* children.result(child);
      }
      return "Changes delivered";
    }),
});
