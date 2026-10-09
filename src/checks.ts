// The checks Collie runs for a Run, as every door reads them (ADR-0042 D5): the card, the
// drawer, `collie_run`, `collie_herd` and `collie run checks` all come through here, so
// none of them can say a different thing about the same check.

import { Effect } from "effect";
import { Buffer } from "node:buffer";
import type { RunFacts } from "./runs";
import type { RunningCheck } from "./board-model";
import {
  readVerifications,
  verifyingIn,
  type Pass,
  type Verification,
  type Verifying,
} from "./verify";
import { epochMs } from "./time";

/** One pass Collie ran and finished. */
export interface DonePass {
  readonly name: string;
  readonly pass: Pass;
  readonly round: number | null;
  readonly result: Verification["result"];
  readonly seconds: number;
  readonly revision: string;
  readonly at: string;
  /** Its output as it ran, up to the log's bound, or null for a record that kept none. */
  readonly log: string | null;
}

/** How many earlier runs "usually" is the median of. */
const USUAL_OF = 5;

/** How many of a running check's last lines every door shows. */
export const LAST_LINES = 40;

/** How much of a log's end is read for its last lines: never the whole bounded file. */
const TAIL_READ = 16 * 1024;

/** The last lines a check's log holds, read from its end only. */
export const lastLinesOf = (log: string | null, count = LAST_LINES) =>
  log === null
    ? Effect.succeed<ReadonlyArray<string>>([])
    : Effect.tryPromise(() => {
        const file = Bun.file(log);
        return file.slice(Math.max(0, file.size - TAIL_READ)).text();
      }).pipe(
        Effect.map((text) =>
          text
            .split("\n")
            .filter((line) => line !== "")
            .slice(-count),
        ),
        Effect.orElseSucceed((): ReadonlyArray<string> => []),
      );

/** Every Run's marker, read once for a whole board. */
export const markersOf = Effect.fn("Checks.markersOf")(function* (runs: ReadonlyArray<RunFacts>) {
  const found = new Map<string, Verifying>();
  for (const run of runs) {
    const marker = yield* verifyingIn(run.dir);
    if (marker !== null) found.set(run.id, marker);
  }
  return found;
});

const readOrNone = (run: RunFacts) =>
  readVerifications(run.evidence).pipe(Effect.orElseSucceed((): ReadonlyArray<Verification> => []));

/** A record keeps the executable as PATH resolved it, an approved spec as it was written. */
const commandOf = (executable: string) => executable.split("/").at(-1) ?? executable;

/** The median time of the last few completed runs of this name and arguments in this repository. */
const usualOf = Effect.fn("Checks.usualOf")(function* (
  run: RunFacts,
  runs: ReadonlyArray<RunFacts>,
  marker: Verifying,
) {
  const same: Verification[] = [];
  for (const other of runs) {
    if (other.project !== run.project) continue;
    for (const record of yield* readOrNone(other))
      if (
        record.by === "collie" &&
        record.name === marker.name &&
        commandOf(record.executable) === commandOf(marker.executable) &&
        record.argv.length === marker.argv.length &&
        record.argv.every((word, at) => word === marker.argv[at])
      )
        same.push(record);
  }
  const last = same
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-USUAL_OF)
    .map((record) => record.seconds * 1000)
    .sort((a, b) => a - b);
  if (last.length === 0) return null;
  const mid = Math.floor(last.length / 2);
  return last.length % 2 === 1 ? last[mid]! : (last[mid - 1]! + last[mid]!) / 2;
});

/**
 * The usual time of a running check, read once per run of it: it changes only when a
 * check finishes, and every board refresh would otherwise read every journal again.
 */
const usualRemembered = Effect.fn("Checks.usualRemembered")(function* (
  run: RunFacts,
  runs: ReadonlyArray<RunFacts>,
  marker: Verifying,
) {
  const key = `${run.dir}\0${marker.name}\0${marker.started}`;
  const known = usuals.get(key);
  if (known !== undefined) return known;
  const usual = yield* usualOf(run, runs, marker);
  if (usuals.size >= USUALS_KEPT) usuals.clear();
  usuals.set(key, usual);
  return usual;
});
const USUALS_KEPT = 256;
const usuals = new Map<string, number | null>();

/** The check running for `run` now, or null where none is. */
export const runningCheck = Effect.fn("Checks.running")(function* (
  run: RunFacts,
  runs: ReadonlyArray<RunFacts>,
  markers: ReadonlyMap<string, Verifying>,
  now: number,
) {
  const marker = markers.get(run.id);
  if (marker === undefined) return null;
  const started = epochMs(marker.started);
  const facts = {
    name: marker.name,
    pass: marker.pass,
    round: marker.round,
    revision: marker.revision,
    base: marker.base,
    elapsedMs: Number.isFinite(started) ? Math.max(0, now - started) : null,
    usualMs: yield* usualRemembered(run, runs, marker),
    others: [...markers.keys()].filter((id) => id !== run.id).length,
  };
  const log = marker.log ?? null;
  return {
    ...facts,
    sentence: checkSentence(facts),
    log,
    lastLines: yield* lastLinesOf(log),
  } satisfies RunningCheck;
});

/** How often `--follow` looks at the log again. */
const FOLLOW_EVERY = "250 millis";

const bytesFrom = (log: string, offset: number) =>
  Effect.tryPromise(() => Bun.file(log).slice(offset).arrayBuffer()).pipe(
    Effect.map((buffer) => Buffer.from(buffer)),
    Effect.orElseSucceed(() => Buffer.alloc(0)),
  );

/**
 * Hands a running check's output to `say` as it is written, until the Run's marker no longer
 * names this log, then says what was left. Bytes, not characters, so a cut never splits one.
 */
export const followLog = Effect.fn("Checks.followLog")(function* (
  run: RunFacts,
  log: string,
  say: (text: string) => Effect.Effect<void>,
) {
  let offset = 0;
  let pending = Buffer.alloc(0);
  const drain = Effect.gen(function* () {
    const read = yield* bytesFrom(log, offset);
    offset += read.length;
    pending = Buffer.concat([pending, read]);
    // Up to the last newline: a line half-written is said when it is whole.
    const end = pending.lastIndexOf(10) + 1;
    if (end > 0) {
      yield* say(pending.subarray(0, end).toString("utf8"));
      pending = pending.subarray(end);
    }
  });
  while ((yield* verifyingIn(run.dir))?.log === log) {
    yield* drain;
    yield* Effect.sleep(FOLLOW_EVERY);
  }
  yield* drain;
  if (pending.length > 0) yield* say(`${pending.toString("utf8")}\n`);
  return (yield* readOrNone(run)).findLast((record) => record.log === log) ?? null;
});

/** Every pass Collie finished for this Run, oldest first. */
export const donePasses = Effect.fn("Checks.done")(function* (run: RunFacts) {
  return (yield* readOrNone(run))
    .filter((record) => record.by === "collie")
    .map((record): DonePass => ({
      name: record.name,
      pass: record.pass ?? "check",
      round: record.round ?? null,
      result: record.result,
      seconds: record.seconds,
      revision: record.end.head_sha,
      at: record.at,
      log: record.log ?? null,
    }));
});

/** What the pass is for, in words. */
function doing(check: Pick<RunningCheck, "name" | "pass" | "round" | "base">): string {
  const running = `Running ${check.name}`;
  switch (check.pass) {
    case "gate":
      return `${running} on the branch`;
    case "baseline":
      return `${running} where the branch left ${check.base ?? "the default branch"}, to see whether it failed before this Run`;
    case "recheck":
      return `${running} again on the same tree to rule out a flake`;
    case "fix":
      return check.round === null
        ? `${running} after a gate fix`
        : `${running} after gate fix ${check.round}`;
    case "finish":
      return `${running} as the Run finishes`;
    case "check":
      return running;
  }
}

const inMinutes = (ms: number) => ms >= 60_000;
const amount = (ms: number) =>
  inMinutes(ms) ? `${Math.round(ms / 60_000)}` : `${Math.round(ms / 1000)}`;
const unit = (ms: number) => (inMinutes(ms) ? "min" : "s");

/** How long it has run, against how long it usually takes. */
function timing(elapsed: number, usual: number | null): string {
  const ran = `${amount(elapsed)} ${unit(elapsed)}`;
  if (usual === null) return ran;
  // The usual time is bare where it shares the elapsed time's unit: "4 min of a usual 20".
  const usually = unit(usual) === unit(elapsed) ? amount(usual) : `${amount(usual)} ${unit(usual)}`;
  return elapsed > usual
    ? `${ran}, longer than the usual ${usually}`
    : `${ran} of a usual ${usually}`;
}

/** The one sentence about a running check: which, which pass and why, how long, and contention. */
export function checkSentence(
  check: Pick<
    RunningCheck,
    "name" | "pass" | "round" | "base" | "elapsedMs" | "usualMs" | "others"
  >,
): string {
  const when = check.elapsedMs === null ? "" : `, ${timing(check.elapsedMs, check.usualMs)}`;
  const others =
    check.others === 0
      ? ""
      : ` ${check.others} other ${check.others === 1 ? "check is" : "checks are"} running.`;
  return `${doing(check)}${when}.${others}`;
}
