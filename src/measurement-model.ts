// A Measurement's Schemas alone, so a front door reads its record without loading the sampler
// (ADR-draft-a-performance-gain-is-proved-by-the-hosts-measurement).

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Effect, Schema, flow } from "effect";
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
  /** `<command>.wall_ms`, `<command>.cpu_ms`, `<command>.peak_kb`, which the host reads, or `<command>.<key>` of its last stdout line's JSON. */
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
  /** Seconds one sample, all its commands, or one tree's prepare may take. */
  limit: Schema.Finite.pipe(
    Schema.check(Schema.isGreaterThan(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(600)),
  ),
  /** Percent. */
  threshold: Schema.Finite.pipe(Schema.withDecodingDefaultKey(Effect.succeed(5))),
  tolerance: Schema.Finite.pipe(Schema.withDecodingDefaultKey(Effect.succeed(2))),
});
export type BenchmarkPlan = typeof BenchmarkPlan.Type;

/** The plan, or the reason it is not one, in `collie measure`'s words. */
export const decodeBenchmarkPlan = flow(
  Schema.decodeUnknownEffect(BenchmarkPlan),
  Effect.mapError((cause) => `the plan is not one: ${cause.message}`),
  Effect.flatMap((plan) => {
    const primaries = Arr.filter(plan.metrics, (one) => one.role === "primary").length;
    return primaries === 1
      ? Effect.succeed(plan)
      : Effect.fail(`a plan declares exactly one primary metric, not ${primaries}`);
  }),
);

export const PASS_LABEL = /^(?:calibration|final|cycle [1-9]\d*)$/;

const Tree = Schema.Struct({
  cwd: Schema.String,
  head_sha: Schema.String,
  fingerprint: Schema.String,
  /** The Git tree HEAD names: equal on two checkouts of the same files at different commits. */
  content: Schema.String,
  /** Each dependency lockfile at the tree's root, by its digest. */
  lockfiles: Schema.Record(Schema.String, Schema.String),
});

const Side = Schema.Literals(["base", "candidate"]);

export const Sample = Schema.Struct({
  tree: Side,
  /** Recorded, never judged. */
  warmup: Schema.Boolean,
  readings: Schema.Record(Schema.String, Schema.Finite),
  /** The Machine's 1, 5 and 15 minute load as the sample began. */
  load: Schema.Array(Schema.Finite),
  memory: Schema.NullOr(
    Schema.Struct({
      available: Schema.Finite,
      total: Schema.Finite,
      pressure: Schema.NullOr(Schema.Finite),
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
  /** Why the Run's plan changed to this one; null for its first. */
  plan_reason: Schema.NullOr(Schema.String),
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
      exit: Schema.Finite,
      seconds: Schema.Finite,
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
      exit: Schema.Finite,
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

/** A Measurement's verdicts, or how it ended without one, as one phrase. */
export const summaryOf = (measurement: Measurement) => {
  const result = measurement.result;
  switch (result._tag) {
    case "Judged":
      return Arr.join(
        Arr.map(
          result.verdicts,
          (one) => `${one.metric} ${one.verdict} (ratio ${one.ratio.toFixed(3)})`,
        ),
        ", ",
      );
    case "TimedOut":
      return `timed out in ${result.stage} on the ${result.tree} tree (${result.command})`;
    case "Failed":
      return `${result.stage} failed on the ${result.tree} tree (${result.command}, exit ${result.exit})`;
    case "Unjudged":
      return `not judged: ${result.reason}`;
  }
};

/** The latest `final` Measurement, named with its verdicts; null before one. */
export const finalMeasurementLine = (measurements: ReadonlyArray<Measurement>) => {
  const last = Option.getOrUndefined(Arr.findLast(measurements, (one) => one.pass === "final"));
  return last === undefined ? null : `final Measurement ${last.id}: ${summaryOf(last)}`;
};

/** What `measure` streams to a front door: what it waits on, then its one record. */
export const MeasureEvent = Schema.Union([
  Schema.TaggedStruct("Said", { text: Schema.String }),
  Schema.TaggedStruct("Result", { measurement: MeasurementJson, ran: Schema.Boolean }),
]);
