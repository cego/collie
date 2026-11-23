// Two sets of Runs compared case by case, on what they spent and how good the work was
// (pure). It reports figures and which way each directional quality measure moved, and
// never a percentage or a verdict: the decision rules that read it say what counts.

import * as Arr from "effect/Array";
import * as Num from "effect/Number";
import * as Order from "effect/Order";
import * as Rec from "effect/Record";
import { Schema } from "effect";
import type { AuditLine } from "./audit";
import { findingKey } from "./output";
import { epochMs } from "./time";
import { ledgerOf, recoveryOf, sessionKey, usageOf } from "./usage-ledger-model";
import type { Count, UsageEntry } from "./usage-ledger-model";

/** A finding as any reviewer's Output gives it: a reassessment names only its id and status. */
export const ReviewedFinding = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Literals(["open", "fixed", "disputed", "obsolete"])),
  severity: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  file: Schema.optionalKey(Schema.String),
  line: Schema.optionalKey(Schema.Finite),
});
export type ReviewedFinding = typeof ReviewedFinding.Type;

/** What a Run's host recorded that a comparison reads beside its metric lines. */
export const TrialRecords = Schema.Struct({
  /** Each reviewer Output's findings, in the order its agent was launched. */
  reviews: Schema.Array(Schema.Array(ReviewedFinding)),
  /** Its required Checks that passed on its final tree; null where it never finished. */
  checks: Schema.NullOr(Schema.Struct({ passed: Schema.Int, of: Schema.Int })),
  interventions: Schema.Int,
  ended: Schema.NullOr(Schema.String),
});
export type TrialRecords = typeof TrialRecords.Type;

export interface TrialRun {
  readonly runId: string;
  readonly created: string;
  readonly usage: ReadonlyArray<UsageEntry>;
  readonly records: TrialRecords;
  /** The records of the review Run that audited its final tree, or null for none. */
  readonly audit: TrialRecords | null;
}

export interface Planted {
  readonly file: string;
  readonly line: number;
}

const PHASES = ["startup", "work", "recovery", "total"] as const;
const CATEGORIES = ["output", "cacheRead", "cacheCreation", "input", "reasoning"] as const;
type Phase = (typeof PHASES)[number];
type Category = (typeof CATEGORIES)[number];
type TokenMeasure = `${Phase}.${Category}`;
interface Token {
  readonly measure: TokenMeasure;
  readonly phase: Phase;
  readonly category: Category;
}
const TOKENS = Arr.flatMap(PHASES, (phase) =>
  Arr.map(CATEGORIES, (category): Token => ({ measure: `${phase}.${category}`, phase, category })),
);
const TOKEN_MEASURES = Arr.map(TOKENS, (one) => one.measure);

/** Better is higher for these, and lower for every other directed measure. */
const HIGHER: ReadonlySet<string> = new Set(["accepted", "checksPassed", "plantedCaught"]);
const DIRECTED = [
  "accepted",
  "checksPassed",
  "escapedDefects",
  "plantedCaught",
  "reopenedFindings",
  "interventions",
] as const;
type Directed = (typeof DIRECTED)[number];
const MEASURES = [
  ...TOKEN_MEASURES,
  "sessions",
  "compactions",
  "peakContext",
  "accepted",
  "checksPassed",
  "defectsFound",
  "escapedDefects",
  "reopenedFindings",
  "plantedCaught",
  "interventions",
  "wallMs",
] as const;
type Measure = (typeof MEASURES)[number];

const tabulate = <T, K extends string, V>(
  items: ReadonlyArray<T>,
  key: (item: T) => K,
  value: (item: T) => V,
): Readonly<Record<K, V>> =>
  // SAFETY: callers pass one of the constant lists above, which names every key of `K`.
  Rec.fromIterableWith(items, (item): readonly [K, V] => [key(item), value(item)]) as Record<K, V>;
const same = <K extends string>(key: K) => key;

/** Each measure of one Run, or of a case or set; null where it is unavailable. */
export type Figures = Readonly<Record<Measure, number | null>>;
export type Direction = "no worse" | "worse" | "unavailable";

export interface Side {
  readonly runs: ReadonlyArray<{ readonly runId: string; readonly figures: Figures }>;
  readonly median: Figures;
  readonly range: { readonly min: Figures; readonly max: Figures };
}

export interface SetFigures {
  readonly runs: ReadonlyArray<string>;
  readonly figures: Figures;
  readonly perAcceptedChange: Readonly<Record<TokenMeasure, number | null>> | "no accepted change";
}

export interface Comparison {
  readonly cases: ReadonlyArray<{
    readonly case: string;
    readonly compare: Side;
    readonly against: Side;
    readonly direction: Readonly<Record<Directed, Direction>>;
  }>;
  readonly sets: { readonly compare: SetFigures; readonly against: SetFigures };
}

export type Labelled = { readonly case: string | null; readonly run: TrialRun };

const INTERVENING = new Set(["answer", "steer", "followup", "deliver", "resume", "hold"]);
const COLLIE = new Set(["host", "driver", "evaluator", "schedule"]);

export const interventionsIn = (runId: string, trail: ReadonlyArray<AuditLine>): number =>
  Arr.filter(
    trail,
    (line) =>
      INTERVENING.has(line.operation) &&
      !COLLIE.has(line.actor.origin) &&
      line.actor.from?.run !== runId,
  ).length;

const blocking = (one: ReviewedFinding) =>
  one.severity !== undefined &&
  one.severity !== "minor" &&
  one.status !== "fixed" &&
  one.status !== "obsolete";

const named = (one: ReviewedFinding) => findingKey({ file: one.file, title: one.title ?? "" });
const keyOf = (one: ReviewedFinding) => one.id ?? named(one);

/** A Run's review rounds read as one ledger of findings, each known by its id. */
function ledgerOfReviews(reviews: ReadonlyArray<ReadonlyArray<ReviewedFinding>>) {
  const latest = new Map<string, ReviewedFinding>();
  const raised = new Set<string>();
  const reopened = new Set<string>();
  const statuses = new Map<string, string>();
  const last = Arr.map(reviews.at(-1) ?? [], keyOf);
  for (const review of reviews)
    for (const one of review) {
      const key = keyOf(one);
      const merged = { ...latest.get(key), ...one };
      latest.set(key, merged);
      // By file and title, so a seat's finding and the synthesis's copy with an id are one.
      if (blocking(merged)) raised.add(named(merged));
      const was = statuses.get(key);
      const now = one.status ?? "open";
      if (was === "fixed" && now === "open") reopened.add(key);
      statuses.set(key, now);
    }
  return {
    raised: raised.size,
    reopened: reopened.size,
    /** The last review's blocking findings, by file and title. */
    finalBlocking: new Set(
      Arr.map(
        Arr.filter(
          Arr.map(last, (key) => latest.get(key) ?? {}),
          blocking,
        ),
        named,
      ),
    ).size,
    names: (planted: Planted) =>
      Arr.some(
        [...latest.values()],
        (one) => one.file === planted.file && one.line === planted.line,
      ),
  };
}

const plus = (a: Count, b: Count): Count => (a === null || b === null ? null : a + b);

/** What one Run spent by phase: each session's first request, recovery, and the rest. */
function phasesOf(entries: ReadonlyArray<UsageEntry>) {
  const usage = usageOf(entries);
  const recovering = new Set(
    Arr.map(
      Arr.filter(usage.sessions, (one) => one.recovery),
      sessionKey,
    ),
  );
  const ledger = ledgerOf(entries);
  const retried = recoveryOf(ledger);
  const requests = Arr.sortWith(
    [...ledger.requests.values()],
    (one) => epochMs(one.at),
    Order.Number,
  );
  const opened = new Set<string>();
  const counted = new Set<Phase>();
  const sums = new Map<Phase, Record<Category, Count>>(
    Arr.map(PHASES, (phase) => [
      phase,
      { output: 0, cacheRead: 0, cacheCreation: 0, input: 0, reasoning: 0 },
    ]),
  );
  for (const one of requests) {
    const owner = sessionKey({ agent: one.agent, session: one.parent ?? one.session });
    const first = one.parent === null && !opened.has(owner);
    if (one.parent === null) opened.add(owner);
    const phase: Phase =
      recovering.has(owner) || retried(one) ? "recovery" : first ? "startup" : "work";
    counted.add(phase);
    for (const at of [phase, "total"] as const) {
      const sum = sums.get(at)!;
      for (const category of CATEGORIES) sum[category] = plus(sum[category], one[category]);
    }
  }
  const figures = tabulate(
    TOKENS,
    (one) => one.measure,
    ({ phase, category }) =>
      requests.length === 0 || (!counted.has(phase) && sums.get("total")![category] === null)
        ? null
        : sums.get(phase)![category],
  );
  return { figures, usage };
}

const flag = (value: boolean | null) => (value === null ? null : value ? 1 : 0);

function figuresOf(run: TrialRun, planted: Planted | undefined): Figures {
  const { figures, usage } = phasesOf(run.usage);
  const { records } = run;
  const reviewed = records.reviews.length === 0 ? null : ledgerOfReviews(records.reviews);
  const audit =
    run.audit === null || run.audit.reviews.length === 0
      ? null
      : ledgerOfReviews(run.audit.reviews);
  const checksPassed = records.checks === null ? null : records.checks.passed === records.checks.of;
  const peaks = Arr.filter(
    Arr.map(usage.sessions, (one) => one.peakContext),
    (peak): peak is number => peak !== null,
  );
  return {
    ...figures,
    sessions: usage.sessions.length,
    compactions: Arr.reduce(usage.sessions, 0, (sum, one) => sum + one.compactions),
    peakContext: peaks.length === 0 ? null : Math.max(...peaks),
    accepted: flag(reviewed !== null && reviewed.finalBlocking === 0 && checksPassed === true),
    checksPassed: flag(checksPassed),
    defectsFound: reviewed?.raised ?? null,
    escapedDefects: audit === null ? null : audit.finalBlocking,
    reopenedFindings: reviewed?.reopened ?? null,
    plantedCaught:
      planted === undefined ? null : flag(reviewed !== null && reviewed.names(planted)),
    interventions: records.interventions,
    wallMs: records.ended === null ? null : epochMs(records.ended) - epochMs(run.created),
  };
}

const each =
  (fold: (values: ReadonlyArray<number>) => number) =>
  (all: ReadonlyArray<Figures>): Figures =>
    tabulate(MEASURES, same, (measure) => {
      const known = Arr.filter(
        Arr.map(all, (one) => one[measure]),
        (value): value is number => value !== null,
      );
      return known.length === 0 || known.length < all.length ? null : fold(known);
    });

const median = each((values) => {
  const sorted = Arr.sort(values, Num.Order);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
});
const minimum = each((values) => Math.min(...values));
const maximum = each((values) => Math.max(...values));
const total = (all: ReadonlyArray<Figures>): Figures => {
  const summed = each((values) => Num.sumAll(values))(all);
  return { ...summed, peakContext: maximum(all).peakContext };
};

const directionOf = (compare: Figures, against: Figures, measure: Directed): Direction => {
  const before = compare[measure];
  const after = against[measure];
  if (before === null || after === null) return "unavailable";
  const higher = HIGHER.has(measure);
  return (higher ? after >= before : after <= before) ? "no worse" : "worse";
};

/** Cases in the order first named; Runs with no label are matched by position. */
function casesOf(compare: ReadonlyArray<Labelled>, against: ReadonlyArray<Labelled>) {
  const labelOf = (side: ReadonlyArray<Labelled>) => {
    let unlabelled = 0;
    return Arr.map(side, (one) => ({
      label: one.case ?? `#${(unlabelled += 1)}`,
      run: one.run,
    }));
  };
  const first = labelOf(compare);
  const second = labelOf(against);
  const labels = Arr.dedupe(Arr.map([...first, ...second], (one) => one.label));
  return Arr.map(labels, (label) => ({
    label,
    compare: Arr.filter(first, (one) => one.label === label),
    against: Arr.filter(second, (one) => one.label === label),
  }));
}

export function compareSets(ask: {
  readonly compare: ReadonlyArray<Labelled>;
  readonly against: ReadonlyArray<Labelled>;
  readonly planted: Readonly<Record<string, Planted>>;
}): Comparison {
  const sideOf = (label: string, runs: ReadonlyArray<{ readonly run: TrialRun }>): Side => {
    const measured = Arr.map(runs, ({ run }) => ({
      runId: run.runId,
      figures: figuresOf(run, ask.planted[label]),
    }));
    const all = Arr.map(measured, (one) => one.figures);
    return { runs: measured, median: median(all), range: { min: minimum(all), max: maximum(all) } };
  };
  const cases = Arr.map(casesOf(ask.compare, ask.against), (one) => {
    const compare = sideOf(one.label, one.compare);
    const against = sideOf(one.label, one.against);
    const direction = tabulate(DIRECTED, same, (measure) =>
      directionOf(compare.median, against.median, measure),
    );
    return { case: one.label, compare, against, direction };
  });
  const setOf = (side: "compare" | "against"): SetFigures => {
    const runs = Arr.flatMap(cases, (one) => one[side].runs);
    const figures = total(Arr.map(runs, (one) => one.figures));
    const accepted = figures.accepted ?? 0;
    return {
      runs: Arr.map(runs, (one) => one.runId),
      figures,
      perAcceptedChange:
        accepted === 0
          ? "no accepted change"
          : tabulate(TOKEN_MEASURES, same, (measure) => {
              const value = figures[measure];
              return value === null ? null : value / accepted;
            }),
    };
  };
  return { cases, sets: { compare: setOf("compare"), against: setOf("against") } };
}

const said = (value: number | null) => (value === null ? "unavailable" : String(value));

const figureLine = (figures: Figures, measures: ReadonlyArray<Measure>) =>
  Arr.join(
    Arr.map(measures, (measure) => `${measure} ${said(figures[measure])}`),
    ", ",
  );

const QUALITY: ReadonlyArray<Measure> = [
  "accepted",
  "checksPassed",
  "defectsFound",
  "escapedDefects",
  "reopenedFindings",
  "plantedCaught",
  "interventions",
  "wallMs",
  "sessions",
  "compactions",
  "peakContext",
];

/** The comparison in the words `run metrics --compare` prints. */
export function trialLines(report: Comparison): ReadonlyArray<string> {
  const sideLines = (name: string, side: Side) => [
    ...Arr.map(side.runs, (one) => `    ${name} ${one.runId}: ${figureLine(one.figures, QUALITY)}`),
    `    ${name} median: ${figureLine(side.median, [...QUALITY, ...TOKEN_MEASURES])}`,
    `    ${name} range: ${Arr.join(
      Arr.map(
        [...QUALITY, ...TOKEN_MEASURES],
        (measure) => `${measure} ${said(side.range.min[measure])}–${said(side.range.max[measure])}`,
      ),
      ", ",
    )}`,
  ];
  const setLines = (name: string, set: SetFigures) => {
    const per = set.perAcceptedChange;
    return [
      `${name} (${Arr.join(set.runs, ", ")}): ${figureLine(set.figures, [...QUALITY, ...TOKEN_MEASURES])}`,
      per === "no accepted change"
        ? `  per accepted change: no accepted change`
        : `  per accepted change: ${Arr.join(
            Arr.map(TOKEN_MEASURES, (measure) => `${measure} ${said(per[measure])}`),
            ", ",
          )}`,
    ];
  };
  return [
    ...Arr.flatMap(report.cases, (one) => [
      `case ${one.case}:`,
      ...sideLines("compare", one.compare),
      ...sideLines("against", one.against),
      `    against is ${Arr.join(
        Arr.map(DIRECTED, (measure) => `${one.direction[measure]} on ${measure}`),
        ", ",
      )}`,
    ]),
    ...setLines("compare", report.sets.compare),
    ...setLines("against", report.sets.against),
  ];
}
