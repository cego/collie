// The two append-only journals steering keeps: what was sent to each live agent, and
// what the model calls for a Herd have cost. Both are read by deriving state from the
// lines, never by rewriting them — a ledger whose past can be edited cannot answer
// "was this already sent" after a crash, which is the only question it exists for.
//
// This module is the only writer of `deliveries.jsonl` and `budget.jsonl` — the second a
// record of every model call and what it cost, never a permission to make one.

import { Data, Effect, FileSystem, Path, Schema } from "effect";
import { appendJournal, readJournal, readJournalWhole } from "./journal";
import { ensureLockDir, withLock } from "./lock";
import { nowIso } from "./time";

/** What a delivery is about. The work, not the words. */
const CauseSchema = Schema.Struct({
  kind: Schema.Literals([
    "step",
    "repair",
    "nudge",
    "handoff",
    "compaction",
    "steer",
    "correction",
    "followup",
  ]),
  ref: Schema.String,
});
export type Cause = Schema.Schema.Type<typeof CauseSchema>;

/**
 * Where a delivery has got to. `submitted` says herdr took it, which is not the same as
 * the agent having read it; `acknowledged` needs the agent's own ack file; `verified`
 * needs an independent check. They are separate states because they are separate facts,
 * and a system that collapsed them would report work as done on the strength of a send.
 *
 * `unknown` is the honest state for a crash between reserving and submitting: nobody can
 * say whether herdr got it. It blocks the same work from being sent again until a human
 * reconciles it, and Collie never retries out of it on its own.
 */
const DELIVERY_STATES = [
  "reserved",
  "submitted",
  "acknowledged",
  "verified",
  "failed",
  "unknown",
  "superseded",
  "expired",
] as const;

/** States nothing follows: a causal key with one of these is free for a new delivery. */
const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "verified",
  "failed",
  "superseded",
  "expired",
]);

const DeliverySchema = Schema.Struct({
  id: Schema.String,
  at: Schema.String,
  run: Schema.String,
  incarnation: Schema.String,
  agent: Schema.String,
  causal_key: Schema.String,
  request_id: Schema.String,
  cause: CauseSchema,
  mode: Schema.Literals(["boundary", "now", "interrupt"]),
  text_hash: Schema.String,
  intent_version: Schema.Int,
  attempt: Schema.Int,
  state: Schema.Literals(DELIVERY_STATES),
  evidence: Schema.optionalKey(Schema.Struct({ kind: Schema.String, ref: Schema.String })),
  note: Schema.optionalKey(Schema.String),
});
export type Delivery = Schema.Schema.Type<typeof DeliverySchema>;

/**
 * An incarnation someone typed into directly, and the human clearing that. Not delivery
 * states: they are about the agent, not about one message, and automatic corrections to
 * an incarnation under override stop until the override is explicitly cleared.
 */
const OverrideSchema = Schema.Struct({
  kind: Schema.Literals(["manual_override", "override_cleared"]),
  at: Schema.String,
  incarnation: Schema.String,
  by: Schema.String,
  note: Schema.optionalKey(Schema.String),
});
export type Override = Schema.Schema.Type<typeof OverrideSchema>;

export type LedgerLine = Delivery | Override;
const LedgerLineSchema = Schema.Union([OverrideSchema, DeliverySchema]);
const LedgerLineJson = Schema.fromJsonString(LedgerLineSchema);

function isDelivery(line: LedgerLine): line is Delivery {
  return "state" in line;
}

/** A short stable digest for a key or a body. Not a security property; a name. */
function digest(value: string): string {
  return Bun.hash(value).toString(16);
}

export function textHash(text: string): string {
  return digest(text);
}

/**
 * What this delivery is *about*: the run, the cause and the Intent it was composed
 * against. Deliberately not the text — a nudge and a re-sent prompt can be the same
 * words about different work, and two corrections for one constraint are the same work
 * in different words. What must not happen twice is the work.
 */
export function causalKey(run: string, cause: Cause, intentVersion: number): string {
  return digest(`${run}\u0000${cause.kind}\u0000${cause.ref}\u0000${intentVersion}`);
}

const LEDGER_FILE = "deliveries.jsonl";

/** The directory an incarnation's ledger lives in, keyed by herdr's own identity. */
export function incarnationKey(terminalId: string): string {
  return digest(terminalId);
}

export const ledgerPath = Effect.fn("Steering.ledgerPath")(function* (
  stateDir: string,
  incarnation: string,
) {
  const path = yield* Path.Path;
  return path.join(stateDir, "agents", incarnationKey(incarnation), LEDGER_FILE);
});

/**
 * Every incarnation's ledger this state dir has. An acknowledgement names only its
 * delivery, so finding which agent it belongs to means looking; the alternative is a
 * second index of what the journals already say.
 */
export const ledgerFiles = Effect.fn("Steering.ledgerFiles")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(stateDir, "agents");
  const names = yield* fs.readDirectory(root).pipe(Effect.catch(() => Effect.succeed([])));
  return names.map((name) => path.join(root, name, LEDGER_FILE));
});

/**
 * The ledger's lock, held around a whole send so two Drivers cannot both find a causal
 * key free and both reserve it.
 */
export function withLedgerLock<A, E, R>(file: string, effect: Effect.Effect<A, E, R>) {
  return withLock(`${file}.lock`, Effect.fail(new LedgerBusy({ file })), effect);
}

export class LedgerBusy extends Data.TaggedError("LedgerBusy")<{ file: string }> {}

export const appendLine = (file: string, line: LedgerLine) =>
  appendJournal(file, LedgerLineJson, line);

/**
 * Every line, oldest first. A half-written last line is skipped rather than failing the
 * read: an append interrupted mid-write is exactly the crash this journal exists to
 * survive, and refusing to read it would leave the crash unrecoverable.
 */
export const readLedger = (file: string) => readJournal(file, LedgerLineJson);

/**
 * The ledger with its corruption counted. A delivery line that cannot be read is a
 * delivery whose state nobody knows, and §7.3's rule is that such a thing blocks the work
 * it was about until a human settles it — so the one caller that decides whether to send
 * reads it this way and refuses rather than sending into a gap.
 */
export const readLedgerWhole = (file: string) => readJournalWhole(file, LedgerLineJson);

/** The newest line for each delivery id, which is that delivery's current state. */
export function newestById(lines: ReadonlyArray<LedgerLine>): Map<string, Delivery> {
  const newest = new Map<string, Delivery>();
  for (const line of lines) if (isDelivery(line)) newest.set(line.id, line);
  return newest;
}

/**
 * Every delivery about this Run, newest state each, across every incarnation it has had.
 * Every ledger and not the live agents': an incarnation that exited after a reservation
 * went `unknown` still has the entry blocking that causal key.
 */
export const deliveriesOf = Effect.fn("Steering.deliveriesOf")(function* (
  stateDir: string,
  run: string,
) {
  const found: Array<{ file: string; delivery: Delivery }> = [];
  for (const file of yield* ledgerFiles(stateDir))
    for (const delivery of newestById(yield* readLedger(file)).values())
      if (delivery.run === run) found.push({ file, delivery });
  return found;
});

/**
 * The delivery, if any, that stops new work with this causal key going out: one still in
 * flight, or one nobody can say the fate of. An `unknown` blocks until a human says what
 * happened, which appends `superseded` — so it stops blocking by being answered, never
 * by timing out into a guess.
 */
export function blocked(lines: ReadonlyArray<LedgerLine>, causal_key: string): Delivery | null {
  let found: Delivery | null = null;
  for (const delivery of newestById(lines).values()) {
    if (delivery.causal_key !== causal_key) continue;
    if (TERMINAL_STATES.has(delivery.state)) continue;
    if (found === null || delivery.at > found.at) found = delivery;
  }
  return found;
}

/**
 * The lines that settle reservations nobody came back for. A crash after `reserved` and
 * one after herdr returned but before `submitted` was written look identical from here,
 * so both settle to `unknown` — the state that asks a human — rather than to a guess in
 * either direction.
 */
export function settleStaleReservations(
  lines: ReadonlyArray<LedgerLine>,
  nowMs: number,
  submitTimeoutMs: number,
  at: string,
): Delivery[] {
  const settled: Delivery[] = [];
  for (const delivery of newestById(lines).values()) {
    if (delivery.state !== "reserved") continue;
    const reservedAt = Date.parse(delivery.at);
    if (Number.isNaN(reservedAt) || nowMs - reservedAt < submitTimeoutMs) continue;
    settled.push({
      ...delivery,
      at,
      state: "unknown",
      note: "reserved and never settled (crash or lost result)",
    });
  }
  return settled;
}

/** Whether this incarnation is under manual override: the last word on it wins. */
export function overrideActive(lines: ReadonlyArray<LedgerLine>): boolean {
  let active = false;
  for (const line of lines) {
    if (isDelivery(line)) continue;
    active = line.kind === "manual_override";
  }
  return active;
}

/**
 * A human's answer to an `unknown`: whether the text reached the agent or not. Only a
 * human may give it — a process that could reconcile its own `unknown` would be a
 * process that retries, which is exactly what the state exists to prevent.
 */
export function reconcile(
  lines: ReadonlyArray<LedgerLine>,
  id: string,
  as: "sent" | "not-sent",
  by: string,
  at: string,
): Delivery | { readonly error: string } {
  if (!by.startsWith("human:")) return { error: "only a human may reconcile a delivery" };
  const delivery = newestById(lines).get(id);
  if (!delivery) return { error: `no delivery "${id}" in this ledger` };
  if (delivery.state !== "unknown") return { error: `delivery "${id}" is ${delivery.state}` };
  return {
    ...delivery,
    at,
    state: "superseded",
    note: `reconciled as ${as} by ${by}`,
  };
}

// ---------------------------------------------------------------------------
// The Herd's budget
// ---------------------------------------------------------------------------

/** herdr is not reachable, so there is no Herd to key anything by. Never a cwd. */
export class HerdrUnreachable extends Data.TaggedError("HerdrUnreachable")<{ why: string }> {}

/**
 * The Herd: one herdr session, named by the canonical path of its socket. Everything
 * shared across the workspaces of one session — the conversation, proposals, the budget,
 * elections — is filed under this. A cwd would key two sessions in one repository to the
 * same Herd and one session across two repositories to different ones.
 */
export const herdKey = Effect.fn("Steering.herdKey")(function* <R>(
  socketPath: string | null,
  fromStatus: () => Effect.Effect<string | null, never, R>,
) {
  const socket = socketPath ?? (yield* fromStatus());
  if (socket === null || socket === "")
    return yield* Effect.fail(new HerdrUnreachable({ why: "no socket path" }));
  const fs = yield* FileSystem.FileSystem;
  const real = yield* fs.realPath(socket).pipe(Effect.catch(() => Effect.succeed(socket)));
  return digest(real);
});

/**
 * The Herd of a plugin invocation. A Collie that was not started by herdr has no Herd and
 * is told so, rather than being given a second-best one: the fallback that a cwd or a
 * status probe would supply is exactly the thing that keys two sessions to one Herd.
 */
export const herdOf = (socketPath: string | null) =>
  herdKey(socketPath, () => Effect.succeed(null));

export const herdDir = Effect.fn("Steering.herdDir")(function* (stateDir: string, key: string) {
  const path = yield* Path.Path;
  return path.join(stateDir, "herd", key);
});

const BudgetSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("reserve"),
    id: Schema.String,
    /** The Run this call is about, or null for one about the whole Herd. */
    run: Schema.NullOr(Schema.String),
    at: Schema.String,
    /** Read from records written before spending caps were dropped; never written now. */
    max_usd: Schema.optionalKey(Schema.Number),
    max_seconds: Schema.Number,
    max_output_bytes: Schema.Number,
  }),
  Schema.Struct({
    kind: Schema.Literal("settle"),
    id: Schema.String,
    at: Schema.String,
    outcome: Schema.Literals(["ok", "failed", "timeout", "over_output", "killed"]),
    usd: Schema.optionalKey(Schema.Number),
    seconds: Schema.Number,
    bytes: Schema.Number,
  }),
]);
export type BudgetLine = Schema.Schema.Type<typeof BudgetSchema>;
const BudgetJson = Schema.fromJsonString(BudgetSchema);
const encodeBudget = Schema.encodeSync(BudgetJson);

export const budgetPath = Effect.fn("Steering.budgetPath")(function* (
  stateDir: string,
  key: string,
) {
  const path = yield* Path.Path;
  return path.join(yield* herdDir(stateDir, key), "budget.jsonl");
});

export const readBudget = (file: string) => readJournal(file, BudgetJson);

/** The execution bounds a call is made under, written down beside it. */
export interface CallLimits {
  readonly maxSeconds: number;
  readonly maxOutputBytes: number;
}

/**
 * Reservations nobody settled, as synthetic failures. A call that took the model down
 * with it still happened and still counts; leaving it unsettled would make the record
 * say fewer calls were made than were.
 */
function staleSettlements(
  lines: ReadonlyArray<BudgetLine>,
  nowMs: number,
  at: string,
): BudgetLine[] {
  const settled = new Set(lines.flatMap((l) => (l.kind === "settle" ? [l.id] : [])));
  return lines.flatMap((line): BudgetLine[] => {
    if (line.kind !== "reserve" || settled.has(line.id)) return [];
    const startedAt = Date.parse(line.at);
    if (Number.isNaN(startedAt) || nowMs - startedAt < 2 * line.max_seconds * 1000) return [];
    return [{ kind: "settle", id: line.id, at, outcome: "failed", seconds: 0, bytes: 0 }];
  });
}

/**
 * The lines that record one more model call starting: the stale settlements it is time
 * to write, and the reservation itself. Nothing here refuses a call. The user's decision
 * is that usage is data — counted, costed, shown — and never a quota that blocks or
 * throttles their work; what bounds a call is its own clock and output cap, not a tally.
 */
export function planReservation(
  lines: ReadonlyArray<BudgetLine>,
  request: { readonly id: string; readonly run: string | null; readonly at: string },
  limits: CallLimits,
) {
  const nowMs = Date.parse(request.at);
  const stale = staleSettlements(lines, nowMs, request.at);
  const reserve: BudgetLine = {
    kind: "reserve",
    id: request.id,
    run: request.run,
    at: request.at,
    max_seconds: limits.maxSeconds,
    max_output_bytes: limits.maxOutputBytes,
  };
  return { append: [...stale, reserve] };
}

export const appendBudget = Effect.fn("Steering.appendBudget")(function* (
  file: string,
  lines: ReadonlyArray<BudgetLine>,
) {
  if (lines.length === 0) return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  const body = lines.map((line) => encodeBudget(line)).join("\n");
  yield* fs.writeFileString(file, `${body}\n`, { flag: "a" });
});

/**
 * One model call's record, written before the call is made. Under the ledger lock where
 * it can be had; a busy lock appends anyway, because a record that a call happened must
 * not be what stops the call from happening. Never fails and never refuses.
 */
export const reserve = Effect.fn("Steering.reserve")(function* (
  file: string,
  request: { readonly id: string; readonly run: string | null },
  limits: CallLimits,
) {
  const at = yield* nowIso();
  yield* ensureLockDir(file);
  const write = Effect.gen(function* () {
    const planned = planReservation(yield* readBudget(file), { ...request, at }, limits);
    yield* appendBudget(file, planned.append);
  });
  yield* withLock(`${file}.lock`, write, write);
  return request.id;
});

export const settle = Effect.fn("Steering.settle")(function* (
  file: string,
  id: string,
  actual: {
    readonly outcome: "ok" | "failed" | "timeout" | "over_output" | "killed";
    /** What the CLI said the call cost, where it said. Telemetry; nothing decides on it. */
    readonly usd?: number | undefined;
    readonly seconds: number;
    readonly bytes: number;
  },
) {
  const at = yield* nowIso();
  const line: Extract<BudgetLine, { kind: "settle" }> = {
    kind: "settle",
    id,
    at,
    outcome: actual.outcome,
    seconds: actual.seconds,
    bytes: actual.bytes,
  };
  yield* appendBudget(file, [actual.usd === undefined ? line : { ...line, usd: actual.usd }]);
});
