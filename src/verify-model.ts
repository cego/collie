import { Effect, Schema } from "effect";
import * as Arr from "effect/Array";
import * as Struct from "effect/Struct";
import { StepPlace } from "./steps";

export const PASSES = [
  "gate",
  "rerun",
  "recheck",
  "fix",
  "baseline",
  "finish",
  "ci",
  "check",
] as const;
export const Pass = Schema.Literals(PASSES);
export type Pass = typeof Pass.Type;
export const FailedTestSchema = Schema.Struct({ file: Schema.String, name: Schema.String });
export type FailedTest = typeof FailedTestSchema.Type;
const SnapshotSchema = Schema.Struct({
  head_sha: Schema.String,
  fingerprint: Schema.String,
  unmeasured: Schema.optionalKey(Schema.String),
});
export type Snapshot = typeof SnapshotSchema.Type;

export const VerificationSchema = Schema.Struct({
  id: Schema.String,
  run: Schema.String,
  name: Schema.String,
  executable: Schema.String,
  asked: Schema.optionalKey(Schema.String),
  argv: Schema.Array(Schema.String),
  cwd: Schema.String,
  start: SnapshotSchema,
  end: SnapshotSchema,
  exit: Schema.Int,
  seconds: Schema.Finite,
  tail: Schema.Struct({ stdout: Schema.String, stderr: Schema.String }),
  expect: Schema.Literals(["pass", "fail"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("pass" as const)),
  ),
  result: Schema.Literals(["pass", "fail", "unstable"]),
  at: Schema.String,
  by: Schema.Literals(["agent", "collie"]),
  step: Schema.optional(Schema.String),
  place: Schema.optional(Schema.NullOr(StepPlace)),
  pass: Schema.optionalKey(Pass),
  round: Schema.optionalKey(Schema.Int),
  log: Schema.optionalKey(Schema.String),
  environment: Schema.optionalKey(Schema.String),
  failed: Schema.optionalKey(Schema.Array(FailedTestSchema)),
  test: Schema.optionalKey(FailedTestSchema),
  own: Schema.optionalKey(Schema.Boolean),
  job: Schema.optionalKey(
    Schema.Struct({
      name: Schema.String,
      url: Schema.NullOr(Schema.String),
      merge: Schema.optionalKey(Schema.String),
      flaked: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            name: Schema.String,
            file: Schema.NullOr(Schema.String),
            attempts: Schema.Int,
          }),
        ),
      ),
    }),
  ),
});
export type Verification = typeof VerificationSchema.Type;

const BRIEFED = ["name", "executable", "argv", "seconds", "result", "at", "by", "step"] as const;

export const ProofSchema = VerificationSchema.mapFields((fields) => ({
  ...Struct.pick(fields, BRIEFED),
  place: fields.place,
  tail: Schema.optionalKey(fields.tail),
}));
export type Proof = typeof ProofSchema.Type;

export const PROOF_SQL = `CASE WHEN journal = 'evidence/steering/verifications.jsonl' THEN
  CASE WHEN json_valid(line) THEN json_patch(
    CASE WHEN line -> '$.place' IS NULL THEN '{}' ELSE json_object('place', line -> '$.place') END,
    json_object(${Arr.join(
      Arr.map(BRIEFED, (name) => `'${name}', line -> '$.${name}'`),
      ", ",
    )}, 'tail', CASE WHEN line ->> '$.result' = 'fail' THEN line -> '$.tail' END))
  ELSE line END
END`;
export const VerifyEvent = Schema.Union([
  Schema.TaggedStruct("Started", { check: Schema.String }),
  Schema.TaggedStruct("Output", {
    stream: Schema.Literals(["stdout", "stderr"]),
    text: Schema.String,
  }),
  Schema.TaggedStruct("Result", {
    verification: VerificationSchema,
    ran: Schema.optionalKey(Schema.Boolean),
  }),
]);
