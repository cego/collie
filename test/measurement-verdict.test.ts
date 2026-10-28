// A Measurement's verdict per metric, from hand-picked samples with known answers.

import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import {
  JudgementJson,
  judge,
  type Judgement,
  type MetricSamples,
} from "../src/measurement-verdict";

const ID = "measurement-7f3a";
const LIMITS = { threshold: 5, tolerance: 2 };

const of = (value: number, count = 10) => Array.from({ length: count }, () => value);

const run = (samples: MetricSamples, id = ID, limits = LIMITS): Judgement =>
  Effect.runSync(judge(id, samples, limits));

const latency = (base: ReadonlyArray<number>, candidate: ReadonlyArray<number>): MetricSamples => ({
  metric: "p95",
  direction: "lower",
  base,
  candidate,
});

describe("a metric's verdict", () => {
  test("a whole 20% drop where lower is better is a gain of ratio 0.8", () => {
    const judged = run(latency(of(100), of(80)));
    expect(judged.verdict).toBe("gain");
    expect(judged.ratio).toBeCloseTo(0.8, 10);
    expect(judged.held).toBe(true);
  });

  test("a tight, significant 3% improvement under a 5% threshold is no-change", () => {
    const judged = run(
      latency([100, 101, 99, 100, 100, 101, 99, 100], [97, 98, 96, 97, 97, 98, 96, 97]),
    );
    expect(judged.interval[1]).toBeLessThan(1);
    expect(judged.verdict).toBe("no-change");
  });

  test("a guardrail 4% worse is a regression under a 2% tolerance, and 1% worse is not", () => {
    const worse = run(latency(of(100), [104, 104, 104, 104, 105, 103, 104, 104, 104, 104]));
    expect(worse.verdict).toBe("regression");
    expect(worse.held).toBe(false);

    const slightly = run(latency(of(100), [101, 101, 101, 101, 101, 101, 101, 101, 101, 101]));
    expect(slightly.verdict).toBe("no-change");
    expect(slightly.held).toBe(true);
  });

  test("samples that cannot tell more than twice the threshold apart are inconclusive", () => {
    const judged = run(
      latency(
        [60, 140, 80, 120, 100, 70, 130, 90, 110, 100],
        [70, 150, 90, 120, 100, 60, 140, 85, 115, 95],
      ),
    );
    expect(judged.verdict).toBe("inconclusive");
    expect(judged.held).toBe(false);
  });

  test("a higher-is-better metric gains when the candidate's median is the larger", () => {
    const throughput = (
      base: ReadonlyArray<number>,
      candidate: ReadonlyArray<number>,
    ): MetricSamples => ({
      metric: "requests/s",
      direction: "higher",
      base,
      candidate,
    });
    const faster = run(throughput(of(100), of(120)));
    expect(faster.verdict).toBe("gain");
    expect(faster.ratio).toBeCloseTo(1.2, 10);

    const slower = run(throughput(of(100), of(80)));
    expect(slower.verdict).toBe("regression");
    expect(slower.held).toBe(false);
  });

  test("a significant 40% gain with a wide interval is still a gain", () => {
    const judged = run(
      latency(
        [95, 100, 105, 98, 102, 97, 103, 100, 99, 101],
        [40, 80, 50, 70, 60, 45, 75, 55, 65, 60],
      ),
    );
    expect(judged.ratio).toBeCloseTo(0.6, 10);
    expect(judged.interval[1] - judged.interval[0]).toBeGreaterThan(0.1);
    expect(judged.verdict).toBe("gain");
  });

  test("a guardrail whose interval reaches 2.00 is not held, and one tight at 1% worse is", () => {
    const wide = run(latency(of(100), [60, 60, 60, 130, 130, 130, 130, 200, 200, 200]));
    expect(wide.ratio).toBeCloseTo(1.3, 10);
    expect(wide.interval).toEqual([0.6, 2]);
    expect(wide.held).toBe(false);

    const tight = run(latency(of(100), of(101)));
    expect(tight.held).toBe(true);
  });

  test("zero medians are defined, never divided by", () => {
    const bothZero = run(latency(of(0), of(0)));
    expect(bothZero).toMatchObject({ verdict: "no-change", held: true, ratio: 1 });

    const fromZero = run(latency(of(0), of(3)));
    expect(fromZero).toMatchObject({ verdict: "regression", held: false, ratio: Infinity });

    const toZero = run(latency(of(5), of(0)));
    expect(toZero).toMatchObject({ verdict: "gain", ratio: 0 });
  });

  test("an infinite ratio and bound survive the record", () => {
    const judged = run(latency(of(0), of(3)));
    const json = Schema.encodeSync(JudgementJson)(judged);
    expect(Schema.decodeSync(JudgementJson)(json)).toEqual(judged);
  });
});

describe("a replay", () => {
  // Many distinct values, so the interval's bounds depend on which resamples are drawn.
  const spread = (centre: number) =>
    Array.from({ length: 30 }, (_, i) => centre + ((i * 7) % 30) * 1.37 + i * 0.013);
  const noisy = latency(spread(100), spread(98));

  test("judges the same samples under the same Measurement id identically", () => {
    expect(run(noisy)).toEqual(run(noisy));
  });

  test("draws its resamples from the Measurement id", () => {
    const intervals = ["measurement-a", "measurement-b", "measurement-c"].map(
      (id) => run(noisy, id).interval,
    );
    expect(new Set(intervals.map((interval) => interval.join())).size).toBeGreaterThan(1);
  });
});

describe("samples that cannot be judged", () => {
  const refusal = (samples: MetricSamples) =>
    Effect.runSync(Effect.flip(judge(ID, samples, LIMITS)));

  test("fewer than two on a side are refused, naming the metric", () => {
    expect(refusal(latency([100], of(80))).message).toContain("p95");
    expect(refusal(latency(of(100), [80])).message).toContain("p95");
  });

  test("a non-finite sample is refused, naming the metric", () => {
    expect(refusal(latency(of(100), [80, Number.NaN, 80])).message).toContain("p95");
    expect(refusal(latency([100, Infinity], of(80))).message).toContain("p95");
  });
});
