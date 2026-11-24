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
  // WARNING: Read so older Intents decode; never written and never enforced.
  model_calls_per_run: Schema.optionalKey(Schema.Int),
});

export const DefaultsSchema = Schema.Struct({
  constraints: Schema.Array(ConstraintSchema),
  authority: AuthoritySchema,
});
export const IntentSeedSchema = Schema.Struct({
  defaults: Schema.optionalKey(DefaultsSchema),
  goal: Schema.optionalKey(Schema.String),
  constraints: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ ...ConstraintSchema.fields, since: Schema.optionalKey(Schema.Int) }),
    ),
  ),
});

export const IntentChangeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("set-goal"), goal: Schema.NullOr(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("set-outcome"), outcome: Schema.NullOr(Schema.String) }),
  Schema.Struct({
    kind: Schema.Literal("add-constraint"),
    constraint: Schema.Struct({
      ...ConstraintSchema.fields,
      since: Schema.optionalKey(Schema.Int),
    }),
  }),
  Schema.Struct({ kind: Schema.Literal("remove-constraint"), id: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("authority"),
    patch: Schema.Struct({
      auto_correct: Schema.optionalKey(Schema.Boolean),
      max_corrections_per_constraint: Schema.optionalKey(
        Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      ),
      now_allowed: Schema.optionalKey(Schema.Boolean),
      interrupt_allowed: Schema.optionalKey(Schema.Boolean),
      stop_allowed: Schema.optionalKey(Schema.Boolean),
      exclusive_steering: Schema.optionalKey(Schema.Boolean),
      run_verification: Schema.optionalKey(Schema.Array(VerifySpecSchema)),
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("verification"),
    name: Schema.String,
    command: Schema.NullOr(
      Schema.Struct({
        executable: Schema.String,
        argv: Schema.Array(Schema.String),
        cwd: Schema.String,
      }),
    ),
  }),
]);
export const ChangedIntent = Schema.Struct({
  version: Schema.NullOr(Schema.Int),
  propagated: Schema.Array(Schema.String),
  approved: Schema.optionalKey(Schema.Array(VerifySpecSchema)),
  warning: Schema.optionalKey(Schema.String),
  redacted: Schema.optionalKey(Schema.Array(Schema.String)),
});
