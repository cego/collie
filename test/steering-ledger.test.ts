// The ledgers exist to answer "was this already sent" and "has this cost too much"
// after a crash, so what is tested here is what they say when nobody came back: an
// unsettled reservation, a second attempt at the same work, a failed model call.

import { Effect, FileSystem, Path, Schema } from "effect";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  appendLine,
  blocked,
  budgetPath,
  causalKey,
  herdKey,
  ledgerPath,
  newestById,
  overrideActive,
  planReservation,
  readBudget,
  readLedger,
  reconcile,
  reserve,
  settle,
  settleStaleReservations,
  textHash,
  type BudgetLine,
  type Delivery,
  type LedgerLine,
} from "../src/steering";
import {
  deliverable,
  registerAgent,
  readRegistry,
  verifyIncarnation,
  type AgentEntry,
} from "../src/registry";
import type { AgentInfo } from "../src/herdr";
import { runEffect } from "./support/effect";

let stateDir: string;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      stateDir = yield* fs.makeTempDirectory({ prefix: "hw-ledger-" });
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

const delivery = (over: Partial<Delivery> = {}): Delivery => ({
  id: "d1",
  at: "2026-09-09T10:00:00Z",
  run: "r1",
  incarnation: "term-1",
  agent: "impl-1",
  causal_key: causalKey("r1", { kind: "correction", ref: "c1" }, 3),
  request_id: "req-1",
  cause: { kind: "correction", ref: "c1" },
  mode: "boundary",
  text_hash: textHash("stay inside src/"),
  intent_version: 3,
  attempt: 1,
  state: "reserved",
  ...over,
});

const live = (over: Partial<AgentInfo> = {}): AgentInfo => ({
  name: "impl-1",
  paneId: "1-9",
  workspaceId: "w1",
  status: "idle",
  title: null,
  terminalId: "term-1",
  agentSession: null,
  ...over,
});

const entry = (over: Partial<AgentEntry> = {}): AgentEntry => ({
  role: "implementer",
  agent: "impl-1",
  paneId: "1-9",
  workspaceId: "w1",
  runId: "r1",
  workflow: "implement",
  at: "2026-09-09T09:00:00Z",
  incarnation: { terminalId: "term-1", agentSession: null },
  ...over,
});

test("an entry written before incarnations still decodes, and is never a delivery target", () =>
  runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const file = path.join(stateDir, "register.json");
      const legacy = entry();
      delete legacy.incarnation;
      yield* registerAgent(file, legacy);

      const [back] = yield* readRegistry(file);
      expect(back).toBeDefined();
      expect(deliverable(back!)).toBe(false);
      expect(verifyIncarnation(back!, [live()])).toEqual({ ok: false, reason: "no_incarnation" });
    }),
  ));

test("an entry with no incarnation is not an answer either, so a later read can heal it", () =>
  runEffect(
    Effect.gen(function* () {
      // herdr had not named a `terminal_id` when the agent started. Treating that as the
      // final word would make one listing's gap an unsteerable Run for ever, so the entry
      // is not deliverable and a later read is free to replace it with what herdr has now.
      const path = yield* Path.Path;
      const file = path.join(stateDir, "register.json");
      const early = entry();
      delete early.incarnation;
      yield* registerAgent(file, early);
      expect(deliverable((yield* readRegistry(file))[0]!)).toBe(false);

      // Registering the same agent again replaces it rather than adding a second row,
      // which is what makes healing on read a write of one line and not a duplicate.
      yield* registerAgent(file, entry());
      const healed = yield* readRegistry(file);
      expect(healed).toHaveLength(1);
      expect(deliverable(healed[0]!)).toBe(true);
      expect(verifyIncarnation(healed[0]!, [live()])).toMatchObject({ ok: true });
    }),
  ));

test("a second agent in the same role and pane is not the one that was registered", () => {
  expect(verifyIncarnation(entry(), [live()])).toMatchObject({ ok: true });
  expect(verifyIncarnation(entry(), [live({ terminalId: "term-2" })])).toEqual({
    ok: false,
    reason: "incarnation_changed",
  });
  expect(verifyIncarnation(entry(), [])).toEqual({ ok: false, reason: "agent_gone" });
});

test("a recorded harness session must still match, and an unrecorded one is not required", () => {
  const withSession = entry({
    incarnation: { terminalId: "term-1", agentSession: { kind: "id", value: "s-1" } },
  });
  expect(
    verifyIncarnation(withSession, [live({ agentSession: { kind: "id", value: "s-1" } })]),
  ).toMatchObject({ ok: true });
  expect(
    verifyIncarnation(withSession, [live({ agentSession: { kind: "id", value: "s-2" } })]),
  ).toEqual({ ok: false, reason: "incarnation_changed" });
  // Recorded as null: herdr did not know one at registration, so it is not held to one.
  expect(
    verifyIncarnation(entry(), [live({ agentSession: { kind: "id", value: "s-9" } })]),
  ).toMatchObject({ ok: true });
});

test("the ledger round trips, and a torn last line does not cost the rest", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* ledgerPath(stateDir, "term-1");
      yield* appendLine(file, delivery());
      yield* appendLine(file, delivery({ at: "2026-09-09T10:00:01Z", state: "submitted" }));
      yield* fs.writeFileString(file, `{"id":"d2","at":"2026`, { flag: "a" });

      const lines = yield* readLedger(file);
      expect(lines).toHaveLength(2);
      expect(newestById(lines).get("d1")?.state).toBe("submitted");
    }),
  ));

test("a reservation nobody settled becomes unknown, not a guess in either direction", () => {
  const lines: LedgerLine[] = [delivery()];
  const tooSoon = settleStaleReservations(lines, Date.parse("2026-09-09T10:00:30Z"), 60_000, "t");
  expect(tooSoon).toHaveLength(0);

  const [settled] = settleStaleReservations(
    lines,
    Date.parse("2026-09-09T10:01:30Z"),
    60_000,
    "2026-09-09T10:01:30Z",
  );
  expect(settled?.state).toBe("unknown");
  expect(settled?.note).toContain("never settled");
});

test("the same work blocks a second delivery; the same words about other work do not", () => {
  const inFlight = delivery({ state: "submitted" });
  expect(blocked([inFlight], inFlight.causal_key)?.id).toBe("d1");

  // Same text, different work: a nudge and a correction can read identically.
  const elsewhere = delivery({
    id: "d2",
    cause: { kind: "nudge", ref: "build" },
    causal_key: causalKey("r1", { kind: "nudge", ref: "build" }, 3),
  });
  expect(blocked([inFlight], elsewhere.causal_key)).toBeNull();

  // Settled work stops blocking; unknown work keeps blocking until someone answers.
  expect(blocked([delivery({ state: "verified" })], inFlight.causal_key)).toBeNull();
  expect(blocked([delivery({ state: "unknown" })], inFlight.causal_key)?.state).toBe("unknown");
});

test("only a human reconciles an unknown, and doing so stops it blocking", () => {
  const unknown = delivery({ state: "unknown" });
  expect(reconcile([unknown], "d1", "sent", "driver:r1", "t")).toEqual({
    error: "only a human may reconcile a delivery",
  });
  expect(reconcile([unknown], "d9", "sent", "human:req-2", "t")).toEqual({
    error: 'no delivery "d9" in this ledger',
  });
  expect(reconcile([delivery({ state: "submitted" })], "d1", "sent", "human:req-2", "t")).toEqual({
    error: 'delivery "d1" is submitted',
  });

  const settled = reconcile([unknown], "d1", "not-sent", "human:req-2", "t");
  expect(settled).toMatchObject({
    state: "superseded",
    note: "reconciled as not-sent by human:req-2",
  });
  if ("error" in settled) throw new Error(settled.error);
  expect(blocked([unknown, settled], unknown.causal_key)).toBeNull();
});

test("an override lasts until it is explicitly cleared", () => {
  expect(overrideActive([delivery()])).toBe(false);
  const flagged: LedgerLine[] = [
    delivery(),
    { kind: "manual_override", at: "t1", incarnation: "term-1", by: "hook:UserPromptSubmit" },
  ];
  expect(overrideActive(flagged)).toBe(true);
  expect(
    overrideActive([
      ...flagged,
      { kind: "override_cleared", at: "t2", incarnation: "term-1", by: "human:req-3" },
    ]),
  ).toBe(false);
});

test("the call record counts every call, settles the abandoned, and refuses none", () => {
  const limits = { maxSeconds: 120, maxOutputBytes: 262_144 };
  const at = (minute: number) => `2026-09-09T10:${String(minute).padStart(2, "0")}:00Z`;

  // A hundred calls already made this hour, every one of them a failure. Usage is data:
  // the record grows, and nothing in it is a reason to refuse the next call.
  const call = (id: string, when: string): BudgetLine[] => [
    { kind: "reserve", id, run: "r1", at: when, max_seconds: 120, max_output_bytes: 1 },
    { kind: "settle", id, at: when, outcome: "failed", seconds: 1, bytes: 0 },
  ];
  const history = Array.from({ length: 100 }, (_, i) => call(`c${i}`, at(i % 60))).flat();
  const next = planReservation(history, { id: "c100", run: "r1", at: at(59) }, limits);
  expect("refused" in next).toBe(false);
  expect(next.append).toEqual([
    {
      kind: "reserve",
      id: "c100",
      run: "r1",
      at: at(59),
      max_seconds: 120,
      max_output_bytes: 262_144,
    },
  ]);

  // A reservation nobody settled is counted as a failure, not forgotten — the record says
  // how many calls were made, so it must not say fewer than were.
  const abandoned: BudgetLine[] = [
    { kind: "reserve", id: "gone", run: "r1", at: at(0), max_seconds: 120, max_output_bytes: 1 },
  ];
  const after = planReservation(abandoned, { id: "next", run: "r1", at: at(30) }, limits);
  expect(after.append.some((l) => l.kind === "settle" && l.outcome === "failed")).toBe(true);

  // A line from before spending caps were dropped still reads; its cap decides nothing.
  const old: BudgetLine = {
    kind: "reserve",
    id: "old",
    run: "r1",
    at: at(0),
    max_usd: 0.5,
    max_seconds: 120,
    max_output_bytes: 1,
  };
  expect(
    planReservation([old], { id: "n", run: "r1", at: at(1) }, limits).append.at(-1),
  ).toMatchObject({
    id: "n",
  });
});

test("a reservation and its settlement are written under the lock", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const key = yield* herdKey("/tmp/herdr.sock", () => Effect.succeed(null));
      const file = yield* budgetPath(stateDir, key);
      yield* reserve(file, { id: "call-1", run: "r1" }, { maxSeconds: 120, maxOutputBytes: 1024 });
      yield* settle(file, "call-1", { outcome: "ok", usd: 0.02, seconds: 4, bytes: 900 });

      const lines = yield* readBudget(file);
      expect(lines.map((l) => l.kind)).toEqual(["reserve", "settle"]);
      expect(yield* fs.exists(`${file}.lock`)).toBe(false);
    }),
  ));

test("with no socket there is no Herd, and nothing falls back to a directory", () =>
  runEffect(
    Effect.gen(function* () {
      const failure = yield* herdKey(null, () => Effect.succeed(null)).pipe(Effect.flip);
      expect(failure._tag).toBe("HerdrUnreachable");
      // The status server's answer is used when the environment does not carry one.
      expect(yield* herdKey(null, () => Effect.succeed("/tmp/from-status.sock"))).toBe(
        yield* herdKey("/tmp/from-status.sock", () => Effect.succeed(null)),
      );
    }),
  ));

test("the delivery schema is what is on disk, and an unknown state is refused", () =>
  runEffect(
    Effect.gen(function* () {
      const file = yield* ledgerPath(stateDir, "term-1");
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(path.dirname(file), { recursive: true });
      yield* fs.writeFileString(
        file,
        `${Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))({ ...delivery(), state: "sent-ish" })}\n`,
      );
      expect(yield* readLedger(file)).toEqual([]);
    }),
  ));
