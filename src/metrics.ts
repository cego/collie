// What a Run actually did, as facts with times on them.
//
// Progress today is inferred from pane text: a changing tail means alive, a still one
// means nudge. That is liveness, and liveness is not progress — an agent can be busy for
// an hour and produce nothing, and one that is quiet for ten minutes may have just
// finished. This journal is the other half: evidence arriving, slices landing, rounds
// going by, context samples, and the moments a Run stopped.
//
// Nothing here throttles, stops or refuses anything. It is data, and the user's decision
// is that usage is data — there is no budget in this file and no counter that becomes a
// limit. The one judgement it makes is `repeatedFailure`, and what that produces is a
// sentence for a human and for the next prompt, never a halt.

import { Effect, FileSystem, Path, Schema } from "effect";
import { appendJournal, readJournal } from "./journal";

const MetricSchema = Schema.Struct({
  at: Schema.String,
  kind: Schema.Literals([
    "context",
    "verification",
    "slice",
    "round",
    "halt",
    "evidence",
    "checkpoint",
  ]),
  /** What it is about: an agent, a step, a verification name, a ticket. */
  subject: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
  /** The number that matters for this kind: tokens, an exit code, an iteration, a count. */
  value: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  /** The word that matters: a result, a status, a reason. */
  note: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed(""))),
});
export type Metric = Schema.Schema.Type<typeof MetricSchema>;
const MetricJson = Schema.fromJsonString(MetricSchema);

export const METRICS_FILE = "metrics.jsonl";

export const metricsPath = Effect.fn("Metrics.path")(function* (runDir: string) {
  const path = yield* Path.Path;
  return path.join(runDir, METRICS_FILE);
});

export const appendMetric = Effect.fn("Metrics.append")(function* (
  runDir: string,
  line: Metric,
): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
  yield* appendJournal(yield* metricsPath(runDir), MetricJson, line).pipe(Effect.orDie);
});

/**
 * One verification as a card reads it. Recorded where this Run's metrics are, so what a
 * card counts is the same fact whichever kind of Run collected it. It records and nothing
 * else: a command that keeps failing earns a sentence, never a limit.
 */
export const noteVerification = (
  runDir: string,
  record: {
    readonly id: string;
    readonly at: string;
    readonly result: string;
    readonly by: "agent" | "collie";
  },
): Effect.Effect<void, never, FileSystem.FileSystem | Path.Path> =>
  appendMetric(runDir, {
    at: record.at,
    kind: "verification",
    subject: record.id,
    value: record.by === "collie" ? 1 : 0,
    note: record.result,
  });

export const readMetrics = Effect.fn("Metrics.read")(function* (runDir: string) {
  const none: Metric[] = [];
  return yield* readJournal(yield* metricsPath(runDir), MetricJson).pipe(
    Effect.catch(() => Effect.succeed(none)),
  );
});

/** Enough of a verification for the detector; the real one is in `verify.ts`. */
export interface FailureLike {
  readonly name: string;
  readonly result: string;
  readonly exit: number;
  readonly tail: { readonly stderr: string };
}

/**
 * Whether the last `n` runs of one command failed the same way. Same name, same exit, and
 * the same last line of stderr — a test that fails differently each time is a Run making
 * progress through a problem, and one that fails identically is a Run going round.
 *
 * What this produces is an obstacle: a sentence for the human and for the next prompt, so
 * the agent can change approach. It is deliberately **not** a halt. A counter reaching
 * three is not evidence that the work cannot be done, and stopping a Run over one would
 * be inventing a limit nobody asked for. What stops a false claim of success is the
 * evidence gate reading collected results, not this.
 */
export function repeatedFailure(
  records: ReadonlyArray<FailureLike>,
  n: number,
): { name: string; times: number; exit: number; line: string } | null {
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
    if (!last.every((record) => record.result === "fail")) continue;
    const first = last[0]!;
    if (!last.every((record) => record.exit === first.exit)) continue;
    const line = lastLine(first.tail.stderr);
    if (!last.every((record) => lastLine(record.tail.stderr) === line)) continue;
    return { name, times: n, exit: first.exit, line };
  }
  return null;
}

/** The last line that says anything, which is what a failure is usually recognised by. */
function lastLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines[lines.length - 1] ?? "";
}

/** The obstacle a repeated failure is, in the words a human and an agent both get. */
export function obstacleOf(found: {
  name: string;
  times: number;
  exit: number;
  line: string;
}): string {
  const said = found.line === "" ? "" : `: ${found.line}`;
  return (
    `${found.name} has failed ${found.times} times in a row the same way (exit ${found.exit})${said}. ` +
    `Repeating it will not change it — change approach, or say precisely what is blocking you.`
  );
}

/** What a Run cost and how it went, for `run metrics` and the detail panel. */
export interface Metrics {
  /** From the Run's creation to the first collected verification, in seconds. */
  timeToFirstEvidence: number | null;
  verifications: { pass: number; fail: number; unstable: number; byCollie: number };
  slices: { done: number; total: number };
  /** Fix rounds plus halts: how much of this Run was doing work again. */
  rework: number;
  /** The largest context sample any agent reported, and which agent. */
  peakContext: { agent: string; tokens: number } | null;
  halts: string[];
  obstacles: string[];
}

export function metricsOf(lines: ReadonlyArray<Metric>, createdAt: string): Metrics {
  const created = Date.parse(createdAt);
  const first = lines.find((line) => line.kind === "verification");
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
        break;
    }
  }

  return {
    timeToFirstEvidence:
      first && Number.isFinite(created)
        ? Math.max(0, (Date.parse(first.at) - created) / 1000)
        : null,
    verifications,
    slices,
    rework,
    peakContext: peak,
    halts,
    obstacles,
  };
}
