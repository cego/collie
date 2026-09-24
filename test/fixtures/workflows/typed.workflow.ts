// A module whose inputs are not all strings, so a launch has something to settle.
//
// Every field here is a shape `--input k=v` cannot carry as text alone: a number, a
// boolean, a list, a nullable, a closed set, a union that text and JSON disagree about,
// and one field that may simply be absent.

import { defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import * as Activity from "effect/unstable/workflow/Activity";

/** What the workflow was handed, as the type of each value rather than its text. */
const shape = (given: {
  count: number;
  draft: boolean;
  labels: ReadonlyArray<string>;
  ticket: string | null;
  mode: string;
  ref: string | number;
  spec?: string;
}) =>
  [
    `count=${typeof given.count}:${given.count}`,
    `draft=${typeof given.draft}:${given.draft}`,
    `labels=${given.labels.length}:[${given.labels.join("|")}]`,
    `ticket=${given.ticket === null ? "null" : `string:${given.ticket}`}`,
    `mode=${given.mode}`,
    `ref=${typeof given.ref}:${given.ref}`,
    `spec=${given.spec === undefined ? "absent" : `string:${given.spec}`}`,
  ].join(" ");

export default defineWorkflow({
  id: "typed",
  title: "A workflow with typed inputs",
  description: "Reports the types it was given, so a caller can see them.",
  input: Schema.Struct({
    note: Schema.String,
    count: Schema.Number,
    draft: Schema.Boolean,
    labels: Schema.Array(Schema.String),
    ticket: Schema.NullOr(Schema.String),
    mode: Schema.Literals(["fast", "thorough"]),
    ref: Schema.Union([Schema.String, Schema.Number]),
    spec: Schema.optionalKey(Schema.String),
  }),
  output: Schema.String,
  hints: { spec: "work-source" },
  outcome: { fixed: "feature" },
  run: ({ input }) =>
    Activity.make({
      name: "report",
      success: Schema.String,
      execute: Effect.succeed(shape(input)),
    }),
});
