// A Measurement's judgement: one metric's samples on each tree turned into a verdict
// (ADR-draft-a-performance-gain-is-proved-by-the-hosts-measurement). Pure and seeded from
// the Measurement id, so a replay of the same samples judges identically.

import * as Num from "effect/Number";
import * as Arr from "effect/Array";
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
  /** In the metric's units: a difference this small is neither a gain nor a regression. */
  readonly absolute?: number;
  /** Every sample of a tree must be the same number, judged by that value. */
  readonly exact?: boolean;
}

export const Judgement = Schema.Struct({
  metric: Schema.String,
  /** Candidate's median over base's. */
  // oxlint-disable-next-line effecttsgo/schema-number -- A zero baseline yields an infinite ratio.
  ratio: Schema.Number,
  /** The 95% bootstrap interval on `ratio`. */
  // oxlint-disable-next-line effecttsgo/schema-number -- Bootstrap ratio bounds can be infinite too.
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
  const sorted = Arr.sortWith(
    values,
    (value) => value,
    (a, b) => Num.sign(a - b),
  );
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
    if (!Arr.every(values, Number.isFinite)) return `${side} has a non-finite sample`;
  }
  return null;
};

const varies = (values: ReadonlyArray<number>) => Arr.some(values, (one) => one !== values[0]);

export const judge = (
  measurement: string,
  samples: MetricSamples,
  { threshold, tolerance, absolute = 0, exact = false }: Limits,
): Effect.Effect<Judgement, MeasurementRefused> =>
  Effect.gen(function* () {
    const reason = refusal(samples);
    if (reason !== null) return yield* new MeasurementRefused({ metric: samples.metric, reason });

    const ratio = ratioOf(median(samples.candidate), median(samples.base));
    const difference = median(samples.candidate) - median(samples.base);
    if (exact && (varies(samples.base) || varies(samples.candidate)))
      return {
        metric: samples.metric,
        ratio,
        interval: [ratio, ratio] as const,
        verdict: "inconclusive" as const,
        held: false,
      };

    const random = yield* Random.Random;
    const resample = (values: ReadonlyArray<number>) =>
      median(Arr.map(values, () => values[Math.floor(random.nextDoubleUnsafe() * values.length)]!));
    const ratios: Array<number> = [];
    const differences: Array<number> = [];
    for (let at = 0; at < RESAMPLES; at++) {
      const candidate = resample(samples.candidate);
      const base = resample(samples.base);
      ratios.push(ratioOf(candidate, base));
      differences.push(candidate - base);
    }
    const bounds = (values: Array<number>): [number, number] => {
      values.sort((a, b) => a - b);
      return [values[Math.floor(RESAMPLES * 0.025)]!, values[Math.ceil(RESAMPLES * 0.975) - 1]!];
    };
    const [low, high] = bounds(ratios);
    const [lowBy, highBy] = bounds(differences);

    // How much better than no change a ratio or a difference is: negative is worse.
    const better = samples.direction === "lower" ? -1 : 1;
    const gainOf = (value: number) => better * (value - 1);
    const worstGain = Math.min(gainOf(low), gainOf(high));
    const bestGain = Math.max(gainOf(low), gainOf(high));
    const worstBy = Math.min(better * lowBy, better * highBy);
    const beyondSlack = (by: number) => absolute === 0 || by > absolute;
    const resolution = Math.max(threshold, tolerance) / 100;
    const verdict: Judgement["verdict"] =
      worstGain > 0 &&
      gainOf(ratio) >= threshold / 100 - ROUNDING &&
      beyondSlack(better * difference)
        ? "gain"
        : bestGain < 0 &&
            -gainOf(ratio) > tolerance / 100 + ROUNDING &&
            beyondSlack(-better * difference)
          ? "regression"
          : high - low > 2 * resolution && (absolute === 0 || highBy - lowBy > 2 * absolute)
            ? "inconclusive"
            : "no-change";
    return {
      metric: samples.metric,
      ratio,
      interval: [low, high] as const,
      verdict,
      held: worstGain >= -tolerance / 100 - ROUNDING || (absolute > 0 && worstBy >= -absolute),
    };
  }).pipe(Random.withSeed(`${measurement}/${samples.metric}`));
