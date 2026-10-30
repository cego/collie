// A module written against Effect 4.0, whose `effect/Crypto` 4.1 removed.

import { defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import * as Crypto from "effect/Crypto";

export default defineWorkflow({
  id: "crypto",
  title: "Name a fresh id",
  description: "Draws a UUID from the Crypto service Effect 4.0 had.",
  input: Schema.Struct({}),
  output: Schema.String,
  run: () => Effect.flatMap(Crypto.Crypto, (crypto) => crypto.randomUUIDv4),
});
