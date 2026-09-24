// An entry with an ordinary type error in it, so a check reports the file and the line
// rather than refusing every workflow beside it.

import { defineWorkflow } from "collie";
import { Effect, Schema } from "effect";

const note: string = 1;

export default defineWorkflow({
  id: "broken",
  title: "A workflow that does not typecheck",
  description: "Its note is a number where a string belongs.",
  input: Schema.Struct({ note: Schema.String }),
  run: () => Effect.log(note),
});
