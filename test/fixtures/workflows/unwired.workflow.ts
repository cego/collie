// A module whose run asks for a service nothing provides. The host has to say which file
// that is rather than fail somewhere nobody can find.

import { defineWorkflow } from "collie";
import { Context, Effect, Schema } from "effect";

interface MissingApi {
  readonly value: string;
}
class Missing extends Context.Service<Missing, MissingApi>()("unwired/Missing") {}

export default defineWorkflow({
  id: "unwired",
  title: "A workflow whose service is never provided",
  description: "Its run asks for a service it has no layer for.",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.String,
  run: () =>
    Effect.gen(function* () {
      return (yield* Missing).value;
    }),
});
