import * as Str from "effect/String";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { pipe as pipe_ } from "effect/Function";
import { Effect } from "effect";
import { Buffer } from "node:buffer";
import type { RunFacts } from "./runs";
import type { RunningCheck } from "./board-model";
import { decodeVerifying, readProofsOf, readVerifications, VERIFYING, verifyingOf } from "./verify";
import type { Pass, Verification, Verifying } from "./verify";
import { RunRecords } from "./run-records";
import { epochMs } from "./time";
import type { CheckRecord } from "./check-processes";
import { PASSES } from "./verify-model";

export interface DonePass {
  readonly name: string;
  readonly pass: Pass;
  readonly round: number | null;
  readonly result: Verification["result"];
  readonly seconds: number;
  readonly revision: string;
  readonly at: string;
  readonly log: string | null;
}

const USUAL_OF = 5;

export const LAST_LINES = 40;

// WARNING: read only the end of the log; it can be large.
const TAIL_READ = 16 * 1024;

export const lastLinesOf = (log: string | null, count = LAST_LINES) =>
  log === null
    ? Effect.succeed<ReadonlyArray<string>>([])
    : Effect.tryPromise(() => {
        const file = Bun.file(log);
        return file.slice(Math.max(0, file.size - TAIL_READ)).text();
      }).pipe(
        Effect.map((text) =>
          Arr.filter(Str.split(text, "\n"), (line) => line !== "").slice(-count),
        ),
        Effect.orElseSucceed(() => []),
      );

// WARNING: a Run with no marker is read from its running check's record, as an agent's own verify is.
export const markersOf = Effect.fn("Checks.markersOf")(function* (
  records: ReadonlyArray<CheckRecord> = [],
) {
  const found = new Map<string, Verifying>();
  for (const row of yield* RunRecords.use((all) => all.everyControl(VERIFYING))) {
    const marker = decodeVerifying(row.data);
    if (marker !== null) {
      found.set(row.run, marker);
    }
  }
  // WARNING: a marker outlives a check that ended, so only one naming a live record of its Run is shown.
  for (const [run, marker] of found) {
    const live = Arr.some(records, (record) => record.run === run && record.name === marker.name);
    const recorded = Arr.some(records, (record) => record.run === run);
    if (marker.pass !== "ci" && recorded && !live) {
      found.delete(run);
    }
  }
  for (const record of records) {
    if (!found.has(record.run)) {
      found.set(record.run, {
        name: record.name,
        executable: "",
        argv: [],
        pass:
          Option.getOrUndefined(Arr.findFirst(PASSES, (pass) => pass === record.pass)) ?? "check",
        round: record.round ?? null,
        revision: "",
        base: null,
        started: record.started,
      });
    }
  }
  return found;
});

const readOrNone = (run: RunFacts) =>
  readVerifications(run.evidence).pipe(Effect.orElseSucceed(() => []));

const commandOf = (executable: string) => Str.split(executable, "/").at(-1) ?? executable;

const usualOf = Effect.fn("Checks.usualOf")(function* (
  run: RunFacts,
  runs: ReadonlyArray<RunFacts>,
  marker: Verifying,
) {
  const same = Arr.filter(
    yield* readProofsOf(
      Arr.flatMap(runs, (other) => (other.project === run.project ? [other.evidence] : [])),
    ),
    (record) =>
      record.by === "collie" &&
      record.name === marker.name &&
      commandOf(record.executable) === commandOf(marker.executable) &&
      record.argv.length === marker.argv.length &&
      Arr.every(record.argv, (word, at) => word === marker.argv[at]),
  );
  const last = Arr.map(
    same.sort((a, b) => pipe_(a.at, Str.localeCompare(b.at))).slice(-USUAL_OF),
    (record) => record.seconds * 1000,
  ).sort((a, b) => a - b);
  if (last.length === 0) {
    return null;
  }
  const mid = Math.floor(last.length / 2);
  return last.length % 2 === 1 ? last[mid]! : (last[mid - 1]! + last[mid]!) / 2;
});

// WARNING: remembered per run; each board refresh would otherwise re-read every journal.
const usualRemembered = Effect.fn("Checks.usualRemembered")(function* (
  run: RunFacts,
  runs: ReadonlyArray<RunFacts>,
  marker: Verifying,
) {
  const key = `${run.dir}\0${marker.name}\0${marker.started}`;
  const known = usuals.get(key);
  if (known !== undefined) {
    return known;
  }
  const usual = yield* usualOf(run, runs, marker);
  if (usuals.size >= USUALS_KEPT) {
    usuals.clear();
  }
  usuals.set(key, usual);
  return usual;
});
const USUALS_KEPT = 256;
const usuals = new Map<string, number | null>();

export const runningCheck = Effect.fn("Checks.running")(function* (
  run: RunFacts,
  runs: ReadonlyArray<RunFacts>,
  markers: ReadonlyMap<string, Verifying>,
  now: number,
) {
  const marker = markers.get(run.id);
  if (marker === undefined) {
    return null;
  }
  const started = epochMs(marker.started);
  const read = {
    name: marker.name,
    pass: marker.pass,
    round: marker.round,
    revision: marker.revision,
    base: marker.base,
    elapsedMs: Number.isFinite(started) ? Math.max(0, now - started) : null,
    usualMs: yield* usualRemembered(run, runs, marker),
    others: Arr.filter([...markers.keys()], (id) => id !== run.id).length,
  };
  const facts = marker.job === undefined ? read : { ...read, job: marker.job };
  const log = marker.log ?? null;
  return {
    ...facts,
    sentence: checkSentence(facts),
    log,
    lastLines: yield* lastLinesOf(log),
  } satisfies RunningCheck;
});

const FOLLOW_EVERY = "250 millis";

const bytesFrom = (log: string, offset: number) =>
  Effect.tryPromise(() => Bun.file(log).slice(offset).arrayBuffer()).pipe(
    Effect.map((buffer) => Buffer.from(buffer)),
    Effect.orElseSucceed(() => Buffer.alloc(0)),
  );

// WARNING: counts bytes, not characters, so a cut never splits one.
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
    // WARNING: up to the last newline: a half-written line is said when it is whole.
    const end = pending.lastIndexOf(10) + 1;
    if (end > 0) {
      yield* say(pending.subarray(0, end).toString("utf8"));
      pending = pending.subarray(end);
    }
  });
  while ((yield* verifyingOf(run.id))?.log === log) {
    yield* drain;
    yield* Effect.sleep(FOLLOW_EVERY);
  }
  yield* drain;
  if (pending.length > 0) {
    yield* say(`${pending.toString("utf8")}\n`);
  }
  return (
    Option.getOrUndefined(Arr.findLast(yield* readOrNone(run), (record) => record.log === log)) ??
    null
  );
});

export const donePasses = Effect.fn("Checks.done")(function* (run: RunFacts) {
  return Arr.map(
    Arr.filter(yield* readOrNone(run), (record) => record.by === "collie"),
    (record) => ({
      name: record.name,
      pass: record.pass ?? "check",
      round: record.round ?? null,
      result: record.result,
      seconds: record.seconds,
      revision: record.end.head_sha,
      at: record.at,
      log: record.log ?? null,
    }),
  );
});

function doing(
  check: Pick<RunningCheck, "name" | "pass" | "round" | "base"> &
    Partial<Pick<RunningCheck, "revision" | "job">>,
) {
  const running = `Running ${check.name}`;
  switch (check.pass) {
    case "gate":
      return `${running} on the branch`;
    case "baseline":
      return `${running} where the branch left ${check.base ?? "the default branch"}, to see whether it failed before this Run`;
    case "rerun":
      return `Running a test ${check.name} failed on, alone on the same tree, to tell a flake`;
    case "recheck":
      return `${running} again on the same tree to rule out a flake`;
    case "fix":
      return check.round === null
        ? `${running} after a gate fix`
        : `${running} after gate fix ${check.round}`;
    case "finish":
      return `${running} as the Run finishes`;
    case "ci":
      return `Waiting on ${check.name}'s CI job ${check.job ?? ""} at ${pipe_(check.revision ?? "", Str.slice(0, 12))}`;
    case "check":
      return running;
  }
}

const inMinutes = (ms: number) => ms >= 60_000;
const amount = (ms: number) =>
  inMinutes(ms) ? `${Math.round(ms / 60_000)}` : `${Math.round(ms / 1000)}`;
const unit = (ms: number) => (inMinutes(ms) ? "min" : "s");

function timing(elapsed: number, usual: number | null) {
  const ran = `${amount(elapsed)} ${unit(elapsed)}`;
  if (usual === null) {
    return ran;
  }
  const usually = unit(usual) === unit(elapsed) ? amount(usual) : `${amount(usual)} ${unit(usual)}`;
  return elapsed > usual
    ? `${ran}, longer than the usual ${usually}`
    : `${ran} of a usual ${usually}`;
}

export function checkSentence(
  check: Pick<
    RunningCheck,
    "name" | "pass" | "round" | "base" | "elapsedMs" | "usualMs" | "others"
  > &
    Partial<Pick<RunningCheck, "revision" | "job">>,
) {
  const when = check.elapsedMs === null ? "" : `, ${timing(check.elapsedMs, check.usualMs)}`;
  const others =
    check.others === 0
      ? ""
      : ` ${check.others} other ${check.others === 1 ? "check is" : "checks are"} running.`;
  return `${doing(check)}${when}.${others}`;
}
