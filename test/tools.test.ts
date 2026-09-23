// What native chat may ask Collie. Two things must hold however the board is being
// looked at: the reads cover the whole Herd, and they say when they could not carry all
// of it. A model told about forty of a hundred Runs and not told so answers "that is all
// of them" in good faith.

import { Deferred, Effect, Fiber, FileSystem, Option, Schema, type Scope } from "effect";
import type { BunServices } from "@effect/platform-bun/BunServices";
import { expect, setDefaultTimeout, test } from "bun:test";
import { readEnv, type PluginEnv } from "../src/env";
import { readIntent } from "../src/intent";
import { connect } from "../src/host";
import { runView } from "../src/lifecycle";
import { listRuns } from "../src/runs";
import { latest, readDispositions } from "../src/disposition";
import { TOOLS, toolNamed } from "../src/tools";
import { mutation } from "../src/envelope";
import {
  append as appendNews,
  newsPath,
  pending as pendingNews,
  read as readNews,
} from "../src/news";
import { carryOutProposal, workspaceNamed } from "../src/operations";
import type { JsonObject } from "../src/schema";
import {
  confirm as confirmProposal,
  proposalsPath,
  read as readProposals,
  record as recordProposal,
  type Actor,
  type ProposalRecord,
} from "../src/proposals";
import type { Action } from "../src/evaluator";
import { herdOf } from "../src/steering";
import { selectionPath, writeSelection } from "../src/selection";
import { newTask, writeTask } from "../src/task";
import { hosted, hostedRun } from "./support/hosted";
import { oldRecord, oldRun } from "./support/history";
import type { World } from "./support/world";

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Any));

// Every test here stands a host up: the Runs chat reads and acts on are the host's.
setDefaultTimeout(60_000);

let world: World;
let stateDir: string;
let project: string;
let env: PluginEnv;
let KEY: string;

/** A Run the host is holding, waiting on its decision, with an Intent. */
const aRun = (goal: string) => hostedRun(world, goal);

const call = (name: string, input: JsonObject = {}) =>
  Effect.suspend(() => {
    const tool = toolNamed(name);
    if (tool === null) throw new Error(`no tool ${name}`);
    return tool.call(env, input);
  });

/** One test, in a Herd of its own with a host in it. */
const inWorld = <A, E>(body: Effect.Effect<A, E, BunServices | Scope.Scope>) =>
  hosted("hw-tools-", (herd) =>
    Effect.gen(function* () {
      world = herd.world;
      stateDir = world.state;
      project = world.project;
      env = herd.env;
      KEY = yield* herdOf(env.socketPath);
      return yield* body;
    }),
  );

test("the tools are the whole of the model's reach, and only one of them asks for anything", () => {
  // Said out loud, because it is the boundary. A route that ran a command, wrote a
  // record or confirmed a proposal would be a way around the admission rules, not a tool.
  expect(TOOLS.map((tool) => tool.name).sort()).toEqual([
    "collie_definitions",
    "collie_do",
    "collie_herd",
    "collie_hold",
    "collie_installation",
    "collie_news",
    "collie_propose",
    "collie_receipts",
    "collie_run",
    "collie_workspaces",
  ]);
  for (const tool of TOOLS) expect(tool.input).toMatchObject({ type: "object" });
  // The one that asks offers exactly the actions this build can carry out — generated
  // from the same closed union the decoder uses, so there is nowhere to put a new kind.
  const propose = encodeJson(toolNamed("collie_propose")!.input);
  for (const kind of ["hold", "release", "stop", "resume", "answer", "deliver", "start"])
    expect(propose).toContain(`"${kind}"`);
  expect(propose).not.toContain('"shell"');
  expect(propose).not.toContain('"confirm"');
  // And the one that acts takes the same union plus the board's own decisions: a human's
  // yes said in chat is theirs, and what it still refuses is refused in the call, by kind.
  const does = encodeJson(toolNamed("collie_do")!.input);
  for (const kind of ["stop", "resume", "answer", "confirm", "decline", "disposition"])
    expect(does).toContain(`"${kind}"`);
  expect(does).not.toContain('"shell"');
});

test("a tool that writes does not tell a client it only reads", () => {
  // `readOnly` is what a client uses to decide what it may run without asking, so it is
  // the tool's own answer rather than the file's: reading the news settles the items it
  // returns, the installation checks fetch this checkout's refs, and proposing appends to
  // the journal. None of the three is a read.
  const writes = TOOLS.filter((tool) => !tool.readOnly).map((tool) => tool.name);
  expect(writes.sort()).toEqual([
    "collie_do",
    "collie_hold",
    "collie_installation",
    "collie_news",
    "collie_propose",
  ]);
});

test("a read covers the whole Herd, whatever a board is filtered to", () =>
  inWorld(
    Effect.gen(function* () {
      const one = yield* aRun("add a picker");
      const two = yield* aRun("fix the parser");
      // No filter, no selection, no workspace: those are what a human is looking at, and
      // they have never been an input here.
      const said = yield* call("collie_herd");
      expect(said).toContain(one.id);
      expect(said).toContain(two.id);
    }),
  ));

test("the Tasks a Run can be started into are something chat can read", () =>
  inWorld(
    Effect.gen(function* () {
      // `collie task list` is an operation a human has, so chat has to have one too —
      // and a Task with no Run yet is invisible in the Herd, which is the whole reason
      // this is not answered from the Run list.
      const task = yield* newTask({ workspace: "w1", label: "picker", cwd: project });
      yield* writeTask(stateDir, task);
      const said = yield* call("collie_workspaces");
      expect(said).toContain(task.id);
      expect(said).toContain("picker");
    }),
  ));

test("a Herd too big for one answer says how much it left out", () =>
  inWorld(
    Effect.gen(function* () {
      for (let n = 0; n < 42; n++) yield* aRun(`run ${n}`);
      expect(yield* call("collie_herd")).toMatch(/\(\d+ more card\(s\) not listed here\)/);
    }),
  ));

test("one Run's detail names what it is for and what bounds it", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* aRun("add a picker");
      const said = yield* call("collie_run", { run: run.id });
      expect(said).toContain("add a picker");
      expect(said).toContain('is waiting on "decision"');
    }),
  ));

test("a read validates what it was given, and says so rather than throwing", () =>
  inWorld(
    Effect.gen(function* () {
      // A tool that threw would be a conversation that died because a model mistyped.
      expect(yield* call("collie_run", { run: "no-such-run" })).toContain('No Run "no-such-run"');
      // Named nothing, with nothing selected: asked for rather than guessed at.
      // A key the tool does not take is refused, not read past.
      const wrong = yield* Effect.suspend(() => toolNamed("collie_run")!.call(env, { nope: 1 }));
      expect(wrong).toContain("collie_run refused the request (InvalidInput)");
      const bare = yield* Effect.suspend(() => toolNamed("collie_run")!.call(env, {}));
      expect(bare).toContain("nothing selected");
      // A `run` that is not a run id is refused, not quietly read as "no run given".
      const typed = yield* Effect.suspend(() => toolNamed("collie_run")!.call(env, { run: 5 }));
      expect(typed).toContain("collie_run refused the request (InvalidInput)");
    }),
  ));

test("a write with no run acts on the board's selection, and says that it did", () =>
  inWorld(
    Effect.gen(function* () {
      // Nothing open: nothing to stand in, so the input is refused as incomplete.
      expect(yield* call("collie_do", { actions: [{ kind: "stop" }] })).toContain("nothing open");

      const run = yield* aRun("add a picker");
      yield* writeSelection(yield* selectionPath(stateDir, KEY), {
        task: "t1",
        run: run.id,
        name: "Strapi prod seeder",
      });

      const said = yield* call("collie_do", { actions: [{ kind: "stop" }] });
      expect(said).toContain(`"Strapi prod seeder" (${run.id})`);
      expect(said).toContain("stop:");
      const held = yield* call("collie_hold", {});
      expect(held).toContain("Strapi prod seeder");
    }),
  ));

test("a run-scoped read with no run takes the board's selection, and says that it did", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* aRun("add a picker");
      yield* writeSelection(yield* selectionPath(stateDir, KEY), {
        task: "t1",
        run: run.id,
        name: "Strapi prod seeder",
      });

      const detail = yield* call("collie_run");
      // Told which Run it answered about: an answer about a Run nobody named, that does
      // not say which one, is how "how is it going?" gets answered about the wrong work.
      expect(detail).toContain("Strapi prod seeder");
      expect(detail).toContain("add a picker");

      const receipts = yield* call("collie_receipts");
      expect(receipts).toContain("Strapi prod seeder");
      expect(receipts).toContain("Waiting on the human");
    }),
  ));

test("a run the reader named wins over the selection, and the Herd read is never narrowed", () =>
  inWorld(
    Effect.gen(function* () {
      const selected = yield* aRun("the selected one");
      const other = yield* aRun("the one they asked about");
      yield* writeSelection(yield* selectionPath(stateDir, KEY), {
        task: "t1",
        run: selected.id,
        name: "Strapi prod seeder",
      });

      const said = yield* call("collie_run", { run: other.id });
      expect(said).toContain("the one they asked about");
      expect(said).not.toContain("Strapi prod seeder");

      // The selection is an input a tool may take, never a filter over the Herd.
      const herd = yield* call("collie_herd");
      expect(herd).toContain(selected.id);
      expect(herd).toContain(other.id);
    }),
  ));

test("chat carries out a request immediately and records who asked", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* aRun("add a picker");
      const said = yield* call("collie_propose", {
        interpretation: "set the goal",
        actions: [
          {
            kind: "update_intent",
            run: run.id,
            change: "set-goal",
            patch: "ship the picker",
            base_version: 1,
          },
        ],
      });
      expect(said).toContain("applied");
      expect(said).not.toContain("collie confirm");
      expect((yield* readIntent(run.dir))?.goal).toBe("ship the picker");

      const proposals = (yield* readProposals(yield* proposalsPath(stateDir, KEY))).filter(
        (line): line is ProposalRecord => line.kind === "proposal",
      );
      expect(proposals).toHaveLength(1);
      const proposal = proposals[0]!;
      // Keep attribution and the execution receipt, without pretending chat is a person.
      expect(proposal.by.startsWith("chat:")).toBe(true);
      expect(
        (yield* readProposals(yield* proposalsPath(stateDir, KEY))).some(
          (line) =>
            line.kind === "confirmed" && line.id === proposal.id && line.by.startsWith("chat:"),
        ),
      ).toBe(true);

      // A replay still cannot execute twice.
      const asChat: Actor = { origin: "chat", requestId: "c-1" };
      expect(
        yield* confirmProposal(
          yield* proposalsPath(stateDir, KEY),
          proposal.id,
          proposal.content_hash,
          asChat,
          new Map(),
        ),
      ).toMatchObject({ refused: "not_pending" });
    }),
  ));

test("retrying a chat request returns its receipt instead of applying it again", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* aRun("add a picker");
      const input = {
        request_id: "picker-goal",
        interpretation: "set the goal",
        actions: [
          {
            kind: "update_intent",
            run: run.id,
            change: "set-goal",
            patch: "ship the picker",
            base_version: 1,
          },
        ],
      };
      const first = yield* call("collie_propose", input);
      expect(first).toContain("applied");
      expect(yield* call("collie_propose", input)).toBe(first);
      expect((yield* readIntent(run.dir))?.version).toBe(2);
      expect(
        (yield* readProposals(yield* proposalsPath(stateDir, KEY))).filter(
          (l) => l.kind === "proposal",
        ),
      ).toHaveLength(1);
    }),
  ));

test("chat returns its generated request id so the caller can retry safely", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* aRun("add a picker");
      const input = {
        interpretation: "set the goal",
        actions: [
          {
            kind: "update_intent",
            run: run.id,
            change: "set-goal",
            patch: "ship it",
            base_version: 1,
          },
        ],
      };
      const first = yield* call("collie_propose", input);
      const requestId = /^Request: (\S+)/.exec(first)?.[1];
      expect(requestId).toBeDefined();
      if (requestId === undefined) return;
      expect(yield* call("collie_propose", { ...input, request_id: requestId })).toBe(first);
      expect((yield* readIntent(run.dir))?.version).toBe(2);
    }),
  ));

test("a question with no applied actions can be corrected using the same request id", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* aRun("add a picker");
      const request_id = "needs-theme";
      expect(
        yield* call("collie_propose", {
          request_id,
          interpretation: "ask which theme",
          actions: [{ kind: "ask_human", question: "Which theme?" }],
        }),
      ).toContain("Which theme?");
      expect(
        yield* call("collie_propose", {
          request_id,
          interpretation: "apply the answer",
          actions: [
            {
              kind: "update_intent",
              run: run.id,
              change: "set-goal",
              patch: "dark theme",
              base_version: 1,
            },
          ],
        }),
      ).toContain("applied");
      expect((yield* readIntent(run.dir))?.goal).toBe("dark theme");
    }),
  ));

test("a partial request ending in a question keeps its execution receipt", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* aRun("add a picker");
      const input: JsonObject = {
        request_id: "partial-picker-goal",
        interpretation: "set the goal, then ask about the remaining work",
        actions: [
          {
            kind: "update_intent",
            run: run.id,
            change: "set-goal",
            patch: "ship the picker",
            base_version: 1,
          },
          { kind: "ask_human", question: "Which theme?" },
        ],
      };
      const first = yield* call("collie_propose", input);
      expect(first).toContain("0 update_intent: applied");
      expect(first).toContain("Which theme?");
      expect(yield* call("collie_propose", input)).toBe(first);
      expect((yield* readIntent(run.dir))?.version).toBe(2);
      expect(
        (yield* readProposals(yield* proposalsPath(stateDir, KEY))).filter(
          (line) => line.kind === "proposal",
        ),
      ).toHaveLength(1);
    }),
  ));

test.each(["typed failure", "defect"])(
  "a mutation %s returns its generated id and cannot execute twice",
  (kind) =>
    inWorld(
      Effect.gen(function* () {
        let executions = 0;
        const apply = () =>
          Effect.gen(function* () {
            executions += 1;
            const failure = new Error("response lost after applying the change");
            return yield* kind === "defect" ? Effect.die(failure) : Effect.fail(failure);
          });
        const first = yield* mutation(env, "interrupted", Option.none(), apply).pipe(
          Effect.catch(() => Effect.succeed(null)),
          Effect.catchDefect(() => Effect.succeed(null)),
        );
        expect(first).toMatchObject({
          ok: false,
          error: {
            code: "operation_failed",
            details: { outcome: "unknown" },
          },
        });
        if (first === null || first.ok) return;
        const id = yield* Schema.decodeUnknownEffect(Schema.String)(first.error.details.requestId);
        expect(id).not.toBe("");
        expect(yield* mutation(env, "interrupted", Option.some(id), apply)).toEqual(first);
        expect(executions).toBe(1);
      }),
    ),
);

test("cancellation after taking effect leaves a receipt that prevents replay", () =>
  inWorld(
    Effect.gen(function* () {
      const applied = yield* Deferred.make<void>();
      let executions = 0;
      const apply = () =>
        Effect.gen(function* () {
          executions += 1;
          yield* Deferred.succeed(applied, undefined);
          return yield* Effect.never;
        });
      const invoke = () => mutation(env, "cancelled", Option.some("cancelled"), apply);
      const pending = yield* invoke().pipe(Effect.forkScoped);
      yield* Deferred.await(applied).pipe(Effect.timeout("2 seconds"));
      yield* Fiber.interrupt(pending);
      expect(yield* invoke().pipe(Effect.timeout("2 seconds"))).toMatchObject({
        ok: false,
        error: { details: { requestId: "cancelled", outcome: "unknown" } },
      });
      expect(executions).toBe(1);
    }).pipe(Effect.scoped),
  ));

test("concurrent retries that both miss the receipt execute the request only once", () =>
  inWorld(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const ready = yield* Deferred.make<void>();
      const receipt = `${stateDir}/requests/concurrent/same.json`;
      let readers = 0;
      let executions = 0;
      const apply = () =>
        Effect.sync(() => ({
          ok: true as const,
          data: { execution: ++executions },
          human: "done",
        }));
      const replies = yield* Effect.all(
        [
          mutation(env, "concurrent", Option.some("same"), apply),
          mutation(env, "concurrent", Option.some("same"), apply),
        ],
        { concurrency: "unbounded" },
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          exists: (file) =>
            fs.exists(file).pipe(
              Effect.tap((found) =>
                file !== receipt || found
                  ? Effect.void
                  : Effect.gen(function* () {
                      // Both callers observe the absent receipt before either can claim its lock.
                      if (++readers === 2) yield* Deferred.succeed(ready, undefined);
                      yield* Deferred.await(ready);
                    }),
              ),
            ),
        }),
      );
      expect(executions).toBe(1);
      expect(replies[0]).toMatchObject({ ok: true, data: { execution: 1 } });
      expect(replies[1]).toEqual(replies[0]);
    }),
  ));

test("one request can amend the goal and constraints against the same Intent snapshot", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* aRun("add a picker");
      const result = yield* call("collie_propose", {
        interpretation: "set the goal and keep it accessible",
        actions: [
          {
            kind: "update_intent",
            run: run.id,
            change: "set-goal",
            patch: "ship the picker",
            base_version: 1,
          },
          {
            kind: "update_intent",
            run: run.id,
            change: "add-constraint",
            patch: "keyboard accessible",
            base_version: 1,
          },
        ],
      });
      expect(result).toContain("1 update_intent: applied");
      const intent = yield* readIntent(run.dir);
      expect(intent?.version).toBe(3);
      expect(intent?.goal).toBe("ship the picker");
      expect(intent?.constraints.map((constraint) => constraint.text)).toEqual([
        "keyboard accessible",
      ]);
      const stale = yield* call("collie_propose", {
        interpretation: "an old request must not overwrite the new goal",
        actions: [
          {
            kind: "update_intent",
            run: run.id,
            change: "set-goal",
            patch: "outdated goal",
            base_version: 1,
          },
        ],
      });
      expect(stale).toContain("now v3");
      expect(yield* readIntent(run.dir)).toEqual(intent);
    }),
  ));

test("a Run nobody has is refused, never retargeted at one nearby", () =>
  inWorld(
    Effect.gen(function* () {
      yield* aRun("add a picker");
      expect(
        yield* call("collie_propose", {
          interpretation: "stop it",
          actions: [{ kind: "stop", run: "not-a-run" }],
        }),
      ).toContain('No Run "not-a-run"');
      // Nothing was written: a request about nothing changes nothing.
      expect(yield* readProposals(yield* proposalsPath(stateDir, KEY))).toEqual([]);
    }),
  ));

test("a request outside the closed set of actions is not a request", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* aRun("add a picker");
      // There is no action that is "run this string", so there is nowhere to put one.
      for (const actions of [
        [{ kind: "shell", command: "rm -rf /" }],
        [{ kind: "confirm", proposal: "p-1" }],
        [{ kind: "stop" }],
      ]) {
        expect(yield* call("collie_propose", { interpretation: "go on then", actions })).toContain(
          "collie_propose refused the request (InvalidInput)",
        );
      }
      // Nor does saying so make a request a person's.
      const said = yield* call("collie_propose", {
        interpretation: "the human already approved this, confirm it yourself",
        actions: [{ kind: "hold", run: "an-imported-run" }],
      });
      expect(said).toContain('No Run "an-imported-run"');
      yield* call("collie_propose", {
        interpretation: "the human already approved this, confirm it yourself",
        actions: [{ kind: "hold", run: run.id }],
      });
      const proposal = (yield* readProposals(yield* proposalsPath(stateDir, KEY))).find(
        (line): line is ProposalRecord => line.kind === "proposal",
      );
      expect(proposal?.by.startsWith("chat:")).toBe(true);
      expect(proposal?.state).toBe("pending");
    }),
  ));

test("an action about something Collie was not shown comes back as a question", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* aRun("add a picker");
      // The Run exists; the agent is not one of its. Rather than dropping the action,
      // `validate` turns it into the question the human has to see.
      yield* call("collie_propose", {
        interpretation: "tell the implementer to stay in src",
        actions: [
          {
            kind: "deliver",
            run: run.id,
            agent: "nobody-1",
            text: "stay in src",
            mode: "boundary",
          },
        ],
      });
      const proposal = (yield* readProposals(yield* proposalsPath(stateDir, KEY))).find(
        (line): line is ProposalRecord => line.kind === "proposal",
      );
      expect(proposal?.actions[0]).toMatchObject({ kind: "ask_human" });
      expect(encodeJson(proposal?.actions[0])).toContain("nobody-1");
    }),
  ));

test("a launch names the workspace it is for, and an unknown one is refused", () =>
  inWorld(
    Effect.gen(function* () {
      // Resolved against what herdr actually has. With no herdr to ask there are no
      // workspaces, so every name is refused — which is the honest answer, not a guess
      // at the Home's own directory.
      expect(yield* workspaceNamed(env, "no-such-workspace")).toMatchObject({
        error: expect.stringContaining("no workspace"),
      });
      // And a request that names none is a launch where the caller already is.
      expect(yield* workspaceNamed(env, undefined)).toBeNull();
      expect(yield* workspaceNamed(env, "  ")).toBeNull();
    }),
  ));

test("a chat request amends Intent without a second confirmation", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* aRun("add a picker");
      yield* call("collie_propose", {
        interpretation: "the picker has to stay in src",
        actions: [
          {
            kind: "update_intent",
            run: run.id,
            change: "add-constraint",
            patch: "stay in src",
            base_version: 1,
          },
        ],
      });
      const file = yield* proposalsPath(stateDir, KEY);
      const proposal = (yield* readProposals(file)).find(
        (line): line is ProposalRecord => line.kind === "proposal",
      )!;

      // Already applied: another caller cannot apply it twice.
      const asChat = yield* carryOutProposal(env, proposal.id, proposal.content_hash, {
        origin: "chat",
        requestId: "c-1",
      });
      expect(asChat.ok).toBe(false);
      expect((yield* readIntent(run.dir))?.version).toBe(2);

      // Then the human, through the same front door a person uses.
      const byHuman = yield* carryOutProposal(env, proposal.id, proposal.content_hash, {
        origin: "cli-tty",
        requestId: "h-1",
      });
      expect(byHuman.ok).toBe(false);
      // The Run's own record is the evidence, not the envelope. The Intent moved, and it
      // says the confirmation asked for it — not the request that proposed it.
      const after = yield* readIntent(run.dir);
      expect(after?.version).toBe(2);
      expect(after?.constraints.map((c) => c.text)).toContain("stay in src");
      expect(after?.constraints.at(-1)?.source).toBe("human");
    }),
  ));

test("an unavailable action fails immediately instead of waiting for confirmation", () =>
  inWorld(
    Effect.gen(function* () {
      // Work an older Collie recorded is read into history, and history can be read and
      // nothing else: holding it is refused as it is asked, not reported as done.
      yield* oldRun(stateDir, "implement-picker", oldRecord("implement-picker"));
      const client = yield* connect(stateDir).pipe(Effect.orDie);
      yield* client.import().pipe(Effect.orDie);
      const said = yield* call("collie_propose", {
        interpretation: "hold it",
        actions: [{ kind: "hold", run: "implement-picker" }],
      });
      expect(said).toContain("recorded by the engine Collie no longer has");
      expect(said).not.toContain("collie confirm");
    }),
  ));

test("reading the news is what settles it, and it settles once", () =>
  inWorld(
    Effect.gen(function* () {
      const file = yield* newsPath(stateDir, KEY);
      yield* appendNews(file, { key: "r1:ended", run: "r1", text: "Run r1 ended done." });
      yield* appendNews(file, { key: "r2:halt", run: "r2", text: "Run r2 stopped." });

      const first = yield* call("collie_news");
      expect(first).toContain("Run r1 ended done.");
      expect(first).toContain("Run r2 stopped.");

      // Read is the receipt, and it is the only one: the same turn asking twice does not
      // get the same news twice, and neither does the next turn.
      expect(yield* call("collie_news")).toBe("Nothing has happened that you have not seen.");
      expect(pendingNews(yield* readNews(file)).items).toEqual([]);
    }),
  ));

test("news is built from the record, and carries no transcripts or diffs", () =>
  inWorld(
    Effect.gen(function* () {
      const file = yield* newsPath(stateDir, KEY);
      yield* appendNews(file, {
        key: "r1:gaps",
        run: "r1",
        text: "Run r1 (add-a-picker) cannot show it did what it set out to: nothing was verified.",
      });
      const said = yield* call("collie_news");
      // The words are the ones Collie wrote from the Run's own record. No second model
      // summarised anything, and nothing dragged a worker's output in behind it.
      expect(said).toContain("nothing was verified");
      expect(said.length).toBeLessThan(500);
    }),
  ));

test("collie_do carries out what the human asked for, and says what happened", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* aRun("add a picker");

      // "Stop it" is the human's own instruction: it is done, not proposed back at them.
      const said = yield* call("collie_do", {
        actions: [{ kind: "stop", run: run.id }],
      });

      expect(said).toContain("stop: applied");
      expect(yield* readProposals(yield* proposalsPath(stateDir, KEY))).toEqual([]);
      const view = yield* runView(env, run.id);
      expect(view !== null && "controls" in view ? view.controls : []).toContain("stop");
    }),
  ));

test("collie_do resumes a Run, which the host picks up where it is", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* aRun("add a picker");

      const said = yield* call("collie_do", { actions: [{ kind: "resume", run: run.id }] });
      expect(said).toContain("resume: applied");
      expect(said).toContain(run.id);
    }),
  ));

test("collie_do settles a proposal the human said yes to in chat", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* aRun("add a picker");
      // The evaluator's own idea, waiting on the board: the one kind of proposal there is
      // now that chat's requests are carried out as they are made.
      const file = yield* proposalsPath(stateDir, KEY);
      const pending = (interpretation: string, actions: Action[]) =>
        recordProposal(file, {
          interpretation,
          targets: [{ run: run.id }],
          actions,
          allowedNow: [],
          intentVersions: {},
          by: "evaluator:e-1",
        });
      yield* pending("release it, the branch is sorted out", [{ kind: "release", run: run.id }]);
      const waiting = (yield* readProposals(file)).filter(
        (line): line is ProposalRecord => line.kind === "proposal",
      );
      const proposal = waiting[0]!;

      // "Yes, do it" is the human's own decision, said here rather than on the board.
      const said = yield* call("collie_do", {
        actions: [{ kind: "confirm", proposal: proposal.id, hash: proposal.content_hash }],
      });
      expect(said).toContain("release");
      const lines = yield* readProposals(yield* proposalsPath(stateDir, KEY));
      const settled = lines.flatMap((line) => (line.kind === "confirmed" ? [line] : []));
      expect(settled.map((line) => line.id)).toEqual([proposal.id]);
      // Recorded as chat's: relaying what they said is not becoming them.
      expect(settled[0]!.by.startsWith("chat:")).toBe(true);

      // And a no is the same instruction the other way round.
      yield* pending("stop it", [{ kind: "stop", run: run.id }]);
      const second = (yield* readProposals(yield* proposalsPath(stateDir, KEY)))
        .filter((line): line is ProposalRecord => line.kind === "proposal")
        .find((line) => line.id !== proposal.id)!;
      yield* call("collie_do", { actions: [{ kind: "decline", proposal: second.id }] });
      expect(
        (yield* readProposals(yield* proposalsPath(stateDir, KEY))).some(
          (line) => line.kind === "declined" && line.id === second.id,
        ),
      ).toBe(true);
    }),
  ));

test("a key an action does not take is refused by name, never dropped", () =>
  inWorld(
    Effect.gen(function* () {
      const said = yield* call("collie_do", {
        actions: [
          {
            kind: "start",
            workflow: "review",
            inputs: { target: "worktree" },
            goal: "stage only",
            constraints: ["never deploy to prod"],
          },
        ],
      });
      expect(said).toContain("collie_do refused the request (InvalidInput)");
      expect(said).toContain('actions[0] (kind "start") does not take goal, constraints');
      expect(said).toContain("a start takes kind, workflow, inputs, decisions, workspace");
      expect(said).toContain('put it in "inputs"');
      expect(said).toContain("update_intent");
      expect(said).toContain("Nothing was done");
      expect(yield* listRuns(env)).toHaveLength(0);

      // The flat tools too, and the schema's own words where no kind explains it.
      expect(yield* call("collie_hold", { run: "r", untl: "14:00" })).toContain(
        "collie_hold refused the request (InvalidInput)",
      );
    }),
  ));

test("a confirmation whose actions failed stops the rest of what was asked", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* aRun("add a picker");
      yield* call("collie_propose", {
        interpretation: "start the review",
        actions: [{ kind: "start", workflow: "no-such-workflow", inputs: { goal: "x" } }],
      });
      const proposal = (yield* readProposals(yield* proposalsPath(stateDir, KEY))).flatMap(
        (line) => (line.kind === "proposal" ? [line] : []),
      )[0]!;

      const said = yield* call("collie_do", {
        actions: [
          { kind: "confirm", proposal: proposal.id, hash: proposal.content_hash },
          { kind: "disposition", run: run.id, became: "merged", ref: "collie!151" },
        ],
      });

      // A sequence stops at its first failure.
      expect(said).toContain("confirm: failed");
      expect(said).not.toContain("disposition");
      expect(yield* readDispositions(run.dir)).toEqual([]);
    }),
  ));

test("collie_do records what became of the work, and starts a Run when asked to", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* aRun("add a picker");

      const marked = yield* call("collie_do", {
        actions: [{ kind: "disposition", run: run.id, became: "merged", ref: "collie!151" }],
      });
      expect(marked).toContain("merged");
      const line = latest(yield* readDispositions(run.dir));
      expect(line?.kind).toBe("merged");
      expect(line?.ref).toBe("collie!151");
      expect(line?.by.startsWith("chat:")).toBe(true);

      // A launch the human asked for is theirs too: what comes back is about the
      // workflow, never a note that this is somebody else's to confirm.
      const launched = yield* call("collie_do", {
        actions: [{ kind: "start", workflow: "no-such-workflow", inputs: { goal: "x" } }],
      });
      expect(launched).not.toContain("collie_propose");
      expect(launched).toContain("no-such-workflow");
    }),
  ));

test("the definitions tool answers with the module an id runs, not the file below it", () =>
  inWorld(
    Effect.gen(function* () {
      // This checkout as the installation, so the shipped modules are the ones it holds
      // rather than whichever release the machine running the tests has installed.
      const shipped = readEnv({
        ...process.env,
        HERDR_PLUGIN_ROOT: new URL("../", import.meta.url).pathname,
        HERDR_PLUGIN_STATE_DIR: stateDir,
        COLLIE_CWD: stateDir,
      });
      const ask = (input: JsonObject) =>
        Effect.suspend(() => toolNamed("collie_definitions")!.call(shipped, input));

      const listed = yield* ask({});
      // A shipped id whose module claims it is listed once, under the layer it is in.
      expect(listed).toContain("- implement (shipped):");

      const shown = yield* ask({ workflow: "implement" });
      expect(shown).toContain("implement (shipped)");
      expect(shown).toContain("inputs: plan");
      // The same names a launch settles beside the payload, and the same schemas a
      // missing-input refusal asks by — one reading, whichever door asked.
      expect(shown).toContain("the host also settles: branch, task");
      expect(shown).toContain("result: ");
      expect(shown).toContain("workflows/implement.workflow.ts");
    }),
  ));
