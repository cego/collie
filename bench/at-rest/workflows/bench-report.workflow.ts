import { ask, defineWorkflow, step } from "collie";
import { Effect, Schema } from "effect";

const STEPS = Array.from({ length: 16 }, (_, at) =>
  step({ id: `s${at + 1}`, title: `Step ${at + 1}`, kind: "check" }),
);

export default defineWorkflow({
  id: "bench-report",
  title: "Report when done",
  description:
    "Takes sixteen Steps, then settles or waits on a question; its Task closes once reported.",
  input: Schema.Struct({ on: Schema.Literals(["done", "ask"]), steps: Schema.String }),
  hints: { on: "goal" },
  closes: "reported",
  output: Schema.String,
  run: ({ input }) =>
    Effect.gen(function* () {
      for (const one of STEPS.slice(0, Number(input.steps))) yield* one(Effect.void);
      if (input.on === "ask") return yield* ask({ name: "never", prompt: "Nobody answers." });
      return "done";
    }),
});
