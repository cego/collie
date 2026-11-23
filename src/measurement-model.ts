import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as Option from "effect/Option";
import { Effect, Schema, flow } from "effect";
import { Judgement } from "./measurement-verdict";

export const Command = Schema.Struct({
  executable: Schema.String,
  argv: Schema.Array(Schema.String),
});

export const BenchmarkPlan = Schema.Struct({
  harness: Schema.Struct({
    commits: Schema.Array(Schema.String),
    paths: Schema.Array(Schema.String),
  }),
  prepare: Schema.NullOr(Command).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  commands: Schema.NonEmptyArray(Schema.Struct({ name: Schema.String, ...Command.fields })),
  metrics: Schema.NonEmptyArray(
    Schema.Struct({
      name: Schema.String,
      direction: Schema.Literals(["lower", "higher"]),
      role: Schema.Literals(["primary", "guardrail"]),
      threshold: Schema.optionalKey(Schema.Finite),
      tolerance: Schema.optionalKey(Schema.Finite),
      absolute: Schema.optionalKey(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
      exact: Schema.optionalKey(Schema.Boolean),
      why: Schema.optionalKey(Schema.String),
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
  limit: Schema.Finite.pipe(
    Schema.check(Schema.isGreaterThan(0)),
    Schema.withDecodingDefaultKey(Effect.succeed(600)),
  ),
  threshold: Schema.Finite.pipe(Schema.withDecodingDefaultKey(Effect.succeed(5))),
  tolerance: Schema.Finite.pipe(Schema.withDecodingDefaultKey(Effect.succeed(2))),
});
export type BenchmarkPlan = typeof BenchmarkPlan.Type;

export const decodeBenchmarkPlan = flow(
  Schema.decodeUnknownEffect(BenchmarkPlan),
  Effect.mapError((cause) => `the plan is not one: ${cause.message}`),
  Effect.flatMap((plan) => {
    const primaries = Arr.filter(plan.metrics, (one) => one.role === "primary").length;
    if (primaries !== 1)
      return Effect.fail(`a plan declares exactly one primary metric, not ${primaries}`);
    const unjustified = Arr.filter(
      plan.metrics,
      (one) =>
        (one.threshold !== undefined ||
          one.tolerance !== undefined ||
          one.absolute !== undefined ||
          one.exact !== undefined) &&
        Str.trim(one.why ?? "") === "",
    );
    return unjustified.length === 0
      ? Effect.succeed(plan)
      : Effect.fail(
          `a metric's own limits need their why: ${Arr.join(
            Arr.map(unjustified, (one) => one.name),
            ", ",
          )}`,
        );
  }),
);

export const PASS_LABEL = /^(?:calibration|final|cycle [1-9]\d*)$/;

const Tree = Schema.Struct({
  cwd: Schema.String,
  head_sha: Schema.String,
  fingerprint: Schema.String,
  content: Schema.String,
  lockfiles: Schema.Record(Schema.String, Schema.String),
});

const Side = Schema.Literals(["base", "candidate"]);

export const Sample = Schema.Struct({
  tree: Side,
  warmup: Schema.Boolean,
  readings: Schema.Record(Schema.String, Schema.Finite),
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
  plan_reason: Schema.NullOr(Schema.String),
  base: Schema.Struct({ commit: Schema.String, ...Tree.fields }),
  candidate: Schema.Struct({
    ...Tree.fields,
    harness_applied: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
  environment: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
  waited: Schema.Struct({
    memory: Schema.Boolean,
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
// WARNING: Infinite ratios are kept as they are: plain JSON writes them as null.
export const MeasurementJson = Schema.toCodecJson(MeasurementSchema);

export const summaryOf = (measurement: Pick<Measurement, "result">) => {
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

export const finalMeasurementLine = (measurements: ReadonlyArray<Measurement>) => {
  const last = Option.getOrUndefined(Arr.findLast(measurements, (one) => one.pass === "final"));
  return last === undefined ? null : `final Measurement ${last.id}: ${summaryOf(last)}`;
};

export const MeasureEvent = Schema.Union([
  Schema.TaggedStruct("Said", { text: Schema.String }),
  Schema.TaggedStruct("Result", { measurement: MeasurementJson, ran: Schema.Boolean }),
]);

export const limitsOf = (
  plan: Pick<BenchmarkPlan, "threshold" | "tolerance">,
  metric: BenchmarkPlan["metrics"][number],
) => ({
  threshold: metric.threshold ?? plan.threshold,
  tolerance: metric.tolerance ?? plan.tolerance,
  absolute: metric.absolute ?? 0,
  exact: metric.exact ?? false,
});

export interface Lost {
  readonly metric: string;
  readonly why: string;
}

// WARNING: A harness that ran nothing, or differs on identical trees, is broken; too-noisy metrics leave proof unavailable.
export type Calibration =
  | { readonly _tag: "Calibrated" }
  | { readonly _tag: "HarnessBroken"; readonly why: ReadonlyArray<string> }
  | { readonly _tag: "ProofUnavailable"; readonly lost: ReadonlyArray<Lost> };

const bounds = (interval: readonly [number, number]) =>
  `[${Arr.join(
    Arr.map(interval, (bound) => bound.toFixed(3)),
    ", ",
  )}]`;

export const calibrationOf: (measured: Pick<Measurement, "plan" | "result">) => Calibration = (
  measured,
) => {
  const { plan, result } = measured;
  if (result._tag !== "Judged") return { _tag: "HarnessBroken", why: [summaryOf(measured)] };
  const broken: Array<string> = [];
  const noisy: Array<Lost> = [];
  for (const metric of plan.metrics) {
    const judged = Option.getOrUndefined(
      Arr.findFirst(result.verdicts, (one) => one.metric === metric.name),
    );
    if (judged === undefined) continue;
    const limits = limitsOf(plan, metric);
    if (limits.exact) {
      if (!judged.held || judged.verdict !== "no-change")
        broken.push(
          `exact ${metric.name} is not the same number on every sample of identical trees`,
        );
    } else if (metric.role === "primary") {
      if (judged.verdict === "inconclusive")
        noisy.push({
          metric: metric.name,
          why: `${metric.name} is inconclusive against itself: its 95% interval ${bounds(judged.interval)} is wider than twice its threshold of ${limits.threshold}%`,
        });
      else if (judged.verdict !== "no-change")
        noisy.push({
          metric: metric.name,
          why: `${metric.name} differs from itself: its 95% interval ${bounds(judged.interval)} leaves out no change`,
        });
    } else if (!judged.held) {
      const [low, high] = judged.interval;
      const worse = metric.direction === "lower" ? high - 1 : 1 - low;
      noisy.push({
        metric: metric.name,
        why: `guardrail ${metric.name} is not held against itself: its interval reaches ${(worse * 100).toFixed(1)}% worse, beyond its tolerance of ${limits.tolerance}%${limits.absolute ? ` and its absolute of ${limits.absolute}` : ""}`,
      });
    }
  }
  if (broken.length > 0) return { _tag: "HarnessBroken", why: broken };
  if (noisy.length > 0) return { _tag: "ProofUnavailable", lost: noisy };
  return { _tag: "Calibrated" };
};
