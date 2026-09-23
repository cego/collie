// The one place text reaches an agent. Six callers used to send independently, so a
// hand-off and a nudge could land in one pane in either order with neither knowing. One
// arbiter holding the agent's ledger lock while it sends buys what no single sender
// could: a record written *before* herdr is called, and one answer to "is something
// already in the air about this work".

import type { BunServices } from "@effect/platform-bun/BunServices";
import { Clock, Data, Duration, Effect, FileSystem, Path, Result, Schema } from "effect";
import { ensureLockDir } from "./lock";
import { herdrFailureReason, type AgentInfo, type Herdr, type Submission } from "./herdr";
import { verifyIncarnation, type AgentEntry } from "./registry";
import {
  appendLine,
  blocked,
  causalKey,
  deferralsOf,
  ledgerFiles,
  ledgerPath,
  newestById,
  readLedger,
  readLedgerWhole,
  settleStaleReservations,
  textHash,
  withLedgerLock,
  type Cause,
  type Delivery,
} from "./steering";
import { gate, interruptKeys } from "./steering-caps";
import { nowIso, took } from "./time";

/** How long a message may sit `reserved` before a later reader calls it `unknown`. */
export const SUBMIT_TIMEOUT_MS = 60_000;

/** How stale the agent listing a transaction holds may be before a send re-reads it. */
const LISTING_MAX_AGE_MS = 5_000;

/** A resource limit, not a style rule: one send is one message, not a transcript. */
export const MAX_DELIVERY_BYTES = 8 * 1024;

export interface DeliveryDraft {
  readonly run: string;
  /** Which harness is in that pane, so `now` and `interrupt` can be gated on it. */
  readonly harness?: string;
  readonly cause: Cause;
  readonly mode: "boundary" | "now" | "interrupt";
  readonly intentVersion: number;
  readonly attempt: number;
  readonly requestId: string;
  readonly note?: string;
  /**
   * How long a refusal herdr calls momentary may hold before this sender gives up, from
   * the first one. Absent, it is not waited out: the refusal fails the delivery at once.
   */
  readonly patienceMs?: number;
}

/**
 * Refusals that name a pane condition which clears by itself. By herdr's code, never its
 * prose: a message is for people and can change under a release that keeps the code.
 */
const TRANSIENT_REFUSALS: ReadonlySet<string> = new Set(["agent_blocked"]);

type Refusal =
  | "blocked"
  | "incarnation_changed"
  | "failed"
  | "unknown"
  | "too_long"
  | "deferred"
  | "exhausted";

/**
 * What became of one send. Never a throw: every one of these is a fact the caller has to
 * record, and an exception would lose the delivery id the ledger line was written under.
 */
export type SubmitOutcome =
  | {
      readonly ok: true;
      readonly id: string;
      /**
       * What herdr saw of the submission: a turn starting, or nothing it can vouch for.
       * Absent from a channel that was not asked — a test double, a scripted reply.
       */
      readonly submission?: Submission;
    }
  | {
      readonly ok: false;
      readonly id: string | null;
      /**
       * `deferred`: herdr said the pane cannot take it yet, and nothing was delivered.
       * `exhausted`: that stayed true for the draft's whole patience.
       */
      readonly reason: Refusal;
      readonly detail: string;
    };

export interface Channel {
  /** The incarnation this channel is bound to, so a caller can label what it sends. */
  readonly agent: string;
  submit(
    text: string,
    draft: DeliveryDraft,
  ): Effect.Effect<SubmitOutcome, never, FileSystem.FileSystem | Path.Path | BunServices>;
}

export interface DispatcherDeps {
  readonly stateDir: string;
  readonly herdr: Pick<Herdr, "agentPrompt" | "agentList" | "agentSendKeys" | "restoreAgentName">;
  /** The Run's audit trail, so a refusal is explained where the Run is read. */
  readonly log: (
    line: string,
  ) => Effect.Effect<void, never, FileSystem.FileSystem | Path.Path | BunServices>;
}

/** Nothing was sent, and the caller is told which of its own rules stopped it. */
export class NotDeliverable extends Data.TaggedError("NotDeliverable")<{
  agent: string;
  reason: string;
}> {}

/**
 * A programming error, not a runtime one: two transactions for one incarnation deadlock
 * on the ledger lock, and a channel used after its transaction closed sends outside the
 * lock that made it safe.
 */
class DispatcherDefect extends Data.TaggedError("DispatcherDefect")<{ why: string }> {}

const open = new Set<string>();

/**
 * The order several due messages go out in for one incarnation. An interrupt is the
 * human saying "now", so it outranks everything; a compaction is the least urgent thing
 * there is and only happens with nothing else in flight.
 */
const ORDER = {
  correction: 1,
  steer: 2,
  step: 3,
  repair: 4,
  followup: 5,
  handoff: 6,
  nudge: 7,
  compaction: 8,
} satisfies Record<Cause["kind"], number>;

const MODE_ORDER = { interrupt: 0, now: 1, boundary: 2 } satisfies Record<Delivery["mode"], number>;

// Last, rather than `undefined` in the arithmetic: these are read off the inbox, whose
// decode types both as plain strings, and a comparison against NaN leaves the whole list
// in whatever order it arrived in.
const LAST = Number.MAX_SAFE_INTEGER;
// SAFETY: the index is checked by `?? LAST` — a kind or mode these tables do not name
// reads as absent and sorts last, which is the point of the lookup.
const causeRank = (kind: string) => ORDER[kind as Cause["kind"]] ?? LAST;
// SAFETY: as above; an unknown mode is ordered last rather than compared as NaN.
const modeRank = (mode: string) => MODE_ORDER[mode as Delivery["mode"]] ?? LAST;

/** Due messages, worst-waited first. Exported because ordering is a rule, not a detail. */
export function dispatchOrder<
  T extends { readonly mode: string; readonly cause: { readonly kind: string } },
>(due: ReadonlyArray<T>): T[] {
  return [...due].sort(
    (a, b) =>
      modeRank(a.mode) - modeRank(b.mode) || causeRank(a.cause.kind) - causeRank(b.cause.kind),
  );
}

/**
 * Everything one caller wants to send to one live agent, under that agent's ledger lock.
 *
 * The incarnation is revalidated before anything is sent: an agent name and a pane are
 * both inherited by whatever takes that role next, so "the agent that was registered" and
 * "whatever is in that pane now" are different questions.
 */
export const transaction = Effect.fn("Dispatcher.transaction")(function* <A, E, R>(
  deps: DispatcherDeps,
  entry: AgentEntry,
  body: (channel: Channel) => Effect.Effect<A, E, R>,
) {
  const terminalId = entry.incarnation?.terminalId;
  if (terminalId === undefined)
    return yield* new NotDeliverable({ agent: entry.agent, reason: "no_incarnation" });
  if (open.has(terminalId))
    return yield* new DispatcherDefect({
      why: `a transaction for ${entry.agent} is already open in this process`,
    });

  const file = yield* ledgerPath(deps.stateDir, terminalId);
  yield* ensureLockDir(file);
  open.add(terminalId);
  return yield* withLedgerLock(
    file,
    Effect.gen(function* () {
      let listing = yield* agentsNow(deps, entry);
      let listedAt = yield* Clock.currentTimeMillis;

      const identified = verifyIncarnation(entry, listing);
      if (!identified.ok) {
        yield* settlePending(file, identified.reason);
        return yield* new NotDeliverable({ agent: entry.agent, reason: identified.reason });
      }

      let closed = false;
      const channel: Channel = {
        agent: entry.agent,
        submit: (text, draft) =>
          Effect.gen(function* () {
            if (closed)
              return yield* new DispatcherDefect({
                why: `${entry.agent}'s channel was used after its transaction closed`,
              });
            if (Buffer.byteLength(text, "utf8") > MAX_DELIVERY_BYTES)
              return refuse(null, "too_long", `over ${MAX_DELIVERY_BYTES} bytes`);
            // Fail closed before anything is reserved: a mode this harness has not been
            // shown to take would produce a delivery nobody can say the fate of.
            const ungated = yield* gate(draft.harness ?? "", draft.mode).pipe(
              Effect.as(null),
              Effect.catch((cause) => Effect.succeed(cause)),
            );
            if (ungated) {
              yield* recordUngated(file, entry, terminalId, text, draft, ungated.reason);
              return refuse(null, "failed", ungated.reason);
            }
            // The listing was read when the transaction opened, and a whole compaction
            // can happen inside one. Anything older than a few seconds is re-read before
            // it is trusted with a send.
            if ((yield* Clock.currentTimeMillis) - listedAt > LISTING_MAX_AGE_MS) {
              listing = yield* agentsNow(deps, entry);
              listedAt = yield* Clock.currentTimeMillis;
              const again = verifyIncarnation(entry, listing);
              if (!again.ok) {
                yield* settlePending(file, again.reason);
                return refuse(null, "incarnation_changed", again.reason);
              }
            }
            return yield* send(deps, file, entry, terminalId, text, draft);
          }).pipe(Effect.orDie),
      };

      // Closed however the body ends: the lock goes back at the same moment, so a channel
      // a failed body kept hold of would be a sender with nothing serialising it.
      const result = yield* body(channel).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            closed = true;
          }),
        ),
      );
      return result;
    }),
  ).pipe(Effect.ensuring(Effect.sync(() => open.delete(terminalId))));
});

function refuse(id: string | null, reason: Refusal, detail: string): SubmitOutcome {
  return { ok: false, id, reason, detail };
}

/** Recover a missing name only with an existing binding, then revalidate the fresh list. */
const agentsNow = Effect.fn("Dispatcher.agentsNow")(function* (
  deps: DispatcherDeps,
  entry?: AgentEntry,
) {
  const read = () =>
    deps.herdr.agentList().pipe(Effect.catch(() => Effect.succeed<AgentInfo[]>([])));
  let listing = yield* read();
  if (
    entry?.incarnation &&
    !listing.some((agent) => agent.name === entry.agent) &&
    (yield* deps.herdr.restoreAgentName(entry).pipe(Effect.catch(() => Effect.succeed(false))))
  ) {
    listing = yield* read();
  }
  return listing;
});

/**
 * One message: reserved, sent, settled. The reservation is appended **before** herdr is
 * called and is never removed — a crash in the window between them is exactly the case
 * this record exists for, and a later reader settles it `unknown` rather than guessing.
 */
/**
 * One delivery line. Every state of a delivery is this line again with its own `at` and
 * `state`, because each of those is the same fact recorded a second time.
 */
function deliveryOf(
  entry: AgentEntry,
  terminalId: string,
  text: string,
  draft: DeliveryDraft,
  at: string,
  state: Delivery["state"],
): Delivery {
  return {
    id: `${draft.requestId}-${draft.attempt}`,
    at,
    run: draft.run,
    incarnation: terminalId,
    agent: entry.agent,
    causal_key: causalKey(draft.run, draft.cause, draft.intentVersion),
    request_id: draft.requestId,
    cause: draft.cause,
    mode: draft.mode,
    text_hash: textHash(text),
    intent_version: draft.intentVersion,
    attempt: draft.attempt,
    state,
  };
}

const send = Effect.fn("Dispatcher.send")(function* (
  deps: DispatcherDeps,
  file: string,
  entry: AgentEntry,
  terminalId: string,
  text: string,
  draft: DeliveryDraft,
) {
  const at = yield* nowIso();
  const lines = yield* readLedger(file);
  const now = yield* Clock.currentTimeMillis;
  for (const stale of settleStaleReservations(lines, now, SUBMIT_TIMEOUT_MS, at))
    yield* appendLine(file, stale);

  const key = causalKey(draft.run, draft.cause, draft.intentVersion);
  const ledger = yield* readLedgerWhole(file);
  // A line nobody can read is a delivery nobody can account for, which is what `unknown`
  // means and why it blocks: sending again could be the second copy of this work.
  if (ledger.corrupt > 0) {
    yield* deps.log(
      `not sent to ${entry.agent}: ${ledger.corrupt} unreadable line(s) in its ledger`,
    );
    return refuse(null, "blocked", `${file} has ${ledger.corrupt} unreadable line(s)`);
  }
  const line = deliveryOf(entry, terminalId, text, draft, at, "reserved");
  const id = line.id;
  const inFlight = blocked(ledger.lines, key, id);
  if (inFlight) {
    yield* deps.log(
      `not sent to ${entry.agent}: ${inFlight.state} delivery ${inFlight.id} is already about this work`,
    );
    return refuse(null, "blocked", `${inFlight.id} is ${inFlight.state}`);
  }
  const reserved: Delivery = draft.note === undefined ? line : { ...line, note: draft.note };
  yield* appendLine(file, reserved);

  const sent = yield* deps.herdr.agentPrompt(entry.agent, text).pipe(Effect.result);
  const settledAt = yield* nowIso();
  if (Result.isSuccess(sent)) {
    // `submitted` either way: the text and the Enter were written. What herdr could not
    // vouch for is kept as the note, never rounded up to a delivery it saw taken.
    const line = { ...reserved, at: settledAt, state: "submitted" as const };
    yield* appendLine(file, sent.success === "unobserved" ? { ...line, note: "unobserved" } : line);
    return { ok: true as const, id, submission: sent.success };
  }
  // A refusal herdr answered with is a fact; a transport that never answered is not.
  const why = herdrFailureReason(sent.failure);
  if (sent.failure.answered !== true) {
    // Nobody can say whether it arrived, and Collie never retries out of that on its own.
    yield* appendLine(file, { ...reserved, at: settledAt, state: "unknown", note: why });
    return refuse(id, "unknown", why);
  }
  const code = sent.failure.code;
  const coded = code === undefined ? reserved : { ...reserved, code };
  if (code === undefined || !TRANSIENT_REFUSALS.has(code) || draft.patienceMs === undefined) {
    yield* appendLine(file, { ...coded, at: settledAt, state: "failed", note: why });
    return refuse(id, "failed", why);
  }
  // Measured from the ledger rather than this process, so a sender that comes back after
  // a restart is held to the same deadline rather than a fresh one.
  const before = deferralsOf(ledger.lines, id);
  const attempts = before.count + 1;
  const held =
    before.since === null ? 0 : (yield* Clock.currentTimeMillis) - Date.parse(before.since);
  if (held < draft.patienceMs) {
    if (attempts === 1)
      yield* deps.log(`${entry.agent} cannot take a prompt yet (${code}); retrying`);
    yield* appendLine(file, { ...coded, at: settledAt, state: "deferred", note: why });
    return refuse(id, "deferred", `${code}, attempt ${attempts}`);
  }
  const gaveUp = `${code} held for ${took(held)} over ${attempts} attempts`;
  yield* deps.log(`not sent to ${entry.agent}: ${gaveUp}; gave up`);
  yield* appendLine(file, { ...coded, at: settledAt, state: "failed", note: gaveUp });
  return refuse(id, "exhausted", gaveUp);
});

/** How soon, how often and for how long a pane that refuses for a moment is tried again. */
export interface Patience {
  readonly firstMs: number;
  readonly maxMs: number;
  /** From the first refusal. */
  readonly forMs: number;
}

export const PATIENCE: Patience = { firstMs: 2_000, maxMs: 30_000, forMs: 10 * 60_000 };

/**
 * One delivery, tried again while herdr says the pane will clear by itself. Each try is a
 * transaction of its own, so nothing waits holding the agent's ledger lock, and the
 * incarnation is proven again before every send.
 */
export const submitPatiently = Effect.fn("Dispatcher.submitPatiently")(function* (
  deps: DispatcherDeps,
  entry: AgentEntry,
  text: string,
  draft: DeliveryDraft,
  patience: Patience = PATIENCE,
) {
  const patient = { ...draft, patienceMs: patience.forMs };
  for (let wait = patience.firstMs; ; wait = Math.min(wait * 2, patience.maxMs)) {
    const outcome = yield* transaction(deps, entry, (channel) => channel.submit(text, patient));
    if (outcome.ok || outcome.reason !== "deferred") return outcome;
    yield* Effect.sleep(Duration.millis(wait));
  }
});

/**
 * The step prompt's work has been collected — the agent went quiet and its Output was
 * read — so the delivery that carried it is over. Settled `superseded` with that as the
 * note, because nothing in it is left to acknowledge or verify: what the agent did is now
 * in the Run, and a later prompt about the same step — a human's `run resume` re-running
 * a disputed fix at the same iteration, to the same live implementer — is a new attempt
 * at that work, not a second copy of this one. Without this line the causal key would
 * read it as exactly that and refuse it.
 *
 * Only a delivery whose arrival is known: one herdr saw a turn start from, or one the
 * agent acknowledged. A `submitted` line noted `unobserved` stays in flight — an Output
 * turning up beside it does not say the prompt was read, and making that work retryable
 * is how it runs twice. It is settled by an ack, or by a human's `reconcile`.
 */
export const settleCollected = Effect.fn("Dispatcher.settleCollected")(function* (
  stateDir: string,
  terminalId: string,
  causal_key: string,
) {
  const file = yield* ledgerPath(stateDir, terminalId);
  yield* withLedgerLock(
    file,
    Effect.gen(function* () {
      const at = yield* nowIso();
      for (const delivery of newestById(yield* readLedger(file)).values()) {
        if (delivery.causal_key !== causal_key) continue;
        const known =
          delivery.state === "acknowledged" ||
          (delivery.state === "submitted" && delivery.note !== "unobserved");
        if (!known) continue;
        yield* appendLine(file, { ...delivery, at, state: "superseded", note: "work_collected" });
      }
    }),
  );
});

/**
 * Every reservation, and every delivery waiting on its pane, for an incarnation that is no
 * longer the one addressed, settled `failed`. Nothing was sent for them and nothing ever
 * will be: the process they were reserved against is gone.
 */
const settlePending = Effect.fn("Dispatcher.settlePending")(function* (file: string, why: string) {
  const at = yield* nowIso();
  for (const delivery of newestById(yield* readLedger(file)).values()) {
    if (delivery.state !== "reserved" && delivery.state !== "deferred") continue;
    yield* appendLine(file, { ...delivery, at, state: "failed", note: why });
  }
});

/** Where an agent writes what it understood, for one delivery. */
export function ackPath(runDir: string, deliveryId: string): string {
  return `${runDir}/steering/acks/${deliveryId}.json`;
}

/**
 * The ack the agent is asked for, in the words every delivery uses, and the token that
 * marks the text as Collie's. The token is on its own first line so a harness hook that
 * only sees the submitted prompt can tell a Collie delivery from a human typing.
 */
export function ackInstruction(
  runDir: string,
  delivery: { readonly id: string; readonly intentVersion: number; readonly attempt: number },
): string {
  return [
    `${DELIVERY_TOKEN}${delivery.id}`,
    `When you have read this, write \`${ackPath(runDir, delivery.id)}\` containing`,
    `{"delivery":"${delivery.id}","intent_version":${delivery.intentVersion},"attempt":${delivery.attempt},"understood":"<one sentence>"}`,
    "before continuing.",
  ].join("\n");
}

/** What marks a prompt as Collie's own. Its absence is what attribution is looking for. */
export const DELIVERY_TOKEN = "collie-delivery:";

const AckSchema = Schema.Struct({
  delivery: Schema.String,
  intent_version: Schema.Int,
  attempt: Schema.Int,
  understood: Schema.String,
});
const AckJson = Schema.fromJsonString(AckSchema);

/**
 * Acknowledgements the agents have written since anyone last looked, turned into ledger
 * lines. An ack for a version or an attempt other than the one that was sent is recorded
 * as a mismatch and changes nothing: it is the agent answering a different question.
 *
 * The file is removed only once its line is written, so a crash in between leaves the
 * ack to be read again rather than lost.
 */
export const readAcks = Effect.fn("Dispatcher.readAcks")(function* (
  stateDir: string,
  runDir: string,
  log: (
    line: string,
  ) => Effect.Effect<void, never, FileSystem.FileSystem | Path.Path | BunServices>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(runDir, "steering", "acks");
  const names = yield* fs.readDirectory(dir).pipe(Effect.catch(() => Effect.succeed([])));
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    const raw = yield* fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")));
    const decoded = Schema.decodeUnknownOption(AckJson)(raw);
    if (decoded._tag === "None") {
      yield* log(`ack ${name} could not be read`);
      continue;
    }
    const ack = decoded.value;
    // Removed only once the ledger has taken it; null says it has not, so the ack stays
    // to be read again — which is why an agent writes a file rather than a message.
    const settled = yield* settleAck(stateDir, ack, file);
    if (settled === null) continue;
    yield* log(settled);
    yield* fs.remove(file, { force: true }).pipe(Effect.ignore);
  }
});

/** What an ack may advance. Everything else is settled, and settled is somebody's answer. */
const AWAITING_ACK: ReadonlySet<string> = new Set(["reserved", "submitted"]);

const settleAck = Effect.fn("Dispatcher.settleAck")(function* (
  stateDir: string,
  ack: Schema.Schema.Type<typeof AckSchema>,
  file: string,
): Effect.fn.Return<string | null, never, FileSystem.FileSystem | Path.Path | BunServices> {
  // The ledger is per incarnation and an ack names only its delivery, so the delivery is
  // found by looking for it: an ack is rare and the ledgers are small.
  for (const ledger of yield* ledgerFiles(stateDir)) {
    if (!newestById(yield* readLedger(ledger)).has(ack.delivery)) continue;
    return yield* withLedgerLock(
      ledger,
      Effect.gen(function* () {
        // Read again under the lock: between finding the delivery and writing about it, a
        // Dispatcher transaction can have settled the very state this ack is about.
        const delivery = newestById(yield* readLedger(ledger)).get(ack.delivery);
        if (!delivery) return `ack for ${ack.delivery}, which no ledger has`;
        const at = yield* nowIso();
        if (!AWAITING_ACK.has(delivery.state)) {
          yield* appendLine(ledger, { ...delivery, at, note: `ack_after_${delivery.state}` });
          return `ack for ${ack.delivery} arrived after it was ${delivery.state}; nothing changed`;
        }
        if (delivery.intent_version !== ack.intent_version || delivery.attempt !== ack.attempt) {
          yield* appendLine(ledger, { ...delivery, at, note: "ack_mismatch" });
          return `ack for ${ack.delivery} is about v${ack.intent_version} attempt ${ack.attempt}, not v${delivery.intent_version} attempt ${delivery.attempt}`;
        }
        yield* appendLine(ledger, {
          ...delivery,
          at,
          state: "acknowledged",
          evidence: { kind: "ack", ref: file },
        });
        return `${ack.delivery} acknowledged`;
      }),
    ).pipe(Effect.catch(() => Effect.succeed(null)));
  }
  return `ack for ${ack.delivery}, which no ledger has`;
});

/** The `## Steering` section a boundary delivery is composed into. */
export function steeringSection(
  runDir: string,
  items: ReadonlyArray<{
    readonly id: string;
    readonly text: string;
    readonly intentVersion: number;
    readonly attempt: number;
  }>,
) {
  if (items.length === 0) return "";
  const body = items
    .map(
      (item) =>
        `- (${item.id}) ${item.text}\n\n${ackInstruction(runDir, {
          id: item.id,
          intentVersion: item.intentVersion,
          attempt: item.attempt,
        })}`,
    )
    .join("\n\n");
  return `## Steering\n\n${body}\n\n`;
}

/**
 * The entry for an agent this process has just started or is already working with,
 * built from what herdr says about it now. The register only holds group heads, and a
 * fan-out step's other variants are just as much live agents — so the identity is read
 * where it can be read rather than a whole variant being undeliverable for want of a
 * register row.
 *
 * The two ways this can come back empty are told apart, because they mean different
 * things to whoever is waiting: an agent herdr no longer has is over, and one herdr has
 * without a `terminal_id` is a release too old to address.
 */
export const entryFromLive = Effect.fn("Dispatcher.entryFromLive")(function* (
  deps: DispatcherDeps,
  about: {
    readonly role: string;
    readonly agent: string;
    readonly paneId: string | null;
    readonly workspaceId: string | null;
    readonly runId: string;
    readonly workflow: string;
  },
) {
  const live = (yield* agentsNow(deps)).find((a) => a.name === about.agent);
  if (!live) return { entry: null, reason: `${about.agent} is gone — herdr no longer has it` };
  if (!live.terminalId)
    return {
      entry: null,
      reason: `${about.agent} cannot be addressed: herdr does not name its process`,
    };
  const entry: AgentEntry = {
    role: about.role,
    agent: about.agent,
    paneId: about.paneId ?? live.paneId,
    workspaceId: about.workspaceId,
    runId: about.runId,
    workflow: about.workflow,
    at: yield* nowIso(),
    incarnation: { terminalId: live.terminalId, agentSession: live.agentSession },
  };
  return { entry, reason: null };
});

/**
 * A delivery refused by the capability gate, recorded rather than dropped. Nothing was
 * sent, so it never gets a `reserved` line — but a human asking "what happened to my
 * steer" has to find an answer somewhere, and the ledger is where they look.
 */
const recordUngated = Effect.fn("Dispatcher.recordUngated")(function* (
  file: string,
  entry: AgentEntry,
  terminalId: string,
  text: string,
  draft: DeliveryDraft,
  why: string,
) {
  const at = yield* nowIso();
  yield* appendLine(file, {
    ...deliveryOf(entry, terminalId, text, draft, at, "failed"),
    note: why,
  });
});

/**
 * The interrupt: keys first, then the text. herdr answering says the keys were sent, and
 * a status that has left `working` says the harness reacted to something — neither is
 * proof it stopped, and no such proof exists at this boundary. So the states are
 * `interrupt_requested` and, once the agent's own ack arrives, `interrupt_acknowledged`.
 * The word this deliberately never uses is the one a reader would most like: stopped.
 */
export const interrupt = Effect.fn("Dispatcher.interrupt")(function* (
  deps: DispatcherDeps & {
    readonly status: (agent: string) => Effect.Effect<string, never, BunServices>;
  },
  channel: Channel,
  entry: AgentEntry,
  text: string,
  draft: DeliveryDraft,
  waitMs = INTERRUPT_WAIT_MS,
) {
  // Before the keys: `channel.submit` below gates the text as a `now`, which is a
  // different permission and too late to un-press a key.
  const ungated = yield* gate(draft.harness ?? "", "interrupt").pipe(
    Effect.as(null),
    Effect.catch((cause) => Effect.succeed(cause)),
  );
  if (ungated) return refuse(null, "failed", ungated.reason);
  const keys = interruptKeys(draft.harness ?? "");
  if (keys === null)
    return refuse(null, "failed", `capability_unproven:${draft.harness ?? ""}:interrupt`);
  const sent = yield* deps.herdr.agentSendKeys(entry.agent, keys).pipe(
    Effect.as(null),
    Effect.catch((cause) => Effect.succeed(herdrFailureReason(cause))),
  );
  if (sent !== null) return refuse(null, "failed", `interrupt keys not sent: ${sent}`);
  yield* deps.log(`${entry.agent}: interrupt_requested`);

  // Waiting is a courtesy, not a condition: whether or not the status moves, the text
  // goes out. A harness that ignored the keys still has to be told what changed.
  const deadline = (yield* Clock.currentTimeMillis) + waitMs;
  while ((yield* Clock.currentTimeMillis) < deadline) {
    if ((yield* deps.status(entry.agent)) !== "working") break;
    yield* Effect.sleep(250);
  }
  return yield* channel.submit(text, { ...draft, mode: "now" });
});

/** How long an interrupt waits for the agent's status to move before it sends anyway. */
export const INTERRUPT_WAIT_MS = 10_000;
