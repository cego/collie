// Where Runs end, across all of them: the numbers a change to Collie is judged by.
// Data only: nothing here is a threshold, and nothing refuses anything.

import * as Num from "effect/Number";
import * as Rec from "effect/Record";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { Schema, flow, Result } from "effect";
import { STOP, type RunView } from "./engine";
import type { Metrics } from "./board-model";
import { epochMs } from "./time";
import { measuresOf, type Measures, type OutcomeRecords } from "./outcomes";
import type { Metric } from "./metrics";

const asJsonText = flow(Schema.encodeResult(Schema.fromJsonString(Schema.Json)), Result.getOrThrow);
const isText = Schema.is(Schema.String);
export const resultText = (value: Schema.Json): string =>
  isText(value) ? value : asJsonText(value);

export interface WorkflowTally {
  readonly workflow: string;
  readonly total: number;
  readonly complete: number;
  readonly failed: number;
  readonly suspended: number;
  readonly pending: number;
  /** Carries a `stop` control: a human stopped it. */
  readonly stopped: number;
  /** Recorded a merge request (`RunView.mr`). */
  readonly withMr: number;
  readonly answered: number;
  readonly open: number;
  readonly rework: number;
  readonly verifications: {
    readonly pass: number;
    readonly fail: number;
    readonly unstable: number;
  };
}

export interface Report {
  readonly since: string | null;
  readonly total: number;
  readonly runs: ReadonlyArray<{
    readonly runId: string;
    readonly workflow: string;
    readonly parent: string | null;
    readonly project: string;
    readonly created: string;
    readonly status: RunView["status"]["status"];
    /** The issues its input says `Closes #n` for. */
    readonly closes: ReadonlyArray<number>;
  }>;
  readonly workflows: ReadonlyArray<WorkflowTally>;
  readonly failed: ReadonlyArray<{ runId: string; workflow: string; reason: string }>;
  readonly completed: ReadonlyArray<{
    runId: string;
    workflow: string;
    value: string;
    mr: string | null;
  }>;
  readonly stopped: ReadonlyArray<{ runId: string; workflow: string }>;
  readonly measures: Measures;
}

/** What one Run recorded, for the measures; null records where its host could not read them. */
export interface Recorded {
  readonly records: OutcomeRecords | null;
  readonly metrics: ReadonlyArray<Metric>;
}

const CLOSES = /Closes #(\d+)/gi;

const closesIn = (input: RunView["input"]) => {
  const texts = Arr.filter(Rec.values(input), (value): value is string => isText(value));
  return Arr.flatMap(texts, (text) =>
    Arr.map([...pipe(text, Str.matchAll(CLOSES))], (match) => Number(match[1])),
  );
};

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };

export function reportOf(
  views: ReadonlyArray<RunView>,
  metrics: ReadonlyMap<string, Metrics>,
  since: string | null,
  recorded: ReadonlyMap<string, Recorded> = new Map(),
): Report {
  const from = since === null ? -Infinity : epochMs(since);
  const recent = Arr.filter(views, (view) => epochMs(view.created) >= from);
  const kept = Arr.sortWith(
    recent,
    (value) => value,
    (a, b) => Num.sign(epochMs(a.created) - epochMs(b.created)),
  );
  const tallies = new Map<string, Mutable<WorkflowTally>>();
  const failed: Mutable<Report["failed"]> = [];
  const completed: Mutable<Report["completed"]> = [];
  const stopped: Mutable<Report["stopped"]> = [];
  for (const view of kept) {
    const { runId, workflow, status } = view;
    let tally = tallies.get(workflow);
    if (tally === undefined) {
      tally = {
        workflow,
        total: 0,
        complete: 0,
        failed: 0,
        suspended: 0,
        pending: 0,
        stopped: 0,
        withMr: 0,
        answered: 0,
        open: 0,
        rework: 0,
        verifications: { pass: 0, fail: 0, unstable: 0 },
      };
      tallies.set(workflow, tally);
    }
    tally.total++;
    tally[status.status]++;
    if (status.status === "failed") failed.push({ runId, workflow, reason: status.reason });
    if (status.status === "complete")
      completed.push({
        runId,
        workflow,
        value: resultText(status.value),
        mr: view.mr,
      });
    if (view.controls.includes(STOP)) {
      tally.stopped++;
      stopped.push({ runId, workflow });
    }
    if (view.mr !== null) tally.withMr++;
    const answered = Arr.filter(view.waiting, (decision) => decision.answer !== null).length;
    tally.answered += answered;
    tally.open += view.waiting.length - answered;
    const recorded = metrics.get(runId);
    if (recorded !== undefined) {
      tally.rework += recorded.rework;
      tally.verifications.pass += recorded.verifications.pass;
      tally.verifications.fail += recorded.verifications.fail;
      tally.verifications.unstable += recorded.verifications.unstable;
    }
  }
  const workflows = Arr.sortWith(
    [...tallies.values()],
    (value) => value,
    (a, b) => Num.sign(b.total - a.total || pipe(a.workflow, Str.localeCompare(b.workflow))),
  );
  const runs = Arr.map(kept, ({ runId, workflow, parent, project, created, status, input }) => ({
    runId,
    workflow,
    parent,
    project,
    created,
    status: status.status,
    closes: [...new Set(closesIn(input))],
  }));
  const measures = measuresOf(
    Arr.map(kept, ({ runId }) => ({
      runId,
      records: recorded.get(runId)?.records ?? null,
      metrics: recorded.get(runId)?.metrics ?? [],
    })),
  );
  return { since, total: kept.length, runs, workflows, failed, completed, stopped, measures };
}

const capped = (lines: ReadonlyArray<string>, cap = 20): string[] =>
  lines.length > cap ? [...lines.slice(0, cap), `  …and ${lines.length - cap} more`] : [...lines];

const percent = (share: number | null) => (share === null ? "" : ` (${Math.round(share * 100)}%)`);

/** The Runs a measure counts, as far as the text has room for. */
const citing = (runs: ReadonlyArray<string>, cap = 10) =>
  runs.length === 0
    ? ""
    : `: ${Arr.join(runs.slice(0, cap), ", ")}${runs.length > cap ? ` …and ${runs.length - cap} more` : ""}`;

/** The measures, as `run report` prints them under the tallies. */
const measureLines = (measures: Measures): string[] => {
  const { rounds, dispositions, steering, verifications, parks, peakContext } = measures;
  const recorded = Arr.filter(peakContext, (one) => one.tokens !== null);
  return [
    `review rounds: ${rounds.runs.length} Runs with a rally, median ${rounds.median ?? "none"}, ${rounds.atCap.count} hit the cap${citing(rounds.atCap.runs)}`,
    ...capped(Arr.map(rounds.runs, (one) => `  ${one.runId}  ${one.reached} of ${one.cap}`)),
    `dispositions: ${Arr.join(
      Arr.map(
        ["merged", "superseded", "abandoned"] as const,
        (kind) => `${dispositions[kind].count} ${kind}${percent(dispositions[kind].share)}`,
      ),
      ", ",
    )}`,
    ...Arr.flatMap(["merged", "superseded", "abandoned"] as const, (kind) =>
      dispositions[kind].count === 0 ? [] : [`  ${kind}${citing(dispositions[kind].runs)}`],
    ),
    `steering by origin: ${Arr.join(
      Arr.map(
        ["human", "chat", "agent", "host"] as const,
        (origin) => `${steering.byOrigin[origin].count} ${origin}`,
      ),
      ", ",
    )}`,
    ...capped(
      Arr.map(
        steering.runs,
        (one) =>
          `  ${one.runId}  ${one.steer} steers, ${one.followup} follow-ups, ${one.deliver} deliveries, ${one.correction} corrections`,
      ),
    ),
    `verifications: ${verifications.total}, ${verifications.byCollector.collie} by Collie, ${verifications.byCollector.agent} by agents; ${verifications.repeated.count} repeated${citing(verifications.repeated.runs)}; ${verifications.executableOnly.count} named only by their executable${citing(verifications.executableOnly.runs)}`,
    `parks: ${parks.collectExpiries.count} collect-budget expiries${citing(parks.collectExpiries.runs)}`,
    ...capped(
      Arr.map(
        parks.byReason,
        (one) => `  ${one.count}× ${pipe(one.reason, Str.slice(0, 120))}${citing(one.runs)}`,
      ),
    ),
    `peak context tokens: ${recorded.length} of ${peakContext.length} Runs recorded; the rest not recorded`,
    ...capped(Arr.map(recorded, (one) => `  ${one.runId}  ${one.tokens} on ${one.agent}`)),
  ];
};

/** `run report` in words, which chat reads too. */
export const reportLines = (report: Report, unreadable: string | null): string => {
  const unread = unreadable === null ? [] : [`runs: ${unreadable}`];
  if (report.total === 0) return Arr.join([...unread, "No runs found."], "\n");
  return Arr.join(
    [
      `${report.total} Runs`,
      ...Arr.map(
        report.workflows,
        (t) =>
          `${t.workflow}  ${t.total}: ${t.complete} complete, ${t.failed} failed, ${t.suspended} suspended, ${t.pending} pending; ${t.withMr} recorded a merge request; ${t.stopped} stopped; ${t.answered} decisions answered; rework ${t.rework}; verifications ${t.verifications.pass} pass, ${t.verifications.fail} fail, ${t.verifications.unstable} unstable`,
      ),
      ...(report.failed.length === 0 ? [] : ["failed:"]),
      ...capped(
        Arr.map(
          report.failed,
          (r) => `  ${r.runId}  ${r.workflow}  ${pipe(r.reason, Str.slice(0, 120))}`,
        ),
      ),
      ...(report.completed.length === 0 ? [] : ["complete:"]),
      ...capped(Arr.map(report.completed, (r) => `  ${r.runId}  ${r.workflow}  ${r.value}`)),
      ...(report.stopped.length === 0 ? [] : ["stopped:"]),
      ...capped(Arr.map(report.stopped, (r) => `  ${r.runId}  ${r.workflow}`)),
      ...measureLines(report.measures),
      ...unread,
    ],
    "\n",
  );
};
