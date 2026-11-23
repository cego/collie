import * as Num from "effect/Number";
import * as Arr from "effect/Array";
import { DateTime, Effect, Option, Schema } from "effect";
import { forgeOfRef, mrRefOf } from "./board-model";
import { forgeOf } from "./forge/forge";
import { QUEUE_MERGERS } from "./forge/review";
import type { ReviewRead } from "./forge/review";
import { mrIdIn } from "./mr";
import type { Runner } from "./mr";
import { appendLog } from "./oversight";
import { WorkflowError } from "./sdk";
import { epochMs } from "./time";
import { RunRecords, runOfDir } from "./run-records";

export const LandingSchema = Schema.Struct({
  state: Schema.Literals(["attempt", "landed", "withdrawn"]),
  mr: Schema.String,
  head: Schema.String,
  at: Schema.String,
  sha: Schema.optionalKey(Schema.String),
  why: Schema.optionalKey(Schema.String),
  from: Schema.optionalKey(Schema.String),
});
export type Landing = typeof LandingSchema.Type;

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
const LANDING = "landing.json";

export const landingNow = new Set<string>();

export const readLanding = Effect.fn("Landing.read")(function* (runDir: string) {
  const text = yield* RunRecords.use((records) => records.fact(runOfDir(runDir), LANDING));
  return text === null ? null : Option.getOrNull(Schema.decodeOption(LandingJson)(text));
});

const lineOf = (record: Landing) => {
  const at = `${record.mr} at ${record.head}`;
  if (record.state === "attempt") return `landing: attempting to merge ${at}`;
  if (record.from !== undefined)
    return `landing: took over the merge of ${at} as ${record.sha ?? ""} from ${record.from}`;
  if (record.state === "landed") return `landing: merged ${at} as ${record.sha ?? ""}`;
  return `landing: withdrew the merge of ${at}: ${record.why ?? ""}`;
};

export const writeLanding = Effect.fn("Landing.write")(function* (runDir: string, record: Landing) {
  const text = yield* Schema.encodeEffect(LandingJson)(record).pipe(Effect.orDie);
  yield* RunRecords.use((records) => records.put(runOfDir(runDir), LANDING, text));
  yield* appendLog(runDir, lineOf(record));
});

// WARNING: The forge's clock may run this far behind the host's.
const CLOCK_SKEW_MS = 60_000;

export type Settled =
  | { readonly _tag: "Unmerged" }
  | { readonly _tag: "Landed"; readonly sha: string }
  | { readonly _tag: "Outside"; readonly sha: string; readonly by: string; readonly at: string };

// WARNING: A merge-queue merge counts as Collie's only at a head written no earlier than the attempt.
export function settleAttempt(attempt: Landing, read: Extract<ReviewRead, { readonly ok: true }>) {
  if (read.state !== "merged" || read.merged === null) {
    const returned: Settled = { _tag: "Unmerged" };
    return returned;
  }
  const { sha, by, at } = read.merged;
  const ref = mrRefOf(attempt.mr);
  const queue = ref !== null && forgeOfRef(ref) === "github" && QUEUE_MERGERS.has(by);
  const returned: Settled =
    (by === read.login || queue) &&
    read.head === attempt.head &&
    epochMs(at) >= epochMs(attempt.at) - CLOCK_SKEW_MS
      ? { _tag: "Landed", sha }
      : { _tag: "Outside", sha, by, at };
  return returned;
}

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

const sameMr = <R>(
  one: string,
  other: string,
  at: { readonly cwd: string; readonly run: Runner<R> },
) =>
  Effect.gen(function* () {
    const id = yield* mrIdIn(one, at.cwd, at.run);
    return id !== null && id === (yield* mrIdIn(other, at.cwd, at.run));
  });

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
  const ours = left !== null && (yield* sameMr(left.mr, mr, opts));
  if (ours && left.head === opts.head && left.state === "landed" && left.sha !== undefined)
    return { _tag: "Merged", sha: left.sha } satisfies MergeOutcome;
  if (ours && left.state === "attempt") {
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
        {
          const returned: MergeOutcome = { _tag: "Merged", sha: answer.merged };
          return returned;
        }
      case "HeadMoved":
        yield* withdraw(attempt, `the head moved to ${answer.head}`);
        {
          const returned: MergeOutcome = { _tag: "HeadMoved", head: answer.head };
          return returned;
        }
      case "AlreadyMerged":
        yield* withdraw(attempt, outside(answer.by));
        {
          const returned: MergeOutcome = {
            _tag: "MergedOutside",
            sha: answer.merged,
            by: answer.by,
            at: answer.at,
          };
          return returned;
        }
      case "Refused":
        yield* withdraw(attempt, answer.reason);
        {
          const returned: MergeOutcome = { _tag: "Refused", reason: answer.reason };
          return returned;
        }
    }
  }).pipe(Effect.ensuring(Effect.sync(() => landingNow.delete(opts.runDir))));
});

export const TakeoverSchema = Schema.Union([
  Schema.TaggedStruct("TakenOver", {
    from: Schema.String,
    sha: Schema.String,
    head: Schema.String,
    failure: Schema.String,
  }),
  Schema.TaggedStruct("Refused", { why: Schema.String }),
]);
export type Takeover = typeof TakeoverSchema.Type;

export interface Lander {
  readonly runId: string;
  readonly landing: Landing | null;
  readonly ended: { readonly succeeded: boolean; readonly failure: string } | null;
}

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
  const refused: (why: string) => Takeover = (why) => ({ _tag: "Refused", why });
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
  const finished: Array<Lander & { readonly landing: Landing }> = [];
  for (const one of opts.runs)
    if (one.landing?.state === "landed" && (yield* sameMr(one.landing.mr, mr, opts)))
      finished.push({ ...one, landing: one.landing });
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
