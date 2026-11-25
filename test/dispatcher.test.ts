import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import type { PlatformServices } from "../src/platform";
import { Clock, DateTime, Deferred, Effect, Fiber, FileSystem } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { HerdrError } from "../src/herdr";
import type { AgentInfo } from "../src/herdr";
import {
  dispatchOrder,
  interrupt,
  transaction,
  MAX_DELIVERY_BYTES,
  SUBMIT_TIMEOUT_MS,
  submitPatiently,
  marked,
  carriedDelivery,
  confirmSubmitted,
  deliveryText,
  fitDelivery,
  DELIVERY_TOKEN,
} from "../src/dispatcher";
import { appendLine, causalKey, readLedger } from "../src/steering";
import { writeEvent } from "../src/compactors";
import { controlDir } from "../src/compaction";
import { isoAt } from "../src/time";
import type { Delivery } from "../src/steering";
import type { Records } from "../src/records";
import { reason } from "../src/naming";
import type { AgentEntry } from "../src/registry";
import { fastForward, runEffect } from "./support/effect";
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
        expect(
          Option.getOrUndefined(
            Arr.findFirst(sent.calls, (line) => pipe_(line, Str.startsWith("agentPrompt"))),
          ),
        ).toContain(
          `From source-agent of r-source on laptop. Answer with collie_do deliver to r-source (or collie run steer r-source --operation source-agent "…").\n${text}`,
        );
      }
    }),
  ));

const MINUTE = String.raw`\d{4}-\d{2}-\d{2} \d{2}:\d{2} [+-]\d{2}:\d{2}`;
const AT = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-16T12:02:30Z"));

test("each door's Delivery names its sender on its first line, and Collie's own carry none", () => {
  const firstLine = (actor?: Parameters<typeof deliveryText>[1]) =>
    Str.split(deliveryText("merge it", actor, AT), "\n")[0];
  expect(firstLine({ origin: "board" })).toMatch(
    new RegExp(`^From the human, on the board, ${MINUTE}\\.$`),
  );
  expect(firstLine({ origin: "desktop" })).toMatch(
    new RegExp(`^From the human, in Desktop, ${MINUTE}\\.$`),
  );
  expect(firstLine({ origin: "cli-tty" })).toMatch(
    new RegExp(`^From the human, in a terminal, ${MINUTE}\\.$`),
  );
  for (const door of ["cli", "driver", "evaluator", "schedule"] as const) {
    expect(firstLine({ origin: door })).toMatch(new RegExp(`^From ${door}, ${MINUTE}\\.$`));
  }
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
      const into = `${stateDir}/${pipe_("long-state-directory/", Str.repeat(30))}runs/r1/attachments`;
      const token = `${DELIVERY_TOKEN}r1-req-1-steer-1`;
      const fitted = yield* fitDelivery(into, token, "first\nsecond", { origin: "board" });
      const typed = `${token}\n${deliveryText(fitted.words, fitted.actor, AT)}`;
      expect(Str.split(typed, "\n")).toHaveLength(3);
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
      const words = pipe_("w", Str.repeat(560));
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
  incarnation: { terminalId: "term-1", agentSession: null, backend: "core" },
};

const alive: AgentInfo = {
  name: "impl-1",
  paneId: "1-9",
  status: "idle",
  terminalId: "term-1",
  cwd: "/project",
  foregroundCwd: null,
};

const draft = {
  run: "r1",
  cause: { kind: "step" as const, ref: "build" },
  mode: "boundary" as const,
  intentVersion: 1,
  attempt: 1,
  requestId: "req-1",
};

function fake(
  options: {
    agents?: Array<AgentInfo>;
    list?: ReadonlyArray<Array<AgentInfo> | HerdrError>;
    fail?: HerdrError;
    failing?: number;
    saw?: "observed" | "unobserved";
    onPrompt?: Effect.Effect<void, never, PlatformServices>;
  } = {},
) {
  const calls: Array<string> = [];
  let listed = 0;
  return {
    calls,
    deps: {
      stateDir,
      herdr: {
        agentList: () =>
          Effect.gen(function* () {
            calls.push("agentList");
            const next = (options.list ?? []).at(listed++);
            if (next instanceof HerdrError) {
              return yield* next;
            }
            return next ?? options.agents ?? [alive];
          }),
        agentSendKeys: (target: string, keys: ReadonlyArray<string>) =>
          Effect.sync(() => {
            calls.push(`agentSendKeys ${target} ${Arr.join(keys, "+")}`);
          }),
        agentPrompt: (target: string, text: string) =>
          Effect.gen(function* () {
            calls.push(`agentPrompt ${target} ${text}`);
            if (options.onPrompt) {
              yield* options.onPrompt;
            }
            const prompted = Arr.filter(calls, (call) =>
              pipe_(call, Str.startsWith("agentPrompt")),
            ).length;
            if (options.fail && prompted <= (options.failing ?? Infinity)) {
              return yield* options.fail;
            }
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

const states = Effect.fn("test.states")(function* () {
  return Arr.map(
    Arr.filter(yield* readLedger("term-1"), (line): line is Delivery => "state" in line),
    (line) => `${line.id} ${line.state}`,
  );
});

test("a continuation refuses an agent core no longer lists", () =>
  runEffect(
    Effect.gen(function* () {
      const h = fake({ agents: [] });
      const outcome = yield* transaction(h.deps, entry, (channel) =>
        channel.submit("continue with the spec", draft),
      ).pipe(Effect.flip);
      expect(outcome).toMatchObject({ _tag: "NotDeliverable", reason: "agent_gone" });
      expect(h.calls).toEqual(["agentList"]);
      expect(yield* states()).toEqual([]);
    }),
  ));

test("the record is written before core is called, and settled after", () =>
  runEffect(
    Effect.gen(function* () {
      const records = yield* Effect.context<Records>();
      // WARNING: Read inside the fake send: the only moment that tells "reserved before the call" from "both written after". It must be synchronous.
      let atSendTime: Array<string> = [];
      const h = fake({
        onPrompt: Effect.gen(function* () {
          atSendTime = Arr.map(
            Arr.filter(
              yield* readLedger("term-1").pipe(Effect.provideContext(records)),
              (line): line is Delivery => "state" in line,
            ),
            (line) => line.state,
          );
        }),
      });

      const outcome = yield* transaction(h.deps, entry, (channel) =>
        channel.submit("read the prompt file", draft),
      );

      expect(outcome).toEqual({ ok: true, id: "req-1-1", submission: "observed" });
      expect(atSendTime).toEqual(["reserved"]);
      expect(yield* states()).toEqual([
        "req-1-1 reserved",
        "req-1-1 submitted",
        "req-1-1 acknowledged",
      ]);
    }),
  ));

test("a submission core saw no turn come of is submitted, with that as its note", () =>
  runEffect(
    Effect.gen(function* () {
      const h = fake({ saw: "unobserved" });
      const outcome = yield* transaction(h.deps, entry, (channel) =>
        channel.submit("read the prompt file", draft),
      );
      // WARNING: Written as submitted, never rounded up to a turn nobody saw start; the note tells a lost prompt from an ignored one.
      expect(outcome).toEqual({ ok: true, id: "req-1-1", submission: "unobserved" });
      const settled = Arr.filter(
        yield* readLedger("term-1"),
        (line): line is Delivery => "state" in line && line.state === "submitted",
      );
      expect(Arr.map(settled, (line) => line.note)).toEqual(["unobserved"]);
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
      const statuses = ["working", "idle", "working"] as const;
      let looked = 0;
      const how = yield* confirmSubmitted(
        {
          stateDir,
          herdr: {
            agentStatus: () => Effect.succeed(statuses[Math.min(looked++, 2)]!),
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
      const last = (yield* readLedger("term-1")).at(-1);
      expect(last).toMatchObject({ state: "acknowledged", note: "taken: a turn started" });
    }),
  ));

test("a core that refuses is a failure; one that never answers is unknown", () =>
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

const paneBusy = new HerdrError({
  message: "core terminal.send refused",
  detail: '{"error":{"code":"agent_blocked","message":"agent impl-1 is blocked"}}',
  code: "agent_blocked",
  answered: true,
});

const quick = { firstMs: 1, maxMs: 4, forMs: 60_000 };

const ledgerLines = Effect.fn("test.ledgerLines")(function* () {
  return Arr.filter(yield* readLedger("term-1"), (line): line is Delivery => "state" in line);
});

const prompted = (calls: ReadonlyArray<string>) =>
  Arr.filter(calls, (call) => pipe_(call, Str.startsWith("agentPrompt"))).length;

const pending = (state: "reserved" | "deferred", id: string) =>
  appendLine({
    id,
    at: entry.at,
    run: draft.run,
    incarnation: "term-1",
    agent: entry.agent,
    causal_key: causalKey(draft.run, { kind: "step", ref: id }, draft.intentVersion),
    request_id: id,
    cause: { kind: "step", ref: id },
    mode: draft.mode,
    text_hash: `${id}-text`,
    intent_version: draft.intentVersion,
    attempt: 1,
    state,
  });

const unread = new HerdrError({ message: "core is restarting", detail: "" });

const pendingStates = Effect.fn("test.pendingStates")(function* () {
  return Arr.map(
    Arr.filter(yield* ledgerLines(), (line) =>
      Arr.some(["pending-1", "pending-2"], (id) => id === line.id),
    ),
    (line) => `${line.id} ${line.state}`,
  );
});

test("a roster that did not answer refuses the send and settles no pending delivery", () =>
  runEffect(
    Effect.gen(function* () {
      yield* pending("reserved", "pending-1");
      yield* pending("deferred", "pending-2");
      const h = fake({ list: [unread] });
      const outcome = yield* transaction(h.deps, entry, (channel) =>
        channel.submit("carry on", draft),
      ).pipe(Effect.flip);
      expect(outcome).toMatchObject({ _tag: "NotDeliverable", reason: "roster_unread" });
      expect(h.calls).toEqual(["agentList"]);
      expect(yield* pendingStates()).toEqual(["pending-1 reserved", "pending-2 deferred"]);
    }),
  ));

test("a roster that did not answer when the listing went stale refuses the send and settles nothing", () =>
  runEffect(
    fastForward(
      Effect.gen(function* () {
        yield* pending("reserved", "pending-1");
        const h = fake({ list: [[alive], unread] });
        const outcome = yield* transaction(h.deps, entry, (channel) =>
          Effect.gen(function* () {
            yield* TestClock.adjust("6 seconds");
            return yield* channel.submit("carry on", draft);
          }),
        );
        expect(outcome).toMatchObject({
          ok: false,
          reason: "deferred",
          detail: expect.stringContaining("could not be read"),
        });
        expect(prompted(h.calls)).toBe(0);
        expect(yield* pendingStates()).toEqual(["pending-1 reserved"]);
      }),
    ),
  ));

test("a pane that refuses while it is busy is retried until it takes the prompt, as one delivery", () =>
  runEffect(
    Effect.gen(function* () {
      const h = fake({ fail: paneBusy, failing: 3 });
      const outcome = yield* submitPatiently(h.deps, entry, "read the prompt file", draft, quick);

      expect(outcome).toEqual({ ok: true, id: "req-1-1", submission: "observed" });
      expect(prompted(h.calls)).toBe(4);
      const lines = yield* ledgerLines();
      expect(new Set(Arr.map(lines, (line) => line.id))).toEqual(new Set(["req-1-1"]));
      expect(Arr.map(lines, (line) => line.state)).toEqual([
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
      expect(
        Arr.map(
          Arr.filter(lines, (line) => line.state === "deferred"),
          (line) => line.code,
        ),
      ).toEqual(["agent_blocked", "agent_blocked", "agent_blocked"]);
    }),
  ));

test("a refusal core does not call momentary is not retried, and neither is a send nobody answered", () =>
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
      const last = (yield* ledgerLines()).at(-1);
      expect(last).toMatchObject({ state: "failed", code: "agent_blocked", note: detail });
      expect(
        Arr.filter(
          h.calls,
          (call) => pipe_(call, Str.startsWith("log ")) && pipe_(call, Str.includes("gave up")),
        ),
      ).toEqual([`log not sent to impl-1: ${detail}; gave up`]);
    }),
  ));

test("a delivery left waiting on a busy pane is picked up under its own id, and no other copy goes out", () =>
  runEffect(
    Effect.gen(function* () {
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
        // WARNING: A different request id for the same work: a request-id check would miss it and a causal key catches it.
        channel.submit("hello again", { ...draft, requestId: "req-9" }),
      );

      expect(again).toMatchObject({ ok: false, reason: "blocked" });
      expect(Arr.some(h.calls, (c) => pipe_(c, Str.startsWith("agentPrompt")))).toBe(false);
      expect(yield* states()).not.toContain("req-9-1 reserved");
    }),
  ));

const answerDraft = {
  ...draft,
  cause: { kind: "steer" as const, ref: "ask-review-1" },
  requestId: "answer-1",
};

const answerKey = causalKey(answerDraft.run, answerDraft.cause, answerDraft.intentVersion);

const answerLine = (state: "reserved" | "unknown", at: string) =>
  appendLine({
    id: "answer-1-1",
    at,
    run: answerDraft.run,
    incarnation: "term-1",
    agent: entry.agent,
    causal_key: answerKey,
    request_id: answerDraft.requestId,
    cause: answerDraft.cause,
    mode: answerDraft.mode,
    text_hash: "answer-text",
    intent_version: answerDraft.intentVersion,
    attempt: 1,
    state,
  });

const recordedSubmit = (delivery: string, incarnation: string) =>
  Effect.flatMap(controlDir(stateDir, entry.agent), (dir) =>
    writeEvent(dir, { session: null, kind: "submit", reason: "collie", delivery, incarnation }),
  );

const answerNow = Effect.fn("test.answerNow")(function* () {
  return Option.getOrThrow(Arr.findLast(yield* ledgerLines(), (line) => line.id === "answer-1-1"));
});

const nudge = { ...draft, cause: { kind: "nudge" as const, ref: "n-1" }, requestId: "n-1" };

test("a lost send result settles as acknowledged when the agent's submit hook recorded that delivery from the incarnation it went to", () =>
  runEffect(
    Effect.gen(function* () {
      yield* answerLine(
        "reserved",
        isoAt((yield* Clock.currentTimeMillis) - SUBMIT_TIMEOUT_MS - 1000),
      );
      yield* recordedSubmit("answer-1-1", "term-1");

      const h = fake();
      const follow = yield* transaction(h.deps, entry, (channel) =>
        channel.submit("carry on", nudge),
      );

      expect(follow).toMatchObject({ ok: true });
      expect(prompted(h.calls)).toBe(1);
      expect(yield* answerNow()).toMatchObject({
        state: "acknowledged",
        note: "taken: its submit hook recorded it",
      });
      expect(yield* states()).not.toContain("answer-1-1 unknown");
    }),
  ));

test("a delivery already unknown settles once its submit hook records it, and a restarted host settles it as it reaches the agent again", () =>
  runEffect(
    Effect.gen(function* () {
      yield* answerLine("unknown", isoAt(yield* Clock.currentTimeMillis));

      const before = fake();
      const held = yield* transaction(before.deps, entry, (channel) =>
        channel.submit("the answer", { ...answerDraft, requestId: "answer-2" }),
      );
      expect(held).toMatchObject({ ok: false, reason: "blocked", held: "unknown" });
      expect(prompted(before.calls)).toBe(0);

      yield* recordedSubmit("answer-1-1", "term-1");

      const restarted = fake();
      const again = yield* transaction(restarted.deps, entry, (channel) =>
        channel.submit("the answer", { ...answerDraft, requestId: "answer-2" }),
      );

      expect(again).toMatchObject({ ok: false, reason: "blocked", held: "acknowledged" });
      expect(prompted(restarted.calls)).toBe(0);
      expect(yield* answerNow()).toMatchObject({
        state: "acknowledged",
        note: "taken: its submit hook recorded it",
      });
    }),
  ));

test.each([
  ["another incarnation's record", "answer-1-1", "term-2"],
  ["another delivery's record", "answer-9-1", "term-1"],
] as const)(
  "%s leaves an unknown delivery unknown, and nothing is resent",
  (_case, delivery, incarnation) =>
    runEffect(
      Effect.gen(function* () {
        yield* answerLine("unknown", isoAt(yield* Clock.currentTimeMillis));
        yield* recordedSubmit(delivery, incarnation);

        const h = fake();
        const again = yield* transaction(h.deps, entry, (channel) =>
          channel.submit("the answer", { ...answerDraft, requestId: "answer-2" }),
        );

        expect(again).toMatchObject({ ok: false, reason: "blocked", held: "unknown" });
        expect(prompted(h.calls)).toBe(0);
        expect(yield* answerNow()).toMatchObject({ state: "unknown" });
      }),
    ),
);

test("no submit record at all leaves an unknown delivery unknown, and nothing is resent", () =>
  runEffect(
    Effect.gen(function* () {
      yield* answerLine("unknown", isoAt(yield* Clock.currentTimeMillis));

      const h = fake();
      const again = yield* transaction(h.deps, entry, (channel) =>
        channel.submit("the answer", { ...answerDraft, requestId: "answer-2" }),
      );

      expect(again).toMatchObject({ ok: false, reason: "blocked", held: "unknown" });
      expect(prompted(h.calls)).toBe(0);
      expect(yield* answerNow()).toMatchObject({ state: "unknown" });
    }),
  ));

test("a different agent in the same pane is not the addressee", () =>
  runEffect(
    Effect.gen(function* () {
      const moved = fake({ agents: [{ ...alive, terminalId: "term-2" }] });
      const outcome = yield* transaction(moved.deps, entry, (channel) =>
        channel.submit("hello", draft),
      ).pipe(Effect.flip);

      expect(outcome).toMatchObject({ _tag: "NotDeliverable", reason: "incarnation_changed" });
      expect(Arr.some(moved.calls, (c) => pipe_(c, Str.startsWith("agentPrompt")))).toBe(false);
    }),
  ));

test.each([
  ["gone", "reserved", "unknown"],
  ["gone", "deferred", "failed"],
  ["replaced", "reserved", "unknown"],
  ["replaced", "deferred", "failed"],
] as const)("a %s incarnation leaves a %s delivery %s", (lost, state, settled) =>
  runEffect(
    Effect.gen(function* () {
      yield* appendLine({
        id: "pending-1",
        at: entry.at,
        run: draft.run,
        incarnation: "term-1",
        agent: entry.agent,
        causal_key: causalKey(draft.run, draft.cause, draft.intentVersion),
        request_id: "pending",
        cause: draft.cause,
        mode: draft.mode,
        text_hash: "pending-text",
        intent_version: draft.intentVersion,
        attempt: 1,
        state,
      });
      const gone = fake({ agents: lost === "gone" ? [] : [{ ...alive, terminalId: "term-2" }] });
      yield* transaction(gone.deps, entry, (channel) => channel.submit("carry on", draft)).pipe(
        Effect.flip,
      );
      expect((yield* ledgerLines()).at(-1)).toMatchObject({ id: "pending-1", state: settled });
      const restored = fake();
      const retry = yield* transaction(restored.deps, entry, (channel) =>
        channel.submit("carry on", draft),
      );
      expect(retry).toMatchObject(
        state === "reserved" ? { ok: false, reason: "blocked" } : { ok: true },
      );
      expect(prompted(restored.calls)).toBe(state === "reserved" ? 0 : 1);
    }),
  ),
);

test("a Herdr 1 incarnation cannot address a core terminal with the same name and id", () =>
  runEffect(
    Effect.gen(function* () {
      const legacy: AgentEntry = {
        ...entry,
        incarnation: { terminalId: "term-1", agentSession: null },
      };
      const h = fake();
      const outcome = yield* transaction(h.deps, legacy, (channel) =>
        channel.submit("hello", draft),
      ).pipe(Effect.flip);

      expect(outcome).toMatchObject({ _tag: "NotDeliverable", reason: "agent_gone" });
      expect(h.calls).toEqual(["agentList"]);
      expect(yield* states()).toEqual([]);
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
        channel.submit(Str.repeat(MAX_DELIVERY_BYTES + 1)("x"), draft),
      );
      expect(outcome).toMatchObject({ ok: false, reason: "too_long" });
      expect(yield* states()).toEqual([]);
    }),
  ));

test("a second transaction for one agent in one process fails at once, saying the ledger is held", () =>
  runEffect(
    Effect.gen(function* () {
      const h = fake();
      const refused = yield* transaction(h.deps, entry, () =>
        transaction(h.deps, entry, (inner) => inner.submit("hello", draft)),
      ).pipe(Effect.flip);
      expect(reason(refused)).toContain("impl-1");
      expect(reason(refused)).toContain("already open");
      expect(prompted(h.calls)).toBe(0);
    }),
  ));

const holdingTheLedger = {
  "another transaction in this process": (until: Effect.Effect<void>) =>
    transaction(fake().deps, entry, () => until),
};

for (const [holder, hold] of Rec.toEntries(holdingTheLedger)) {
  test(`a patient submission waits out ${holder} on the agent's ledger, then delivers once`, () =>
    runEffect(
      fastForward(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const holding = yield* Effect.forkScoped(
            hold(
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
            ),
          );
          yield* Deferred.await(entered);
          const h = fake();
          const from = yield* Clock.currentTimeMillis;
          const submitting = yield* Effect.forkScoped(
            submitPatiently(h.deps, entry, "read the prompt file", draft),
          );
          while ((yield* Clock.currentTimeMillis) - from < 20_000) {
            yield* TestClock.withLive(Effect.sleep("5 millis"));
          }

          expect(submitting.pollUnsafe()).toBeUndefined();
          expect(prompted(h.calls)).toBe(0);
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(holding);
          expect(yield* Fiber.join(submitting)).toMatchObject({ ok: true, id: "req-1-1" });
          expect(Arr.filter(h.calls, (call) => pipe_(call, Str.startsWith("agentPrompt")))).toEqual(
            [`agentPrompt impl-1 ${marked("read the prompt file", "req-1-1")}`],
          );
          expect(yield* states()).toEqual([
            "req-1-1 reserved",
            "req-1-1 submitted",
            "req-1-1 acknowledged",
          ]);
        }),
      ),
    ));
}

test("an interrupt presses nothing in a pane whose harness has not been shown to take one", () =>
  runEffect(
    Effect.gen(function* () {
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
      expect(Arr.some(h.calls, (call) => pipe_(call, Str.startsWith("agentSendKeys")))).toBe(false);
      expect(Arr.some(h.calls, (call) => pipe_(call, Str.startsWith("agentPrompt")))).toBe(false);
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
  expect(Arr.map(dispatchOrder(due), (d) => d.cause.kind)).toEqual([
    "correction",
    "steer",
    "step",
    "nudge",
    "compaction",
  ]);
});

test("the order survives the inbox, whose decode types mode and cause as plain strings", () => {
  // WARNING: An unknown kind used to make the comparison NaN, leaving the batch in arrival order.
  const queued = [
    { mode: "boundary", cause: { kind: "handoff", ref: "h" } },
    { mode: "boundary", cause: { kind: "from-a-newer-collie", ref: "?" } },
    { mode: "boundary", cause: { kind: "steer", ref: "s" } },
    { mode: "boundary", cause: { kind: "correction", ref: "c1" } },
  ];
  expect(Arr.map(dispatchOrder(queued), (d) => d.cause.kind)).toEqual([
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
  expect(carriedDelivery(marked("item\ncollie-delivery:item-1", "d1"))).toBe("d1");
});

test("a prompt quoting a delivery token is not read as that delivery being submitted", () => {
  expect(carriedDelivery("see collie-delivery:d1 for the last one")).toBeNull();
  expect(carriedDelivery("collie-delivery:d1 is what the agent quoted")).toBeNull();
  expect(carriedDelivery("a note\ncollie-delivery:d1\nmore")).toBeNull();
  expect(carriedDelivery("collie-delivery:\nno id")).toBeNull();
});
