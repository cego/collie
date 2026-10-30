// What `run report` measures beyond where Runs ended: review rounds, dispositions,
// steering, verifications, parks and context. Each measure is counted from what a Run
// recorded and names the Runs it counts. Data only: nothing here is a threshold.

import * as Num from "effect/Number";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { Effect, FileSystem, Schema } from "effect";
import { evidenceDir, runDir } from "./engine";
import { readAudit } from "./audit";
import { readDispositions, latest } from "./disposition";
import { launchDir, readLaunches, stemOf } from "./launches";
import { deliveriesOf } from "./steering";
import { readVerifications } from "./verify";
import type { Metric } from "./metrics";

const STEERING = ["steer", "followup", "deliver", "correction"] as const;
type SteeringKind = (typeof STEERING)[number];

/** One Run's records the measures are counted from, as its host reads them. */
export const OutcomeRecords = Schema.Struct({
  /** Each review step's round, and the most its rally allowed, as its prompt said. */
  rounds: Schema.Array(Schema.Struct({ round: Schema.Int, of: Schema.Int })),
  disposition: Schema.NullOr(Schema.Literals(["merged", "abandoned", "superseded"])),
  steering: Schema.Array(Schema.Struct({ kind: Schema.Literals(STEERING), origin: Schema.String })),
  verifications: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      executable: Schema.String,
      argv: Schema.Array(Schema.String),
      cwd: Schema.String,
      start: Schema.String,
      result: Schema.String,
      by: Schema.String,
    }),
  ),
});
export type OutcomeRecords = typeof OutcomeRecords.Type;

const ITERATION = /Iteration (\d+) of at most (\d+)\./;

export const outcomeRecordsOf = Effect.fn("Outcomes.records")(function* (
  stateDir: string,
  runId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const rounds: Array<{ round: number; of: number }> = [];
  for (const launch of yield* readLaunches(stateDir, runId)) {
    if (launch.role !== "reviewer") continue;
    const prompt = yield* fs
      .readFileString(`${launchDir(stateDir, runId)}/${stemOf(launch)}.prompt.md`)
      .pipe(Effect.orElseSucceed(() => ""));
    const found = ITERATION.exec(prompt);
    if (found !== null) rounds.push({ round: Number(found[1]), of: Number(found[2]) });
  }
  const dir = runDir(stateDir, runId);
  const steering: Array<{ kind: SteeringKind; origin: string }> = [];
  for (const line of yield* readAudit(dir).pipe(Effect.orElseSucceed(() => [])))
    for (const kind of STEERING)
      if (line.operation === kind) steering.push({ kind, origin: line.actor.origin });
  const corrections = new Set<string>();
  for (const { delivery } of yield* deliveriesOf(stateDir, runId).pipe(
    Effect.orElseSucceed(() => []),
  ))
    if (delivery.cause.kind === "correction") corrections.add(delivery.causal_key);
  for (const _ of corrections) steering.push({ kind: "correction", origin: "evaluator" });
  const verifications = yield* readVerifications(evidenceDir(stateDir, runId)).pipe(
    Effect.orElseSucceed(() => []),
  );
  return {
    rounds,
    disposition:
      latest(yield* readDispositions(dir).pipe(Effect.orElseSucceed(() => [])))?.kind ?? null,
    steering,
    verifications: Arr.map(verifications, (one) => ({
      name: one.name,
      executable: one.executable,
      argv: one.argv,
      cwd: one.cwd,
      start: `${one.start.head_sha}:${one.start.fingerprint}`,
      result: one.result,
      by: one.by,
    })),
  } satisfies OutcomeRecords;
});

/** The Runs a measure counts, so an issue can cite them. */
export interface Counted {
  readonly count: number;
  readonly runs: ReadonlyArray<string>;
}

export const ORIGINS = ["human", "chat", "agent", "host"] as const;
export type Origin = (typeof ORIGINS)[number];

/** Which kind of asker a front door is: a person at it, chat, an agent's CLI, or Collie. */
export const originOf = (door: string): Origin => {
  switch (door) {
    case "cli-tty":
    case "board":
    case "desktop":
      return "human";
    case "chat":
      return "chat";
    case "cli":
    case "agent":
      return "agent";
    default:
      return "host";
  }
};

export interface Measures {
  readonly rounds: {
    /** Runs with a review rally, the round each reached and the most it allowed. */
    readonly runs: ReadonlyArray<{ runId: string; reached: number; cap: number }>;
    readonly median: number | null;
    readonly atCap: Counted;
  };
  readonly dispositions: Record<
    "merged" | "superseded" | "abandoned",
    Counted & { readonly share: number | null }
  >;
  readonly steering: {
    readonly runs: ReadonlyArray<
      { runId: string } & Record<SteeringKind, number> & { byOrigin: Record<Origin, number> }
    >;
    readonly byOrigin: Record<Origin, Counted>;
  };
  readonly verifications: {
    readonly total: number;
    readonly runs: ReadonlyArray<{ runId: string; total: number; agent: number; collie: number }>;
    readonly byCollector: { readonly agent: number; readonly collie: number };
    /** Same Run, spec, start tree, result and collector as one recorded before it. */
    readonly repeated: Counted;
    /** Named only by the executable that ran it, such as "bun". */
    readonly executableOnly: Counted;
  };
  readonly parks: {
    readonly byReason: ReadonlyArray<Counted & { readonly reason: string }>;
    /** An agent's collect budget ran out before it wrote its Output. */
    readonly collectExpiries: Counted;
  };
  /** The largest context sampled at a work boundary; not tokens consumed. */
  readonly peakContext: ReadonlyArray<{
    runId: string;
    tokens: number | null;
    agent: string | null;
  }>;
}

const counted = (runs: ReadonlyArray<string>): Counted => ({
  count: runs.length,
  runs: [...new Set(runs)],
});

const median = (values: ReadonlyArray<number>): number | null => {
  if (values.length === 0) return null;
  const sorted = Arr.sortWith(
    values,
    (value) => value,
    (a, b) => Num.sign(a - b),
  );
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

const COLLECT_EXPIRY = "has written nothing";

/** A park's reason without what names one Run, pane, path or command, so like counts with like. */
export const reasonOf = (note: string): string =>
  pipe(
    note,
    Str.replace(/`[^`]*`/g, "<command>"),
    Str.replace(/(?<![\w-])\/\S+/g, "<path>"),
    Str.replace(/\brun-[0-9a-f]+[\w.-]*/g, "<run>"),
    Str.replace(/\bw\w*:p\d+\b/g, "<pane>"),
  );

const executableName = (path: string) => Str.split(path, "/").at(-1) ?? path;

export function measuresOf(
  runs: ReadonlyArray<{
    readonly runId: string;
    readonly records: OutcomeRecords | null;
    readonly metrics: ReadonlyArray<Metric>;
  }>,
): Measures {
  const rounds: Array<{ runId: string; reached: number; cap: number }> = [];
  const dispositions: Record<"merged" | "superseded" | "abandoned", string[]> = {
    merged: [],
    superseded: [],
    abandoned: [],
  };
  const steering: Array<Measures["steering"]["runs"][number]> = [];
  const byOrigin: Record<Origin, string[]> = { human: [], chat: [], agent: [], host: [] };
  const verifications: Array<Measures["verifications"]["runs"][number]> = [];
  const repeated: string[] = [];
  const executableOnly: string[] = [];
  const reasons = new Map<string, string[]>();
  const collectExpiries: string[] = [];
  const peakContext: Array<Measures["peakContext"][number]> = [];

  for (const { runId, records, metrics } of runs) {
    for (const line of metrics) {
      if (line.kind !== "halt") continue;
      if (pipe(line.note, Str.includes(COLLECT_EXPIRY))) collectExpiries.push(runId);
      else {
        const reason = reasonOf(line.note);
        reasons.set(reason, [...(reasons.get(reason) ?? []), runId]);
      }
    }
    const peak = Arr.reduce<Metric, Metric | null>(
      Arr.filter(metrics, (line) => line.kind === "context"),
      null,
      (top, line) => (top === null || line.value > top.value ? line : top),
    );
    peakContext.push({ runId, tokens: peak?.value ?? null, agent: peak?.subject ?? null });

    if (records === null) continue;
    const rally = Arr.filter(records.rounds, (one) => one.of > 1);
    if (rally.length > 0)
      rounds.push({
        runId,
        reached: Math.max(...Arr.map(rally, (one) => one.round)),
        cap: Math.max(...Arr.map(rally, (one) => one.of)),
      });
    if (records.disposition !== null) dispositions[records.disposition].push(runId);

    if (records.steering.length > 0) {
      const one = {
        runId,
        steer: 0,
        followup: 0,
        deliver: 0,
        correction: 0,
        byOrigin: { human: 0, chat: 0, agent: 0, host: 0 },
      };
      for (const { kind, origin } of records.steering) {
        one[kind] += 1;
        one.byOrigin[originOf(origin)] += 1;
        byOrigin[originOf(origin)].push(runId);
      }
      steering.push(one);
    }

    if (records.verifications.length > 0) {
      const seen = new Set<string>();
      let agent = 0;
      for (const one of records.verifications) {
        if (one.by === "agent") agent += 1;
        const key = JSON.stringify([
          one.name,
          one.executable,
          one.argv,
          one.cwd,
          one.start,
          one.result,
          one.by,
        ]);
        if (seen.has(key)) repeated.push(runId);
        seen.add(key);
        if (one.name === executableName(one.executable)) executableOnly.push(runId);
      }
      const total = records.verifications.length;
      verifications.push({ runId, total, agent, collie: total - agent });
    }
  }

  const disposed =
    dispositions.merged.length + dispositions.superseded.length + dispositions.abandoned.length;
  const share = (of: string[]) => (disposed === 0 ? null : of.length / disposed);
  const atCap = Arr.map(
    Arr.filter(rounds, (one) => one.reached >= one.cap),
    (one) => one.runId,
  );
  return {
    rounds: {
      runs: rounds,
      median: median(Arr.map(rounds, (one) => one.reached)),
      atCap: counted(atCap),
    },
    dispositions: {
      merged: { ...counted(dispositions.merged), share: share(dispositions.merged) },
      superseded: { ...counted(dispositions.superseded), share: share(dispositions.superseded) },
      abandoned: { ...counted(dispositions.abandoned), share: share(dispositions.abandoned) },
    },
    steering: {
      runs: steering,
      byOrigin: {
        human: counted(byOrigin.human),
        chat: counted(byOrigin.chat),
        agent: counted(byOrigin.agent),
        host: counted(byOrigin.host),
      },
    },
    verifications: {
      total: Arr.reduce(verifications, 0, (sum, one) => sum + one.total),
      runs: verifications,
      byCollector: {
        agent: Arr.reduce(verifications, 0, (sum, one) => sum + one.agent),
        collie: Arr.reduce(verifications, 0, (sum, one) => sum + one.collie),
      },
      repeated: counted(repeated),
      executableOnly: counted(executableOnly),
    },
    parks: {
      byReason: Arr.sortWith(
        Arr.map([...reasons], ([reason, of]) => ({ reason, ...counted(of) })),
        (value) => value,
        (a, b) => Num.sign(b.count - a.count || pipe(a.reason, Str.localeCompare(b.reason))),
      ),
      collectExpiries: counted(collectExpiries),
    },
    peakContext,
  };
}
