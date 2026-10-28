// A Measurement's judgement: one metric's samples on each tree turned into a verdict
// (ADR-draft-a-performance-gain-is-proved-by-the-hosts-measurement). Pure and seeded from
// the Measurement id, so a replay of the same samples judges identically.

import { Data, Effect, Random, Schema } from "effect";

const RESAMPLES = 4000;
/** Below any real difference, above a ratio's rounding: 100→102 is exactly 2% worse. */
const ROUNDING = 1e-9;

export interface MetricSamples {
  readonly metric: string;
  readonly direction: "lower" | "higher";
  readonly base: ReadonlyArray<number>;
  readonly candidate: ReadonlyArray<number>;
}

/** Percentages: a gain must improve by at least `threshold`, a regression worsen by more than `tolerance`. */
export interface Limits {
  readonly threshold: number;
  readonly tolerance: number;
}

export const Judgement = Schema.Struct({
  metric: Schema.String,
  /** Candidate's median over base's. */
  ratio: Schema.Number,
  /** The 95% bootstrap interval on `ratio`. */
  interval: Schema.Tuple([Schema.Number, Schema.Number]),
  verdict: Schema.Literals(["gain", "no-change", "regression", "inconclusive"]),
  /** The interval's worse bound is within tolerance. */
  held: Schema.Boolean,
});
export type Judgement = typeof Judgement.Type;

/** Keeps an infinite ratio or bound, which plain JSON writes as null. */
export const JudgementJson = Schema.fromJsonString(Schema.toCodecJson(Judgement));

export class MeasurementRefused extends Data.TaggedError("MeasurementRefused")<{
  readonly metric: string;
  readonly reason: string;
}> {
  override get message() {
    return `${this.metric} cannot be judged: ${this.reason}`;
  }
}

const median = (values: ReadonlyArray<number>) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

const ratioOf = (candidate: number, base: number) =>
  base !== 0 ? candidate / base : candidate === 0 ? 1 : Infinity;

const refusal = (samples: MetricSamples) => {
  for (const [side, values] of [
    ["base", samples.base],
    ["candidate", samples.candidate],
  ] as const) {
    if (values.length < 2) return `${side} has ${values.length} sample(s), at least 2 are needed`;
    if (!values.every(Number.isFinite)) return `${side} has a non-finite sample`;
  }
  return null;
};

export const judge = (
  measurement: string,
  samples: MetricSamples,
  { threshold, tolerance }: Limits,
): Effect.Effect<Judgement, MeasurementRefused> =>
  Effect.gen(function* () {
    const reason = refusal(samples);
    if (reason !== null) return yield* new MeasurementRefused({ metric: samples.metric, reason });

    const random = yield* Random.Random;
    const resample = (values: ReadonlyArray<number>) =>
      median(values.map(() => values[Math.floor(random.nextDoubleUnsafe() * values.length)]!));
    const ratios = Array.from({ length: RESAMPLES }, () =>
      ratioOf(resample(samples.candidate), resample(samples.base)),
    ).sort((a, b) => a - b);
    const low = ratios[Math.floor(RESAMPLES * 0.025)]!;
    const high = ratios[Math.ceil(RESAMPLES * 0.975) - 1]!;
    const ratio = ratioOf(median(samples.candidate), median(samples.base));

    // How much better than no change a ratio is: negative is worse.
    const gainOf = (value: number) => (samples.direction === "lower" ? 1 - value : value - 1);
    const worstGain = Math.min(gainOf(low), gainOf(high));
    const bestGain = Math.max(gainOf(low), gainOf(high));
    const verdict: Judgement["verdict"] =
      worstGain > 0 && gainOf(ratio) >= threshold / 100 - ROUNDING
        ? "gain"
        : bestGain < 0 && -gainOf(ratio) > tolerance / 100 + ROUNDING
          ? "regression"
          : high - low > (2 * threshold) / 100
            ? "inconclusive"
            : "no-change";
    return {
      metric: samples.metric,
      ratio,
      interval: [low, high] as const,
      verdict,
      held: worstGain >= -tolerance / 100 - ROUNDING,
    };
  }).pipe(Random.withSeed(`${measurement}/${samples.metric}`));
