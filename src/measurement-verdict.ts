import * as Num from "effect/Number";
import * as Arr from "effect/Array";
import { Data, Effect, Random, Schema } from "effect";

const RESAMPLES = 4000;
const ROUNDING = 1e-9;

export interface MetricSamples {
  readonly metric: string;
  readonly direction: "lower" | "higher";
  readonly base: ReadonlyArray<number>;
  readonly candidate: ReadonlyArray<number>;
}

export interface Limits {
  readonly threshold: number;
  readonly tolerance: number;
  readonly absolute?: number;
  readonly exact?: boolean;
}

export const Judgement = Schema.Struct({
  metric: Schema.String,
  // oxlint-disable-next-line effecttsgo/schema-number -- A zero baseline yields an infinite ratio.
  ratio: Schema.Number,
  // oxlint-disable-next-line effecttsgo/schema-number -- Bootstrap ratio bounds can be infinite too.
  interval: Schema.Tuple([Schema.Number, Schema.Number]),
  verdict: Schema.Literals(["gain", "no-change", "regression", "inconclusive"]),
  held: Schema.Boolean,
});
export type Judgement = typeof Judgement.Type;

// WARNING: Infinite ratios and bounds are kept as they are: plain JSON writes them as null.
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
    if (values.length < 2) {
      return `${side} has ${values.length} sample(s), at least 2 are needed`;
    }
    if (!Arr.every(values, Number.isFinite)) {
      return `${side} has a non-finite sample`;
    }
  }
  return null;
};

const varies = (values: ReadonlyArray<number>) => Arr.some(values, (one) => one !== values[0]);

export const judge = (
  measurement: string,
  samples: MetricSamples,
  { threshold, tolerance, absolute = 0, exact = false }: Limits,
) =>
  Effect.gen(function* () {
    const reason = refusal(samples);
    if (reason !== null) {
      return yield* new MeasurementRefused({ metric: samples.metric, reason });
    }

    const ratio = ratioOf(median(samples.candidate), median(samples.base));
    const difference = median(samples.candidate) - median(samples.base);
    if (exact && (varies(samples.base) || varies(samples.candidate))) {
      return {
        metric: samples.metric,
        ratio,
        interval: [ratio, ratio] as const,
        verdict: "inconclusive" as const,
        held: false,
      };
    }

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
    const bounds: (values: Array<number>) => [number, number] = (values) => {
      values.sort((a, b) => a - b);
      return [values[Math.floor(RESAMPLES * 0.025)]!, values[Math.ceil(RESAMPLES * 0.975) - 1]!];
    };
    const [low, high] = bounds(ratios);
    const [lowBy, highBy] = bounds(differences);

    const better = samples.direction === "lower" ? -1 : 1;
    const gainOf = (value: number) => better * (value - 1);
    const worstGain = Math.min(gainOf(low), gainOf(high));
    const bestGain = Math.max(gainOf(low), gainOf(high));
    const worstBy = Math.min(better * lowBy, better * highBy);
    const beyondSlack = (by: number) => absolute === 0 || by > absolute;
    const verdict: Judgement["verdict"] =
      worstGain > 0 &&
      gainOf(ratio) >= threshold / 100 - ROUNDING &&
      beyondSlack(better * difference)
        ? "gain"
        : bestGain < 0 &&
            -gainOf(ratio) > tolerance / 100 + ROUNDING &&
            beyondSlack(-better * difference)
          ? "regression"
          : high - low > (2 * threshold) / 100 && (absolute === 0 || highBy - lowBy > 2 * absolute)
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
