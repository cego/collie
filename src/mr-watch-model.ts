import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { Schema } from "effect";

/** How long a new head must stand unchanged before it is a change. */
export const QUIET_MS = 5 * 60_000;
/** How long a running pipeline is waited for before the change goes ahead without it. */
export const PIPELINE_CAP_MS = 30 * 60_000;

/** Where the watching Run left off: the head it worked from, the comments it has seen, its pipeline. */
export const WatchCursor = Schema.Struct({
  head: Schema.String,
  seen: Schema.Array(Schema.String),
  /** The head's checks as the card reads them: `passed`, `failed`, `running`, `unknown` or `none`. */
  pipeline: Schema.String,
});
export type WatchCursor = typeof WatchCursor.Type;

/** The head the watch last read, since when it has stood, and since when its pipeline has run. */
export const Observed = Schema.Struct({
  head: Schema.String,
  since: Schema.Finite,
  running: Schema.NullOr(Schema.Finite),
});
export type Observed = typeof Observed.Type;

/** One read of the merge request, as the merge watch made it. */
export interface MrReading {
  readonly state: "open" | "merged" | "closed";
  readonly head: string;
  readonly pipeline: string;
  readonly comments: ReadonlyArray<{ readonly id: string; readonly body: string }>;
}

export const WatchChange = Schema.Struct({
  head: Schema.String,
  /** The cursor's head. */
  previous: Schema.String,
  newHead: Schema.Boolean,
  /** Comments new since the cursor, none of them Collie's. */
  comments: Schema.Array(Schema.String),
  /** The head's pipeline where it has ended, `passed` or `failed`. */
  pipeline: Schema.NullOr(Schema.String),
  /** A new head that does not descend from `previous`; null where ancestry was not read. */
  forcePush: Schema.NullOr(Schema.Boolean),
});
export type WatchChange = typeof WatchChange.Type;

/** What wakes a watching Run. */
export const Woke = Schema.Union([
  Schema.TaggedStruct("Changed", { change: WatchChange }),
  Schema.TaggedStruct("Ended", { state: Schema.Literals(["merged", "closed"]) }),
]);
export type Woke = typeof Woke.Type;

export type Verdict =
  | { readonly _tag: "NoChange" }
  | { readonly _tag: "NotYet"; readonly until: number }
  | Woke;

const TERMINAL = new Set(["passed", "failed"]);

const SIGNATURES = [
  /^Review by Collie for @\S+ · \S+ round \d+ at [0-9a-f]+$/,
  /^Posted by Collie's Run \S+ on /,
];

/** A verdict, and what the watch keeps for the next judgement. */
export interface Judgement {
  readonly verdict: Verdict;
  readonly observed: Observed;
}

/** Whether a comment's last line is one Collie signs its notes and replies with. */
export const signedByCollie = (body: string) => {
  const last = Arr.last(Arr.filter(Str.split(Str.trimEnd(body), "\n"), (line) => line !== ""));
  return last._tag === "Some" && Arr.some(SIGNATURES, (one) => one.test(Str.trim(last.value)));
};

/**
 * The verdict on `reading` against `cursor`.
 * `descends` says whether a new head descends from the cursor's; left out, it was not read.
 */
export function judge(options: {
  readonly cursor: WatchCursor;
  readonly observed: Observed | null;
  readonly reading: MrReading;
  readonly now: number;
  readonly descends?: boolean;
}): Judgement {
  const { cursor, reading, now } = options;
  const before = options.observed?.head === reading.head ? options.observed : null;
  const running = reading.pipeline === "running";
  const observed: Observed = {
    head: reading.head,
    since: before?.since ?? now,
    running: running ? (before?.running ?? now) : null,
  };
  if (reading.state !== "open")
    return { verdict: { _tag: "Ended", state: reading.state }, observed };
  const newHead = reading.head !== "" && reading.head !== cursor.head;
  const comments = pipe(
    reading.comments,
    Arr.filter((one) => !cursor.seen.includes(one.id) && !signedByCollie(one.body)),
    Arr.map((one) => one.id),
  );
  const ended = TERMINAL.has(reading.pipeline) && (newHead || reading.pipeline !== cursor.pipeline);
  if (!newHead && comments.length === 0 && !ended)
    return { verdict: { _tag: "NoChange" }, observed };
  const until = Math.max(
    newHead ? observed.since + QUIET_MS : now,
    observed.running === null ? now : observed.running + PIPELINE_CAP_MS,
  );
  if (until > now) return { verdict: { _tag: "NotYet", until }, observed };
  return {
    verdict: {
      _tag: "Changed",
      change: {
        head: reading.head,
        previous: cursor.head,
        newHead,
        comments,
        pipeline: ended ? reading.pipeline : null,
        forcePush: !newHead ? false : options.descends === undefined ? null : !options.descends,
      },
    },
    observed,
  };
}
