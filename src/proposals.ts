// A proposal is what the evaluator suggested, written down before anyone can act on it.
//
// Requests execute through this journal. Explicit proposals can also be confirmed later;
// hashes and target versions prevent applying a different or stale payload.
//
// Nothing here runs an action: `confirm` returns the actions that may run, and who runs
// them is `executors.ts` and the front door's business.

import { Data, DateTime, Duration, Effect, Path, Schema } from "effect";
import type { Action, ActionKind } from "./evaluator";
import { ActionSchema } from "./evaluator";
import { appendJournal, readJournal } from "./journal";
import { ensureLockDir, withLock } from "./lock";
import { herdDir } from "./steering";
import { nowIso } from "./time";

/** How long a proposal stands. After this the world has moved and it is re-asked. */
export const EXPIRES_AFTER_MS = 30 * 60 * 1000;

const TargetSchema = Schema.Struct({ run: Schema.String });

const RecordSchema = Schema.Struct({
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

const LineSchema = Schema.Union([RecordSchema, SettledSchema, StepSchema]);
export type ProposalRecord = Schema.Schema.Type<typeof RecordSchema>;
export type ProposalLine = Schema.Schema.Type<typeof LineSchema>;
const LineJson = Schema.fromJsonString(LineSchema);

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

const encodeContent = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({ targets: Schema.Array(TargetSchema), actions: Schema.Array(ActionSchema) }),
  ),
);

export const proposalsPath = Effect.fn("Proposals.path")(function* (
  stateDir: string,
  herdKey: string,
) {
  const path = yield* Path.Path;
  return path.join(yield* herdDir(stateDir, herdKey), "proposals.jsonl");
});

export const append = (file: string, line: ProposalLine) => appendJournal(file, LineJson, line);

export const read = (file: string) => readJournal(file, LineJson);

export class ProposalsBusy extends Data.TaggedError("ProposalsBusy")<{ file: string }> {}

/**
 * The journal's lock, around a whole read-and-append: the check a confirmation makes and
 * the line it writes have to be one act, or two confirmations of one proposal both pass.
 */
function withProposalsLock<A, E, R>(file: string, effect: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    yield* ensureLockDir(file);
    return yield* withLock(`${file}.lock`, Effect.fail(new ProposalsBusy({ file })), effect);
  });
}

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

export const record = Effect.fn("Proposals.record")(function* (file: string, what: Recorded) {
  const at = yield* nowIso();
  const line: ProposalRecord = {
    kind: "proposal",
    id: `p-${Bun.hash(`${at}${what.by}${contentHash(what.targets, what.actions)}`).toString(16)}`,
    content_hash: contentHash(what.targets, what.actions),
    interpretation: what.interpretation,
    targets: [...what.targets],
    actions: [...what.actions],
    allowed_now: [...what.allowedNow],
    created_at: at,
    expires_at: DateTime.formatIso(
      DateTime.addDuration(yield* DateTime.now, Duration.millis(EXPIRES_AFTER_MS)),
    ),
    intent_versions: what.intentVersions,
    by: what.by,
    state: "pending",
  };
  const bound: ProposalRecord = what.card === undefined ? line : { ...line, card: what.card };
  const written: ProposalRecord =
    what.incarnations === undefined ? bound : { ...bound, incarnations: what.incarnations };
  yield* withProposalsLock(file, append(file, written));
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
export interface Actor {
  readonly origin: "cli" | "cli-tty" | "board" | "driver" | "evaluator" | "chat";
  readonly requestId: string;
}

export function isHuman(actor: Actor): boolean {
  return actor.origin === "cli-tty" || actor.origin === "board";
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
    const answered = lines.some(
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
  return unanswered(lines, nowMs).filter((line) => line.targets.length === 0);
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
  return unanswered(lines, nowMs).filter((line) =>
    line.targets.some((target) => target.run === run),
  );
}

/** Proposals nobody has answered and nothing has expired, whatever they are about. */
function unanswered(lines: ReadonlyArray<ProposalLine>, nowMs: number): ProposalRecord[] {
  const answered = new Set(
    lines.flatMap((line) =>
      line.kind === "confirmed" || line.kind === "declined" ? [line.id] : [],
    ),
  );
  return lines.filter(
    (line): line is ProposalRecord =>
      line.kind === "proposal" && !answered.has(line.id) && Date.parse(line.expires_at) > nowMs,
  );
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
  const found = lines.find(
    (line): line is ProposalRecord => line.kind === "proposal" && line.id === id,
  );
  if (!found) return { refused: "not_found", detail: `no proposal "${id}"` };

  const settled = lines.find(
    (line) => (line.kind === "confirmed" || line.kind === "declined") && line.id === id,
  );
  if (settled) return { refused: "not_pending", detail: `"${id}" is already ${settled.kind}` };

  const waiting = unsettled(lines, id);
  if (waiting.length > 0)
    return {
      refused: "reconcile_required",
      detail: `action ${waiting.join(", ")} started and never settled; reconcile it before confirming again`,
    };

  if (Date.parse(found.expires_at) <= nowMs)
    return { refused: "expired", detail: `"${id}" expired at ${found.expires_at}` };
  if (found.content_hash !== hash)
    return {
      refused: "hash_mismatch",
      detail: `"${id}" is ${found.content_hash}, not ${hash}`,
    };
  for (const [run, version] of Object.entries(found.intent_versions)) {
    const now = currentVersions.get(run);
    if (now !== undefined && now !== version)
      return {
        refused: "intent_moved",
        detail: `run ${run} was v${version} when this was proposed and is v${now} now`,
      };
  }
  return { proposal: found, actions: found.actions };
}

export const confirm = Effect.fn("Proposals.confirm")(function* (
  file: string,
  id: string,
  hash: string,
  actor: Actor,
  currentVersions: ReadonlyMap<string, number>,
) {
  const at = yield* nowIso();
  return yield* withProposalsLock(
    file,
    Effect.gen(function* () {
      const judged = judgeConfirmation(
        yield* read(file),
        id,
        hash,
        actor,
        Date.parse(at),
        currentVersions,
      );
      if ("refused" in judged) return judged;
      yield* append(file, { kind: "confirmed", id, at, by: actorName(actor) });
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
  file: string,
  id: string,
  actor: Actor,
) {
  const at = yield* nowIso();
  return yield* withProposalsLock(
    file,
    Effect.gen(function* () {
      const lines = yield* read(file);
      if (!lines.some((line) => line.kind === "proposal" && line.id === id))
        return settledAs("not_found", `no proposal "${id}"`, id);
      // Already answered. Appending a second answer would leave the journal saying a
      // proposal was both confirmed and declined, and the journal is the account.
      const settled = lines.find(
        (line) => (line.kind === "confirmed" || line.kind === "declined") && line.id === id,
      );
      if (settled) return settledAs("not_pending", `"${id}" is already ${settled.kind}`, id);
      yield* append(file, { kind: "declined", id, at, by: actorName(actor) });
      return settledAs(null, "", id);
    }),
  );
});

/** Written before an action runs, so a crash leaves a record that it may have. */
export const stepStarted = Effect.fn("Proposals.stepStarted")(function* (
  file: string,
  proposal: string,
  index: number,
) {
  yield* append(file, {
    kind: "step",
    proposal,
    index,
    state: "started",
    at: yield* nowIso(),
  });
});

export const stepSettled = Effect.fn("Proposals.stepSettled")(function* (
  file: string,
  proposal: string,
  index: number,
  state: "applied" | "failed" | "skipped" | "unknown",
  note?: string,
) {
  const at = yield* nowIso();
  const line: ProposalLine = { kind: "step", proposal, index, state, at };
  yield* append(file, note === undefined ? line : { ...line, note });
});

/**
 * An explicit account of an action whose result is unknown. A timeout never supplies
 * this answer: callers must establish what happened before retrying.
 */
export const reconcileStep = Effect.fn("Proposals.reconcileStep")(function* (
  file: string,
  proposal: string,
  index: number,
  as: "applied" | "not-applied",
  actor: Actor,
) {
  return yield* withProposalsLock(
    file,
    Effect.gen(function* () {
      const lines = yield* read(file);
      if (!lines.some((line) => line.kind === "proposal" && line.id === proposal))
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
        file,
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
  /** Whether a Driver owns it, which `hold` and `deliver` need and `followup` refuses. */
  readonly driverLive: boolean;
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
  "upgrade",
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
  // Resume owns its lifecycle checks, succeeded included; navigation does not change the
  // Run, so a finished one may still be gone to.
  if (
    action.kind !== "followup" &&
    action.kind !== "resume" &&
    action.kind !== "navigate" &&
    terminal
  )
    return `the run is ${ctx.run.status}`;

  if ((action.kind === "hold" || action.kind === "deliver") && !ctx.driverLive)
    return "no Driver owns the run, so there is nothing to carry this out";
  if (action.kind === "answer" && ctx.pendingChoice !== action.choiceId)
    return ctx.pendingChoice === null
      ? "the run is not asking a Choice any more"
      : `the run is asking "${ctx.pendingChoice}" now, not "${action.choiceId}"`;

  if (ctx.proposedIncarnation !== null && ctx.incarnation !== ctx.proposedIncarnation)
    return "the agent this was about is not the one in that pane now";
  if (
    ctx.proposedIntentVersion !== null &&
    ctx.intentVersion !== null &&
    ctx.intentVersion !== ctx.proposedIntentVersion
  )
    return `the Intent was v${ctx.proposedIntentVersion} and is v${ctx.intentVersion}`;
  if (ctx.revision !== null && ctx.revision.card !== ctx.revision.now) return "revision_moved";
  return null;
}
