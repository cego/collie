import { Effect, Schema } from "effect";

/**
 * Why a check was run (ADR-0042): the gate on the branch, a rerun of one of its failed tests
 * alone, a recheck of the same tree for a flake, a fix after gate fix N, the default branch's
 * base, the finish's own, a check left to CI read from the merge request's pipeline, or a
 * plain check where nobody said.
 */
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
/** One test of a check, as its runner named it: the file, and the name with ` > ` between describes. */
export const FailedTestSchema = Schema.Struct({ file: Schema.String, name: Schema.String });
export type FailedTest = typeof FailedTestSchema.Type;
const SnapshotSchema = Schema.Struct({ head_sha: Schema.String, fingerprint: Schema.String });
export type Snapshot = typeof SnapshotSchema.Type;

export const VerificationSchema = Schema.Struct({
  id: Schema.String,
  run: Schema.String,
  name: Schema.String,
  executable: Schema.String,
  argv: Schema.Array(Schema.String),
  cwd: Schema.String,
  start: SnapshotSchema,
  end: SnapshotSchema,
  exit: Schema.Int,
  seconds: Schema.Number,
  tail: Schema.Struct({ stdout: Schema.String, stderr: Schema.String }),
  /**
   * What a pass looks like for this command. `fail` is how a bug is proved to exist: a
   * regression test that exits non-zero on the tree before the fix is the evidence, and
   * calling that a failure would make reproducing a bug indistinguishable from not
   * having fixed it. Records written before this decode as `pass`, which is what they were.
   */
  expect: Schema.Literals(["pass", "fail"]).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("pass" as const)),
  ),
  result: Schema.Literals(["pass", "fail", "unstable"]),
  at: Schema.String,
  /** Who collected it. An agent may run one; only Collie may run an approved spec. */
  by: Schema.Literals(["agent", "collie"]),
  /** Why Collie ran it; absent on an agent's and on records written before passes were. */
  pass: Schema.optionalKey(Pass),
  round: Schema.optionalKey(Schema.Int),
  /** Where both streams were written as they arrived, up to `LOG_BYTES`. */
  log: Schema.optionalKey(Schema.String),
  /** What it ran with outside the tree; absent before environments were, and never reused. */
  environment: Schema.optionalKey(Schema.String),
  /** The tests a failing check's output names, where it could be read whole (ADR-0034). */
  failed: Schema.optionalKey(Schema.Array(FailedTestSchema)),
  /** The one test a `rerun` ran. */
  test: Schema.optionalKey(FailedTestSchema),
  /** The pipeline job a `ci` pass read, and the merge commit it ran on where not the head itself. */
  job: Schema.optionalKey(
    Schema.Struct({
      name: Schema.String,
      url: Schema.NullOr(Schema.String),
      merge: Schema.optionalKey(Schema.String),
    }),
  ),
});
export type Verification = typeof VerificationSchema.Type;
export const VerifyEvent = Schema.Union([
  Schema.Struct({
    _tag: Schema.Literal("Output"),
    stream: Schema.Literals(["stdout", "stderr"]),
    text: Schema.String,
  }),
  Schema.Struct({
    _tag: Schema.Literal("Result"),
    verification: VerificationSchema,
    /** False where an earlier pass answered and nothing ran. */
    ran: Schema.optionalKey(Schema.Boolean),
  }),
]);
