// A Run's landing of the merge request it recorded: an attempt written before the forge is
// asked, then landed or withdrawn. The merge watch reads it to leave the lander running.

import * as Num from "effect/Number";
import * as Arr from "effect/Array";
import { DateTime, Effect, FileSystem, Option, Schema } from "effect";
import { mrLabel, mrRefOf } from "./board-model";
import { forgeOf } from "./forge/forge";
import type { ReviewRead } from "./forge/review";
import type { Runner } from "./mr";
import { appendLog } from "./oversight";
import { WorkflowError } from "./sdk";
import { epochMs } from "./time";

export const LandingSchema = Schema.Struct({
  state: Schema.Literals(["attempt", "landed", "withdrawn"]),
  mr: Schema.String,
  head: Schema.String,
  /** When the attempt was written. */
  at: Schema.String,
  /** The merged commit, once landed. */
  sha: Schema.optionalKey(Schema.String),
  /** Why it was withdrawn. */
  why: Schema.optionalKey(Schema.String),
  /** The Run whose landing this one took over to finish its release. */
  from: Schema.optionalKey(Schema.String),
});
export type Landing = typeof LandingSchema.Type;

/** What a merge call came to. `MergedOutside` is a merge this Run did not make. */
export const MergeOutcomeSchema = Schema.Union([
  Schema.TaggedStruct("Merged", { sha: Schema.String }),
  Schema.TaggedStruct("HeadMoved", { head: Schema.String }),
  Schema.TaggedStruct("MergedOutside", {
    sha: Schema.String,
    by: Schema.String,
    at: Schema.String,
  }),
  Schema.TaggedStruct("Refused", { reason: Schema.String }),
]);
export type MergeOutcome = typeof MergeOutcomeSchema.Type;

const LandingJson = Schema.fromJsonString(LandingSchema);
const landingPath = (runDir: string) => `${runDir}/landing.json`;

/** The Runs, by directory, whose attempt this host process is making now. */
export const landingNow = new Set<string>();

/** A Run's landing record, or null where it has none. */
export const readLanding = Effect.fn("Landing.read")(function* (runDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(landingPath(runDir)).pipe(Effect.orElseSucceed(() => ""));
  return Option.getOrNull(Schema.decodeOption(LandingJson)(text));
});

const lineOf = (record: Landing) => {
  const at = `${record.mr} at ${record.head}`;
  if (record.state === "attempt") return `landing: attempting to merge ${at}`;
  if (record.from !== undefined)
    return `landing: took over the merge of ${at} as ${record.sha ?? ""} from ${record.from}`;
  if (record.state === "landed") return `landing: merged ${at} as ${record.sha ?? ""}`;
  return `landing: withdrew the merge of ${at}: ${record.why ?? ""}`;
};

/** Writes the record and logs it, both in the Run's own directory. */
export const writeLanding = Effect.fn("Landing.write")(function* (runDir: string, record: Landing) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(runDir, { recursive: true });
  yield* fs.writeFileString(
    landingPath(runDir),
    yield* Schema.encodeEffect(LandingJson)(record).pipe(Effect.orDie),
  );
  yield* appendLog(runDir, lineOf(record));
});

/** How far the forge's clock may run behind the host's. */
const CLOCK_SKEW_MS = 60_000;

export type Settled =
  | { readonly _tag: "Unmerged" }
  | { readonly _tag: "Landed"; readonly sha: string }
  | { readonly _tag: "Outside"; readonly sha: string; readonly by: string; readonly at: string };

/**
 * An attempt with no outcome, on the forge's word: merged by Collie's login at its head no
 * earlier than it was written is the merge it made; any other merge is someone else's.
 */
export function settleAttempt(
  attempt: Landing,
  read: Extract<ReviewRead, { readonly ok: true }>,
): Settled {
  if (read.state !== "merged" || read.merged === null) return { _tag: "Unmerged" };
  const { sha, by, at } = read.merged;
  return by === read.login &&
    read.head === attempt.head &&
    epochMs(at) >= epochMs(attempt.at) - CLOCK_SKEW_MS
    ? { _tag: "Landed", sha }
    : { _tag: "Outside", sha, by, at };
}

/** Settles an attempt an earlier process left, and records what the forge's word made it. */
export const settleLeft = Effect.fn("Landing.settleLeft")(function* (
  runDir: string,
  left: Landing,
  read: Extract<ReviewRead, { readonly ok: true }>,
) {
  const settled = settleAttempt(left, read);
  if (settled._tag === "Landed")
    yield* writeLanding(runDir, { ...left, state: "landed", sha: settled.sha });
  if (settled._tag === "Outside")
    yield* writeLanding(runDir, { ...left, state: "withdrawn", why: outside(settled.by) });
  return settled;
});

const outside = (by: string) => `merged outside this Run by ${by}`;

/**
 * Merges the merge request a Run recorded at `head`, writing the attempt first and its
 * outcome after. A landing already recorded at `head` is answered from its record, and an
 * attempt an earlier process left is settled by `settleAttempt` first.
 */
export const land = Effect.fn("Landing.land")(function* <R>(opts: {
  readonly runDir: string;
  readonly mr: string | null;
  readonly head: string;
  readonly cwd: string;
  readonly run: Runner<R>;
}) {
  const ref = opts.mr === null ? null : mrRefOf(opts.mr);
  if (opts.mr === null || ref === null)
    return yield* new WorkflowError({ reason: "this Run has recorded no merge request to merge" });
  const mr = opts.mr;
  const forge = forgeOf(ref);
  const withdraw = (record: Landing, why: string) =>
    writeLanding(opts.runDir, { ...record, state: "withdrawn", why });
  const left = yield* readLanding(opts.runDir);
  const same = left !== null && mrLabel(left.mr) === mrLabel(mr) && left.head === opts.head;
  if (same && left.state === "landed" && left.sha !== undefined)
    return { _tag: "Merged", sha: left.sha } satisfies MergeOutcome;
  if (left?.state === "attempt" && mrLabel(left.mr) === mrLabel(mr)) {
    const read = yield* forge.readReview(ref, opts.cwd, opts.run);
    if (!read.ok)
      return yield* new WorkflowError({
        reason: `an earlier attempt to merge ${mr} could not be settled: ${read.reason}`,
      });
    const settled = yield* settleLeft(opts.runDir, left, read);
    if (settled._tag === "Landed")
      return { _tag: "Merged", sha: settled.sha } satisfies MergeOutcome;
    if (settled._tag === "Outside") {
      const { sha, by, at } = settled;
      return { _tag: "MergedOutside", sha, by, at } satisfies MergeOutcome;
    }
    yield* withdraw(left, "left unanswered by an earlier host");
  }
  landingNow.add(opts.runDir);
  return yield* Effect.gen(function* () {
    const attempt: Landing = {
      state: "attempt",
      mr,
      head: opts.head,
      at: DateTime.formatIso(yield* DateTime.now),
    };
    yield* writeLanding(opts.runDir, attempt);
    const answer = yield* forge.merge(ref, opts.head, opts.cwd, opts.run);
    switch (answer._tag) {
      case "Merged":
        yield* writeLanding(opts.runDir, { ...attempt, state: "landed", sha: answer.merged });
        return { _tag: "Merged", sha: answer.merged } satisfies MergeOutcome;
      case "HeadMoved":
        yield* withdraw(attempt, `the head moved to ${answer.head}`);
        return { _tag: "HeadMoved", head: answer.head } satisfies MergeOutcome;
      case "AlreadyMerged":
        yield* withdraw(attempt, outside(answer.by));
        return {
          _tag: "MergedOutside",
          sha: answer.merged,
          by: answer.by,
          at: answer.at,
        } satisfies MergeOutcome;
      case "Refused":
        yield* withdraw(attempt, answer.reason);
        return { _tag: "Refused", reason: answer.reason } satisfies MergeOutcome;
    }
  }).pipe(Effect.ensuring(Effect.sync(() => landingNow.delete(opts.runDir))));
});

/** What a takeover came to: the landing taken over, or why there was none to take. */
export const TakeoverSchema = Schema.Union([
  Schema.TaggedStruct("TakenOver", {
    from: Schema.String,
    sha: Schema.String,
    head: Schema.String,
    /** Why the Run it came from failed. */
    failure: Schema.String,
  }),
  Schema.TaggedStruct("Refused", { why: Schema.String }),
]);
export type Takeover = typeof TakeoverSchema.Type;

/** A Run on this host as a takeover weighs it: null `ended` is one still running. */
export interface Lander {
  readonly runId: string;
  readonly landing: Landing | null;
  readonly ended: { readonly succeeded: boolean; readonly failure: string } | null;
}

/**
 * The landing of a merged merge request, taken over from the newest Run that landed it,
 * only where that Run ended without succeeding at the merged commit the forge reports.
 * Recorded on this Run, naming that one, so a later recovery finds this one.
 */
export const takeOver = Effect.fn("Landing.takeOver")(function* <R>(opts: {
  readonly runDir: string;
  readonly mr: string | null;
  readonly runs: ReadonlyArray<Lander>;
  readonly cwd: string;
  readonly run: Runner<R>;
}) {
  const ref = opts.mr === null ? null : mrRefOf(opts.mr);
  if (opts.mr === null || ref === null)
    return yield* new WorkflowError({
      reason: "this Run has recorded no merge request to recover",
    });
  const mr = opts.mr;
  const refused = (why: string): Takeover => ({ _tag: "Refused", why });
  const ended = (runId: string) =>
    Option.getOrUndefined(Arr.findFirst(opts.runs, (one) => one.runId === runId))?.ended ?? null;
  const own = yield* readLanding(opts.runDir);
  if (own?.state === "landed" && own.from !== undefined && own.sha !== undefined)
    return {
      _tag: "TakenOver",
      from: own.from,
      sha: own.sha,
      head: own.head,
      failure: ended(own.from)?.failure ?? "",
    } satisfies Takeover;
  const finished = Arr.flatMap(opts.runs, (one) =>
    one.landing?.state === "landed" && mrLabel(one.landing.mr) === mrLabel(mr)
      ? [{ ...one, landing: one.landing }]
      : [],
  );
  const landed = Arr.sortWith(
    finished,
    (value) => value,
    (a, b) => Num.sign(epochMs(b.landing.at) - epochMs(a.landing.at)),
  );
  const newest = landed[0];
  if (newest === undefined)
    return refused(`${mr} was merged outside a Release Run: no Run on this host landed it`);
  if (newest.ended === null) return refused(`${mr} is still being released by ${newest.runId}`);
  if (newest.ended.succeeded) return refused(`${mr} was already released by ${newest.runId}`);
  const read = yield* forgeOf(ref).readReview(ref, opts.cwd, opts.run);
  if (!read.ok) return refused(`${mr} could not be read: ${read.reason}`);
  const sha = read.merged?.sha ?? "";
  if (read.state !== "merged") return refused(`${mr} is ${read.state}, not merged`);
  if (sha !== newest.landing.sha)
    return refused(
      `${mr} was merged at ${sha}, not at the ${newest.landing.sha ?? ""} ${newest.runId} landed`,
    );
  yield* writeLanding(opts.runDir, {
    state: "landed",
    mr,
    head: newest.landing.head,
    at: DateTime.formatIso(yield* DateTime.now),
    sha,
    from: newest.runId,
  });
  return {
    _tag: "TakenOver",
    from: newest.runId,
    sha,
    head: newest.landing.head,
    failure: newest.ended.failure,
  } satisfies Takeover;
});
