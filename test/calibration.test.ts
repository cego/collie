// What a Measurement of the base against itself says about proving anything with its plan.

import * as Arr from "effect/Array";
import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { BenchmarkPlan, calibrationOf, type Measurement } from "../src/measurement-model";
import { Judgement } from "../src/measurement-verdict";
import ff23b932 from "./fixtures/measurements/run-ff23b932-calibration.json" with { type: "json" };

type Calibrated = Pick<Measurement, "plan" | "result">;

const Recorded = Schema.Struct({
  plan: BenchmarkPlan,
  result: Schema.TaggedStruct("Judged", { verdicts: Schema.Array(Judgement) }),
});
const recorded: Calibrated = Effect.runSync(Schema.decodeUnknownEffect(Recorded)(ff23b932));

const plan = (metrics: Measurement["plan"]["metrics"]): Measurement["plan"] => ({
  ...recorded.plan,
  metrics,
});
const judged = (...verdicts: ReadonlyArray<Judgement>): Measurement["result"] => ({
  _tag: "Judged",
  verdicts,
});
const verdict = (
  metric: string,
  interval: readonly [number, number],
  held: boolean,
): Judgement => ({
  metric,
  ratio: 1,
  interval,
  verdict: held ? "no-change" : "inconclusive",
  held,
});

describe("run-ff23b932's calibration, replayed", () => {
  const read = calibrationOf(recorded);

  test("rules proof out for noise, not for a broken harness", () => {
    expect(read._tag).toBe("ProofUnavailable");
  });

  test("names each metric it lost with how far its interval reaches past its limit", () => {
    const lost = read._tag === "ProofUnavailable" ? read.lost : [];
    const why = Arr.map(lost, (one) => one.why);
    expect(why).toContain(
      "rest.host_idle_cpu_ms is inconclusive against itself: its 95% interval [0.943, 1.046] is wider than twice its threshold of 5%",
    );
    expect(why).toContain(
      "guardrail rest.runs_p50_ms is not held against itself: its interval reaches 22.3% worse, beyond its tolerance of 2%",
    );
    expect(Arr.map(lost, (one) => one.metric)).toEqual([
      "rest.host_idle_cpu_ms",
      "rest.host_busy_wake_fresh_max_ms",
      "rest.host_busy_board_fresh_p95_ms",
      "rest.runs_p50_ms",
      "rest.host_busy_door_lag_p99_ms",
      "rest.host_busy_cpu_ms",
      "rest.host_idle_rss_kb",
      "rest.host_start_ms",
      "rest.desktop_desktop_idle_cpu_ms",
      "rest.chrome_desktop_idle_cpu_ms",
      "rest.view_heap_kb",
    ]);
  });
});

describe("a calibration", () => {
  const primary = { name: "a.cpu", direction: "lower", role: "primary" } as const;
  const guardrail = { name: "a.lag", direction: "lower", role: "guardrail" } as const;

  test("whose primary and guardrails hold is calibrated", () => {
    expect(
      calibrationOf({
        plan: plan([primary, guardrail]),
        result: judged(verdict("a.cpu", [0.98, 1.02], true), verdict("a.lag", [0.99, 1.01], true)),
      }),
    ).toEqual({ _tag: "Calibrated" });
  });

  test("names a guardrail's own tolerance and absolute slack", () => {
    const read = calibrationOf({
      plan: plan([
        primary,
        { ...guardrail, tolerance: 25, absolute: 20, why: "the door's 20 ms p99 target" },
      ]),
      result: judged(verdict("a.cpu", [0.98, 1.02], true), verdict("a.lag", [0.6, 1.7], false)),
    });
    expect(read._tag === "ProofUnavailable" ? read.lost : []).toEqual([
      {
        metric: "a.lag",
        why: "guardrail a.lag is not held against itself: its interval reaches 70.0% worse, beyond its tolerance of 25% and its absolute of 20",
      },
    ]);
  });

  test("that ran nothing to judge is a broken harness", () => {
    expect(
      calibrationOf({
        plan: plan([primary]),
        result: {
          _tag: "Failed",
          tree: "candidate",
          stage: "prepare",
          command: "bun bench/prepare.ts",
          exit: 1,
          output: "Cannot find package 'effect'",
        },
      })._tag,
    ).toBe("HarnessBroken");
  });

  test("whose exact metric differs against itself is a broken harness, whatever else is lost", () => {
    const read = calibrationOf({
      plan: plan([
        primary,
        {
          name: "a.mismatches",
          direction: "lower",
          role: "guardrail",
          exact: true,
          why: "a count",
        },
      ]),
      result: judged(verdict("a.cpu", [0.8, 1.3], false), verdict("a.mismatches", [1, 1], false)),
    });
    expect(read).toEqual({
      _tag: "HarnessBroken",
      why: ["exact a.mismatches is not the same number on every sample of identical trees"],
    });
  });

  test("whose primary differs from itself cannot attribute a later gain", () => {
    const read = calibrationOf({
      plan: plan([primary]),
      result: judged({
        ...verdict("a.cpu", [1.04, 1.12], true),
        ratio: 1.08,
        verdict: "regression",
      }),
    });
    expect(read._tag).toBe("ProofUnavailable");
    expect(read._tag === "ProofUnavailable" ? read.lost : []).toEqual([
      {
        metric: "a.cpu",
        why: "a.cpu differs from itself: its 95% interval [1.040, 1.120] leaves out no change",
      },
    ]);
  });
});
