import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import type { PlatformServices } from "./platform";
import type { FileSystem, Path } from "effect";
import { Clock, Data, DateTime, Duration, Effect, Predicate, Result } from "effect";
import { HerdrError, herdrFailureReason, isSettled, type Herdr, type Submission } from "./herdr";
import { verifyIncarnation, type AgentEntry, type Incarnation } from "./registry";
import {
  appendLine,
  blocked,
  causalKey,
  deferralsOf,
  isUnobserved,
  newestById,
  deliveriesAbout,
  readLedger,
  readLedgerWhole,
  settleStaleReservations,
  textHash,
  type Cause,
  type Deliveries,
  type Delivery,
  type HumanDoor,
} from "./steering";
import { gate, interruptKeys } from "./steering-caps";
import { nowIso, took, epochMs } from "./time";
import type { Asker } from "./proposals";
import type { FrontDoor } from "./board-model";
import { scrub } from "./redact";
import { keepMessage } from "./attachments";

// WARNING: a message may sit reserved until a later reader calls it unknown.
export const SUBMIT_TIMEOUT_MS = 60_000;

const LISTING_MAX_AGE_MS = 5000;

export const MAX_DELIVERY_BYTES = 8 * 1024;

const HUMAN_DOORS: Partial<Record<FrontDoor, string>> = {
  board: "on the board",
  desktop: "in Desktop",
  "cli-tty": "in a terminal",
};

const localMinute = (at: number) => {
  const iso = DateTime.formatIsoOffset(
    DateTime.makeZonedUnsafe(at, { timeZone: DateTime.zoneMakeLocal() }),
  );
  return `${pipe_(iso, Str.slice(0, 10))} ${pipe_(iso, Str.slice(11, 16))} ${pipe_(iso, Str.slice(-6))}`;
};

const senderLine = (actor: Asker | undefined, at: number) => {
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

export const deliveryText = (
  words: string,
  actor: Asker | undefined,
  at: number,
  workflowNotice?: string,
) => {
  const line = senderLine(actor, at);
  const heading = Arr.join(
    Arr.filter([line, workflowNotice], (one) => one != null),
    " ",
  );
  return heading === "" ? words : `${heading}\n${words}`;
};

// WARNING: past about 3 lines or 800 characters Claude Code shows the text as pasted content; 700 leaves room for a resend's token.
export const PASTE_BUDGET = { lines: 3, chars: 700 } as const;

const fits = (typed: string) =>
  Str.split(typed, "\n").length <= PASTE_BUDGET.lines &&
  Array.from(typed).length <= PASTE_BUDGET.chars;

export const KEPT =
  "Kept as a file in the Run. Auto mode reads only what is typed: ask for an action it must clear in a message of at most 3 lines and 700 characters.";

// WARNING: never cut, since an excerpt can change what it asks.
export const fitDelivery = Effect.fn("Dispatcher.fitDelivery")(function* (
  into: string,
  token: string,
  words: string,
  actor: Asker | undefined,
  workflowNotice?: string,
) {
  const at = yield* Clock.currentTimeMillis;
  if (fits(`${token}\n${deliveryText(words, actor, at, workflowNotice)}`))
    return { words, actor, kept: null };
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
    kept: fits(`${token}\n${deliveryText(told, unquoted, at, workflowNotice)}`)
      ? KEPT
      : `${KEPT} Even this is over the budget, so it may arrive as pasted content.`,
  };
});

export interface DeliveryDraft {
  readonly run: string;
  readonly harness?: string;
  readonly cause: Cause;
  readonly mode: "boundary" | "now" | "interrupt";
  readonly intentVersion: number;
  readonly attempt: number;
  readonly requestId: string;
  readonly actor?: Asker;
  readonly note?: string;
  readonly workflowNotice?: string;
  readonly idleOnly?: boolean;
  readonly human?: HumanDoor | null;
  readonly patienceMs?: number;
}

// WARNING: matched by herdr's error code, never its message text.
const AGENT_BLOCKED = "agent_blocked";
const TRANSIENT_REFUSALS: ReadonlySet<string> = new Set([AGENT_BLOCKED]);

type Refusal =
  | "blocked"
  | "incarnation_changed"
  | "failed"
  | "unknown"
  | "too_long"
  | "deferred"
  | "exhausted";

// WARNING: never a throw: each outcome is a fact the caller records, and an exception would lose the delivery id.
export type SubmitOutcome =
  | {
      readonly ok: true;
      readonly id: string;
      readonly submission?: Submission;
    }
  | {
      readonly ok: false;
      readonly id: string | null;
      readonly reason: Refusal;
      readonly detail: string;
      readonly held?: string;
    };

export interface Channel {
  readonly agent: string;
  submit(
    text: string,
    draft: DeliveryDraft,
  ): Effect.Effect<
    SubmitOutcome,
    never,
    FileSystem.FileSystem | Path.Path | PlatformServices | Deliveries
  >;
}

export interface DispatcherDeps {
  readonly stateDir: string;
  readonly herdr: Pick<Herdr, "agentPrompt" | "agentList" | "agentSendKeys"> &
    Partial<Pick<Herdr, "agentStatus">>;
  readonly log: (
    line: string,
  ) => Effect.Effect<void, never, FileSystem.FileSystem | Path.Path | PlatformServices>;
  readonly asking?: (agent: string) => Effect.Effect<string | null>;
}

export class NotDeliverable extends Data.TaggedError("NotDeliverable")<{
  agent: string;
  reason: string;
}> {}

class DispatcherDefect extends Data.TaggedError("DispatcherDefect")<{ why: string }> {}

class TransactionOpen extends Data.TaggedError("TransactionOpen")<{ agent: string }> {
  override get message() {
    return `a transaction for ${this.agent} is already open in this process`;
  }
}

const isLedgerHeld = (cause: unknown): cause is TransactionOpen =>
  Predicate.isTagged(cause, "TransactionOpen");

const open = new Set<string>();

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

// WARNING: last, not undefined, in the arithmetic: a NaN comparison leaves the list in whatever order it arrived.
const LAST = Number.MAX_SAFE_INTEGER;
// WARNING: the index is checked by `?? LAST` — a kind or mode these tables do not name reads as absent and sorts last, which is the point of the lookup.
const causeRank = (kind: string) => ORDER[kind as Cause["kind"]] ?? LAST;
// WARNING: as above; an unknown mode is ordered last rather than compared as NaN.
const modeRank = (mode: string) => MODE_ORDER[mode as Delivery["mode"]] ?? LAST;

export function dispatchOrder<
  T extends { readonly mode: string; readonly cause: { readonly kind: string } },
>(due: ReadonlyArray<T>) {
  return [...due].sort(
    (a, b) =>
      modeRank(a.mode) - modeRank(b.mode) || causeRank(a.cause.kind) - causeRank(b.cause.kind),
  );
}

// WARNING: the incarnation is revalidated before any send, since an inherited agent name or pane may now belong to something else.
export const transaction = Effect.fn("Dispatcher.transaction")(function* <A, E, R>(
  deps: DispatcherDeps,
  entry: AgentEntry,
  body: (channel: Channel) => Effect.Effect<A, E, R>,
) {
  const terminalId = entry.incarnation?.terminalId;
  if (terminalId === undefined)
    return yield* new NotDeliverable({ agent: entry.agent, reason: "no_incarnation" });
  if (open.has(terminalId)) return yield* new TransactionOpen({ agent: entry.agent });
  open.add(terminalId);
  return yield* Effect.gen(function* () {
    let listing = yield* agentsNow(deps);
    let listedAt = yield* Clock.currentTimeMillis;

    const identified = verifyIncarnation(entry, listing);
    if (!identified.ok) {
      yield* settlePending(terminalId, identified.reason);
      return yield* new NotDeliverable({ agent: entry.agent, reason: identified.reason });
    }

    let closed = false;
    const channel: Channel = {
      agent: entry.agent,
      submit: (words, draft) =>
        Effect.gen(function* () {
          const text = deliveryText(
            words,
            draft.actor,
            yield* Clock.currentTimeMillis,
            draft.workflowNotice,
          );
          if (closed)
            return yield* new DispatcherDefect({
              why: `${entry.agent}'s channel was used after its transaction closed`,
            });
          if (Buffer.byteLength(text, "utf8") > MAX_DELIVERY_BYTES)
            return refuse(null, "too_long", `over ${MAX_DELIVERY_BYTES} bytes`);
          // WARNING: fails closed before anything is reserved: an unshown mode would produce a delivery nobody can settle.
          const ungated = yield* gate(draft.harness ?? "", draft.mode).pipe(
            Effect.as(null),
            Effect.catch((cause) => Effect.succeed(cause)),
          );
          if (ungated) {
            yield* recordUngated(entry, terminalId, text, draft, ungated.reason);
            return refuse(null, "failed", ungated.reason);
          }
          if (
            draft.idleOnly &&
            !isSettled(
              yield* (
                deps.herdr.agentStatus?.(entry.agent) ?? Effect.succeed("unknown" as const)
              ).pipe(Effect.orElseSucceed(() => "unknown" as const)),
            )
          )
            return refuse(null, "deferred", "agent is not idle");
          // WARNING: a whole compaction can happen inside one transaction, so a listing older than a few seconds is re-read.
          if ((yield* Clock.currentTimeMillis) - listedAt > LISTING_MAX_AGE_MS) {
            listing = yield* agentsNow(deps);
            listedAt = yield* Clock.currentTimeMillis;
            const again = verifyIncarnation(entry, listing);
            if (!again.ok) {
              yield* settlePending(terminalId, again.reason);
              return refuse(null, "incarnation_changed", again.reason);
            }
          }
          return yield* send(deps, entry, terminalId, text, draft);
        }).pipe(Effect.orDie),
    };

    // WARNING: closed however the body ends, so a failed body cannot keep a sender with nothing serialising it.
    const result = yield* body(channel).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          closed = true;
        }),
      ),
    );
    return result;
  }).pipe(Effect.ensuring(Effect.sync(() => open.delete(terminalId))));
});

function refuse(id: string | null, reason: Refusal, detail: string) {
  const returned: SubmitOutcome = { ok: false, id, reason, detail };
  return returned;
}

const agentsNow = (deps: DispatcherDeps) =>
  deps.herdr.agentList().pipe(Effect.orElseSucceed(() => []));

// WARNING: reserved before herdr is called and never removed; a crash between them settles as unknown, not guessed.
function deliveryOf(
  entry: AgentEntry,
  terminalId: string,
  text: string,
  draft: DeliveryDraft,
  at: string,
  state: Delivery["state"],
) {
  let line: Delivery = {
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
  if (draft.workflowNotice !== undefined) line = { ...line, workflowNotice: draft.workflowNotice };
  return draft.human == null ? line : { ...line, human: draft.human };
}

const send = Effect.fn("Dispatcher.send")(function* (
  deps: DispatcherDeps,
  entry: AgentEntry,
  terminalId: string,
  text: string,
  draft: DeliveryDraft,
) {
  const at = yield* nowIso;
  const lines = yield* readLedger(terminalId);
  const now = yield* Clock.currentTimeMillis;
  for (const stale of settleStaleReservations(lines, now, SUBMIT_TIMEOUT_MS, at))
    yield* appendLine(stale);

  const key = causalKey(draft.run, draft.cause, draft.intentVersion);
  const ledger = yield* readLedgerWhole(terminalId);
  // WARNING: an unreadable line is a delivery nobody can account for; sending again could be a second copy.
  if (ledger.corrupt > 0) {
    yield* deps.log(
      `not sent to ${entry.agent}: ${ledger.corrupt} unreadable line(s) in its ledger`,
    );
    return refuse(
      null,
      "blocked",
      `${entry.agent}'s ledger has ${ledger.corrupt} unreadable line(s)`,
    );
  }
  const line = deliveryOf(entry, terminalId, text, draft, at, "reserved");
  const id = line.id;
  const inFlight = blocked(yield* deliveriesAbout(terminalId, key), key, id);
  if (inFlight) {
    yield* deps.log(
      `not sent to ${entry.agent}: ${inFlight.state} delivery ${inFlight.id} is already about this work`,
    );
    return {
      ...refuse(inFlight.id, "blocked", `${inFlight.id} is ${inFlight.state}`),
      held: inFlight.state,
    };
  }
  const reserved: Delivery = draft.note === undefined ? line : { ...line, note: draft.note };
  yield* appendLine(reserved);

  const asking =
    draft.cause.kind === "step" || draft.cause.kind === "repair"
      ? yield* deps.asking?.(entry.agent) ?? Effect.succeed(null)
      : null;
  const sent =
    asking === null
      ? yield* deps.herdr.agentPrompt(entry.agent, marked(text, id)).pipe(Effect.result)
      : Result.fail(
          new HerdrError({ message: asking, detail: "", code: AGENT_BLOCKED, answered: true }),
        );
  const settledAt = yield* nowIso;
  if (Result.isSuccess(sent)) {
    // WARNING: submitted either way; what herdr could not vouch for is kept as a note, never rounded up to a delivery seen taken.
    const line = { ...reserved, at: settledAt, state: "submitted" as const };
    yield* appendLine(
      sent.success === "observed"
        ? line
        : { ...line, note: sent.success === "pressed" ? ENTER_PRESSED : UNOBSERVED },
    );
    if (sent.success === "observed")
      yield* appendLine({ ...line, state: "acknowledged", note: TURN_STARTED });
    return { ok: true as const, id, submission: sent.success };
  }
  // WARNING: a refusal herdr answered with is a fact; a transport that never answered is not.
  const why = herdrFailureReason(sent.failure);
  if (sent.failure.answered !== true) {
    // WARNING: Collie never retries out of unknown on its own.
    yield* appendLine({ ...reserved, at: settledAt, state: "unknown", note: why });
    return refuse(id, "unknown", why);
  }
  const code = sent.failure.code;
  const coded = code === undefined ? reserved : { ...reserved, code };
  if (code === undefined || !TRANSIENT_REFUSALS.has(code) || draft.patienceMs === undefined) {
    yield* appendLine({ ...coded, at: settledAt, state: "failed", note: why });
    return refuse(id, "failed", why);
  }
  // WARNING: measured from the ledger, not this process, so a sender that comes back after a restart keeps the same deadline.
  const before = deferralsOf(ledger.lines, id);
  const attempts = before.count + 1;
  const held = before.since === null ? 0 : (yield* Clock.currentTimeMillis) - epochMs(before.since);
  if (held < draft.patienceMs) {
    if (attempts === 1)
      yield* deps.log(`${entry.agent} cannot take a prompt yet (${code}); retrying`);
    yield* appendLine({ ...coded, at: settledAt, state: "deferred", note: why });
    return refuse(id, "deferred", `${code}, attempt ${attempts}`);
  }
  const gaveUp = `${code} held for ${took(held)} over ${attempts} attempts`;
  yield* deps.log(`not sent to ${entry.agent}: ${gaveUp}; gave up`);
  yield* appendLine({ ...coded, at: settledAt, state: "failed", note: gaveUp });
  return refuse(id, "exhausted", gaveUp);
});

export interface Patience {
  readonly firstMs: number;
  readonly maxMs: number;
  readonly forMs: number;
}

export const PATIENCE: Patience = { firstMs: 2000, maxMs: 30_000, forMs: 10 * 60_000 };

// WARNING: each try is a transaction of its own, so nothing waits holding the agent's ledger lock.
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

export class Unconfirmed extends Data.TaggedError("Unconfirmed")<{
  agent: string;
  pane: string;
  delivery: string;
  why: string;
}> {}

export interface ConfirmDeps<R> {
  readonly stateDir: string;
  readonly herdr: Pick<Herdr, "agentStatus">;
  readonly log: DispatcherDeps["log"];
  readonly taken: (delivery: Delivery) => Effect.Effect<string | null, never, R>;
  readonly pollMs: number;
  readonly graceMs: number;
}

// WARNING: a settled agent showing neither a taken turn nor a delivery for the whole grace fails Unconfirmed; nothing proves resending is safe.
export const confirmSubmitted = Effect.fn("Dispatcher.confirmSubmitted")(function* <R>(
  deps: ConfirmDeps<R>,
  entry: AgentEntry,
  keys: ReadonlyArray<string>,
) {
  const terminalId = entry.incarnation?.terminalId;
  if (terminalId === undefined) return null;
  const pending = Effect.map(readLedger(terminalId), (lines) =>
    Arr.filter(
      [...newestById(lines).values()],
      (one) => keys.includes(one.causal_key) && isUnobserved(one),
    ).at(-1),
  );
  const settle = (id: string, note: string, state?: "acknowledged") =>
    Effect.gen(function* () {
      const now = newestById(yield* readLedger(terminalId)).get(id);
      if (now === undefined || !isUnobserved(now)) return;
      yield* appendLine({ ...now, at: yield* nowIso, state: state ?? now.state, note });
    });
  let sawSettled = false;
  let quietSince: number | null = null;
  for (;;) {
    const open = yield* pending;
    if (open === undefined) return null;
    const status = yield* deps.herdr
      .agentStatus(entry.agent)
      .pipe(Effect.orElseSucceed(() => "unknown" as const));
    const turn = sawSettled && (status === "working" || status === "blocked");
    const found = turn ? TURN_STARTED : yield* deps.taken(open);
    if (found !== null) {
      yield* settle(open.id, `taken: ${found}`, "acknowledged");
      yield* deps.log(`${entry.agent} took ${open.id}: ${found}`);
      return found;
    }
    if (!isSettled(status)) {
      quietSince = null;
    } else {
      sawSettled = true;
      const now = yield* Clock.currentTimeMillis;
      quietSince ??= now;
      if (now - quietSince >= deps.graceMs) {
        return yield* new Unconfirmed({
          agent: entry.agent,
          pane: entry.paneId,
          delivery: open.id,
          why: "it started no turn for it",
        });
      }
    }
    yield* Effect.sleep(Duration.millis(deps.pollMs));
  }
});

const settlePending = Effect.fn("Dispatcher.settlePending")(function* (
  terminalId: string,
  why: string,
) {
  const at = yield* nowIso;
  for (const delivery of newestById(yield* readLedger(terminalId)).values()) {
    if (delivery.state !== "reserved" && delivery.state !== "deferred") continue;
    yield* appendLine({
      ...delivery,
      at,
      state: delivery.state === "reserved" ? "unknown" : "failed",
      note: why,
    });
  }
});

export const DELIVERY_TOKEN = "collie-delivery:";

// WARNING: herdr sees a prompt's first few hundred bytes and a slash command keeps its first line, so the token goes on its own line near the top.
export function marked(text: string, id: string) {
  const token = `${DELIVERY_TOKEN}${id}`;
  if (Str.split(text, "\n").includes(token)) return text;
  if (!pipe_(text, Str.startsWith("/"))) return `${token}\n${text}`;
  const [command, ...rest] = Str.split(text, "\n");
  return Arr.join([command, token, ...rest], "\n");
}

export function carriedDelivery(prompt: string) {
  return new RegExp(`${DELIVERY_TOKEN}(\\S+)`).exec(prompt)?.[1] ?? null;
}

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
  const live = Option.getOrUndefined(
    Arr.findFirst(yield* agentsNow(deps), (a) => a.name === about.agent),
  );
  if (!live)
    return { entry: null, reason: `${about.agent} is gone — core no longer has it`, gone: true };
  const incarnation: Incarnation = {
    terminalId: live.terminalId,
    agentSession: null,
    backend: "core",
  };
  const entry: AgentEntry = {
    role: about.role,
    agent: about.agent,
    paneId: about.paneId ?? live.paneId,
    workspaceId: about.workspaceId,
    runId: about.runId,
    workflow: about.workflow,
    at: yield* nowIso,
    incarnation,
  };
  return { entry, reason: null, gone: false };
});

const recordUngated = Effect.fn("Dispatcher.recordUngated")(function* (
  entry: AgentEntry,
  terminalId: string,
  text: string,
  draft: DeliveryDraft,
  why: string,
) {
  const at = yield* nowIso;
  yield* appendLine({
    ...deliveryOf(entry, terminalId, text, draft, at, "failed"),
    note: why,
  });
});

// WARNING: never says stopped: keys do not prove the harness stopped, so the log says interrupt_requested.
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
  // WARNING: before the keys: gating the text as a now is too late to un-press a key.
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

  // WARNING: waiting is a courtesy, not a condition: the text goes out whether or not the status moves.
  const deadline = (yield* Clock.currentTimeMillis) + waitMs;
  while ((yield* Clock.currentTimeMillis) < deadline) {
    if ((yield* deps.status(entry.agent)) !== "working") break;
    yield* Effect.sleep(250);
  }
  return yield* channel.submit(text, { ...draft, mode: "now" });
});

export const INTERRUPT_WAIT_MS = 10_000;
