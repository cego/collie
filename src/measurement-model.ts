// A Measurement's Schemas alone, so a front door reads its record without loading the sampler
// (ADR-draft-a-performance-gain-is-proved-by-the-hosts-measurement).

import { Effect, Schema } from "effect";
import { Judgement } from "./measurement-verdict";

const Command = Schema.Struct({ executable: Schema.String, argv: Schema.Array(Schema.String) });

/** What a Run measures with, frozen: a changed plan is a new comparison. */
export const BenchmarkPlan = Schema.Struct({
  /** Commits applied on the base commit, each touching only `paths`. */
  harness: Schema.Struct({
    commits: Schema.Array(Schema.String),
    paths: Schema.Array(Schema.String),
  }),
  /** Run once per tree before its samples. */
  prepare: Schema.NullOr(Command).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /** Each sample runs every one, in order, in the tree's root. */
  commands: Schema.NonEmptyArray(Schema.Struct({ name: Schema.String, ...Command.fields })),
  /** `<command>.wall_ms`, `<command>.cpu_ms`, `<command>.peak_kb`, or `<command>.<key>` of its last stdout line's JSON. */
  metrics: Schema.NonEmptyArray(
    Schema.Struct({
      name: Schema.String,
      direction: Schema.Literals(["lower", "higher"]),
      role: Schema.Literals(["primary", "guardrail"]),
    }),
  ),
  warmup: Schema.Int.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(1)),
  ),
  samples: Schema.Int.pipe(
    Schema.check(Schema.isGreaterThanOrEqualTo(2)),
    Schema.withDecodingDefaultKey(Effect.succeed(10)),
  ),
  /** Seconds one command of a sample, or prepare, may take. */
  limit: Schema.Finite.pipe(
    Schema.check(Schema.isGreaterThan(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(600)),
  ),
  /** Percent. */
  threshold: Schema.Finite.pipe(Schema.withDecodingDefaultKey(Effect.succeed(5))),
  tolerance: Schema.Finite.pipe(Schema.withDecodingDefaultKey(Effect.succeed(2))),
});
export type BenchmarkPlan = typeof BenchmarkPlan.Type;

export const PASS_LABEL = /^(?:calibration|final|cycle [1-9]\d*)$/;

const Tree = Schema.Struct({
  cwd: Schema.String,
  head_sha: Schema.String,
  fingerprint: Schema.String,
  /** Each dependency lockfile at the tree's root, by its digest. */
  lockfiles: Schema.Record(Schema.String, Schema.String),
});

const Side = Schema.Literals(["base", "candidate"]);

export const Sample = Schema.Struct({
  tree: Side,
  /** Recorded, never judged. */
  warmup: Schema.Boolean,
  readings: Schema.Record(Schema.String, Schema.Number),
  /** The Machine's 1, 5 and 15 minute load as the sample began. */
  load: Schema.Array(Schema.Number),
  memory: Schema.NullOr(
    Schema.Struct({
      available: Schema.Number,
      total: Schema.Number,
      pressure: Schema.NullOr(Schema.Number),
    }),
  ),
  at: Schema.String,
});
export type Sample = typeof Sample.Type;

const Stage = Schema.Literals(["prepare", "sample"]);

export const MeasurementSchema = Schema.Struct({
  id: Schema.String,
  run: Schema.String,
  pass: Schema.String,
  machine: Schema.String,
  plan: BenchmarkPlan,
  plan_digest: Schema.String,
  base: Schema.Struct({ commit: Schema.String, ...Tree.fields }),
  candidate: Tree,
  /** Each command's environment as a Verification records it; null where it could not be read. */
  environment: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
  waited: Schema.Struct({
    memory: Schema.Boolean,
    /** The Measurements that held this Machine while it waited. */
    machine: Schema.Array(Schema.String),
  }),
  prepare: Schema.Array(
    Schema.Struct({
      tree: Side,
      exit: Schema.Number,
      seconds: Schema.Number,
      output: Schema.String,
    }),
  ),
  samples: Schema.Array(Sample),
  result: Schema.Union([
    Schema.TaggedStruct("Judged", { verdicts: Schema.Array(Judgement) }),
    Schema.TaggedStruct("TimedOut", { tree: Side, stage: Stage, command: Schema.String }),
    Schema.TaggedStruct("Failed", {
      tree: Side,
      stage: Stage,
      command: Schema.String,
      exit: Schema.Number,
      output: Schema.String,
    }),
    Schema.TaggedStruct("Unjudged", { reason: Schema.String }),
  ]),
  started: Schema.String,
  at: Schema.String,
});
export type Measurement = typeof MeasurementSchema.Type;
/** Keeps an infinite ratio, which plain JSON writes as null. */
export const MeasurementJson = Schema.toCodecJson(MeasurementSchema);

/** What `measure` streams to a front door: what it waits on, then its one record. */
export const MeasureEvent = Schema.Union([
  Schema.TaggedStruct("Said", { text: Schema.String }),
  Schema.TaggedStruct("Result", { measurement: MeasurementJson, ran: Schema.Boolean }),
]);
