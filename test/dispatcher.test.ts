// The Dispatcher's whole reason to exist is what happens when a send goes wrong, so
// that is what is tested: the record written before herdr is called, a herdr that
// refuses versus one that never answers, and an agent that is no longer the one the
// message was addressed to.

import type { BunServices } from "@effect/platform-bun/BunServices";
import { DateTime, Effect, FileSystem } from "effect";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { HerdrError, type AgentInfo } from "../src/herdr";
import {
  dispatchOrder,
  interrupt,
  transaction,
  MAX_DELIVERY_BYTES,
  submitPatiently,
  marked,
  carriedDelivery,
  confirmSubmitted,
  deliveryText,
  fitDelivery,
  DELIVERY_TOKEN,
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
import { FakeBin } from "./support/bin";

test("every delivery mode carries the agent Actor's sender line before its unchanged words", () =>
  runEffect(
    Effect.gen(function* () {
      const bin = yield* FakeBin.make(`${stateDir}/bin`);
      yield* Effect.addFinalizer(() => bin.restore());
      yield* bin.add("claude", "echo 2.1.300");
      for (const mode of ["now", "boundary", "interrupt"] as const) {
        const source = {
          origin: "agent" as const,
          from: {
            run: "r-source",
            agent: "source-agent",
            machine: { installation: "source-id", name: "laptop" },
          },
        };
        const text = "the question\n  exactly as written";
        const sent = fake();
        const result = yield* transaction(sent.deps, entry, (channel) =>
          channel.submit(text, {
            ...draft,
            cause: { kind: "steer", ref: `source-${mode}` },
            requestId: `source-${mode}`,
            harness: "claude",
            mode,
            actor: source,
          }),
        );
        expect(result.ok).toBe(true);
        expect(sent.calls.find((line) => line.startsWith("agentPrompt"))).toContain(
          `From source-agent of r-source on laptop. Answer with collie_do deliver to r-source (or collie run steer r-source --operation source-agent "…").\n${text}`,
        );
      }
    }),
  ));

const MINUTE = String.raw`\d{4}-\d{2}-\d{2} \d{2}:\d{2} [+-]\d{2}:\d{2}`;
const AT = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-16T12:02:30Z"));

test("each door's Delivery names its sender on its first line, and Collie's own carry none", () => {
  const firstLine = (actor?: Parameters<typeof deliveryText>[1]) =>
    deliveryText("merge it", actor, AT).split("\n")[0];
  expect(firstLine({ origin: "board" })).toMatch(
    new RegExp(`^From the human, on the board, ${MINUTE}\\.$`),
  );
  expect(firstLine({ origin: "desktop" })).toMatch(
    new RegExp(`^From the human, in Desktop, ${MINUTE}\\.$`),
  );
  expect(firstLine({ origin: "cli-tty" })).toMatch(
    new RegExp(`^From the human, in a terminal, ${MINUTE}\\.$`),
  );
  for (const door of ["cli", "driver", "evaluator", "schedule"] as const)
    expect(firstLine({ origin: door })).toMatch(new RegExp(`^From ${door}, ${MINUTE}\\.$`));
  expect(firstLine({ origin: "chat" })).toMatch(new RegExp(`^From chat, ${MINUTE}\\.$`));
  const chatting = firstLine({
    origin: "chat",
    conversation: "c-1",
    said: "merge it, token glpat-abcdefghijklmnopqrst",
  });
  expect(chatting).toMatch(new RegExp(`^From chat for the human, ${MINUTE}\\. The human said: "`));
  expect(chatting).toEndWith(`The human said: "merge it, token <gitlab token>"`);
  expect(deliveryText("merge it", undefined, AT)).toBe("merge it");
  expect(
    deliveryText(
      "merge it",
      { origin: "agent", from: { run: "r-source", agent: "source-agent" } },
      AT,
    ),
  ).toBe(
    `From source-agent of r-source on this Machine. Answer with collie_do deliver to r-source (or collie run steer r-source --operation source-agent "…").\nmerge it`,
  );
});

test("a fallback that is itself over the paste budget is still typed, and its receipt says so", () =>
  runEffect(
    Effect.gen(function* () {
      const into = `${stateDir}/${"long-state-directory/".repeat(30)}runs/r1/attachments`;
      const token = `${DELIVERY_TOKEN}r1-req-1-steer-1`;
      const fitted = yield* fitDelivery(into, token, "first\nsecond", { origin: "board" });
      const typed = `${token}\n${deliveryText(fitted.words, fitted.actor, AT)}`;
      expect(typed.split("\n")).toHaveLength(3);
      expect(typed.length).toBeGreaterThan(700);
      expect(fitted.words).toStartWith(`Their message is in ${into}/message-`);
      expect(fitted.kept).toContain("Kept as a file in the Run.");
      expect(fitted.kept).toContain("over the budget");
    }),
  ));

test("an agent's long sender line counts against the budget, and its kept words stay that agent's", () =>
  runEffect(
    Effect.gen(function* () {
      const into = `${stateDir}/runs/r1/attachments`;
      const token = `${DELIVERY_TOKEN}r1-req-2-steer-1`;
      const source = { origin: "agent" as const, from: { run: "r-source", agent: "source-agent" } };
      const words = "w".repeat(560);
      expect((yield* fitDelivery(into, token, words, { origin: "board" })).kept).toBeNull();
      const fitted = yield* fitDelivery(into, token, words, source);
      expect(fitted.words).toEndWith(". Read it whole and act on it as that agent's.");
      const file = /^Their message is in (\S+)\./.exec(fitted.words)?.[1] ?? "";
      expect(yield* (yield* FileSystem.FileSystem).readFileString(file)).toBe(words);
      expect(fitted.kept).not.toContain("over the budget");
    }),
  ));

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
    /** Only the first this many prompts fail; every one after is taken. */
    failing?: number;
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
            const prompted = calls.filter((call) => call.startsWith("agentPrompt")).length;
            if (options.fail && prompted <= (options.failing ?? Infinity))
              return yield* Effect.fail(options.fail);
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
      expect(h.calls).toContain(
        "agentPrompt impl-1 collie-delivery:req-1-1\ncontinue with the spec",
      );
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
      // Sent, then taken: herdr saw a turn start from it.
      expect(yield* states()).toEqual([
        "req-1-1 reserved",
        "req-1-1 submitted",
        "req-1-1 acknowledged",
      ]);
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

test("a steer to a busy agent is taken once a turn starts after it settles, and recorded acknowledged", () =>
  runEffect(
    Effect.gen(function* () {
      const steer = { ...draft, cause: { kind: "steer" as const, ref: "s-1" }, requestId: "s-1" };
      const sent = yield* transaction(fake({ saw: "unobserved" }).deps, entry, (channel) =>
        channel.submit("keep going", steer),
      );
      expect(sent).toMatchObject({ ok: true, submission: "unobserved" });
      // Busy with its own turn, then between turns, then on a turn this message started.
      const statuses = ["working", "idle", "working"] as const;
      let looked = 0;
      const how = yield* confirmSubmitted(
        {
          stateDir,
          herdr: {
            agentStatus: () => Effect.succeed(statuses[Math.min(looked++, 2)]!),
            promptBox: () => Effect.succeed(""),
            agentPressEnter: () => Effect.void,
          },
          log: () => Effect.void,
          taken: () => Effect.succeed(null),
          pollMs: 1,
          graceMs: 60_000,
        },
        entry,
        [causalKey(steer.run, steer.cause, steer.intentVersion)],
      );
      expect(how).toBe("a turn started");
      const last = (yield* readLedger(yield* ledgerPath(stateDir, "term-1"))).at(-1);
      expect(last).toMatchObject({ state: "acknowledged", note: "taken: a turn started" });
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

/** herdr's answer for a pane showing a dialog: a fact about the pane, not about the prompt. */
const paneBusy = new HerdrError({
  message: "herdr agent prompt failed (exit 1)",
  detail: '{"error":{"code":"agent_blocked","message":"agent impl-1 is blocked"}}',
  code: "agent_blocked",
  answered: true,
});

const quick = { firstMs: 1, maxMs: 4, forMs: 60_000 };

const ledgerLines = Effect.fn("test.ledgerLines")(function* () {
  const file = yield* ledgerPath(stateDir, "term-1");
  return (yield* readLedger(file)).filter((line): line is Delivery => "state" in line);
});

const prompted = (calls: ReadonlyArray<string>) =>
  calls.filter((call) => call.startsWith("agentPrompt")).length;

test("a pane that refuses while it is busy is retried until it takes the prompt, as one delivery", () =>
  runEffect(
    Effect.gen(function* () {
      const h = fake({ fail: paneBusy, failing: 3 });
      const outcome = yield* submitPatiently(h.deps, entry, "read the prompt file", draft, quick);

      expect(outcome).toEqual({ ok: true, id: "req-1-1", submission: "observed" });
      // Four tries and one of them taken: one turn for one prompt.
      expect(prompted(h.calls)).toBe(4);
      const lines = yield* ledgerLines();
      // Every try is on the ledger, under the one identity the first reservation had.
      expect(new Set(lines.map((line) => line.id))).toEqual(new Set(["req-1-1"]));
      expect(lines.map((line) => line.state)).toEqual([
        "reserved",
        "deferred",
        "reserved",
        "deferred",
        "reserved",
        "deferred",
        "reserved",
        "submitted",
        "acknowledged",
      ]);
      expect(lines.filter((line) => line.state === "deferred").map((line) => line.code)).toEqual([
        "agent_blocked",
        "agent_blocked",
        "agent_blocked",
      ]);
    }),
  ));

test("a refusal herdr does not call momentary is not retried, and neither is a send nobody answered", () =>
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
      expect(yield* submitPatiently(refused.deps, entry, "hello", draft, quick)).toMatchObject({
        ok: false,
        reason: "failed",
      });
      expect(prompted(refused.calls)).toBe(1);
      expect((yield* ledgerLines()).at(-1)).toMatchObject({
        state: "failed",
        code: "agent_not_found",
      });

      const silent = fake({ fail: new HerdrError({ message: "socket closed", detail: "" }) });
      expect(
        yield* submitPatiently(
          silent.deps,
          entry,
          "hello",
          { ...draft, requestId: "req-2" },
          quick,
        ),
      ).toMatchObject({ ok: false, reason: "unknown" });
      expect(prompted(silent.calls)).toBe(1);
      expect(yield* states()).toContain("req-2-1 unknown");
    }),
  ));

test("a pane that stays busy past the deadline is given up on, and says what held and for how long", () =>
  runEffect(
    Effect.gen(function* () {
      const h = fake({ fail: paneBusy });
      const outcome = yield* submitPatiently(h.deps, entry, "hello", draft, {
        firstMs: 5,
        maxMs: 10,
        forMs: 40,
      });

      expect(outcome).toMatchObject({ ok: false, id: "req-1-1", reason: "exhausted" });
      const detail = outcome.ok ? "" : outcome.detail;
      expect(detail).toMatch(/^agent_blocked held for \d+s over \d+ attempts$/);
      expect(prompted(h.calls)).toBeGreaterThan(1);
      // Settled, so the same work is free to go out again once somebody resumes it.
      const last = (yield* ledgerLines()).at(-1);
      expect(last).toMatchObject({ state: "failed", code: "agent_blocked", note: detail });
      // Told apart in the Run's log from a refusal that was never retried.
      expect(h.calls.filter((call) => call.startsWith("log ") && call.includes("gave up"))).toEqual(
        [`log not sent to impl-1: ${detail}; gave up`],
      );
    }),
  ));

test("a delivery left waiting on a busy pane is picked up under its own id, and no other copy goes out", () =>
  runEffect(
    Effect.gen(function* () {
      // One try and then nobody came back for it: the process went during the wait.
      const busy = fake({ fail: paneBusy });
      yield* transaction(busy.deps, entry, (channel) =>
        channel.submit("hello", { ...draft, patienceMs: 60_000 }),
      );
      expect(yield* states()).toEqual(["req-1-1 reserved", "req-1-1 deferred"]);

      const other = fake();
      expect(
        yield* submitPatiently(other.deps, entry, "hello", { ...draft, requestId: "req-9" }, quick),
      ).toMatchObject({ ok: false, reason: "blocked" });
      expect(prompted(other.calls)).toBe(0);

      const same = fake();
      expect(yield* submitPatiently(same.deps, entry, "hello", draft, quick)).toMatchObject({
        ok: true,
        id: "req-1-1",
      });
      expect(prompted(same.calls)).toBe(1);
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

test("a prompt's delivery token is near its top, and a slash command keeps its first line", () => {
  expect(marked("do the thing", "d1")).toBe("collie-delivery:d1\ndo the thing");
  expect(marked("/implement do the thing\nmore", "d1")).toBe(
    "/implement do the thing\ncollie-delivery:d1\nmore",
  );
  // What the submit hook reads back is that same delivery, not a steering item's inside it.
  expect(carriedDelivery(marked("item\ncollie-delivery:item-1", "d1"))).toBe("d1");
});
