// The ledgers exist to answer "was this already sent" and "has this cost too much"
// after a crash, so what is tested here is what they say when nobody came back: an
// unsettled reservation, a second attempt at the same work, a failed model call.

import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import { Deferred, Effect, Fiber, FileSystem, Result, Schema, Stream, flow } from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  appendLine,
  DELIVERIES,
  blocked,
  budgetPath,
  causalKey,
  deliveriesOf,
  herdKey,
  humanSubmits,
  incarnationKey,
  newestById,
  overriddenRuns,
  overrideActive,
  planReservation,
  readBudget,
  readLedger,
  readLedgerWhole,
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
  everyRegistered,
  registerAgent,
  verifyIncarnation,
  type AgentEntry,
} from "../src/registry";
import type { AgentInfo } from "../src/herdr";
import { runEffect } from "./support/effect";
import { recordsAt } from "./support/records";
import { StoreWrites } from "../src/store-writes";
import { epochMs } from "../src/time";

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

const scope = { session: null, workspaceId: "w1", cwd: "/project" };

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
      const legacy = entry();
      delete legacy.incarnation;
      yield* registerAgent(scope, legacy);

      const [back] = yield* everyRegistered;
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
      const early = entry();
      delete early.incarnation;
      yield* registerAgent(scope, early);
      expect(deliverable((yield* everyRegistered)[0]!)).toBe(false);

      // Registering the same agent again replaces it rather than adding a second row,
      // which is what makes healing on read a write of one line and not a duplicate.
      yield* registerAgent(scope, entry());
      const healed = yield* everyRegistered;
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

/** A ledger file as a host of an older build left it. */
const oldLedger = (incarnation: string, lines: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = `${stateDir}/agents/${incarnationKey(incarnation)}`;
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(`${dir}/deliveries.jsonl`, Arr.join(lines, "\n"));
    return `${dir}/deliveries.jsonl`;
  });

const encodeLine = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Unknown)),
  Result.getOrThrow,
);

test("the ledger round trips through the host's database", () =>
  runEffect(
    Effect.gen(function* () {
      yield* appendLine(delivery());
      yield* appendLine(delivery({ at: "2026-09-09T10:00:01Z", state: "submitted" }));
      yield* appendLine(delivery({ id: "d9", incarnation: "term-2" }));

      const lines = yield* readLedger("term-1");
      expect(lines).toHaveLength(2);
      expect(newestById(lines).get("d1")?.state).toBe("submitted");
    }).pipe(Effect.provide(recordsAt(stateDir))),
  ));

test("the first host imports each ledger file once, still blocking on a line it cannot read", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = yield* oldLedger("term-1", [
        encodeLine(delivery()),
        "{not a line",
        encodeLine(delivery({ at: "2026-09-09T10:00:01Z", state: "submitted" })),
        `{"id":"d2","at":"2026`,
      ]);
      const read = Effect.gen(function* () {
        const ledger = yield* readLedgerWhole("term-1");
        expect(ledger.corrupt).toBe(1);
        expect(ledger.lines).toHaveLength(2);
        expect(Arr.map(yield* deliveriesOf("r1"), (one) => [one.id, one.state])).toEqual([
          ["d1", "submitted"],
        ]);
      });
      yield* read.pipe(Effect.provide(recordsAt(stateDir)));
      expect(yield* fs.exists(file)).toBe(true);
      // A second host finds the import made, and does not make it again.
      yield* read.pipe(Effect.provide(recordsAt(stateDir)));
    }),
  ));

test("a human's words herdr took are found once, at the first line saying so", () =>
  runEffect(
    Effect.gen(function* () {
      const human = { origin: "desktop" } as const;
      yield* appendLine(delivery({ id: "d1", human }));
      yield* appendLine(
        delivery({ id: "d1", state: "submitted", at: "2026-09-09T10:00:01Z", human }),
      );
      yield* appendLine(
        delivery({ id: "d1", state: "acknowledged", at: "2026-09-09T10:00:02Z", human }),
      );
      yield* appendLine(delivery({ id: "d2", state: "submitted" }));
      yield* appendLine(delivery({ id: "d3", state: "failed", human }));
      expect(Arr.map(yield* humanSubmits, (one) => [one.id, one.state])).toEqual([
        ["d1", "submitted"],
      ]);
    }).pipe(Effect.provide(recordsAt(stateDir))),
  ));

test("a Run is under override while an incarnation it was delivered through last said so", () =>
  runEffect(
    Effect.gen(function* () {
      yield* appendLine(delivery());
      yield* appendLine(delivery({ id: "d2", run: "r2", incarnation: "term-2" }));
      const override = { at: "2026-09-09T10:01:00Z", incarnation: "term-1", by: "mk" };
      yield* appendLine({ kind: "manual_override", ...override });
      expect([...(yield* overriddenRuns)]).toEqual(["r1"]);
      yield* appendLine({ kind: "override_cleared", ...override });
      expect([...(yield* overriddenRuns)]).toEqual([]);
    }).pipe(Effect.provide(recordsAt(stateDir))),
  ));

test("a delivery written tells the Run model which Run it moved", () =>
  runEffect(
    Effect.gen(function* () {
      const moved: string[] = [];
      yield* appendLine(delivery({ run: "r7" })).pipe(
        Effect.provide(recordsAt(stateDir)),
        Effect.provideService(StoreWrites, (runs) => moved.push(...runs)),
      );
      expect(moved).toEqual(["r7"]);
    }),
  ));

test("a delivery written moves whatever follows the ledgers, as the board does", () =>
  runEffect(
    Effect.gen(function* () {
      const reactivity = yield* Reactivity.Reactivity;
      const following = yield* Deferred.make<void>();
      const reads = yield* reactivity
        .stream(
          [DELIVERIES],
          Deferred.succeed(following, undefined).pipe(Effect.andThen(Effect.void)),
        )
        .pipe(Stream.take(2), Stream.runCount, Effect.forkScoped);
      yield* Deferred.await(following);
      yield* appendLine(delivery({ run: "r7" }));
      expect(yield* Fiber.join(reads).pipe(Effect.timeout("2 seconds"))).toBe(2);
    }).pipe(Effect.provide(recordsAt(stateDir))),
  ));

test("a reservation nobody settled becomes unknown, not a guess in either direction", () => {
  const lines: LedgerLine[] = [delivery()];
  const tooSoon = settleStaleReservations(lines, epochMs("2026-09-09T10:00:30Z"), 60_000, "t");
  expect(tooSoon).toHaveLength(0);

  const [settled] = settleStaleReservations(
    lines,
    epochMs("2026-09-09T10:01:30Z"),
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
  expect(blocked([delivery({ state: "superseded" })], inFlight.causal_key)).toBeNull();
  expect(blocked([delivery({ state: "unknown" })], inFlight.causal_key)?.state).toBe("unknown");
});

test("an explicit reconciliation works from automation and stops an unknown blocking", () => {
  const unknown = delivery({ state: "unknown" });
  expect(reconcile([unknown], "d1", "sent", "driver:r1", "t")).toMatchObject({
    state: "superseded",
    note: "reconciled as sent by driver:r1",
  });
  expect(reconcile([unknown], "d9", "sent", "human:req-2", "t")).toEqual({
    error: 'no delivery "d9" in this ledger',
  });
  expect(reconcile([delivery({ state: "submitted" })], "d1", "sent", "human:req-2", "t")).toEqual({
    error: 'delivery "d1" is submitted',
  });
  // One sent that nothing showed was taken is a human's to account for too.
  expect(
    reconcile([delivery({ state: "submitted", note: "unobserved" })], "d1", "not-sent", "h", "t"),
  ).toMatchObject({ state: "superseded", note: "reconciled as not-sent by h" });

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
  const at = (minute: number) => `2026-09-09T10:${pipe_(String(minute), Str.padStart(2, "0"))}:00Z`;

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
  expect(Arr.some(after.append, (l) => l.kind === "settle" && l.outcome === "failed")).toBe(true);

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
      expect(Arr.map(lines, (l) => l.kind)).toEqual(["reserve", "settle"]);
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

test("the delivery schema is what is imported, and an unknown state is refused", () =>
  runEffect(
    Effect.gen(function* () {
      yield* oldLedger("term-1", [encodeLine({ ...delivery(), state: "sent-ish" })]);
      expect(yield* readLedger("term-1").pipe(Effect.provide(recordsAt(stateDir)))).toEqual([]);
    }),
  ));
