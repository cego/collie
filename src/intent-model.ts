// The Intent's Schemas, with nothing else: a browser bundle of the board imports them.

import { Schema } from "effect";
import { VerifySpecSchema } from "./verify-spec";

export const RuleSpecSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("protected_paths"), globs: Schema.Array(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("branch_is"), name: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("mr_target"),
    project: Schema.String,
    iid: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("output_field"),
    step: Schema.String,
    path: Schema.String,
    op: Schema.Literals(["eq", "ne"]),
    value: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("command_exit"),
    name: Schema.String,
    expect: Schema.Int,
  }),
]);

export const ConstraintSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["rule", "semantic"]),
  text: Schema.String,
  severity: Schema.Literals(["block", "warn"]),
  source: Schema.Literals(["human", "workspace-default", "parent", "plan"]),
  provenance: Schema.optionalKey(
    Schema.Struct({ file: Schema.String, heading: Schema.String, line: Schema.Int }),
  ),
  since: Schema.Int,
  rule: Schema.optionalKey(RuleSpecSchema),
  paths: Schema.optionalKey(Schema.Array(Schema.String)),
});

export const AuthoritySchema = Schema.Struct({
  auto_correct: Schema.Boolean,
  max_corrections_per_constraint: Schema.Int,
  now_allowed: Schema.Boolean,
  interrupt_allowed: Schema.Boolean,
  stop_allowed: Schema.Boolean,
  exclusive_steering: Schema.Boolean,
  run_verification: Schema.Array(VerifySpecSchema),
  /**
   * A spending quota an earlier revision wrote. Read so an Intent from then still
   * decodes; never written and never enforced — the user's decision is that model-call
   * usage is data, not a restriction on their work.
   */
  model_calls_per_run: Schema.optionalKey(Schema.Int),
});

/** What a workspace offers a new Run before anyone types anything. */
export const DefaultsSchema = Schema.Struct({
  constraints: Schema.Array(ConstraintSchema),
  authority: AuthoritySchema,
});
/**
 * What a front door knows of a new Run's Intent: the defaults of the workspace it was
 * started from, and the goal and constraints named at launch. The host adds what the work
 * source asks for and what the Run may verify, and writes version 1 before any work runs.
 */
export const IntentSeedSchema = Schema.Struct({
  defaults: Schema.optionalKey(DefaultsSchema),
  goal: Schema.optionalKey(Schema.String),
  constraints: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ ...ConstraintSchema.fields, since: Schema.optionalKey(Schema.Int) }),
    ),
  ),
});
