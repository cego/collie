import { defineWorkflow } from "collie";
import { Schema } from "effect";
import follows from "./follows-mr.workflow";

export default defineWorkflow({
  ...follows,
  id: "slack-follows-mr",
  input: Schema.Struct({
    target: Schema.String,
    proves: Schema.optionalKey(Schema.String),
    slack: Schema.optionalKey(Schema.String),
  }),
});
