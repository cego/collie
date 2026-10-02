// A proposal exists so that a human can say yes to a specific thing. Everything tested
// here is a way of saying yes to something else: a payload that changed, a proposal that
// has aged out, a Run whose Intent moved, a caller that is not a person, and an action
// nobody can say whether it already happened.

import { Effect, FileSystem, Path, type Scope } from "effect";
import type { BunServices } from "@effect/platform-bun/BunServices";
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
  stepResults,
  stepStarted,
  type Actor,
  type AdmissionContext,
  type ProposalLine,
} from "../src/proposals";
import { executorFor, registeredKinds, resetExecutors } from "../src/executors";
import type { Action } from "../src/evaluator";
import { carryOutProposal } from "../src/operations";
import type { PluginEnv } from "../src/env";
import { readIntent, seedIntent, writeIntent } from "../src/intent";
import { herdOf } from "../src/steering";
import { runEffect } from "./support/effect";
import { hosted, hostedRun, settledRun } from "./support/hosted";
import { save } from "./support/world";
import { connect } from "../src/host";
import { writeConfigValue } from "../src/config";
import type { World } from "./support/world";

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
      resetExecutors();
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

test("automation can execute and decline proposals without a terminal", () =>
  runEffect(
    Effect.gen(function* () {
      const evaluator: Actor = { origin: "evaluator", requestId: "e-1" };
      const chat: Actor = { origin: "chat", requestId: "c-1" };
      for (const actor of [driver, evaluator, chat, board]) {
        const proposal = yield* written();
        expect(
          yield* confirm(file, proposal.id, proposal.content_hash, actor, versions),
        ).toMatchObject({ actions });
        const declined = yield* written();
        expect(yield* decline(file, declined.id, actor)).toMatchObject({ refused: null });
      }
    }),
  ));

test("a carry-out cut off partway is read back as unsettled and unrun, not as done", () =>
  runEffect(
    Effect.gen(function* () {
      const proposal = yield* written();
      yield* confirm(file, proposal.id, proposal.content_hash, human, versions);
      yield* stepStarted(file, proposal.id, 0);
      // Cut off here: action 0 never settled and action 1 never ran.

      expect(stepResults(yield* read(file), proposal.id)).toMatchObject([
        { index: 0, kind: "deliver", state: "unknown" },
        { index: 1, kind: "hold", state: "skipped", note: "not_run" },
      ]);
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

      // Only an action that really is waiting can be reconciled.
      expect(yield* reconcileStep(file, later.id, 1, "not-applied", human)).toMatchObject({
        refused: "not_pending",
      });
      expect(yield* reconcileStep(file, proposal.id, 0, "not-applied", human)).toMatchObject({
        refused: "not_pending",
      });
      expect(yield* reconcileStep(file, proposal.id, 1, "not-applied", driver)).toMatchObject({
        refused: null,
      });
      const settled = (yield* read(file)).filter(
        (line): line is Extract<ProposalLine, { kind: "step" }> => line.kind === "step",
      );
      expect(settled.at(-1)).toMatchObject({
        state: "skipped",
        note: expect.stringContaining("driver:d-1"),
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
  pendingChoice: null,
  incarnation: "term-1",
  proposedIncarnation: "term-1",
  intentVersion: 2,
  proposedIntentVersion: 2,
  revision: null,
  ...over,
});

test("a proposed hold that names a time is refused, because nothing would lift it", () => {
  const timed: Action = { kind: "hold", run: "r1", until: "2026-09-23T14:00:00+02:00" };
  expect(admit(timed, ctx())).toContain("nothing lifts a hold at a time");
  expect(admit({ kind: "hold", run: "r1" }, ctx())).toBeNull();
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

  // A resume is what a failed or stopped Run is offered, so ending is not a reason to
  // refuse it; `resumeRun` owns the rest, the one that already succeeded included.
  const resume: Action = { kind: "resume", run: "r1" };
  expect(admit(resume, ctx({ run: { id: "r1", status: "failed" } }))).toBeNull();
  expect(admit(resume, ctx({ run: { id: "r1", status: "stopped" } }))).toBeNull();
  expect(admit(resume, ctx({ run: { id: "r1", status: "succeeded" } }))).toBeNull();

  // A card-bound proposal is about a revision, and revisions move.
  expect(admit(deliver, ctx({ revision: { card: "abc", now: "def" } }))).toBe("revision_moved");

  // Nothing is asked of an action that does nothing to a Run.
  expect(admit({ kind: "none", why: "nothing to do" }, ctx({ run: null }))).toBeNull();
  expect(admit({ kind: "ask_human", question: "which?" }, ctx({ run: null }))).toBeNull();
});

const NO_STEP = "a finished Run has no step left to hold; stop closes its agents";
const COLLECTED =
  "its checks were collected when it finished; remember_verification keeps them for the next Run";

/** Every Run-scoped action kind, and what a finished Run's admission says to it (ADR-0041 D2). */
const ON_A_FINISHED_RUN: ReadonlyArray<readonly [Action, string | null]> = [
  [{ kind: "deliver", run: "r1", agent: "impl-1", text: "merge it", mode: "now" }, null],
  [{ kind: "answer", run: "r1", choiceId: "c1", answer: "yes" }, "the run is not asking a Choice"],
  [
    {
      kind: "update_intent",
      run: "r1",
      change: "add-constraint",
      patch: "tag it",
      base_version: 2,
    },
    null,
  ],
  [{ kind: "clear_override", run: "r1", agent: "impl-1" }, null],
  [{ kind: "stop", run: "r1" }, null],
  [{ kind: "hold", run: "r1" }, NO_STEP],
  [{ kind: "release", run: "r1" }, NO_STEP],
  [{ kind: "set_verification", run: "r1", name: "test" }, COLLECTED],
  [{ kind: "followup", run: "r1", text: "and tag it" }, null],
  [{ kind: "resume", run: "r1" }, null],
  [{ kind: "navigate", run: "r1" }, null],
  [{ kind: "remember_verification", run: "r1" }, null],
];

for (const status of ["succeeded", "failed", "stopped"]) {
  test(`a ${status} Run is admitted on facts, never on its status`, () => {
    for (const [action, refused] of ON_A_FINISHED_RUN) {
      const said = admit(action, ctx({ run: { id: "r1", status } }));
      if (refused === null) expect([action.kind, said]).toEqual([action.kind, null]);
      else expect([action.kind, said]).toEqual([action.kind, expect.stringContaining(refused)]);
    }
  });
}

test("this build registers no executors, so nothing is stubbed into pretending", () => {
  // Every kind is registered by the module that owns the operation. Until one does, a
  // confirmed action of that kind is refused rather than silently succeeding at nothing.
  expect(registeredKinds()).toEqual([]);
  expect(executorFor("followup")).toBeUndefined();
  expect(executorFor("deliver")).toBeUndefined();
});

// From here on this process has executors registered, which is why it comes last.
/** A Herd of this test's own with a host in it, and the proposals file its Herd keeps. */
const inHerd = <A, E>(
  body: (herd: {
    world: World;
    env: PluginEnv;
    herdFile: string;
  }) => Effect.Effect<A, E, BunServices | Scope.Scope>,
) =>
  hosted("hw-proposals-", ({ world, env }) =>
    Effect.gen(function* () {
      // A socket path is what names a Herd, so the proposal has to be filed under the one
      // this env resolves to rather than under a key the test picked.
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(env.socketPath!, "");
      const herdFile = yield* proposalsPath(world.state, yield* herdOf(env.socketPath));
      return yield* body({ world, env, herdFile });
    }),
  );

test(
  "a refused action fails the request and does not execute later actions",
  () =>
    inHerd(({ world, env, herdFile }) =>
      Effect.gen(function* () {
        // A Run that has ended: something nothing can hold, which a proposal could not know
        // about and only the moment of carrying it out can.
        const { id, dir } = yield* settledRun(world, "hello");
        yield* writeIntent(dir, seedIntent(id, { goal: "a picker" }));

        const proposal = yield* record(herdFile, {
          interpretation: "hold it",
          targets: [{ run: id }],
          actions: [
            { kind: "hold", run: id },
            {
              kind: "update_intent",
              run: id,
              change: "set-goal",
              patch: "must not happen",
              base_version: 1,
            },
          ],
          allowedNow: [],
          // The Intent was v1 when this was proposed, and `seedIntent` wrote v1.
          intentVersions: { [id]: 1 },
          by: "evaluator:call-1",
        });

        // The board used to run its actions without asking this, which is the whole point
        // of one module.
        const out = yield* carryOutProposal(env, proposal.id, undefined, board);
        expect(out.ok).toBe(false);
        if (out.ok) return;
        expect(out.error.code).toBe("operation_failed");
        expect(out.error.message).toContain("no step left to hold");
        expect(out.error.details).toMatchObject({ results: [{ kind: "hold", state: "skipped" }] });
        expect((yield* readIntent(dir))?.goal).toBe("a picker");
      }),
    ),
  60_000,
);

test(
  "an Intent nobody can decode refuses the confirmation instead of reading as no version",
  () =>
    inHerd(({ world, env, herdFile }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const run = yield* hostedRun(world, "a picker");
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

        const out = yield* carryOutProposal(env, proposal.id, proposal.content_hash, board);
        expect(out).toMatchObject({
          ok: false,
          error: {
            details: {
              results: [
                { kind: "hold", state: "skipped", note: `${run.id}'s Intent cannot be read` },
              ],
            },
          },
        });
      }),
    ),
  60_000,
);

test(
  "chat's start names projects-root and every Input, or is told each one it left out",
  () =>
    inHerd(({ world, env, herdFile }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = `${world.home}/projects`;
        yield* fs.makeDirectory(`${root}/app/.git`, { recursive: true });
        yield* writeConfigValue(world.config, "projects.root", root);
        yield* save(world.user, ["branches.workflow.ts"]);
        const carry = (action: Action) =>
          Effect.gen(function* () {
            const proposal = yield* record(herdFile, {
              interpretation: "start it",
              targets: [],
              actions: [action],
              allowedNow: [],
              intentVersions: {},
              by: "evaluator:call-1",
            });
            return yield* carryOutProposal(env, proposal.id, proposal.content_hash, board);
          });

        const started = yield* carry({
          kind: "start",
          workflow: "proof",
          workspace: "projects-root",
          inputs: { note: "x" },
        });
        expect(started.ok).toBe(true);
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const runs = yield* client.runs({ task: null }).pipe(Effect.orDie);
        expect(runs.map((one) => one.cwd)).toEqual([root]);

        const short = yield* carry({
          kind: "start",
          workflow: "branches",
          workspace: "projects-root",
          inputs: { size: "small" },
        });
        expect(short.ok).toBe(false);
        if (short.ok) return;
        expect(short.error.message).toContain('"goal"');
        expect(short.error.message).toContain('as ""');

        const nowhere = yield* carry({ kind: "start", workflow: "proof", inputs: { note: "x" } });
        expect(nowhere.ok).toBe(false);
        if (nowhere.ok) return;
        expect(nowhere.error.message).toContain('"workspace"');
        // Told how chat names one, not the command line's flag.
        expect(nowhere.error.message).toContain("the action's workspace");
        expect(nowhere.error.message).not.toContain("--input");
      }),
    ),
  60_000,
);

test(
  "a confirmed start goes through the same Input settling a typed one does",
  () =>
    inHerd(({ world, env, herdFile }) =>
      Effect.gen(function* () {
        const run = yield* hostedRun(world, "a picker");

        const proposal = yield* record(herdFile, {
          interpretation: "start one and hold the other",
          targets: [{ run: run.id }],
          actions: [
            { kind: "start", workflow: "proof", inputs: {} },
            { kind: "hold", run: run.id },
          ],
          allowedNow: [],
          intentVersions: { [run.id]: 1 },
          by: "evaluator:call-1",
        });

        // `start` goes through the same two steps `run start` takes, so an Input nobody
        // named is a refusal rather than a guess — there is no human here to ask. The
        // refusal is this action's and not the next one's: the `hold` is about another Run,
        // so it is still attempted and reported on its own.
        const out = yield* carryOutProposal(env, proposal.id, proposal.content_hash, board);
        expect(out.ok).toBe(false);
        if (out.ok) return;
        expect(out.error.details).toMatchObject({
          results: [{ kind: "start", state: "failed" }, { kind: "hold" }],
        });
        expect(out.error.message).toContain("note");
      }),
    ),
  60_000,
);

test(
  "a confirmed set_verification grants a running Run a check, and a later one withdraws it",
  () =>
    inHerd(({ world, env, herdFile }) =>
      Effect.gen(function* () {
        const run = yield* hostedRun(world, "a picker");
        const confirm = (action: Action) =>
          Effect.gen(function* () {
            const version = (yield* readIntent(run.dir))?.version ?? 1;
            const proposal = yield* record(herdFile, {
              interpretation: "change what proves it",
              targets: [{ run: run.id }],
              actions: [action],
              allowedNow: [],
              intentVersions: { [run.id]: version },
              by: "evaluator:call-1",
            });
            return yield* carryOutProposal(env, proposal.id, proposal.content_hash, board);
          });

        const granted = yield* confirm({
          kind: "set_verification",
          run: run.id,
          name: "unit",
          command: { executable: "true", argv: [], cwd: "worktree" },
        });
        expect(granted.ok).toBe(true);
        expect((yield* readIntent(run.dir))?.authority.run_verification).toEqual([
          { name: "unit", executable: "true", argv: [], cwd: "worktree" },
        ]);

        const withdrawn = yield* confirm({ kind: "set_verification", run: run.id, name: "unit" });
        expect(withdrawn.ok).toBe(true);
        expect((yield* readIntent(run.dir))?.authority.run_verification).toEqual([]);
      }),
    ),
  60_000,
);

test(
  "remember_verification keeps a finished Run's checks for its repository, and overwrites only when told",
  () =>
    inHerd(({ world, env, herdFile }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const unit = { name: "unit", executable: "true", argv: [], cwd: "worktree" };
        // A checkout of its own, as a worktree is, and gone once the Run has settled.
        const worktree = `${world.home}/worktree`;
        yield* fs.makeDirectory(worktree, { recursive: true });
        Bun.spawnSync(["git", "init", "-q"], { cwd: worktree });
        for (const cwd of [world.project, worktree])
          Bun.spawnSync(["git", "remote", "add", "origin", "git@example.test:team/app.git"], {
            cwd,
          });
        const run = yield* settledRun(world, "hello", { workspace: worktree });
        const client = yield* connect(world.state).pipe(Effect.orDie);
        expect((yield* client.run({ runId: run.id }).pipe(Effect.orDie))?.cwd).toBe(worktree);
        yield* writeIntent(run.dir, seedIntent(run.id, { runVerification: [unit] }));
        const carry = (replace?: boolean) =>
          Effect.gen(function* () {
            const proposal = yield* record(herdFile, {
              interpretation: "keep these checks for the repository",
              targets: [{ run: run.id }],
              actions: [
                replace === undefined
                  ? { kind: "remember_verification", run: run.id }
                  : { kind: "remember_verification", run: run.id, replace },
              ],
              allowedNow: [],
              intentVersions: {},
              by: "chat",
            });
            return yield* carryOutProposal(env, proposal.id, proposal.content_hash, board);
          });

        expect((yield* carry()).ok).toBe(true);
        const file = `${world.config}/verify/example.test/team/app.json`;
        expect(yield* fs.readFileString(file)).toContain('"executable": "true"');
        // The checkout it was started for still names the repository.
        yield* fs.remove(worktree, { recursive: true });
        expect((yield* carry()).ok).toBe(false);
        expect((yield* carry(true)).ok).toBe(true);
      }),
    ),
  60_000,
);

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
