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

export const DEFAULT_LIMIT = 50;

export const listStateOf: (run: RunFacts) => ListState = (run) => {
  switch (run.state) {
    case "stopped":
    case "failed":
    case "succeeded":
      return run.state;
    case "ended":
      return "succeeded";
    default:
      if (run.asking.length > 0) {
        return "needs-you";
      }
      return run.parked !== null ? "parked" : "live";
  }
};

export const RunSummary = Schema.Struct({
  runId: Schema.String,
  workflow: Schema.String,
  task: Schema.NullOr(Schema.String),
  state: ListState,
  created: Schema.String,
  updated: Schema.String,
  park: Schema.NullOr(ParkCause),
  blocker: Schema.NullOr(Schema.String),
  agent: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  head: Schema.NullOr(Schema.String),
  next: Schema.NullOr(Schema.String),
});
export type RunSummary = typeof RunSummary.Type;

export const summaryOf: (
  run: RunFacts,
  card: TaskView | undefined,
  head: string | null,
) => RunSummary = (run, card, head) => {
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

export const Position = Schema.Struct({ created: Schema.String, runId: Schema.String });
export type Position = typeof Position.Type;

export const newerFirst: (a: Position, b: Position) => number = (a, b) =>
  a.created === b.created
    ? b.runId < a.runId
      ? -1
      : b.runId > a.runId
        ? 1
        : 0
    : b.created < a.created
      ? -1
      : 1;

export const RunPageAsked = Schema.Struct({
  task: Schema.NullOr(Schema.String),
  states: Schema.Array(ListState),
  limit: Schema.NullOr(Schema.Int),
  full: Schema.Boolean,
  after: Schema.NullOr(Position),
  since: Schema.NullOr(Schema.Finite),
});
export type RunPageAsked = typeof RunPageAsked.Type;

interface Pageable {
  readonly facts: RunFacts;
  readonly revision: number;
}

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

const positionOf: (run: RunFacts) => Position = (run) => ({ created: run.created, runId: run.id });

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

type TokenRead<T extends "page" | "cursor"> =
  | { ok: true; token: Extract<typeof Token.Type, { readonly _tag: T }> }
  | { ok: false; message: string };

export const readToken = <T extends "page" | "cursor">(text: string, tag: T) => {
  const read = decodeToken(text);
  if (Option.isNone(read)) {
    const unread: TokenRead<T> = { ok: false, message: `"${text}" is not a token run list gave.` };
    return unread;
  }
  if (read.value._tag !== tag) {
    const mistaken: TokenRead<T> = {
      ok: false,
      message:
        tag === "page"
          ? "That is a cursor: give it to --since, and a next page token to --after."
          : "That is a next page token: give it to --after, and a cursor to --since.",
    };
    return mistaken;
  }
  const token: TokenRead<T> = {
    ok: true,
    // WARNING: the tag was just checked.
    token: read.value as Extract<typeof Token.Type, { readonly _tag: T }>,
  };
  return token;
};

export const restarted: (
  given: Readonly<Record<string, string>>,
  now: Readonly<Record<string, string>>,
) => ReadonlyArray<string> = (given, now) =>
  Arr.filter(
    Rec.keys(given),
    (machine) => now[machine] !== undefined && now[machine] !== given[machine],
  );

export interface RunListAsked {
  readonly task: string | null;
  readonly states: ReadonlyArray<ListState>;
  readonly limit: number | null;
  readonly full: boolean;
  readonly after: Position | null;
  readonly since: Marks | null;
  readonly epochs: Readonly<Record<string, string>>;
}

export interface ListFlags {
  readonly status: ReadonlyArray<string>;
  readonly limit: string | null;
  readonly fields: string | null;
  readonly after: string | null;
  readonly since: string | null;
}

// WARNING: a page token carries its filters, so `after` takes no others.
export const listAsked: (
  flags: ListFlags,
  task: string | null,
) => { ok: true; asked: RunListAsked } | { ok: false; message: string } = (flags, task) => {
  if (flags.after !== null) {
    if (
      flags.status.length > 0 ||
      flags.limit !== null ||
      flags.fields !== null ||
      flags.since !== null
    ) {
      return {
        ok: false,
        message: "--after continues a listing under its own filters; give it alone.",
      };
    }
    const read = readToken(flags.after, "page");
    if (!read.ok) {
      return read;
    }
    const { _tag, ...token } = read.token;
    return { ok: true, asked: token };
  }
  const states = Arr.filter(flags.status, (one) => !Schema.is(ListState)(one));
  if (states.length > 0) {
    return {
      ok: false,
      message: `--status takes ${Arr.join(LIST_STATES, ", ")}; not ${Arr.join(states, ", ")}.`,
    };
  }
  if (flags.fields !== null && flags.fields !== "summary" && flags.fields !== "full") {
    return { ok: false, message: `--fields takes summary or full; not ${flags.fields}.` };
  }
  const full = flags.fields === "full";
  const limit = flags.limit === null ? (full ? null : DEFAULT_LIMIT) : Number(flags.limit);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
    return {
      ok: false,
      message: `--limit takes a whole number of Runs, 1 or more; not ${flags.limit}.`,
    };
  }
  const since = flags.since === null ? null : readToken(flags.since, "cursor");
  if (since !== null && !since.ok) {
    return since;
  }
  return {
    ok: true,
    asked: {
      task,
      // WARNING: each was checked against LIST_STATES above.
      states: flags.status as ReadonlyArray<ListState>,
      limit,
      full,
      after: null,
      since: since === null ? null : since.token.marks,
      epochs: {},
    },
  };
};

const SUMMARY_CHARS = 360;

const fieldOf = (value: Schema.Json, key: string) => (isJsonObject(value) ? value[key] : undefined);
const textField: (value: Schema.Json, key: string) => string | null = (value, key) => {
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

export const outputSummary: (
  runId: string,
  output: { readonly path: string; readonly value?: Schema.Json; readonly error?: string },
) => OutputSummary = (runId, output) => {
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
