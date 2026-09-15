// A proposal exists so that a human can say yes to a specific thing. Everything tested
// here is a way of saying yes to something else: a payload that changed, a proposal that
// has aged out, a Run whose Intent moved, a caller that is not a person, and an action
// nobody can say whether it already happened.

import { Effect, FileSystem, Path } from "effect";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  EXPIRES_AFTER_MS,
  admit,
  confirm,
  contentHash,
  decline,
  judgeConfirmation,
  proposalsPath,
  read,
  pendingFor,
  pendingHerdWide,
  reconcileStep,
  record,
  stepSettled,
  stepStarted,
  type Actor,
  type AdmissionContext,
  type ProposalLine,
} from "../src/proposals";
import { executorFor, registeredKinds } from "../src/executors";
import type { Action } from "../src/evaluator";
import { carryOutProposal } from "../src/operations";
import { currentEnv, type PluginEnv } from "../src/env";
import { seedIntent, writeIntent } from "../src/intent";
import { RunStore } from "../src/run";
import { herdOf } from "../src/steering";
import { runEffect } from "./support/effect";

let stateDir: string;
let file: string;

const human: Actor = { origin: "cli-tty", requestId: "req-1" };
const board: Actor = { origin: "board", requestId: "req-2" };
const driver: Actor = { origin: "driver", requestId: "d-1" };

const actions: Action[] = [
  { kind: "deliver", run: "r1", agent: "impl-1", text: "stay in src", mode: "boundary" },
  { kind: "hold", run: "r1" },
];
const targets = [{ run: "r1" }];
const versions = new Map([["r1", 2]]);

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      stateDir = yield* fs.makeTempDirectory({ prefix: "hw-proposals-" });
      file = yield* proposalsPath(stateDir, "herd-1");
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

const written = Effect.fn("test.written")(function* () {
  return yield* record(file, {
    interpretation: "the branch is wrong",
    targets,
    actions,
    allowedNow: [],
    intentVersions: { r1: 2 },
    by: "evaluator:call-1",
  });
});

test("a card-bound proposal carries the revision it was asked about", () =>
  runEffect(
    Effect.gen(function* () {
      // Without this the binding exists only on the conversation turn, and `admit` has
      // nothing to compare — `revision_moved` becomes a refusal nothing can reach.
      const bound = yield* record(file, {
        interpretation: "the branch is wrong",
        targets,
        actions,
        allowedNow: [],
        intentVersions: { r1: 2 },
        by: "evaluator:call-1",
        card: { id: "card-1", revision: "sha:fingerprint" },
      });
      expect(bound.card).toEqual({ id: "card-1", revision: "sha:fingerprint" });
      // And it survives the journal, which is where a confirmation reads it from.
      const back = (yield* read(file)).find(
        (line): line is typeof bound => line.kind === "proposal",
      );
      expect(back?.card?.revision).toBe("sha:fingerprint");
      // Unbound proposals stay unbound: nothing invents a revision to compare.
      expect((yield* written()).card).toBeUndefined();
    }),
  ));

test("the hash is of the payload, so a changed action is a different proposal", () => {
  expect(contentHash(targets, actions)).toBe(contentHash(targets, actions));
  const reworded: Action[] = [
    { kind: "deliver", run: "r1", agent: "impl-1", text: "stay in SRC", mode: "boundary" },
    { kind: "hold", run: "r1" },
  ];
  expect(contentHash(targets, reworded)).not.toBe(contentHash(targets, actions));
  // Order is part of it: the same actions in another order do different things.
  expect(contentHash(targets, [...actions].reverse())).not.toBe(contentHash(targets, actions));
});

test("a human confirming the exact payload gets the actions back, once", () =>
  runEffect(
    Effect.gen(function* () {
      const proposal = yield* written();
      const first = yield* confirm(file, proposal.id, proposal.content_hash, human, versions);
      expect(first).toMatchObject({ actions });

      // Confirming again is not a second execution: it is already settled.
      const second = yield* confirm(file, proposal.id, proposal.content_hash, human, versions);
      expect(second).toMatchObject({ refused: "not_pending" });
    }),
  ));

test("every refusal is its own fact, and says which one it was", () =>
  runEffect(
    Effect.gen(function* () {
      const proposal = yield* written();
      const lines = yield* read(file);
      const now = Date.parse(proposal.created_at);

      expect(
        judgeConfirmation(lines, "nope", proposal.content_hash, human, now, versions),
      ).toMatchObject({
        refused: "not_found",
      });
      // A summary is not consent to a payload nobody saw.
      expect(
        judgeConfirmation(lines, proposal.id, "some-other-hash", human, now, versions),
      ).toMatchObject({
        refused: "hash_mismatch",
      });
      expect(
        judgeConfirmation(
          lines,
          proposal.id,
          proposal.content_hash,
          human,
          now + EXPIRES_AFTER_MS + 1,
          versions,
        ),
      ).toMatchObject({ refused: "expired" });
      // The Intent moved, so this was proposed about a Run that no longer wants that.
      expect(
        judgeConfirmation(
          lines,
          proposal.id,
          proposal.content_hash,
          human,
          now,
          new Map([["r1", 3]]),
        ),
      ).toMatchObject({ refused: "intent_moved" });
    }),
  ));

test("only a person confirms; a Driver, the evaluator and native chat cannot", () =>
  runEffect(
    Effect.gen(function* () {
      const proposal = yield* written();
      // SAFETY: the literal is exactly an Actor; the annotation only picks the origin.
      const evaluator: Actor = { origin: "evaluator", requestId: "e-1" };
      // Native chat's bridge. It runs as a child of a harness inside a pane, so it has a
      // controlling terminal — and a terminal is what the CLI reads as a person. Its
      // origin is stamped by the entrypoint for exactly this reason, and it is not human
      // however much of a TTY the process has.
      const chat: Actor = { origin: "chat", requestId: "c-1" };
      for (const actor of [driver, evaluator, chat]) {
        expect(
          yield* confirm(file, proposal.id, proposal.content_hash, actor, versions),
        ).toMatchObject({ refused: "not_human" });
        expect(yield* decline(file, proposal.id, actor)).toMatchObject({ refused: "not_human" });
      }
      // Both front doors count: a terminal with a person at it, and the board.
      expect(
        yield* confirm(file, proposal.id, proposal.content_hash, board, versions),
      ).toMatchObject({ actions });
    }),
  ));

test("an action that started and never settled stops the next confirmation", () =>
  runEffect(
    Effect.gen(function* () {
      const proposal = yield* written();
      yield* confirm(file, proposal.id, proposal.content_hash, human, versions);
      yield* stepStarted(file, proposal.id, 0);
      yield* stepSettled(file, proposal.id, 0, "applied");
      yield* stepStarted(file, proposal.id, 1);
      // Crash here: nobody can say whether action 1 happened.

      const later = yield* written();
      const lines = yield* read(file);
      const judged = judgeConfirmation(
        lines.map((line) => (line.kind === "step" ? { ...line, proposal: later.id } : line)),
        later.id,
        later.content_hash,
        human,
        Date.parse(later.created_at),
        versions,
      );
      expect(judged).toMatchObject({ refused: "reconcile_required" });

      // A human says what happened, and it stops blocking. Only a human — and only about
      // an action that really is waiting: `later` is a fiction of this test's, and the
      // unsettled step belongs to the proposal that actually ran one.
      expect(yield* reconcileStep(file, proposal.id, 1, "applied", driver)).toMatchObject({
        refused: "not_human",
      });
      expect(yield* reconcileStep(file, later.id, 1, "not-applied", human)).toMatchObject({
        refused: "not_pending",
      });
      expect(yield* reconcileStep(file, proposal.id, 0, "not-applied", human)).toMatchObject({
        refused: "not_pending",
      });
      yield* reconcileStep(file, proposal.id, 1, "not-applied", human);
      const settled = (yield* read(file)).filter(
        (line): line is Extract<ProposalLine, { kind: "step" }> => line.kind === "step",
      );
      expect(settled.at(-1)).toMatchObject({
        state: "skipped",
        note: expect.stringContaining("human:"),
      });
    }),
  ));

test("declining settles it, and it cannot then be confirmed", () =>
  runEffect(
    Effect.gen(function* () {
      const proposal = yield* written();
      expect(yield* decline(file, proposal.id, human)).toMatchObject({ refused: null });
      expect(
        yield* confirm(file, proposal.id, proposal.content_hash, human, versions),
      ).toMatchObject({ refused: "not_pending" });
      // And it cannot be declined twice: the journal would say it was answered twice.
      expect(yield* decline(file, proposal.id, human)).toMatchObject({ refused: "not_pending" });
    }),
  ));

test("a confirmed proposal cannot then be declined", () =>
  runEffect(
    Effect.gen(function* () {
      const proposal = yield* written();
      yield* confirm(file, proposal.id, proposal.content_hash, human, versions);
      // Both facts in one journal would leave nobody able to say which one happened.
      expect(yield* decline(file, proposal.id, human)).toMatchObject({ refused: "not_pending" });
    }),
  ));

const ctx = (over: Partial<AdmissionContext> = {}): AdmissionContext => ({
  run: { id: "r1", status: "running" },
  driverLive: true,
  pendingChoice: null,
  incarnation: "term-1",
  proposedIncarnation: "term-1",
  intentVersion: 2,
  proposedIntentVersion: 2,
  revision: null,
  ...over,
});

test("admission asks again, immediately before the action runs", () => {
  const deliver: Action = {
    kind: "deliver",
    run: "r1",
    agent: "impl-1",
    text: "t",
    mode: "boundary",
  };
  expect(admit(deliver, ctx())).toBeNull();
  expect(admit(deliver, ctx({ run: null }))).toBe("the run is gone");
  expect(admit(deliver, ctx({ run: { id: "r1", status: "succeeded" } }))).toBe(
    "the run is succeeded",
  );
  expect(admit(deliver, ctx({ driverLive: false }))).toContain("no Driver");
  // The agent moved on between the proposal and the yes.
  expect(admit(deliver, ctx({ incarnation: "term-2" }))).toContain("not the one in that pane");
  expect(admit(deliver, ctx({ intentVersion: 3 }))).toContain("v2");

  const answer: Action = { kind: "answer", run: "r1", choiceId: "c1", answer: "Build it now" };
  expect(admit(answer, ctx({ pendingChoice: "c1" }))).toBeNull();
  expect(admit(answer, ctx({ pendingChoice: null }))).toContain("not asking a Choice");
  expect(admit(answer, ctx({ pendingChoice: "c2" }))).toContain('"c2"');

  // A follow-up is a child of a finished Run, so the rule runs the other way.
  const followup: Action = { kind: "followup", run: "r1", text: "the block is open" };
  expect(admit(followup, ctx())).toContain("still going");
  expect(admit(followup, ctx({ run: { id: "r1", status: "succeeded" } }))).toBeNull();

  // A card-bound proposal is about a revision, and revisions move.
  expect(admit(deliver, ctx({ revision: { card: "abc", now: "def" } }))).toBe("revision_moved");

  // Nothing is asked of an action that does nothing to a Run.
  expect(admit({ kind: "none", why: "nothing to do" }, ctx({ run: null }))).toBeNull();
  expect(admit({ kind: "ask_human", question: "which?" }, ctx({ run: null }))).toBeNull();
});

test("this build registers no executors, so nothing is stubbed into pretending", () => {
  // Every kind is registered by the module that owns the operation. Until one does, a
  // confirmed action of that kind is refused rather than silently succeeding at nothing.
  expect(registeredKinds()).toEqual([]);
  expect(executorFor("followup")).toBeUndefined();
  expect(executorFor("deliver")).toBeUndefined();
});

// From here on this process has executors registered, which is why it comes last.
test("carrying out a Confirmation asks admission again, whichever front door said yes", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // A socket path is what names a Herd, so the proposal has to be filed under the one
      // this env resolves to rather than under a key the test picked.
      const socketPath = path.join(stateDir, "herdr.sock");
      yield* fs.writeFileString(socketPath, "");
      const env: PluginEnv = { ...(yield* currentEnv), stateDir, socketPath };
      const herdFile = yield* proposalsPath(stateDir, yield* herdOf(socketPath));

      const run = yield* new RunStore(stateDir).create({
        workflow: "implement",
        cwd: stateDir,
        inputs: { plan: "a picker" },
        inputSources: { plan: "asked" },
        stepIds: ["build"],
        maxIterations: 5,
        namedAfter: "a-picker",
        worktree: null,
      });
      yield* writeIntent(run.dir, seedIntent(run.id, { goal: "a picker" }));

      const proposal = yield* record(herdFile, {
        interpretation: "hold it",
        targets: [{ run: run.id }],
        actions: [{ kind: "hold", run: run.id }],
        allowedNow: [],
        // The Intent was v1 when this was proposed, and `seedIntent` wrote v1.
        intentVersions: { [run.id]: 1 },
        by: "evaluator:call-1",
      });

      // Nothing owns this Run, so there is nobody to hold it — a condition the proposal
      // could not know about and only the moment of carrying it out can. The board used
      // to run its actions without asking this, which is the whole point of one module.
      const out = yield* carryOutProposal(env, proposal.id, proposal.content_hash, board);
      if (!out.ok) throw new Error(out.error.message);
      expect(out.data.results).toMatchObject([{ kind: "hold", state: "skipped" }]);
      expect(out.data.results[0]!.note).toContain("no Driver");
    }),
  ));

test("an Intent nobody can decode refuses the confirmation instead of reading as no version", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const socketPath = path.join(stateDir, "herdr.sock");
      yield* fs.writeFileString(socketPath, "");
      const env: PluginEnv = { ...(yield* currentEnv), stateDir, socketPath };
      const herdFile = yield* proposalsPath(stateDir, yield* herdOf(socketPath));

      const run = yield* new RunStore(stateDir).create({
        workflow: "implement",
        cwd: stateDir,
        inputs: { plan: "a picker" },
        inputSources: { plan: "asked" },
        stepIds: ["build"],
        maxIterations: 5,
        namedAfter: "a-picker",
        worktree: null,
      });
      yield* writeIntent(run.dir, seedIntent(run.id, { goal: "a picker" }));
      const proposal = yield* record(herdFile, {
        interpretation: "hold it",
        targets: [{ run: run.id }],
        actions: [{ kind: "hold", run: run.id }],
        allowedNow: [],
        intentVersions: { [run.id]: 1 },
        by: "evaluator:call-1",
      });

      // Corrupt after the proposal was written, which is the window that matters: the
      // version it was checked against is now unreadable rather than merely absent.
      yield* fs.writeFileString(path.join(run.dir, "intent.json"), "{ not json");

      const out = yield* carryOutProposal(env, proposal.id, proposal.content_hash, board).pipe(
        Effect.catch((cause) => Effect.succeed(cause)),
      );
      expect(out).toMatchObject({ _tag: "IntentUnreadable" });
    }),
  ));

test("a confirmed start goes through the same Input settling a typed one does", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const socketPath = path.join(stateDir, "herdr.sock");
      yield* fs.writeFileString(socketPath, "");
      const env: PluginEnv = { ...(yield* currentEnv), stateDir, socketPath };
      const herdFile = yield* proposalsPath(stateDir, yield* herdOf(socketPath));

      const run = yield* new RunStore(stateDir).create({
        workflow: "implement",
        cwd: stateDir,
        inputs: { plan: "a picker" },
        inputSources: { plan: "asked" },
        stepIds: ["build"],
        maxIterations: 5,
        namedAfter: "a-picker",
        worktree: null,
      });
      yield* writeIntent(run.dir, seedIntent(run.id, { goal: "a picker" }));

      const proposal = yield* record(herdFile, {
        interpretation: "start one and hold the other",
        targets: [{ run: run.id }],
        actions: [
          { kind: "start", workflow: "implement", inputs: {} },
          { kind: "hold", run: run.id },
        ],
        allowedNow: [],
        intentVersions: { [run.id]: 1 },
        by: "evaluator:call-1",
      });

      // `start` goes through the same two steps `run start` takes, so an Input nobody
      // named is a refusal rather than a guess — there is no human here to ask, and a Run
      // started on a work source nobody named is a Run about something nobody said. (A
      // branch is the one Input Collie works out for itself, so it is the work source that
      // has to be missing here.) What matters for the sequence is that the refusal is this
      // action's and not the next one's: `hold` is still reached.
      const out = yield* carryOutProposal(env, proposal.id, proposal.content_hash, board);
      if (!out.ok) throw new Error(out.error.message);
      expect(out.data.results[0]).toMatchObject({ kind: "start", state: "failed" });
      expect(out.data.results[0]!.note).toContain("input");
    }),
  ));

test("a proposal is pending until it is answered or it expires", () => {
  const now = Date.parse("2026-09-09T10:00:00Z");
  const proposal: ProposalLine = {
    kind: "proposal",
    id: "p1",
    created_at: "2026-09-09T09:00:00Z",
    expires_at: "2026-09-09T11:00:00Z",
    interpretation: "hold it",
    targets: [{ run: "r1" }],
    actions: [{ kind: "hold", run: "r1" }],
    allowed_now: [],
    intent_versions: { r1: 1 },
    content_hash: "abc",
    by: "evaluator:call-1",
    state: "pending",
  };
  expect(pendingFor([proposal], "r1", now).map((line) => line.id)).toEqual(["p1"]);
  // Somebody else's Run is not this Run's decision.
  expect(pendingFor([proposal], "r2", now)).toEqual([]);
  // Answered either way, and expired, are all "nobody is being waited on".
  const settled = { id: "p1", at: "t", by: "human:1" } as const;
  expect(pendingFor([proposal, { ...settled, kind: "confirmed" }], "r1", now)).toEqual([]);
  expect(pendingFor([proposal, { ...settled, kind: "declined" }], "r1", now)).toEqual([]);
  expect(pendingFor([proposal], "r1", Date.parse("2026-09-09T12:00:00Z"))).toEqual([]);
});

test("a proposal about the installation is waiting on the Herd, not on any Run", () =>
  runEffect(
    Effect.gen(function* () {
      // `upgrade`, `home_cleanup`, `update_defaults` and `fork_definition` name no Run, so
      // they record no targets — and a board that only asked `pendingFor(run)` would never
      // draw them, leaving them to expire at the one front door that is meant to confirm
      // them.
      const herdWide = yield* record(file, {
        interpretation: "bring this installation up to date",
        targets: [],
        actions: [{ kind: "upgrade" }],
        allowedNow: [],
        intentVersions: {},
        by: "chat:c-1",
      });
      const lines = yield* read(file);
      const now = Date.parse(herdWide.expires_at) - 1;
      expect(pendingHerdWide(lines, now).map((p) => p.id)).toEqual([herdWide.id]);
      // And a proposal about a Run is that Run's, never the Herd's: the two lists do not
      // overlap, so confirming one is never confirming the other.
      yield* written();
      const both = yield* read(file);
      expect(pendingHerdWide(both, now).map((p) => p.id)).toEqual([herdWide.id]);
      expect(pendingFor(both, "r1", now).map((p) => p.id)).not.toContain(herdWide.id);
    }),
  ));
