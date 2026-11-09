// A proposal is what the evaluator suggested, written down before anyone can act on it.
//
// Requests execute through this journal. Explicit proposals can also be confirmed later;
// hashes and target versions prevent applying a different or stale payload.
//
// Nothing here runs an action: `confirm` returns the actions that may run, and who runs
// them is `executors.ts` and the front door's business.

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
  Schema,
  Semaphore,
  flow,
  Result,
} from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import type { Action, ActionKind } from "./actions";
import { ActionSchema } from "./actions";
import type { HumanDoor } from "./steering";
import { nowIso, epochMs } from "./time";

/** How long a proposal stands. After this the world has moved and it is re-asked. */
export const EXPIRES_AFTER_MS = 30 * 60 * 1000;

const TargetSchema = Schema.Struct({ run: Schema.String });

export const RecordSchema = Schema.Struct({
  kind: Schema.Literal("proposal"),
  id: Schema.String,
  /** Canonical JSON of targets and actions: what a confirmation has to name exactly. */
  content_hash: Schema.String,
  interpretation: Schema.String,
  targets: Schema.Array(TargetSchema),
  actions: Schema.Array(ActionSchema),
  /** Which of them the target's own authority already grants, by index. */
  allowed_now: Schema.Array(Schema.Int),
  created_at: Schema.String,
  expires_at: Schema.String,
  /** Each target's Intent version when this was written; a move invalidates it. */
  intent_versions: Schema.Record(Schema.String, Schema.Int),
  /**
   * The card this was asked about, and the tree that card was written against. A yes to
   * something said about one revision is not a yes about a tree that has moved since.
   */
  card: Schema.optionalKey(Schema.Struct({ id: Schema.String, revision: Schema.String })),
  /**
   * The incarnation each named agent was when this was written, by agent name. An agent
   * name and a pane are both inherited by whatever takes that role next, so a delivery
   * confirmed later must not land in a process that never saw what this is about.
   */
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

/**
 * One action's own line, written before it runs and again after. A `started` with no
 * settlement is a crash mid-execution, and the next `confirm` refuses rather than
 * re-running: nobody can say whether that action happened.
 */
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

/**
 * The bytes a confirmation names. Canonical, so the same proposal always hashes the same
 * way and a reordered field is not a different proposal — and so that a changed action
 * always is one.
 */
export function contentHash(
  targets: ReadonlyArray<{ readonly run: string }>,
  actions: ReadonlyArray<Action>,
): string {
  // Encoded through the schema rather than stringified as it arrived: the schema decides
  // the field order, so the same proposal always hashes the same way — and a changed
  // action always hashes differently, which is the half that matters.
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

/** What a write to the proposals invalidates. */
export const PROPOSALS = "collie/proposals";

/**
 * Each Herd's proposals journal, by its Herd key, in the host's database
 * (ADR-draft-collies-own-records-live-in-the-hosts-database).
 */
export interface ProposalsApi {
  readonly lines: (journal: string) => Effect.Effect<ReadonlyArray<ProposalLine>>;
  /** Every line about a proposal that names this Run, in any journal, oldest first. */
  readonly ofRun: (run: string) => Effect.Effect<ReadonlyArray<ProposalLine>>;
  /** Every journal's lines, oldest first. */
  readonly all: Effect.Effect<ReadonlyArray<ProposalLine>>;
  /** The journal a proposal was written to, or null where none has it. */
  readonly journalOf: (id: string) => Effect.Effect<string | null>;
  readonly append: (journal: string, line: ProposalLine) => Effect.Effect<void>;
  /** A read and the append it decides as one act: two confirmations cannot both pass. */
  readonly atomically: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

export class Proposals extends Context.Service<Proposals, ProposalsApi>()("collie/Proposals") {}

const decoded = (rows: ReadonlyArray<{ readonly line: string }>) =>
  Arr.flatMap(rows, (row) => Option.toArray(decodeProposalLineOption(row.line)));

export const proposalsLayer = Layer.effect(Proposals)(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const reactivity = yield* Reactivity.Reactivity;
    // ponytail: one lock for every journal; one per journal if confirmations contend.
    const lock = Semaphore.makeUnsafe(1);
    return {
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
        sql`INSERT INTO collie_proposals (journal, line) VALUES (${journal}, ${encodeLine(line)})`.pipe(
          Effect.andThen(reactivity.invalidate([PROPOSALS])),
          Effect.orDie,
        ),
      atomically: lock.withPermits(1),
    } satisfies ProposalsApi;
  }),
);

export const proposalsOf = (run: string) => Proposals.use((proposals) => proposals.ofRun(run));

/** Every Herd's proposals, oldest first. */
export const everyProposal = Proposals.use((proposals) => proposals.all);

/** The Herd journal this proposal was written to, or null where no Herd has one by that id. */
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
  /** Indices the validator marked as already granted to Collie by the target Run. */
  readonly allowedNow: ReadonlyArray<number>;
  readonly intentVersions: Record<string, number>;
  /** The card the human pointed at, with the revision it was written against. */
  readonly card?: { readonly id: string; readonly revision: string };
  /** Which live process each named agent was, by agent name. */
  readonly incarnations?: Record<string, string>;
  /** `evaluator:<call id>` or `chat:<request id>` — never a human: a proposal is not a decision. */
  readonly by: string;
}

export const record = Effect.fn("Proposals.record")(function* (journal: string, what: Recorded) {
  const now = yield* DateTime.now;
  const at = DateTime.formatIso(now);
  const line: ProposalRecord = {
    kind: "proposal",
    id: `p-${Bun.hash(`${at}${what.by}${contentHash(what.targets, what.actions)}`).toString(16)}`,
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

/**
 * Who is asking. Never a string a caller supplies: the front door derives it — a terminal
 * or the board — and stamps its own request id.
 *
 * `chat` is native chat's bridge, and it is stamped by the entrypoint that serves the
 * tools rather than worked out from anything about the process. That matters here more
 * than anywhere else: the bridge runs as a child of a harness inside a pane, so it
 * inherits a controlling terminal, and the `cli-tty` heuristic would read a model as a
 * person. Attribution is recorded, not used to require a second approval: what the human
 * asked for in chat is carried out as theirs, and what Collie wants of its own accord is
 * a proposal because of where it came from, never because of who confirms it.
 */
export interface Actor extends Voice {
  readonly origin: FrontDoor;
  readonly requestId: string;
  readonly from?: Where | undefined;
}

/** Where a chat acted, and what the human said that turn: attached by the tool host, never the model. */
export interface Voice {
  readonly conversation?: string;
  readonly said?: string;
  /** The names of the files the human's message carried. */
  readonly attachments?: ReadonlyArray<string>;
}

/** Who asks, as a channel declares it: a front door and, for a chat, its voice. */
export type Asker = Omit<Actor, "requestId">;

/** Just the voice of anything that carries one, with no key for what it lacks. */
export function voiceOf({ conversation, said, attachments }: Voice): Voice {
  let voice: Voice = {};
  if (conversation !== undefined) voice = { ...voice, conversation };
  if (said !== undefined) voice = { ...voice, said };
  if (attachments !== undefined && attachments.length > 0) voice = { ...voice, attachments };
  return voice;
}

export function isHuman(actor: Pick<Actor, "origin">): boolean {
  return actor.origin === "cli-tty" || actor.origin === "board" || actor.origin === "desktop";
}

/** A door a human types into, or chat carrying the human's own words of that turn. */
export const speaksForHuman = (actor: Asker): boolean =>
  isHuman(actor) || (actor.origin === "chat" && actor.said !== undefined);

/** Who a Delivery of a human's words came from, as its ledger keeps it; null for anyone else's. */
export function humanOf(actor: Asker | undefined): HumanDoor | null {
  if (actor === undefined || !speaksForHuman(actor)) return null;
  return actor.conversation === undefined
    ? { origin: actor.origin }
    : { origin: actor.origin, conversation: actor.conversation };
}

export function actorName(actor: Actor): string {
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

/**
 * The actions of this proposal that started and that nothing has settled — the ones
 * nobody can say the fate of. A confirmation refuses while one stands, and a reconcile
 * is only allowed to answer one of these: settling an index that never ran would write a
 * human's word about something that did not happen.
 */
function unsettled(lines: ReadonlyArray<ProposalLine>, id: string): number[] {
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

/**
 * Proposals about the installation rather than about any Run — an upgrade, a cleanup, a
 * fork, a change to a workspace's defaults. They name no Run, so they carry no targets,
 * and a board that only asked `pendingFor` would let them expire unseen at the one front
 * door that is meant to confirm them.
 */
export function pendingHerdWide(
  lines: ReadonlyArray<ProposalLine>,
  nowMs: number,
): ProposalRecord[] {
  return Arr.filter(unanswered(lines, nowMs), (line) => line.targets.length === 0);
}

/**
 * Proposals about this Run that a human has neither answered nor let expire. What makes
 * a card `decision` rather than something to read: somebody is being waited on.
 */
export function pendingFor(
  lines: ReadonlyArray<ProposalLine>,
  run: string,
  nowMs: number,
): ProposalRecord[] {
  return Arr.filter(unanswered(lines, nowMs), (line) =>
    Arr.some(line.targets, (target) => target.run === run),
  );
}

/**
 * The last answer of `unanswered`, by the journal it read: a board asks once for every Run
 * against one journal and one clock, and each answer parses every proposal's expiry.
 */
const lastUnanswered = new WeakMap<
  ReadonlyArray<ProposalLine>,
  { readonly nowMs: number; readonly records: ReadonlyArray<ProposalRecord> }
>();

/** Proposals nobody has answered and nothing has expired, whatever they are about. */
function unanswered(
  lines: ReadonlyArray<ProposalLine>,
  nowMs: number,
): ReadonlyArray<ProposalRecord> {
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

/**
 * Whether these actions may run, and which. Every refusal is a different fact and is
 * named as one, because "no" without a reason is a thing a human cannot act on.
 *
 * Pure: it is given the journal and answers about it. Writing the confirmation is the
 * caller's, under the lock, so that the check and the write are one act.
 */
export function judgeConfirmation(
  lines: ReadonlyArray<ProposalLine>,
  id: string,
  hash: string,
  _actor: Actor,
  nowMs: number,
  currentVersions: ReadonlyMap<string, number>,
): Confirmed | { readonly refused: ConfirmRefusal; readonly detail: string } {
  const found = Option.getOrUndefined(
    Arr.findFirst(
      lines,
      (line): line is ProposalRecord => line.kind === "proposal" && line.id === id,
    ),
  );
  if (!found) return { refused: "not_found", detail: `no proposal "${id}"` };

  const settled = Option.getOrUndefined(
    Arr.findFirst(
      lines,
      (line) => (line.kind === "confirmed" || line.kind === "declined") && line.id === id,
    ),
  );
  if (settled) return { refused: "not_pending", detail: `"${id}" is already ${settled.kind}` };

  const waiting = unsettled(lines, id);
  if (waiting.length > 0)
    return {
      refused: "reconcile_required",
      detail: `action ${Arr.join(
        Arr.map(waiting, (part) =>
          part === null || part === undefined ? "" : globalThis.String(part),
        ),
        ", ",
      )} started and never settled; reconcile it before confirming again`,
    };

  if (epochMs(found.expires_at) <= nowMs)
    return { refused: "expired", detail: `"${id}" expired at ${found.expires_at}` };
  if (found.content_hash !== hash)
    return {
      refused: "hash_mismatch",
      detail: `"${id}" is ${found.content_hash}, not ${hash}`,
    };
  for (const [run, version] of Rec.toEntries(found.intent_versions)) {
    const now = currentVersions.get(run);
    if (now !== undefined && now !== version)
      return {
        refused: "intent_moved",
        detail: `run ${run}'s Intent is v${now}, not v${version}`,
      };
  }
  return { proposal: found, actions: found.actions };
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

/**
 * A refusal, or nothing refused. One shape rather than a union: every caller has to say
 * which refusal it hit, and a union of two object types with different keys is one a
 * reader has to narrow before they can print the reason.
 */
export interface Settled {
  readonly refused: ConfirmRefusal | null;
  readonly detail: string;
  readonly id: string;
}

function settledAs(refused: ConfirmRefusal | null, detail: string, id: string): Settled {
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
      // Already answered. Appending a second answer would leave the journal saying a
      // proposal was both confirmed and declined, and the journal is the account.
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

/** The yes or no this request already gave, so a retried answer is the one answer. */
export function answeredBy(
  lines: ReadonlyArray<ProposalLine>,
  request: string,
): { readonly kind: "confirmed" | "declined"; readonly id: string } | undefined {
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

/**
 * What each action of a confirmed proposal came to, as its journal last says. One that
 * started and never settled is `unknown`; one never reached is `skipped` as `not_run`,
 * except after the `ask_human` a carry-out stops at.
 */
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

/** Written before an action runs, so a crash leaves a record that it may have. */
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

/**
 * An explicit account of an action whose result is unknown. A timeout never supplies
 * this answer: callers must establish what happened before retrying.
 */
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
      // Only a `started` nobody answered. Anything else and this would be recording a
      // human's word about an action that never ran, in the journal that is the record
      // of what did.
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

// ---------------------------------------------------------------------------
// Admission
// ---------------------------------------------------------------------------

export interface AdmissionContext {
  /** The target Run as it is now, or null where it is gone. */
  readonly run: { readonly id: string; readonly status: string } | null;
  /** The Choice the Run is asking, if any. */
  readonly pendingChoice: string | null;
  /** The target agent's incarnation now, where the action names an agent. */
  readonly incarnation: string | null;
  /** What the proposal recorded that incarnation as. */
  readonly proposedIncarnation: string | null;
  readonly intentVersion: number | null;
  readonly proposedIntentVersion: number | null;
  /** For a card-bound proposal: the card's revision, and the worktree's now. */
  readonly revision: { readonly card: string; readonly now: string } | null;
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["succeeded", "failed", "stopped"]);

/** Kinds that are about the installation or a definition, and so about no Run. */
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

/**
 * The last check, immediately before an action runs: everything the proposal assumed,
 * asked again. Time passes between a human reading a proposal and confirming it, and an
 * action that was right then can be wrong now.
 */
export function admit(action: Action, ctx: AdmissionContext): string | null {
  if (NOT_ABOUT_A_RUN.has(action.kind)) return null;
  if (!ctx.run) return "the run is gone";

  const terminal = TERMINAL_STATUSES.has(ctx.run.status);
  if (action.kind === "followup" && !terminal)
    return "a follow-up is a child of a finished run, and this one is still going";
  // A finished Run's live agents still take steering (ADR-0041); only what needs a step
  // left to run is refused, with what to do instead.
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
