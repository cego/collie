// A module whose inputs are not all strings, so a launch has something to settle.
//
// Every field here is a shape `--input k=v` cannot carry as text alone: a number, a
// boolean, a list, a nullable, a closed set, a union that text and JSON disagree about,
// and one field that may simply be absent.

import { defineWorkflow } from "collie/native";
import { Effect, Schema } from "effect";
import * as Activity from "effect/unstable/workflow/Activity";

export const id = "typed";
export const title = "A workflow with typed inputs";
export const description = "Reports the types it was given, so a caller can see them.";

export const input = {
  note: Schema.String,
  count: Schema.Number,
  draft: Schema.Boolean,
  labels: Schema.Array(Schema.String),
  ticket: Schema.NullOr(Schema.String),
  mode: Schema.Literals(["fast", "thorough"]),
  ref: Schema.Union([Schema.String, Schema.Number]),
  spec: Schema.optionalKey(Schema.String),
};

export const metadata = {
  hints: { spec: "work-source" },
  outcome: { fixed: "feature" },
};

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

export const make = (registrationName: string) => {
  const workflow = defineWorkflow({ name: registrationName, input, success: Schema.String });
  const layer = workflow.toLayer(
    Effect.fnUntraced(function* (payload) {
      return yield* Activity.make({
        name: "report",
        success: Schema.String,
        execute: Effect.succeed(shape(payload.input)),
      });
    }),
  );
  return { workflow, layer, decisions: {} };
};
