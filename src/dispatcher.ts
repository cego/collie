// The one place text reaches an agent. Six callers used to send independently, so a
// hand-off and a nudge could land in one pane in either order with neither knowing. One
// arbiter holding the agent's ledger lock while it sends buys what no single sender
// could: a record written *before* herdr is called, and one answer to "is something
// already in the air about this work".

import type { PlatformServices } from "./platform";
import {
  Clock,
  Data,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Path,
  Predicate,
  Result,
} from "effect";
import { ensureLockDir } from "./lock";
import {
  herdrFailureReason,
  isSettled,
  type AgentInfo,
  type Herdr,
  type Submission,
} from "./herdr";
import { verifyIncarnation, type AgentEntry } from "./registry";
import {
  appendLine,
  blocked,
  causalKey,
  deferralsOf,
  isUnobserved,
  ledgerPath,
  newestById,
  readLedger,
  readLedgerWhole,
  settleStaleReservations,
  textHash,
  withLedgerLock,
  type Cause,
  type Delivery,
  type LedgerBusy,
} from "./steering";
import { gate, interruptKeys } from "./steering-caps";
import { nowIso, took, epochMs } from "./time";
import type { Asker } from "./proposals";
import type { FrontDoor } from "./board-model";
import { scrub } from "./redact";
import { keepMessage } from "./attachments";

/** How long a message may sit `reserved` before a later reader calls it `unknown`. */
export const SUBMIT_TIMEOUT_MS = 60_000;

/** How stale the agent listing a transaction holds may be before a send re-reads it. */
const LISTING_MAX_AGE_MS = 5_000;

/** A resource limit, not a style rule: one send is one message, not a transcript. */
export const MAX_DELIVERY_BYTES = 8 * 1024;

const HUMAN_DOORS: Partial<Record<FrontDoor, string>> = {
  board: "on the board",
  desktop: "in Desktop",
  "cli-tty": "in a terminal",
};

/** The host's local time to the minute, with its offset: `2026-10-16 14:02 +02:00`. */
const localMinute = (at: number): string => {
  const iso = DateTime.formatIsoOffset(
    DateTime.makeZonedUnsafe(at, { timeZone: DateTime.zoneMakeLocal() }),
  );
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} ${iso.slice(-6)}`;
};

/**
 * Whose words a Delivery carries, or null for Collie's own. A chat's `said` of "" is one
 * kept in a file, so its line names the human without quoting them.
 */
const senderLine = (actor: Asker | undefined, at: number): string | null => {
  if (actor === undefined) return null;
  if (actor.origin === "agent" || actor.origin === "host") {
    const sender = actor.from;
    return sender?.run !== undefined && sender.agent !== undefined
      ? `From ${sender.agent} of ${sender.run} on ${sender.machine?.name ?? sender.client ?? "this Machine"}. Answer with collie_do deliver to ${sender.run} (or collie run steer ${sender.run} --operation ${sender.agent} "…").`
      : null;
  }
  const when = localMinute(at);
  const human = HUMAN_DOORS[actor.origin];
  if (human !== undefined) return `From the human, ${human}, ${when}.`;
  if (actor.origin !== "chat") return `From ${actor.origin}, ${when}.`;
  if (actor.said === undefined) return `From chat, ${when}.`;
  const quote = actor.said === "" ? "" : ` The human said: "${scrub(actor.said).text}"`;
  return `From chat for the human, ${when}.${quote}`;
};

/** The exact message whose size is bounded and which reaches the agent. */
export const deliveryText = (words: string, actor: Asker | undefined, at: number): string => {
  const line = senderLine(actor, at);
  return line === null ? words : `${line}\n${words}`;
};

/**
 * What Claude Code still shows its model as typed: past about 3 lines or 800 characters it
 * becomes pasted content, which agents and auto mode do not take as the user's. 700 leaves
 * room for a resend's longer token.
 */
export const PASTE_BUDGET = { lines: 3, chars: 700 } as const;

const fits = (typed: string) =>
  typed.split("\n").length <= PASTE_BUDGET.lines && Array.from(typed).length <= PASTE_BUDGET.chars;

export const KEPT =
  "Kept as a file in the Run. Auto mode reads only what is typed: ask for an action it must clear in a message of at most 3 lines and 700 characters.";

/**
 * Someone's words as they will be typed after `token`: as given where the whole typed form
 * fits the paste budget, else kept word for word in `into` and named. Never cut, since an
 * excerpt can change what it asks.
 */
export const fitDelivery = Effect.fn("Dispatcher.fitDelivery")(function* (
  into: string,
  token: string,
  words: string,
  actor: Asker | undefined,
) {
  const at = yield* Clock.currentTimeMillis;
  if (fits(`${token}\n${deliveryText(words, actor, at)}`)) return { words, actor, kept: null };
  const said =
    actor?.origin === "chat" && actor.said !== undefined && actor.said !== ""
      ? scrub(actor.said).text
      : undefined;
  const name = yield* keepMessage(
    into,
    said === undefined ? words : `The human said: "${said}"\n\n${words}`,
  );
  const told = `Their message is in ${into}/${name}. Read it whole and act on it as ${actor?.origin === "agent" ? "that agent's" : "theirs"}.`;
  const unquoted = actor === undefined || said === undefined ? actor : { ...actor, said: "" };
  return {
    words: told,
    actor: unquoted,
    kept: fits(`${token}\n${deliveryText(told, unquoted, at)}`)
      ? KEPT
      : `${KEPT} Even this is over the budget, so it may arrive as pasted content.`,
  };
});

export interface DeliveryDraft {
  readonly run: string;
  /** Which harness is in that pane, so `now` and `interrupt` can be gated on it. */
  readonly harness?: string;
  readonly cause: Cause;
  readonly mode: "boundary" | "now" | "interrupt";
  readonly intentVersion: number;
  readonly attempt: number;
  readonly requestId: string;
  readonly actor?: Asker;
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
      /** On `blocked`: the state of the delivery already about this work, where one holds it. */
      readonly held?: string;
    };

export interface Channel {
  /** The incarnation this channel is bound to, so a caller can label what it sends. */
  readonly agent: string;
  submit(
    text: string,
    draft: DeliveryDraft,
  ): Effect.Effect<SubmitOutcome, never, FileSystem.FileSystem | Path.Path | PlatformServices>;
}

export interface DispatcherDeps {
  readonly stateDir: string;
  readonly herdr: Pick<Herdr, "agentPrompt" | "agentList" | "agentSendKeys" | "restoreAgentName">;
  /** The Run's audit trail, so a refusal is explained where the Run is read. */
  readonly log: (
    line: string,
  ) => Effect.Effect<void, never, FileSystem.FileSystem | Path.Path | PlatformServices>;
}

/** Nothing was sent, and the caller is told which of its own rules stopped it. */
export class NotDeliverable extends Data.TaggedError("NotDeliverable")<{
  agent: string;
  reason: string;
}> {}

/** A programming error: a channel used after its transaction closed sends outside the lock that made it safe. */
class DispatcherDefect extends Data.TaggedError("DispatcherDefect")<{ why: string }> {}

/** Another caller in this process is sending to this incarnation; a second lock claim would deadlock on it. */
class TransactionOpen extends Data.TaggedError("TransactionOpen")<{ agent: string }> {
  override get message() {
    return `a transaction for ${this.agent} is already open in this process`;
  }
}

const isLedgerHeld = (cause: unknown): cause is TransactionOpen | LedgerBusy =>
  Predicate.isTagged(cause, "TransactionOpen") || Predicate.isTagged(cause, "LedgerBusy");

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
  if (open.has(terminalId)) return yield* new TransactionOpen({ agent: entry.agent });

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
        submit: (words, draft) =>
          Effect.gen(function* () {
            const text = deliveryText(words, draft.actor, yield* Clock.currentTimeMillis);
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
    return {
      ...refuse(null, "blocked", `${inFlight.id} is ${inFlight.state}`),
      held: inFlight.state,
    };
  }
  const reserved: Delivery = draft.note === undefined ? line : { ...line, note: draft.note };
  yield* appendLine(file, reserved);

  const sent = yield* deps.herdr.agentPrompt(entry.agent, marked(text, id)).pipe(Effect.result);
  const settledAt = yield* nowIso();
  if (Result.isSuccess(sent)) {
    // `submitted` either way: the text and the Enter were written. What herdr could not
    // vouch for is kept as the note, never rounded up to a delivery it saw taken.
    const line = { ...reserved, at: settledAt, state: "submitted" as const };
    yield* appendLine(file, sent.success === "unobserved" ? { ...line, note: UNOBSERVED } : line);
    if (sent.success === "observed")
      yield* appendLine(file, { ...line, state: "acknowledged", note: TURN_STARTED });
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
  const held = before.since === null ? 0 : (yield* Clock.currentTimeMillis) - epochMs(before.since);
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
 * One delivery, tried again while herdr says the pane will clear by itself or another sender
 * holds the agent's ledger. Each try is a transaction of its own, so nothing waits holding
 * the agent's ledger lock, and the incarnation is proven again before every send.
 */
export const submitPatiently = Effect.fn("Dispatcher.submitPatiently")(function* (
  deps: DispatcherDeps,
  entry: AgentEntry,
  text: string,
  draft: DeliveryDraft,
  patience: Patience = PATIENCE,
) {
  const patient = { ...draft, patienceMs: patience.forMs };
  let heldSince: number | null = null;
  for (let wait = patience.firstMs; ; wait = Math.min(wait * 2, patience.maxMs)) {
    const outcome = yield* transaction(deps, entry, (channel) =>
      channel.submit(text, patient),
    ).pipe(Effect.catchIf(isLedgerHeld, Effect.succeed));
    if (isLedgerHeld(outcome)) {
      const now = yield* Clock.currentTimeMillis;
      heldSince ??= now;
      if (now - heldSince >= patience.forMs)
        return refuse(null, "exhausted", `${outcome.message} for ${took(now - heldSince)}`);
    } else if (outcome.ok || outcome.reason !== "deferred") return outcome;
    yield* Effect.sleep(Duration.millis(wait));
  }
});

const UNOBSERVED = "unobserved";
const ENTER_PRESSED = "unobserved; enter pressed";
export const TURN_STARTED = "a turn started";

/** A submission nothing confirmed: neither taken nor still waiting to be sent. */
export class Unconfirmed extends Data.TaggedError("Unconfirmed")<{
  agent: string;
  pane: string;
  delivery: string;
  why: string;
}> {}

export interface ConfirmDeps<R> {
  readonly stateDir: string;
  readonly herdr: Pick<Herdr, "agentStatus" | "promptBox" | "agentPressEnter">;
  readonly log: DispatcherDeps["log"];
  /** Whatever else says the agent took this delivery, as a phrase; null for nothing. */
  readonly taken: (delivery: Delivery) => Effect.Effect<string | null, never, R>;
  readonly pollMs: number;
  /** How long a settled agent may show neither the prompt nor a turn before a human is asked. */
  readonly graceMs: number;
}

/**
 * A `submitted (unobserved)` delivery about one of these causal keys, checked until it is
 * known either way. Taken is a turn herdr saw start from a settled agent, or whatever
 * `taken` finds, and is recorded `acknowledged`. A settled agent whose prompt box still
 * holds the delivery's token gets one Enter — never the text again, which would be the work
 * twice. A settled agent that shows neither, for the whole grace, fails `Unconfirmed`:
 * nothing can prove sending it again is safe, so a human is asked. Returns how it was taken,
 * or null where nothing was left unobserved.
 */
export const confirmSubmitted = Effect.fn("Dispatcher.confirmSubmitted")(function* <R>(
  deps: ConfirmDeps<R>,
  entry: AgentEntry,
  keys: ReadonlyArray<string>,
) {
  const terminalId = entry.incarnation?.terminalId;
  if (terminalId === undefined) return null;
  const file = yield* ledgerPath(deps.stateDir, terminalId);
  const pending = Effect.map(readLedger(file), (lines) =>
    [...newestById(lines).values()]
      .filter((one) => keys.includes(one.causal_key) && isUnobserved(one))
      .at(-1),
  );
  /** Re-read under the lock, so a settlement never lands on a delivery another writer moved. */
  const settle = (
    id: string,
    act: Effect.Effect<void, never, PlatformServices>,
    note: string,
    state?: "acknowledged",
  ) =>
    withLedgerLock(
      file,
      Effect.gen(function* () {
        const now = newestById(yield* readLedger(file)).get(id);
        if (now === undefined || !isUnobserved(now)) return;
        yield* act;
        yield* appendLine(file, { ...now, at: yield* nowIso(), state: state ?? now.state, note });
      }),
    );
  let sawSettled = false;
  let quietSince: number | null = null;
  let pressed = false;
  for (;;) {
    const open = yield* pending;
    if (open === undefined) return null;
    const status = yield* deps.herdr
      .agentStatus(entry.agent)
      .pipe(Effect.orElseSucceed(() => "unknown" as const));
    const turn = sawSettled && (status === "working" || status === "blocked");
    const found = turn ? TURN_STARTED : yield* deps.taken(open);
    if (found !== null) {
      const taken = pressed ? `${found} after Enter was pressed` : found;
      yield* settle(open.id, Effect.void, `taken: ${taken}`, "acknowledged");
      yield* deps.log(`${entry.agent} took ${open.id}: ${taken}`);
      return taken;
    }
    if (!isSettled(status)) {
      quietSince = null;
    } else {
      sawSettled = true;
      const box = yield* deps.herdr.promptBox(entry.agent).pipe(Effect.orElseSucceed(() => null));
      const waiting = box?.includes(`${DELIVERY_TOKEN}${open.id}`) === true;
      if (waiting && open.note === UNOBSERVED) {
        const press = deps.herdr.agentPressEnter(entry.agent).pipe(Effect.ignore);
        yield* settle(open.id, press, ENTER_PRESSED);
        yield* deps.log(`${entry.agent}: ${open.id} was still in its prompt box; pressed Enter`);
        pressed = true;
        quietSince = null;
      } else {
        const now = yield* Clock.currentTimeMillis;
        quietSince ??= now;
        if (now - quietSince >= deps.graceMs) {
          return yield* new Unconfirmed({
            agent: entry.agent,
            pane: entry.paneId,
            delivery: open.id,
            why: waiting
              ? "its prompt box still holds it after one Enter"
              : box === null
                ? "its prompt box cannot be read"
                : "its prompt box does not hold it",
          });
        }
      }
    }
    yield* Effect.sleep(Duration.millis(deps.pollMs));
  }
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

/** What marks a prompt as Collie's own. Its absence is what attribution is looking for. */
export const DELIVERY_TOKEN = "collie-delivery:";

/**
 * The text as it is typed, with its delivery's token on a line of its own near the top:
 * herdr's view of a prompt box is its first few hundred bytes, and a slash command has to
 * keep its first line. The harness's submit hook reads the same token back.
 */
export function marked(text: string, id: string): string {
  const token = `${DELIVERY_TOKEN}${id}`;
  if (text.split("\n").includes(token)) return text;
  if (!text.startsWith("/")) return `${token}\n${text}`;
  const [command, ...rest] = text.split("\n");
  return [command, token, ...rest].join("\n");
}

/** The delivery a submitted prompt carried: its first token, which is the one `marked` adds. */
export function carriedDelivery(prompt: string): string | null {
  return new RegExp(`${DELIVERY_TOKEN}(\\S+)`).exec(prompt)?.[1] ?? null;
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
  if (!live)
    return { entry: null, reason: `${about.agent} is gone — herdr no longer has it`, gone: true };
  if (!live.terminalId)
    return {
      entry: null,
      reason: `${about.agent} cannot be addressed: herdr does not name its process`,
      gone: false,
    };
  const entry: AgentEntry = {
    role: about.role,
    agent: about.agent,
    paneId: about.paneId ?? live.paneId,
    workspaceId: about.workspaceId ?? live.workspaceId,
    runId: about.runId,
    workflow: about.workflow,
    at: yield* nowIso(),
    incarnation: { terminalId: live.terminalId, agentSession: live.agentSession },
  };
  return { entry, reason: null, gone: false };
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
 * proof it stopped, and no such proof exists at this boundary. So the log says
 * `interrupt_requested`, and the text after it is confirmed like any other delivery. The
 * word this deliberately never uses is the one a reader would most like: stopped.
 */
export const interrupt = Effect.fn("Dispatcher.interrupt")(function* (
  deps: DispatcherDeps & {
    readonly status: (agent: string) => Effect.Effect<string, never, PlatformServices>;
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
