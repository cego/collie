// The Dispatcher's whole reason to exist is what happens when a send goes wrong, so
// that is what is tested: the record written before herdr is called, a herdr that
// refuses versus one that never answers, and an agent that is no longer the one the
// message was addressed to.

import type { BunServices } from "@effect/platform-bun/BunServices";
import { Effect, FileSystem } from "effect";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { HerdrError, type AgentInfo } from "../src/herdr";
import {
  dispatchOrder,
  interrupt,
  transaction,
  steeringSection,
  MAX_DELIVERY_BYTES,
  settleCollected,
} from "../src/dispatcher";
import {
  appendLine,
  blocked,
  causalKey,
  ledgerPath,
  newestById,
  readLedger,
  type Delivery,
} from "../src/steering";
import type { AgentEntry } from "../src/registry";
import { runEffect } from "./support/effect";

let stateDir: string;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      stateDir = yield* fs.makeTempDirectory({ prefix: "hw-dispatch-" });
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(stateDir, { recursive: true, force: true });
    }),
  ),
);

const entry: AgentEntry = {
  role: "implementer",
  agent: "impl-1",
  paneId: "1-9",
  workspaceId: "w1",
  runId: "r1",
  workflow: "implement",
  at: "2026-09-09T09:00:00Z",
  incarnation: { terminalId: "term-1", agentSession: null },
};

const alive: AgentInfo = {
  name: "impl-1",
  paneId: "1-9",
  workspaceId: "w1",
  status: "idle",
  title: null,
  terminalId: "term-1",
  agentSession: null,
};

const draft = {
  run: "r1",
  cause: { kind: "step" as const, ref: "build" },
  mode: "boundary" as const,
  intentVersion: 1,
  attempt: 1,
  requestId: "req-1",
};

/** A herdr that records what it was asked, in order, beside the ledger writes. */
function fake(
  options: {
    agents?: AgentInfo[];
    fail?: HerdrError;
    /** What herdr saw of the submission; `observed` unless a test says otherwise. */
    saw?: "observed" | "unobserved";
    /** Run inside `agentPrompt`, to observe what the ledger says at that instant. */
    onPrompt?: Effect.Effect<void, never, BunServices>;
  } = {},
) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      stateDir,
      herdr: {
        restoreAgentName: () => Effect.succeed(false),
        agentList: () =>
          Effect.sync(() => {
            calls.push("agentList");
            return options.agents ?? [alive];
          }),
        agentSendKeys: (target: string, keys: ReadonlyArray<string>) =>
          Effect.sync(() => {
            calls.push(`agentSendKeys ${target} ${keys.join("+")}`);
          }),
        agentPrompt: (target: string, text: string) =>
          Effect.gen(function* () {
            calls.push(`agentPrompt ${target} ${text}`);
            if (options.onPrompt) yield* options.onPrompt;
            if (options.fail) return yield* Effect.fail(options.fail);
            return options.saw ?? ("observed" as const);
          }),
      },
      log: (line: string) =>
        Effect.sync(() => {
          calls.push(`log ${line}`);
        }),
    },
  };
}

/** The ledger as a list of `<id> <state>`, which is what every assertion here is about. */
const states = Effect.fn("test.states")(function* () {
  const file = yield* ledgerPath(stateDir, "term-1");
  return (yield* readLedger(file))
    .filter((line): line is Delivery => "state" in line)
    .map((line) => `${line.id} ${line.state}`);
});

test("a continuation recovers a lost name using its recorded incarnation", () =>
  runEffect(
    Effect.gen(function* () {
      const h = fake();
      let restored = false;
      const deps = {
        ...h.deps,
        herdr: {
          ...h.deps.herdr,
          agentList: () => Effect.succeed(restored ? [alive] : []),
          restoreAgentName: (target: AgentEntry) =>
            Effect.sync(() => {
              expect(target).toEqual(entry);
              restored = true;
              return true;
            }),
        },
      };
      const outcome = yield* transaction(deps, entry, (channel) =>
        channel.submit("continue with the spec", draft),
      );
      expect(outcome.ok).toBe(true);
      expect(h.calls).toContain("agentPrompt impl-1 continue with the spec");
    }),
  ));

test("the record is written before herdr is called, and settled after", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* ledgerPath(stateDir, "term-1");
      // Read from inside the fake send: the only moment that can tell "reserved before
      // the call" from "both written afterwards". Synchronously, because the observation
      // has to happen during the call and not on a later turn of the loop.
      let atSendTime: string[] = [];
      const h = fake({
        onPrompt: Effect.gen(function* () {
          atSendTime = (yield* readLedger(file))
            .filter((line): line is Delivery => "state" in line)
            .map((line) => line.state);
        }),
      });

      const outcome = yield* transaction(h.deps, entry, (channel) =>
        channel.submit("read the prompt file", draft),
      );

      expect(outcome).toEqual({ ok: true, id: "req-1-1", submission: "observed" });
      expect(atSendTime).toEqual(["reserved"]);
      expect(yield* states()).toEqual(["req-1-1 reserved", "req-1-1 submitted"]);
      // The lock is not left behind.
      expect(yield* fs.exists(`${file}.lock`)).toBe(false);
    }),
  ));

test("a submission herdr saw no turn come of is submitted, with that as its note", () =>
  runEffect(
    Effect.gen(function* () {
      const h = fake({ saw: "unobserved" });
      const outcome = yield* transaction(h.deps, entry, (channel) =>
        channel.submit("read the prompt file", draft),
      );
      // Written, so `submitted` — never rounded up to a turn nobody saw start. The note is
      // what a later reader has to tell a lost prompt from an ignored one.
      expect(outcome).toEqual({ ok: true, id: "req-1-1", submission: "unobserved" });
      const file = yield* ledgerPath(stateDir, "term-1");
      const settled = (yield* readLedger(file)).filter(
        (line): line is Delivery => "state" in line && line.state === "submitted",
      );
      expect(settled.map((line) => line.note)).toEqual(["unobserved"]);
    }),
  ));

test("collecting a step's work settles only what was known sent, never what is in doubt", () =>
  runEffect(
    Effect.gen(function* () {
      const file = yield* ledgerPath(stateDir, "term-1");
      const key = causalKey(draft.run, draft.cause, draft.intentVersion);
      // One delivery about this work in each state a reader could find it in.
      const base = {
        run: draft.run,
        incarnation: "term-1",
        agent: entry.agent,
        causal_key: key,
        cause: draft.cause,
        mode: "boundary" as const,
        text_hash: "t",
        intent_version: draft.intentVersion,
        attempt: 1,
      };
      const at = "2026-01-01T00:00:00.000Z";
      yield* appendLine(file, { ...base, id: "sent", request_id: "sent", at, state: "submitted" });
      yield* appendLine(file, {
        ...base,
        id: "acked",
        request_id: "acked",
        at,
        state: "acknowledged",
      });
      yield* appendLine(file, {
        ...base,
        id: "doubt",
        request_id: "doubt",
        at,
        state: "submitted",
        note: "unobserved",
      });
      yield* appendLine(file, { ...base, id: "held", request_id: "held", at, state: "reserved" });
      yield* appendLine(file, { ...base, id: "lost", request_id: "lost", at, state: "unknown" });
      yield* appendLine(file, {
        ...base,
        id: "other",
        request_id: "other",
        at,
        causal_key: "other-work",
        state: "submitted",
      });

      yield* settleCollected(stateDir, "term-1", key);

      const after = newestById(yield* readLedger(file));
      const state = (id: string) => [after.get(id)?.state, after.get(id)?.note];
      // Sent and taken: over, and said so.
      expect(state("sent")).toEqual(["superseded", "work_collected"]);
      expect(state("acked")).toEqual(["superseded", "work_collected"]);
      // A reservation nobody settled and a delivery nobody can account for are exactly
      // the cases a human has to reconcile; collecting an Output says nothing about them.
      expect(state("held")).toEqual(["reserved", undefined]);
      expect(state("lost")).toEqual(["unknown", undefined]);
      // Written, but herdr saw no turn come of it: an Output beside it does not say it was
      // read, so it stays in flight — an ack or a human settles it, never a collection.
      expect(state("doubt")).toEqual(["submitted", "unobserved"]);
      // Other work is other work.
      expect(state("other")).toEqual(["submitted", undefined]);
      // And the doubt still blocks a repeat of this work.
      expect(["held", "lost", "doubt"]).toContain(blocked(yield* readLedger(file), key)?.id ?? "");
    }),
  ));

test("a herdr that refuses is a failure; one that never answers is unknown", () =>
  runEffect(
    Effect.gen(function* () {
      const refused = fake({
        fail: new HerdrError({
          message: "no such agent",
          detail: "",
          code: "agent_not_found",
          answered: true,
        }),
      });
      expect(
        yield* transaction(refused.deps, entry, (channel) => channel.submit("hello", draft)),
      ).toMatchObject({ ok: false, reason: "failed" });
      expect(yield* states()).toEqual(["req-1-1 reserved", "req-1-1 failed"]);

      const silent = fake({ fail: new HerdrError({ message: "socket closed", detail: "" }) });
      expect(
        yield* transaction(silent.deps, entry, (channel) =>
          channel.submit("hello", { ...draft, requestId: "req-2" }),
        ),
      ).toMatchObject({ ok: false, reason: "unknown" });
      expect(yield* states()).toContain("req-2-1 unknown");
    }),
  ));

test("the same work is not sent twice while the first attempt is unsettled", () =>
  runEffect(
    Effect.gen(function* () {
      const silent = fake({ fail: new HerdrError({ message: "socket closed", detail: "" }) });
      yield* transaction(silent.deps, entry, (channel) => channel.submit("hello", draft));

      const h = fake();
      const again = yield* transaction(h.deps, entry, (channel) =>
        // A different request id, the same work: this is the case a request-id check
        // would miss and a causal key catches.
        channel.submit("hello again", { ...draft, requestId: "req-9" }),
      );

      expect(again).toMatchObject({ ok: false, reason: "blocked" });
      expect(h.calls.some((c) => c.startsWith("agentPrompt"))).toBe(false);
      expect(yield* states()).not.toContain("req-9-1 reserved");
    }),
  ));

test("a different agent in the same pane is not the addressee, and pending work fails", () =>
  runEffect(
    Effect.gen(function* () {
      const moved = fake({ agents: [{ ...alive, terminalId: "term-2" }] });
      const outcome = yield* transaction(moved.deps, entry, (channel) =>
        channel.submit("hello", draft),
      ).pipe(Effect.flip);

      expect(outcome).toMatchObject({ _tag: "NotDeliverable", reason: "incarnation_changed" });
      expect(moved.calls.some((c) => c.startsWith("agentPrompt"))).toBe(false);
    }),
  ));

test("an entry with no incarnation is refused before anything is read", () =>
  runEffect(
    Effect.gen(function* () {
      const legacy: AgentEntry = { ...entry };
      delete legacy.incarnation;
      const h = fake();
      const outcome = yield* transaction(h.deps, legacy, (channel) =>
        channel.submit("hello", draft),
      ).pipe(Effect.flip);

      expect(outcome).toMatchObject({ _tag: "NotDeliverable", reason: "no_incarnation" });
      expect(h.calls).toEqual([]);
    }),
  ));

test("a message over the cap is refused, and nothing is reserved for it", () =>
  runEffect(
    Effect.gen(function* () {
      const h = fake();
      const outcome = yield* transaction(h.deps, entry, (channel) =>
        channel.submit("x".repeat(MAX_DELIVERY_BYTES + 1), draft),
      );
      expect(outcome).toMatchObject({ ok: false, reason: "too_long" });
      expect(yield* states()).toEqual([]);
    }),
  ));

test("two transactions for one agent in one process is a defect, not a deadlock", () =>
  runEffect(
    Effect.gen(function* () {
      const h = fake();
      const died = yield* transaction(h.deps, entry, () =>
        transaction(h.deps, entry, (inner) => inner.submit("hello", draft)),
      ).pipe(Effect.exit);
      expect(died._tag).toBe("Failure");
    }),
  ));

test("an interrupt presses nothing in a pane whose harness has not been shown to take one", () =>
  runEffect(
    Effect.gen(function* () {
      // A capability is `unproven` until a live test records a pass; codex has none
      // recorded. The keys are the point: a refusal that arrives after Escape has already
      // been sent is not a refusal.
      const h = fake();
      const outcome = yield* transaction(h.deps, entry, (channel) =>
        interrupt(
          { ...h.deps, status: () => Effect.succeed("idle") },
          channel,
          entry,
          "stop what you are doing",
          { ...draft, harness: "codex", mode: "interrupt" },
          0,
        ),
      );

      expect(outcome).toMatchObject({ ok: false, detail: expect.stringContaining("codex") });
      expect(h.calls.some((call) => call.startsWith("agentSendKeys"))).toBe(false);
      expect(h.calls.some((call) => call.startsWith("agentPrompt"))).toBe(false);
      // Nothing was reserved either: the gate is before the ledger, not after it.
      expect(yield* states()).toEqual([]);
    }),
  ));

test("what goes out first is the human interrupting, and last is a compaction", () => {
  const due = [
    { mode: "boundary" as const, cause: { kind: "compaction" as const, ref: "c" } },
    { mode: "boundary" as const, cause: { kind: "nudge" as const, ref: "n" } },
    { mode: "boundary" as const, cause: { kind: "step" as const, ref: "build" } },
    { mode: "now" as const, cause: { kind: "steer" as const, ref: "s" } },
    { mode: "interrupt" as const, cause: { kind: "correction" as const, ref: "c1" } },
  ];
  expect(dispatchOrder(due).map((d) => d.cause.kind)).toEqual([
    "correction",
    "steer",
    "step",
    "nudge",
    "compaction",
  ]);
});

test("the order survives the inbox, whose decode types mode and cause as plain strings", () => {
  // What `takeBoundaryFor` hands this: the inbox payload, not a typed Cause. An unknown
  // kind used to make the comparison NaN, which left the whole batch in arrival order —
  // so a correction and a steer that came due together went out however they landed.
  const queued = [
    { mode: "boundary", cause: { kind: "handoff", ref: "h" } },
    { mode: "boundary", cause: { kind: "from-a-newer-collie", ref: "?" } },
    { mode: "boundary", cause: { kind: "steer", ref: "s" } },
    { mode: "boundary", cause: { kind: "correction", ref: "c1" } },
  ];
  expect(dispatchOrder(queued).map((d) => d.cause.kind)).toEqual([
    "correction",
    "steer",
    "handoff",
    "from-a-newer-collie",
  ]);
});

test("a boundary steer is composed in front of the work, with its acknowledgement", () => {
  expect(steeringSection("/runs/r1", [])).toBe("");
  const section = steeringSection("/runs/r1", [
    { id: "d1", text: "stay inside src/", intentVersion: 2, attempt: 1 },
  ]);
  expect(section.startsWith("## Steering\n")).toBe(true);
  expect(section).toContain("(d1) stay inside src/");
  expect(section).toContain("/runs/r1/steering/acks/d1.json");
  expect(section).toContain("collie-delivery:d1");
  expect(section).toContain('"intent_version":2');
});
