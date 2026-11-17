// `run list` as a bounded page: which Runs a listing asks for, the summary each one is
// given, and the two tokens that continue it — `next` for the page after, `cursor` for
// what changed since.

import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { Option, Result, Schema, flow, pipe } from "effect";
import { isoAt } from "./time";
import type { TaskView } from "./board-model";
import { ParkCause } from "./park-cause";
import { awaitingLine } from "./awaiting";
import { isJsonObject } from "./schema";
import type { RunFacts } from "./runs";

/** A Run's state as the board names it. */
export const LIST_STATES = [
  "live",
  "parked",
  "needs-you",
  "succeeded",
  "failed",
  "stopped",
] as const;
export const ListState = Schema.Literals(LIST_STATES);
export type ListState = typeof ListState.Type;

/** Runs a page answers without `--limit`. */
export const DEFAULT_LIMIT = 50;

export const listStateOf = (run: RunFacts): ListState => {
  switch (run.state) {
    case "stopped":
    case "failed":
    case "succeeded":
      return run.state;
    case "ended":
      return "succeeded";
    default:
      if (run.asking.length > 0) return "needs-you";
      return run.parked !== null ? "parked" : "live";
  }
};

/** One Run as a page lists it: its card's facts about it, not its whole record. */
export const RunSummary = Schema.Struct({
  runId: Schema.String,
  workflow: Schema.String,
  task: Schema.NullOr(Schema.String),
  state: ListState,
  created: Schema.String,
  /** When its card last changed, or its creation where it has none. */
  updated: Schema.String,
  park: Schema.NullOr(ParkCause),
  /** What holds it up, in its own words, or null. */
  blocker: Schema.NullOr(Schema.String),
  /** Its agent on the board, or null for none. */
  agent: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  head: Schema.NullOr(Schema.String),
  /** What it waits for next, or null where nothing is expected. */
  next: Schema.NullOr(Schema.String),
});
export type RunSummary = typeof RunSummary.Type;

export const summaryOf = (
  run: RunFacts,
  card: TaskView | undefined,
  head: string | null,
): RunSummary => {
  const asked = run.asking[0];
  const wakes = run.engine?.wakes ?? null;
  return {
    runId: run.id,
    workflow: run.workflow,
    task: run.task,
    state: listStateOf(run),
    created: run.created,
    updated: card === undefined ? run.created : isoAt(card.at),
    park: run.park?.cause ?? null,
    blocker: asked?.prompt ?? run.note,
    agent:
      Option.getOrUndefined(Arr.findFirst(card?.agents ?? [], (one) => one.run === run.id))?.name ??
      null,
    branch: run.branch,
    head,
    next:
      asked !== undefined
        ? `an answer to ${asked.name}`
        : run.awaiting !== null
          ? awaitingLine(run.awaiting)
          : wakes !== null
            ? `wakes at ${wakes}`
            : null,
  };
};

/** Where a page ended: the last Run it returned. */
export const Position = Schema.Struct({ created: Schema.String, runId: Schema.String });
export type Position = typeof Position.Type;

/** Newest first, and by id between Runs created in the same instant. */
export const newerFirst = (a: Position, b: Position): number =>
  a.created === b.created
    ? b.runId < a.runId
      ? -1
      : b.runId > a.runId
        ? 1
        : 0
    : b.created < a.created
      ? -1
      : 1;

/** What a host is asked for its own Runs. */
export const RunPageAsked = Schema.Struct({
  task: Schema.NullOr(Schema.String),
  states: Schema.Array(ListState),
  /** Null for every Run that matches. */
  limit: Schema.NullOr(Schema.Int),
  full: Schema.Boolean,
  after: Schema.NullOr(Position),
  /** Only Runs whose revision is past this, or null for every Run. */
  since: Schema.NullOr(Schema.Finite),
});
export type RunPageAsked = typeof RunPageAsked.Type;

/** A Run with what a host pages it by. */
interface Pageable {
  readonly facts: RunFacts;
  readonly revision: number;
}

/** The Runs a host answers, in order, and how many more match after them. */
export const pageOf = <A extends Pageable>(runs: ReadonlyArray<A>, asked: RunPageAsked) => {
  const matching = Arr.filter(
    runs,
    (one) =>
      (asked.states.length === 0 || asked.states.includes(listStateOf(one.facts))) &&
      (asked.since === null || one.revision > asked.since) &&
      (asked.after === null || newerFirst(asked.after, positionOf(one.facts)) < 0),
  ).sort((a, b) => newerFirst(positionOf(a.facts), positionOf(b.facts)));
  const page = asked.limit === null ? matching : matching.slice(0, asked.limit);
  return { page, omitted: matching.length - page.length };
};

const positionOf = (run: RunFacts): Position => ({ created: run.created, runId: run.id });

/** Each Machine's host start, and where its changes had got to. */
const Marks = Schema.Record(
  Schema.String,
  Schema.Struct({ epoch: Schema.String, seq: Schema.Finite }),
);
type Marks = typeof Marks.Type;

const Token = Schema.Union([
  Schema.TaggedStruct("page", {
    task: Schema.NullOr(Schema.String),
    states: Schema.Array(ListState),
    limit: Schema.NullOr(Schema.Int),
    full: Schema.Boolean,
    since: Schema.NullOr(Marks),
    after: Position,
    /** Each Machine's host start when the listing began. */
    epochs: Schema.Record(Schema.String, Schema.String),
  }),
  Schema.TaggedStruct("cursor", { marks: Marks }),
]);
type PageToken = Extract<typeof Token.Type, { readonly _tag: "page" }>;

const encodeToken = flow(
  Schema.encodeResult(Schema.fromJsonString(Token)),
  Result.getOrThrow,
  (json: string) => Buffer.from(json).toString("base64url"),
);
const decodeToken = (text: string) =>
  Schema.decodeOption(Schema.fromJsonString(Token))(Buffer.from(text, "base64url").toString());

export const pageToken = (token: Omit<PageToken, "_tag">) =>
  encodeToken({ _tag: "page", ...token });
export const cursorToken = (marks: Marks) => encodeToken({ _tag: "cursor", marks });

/** A token given to `--after` or `--since`, or why it is refused. */
export const readToken = <T extends "page" | "cursor">(
  text: string,
  tag: T,
):
  | { ok: true; token: Extract<typeof Token.Type, { readonly _tag: T }> }
  | { ok: false; message: string } => {
  const read = decodeToken(text);
  if (Option.isNone(read)) return { ok: false, message: `"${text}" is not a token run list gave.` };
  if (read.value._tag !== tag)
    return {
      ok: false,
      message:
        tag === "page"
          ? "That is a cursor: give it to --since, and a next page token to --after."
          : "That is a next page token: give it to --after, and a cursor to --since.",
    };
  // SAFETY: the tag was just checked.
  return { ok: true, token: read.value as Extract<typeof Token.Type, { readonly _tag: T }> };
};

/** The Machines whose host has started again since the token was given. */
export const restarted = (
  given: Readonly<Record<string, string>>,
  now: Readonly<Record<string, string>>,
): ReadonlyArray<string> =>
  Arr.filter(
    Rec.keys(given),
    (machine) => now[machine] !== undefined && now[machine] !== given[machine],
  );

/** What `run list` asks for, as its flags or a page token said it. */
export interface RunListAsked {
  readonly task: string | null;
  readonly states: ReadonlyArray<ListState>;
  readonly limit: number | null;
  readonly full: boolean;
  readonly after: Position | null;
  readonly since: Marks | null;
  /** Each Machine's host start the page token was given under; empty for a first page. */
  readonly epochs: Readonly<Record<string, string>>;
}

/** The filters as given, before they are read. */
export interface ListFlags {
  readonly status: ReadonlyArray<string>;
  readonly limit: string | null;
  readonly fields: string | null;
  readonly after: string | null;
  readonly since: string | null;
}

/**
 * What a listing asks for, or why its flags are refused. A page token carries the filters
 * it was given under, so `after` takes no others; `--fields full` alone is every Run.
 */
export const listAsked = (
  flags: ListFlags,
  task: string | null,
): { ok: true; asked: RunListAsked } | { ok: false; message: string } => {
  if (flags.after !== null) {
    if (
      flags.status.length > 0 ||
      flags.limit !== null ||
      flags.fields !== null ||
      flags.since !== null
    )
      return {
        ok: false,
        message: "--after continues a listing under its own filters; give it alone.",
      };
    const read = readToken(flags.after, "page");
    if (!read.ok) return read;
    const { _tag, ...token } = read.token;
    return { ok: true, asked: token };
  }
  const states = Arr.filter(flags.status, (one) => !Schema.is(ListState)(one));
  if (states.length > 0)
    return {
      ok: false,
      message: `--status takes ${Arr.join(LIST_STATES, ", ")}; not ${Arr.join(states, ", ")}.`,
    };
  if (flags.fields !== null && flags.fields !== "summary" && flags.fields !== "full")
    return { ok: false, message: `--fields takes summary or full; not ${flags.fields}.` };
  const full = flags.fields === "full";
  const limit = flags.limit === null ? (full ? null : DEFAULT_LIMIT) : Number(flags.limit);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1))
    return {
      ok: false,
      message: `--limit takes a whole number of Runs, 1 or more; not ${flags.limit}.`,
    };
  const since = flags.since === null ? null : readToken(flags.since, "cursor");
  if (since !== null && !since.ok) return since;
  return {
    ok: true,
    asked: {
      task,
      // SAFETY: each was checked against LIST_STATES above.
      states: flags.status as ReadonlyArray<ListState>,
      limit,
      full,
      after: null,
      since: since === null ? null : since.token.marks,
      epochs: {},
    },
  };
};

/** The longest Output summary `run output` gives before `--full`. */
const SUMMARY_CHARS = 360;

const fieldOf = (value: Schema.Json, key: string) => (isJsonObject(value) ? value[key] : undefined);
const textField = (value: Schema.Json, key: string): string | null => {
  const field = fieldOf(value, key);
  return Schema.is(Schema.String)(field) ? field : null;
};

export interface OutputSummary {
  readonly path: string;
  readonly step: string;
  readonly verdict: string | null;
  readonly summary: string | null;
  readonly findings: number | null;
  readonly read: string;
  readonly error?: string;
}

/** One Output as `run output` answers it by default: what it said, never its body. */
export const outputSummary = (
  runId: string,
  output: { readonly path: string; readonly value?: Schema.Json; readonly error?: string },
): OutputSummary => {
  const value = output.value ?? null;
  const findings = fieldOf(value, "findings");
  const summary = textField(value, "summary") ?? textField(value, "conclusion");
  const said = {
    path: output.path,
    step: pipe(output.path, Str.replace(/\.json$/, "")),
    verdict: textField(value, "verdict"),
    summary:
      summary === null || summary.length <= SUMMARY_CHARS
        ? summary
        : `${pipe(summary, Str.slice(0, SUMMARY_CHARS))}…`,
    findings: Arr.isArray(findings) ? findings.length : null,
    read: `collie run output ${runId} --full --path ${output.path}`,
  };
  return output.error === undefined ? said : { ...said, error: output.error };
};
