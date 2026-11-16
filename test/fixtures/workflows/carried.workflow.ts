import { Host, Run, ask, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "carried",
  title: "Carry verified work on",
  description: "Reports the verifications a Run's evidence collects.",
  input: Schema.Struct({ text: Schema.String, wait: Schema.optionalKey(Schema.String) }),
  hints: { text: "work-source" },
  output: Schema.Array(Schema.String),
  followUps: [
    {
      id: "again",
      title: "Carry on",
      workflow: "self",
      when: "always",
      inputs: { text: "started-with" },
    },
  ],
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const runId = (yield* Run).id;
      const { cwd } = yield* host.place(runId);
      if (input.wait === "yes") yield* ask({ name: "done", prompt: "Done?" });
      return (yield* host.evidence(runId, cwd)).verifications.map((one) => one.id);
    }),
});
