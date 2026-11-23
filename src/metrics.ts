// WARNING: Nothing here throttles or stops a Run: usage is data, never a limit.
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as Option from "effect/Option";
import { Effect, Schema } from "effect";
import { appendRunJournal, readRunJournal, runJournal } from "./journal";
import { epochMs } from "./time";
import { ParkCause } from "./park-cause";
import { ProducerReport } from "./narrative-model";

export const RecoveryAction = Schema.Literals(["reminded", "rechecked", "resumed", "healed"]);
export type RecoveryAction = typeof RecoveryAction.Type;
export const RecoveryOutcome = Schema.Literals([
  "output-written",
  "still-absent",
  "cleared",
  "uncleared",
  "error",
  "claimed",
  "resumed",
  "skipped",
  "started",
  "recovered",
  "escalated",
  "false-recovery",
  "failed",
]);
export type RecoveryOutcome = typeof RecoveryOutcome.Type;

export const HealFinding = Schema.Struct({
  collie_defect: Schema.Boolean,
  key: Schema.String,
  root_cause: Schema.String,
  fix: Schema.String,
  regression: Schema.String,
  issue: Schema.optionalKey(Schema.NullOr(Schema.Int)),
  title: Schema.optionalKey(Schema.String),
  observed: Schema.optionalKey(Schema.String),
  expected: Schema.optionalKey(Schema.String),
});
export type HealFinding = typeof HealFinding.Type;

// WARNING: `uncertain` sent a write whose answer was lost; both `refused` and `uncertain` are retried.
export const Publication = Schema.Literals([
  "filed",
  "linked",
  "refused",
  "uncertain",
  "not-filed",
]);
export type Publication = typeof Publication.Type;

export const MetricSchema = Schema.Struct({
  ...ProducerReport.fields,
  at: Schema.String,
  kind: Schema.Literals([
    "context",
    "verification",
    "slice",
    "round",
    "halt",
    "evidence",
    "checkpoint",
    "recovery",
    "report",
  ]),
  subject: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  value: Schema.Finite.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  note: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  cause: Schema.optionalKey(ParkCause),
  build: Schema.optionalKey(Schema.String),
  action: Schema.optionalKey(RecoveryAction),
  outcome: Schema.optionalKey(RecoveryOutcome),
  recoveryId: Schema.optionalKey(Schema.String),
  park: Schema.optionalKey(Schema.String),
  since: Schema.optionalKey(Schema.String),
  entries: Schema.optionalKey(Schema.Int),
  heal: Schema.optionalKey(Schema.String),
  diagnosisComplete: Schema.optionalKey(Schema.Boolean),
  finding: Schema.optionalKey(HealFinding),
  publication: Schema.optionalKey(Publication),
  issue: Schema.optionalKey(Schema.String),
  moved: Schema.optionalKey(
    Schema.Struct({ tracked: Schema.Int, untracked: Schema.Int, lockfile: Schema.Int }),
  ),
});
export type Metric = Schema.Schema.Type<typeof MetricSchema>;
const MetricJson = Schema.fromJsonString(MetricSchema);

export const METRICS_FILE = "metrics.jsonl";

export const metricsPath = (runDir: string) => runJournal(runDir, METRICS_FILE);

export const appendMetric = Effect.fn("Metrics.append")(function* (runDir: string, line: Metric) {
  yield* appendRunJournal(metricsPath(runDir), MetricJson, line);
});

export const noteVerification = (
  runDir: string,
  record: {
    readonly id: string;
    readonly at: string;
    readonly result: string;
    readonly by: "agent" | "collie";
    readonly moved?: ReadonlyArray<{ readonly class: "tracked" | "untracked" | "lockfile" }>;
  },
) => {
  const line: Metric = {
    at: record.at,
    kind: "verification",
    subject: record.id,
    value: record.by === "collie" ? 1 : 0,
    note: record.result,
  };
  if (record.moved === undefined) return appendMetric(runDir, line);
  const moved = { tracked: 0, untracked: 0, lockfile: 0 };
  for (const one of record.moved) moved[one.class] += 1;
  return appendMetric(runDir, { ...line, moved });
};

export const noteReminder = (
  runDir: string,
  line: {
    readonly at: string;
    readonly agent: string;
    readonly recoveryId: string;
    readonly outcome: RecoveryOutcome;
    readonly waitedMs: number;
    readonly build: string;
  },
) =>
  appendMetric(runDir, {
    at: line.at,
    kind: "recovery",
    subject: line.agent,
    value: line.waitedMs,
    note: "",
    cause: "output-absent",
    action: "reminded",
    outcome: line.outcome,
    recoveryId: line.recoveryId,
    build: line.build,
  });

export const noteContext = (runDir: string, at: string, agent: string, tokens: number) =>
  appendMetric(runDir, { at, kind: "context", subject: agent, value: tokens, note: "" });

export const readMetrics = Effect.fn("Metrics.read")(function* (runDir: string) {
  const none: Metric[] = [];
  return yield* readRunJournal(metricsPath(runDir), MetricJson).pipe(
    Effect.orElseSucceed(() => none),
  );
});

export const recoveriesIn = (lines: ReadonlyArray<Metric>) => {
  const latest = new Map<string | number, Metric>();
  for (const [index, line] of lines.entries())
    if (line.kind === "recovery") latest.set(line.recoveryId ?? index, line);
  return [...latest.values()];
};

export interface FailureLike {
  readonly name: string;
  readonly result: string;
  readonly exit: number;
  readonly tail: { readonly stderr: string };
}

// WARNING: Never a halt: a repeat is an obstacle sentence, not evidence the work cannot be done.
export function repeatedFailure(records: ReadonlyArray<FailureLike>, n: number) {
  if (n < 2) return null;
  const byName = new Map<string, FailureLike[]>();
  for (const record of records) {
    const kept = byName.get(record.name) ?? [];
    kept.push(record);
    byName.set(record.name, kept);
  }
  for (const [name, all] of byName) {
    const last = all.slice(-n);
    if (last.length < n) continue;
    if (!Arr.every(last, (record) => record.result === "fail")) continue;
    const first = last[0]!;
    if (!Arr.every(last, (record) => record.exit === first.exit)) continue;
    const line = lastLine(first.tail.stderr);
    if (!Arr.every(last, (record) => lastLine(record.tail.stderr) === line)) continue;
    return { name, times: n, exit: first.exit, line };
  }
  return null;
}

function lastLine(text: string) {
  const lines = Arr.filter(
    Arr.map(Str.split(text, "\n"), (line) => Str.trim(line)),
    (line) => line !== "",
  );
  return lines[lines.length - 1] ?? "";
}

export function obstacleOf(found: { name: string; times: number; exit: number; line: string }) {
  const said = found.line === "" ? "" : `: ${found.line}`;
  return (
    `${found.name} has failed ${found.times} times in a row the same way (exit ${found.exit})${said}. ` +
    `Repeating it will not change it — change approach, or say precisely what is blocking you.`
  );
}

export function metricsOf(lines: ReadonlyArray<Metric>, createdAt: string) {
  const created = epochMs(createdAt);
  const first = Option.getOrUndefined(Arr.findFirst(lines, (line) => line.kind === "verification"));
  const verifications = { pass: 0, fail: 0, unstable: 0, byCollie: 0 };
  const slices = { done: 0, total: 0 };
  let rework = 0;
  let peak: { agent: string; tokens: number } | null = null;
  const halts: string[] = [];
  const obstacles: string[] = [];

  for (const line of lines) {
    switch (line.kind) {
      case "verification":
        if (line.note === "pass") verifications.pass += 1;
        else if (line.note === "fail") verifications.fail += 1;
        else if (line.note === "unstable") verifications.unstable += 1;
        if (line.value === 1) verifications.byCollie += 1;
        break;
      case "slice":
        slices.total += 1;
        if (line.note === "done") slices.done += 1;
        break;
      case "round":
        rework += 1;
        break;
      case "context":
        if (peak === null || line.value > peak.tokens)
          peak = { agent: line.subject, tokens: line.value };
        break;
      case "halt":
        halts.push(line.note);
        rework += 1;
        break;
      case "checkpoint":
        obstacles.push(line.note);
        break;
      case "evidence":
      case "recovery":
        break;
    }
  }

  return {
    timeToFirstEvidence:
      first && Number.isFinite(created) ? Math.max(0, (epochMs(first.at) - created) / 1000) : null,
    verifications,
    slices,
    rework,
    peakContext: peak,
    halts,
    obstacles,
  };
}
