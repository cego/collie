import { Effect, Schema } from "effect";
import * as Arr from "effect/Array";
import * as Struct from "effect/Struct";
import { StepPlace } from "./steps";

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
const SnapshotSchema = Schema.Struct({
  head_sha: Schema.String,
  fingerprint: Schema.String,
  /** Why git could not measure the tree, where the fingerprint is `unstable:unmeasured`. */
  unmeasured: Schema.optionalKey(Schema.String),
});
export type Snapshot = typeof SnapshotSchema.Type;

export const MOVED_CLASSES = ["tracked", "untracked", "lockfile"] as const;
/** One path whose content differs between an unstable verification's start and end trees. */
export const MovedPathSchema = Schema.Struct({
  path: Schema.String,
  change: Schema.Literals(["added", "modified", "deleted", "type-changed"]),
  /** In the index when the command ended, not, or a dependency lockfile either way. */
  class: Schema.Literals(MOVED_CLASSES),
});
export type MovedPath = typeof MovedPathSchema.Type;

export const VerificationSchema = Schema.Struct({
  id: Schema.String,
  run: Schema.String,
  name: Schema.String,
  executable: Schema.String,
  /** The executable as it was asked, before PATH resolved it; absent on records written before it was kept. */
  asked: Schema.optionalKey(Schema.String),
  argv: Schema.Array(Schema.String),
  cwd: Schema.String,
  start: SnapshotSchema,
  end: SnapshotSchema,
  exit: Schema.Int,
  seconds: Schema.Finite,
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
  /** What moved under an `unstable` run, from the repository root; absent on older records. */
  moved: Schema.optionalKey(Schema.Array(MovedPathSchema)),
  at: Schema.String,
  /** Who collected it. An agent may run one; only Collie may run an approved spec. */
  by: Schema.Literals(["agent", "collie"]),
  step: Schema.optional(Schema.String),
  place: Schema.optional(Schema.NullOr(StepPlace)),
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
  /** Whether a `rerun`'s test is the branch's own since the default branch, so never a Flake. */
  own: Schema.optionalKey(Schema.Boolean),
  /** The pipeline job a `ci` pass read, and the merge commit it ran on where not the head itself. */
  job: Schema.optionalKey(
    Schema.Struct({
      name: Schema.String,
      url: Schema.NullOr(Schema.String),
      merge: Schema.optionalKey(Schema.String),
      /** After a failed attempt: each test the job's failed attempts named, and how many named it. */
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

const MOVED_SHOWN = 5;

/** What moved under an unstable record, capped, naming the record that lists them all; "" for none. */
export function movedLine(record: Pick<Verification, "id" | "moved">): string {
  const moved = record.moved ?? [];
  if (moved.length === 0) return "";
  const named = Arr.join(
    Arr.map(moved.slice(0, MOVED_SHOWN), (one) => `${one.change} ${one.class} ${one.path}`),
    ", ",
  );
  const rest = moved.length - MOVED_SHOWN;
  return rest > 0
    ? `${named} and ${rest} more (all ${moved.length} in verification ${record.id})`
    : named;
}

const BRIEFED = ["name", "executable", "argv", "seconds", "result", "at", "by", "step"] as const;

/**
 * What a verification says to a reader across Runs: none of its trees, and its output only
 * where it failed. `collie_run_lines.brief` keeps it beside each whole record.
 */
export const ProofSchema = VerificationSchema.mapFields((fields) => ({
  ...Struct.pick(fields, BRIEFED),
  place: fields.place,
  tail: Schema.optionalKey(fields.tail),
}));
export type Proof = typeof ProofSchema.Type;

/**
 * The SQL of a verifications line's brief, or of the line as written where it is not JSON.
 * A merge patch drops nulls at every depth, so `place` is kept in the patch's target.
 */
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
  /** The check now running, by the id a host that takes it over knows it by. */
  Schema.TaggedStruct("Started", { check: Schema.String }),
  Schema.TaggedStruct("Output", {
    stream: Schema.Literals(["stdout", "stderr"]),
    text: Schema.String,
  }),
  Schema.TaggedStruct("Result", {
    verification: VerificationSchema,
    /** False where an earlier pass answered and nothing ran. */
    ran: Schema.optionalKey(Schema.Boolean),
  }),
]);
