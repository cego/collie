// The same module on Effect 4.1: the id from `SecureRandom`, which its own Layer provides.

import { defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import * as SecureRandom from "effect/crypto/SecureRandom";

export default defineWorkflow({
  id: "random",
  title: "Name a fresh id",
  description: "Draws a UUID from SecureRandom.",
  input: Schema.Struct({}),
  output: Schema.String,
  layer: SecureRandom.layerWebCrypto,
  run: () => Effect.flatMap(SecureRandom.SecureRandom, (random) => random.uuidV4()),
});
