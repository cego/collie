// The record an agent taking over another's work is handed, built from the host's own state
// (ADR-0049 D8, as amended).

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { Effect, FileSystem, Path, Result, Schema, pipe } from "effect";
import type * as Types from "effect/Types";
import type { Verification } from "./verify";
import type { Finding } from "./output";
import type { AskedQuestion } from "./sdk";
import type { Solution } from "./board-model";

const Strings = Schema.Array(Schema.String);

/** What an agent may say beside its Output for whoever takes its work over. */
export const OutgoingFields = {
  decisions: Schema.optionalKey(
    Strings.annotate({ description: "what you decided that the next agent should keep" }),
  ),
  rejected: Schema.optionalKey(
    Strings.annotate({ description: "approaches you tried or weighed and turned down, and why" }),
  ),
  next_action: Schema.optionalKey(
    Schema.String.annotate({ description: "what you would do next, had you more turns" }),
  ),
};
const Outgoing = Schema.Struct(OutgoingFields);
export type Outgoing = typeof Outgoing.Type;

const Claim = Schema.Struct({
  criterion: Schema.String,
  /** The answer the work's last Output gave it as met; null where none did. */
  claimed: Schema.NullOr(Schema.String),
  /** The passing records at the head whose name that answer names. */
  proved: Strings,
});

export const HandOver = Schema.Struct({
  revision: Schema.Int,
  run: Schema.String,
  step: Schema.String,
  ticket: Schema.NullOr(Schema.String),
  agent: Schema.String,
  incarnation: Schema.Int,
  goal: Schema.NullOr(Schema.String),
  constraints: Strings,
  plan: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  base: Schema.NullOr(Schema.String),
  head: Schema.String,
  /** Whose the uncommitted work in the checkout is; null where there is none. */
  uncommitted: Schema.NullOr(Schema.String),
  criteria: Schema.Array(Claim),
  owed: Strings,
  findings: Schema.Array(
    Schema.Struct({ id: Schema.String, status: Schema.String, title: Schema.String }),
  ),
  questions: Schema.Array(Schema.Struct({ name: Schema.String, choices: Strings })),
  transcript: Schema.NullOr(Schema.String),
  reports: Schema.String,
  said: Schema.optionalKey(Outgoing),
});
export type HandOver = typeof HandOver.Type;

/** What only the workflow knows of the work a hand-over is about. */
export interface HandOverGiven {
  readonly ticket?: string;
  /** The plan directory, whose digest is the plan revision. */
  readonly plan?: string;
  /** The ticket's acceptance criteria, from its checkboxes. */
  readonly criteria?: ReadonlyArray<string>;
  /** The work's last decoded Output's answers to them. */
  readonly answers?: ReadonlyArray<{ readonly criterion: string; readonly met: string }>;
  /** The Checks the ticket names. */
  readonly checks?: ReadonlyArray<string>;
  readonly findings?: ReadonlyArray<Finding>;
  /** The outgoing agent's last Output. */
  readonly said?: Outgoing;
}

/** What the host holds when it builds one. */
export interface HandOverState {
  readonly revision: number;
  readonly run: string;
  readonly step: string;
  readonly agent: string;
  readonly incarnation: number;
  readonly given: HandOverGiven;
  readonly goal: string | null;
  readonly constraints: ReadonlyArray<string>;
  readonly plan: string | null;
  readonly checkout: CheckoutNow;
  readonly base: string | null;
  readonly verifications: ReadonlyArray<Verification>;
  /** The Run's Checks, by name. */
  readonly checks: ReadonlyArray<string>;
  readonly asked: ReadonlyArray<AskedQuestion>;
  readonly transcript: string | null;
  readonly reports: string;
}

export interface CheckoutNow {
  readonly head: string;
  readonly branch: string | null;
  readonly dirty: boolean;
}

const NOT_MET = /^\s*(not met|after merge)\b/i;

const names = (text: string, name: string) =>
  new RegExp(
    `(^|[^\\w-])${pipe(name, Str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))}([^\\w-]|$)`,
  ).test(text);

export const buildHandOver = (state: HandOverState): HandOver => {
  const { given, checkout } = state;
  const passing = Arr.filter(
    state.verifications,
    (one) => one.expect === "pass" && one.result === "pass" && one.end.head_sha === checkout.head,
  );
  const criteria = Arr.map(given.criteria ?? [], (criterion) => {
    const answer = Arr.findLast(given.answers ?? [], (one) => one.criterion === criterion);
    const claimed =
      answer._tag === "Some" && !NOT_MET.test(answer.value.met) ? answer.value.met : null;
    return {
      criterion,
      claimed,
      proved:
        claimed === null
          ? []
          : Arr.map(
              Arr.filter(passing, (one) => names(claimed, one.name)),
              (one) => one.id,
            ),
    };
  });
  const record: Types.Mutable<HandOver> = {
    revision: state.revision,
    run: state.run,
    step: state.step,
    ticket: given.ticket ?? null,
    agent: state.agent,
    incarnation: state.incarnation,
    goal: state.goal,
    constraints: state.constraints,
    plan: state.plan,
    branch: checkout.branch,
    base: state.base,
    head: checkout.head,
    uncommitted: checkout.dirty ? state.agent : null,
    criteria,
    owed: Arr.filter(
      Arr.dedupe([...state.checks, ...(given.checks ?? [])]),
      (name) => !Arr.some(passing, (one) => one.name === name),
    ),
    findings: Arr.filterMap(given.findings ?? [], (one) =>
      one.id === undefined || one.status === "fixed" || one.status === "obsolete"
        ? Result.failVoid
        : Result.succeed({ id: one.id, status: one.status ?? "open", title: one.title }),
    ),
    questions: Arr.map(
      Arr.filter(state.asked, (one) => one.answer === null && !one.superseded),
      (one) => ({
        name: one.name,
        choices: Arr.map(one.options ?? [], (option: Solution) => option.id),
      }),
    ),
    transcript: state.transcript,
    reports: state.reports,
  };
  const { decisions, rejected, next_action } = given.said ?? {};
  if (decisions !== undefined || rejected !== undefined || next_action !== undefined) {
    const own: Types.Mutable<Outgoing> = {};
    if (decisions !== undefined) own.decisions = decisions;
    if (rejected !== undefined) own.rejected = rejected;
    if (next_action !== undefined) own.next_action = next_action;
    record.said = own;
  }
  return record;
};

const listed = (heading: string, lines: ReadonlyArray<string>) =>
  lines.length === 0 ? [] : [heading, ...Arr.map(lines, (line) => `- ${line}`)];

const short = (sha: string) => (sha === "" ? "none" : pipe(sha, Str.slice(0, 12)));

/** The record as the new agent reads it, where it took over because `why`. */
export const renderHandOver = (record: HandOver, why: string): string =>
  Arr.join(
    [
      `## Hand-over (revision ${record.revision})`,
      `You take over ${record.step}${record.ticket === null ? "" : ` (ticket ${record.ticket})`} of ${record.run} from ${record.agent}, incarnation ${record.incarnation}, which stopped because ${why}. Carry on from where it was rather than start over.`,
      ...(record.goal === null ? [] : [`Goal: ${record.goal}`]),
      ...listed("Constraints:", record.constraints),
      `Plan revision: ${record.plan ?? "none"}`,
      `Checkout: branch ${record.branch ?? "none"}, base ${short(record.base ?? "")}, head ${short(record.head)}. ${
        record.uncommitted === null
          ? "Nothing is uncommitted."
          : `The uncommitted work is ${record.uncommitted}'s: read \`git status\` and \`git diff\` before you start.`
      }`,
      ...listed(
        "Acceptance criteria:",
        Arr.map(record.criteria, (one) =>
          one.claimed === null
            ? `${one.criterion} — not claimed`
            : one.proved.length === 0
              ? `${one.criterion} — claimed, unproved: ${one.claimed}`
              : `${one.criterion} — claimed met: ${one.claimed}; records ${Arr.join(one.proved, ", ")}`,
        ),
      ),
      `Checks still owed: ${record.owed.length === 0 ? "none" : Arr.join(record.owed, ", ")}. These are claims and records: the gate decides from the journal.`,
      ...listed(
        "Open findings:",
        Arr.map(record.findings, (one) => `${one.id} (${one.status}): ${one.title}`),
      ),
      ...listed(
        "Pending questions:",
        Arr.map(
          record.questions,
          (one) =>
            `${one.name}${one.choices.length === 0 ? "" : `, choices ${Arr.join(one.choices, ", ")}`}`,
        ),
      ),
      ...listed(`${record.agent} decided:`, record.said?.decisions ?? []),
      ...listed(`${record.agent} rejected:`, record.said?.rejected ?? []),
      ...(record.said?.next_action === undefined
        ? []
        : [`${record.agent}'s next action: ${record.said.next_action}`]),
      `${record.transcript === null ? "" : `Its conversation is at ${record.transcript}. `}The Run's reports are in ${record.reports}.`,
    ],
    "\n",
  );

/** What of the checkout a record is held to at dispatch. */
export interface AtDispatch {
  readonly head: string;
  readonly plan: string | null;
  readonly dirty: boolean;
}

const current = (record: HandOver, now: AtDispatch) =>
  record.head === now.head &&
  record.plan === now.plan &&
  (record.uncommitted !== null) === now.dirty;

/**
 * The record to dispatch: this one where it still matches the checkout, else one rebuilt
 * from host state where that matches, else null.
 */
export const atDispatch = <E, R>(
  record: HandOver,
  read: Effect.Effect<AtDispatch, E, R>,
  rebuild: Effect.Effect<HandOver, E, R>,
) =>
  Effect.gen(function* () {
    if (current(record, yield* read)) return record;
    const rebuilt = yield* rebuild;
    return current(rebuilt, yield* read) ? rebuilt : null;
  });

/** A digest of every file under the plan directory, by path and content. */
export const planRevision = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const files = Arr.sort(yield* fs.readDirectory(dir, { recursive: true }), Str.Order);
    const hasher = new Bun.CryptoHasher("sha256");
    for (const file of files) {
      const at = path.join(dir, file);
      if ((yield* fs.stat(at)).type !== "File") continue;
      hasher.update(`${file}\u0000`);
      hasher.update(yield* fs.readFile(at));
      hasher.update("\u0000");
    }
    return pipe(hasher.digest("hex"), Str.slice(0, 16));
  });
