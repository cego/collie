import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { Effect, FileSystem, Path, Result, Schema, pipe } from "effect";
import type * as Types from "effect/Types";
import type { Verification } from "./verify";
import type { Criterion } from "./output";
import type { Finding } from "./output";
import type { AskedQuestion } from "./sdk";
import type { Solution } from "./board-model";

const Strings = Schema.Array(Schema.String);

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
  claimed: Schema.NullOr(Schema.String),
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
  reviewed: Schema.optionalKey(Schema.String),
});
export type HandOver = typeof HandOver.Type;

export interface HandOverGiven {
  readonly ticket?: string;
  readonly plan?: string;
  readonly criteria?: ReadonlyArray<string>;
  readonly answers?: ReadonlyArray<{ readonly criterion: string; readonly met: string }>;
  readonly checks?: ReadonlyArray<string>;
  readonly findings?: ReadonlyArray<Finding>;
  readonly reviewed?: string;
  readonly said?: Outgoing;
}

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
    `(^|[^\\w-])${pipe(name, Str.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`))}([^\\w-]|$)`,
  ).test(text);

export const passingAt = (verifications: ReadonlyArray<Verification>, head: string) =>
  Arr.filter(
    verifications,
    (one) => one.expect === "pass" && one.result === "pass" && one.end.head_sha === head,
  );

export const criteriaEvidence = (input: {
  readonly criteria: ReadonlyArray<string>;
  readonly answers: ReadonlyArray<Criterion>;
  readonly passing: ReadonlyArray<Verification>;
}) =>
  Arr.map(input.criteria, (criterion) => {
    const answer = Arr.findLast(input.answers, (one) => one.criterion === criterion);
    const claimed =
      answer._tag === "Some" && !NOT_MET.test(answer.value.met) ? answer.value.met : null;
    return {
      criterion,
      claimed,
      proved:
        claimed === null
          ? []
          : Arr.map(
              Arr.filter(input.passing, (one) => names(claimed, one.name)),
              (one) => one.id,
            ),
    };
  });

export const buildHandOver = (state: HandOverState) => {
  const { given, checkout } = state;
  const passing = passingAt(state.verifications, checkout.head);
  const criteria = criteriaEvidence({
    criteria: given.criteria ?? [],
    answers: given.answers ?? [],
    passing,
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
    if (decisions !== undefined) {
      own.decisions = decisions;
    }
    if (rejected !== undefined) {
      own.rejected = rejected;
    }
    if (next_action !== undefined) {
      own.next_action = next_action;
    }
    record.said = own;
  }
  if (given.reviewed) {
    record.reviewed = given.reviewed;
  }
  const returned: HandOver = record;
  return returned;
};

const listed = (heading: string, lines: ReadonlyArray<string>) =>
  lines.length === 0 ? [] : [heading, ...Arr.map(lines, (line) => `- ${line}`)];

const short = (sha: string) => (sha === "" ? "none" : pipe(sha, Str.slice(0, 12)));

export const renderHandOver = (record: HandOver, why: string) =>
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
      ...(record.reviewed === undefined
        ? []
        : [
            `They were reviewed at ${short(record.reviewed)}: \`git diff ${record.reviewed}\` is what was done since.`,
          ]),
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

export interface AtDispatch {
  readonly head: string;
  readonly plan: string | null;
  readonly dirty: boolean;
}

const current = (record: HandOver, now: AtDispatch) =>
  record.head === now.head &&
  record.plan === now.plan &&
  (record.uncommitted !== null) === now.dirty;

// WARNING: a record that no longer matches the checkout is rebuilt from host state, else dropped.
export const atDispatch = <E, R>(
  record: HandOver,
  read: Effect.Effect<AtDispatch, E, R>,
  rebuild: Effect.Effect<HandOver, E, R>,
) =>
  Effect.gen(function* () {
    if (current(record, yield* read)) {
      return record;
    }
    const rebuilt = yield* rebuild;
    return current(rebuilt, yield* read) ? rebuilt : null;
  });

export const planRevision = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const files = Arr.sort(yield* fs.readDirectory(dir, { recursive: true }), Str.Order);
    const hasher = new Bun.CryptoHasher("sha256");
    for (const file of files) {
      const at = path.join(dir, file);
      if ((yield* fs.stat(at)).type !== "File") {
        continue;
      }
      hasher.update(`${file}\u0000`);
      hasher.update(yield* fs.readFile(at));
      hasher.update("\u0000");
    }
    return pipe(hasher.digest("hex"), Str.slice(0, 16));
  });
