import { ask, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "shipping-go",
  input: Schema.Struct({ declaration: Schema.String }),
  hints: { declaration: "goal" },
  output: Schema.String,
  run: ({ input }) =>
    Effect.gen(function* () {
      const shipping: unknown = JSON.parse(input.declaration);
      return yield* ask({
        name: "ship",
        options: [{ id: "go", recommended: true }, "stop"],
        // @ts-expect-error Exercise validation of declarations arriving from untyped modules.
        shipping,
      });
    }),
});
