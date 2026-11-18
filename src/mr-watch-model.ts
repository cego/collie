import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { Schema } from "effect";

export const QUIET_MS = 5 * 60_000;
export const PIPELINE_CAP_MS = 30 * 60_000;

export const WatchCursor = Schema.Struct({
  head: Schema.String,
  seen: Schema.Array(Schema.String),
  pipeline: Schema.String,
  headOnly: Schema.optionalKey(Schema.Boolean),
});
export type WatchCursor = typeof WatchCursor.Type;

export const Observed = Schema.Struct({
  head: Schema.String,
  since: Schema.Finite,
  running: Schema.NullOr(Schema.Finite),
});
export type Observed = typeof Observed.Type;

export interface MrReading {
  readonly state: "open" | "merged" | "closed";
  readonly head: string;
  readonly pipeline: string;
  readonly comments: ReadonlyArray<{ readonly id: string; readonly body: string }>;
}

export const WatchChange = Schema.Struct({
  head: Schema.String,
  previous: Schema.String,
  newHead: Schema.Boolean,
  comments: Schema.Array(Schema.String),
  pipeline: Schema.NullOr(Schema.String),
  forcePush: Schema.NullOr(Schema.Boolean),
});
export type WatchChange = typeof WatchChange.Type;

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
  /^<!-- collie:(\S+)(?: [^>]*)? -->$/,
  /^Review by Collie for @\S+ · (\S+) round \d+ at [0-9a-f]+$/,
  /^Posted by Collie's Run (\S+) on /,
];

export interface Judgement {
  readonly verdict: Verdict;
  readonly observed: Observed;
}

export const collieRunOf = (body: string) => {
  const last = Arr.last(Arr.filter(Str.split(Str.trimEnd(body), "\n"), (line) => line !== ""));
  if (last._tag === "None") return null;
  for (const signature of SIGNATURES) {
    const run = signature.exec(Str.trim(last.value))?.[1];
    if (run !== undefined) return run;
  }
  return null;
};

export const signedByCollie = (body: string) => collieRunOf(body) !== null;

export function judge(options: {
  readonly cursor: WatchCursor;
  readonly observed: Observed | null;
  readonly reading: MrReading;
  readonly now: number;
  readonly descends?: boolean;
  readonly run?: string;
}) {
  const { cursor, reading, now } = options;
  const before = options.observed?.head === reading.head ? options.observed : null;
  const running = reading.pipeline === "running";
  const observed: Observed = {
    head: reading.head,
    since: before?.since ?? now,
    running: running ? (before?.running ?? now) : null,
  };
  if (reading.state !== "open") {
    const returned: Judgement = { verdict: { _tag: "Ended", state: reading.state }, observed };
    return returned;
  }
  const newHead = reading.head !== "" && reading.head !== cursor.head;
  const comments = cursor.headOnly
    ? []
    : pipe(
        reading.comments,
        Arr.filter(
          (one) =>
            !cursor.seen.includes(one.id) &&
            (!signedByCollie(one.body) ||
              (options.run !== undefined && collieRunOf(one.body) !== options.run)),
        ),
        Arr.map((one) => one.id),
      );
  const ended =
    !cursor.headOnly &&
    TERMINAL.has(reading.pipeline) &&
    (newHead || reading.pipeline !== cursor.pipeline);
  if (!newHead && comments.length === 0 && !ended) {
    const returned: Judgement = { verdict: { _tag: "NoChange" }, observed };
    return returned;
  }
  const until = Math.max(
    newHead ? observed.since + QUIET_MS : now,
    observed.running === null ? now : observed.running + PIPELINE_CAP_MS,
  );
  if (until > now) {
    const returned: Judgement = { verdict: { _tag: "NotYet", until }, observed };
    return returned;
  }
  const returned: Judgement = {
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
  return returned;
}
