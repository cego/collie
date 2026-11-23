// WARNING: nothing here runs an action: confirm returns the actions that may run, and their executors run them.
import { StoreWrites } from "./store-writes";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import type { FrontDoor, Where } from "./board-model";
import {
  Context,
  DateTime,
  Duration,
  Effect,
  Layer,
  Random,
  Schema,
  Semaphore,
  flow,
  Result,
} from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import type { Action, ActionKind } from "./actions";
import { ActionSchema } from "./actions";
import { nowIso, epochMs } from "./time";

export const EXPIRES_AFTER_MS = 30 * 60 * 1000;

const TargetSchema = Schema.Struct({ run: Schema.String });

export const RecordSchema = Schema.Struct({
  kind: Schema.Literal("proposal"),
  id: Schema.String,
  content_hash: Schema.String,
  interpretation: Schema.String,
  targets: Schema.Array(TargetSchema),
  actions: Schema.Array(ActionSchema),
  allowed_now: Schema.Array(Schema.Int),
  created_at: Schema.String,
  expires_at: Schema.String,
  intent_versions: Schema.Record(Schema.String, Schema.Int),
  // WARNING: a yes about one revision is not a yes once the tree has moved.
  card: Schema.optionalKey(Schema.Struct({ id: Schema.String, revision: Schema.String })),
  // WARNING: a role's name and pane pass to its next occupant, so a delivery must not reach a process that never saw the proposal.
  incarnations: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  by: Schema.String,
  state: Schema.Literal("pending"),
});

const SettledSchema = Schema.Struct({
  kind: Schema.Literals(["confirmed", "declined"]),
  id: Schema.String,
  at: Schema.String,
  by: Schema.String,
  conversation: Schema.optionalKey(Schema.String),
  said: Schema.optionalKey(Schema.String),
  attachments: Schema.optionalKey(Schema.Array(Schema.String)),
});

// WARNING: a started line with no settlement is a crash mid-action: confirm refuses rather than rerunning.
const StepSchema = Schema.Struct({
  kind: Schema.Literal("step"),
  proposal: Schema.String,
  index: Schema.Int,
  state: Schema.Literals(["started", "applied", "failed", "skipped", "unknown"]),
  at: Schema.String,
  note: Schema.optionalKey(Schema.String),
});

export const LineSchema = Schema.Union([RecordSchema, SettledSchema, StepSchema]);
export type ProposalRecord = Schema.Schema.Type<typeof RecordSchema>;
export type ProposalLine = Schema.Schema.Type<typeof LineSchema>;
const LineJson = Schema.fromJsonString(LineSchema);
export const decodeProposalLineOption = Schema.decodeOption(LineJson);
const encodeLine = flow(Schema.encodeResult(LineJson), Result.getOrThrow);

// WARNING: canonical, so a reordered field is the same proposal, but any changed action always hashes differently.
export function contentHash(
  targets: ReadonlyArray<{ readonly run: string }>,
  actions: ReadonlyArray<Action>,
) {
  return Bun.hash(encodeContent({ targets: [...targets], actions: [...actions] })).toString(16);
}

const encodeContent = flow(
  Schema.encodeResult(
    Schema.fromJsonString(
      Schema.Struct({ targets: Schema.Array(TargetSchema), actions: Schema.Array(ActionSchema) }),
    ),
  ),
  Result.getOrThrow,
);

export const PROPOSALS = "collie/proposals";

export interface ProposalsApi {
  readonly lines: (journal: string) => Effect.Effect<ReadonlyArray<ProposalLine>>;
  readonly ofRun: (run: string) => Effect.Effect<ReadonlyArray<ProposalLine>>;
  readonly all: Effect.Effect<ReadonlyArray<ProposalLine>>;
  readonly journalOf: (id: string) => Effect.Effect<string | null>;
  readonly append: (journal: string, line: ProposalLine) => Effect.Effect<void>;
  // WARNING: the read and the append are one act, so two confirmations cannot both pass.
  readonly atomically: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

export class Proposals extends Context.Service<Proposals, ProposalsApi>()("collie/Proposals") {}

const decoded = (rows: ReadonlyArray<{ readonly line: string }>) =>
  Arr.flatMap(rows, (row) => Option.toArray(decodeProposalLineOption(row.line)));

export const proposalsLayer = Layer.effect(Proposals)(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const reactivity = yield* Reactivity.Reactivity;
    const told = Option.getOrUndefined(yield* Effect.serviceOption(StoreWrites));
    const lock = Semaphore.makeUnsafe(1);
    const returned: ProposalsApi = {
      lines: (journal) =>
        sql<{ readonly line: string }>`
          SELECT line FROM collie_proposals WHERE journal = ${journal} ORDER BY seq
        `.pipe(Effect.map(decoded), Effect.orDie),
      ofRun: (run) =>
        sql<{ readonly line: string }>`
          SELECT line FROM collie_proposals WHERE proposal IN (
            SELECT proposal FROM collie_proposal_runs WHERE run = ${run}
          ) ORDER BY seq
        `.pipe(Effect.map(decoded), Effect.orDie),
      all: sql<{ readonly line: string }>`SELECT line FROM collie_proposals ORDER BY seq`.pipe(
        Effect.map(decoded),
        Effect.orDie,
      ),
      journalOf: (id) =>
        sql<{ readonly journal: string }>`
          SELECT journal FROM collie_proposals WHERE proposal = ${id} AND kind = 'proposal' LIMIT 1
        `.pipe(
          Effect.map((rows) => rows[0]?.journal ?? null),
          Effect.orDie,
        ),
      append: (journal, line) =>
        Effect.gen(function* () {
          yield* sql`INSERT INTO collie_proposals (journal, line) VALUES (${journal}, ${encodeLine(line)})`;
          const runs = yield* sql<{ readonly run: string }>`
            SELECT run FROM collie_proposal_runs WHERE proposal = (
              SELECT proposal FROM collie_proposals WHERE seq = last_insert_rowid()
            )
          `;
          told?.(Arr.map(runs, (row) => row.run));
          yield* reactivity.invalidate([PROPOSALS]);
        }).pipe(Effect.orDie),
      atomically: lock.withPermits(1),
    };
    return returned;
  }),
);

export const proposalsOf = (run: string) => Proposals.use((proposals) => proposals.ofRun(run));

export const everyProposal = Proposals.use((proposals) => proposals.all);

export const journalOf = (id: string) => Proposals.use((proposals) => proposals.journalOf(id));

export const append = (journal: string, line: ProposalLine) =>
  Proposals.use((proposals) => proposals.append(journal, line));

export const read = (journal: string) => Proposals.use((proposals) => proposals.lines(journal));

const atomically = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Proposals.use((proposals) => proposals.atomically(effect));

export interface Recorded {
  readonly interpretation: string;
  readonly targets: ReadonlyArray<{ readonly run: string }>;
  readonly actions: ReadonlyArray<Action>;
  readonly allowedNow: ReadonlyArray<number>;
  readonly intentVersions: Record<string, number>;
  readonly card?: { readonly id: string; readonly revision: string };
  readonly incarnations?: Record<string, string>;
  readonly by: string;
}

export const record = Effect.fn("Proposals.record")(function* (journal: string, what: Recorded) {
  const now = yield* DateTime.now;
  const at = DateTime.formatIso(now);
  // WARNING: the clock alone does not tell two identical proposals apart.
  const nonce = yield* Random.nextInt;
  const line: ProposalRecord = {
    kind: "proposal",
    id: `p-${Bun.hash(`${at}${nonce}${what.by}${contentHash(what.targets, what.actions)}`).toString(16)}`,
    content_hash: contentHash(what.targets, what.actions),
    interpretation: what.interpretation,
    targets: [...what.targets],
    actions: [...what.actions],
    allowed_now: [...what.allowedNow],
    created_at: at,
    expires_at: DateTime.formatIso(DateTime.addDuration(now, Duration.millis(EXPIRES_AFTER_MS))),
    intent_versions: what.intentVersions,
    by: what.by,
    state: "pending",
  };
  const bound: ProposalRecord = what.card === undefined ? line : { ...line, card: what.card };
  const written: ProposalRecord =
    what.incarnations === undefined ? bound : { ...bound, incarnations: what.incarnations };
  yield* atomically(append(journal, written));
  return written;
});

// WARNING: chat is stamped by its entrypoint: the bridge inherits a terminal, so a tty check would read a model as a person.
export interface Actor extends Voice {
  readonly origin: FrontDoor;
  readonly requestId: string;
  readonly from?: Where | undefined;
}

export interface Voice {
  readonly conversation?: string;
  readonly said?: string;
  readonly attachments?: ReadonlyArray<string>;
}

export type Asker = Omit<Actor, "requestId">;

export function voiceOf({ conversation, said, attachments }: Voice) {
  let voice: Voice = {};
  if (conversation !== undefined) voice = { ...voice, conversation };
  if (said !== undefined) voice = { ...voice, said };
  if (attachments !== undefined && attachments.length > 0) voice = { ...voice, attachments };
  return voice;
}

export function isHuman(actor: Pick<Actor, "origin">) {
  return actor.origin === "cli-tty" || actor.origin === "board" || actor.origin === "desktop";
}

export const speaksForHuman = (actor: Asker) =>
  isHuman(actor) || (actor.origin === "chat" && actor.said !== undefined);

export function humanOf(actor: Asker | undefined) {
  if (actor === undefined || !speaksForHuman(actor)) return null;
  return actor.conversation === undefined
    ? { origin: actor.origin }
    : { origin: actor.origin, conversation: actor.conversation };
}

export function actorName(actor: Actor) {
  return `${isHuman(actor) ? "human" : actor.origin}:${actor.requestId}`;
}

export type ConfirmRefusal =
  | "not_found"
  | "not_pending"
  | "expired"
  | "hash_mismatch"
  | "intent_moved"
  | "reconcile_required";

export interface Confirmed {
  readonly proposal: ProposalRecord;
  readonly actions: ReadonlyArray<Action>;
}

// WARNING: reconcile may answer only an unsettled start: settling one that never ran records a human's word about nothing.
function unsettled(lines: ReadonlyArray<ProposalLine>, id: string) {
  const indices: number[] = [];
  for (const line of lines) {
    if (line.kind !== "step" || line.proposal !== id || line.state !== "started") continue;
    const answered = Arr.some(
      lines,
      (other) =>
        other.kind === "step" &&
        other.proposal === id &&
        other.index === line.index &&
        other.state !== "started",
    );
    if (!answered && !indices.includes(line.index)) indices.push(line.index);
  }
  return indices;
}

// WARNING: names no Run, so pendingFor would let these expire unseen.
export function pendingHerdWide(lines: ReadonlyArray<ProposalLine>, nowMs: number) {
  return Arr.filter(unanswered(lines, nowMs), (line) => line.targets.length === 0);
}

export function pendingFor(lines: ReadonlyArray<ProposalLine>, run: string, nowMs: number) {
  return Arr.filter(unanswered(lines, nowMs), (line) =>
    Arr.some(line.targets, (target) => target.run === run),
  );
}

const lastUnanswered = new WeakMap<
  ReadonlyArray<ProposalLine>,
  { readonly nowMs: number; readonly records: ReadonlyArray<ProposalRecord> }
>();

function unanswered(lines: ReadonlyArray<ProposalLine>, nowMs: number) {
  const kept = lastUnanswered.get(lines);
  if (kept?.nowMs === nowMs) return kept.records;
  const answered = new Set(
    Arr.flatMap(lines, (line) =>
      line.kind === "confirmed" || line.kind === "declined" ? [line.id] : [],
    ),
  );
  const records = Arr.filter(
    lines,
    (line): line is ProposalRecord =>
      line.kind === "proposal" && !answered.has(line.id) && epochMs(line.expires_at) > nowMs,
  );
  lastUnanswered.set(lines, { nowMs, records });
  return records;
}

// WARNING: pure: the caller writes under the lock, so the check and the write are one act.
export function judgeConfirmation(
  lines: ReadonlyArray<ProposalLine>,
  id: string,
  hash: string,
  _actor: Actor,
  nowMs: number,
  currentVersions: ReadonlyMap<string, number>,
) {
  const found = Option.getOrUndefined(
    Arr.findFirst(
      lines,
      (line): line is ProposalRecord => line.kind === "proposal" && line.id === id,
    ),
  );
  if (!found) {
    const returned: Confirmed | { readonly refused: ConfirmRefusal; readonly detail: string } = {
      refused: "not_found",
      detail: `no proposal "${id}"`,
    };
    return returned;
  }

  const settled = Option.getOrUndefined(
    Arr.findFirst(
      lines,
      (line) => (line.kind === "confirmed" || line.kind === "declined") && line.id === id,
    ),
  );
  if (settled) {
    const returned: Confirmed | { readonly refused: ConfirmRefusal; readonly detail: string } = {
      refused: "not_pending",
      detail: `"${id}" is already ${settled.kind}`,
    };
    return returned;
  }

  const waiting = unsettled(lines, id);
  if (waiting.length > 0) {
    const returned: Confirmed | { readonly refused: ConfirmRefusal; readonly detail: string } = {
      refused: "reconcile_required",
      detail: `action ${Arr.join(
        Arr.map(waiting, (part) =>
          part === null || part === undefined ? "" : globalThis.String(part),
        ),
        ", ",
      )} started and never settled; reconcile it before confirming again`,
    };
    return returned;
  }

  if (epochMs(found.expires_at) <= nowMs) {
    const returned: Confirmed | { readonly refused: ConfirmRefusal; readonly detail: string } = {
      refused: "expired",
      detail: `"${id}" expired at ${found.expires_at}`,
    };
    return returned;
  }
  if (found.content_hash !== hash) {
    const returned: Confirmed | { readonly refused: ConfirmRefusal; readonly detail: string } = {
      refused: "hash_mismatch",
      detail: `"${id}" is ${found.content_hash}, not ${hash}`,
    };
    return returned;
  }
  for (const [run, version] of Rec.toEntries(found.intent_versions)) {
    const now = currentVersions.get(run);
    if (now !== undefined && now !== version) {
      const returned: Confirmed | { readonly refused: ConfirmRefusal; readonly detail: string } = {
        refused: "intent_moved",
        detail: `run ${run}'s Intent is v${now}, not v${version}`,
      };
      return returned;
    }
  }
  const returned: Confirmed | { readonly refused: ConfirmRefusal; readonly detail: string } = {
    proposal: found,
    actions: found.actions,
  };
  return returned;
}

export const confirm = Effect.fn("Proposals.confirm")(function* (
  journal: string,
  id: string,
  hash: string,
  actor: Actor,
  currentVersions: ReadonlyMap<string, number>,
) {
  const at = yield* nowIso;
  return yield* atomically(
    Effect.gen(function* () {
      const judged = judgeConfirmation(
        yield* read(journal),
        id,
        hash,
        actor,
        epochMs(at),
        currentVersions,
      );
      if ("refused" in judged) return judged;
      yield* append(journal, {
        kind: "confirmed",
        id,
        at,
        by: actorName(actor),
        ...voiceOf(actor),
      });
      return judged;
    }),
  );
});

export interface Settled {
  readonly refused: ConfirmRefusal | null;
  readonly detail: string;
  readonly id: string;
}

function settledAs(refused: ConfirmRefusal | null, detail: string, id: string) {
  return { refused, detail, id };
}

export const decline = Effect.fn("Proposals.decline")(function* (
  journal: string,
  id: string,
  actor: Actor,
) {
  const at = yield* nowIso;
  return yield* atomically(
    Effect.gen(function* () {
      const lines = yield* read(journal);
      if (!Arr.some(lines, (line) => line.kind === "proposal" && line.id === id))
        return settledAs("not_found", `no proposal "${id}"`, id);
      // WARNING: a second answer would leave the journal saying both confirmed and declined.
      const settled = Option.getOrUndefined(
        Arr.findFirst(
          lines,
          (line) => (line.kind === "confirmed" || line.kind === "declined") && line.id === id,
        ),
      );
      if (settled) return settledAs("not_pending", `"${id}" is already ${settled.kind}`, id);
      yield* append(journal, { kind: "declined", id, at, by: actorName(actor), ...voiceOf(actor) });
      return settledAs(null, "", id);
    }),
  );
});

export function answeredBy(lines: ReadonlyArray<ProposalLine>, request: string) {
  return Option.getOrUndefined(
    Arr.findFirst(
      lines,
      (line): line is Schema.Schema.Type<typeof SettledSchema> =>
        (line.kind === "confirmed" || line.kind === "declined") &&
        pipe(
          line.by,
          Str.slice(Option.getOrElse(pipe(line.by, Str.indexOf(":")), () => -1) + 1),
        ) === request,
    ),
  );
}

// WARNING: an action never reached is skipped as not_run, except after the ask_human a carry-out stops at.
export function stepResults(lines: ReadonlyArray<ProposalLine>, id: string) {
  const proposal = Option.getOrUndefined(
    Arr.findFirst(
      lines,
      (line): line is ProposalRecord => line.kind === "proposal" && line.id === id,
    ),
  );
  const last = new Map<number, Schema.Schema.Type<typeof StepSchema>>();
  for (const line of lines)
    if (line.kind === "step" && line.proposal === id) last.set(line.index, line);
  const results = [];
  for (const [index, action] of (proposal?.actions ?? []).entries()) {
    const step = last.get(index);
    const asked = results.at(-1)?.kind === "ask_human";
    if (step === undefined && asked) break;
    const [state, note] =
      step === undefined
        ? (["skipped", "not_run"] as const)
        : step.state === "started"
          ? (["unknown", "started and never settled, so it may have run"] as const)
          : ([step.state, step.note ?? ""] as const);
    results.push({
      index,
      kind: action.kind,
      state,
      note,
      run: "run" in action ? action.run : null,
    });
  }
  return results;
}

export const stepStarted = Effect.fn("Proposals.stepStarted")(function* (
  journal: string,
  proposal: string,
  index: number,
) {
  yield* append(journal, {
    kind: "step",
    proposal,
    index,
    state: "started",
    at: yield* nowIso,
  });
});

export const stepSettled = Effect.fn("Proposals.stepSettled")(function* (
  journal: string,
  proposal: string,
  index: number,
  state: "applied" | "failed" | "skipped" | "unknown",
  note?: string,
) {
  const at = yield* nowIso;
  const line: ProposalLine = { kind: "step", proposal, index, state, at };
  yield* append(journal, note === undefined ? line : { ...line, note });
});

// WARNING: a timeout never counts as an answer: callers establish what happened before retrying.
export const reconcileStep = Effect.fn("Proposals.reconcileStep")(function* (
  journal: string,
  proposal: string,
  index: number,
  as: "applied" | "not-applied",
  actor: Actor,
) {
  return yield* atomically(
    Effect.gen(function* () {
      const lines = yield* read(journal);
      if (!Arr.some(lines, (line) => line.kind === "proposal" && line.id === proposal))
        return settledAs("not_found", `no proposal "${proposal}"`, proposal);
      if (!unsettled(lines, proposal).includes(index))
        return settledAs(
          "not_pending",
          `action ${index} of "${proposal}" is not waiting to be reconciled`,
          proposal,
        );
      yield* stepSettled(
        journal,
        proposal,
        index,
        as === "applied" ? "applied" : "skipped",
        `reconciled as ${as} by ${actorName(actor)}`,
      );
      return settledAs(null, "", proposal);
    }),
  );
});

export interface AdmissionContext {
  readonly run: { readonly id: string; readonly status: string } | null;
  readonly pendingChoice: string | null;
  readonly incarnation: string | null;
  readonly proposedIncarnation: string | null;
  readonly intentVersion: number | null;
  readonly proposedIntentVersion: number | null;
  readonly revision: { readonly card: string; readonly now: string } | null;
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["succeeded", "failed", "stopped"]);

const NOT_ABOUT_A_RUN: ReadonlySet<ActionKind> = new Set([
  "ask_human",
  "none",
  "start",
  "update_defaults",
  "fork_definition",
  "home_cleanup",
  "cleanup",
  "schedule_add",
  "schedule_pause",
  "schedule_resume",
  "schedule_remove",
  "upgrade",
  "onboard",
]);

// WARNING: re-asks everything the proposal assumed: time passes between reading a proposal and confirming it.
export function admit(action: Action, ctx: AdmissionContext) {
  if (NOT_ABOUT_A_RUN.has(action.kind)) return null;
  if (!ctx.run) return "the run is gone";

  const terminal = TERMINAL_STATUSES.has(ctx.run.status);
  if (action.kind === "followup" && !terminal)
    return "a follow-up is a child of a finished run, and this one is still going";
  // WARNING: a finished Run's live agents still take steering; only actions needing a step to run are refused.
  if (terminal && (action.kind === "hold" || action.kind === "release"))
    return "a finished Run has no step left to hold; stop closes its agents";
  if (terminal && action.kind === "set_verification")
    return "its checks were collected when it finished; remember_verification keeps them for the next Run";

  if (action.kind === "hold" && action.until !== undefined)
    return "nothing lifts a hold at a time: hold it, and release it when it should go on";
  if (action.kind === "answer" && ctx.pendingChoice !== action.choiceId)
    return ctx.pendingChoice === null
      ? "the run is not asking a Choice"
      : `the run is asking "${ctx.pendingChoice}" now, not "${action.choiceId}"`;

  if (ctx.proposedIncarnation !== null && ctx.incarnation !== ctx.proposedIncarnation)
    return "the agent this was about is not the one in that pane now";
  if (
    ctx.proposedIntentVersion !== null &&
    ctx.intentVersion !== null &&
    ctx.intentVersion !== ctx.proposedIntentVersion
  )
    return `the Intent is v${ctx.intentVersion}, not v${ctx.proposedIntentVersion}`;
  if (ctx.revision !== null && ctx.revision.card !== ctx.revision.now) return "revision_moved";
  return null;
}
