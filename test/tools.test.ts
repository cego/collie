import * as Order from "effect/Order";
import { recordsAt } from "./support/records";
import type { Records } from "../src/records";
import * as Cause from "effect/Cause";

// WARNING: Reads cover the whole Herd and say when truncated: a model not told answers 'that is all of them' in good faith.
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import {
  Clock,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Schema,
  flow as Schemaflow,
  Result,
} from "effect";
import type { Scope } from "effect";
import * as SecureRandom from "effect/crypto/SecureRandom";
import type { PlatformServices } from "../src/platform";
import { expect, setDefaultTimeout, test } from "bun:test";
import { hostname } from "node:os";
import { readEnv } from "../src/env";
import type { PluginEnv } from "../src/env";
import { setSetting } from "../src/config";
import { reachKey } from "../src/reach";
import { amend, readIntent, writeIntent } from "../src/intent";
import { ensureLockDir, withLock } from "../src/lock";
import { nowIso } from "../src/time";
import { changeSchedule, runView, scheduleListing } from "../src/lifecycle";
import { listRuns } from "../src/runs";
import { latest, readDispositions } from "../src/disposition";
import { TOOLS, toolNamed } from "../src/tools";
import { CollieTools } from "../src/toolkit";
import { mutation } from "../src/envelope";
import {
  append as appendNews,
  NATIVE,
  newsPath,
  pending as pendingNews,
  read as readNews,
} from "../src/news";
import { carryOutProposal, workspaceNamed } from "../src/operations";
import type { JsonObject } from "../src/schema";
import {
  confirm as confirmProposal,
  pendingHerdWide,
  read as readProposals,
  record as recordProposal,
} from "../src/proposals";
import type { Actor, ProposalRecord } from "../src/proposals";
import type { Action } from "../src/actions";
import { appendLine, machineHerd } from "../src/steering";
import { CHAT_TERMINAL, chatPath, HEARD_MAX, hear, writeChat } from "../src/chat";
import { connect as connectCore } from "../src/hc";
import { selectionPath, writeSelection } from "../src/selection";
import { newTask, writeTask } from "../src/task";
import { hosted, hostedRun, settledRun } from "./support/hosted";
import { openServer } from "./support/mcp";
import { SETUP } from "./support/fake-hc";
import type { FakeHc } from "./support/fake-hc";
import { save } from "./support/world";
import type { World } from "./support/world";
import { until } from "./support/host";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import { connect, frontDoor, socketOf } from "../src/host";
import { runDir } from "../src/engine";
import type { RunView } from "../src/engine";
import { isSettled } from "../src/lifecycle";
import { appendLog, MERGE_REQUEST } from "../src/oversight";
import { RunRecords } from "../src/run-records";
import { registerAgent } from "../src/registry";
import { AUDIT_FILE, readAudit } from "../src/audit";
import * as SqlClient from "effect/sql/SqlClient";
import { storedAnswers } from "./support/forge";
import { Flow, FrontDoorRpcs } from "../src/board-model";
import type { Declaration, FLOCK_READS } from "../src/board-model";

const encodeJson = Schemaflow(
  Schema.encodeUnknownResult(Schema.fromJsonString(Schema.Any)),
  Result.getOrThrow,
);

setDefaultTimeout(60_000);

let world: World;
let stateDir: string;
let project: string;
let env: PluginEnv;
let KEY: string;
let core: FakeHc;

const aRun = (goal: string) => hostedRun(world, goal);

const call = (name: string, input: JsonObject = {}) =>
  Effect.suspend(() => {
    const tool = toolNamed(name);
    if (tool === null) {
      throw new Error(`no tool ${name}`);
    }
    return tool.call(env, input);
  });

const callAs = (seated: PluginEnv, name: string, input: JsonObject = {}) =>
  Effect.suspend(() => {
    const tool = toolNamed(name);
    if (tool === null) {
      throw new Error(`no tool ${name}`);
    }
    return tool.call(seated, input);
  });

const healerSeat = Effect.fn("ToolsTest.healerSeat")(function* () {
  const heal = yield* aRun("heal the flock");
  yield* registerAgent(
    { session: null, workspaceId: null, cwd: project },
    {
      role: "healer",
      agent: "mender",
      paneId: "p-heal",
      workspaceId: null,
      runId: heal.id,
      workflow: "heal",
      at: "2026-11-13T00:00:00.000Z",
    },
  );
  return {
    ...env,
    asker: { origin: "agent" as const, from: { run: heal.id, agent: "mender" } },
  };
});

const constraintPatch = "keep the picker behind a flag";

const inWorld = <A, E>(body: Effect.Effect<A, E, PlatformServices | Records | Scope.Scope>) =>
  hosted("hw-tools-", (herd) =>
    Effect.gen(function* () {
      world = herd.world;
      stateDir = world.state;
      project = world.project;
      env = herd.env;
      core = herd.core;
      KEY = yield* machineHerd(env);
      return yield* body.pipe(Effect.provide(recordsAt(stateDir)));
    }),
  );

test("the tools are the whole of the model's reach, and only one of them asks for anything", () => {
  expect(
    Arr.sort(
      Arr.map(TOOLS, (tool) => tool.name),
      Order.String,
    ),
  ).toEqual([
    "collie_artefacts",
    "collie_connections",
    "collie_definitions",
    "collie_do",
    "collie_herd",
    "collie_hold",
    "collie_installation",
    "collie_models",
    "collie_news",
    "collie_propose",
    "collie_receipts",
    "collie_report",
    "collie_run",
    "collie_workspaces",
  ]);
  for (const tool of TOOLS) {
    expect(tool.input).toMatchObject({ type: "object" });
  }
  const propose = encodeJson(toolNamed("collie_propose")!.input);
  for (const kind of ["hold", "release", "stop", "resume", "answer", "deliver", "start"]) {
    expect(propose).toContain(`"${kind}"`);
  }
  expect(propose).not.toContain('"shell"');
  expect(propose).not.toContain('"confirm"');
  const does = encodeJson(toolNamed("collie_do")!.input);
  for (const kind of ["stop", "resume", "answer", "confirm", "decline", "disposition"]) {
    expect(does).toContain(`"${kind}"`);
  }
  expect(does).not.toContain('"shell"');
});

test("the tools are one Toolkit, each saying how it fails and that it needs no approval", () => {
  expect(
    Arr.sort(
      Arr.map(TOOLS, (tool) => tool.name),
      Order.String,
    ),
  ).toEqual([
    "collie_artefacts",
    "collie_connections",
    "collie_definitions",
    "collie_do",
    "collie_herd",
    "collie_hold",
    "collie_installation",
    "collie_models",
    "collie_news",
    "collie_propose",
    "collie_receipts",
    "collie_report",
    "collie_run",
    "collie_workspaces",
  ]);
  for (const tool of Rec.values(CollieTools.tools)) {
    expect([tool.name, tool.failureMode]).toEqual([tool.name, "return"]);
    expect([tool.name, tool.needsApproval]).toEqual([tool.name, false]);
  }
});

test("a tool that writes does not tell a client it only reads", () => {
  // WARNING: readOnly is the tool's own answer: reading news, checking the installation and proposing all write.
  const writes = Arr.map(
    Arr.filter(TOOLS, (tool) => !tool.readOnly),
    (tool) => tool.name,
  );
  expect(Arr.sort(writes, Order.String)).toEqual([
    "collie_do",
    "collie_hold",
    "collie_installation",
    "collie_news",
    "collie_propose",
  ]);
});

test("the Tasks a Run can be started into are something chat can read", () =>
  inWorld(
    Effect.gen(function* () {
      // WARNING: A Task with no Run is invisible in the Herd, so tasks are listed from the Task list, not the Run list.
      const task = yield* newTask({
        workspace: null,
        label: "picker",
        cwd: project,
        herd: null,
      });
      yield* writeTask(task);
      const said = yield* call("collie_workspaces");
      expect(said).toContain(task.id);
      expect(said).toContain("picker");
    }),
  ));

test("chat reads how far each workflow can go, and what the last launch in a project chose", () =>
  inWorld(
    Effect.gen(function* () {
      yield* save(world.user, ["reached.workflow.ts"]);
      const unsaid = Str.split(yield* call("collie_workspaces"), "\n");
      expect(unsaid).toContain('  then, how far it goes: "" Ask at the end · "ship" Ship it');
      yield* setSetting(
        world.config,
        reachKey("reached", project),
        "ship",
        "2026-11-12T10:00:00.000Z",
      );
      expect(Str.split(yield* call("collie_workspaces"), "\n")).toContain(
        `  then, how far it goes: "" Ask at the end · "ship" Ship it; last launched with "ship" in ${project}`,
      );
    }),
  ));

test("with no host to ask, chat is told the Tasks are unknown, not that there are none", () =>
  runEffect(
    Effect.gen(function* () {
      const alone = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "hw-tools-no-host-",
      });
      const tool = toolNamed("collie_workspaces")!;
      const said = yield* tool.call(
        readEnv({ ...process.env, COLLIE_STATE_DIR: alone, PATH: "" }),
        {},
      );
      expect(said).toContain("the Tasks are unknown");
      expect(said).not.toContain("no Tasks with an open workspace");
    }).pipe(Effect.scoped),
  ));

test("a Herd too big for one answer says how much it left out", () =>
  inWorld(
    Effect.gen(function* () {
      yield* Effect.forEach(
        Array.from({ length: 42 }, (_, n) => `run ${n}`),
        aRun,
        {
          concurrency: 8,
        },
      );
      const first = yield* call("collie_herd");
      expect(first).toMatch(/\(\d+ more card\(s\) not listed here\) complete: false/);
      const next = /next: "([^"]+)"/.exec(first)?.[1];
      expect(next).toBeDefined();
      const rest = yield* call("collie_herd", { after: next! });
      expect(rest).toContain("- complete: true");
      expect(rest).not.toContain("not listed here");
    }),
  ));

const Listed = Schema.fromJsonString(
  Schema.Struct({
    runs: Schema.Array(Schema.Struct({ runId: Schema.String, state: Schema.String })),
    complete: Schema.Boolean,
    next: Schema.NullOr(Schema.String),
  }),
);

test("the run tool lists a page that says whether it is whole, and its next reaches the end", () =>
  inWorld(
    Effect.gen(function* () {
      const made = yield* Effect.forEach(["one", "two", "three", "four", "five"], aRun, {
        concurrency: 5,
      });
      const read = (input: JsonObject) =>
        call("collie_run", input).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Listed)));
      let page = yield* read({ list: true, limit: 2 });
      expect(page.runs.length).toBe(2);
      expect(page.complete).toBe(false);
      const seen = Arr.map(page.runs, (one) => one.runId);
      while (page.next !== null) {
        page = yield* read({ list: true, after: page.next });
        seen.push(...Arr.map(page.runs, (one) => one.runId));
      }
      expect(page.complete).toBe(true);
      expect([...seen].sort()).toEqual(Arr.map(made, (run) => run.id).sort());

      // WARNING: A filter belongs to a listing, so given without list it is refused rather than ignored.
      expect(yield* call("collie_run", { status: ["live"] })).toContain(
        'collie_run refused the request (InvalidInput): status only filter a listing, which takes "list": true',
      );
    }),
  ));

test("one Run's detail names what it is for and what bounds it", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* aRun("add a picker");
      const said = yield* call("collie_run", { run: run.id });
      expect(said).toContain("add a picker");
      expect(said).toContain('"decision": What should this run do?');
      expect(said).toContain("answered in words");
    }),
  ));

test("a read validates what it was given, and says so rather than throwing", () =>
  inWorld(
    Effect.gen(function* () {
      expect(yield* call("collie_run", { run: "no-such-run" })).toContain('No Run "no-such-run"');
      const wrong = yield* Effect.suspend(() => toolNamed("collie_run")!.call(env, { nope: 1 }));
      expect(wrong).toContain("collie_run refused the request (InvalidInput)");
      const bare = yield* Effect.suspend(() => toolNamed("collie_run")!.call(env, {}));
      expect(bare).toContain("nothing selected");
      const typed = yield* Effect.suspend(() => toolNamed("collie_run")!.call(env, { run: 5 }));
      expect(typed).toContain("collie_run refused the request (InvalidInput)");
    }),
  ));

test("a write with no run acts on the board's selection, and says that it did", () =>
  inWorld(
    Effect.gen(function* () {
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
      // WARNING: Answers say which Run they concern; an unnamed answer is how the wrong work gets described.
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

      const proposals = Arr.filter(
        yield* readProposals(KEY),
        (line): line is ProposalRecord => line.kind === "proposal",
      );
      expect(proposals).toHaveLength(1);
      const proposal = proposals[0]!;
      expect(pipe_(proposal.by, Str.startsWith("chat:"))).toBe(true);
      expect(
        Arr.some(
          yield* readProposals(KEY),
          (line) =>
            line.kind === "confirmed" &&
            line.id === proposal.id &&
            pipe_(line.by, Str.startsWith("chat:")),
        ),
      ).toBe(true);

      const asChat: Actor = { origin: "chat", requestId: "c-1" };
      expect(
        yield* confirmProposal(KEY, proposal.id, proposal.content_hash, asChat, new Map()),
      ).toMatchObject({ refused: "not_pending" });
    }),
  ));

test("chat changes a Run's outcome kind through the host, which refuses one it does not know", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* aRun("add a picker");
      const outcome = (patch: string, base_version: number) =>
        call("collie_propose", {
          interpretation: "change the kind",
          actions: [
            { kind: "update_intent", run: run.id, change: "set-outcome", patch, base_version },
          ],
        });
      expect(yield* outcome("feature", 1)).toContain("applied");
      expect((yield* readIntent(run.dir))?.outcome).toBe("feature");
      expect(yield* outcome("chore", 2)).toContain('"chore" is not an outcome');
      expect((yield* readIntent(run.dir))?.version).toBe(2);
    }),
  ));

test("of two outcome changes made on the same Intent version at once, only one applies", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* aRun("add a picker");
      const outcome = (patch: string) =>
        call("collie_propose", {
          interpretation: "change the kind",
          actions: [
            { kind: "update_intent", run: run.id, change: "set-outcome", patch, base_version: 1 },
          ],
        });
      const said = yield* Effect.all([outcome("feature"), outcome("bug")], {
        concurrency: "unbounded",
      });
      expect(Arr.filter(said, (one) => pipe_(one, Str.includes("applied")))).toHaveLength(1);
      expect(Arr.filter(said, (one) => pipe_(one, Str.includes("not v1")))).toHaveLength(1);
      expect((yield* readIntent(run.dir))?.version).toBe(2);
    }),
  ));

test("an outcome change made on an Intent amended since its version is refused for its version", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* aRun("add a picker");
      const intent = yield* readIntent(run.dir);
      if (intent === null) {
        return yield* Effect.die("the Run has no Intent");
      }
      yield* writeIntent(
        run.dir,
        amend(intent, { kind: "set-goal", goal: "a wider picker" }, "human:test", yield* nowIso),
      );
      const change = yield* call("collie_propose", {
        interpretation: "change the kind",
        actions: [
          {
            kind: "update_intent",
            run: run.id,
            change: "set-outcome",
            patch: "bug",
            base_version: 1,
          },
        ],
      });
      expect(change).toContain("which is now v2");
      expect(change).not.toContain("applied");
      expect((yield* readIntent(run.dir))?.goal).toBe("a wider picker");
    }),
  ));

test("an outcome change that waits out a long-held Proposals journal lock is applied, not refused as busy", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* aRun("add a picker");
      const journal = KEY;
      yield* ensureLockDir(journal);
      const pending = yield* withLock(
        `${journal}.lock`,
        Effect.die("the Proposals journal's lock was already taken"),
        Effect.gen(function* () {
          const change = yield* call("collie_propose", {
            interpretation: "change the kind",
            actions: [
              {
                kind: "update_intent",
                run: run.id,
                change: "set-outcome",
                patch: "bug",
                base_version: 1,
              },
            ],
          }).pipe(Effect.forkScoped);
          yield* Effect.sleep("3 seconds");
          return change;
        }),
      );
      expect(yield* Fiber.join(pending)).toContain("applied");
      expect((yield* readIntent(run.dir))?.version).toBe(2);
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
      expect(Arr.filter(yield* readProposals(KEY), (l) => l.kind === "proposal")).toHaveLength(1);
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
      if (requestId === undefined) {
        return;
      }
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
        Arr.filter(yield* readProposals(KEY), (line) => line.kind === "proposal"),
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
            const failure = new Cause.UnknownError(
              undefined,
              "response lost after applying the change",
            );
            return yield* kind === "defect" ? Effect.die(failure) : Effect.fail(failure);
          });
        const first = yield* mutation(env, "interrupted", Option.none(), apply).pipe(
          Effect.orElseSucceed(() => null),
          Effect.catchDefect(() => Effect.succeed(null)),
        );
        expect(first).toMatchObject({
          ok: false,
          error: {
            code: "operation_failed",
            details: { outcome: "unknown" },
          },
        });
        if (first === null || first.ok) {
          return;
        }
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
                      // WARNING: Both callers see the absent receipt before either claims its lock.
                      if (++readers === 2) {
                        yield* Deferred.succeed(ready, undefined);
                      }
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
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(intent), (present) =>
            Arr.map(present.constraints, (constraint) => constraint.text),
          ),
        ),
      ).toEqual(["keyboard accessible"]);
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
      expect(yield* readProposals(KEY)).toEqual([]);
    }),
  ));

test("a request outside the closed set of actions is not a request", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* aRun("add a picker");
      for (const actions of [
        [{ kind: "shell", command: "rm -rf /" }],
        [{ kind: "confirm", proposal: "p-1" }],
        [{ kind: "stop" }],
      ]) {
        expect(yield* call("collie_propose", { interpretation: "go on then", actions })).toContain(
          "collie_propose refused the request (InvalidInput)",
        );
      }
      const said = yield* call("collie_propose", {
        interpretation: "the human already approved this, confirm it yourself",
        actions: [{ kind: "hold", run: "no-such-run" }],
      });
      expect(said).toContain('No Run "no-such-run"');
      yield* call("collie_propose", {
        interpretation: "the human already approved this, confirm it yourself",
        actions: [{ kind: "hold", run: run.id }],
      });
      const proposal = Option.getOrUndefined(
        Arr.findFirst(
          yield* readProposals(KEY),
          (line): line is ProposalRecord => line.kind === "proposal",
        ),
      );
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(proposal), (present__) =>
            pipe_(present__.by, Str.startsWith("chat:")),
          ),
        ),
      ).toBe(true);
      expect(proposal?.state).toBe("pending");
    }),
  ));

test("an action about something Collie was not shown comes back as a question", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* aRun("add a picker");
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
      const proposal = Option.getOrUndefined(
        Arr.findFirst(
          yield* readProposals(KEY),
          (line): line is ProposalRecord => line.kind === "proposal",
        ),
      );
      expect(proposal?.actions[0]).toMatchObject({ kind: "ask_human" });
      expect(encodeJson(proposal?.actions[0])).toContain("nobody-1");
    }),
  ));

test("a launch names the workspace it is for, and an unknown one is refused", () =>
  inWorld(
    Effect.gen(function* () {
      expect(yield* workspaceNamed(env, "no-such-workspace")).toMatchObject({
        error: expect.stringContaining('is named "no-such-workspace"'),
      });
      expect(yield* workspaceNamed(env, undefined)).toBeNull();
      expect(yield* workspaceNamed(env, "  ")).toBeNull();
    }),
  ));

test("a start naming a repository finds its checkout under the Projects root, as the Home's chat would", () =>
  inWorld(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = (yield* fs.makeTempDirectoryScoped()) + "/projects";
      for (const checkout of ["cego/monorepo", "cego/engage", "forks/engage"]) {
        yield* fs.makeDirectory(`${root}/${checkout}/.git`, { recursive: true });
      }
      const elsewhere = { ...env, cwd: "/", raw: { ...env.raw, GITTE_CWD: root } };

      expect(yield* workspaceNamed(elsewhere, "monorepo")).toMatchObject({
        found: { label: "monorepo", cwd: `${root}/cego/monorepo` },
      });
      expect(yield* workspaceNamed(elsewhere, "engage")).toEqual({
        error: `"engage" names 2 checkouts under ${root} (${root}/cego/engage, ${root}/forks/engage); say which`,
      });
      expect(yield* workspaceNamed(elsewhere, "no-such-repo")).toMatchObject({
        error: expect.stringContaining('is named "no-such-repo"'),
      });
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
      const file = KEY;
      const proposal = Option.getOrUndefined(
        Arr.findFirst(
          yield* readProposals(file),
          (line): line is ProposalRecord => line.kind === "proposal",
        ),
      )!;

      const asChat = yield* carryOutProposal(env, proposal.id, proposal.content_hash, {
        origin: "chat",
        requestId: "c-1",
      });
      expect(asChat.ok).toBe(false);
      expect((yield* readIntent(run.dir))?.version).toBe(2);

      const byHuman = yield* carryOutProposal(env, proposal.id, proposal.content_hash, {
        origin: "cli-tty",
        requestId: "h-1",
      });
      expect(byHuman.ok).toBe(false);
      const after = yield* readIntent(run.dir);
      expect(after?.version).toBe(2);
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(after), (present_) =>
            Arr.map(present_.constraints, (c) => c.text),
          ),
        ),
      ).toContain("stay in src");
      expect(after?.constraints.at(-1)?.source).toBe("human");
    }),
  ));

test("an unavailable action fails immediately instead of waiting for confirmation", () =>
  inWorld(
    Effect.gen(function* () {
      const { id } = yield* settledRun(world, "hello");
      const said = yield* call("collie_propose", {
        interpretation: "hold it",
        actions: [{ kind: "hold", run: id }],
      });
      expect(said).toContain("a finished Run has no step left to hold");
      expect(said).not.toContain("collie confirm");
    }),
  ));

// WARNING: The host's news sweep is off here, or it retires these items before the read under test.
const newsFile = Effect.fn("test.newsFile")(function* () {
  yield* setSetting(env.userDir, "proactive", false, "2026-11-16T00:00:00.000Z");
  return yield* newsPath(stateDir, KEY);
});

test("reading the news is what settles it, and it settles once", () =>
  inWorld(
    Effect.gen(function* () {
      const file = yield* newsFile();
      yield* appendNews(file, { key: "r1:ended", run: "r1", text: "Run r1 ended done." });
      yield* appendNews(file, { key: "r2:halt", run: "r2", text: "Run r2 stopped." });

      const first = yield* call("collie_news");
      expect(first).toContain("Run r1 ended done.");
      expect(first).toContain("Run r2 stopped.");

      expect(yield* call("collie_news")).toBe("Nothing has happened that you have not seen.");
      expect(pendingNews(yield* readNews(file)).items).toEqual([]);
    }),
  ));

test("what Native chat read is still news to another conversation", () =>
  inWorld(
    Effect.gen(function* () {
      const file = yield* newsFile();
      yield* appendNews(file, { key: "r1:ended", run: "r1", text: "Run r1 ended done." });
      expect(yield* call("collie_news")).toContain("Run r1 ended done.");
      const lines = yield* readNews(file);
      expect(pendingNews(lines, NATIVE).items).toEqual([]);
      expect(Arr.map(pendingNews(lines, "flock@pc").items, (item) => item.key)).toEqual([
        "r1:ended",
      ]);
    }),
  ));

test("a Run's agent reading the news settles its own receipts and leaves Native chat's unread", () =>
  inWorld(
    Effect.gen(function* () {
      const file = yield* newsFile();
      yield* appendNews(file, { key: "r1:ended", run: "r1", text: "Run r1 ended done." });
      const run = yield* aRun("read the news");
      yield* registerAgent(
        { session: null, workspaceId: null, cwd: project },
        {
          role: "implementer",
          agent: "builder",
          paneId: "p-1",
          workspaceId: null,
          runId: run.id,
          workflow: "proof",
          at: "2026-11-13T00:00:00.000Z",
        },
      );
      const agent = {
        ...env,
        asker: { origin: "agent" as const, from: { run: run.id, agent: "builder" } },
      };
      const asAgent = () => toolNamed("collie_news")!.call(agent, {});

      expect(yield* asAgent()).toContain("Run r1 ended done.");
      expect(yield* asAgent()).toBe("Nothing has happened that you have not seen.");
      expect(Arr.map(pendingNews(yield* readNews(file), NATIVE).items, (item) => item.key)).toEqual(
        ["r1:ended"],
      );
      expect(yield* call("collie_news")).toContain("Run r1 ended done.");
    }),
  ));

test("news is built from the record, and carries no transcripts or diffs", () =>
  inWorld(
    Effect.gen(function* () {
      const file = yield* newsFile();
      yield* appendNews(file, {
        key: "r1:gaps",
        run: "r1",
        text: "Run r1 (add-a-picker) cannot show it did what it set out to: nothing was verified.",
      });
      const said = yield* call("collie_news");
      expect(said).toContain("nothing was verified");
      expect(said.length).toBeLessThan(500);
    }),
  ));

test("collie_do carries out what the human asked for, and says what happened", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* aRun("add a picker");

      const said = yield* call("collie_do", {
        actions: [{ kind: "stop", run: run.id }],
      });

      expect(said).toContain("stop: applied");
      expect(yield* readProposals(KEY)).toEqual([]);
      const view = yield* runView(env, run.id);
      expect(view !== null && "controls" in view ? view.controls : []).toContain("stop");
    }),
  ));

test("collie_do reuses a supplied request id for an explicit retry", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* aRun("retry the same decision");
      const input = {
        request_id: "retry-decision",
        actions: [{ kind: "disposition", run: run.id, became: "abandoned", ref: "retry-fixture" }],
      };
      const first = yield* call("collie_do", input);
      expect(first).toContain("applied");
      expect(yield* call("collie_do", input)).toBe(first);
      const lines = yield* readDispositions(run.dir);
      expect(Arr.filter(lines, (line) => line.ref === "retry-fixture")).toHaveLength(1);
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
      const file = KEY;
      const pending = (interpretation: string, actions: Array<Action>) =>
        recordProposal(file, {
          interpretation,
          targets: [{ run: run.id }],
          actions,
          allowedNow: [],
          intentVersions: {},
          by: "evaluator:e-1",
        });
      yield* pending("release it, the branch is sorted out", [{ kind: "release", run: run.id }]);
      const waiting = Arr.filter(
        yield* readProposals(file),
        (line): line is ProposalRecord => line.kind === "proposal",
      );
      const proposal = waiting[0]!;

      const said = yield* call("collie_do", {
        actions: [{ kind: "confirm", proposal: proposal.id, hash: proposal.content_hash }],
      });
      expect(said).toContain("release");
      const lines = yield* readProposals(KEY);
      const settled = Arr.flatMap(lines, (line) => (line.kind === "confirmed" ? [line] : []));
      expect(Arr.map(settled, (line) => line.id)).toEqual([proposal.id]);
      expect(pipe_(settled[0]!.by, Str.startsWith("chat:"))).toBe(true);

      yield* pending("stop it", [{ kind: "stop", run: run.id }]);
      const second = Option.getOrUndefined(
        Arr.findFirst(
          Arr.filter(
            yield* readProposals(KEY),
            (line): line is ProposalRecord => line.kind === "proposal",
          ),
          (line) => line.id !== proposal.id,
        ),
      )!;
      yield* call("collie_do", {
        actions: [{ kind: "decline", proposal: second.id, hash: second.content_hash }],
      });
      expect(
        Arr.some(
          yield* readProposals(KEY),
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
      expect(said).toContain("a start takes kind, machine, workflow, inputs, decisions, workspace");
      expect(said).toContain('put it in "inputs"');
      expect(said).toContain("update_intent");
      expect(said).toContain("Nothing was done");
      expect(yield* listRuns(env)).toHaveLength(0);

      expect(yield* call("collie_hold", { run: "r", untl: "14:00" })).toContain(
        "collie_hold refused the request (InvalidInput)",
      );
    }),
  ));

test("a hold asked for until a time is refused, because nothing would lift it", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* aRun("add a picker");
      const said = yield* call("collie_hold", { run: run.id, until: "14:00" });
      expect(said).toContain("collie_hold refused the request (InvalidInput)");
      expect(said).toContain("Nothing was done");
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
      const proposal = Arr.flatMap(yield* readProposals(KEY), (line) =>
        line.kind === "proposal" ? [line] : [],
      )[0]!;

      const said = yield* call("collie_do", {
        actions: [
          { kind: "confirm", proposal: proposal.id, hash: proposal.content_hash },
          { kind: "disposition", run: run.id, became: "merged", ref: "collie!151" },
        ],
      });

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
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(line), (present___) =>
            pipe_(present___.by, Str.startsWith("chat:")),
          ),
        ),
      ).toBe(true);

      const launched = yield* call("collie_do", {
        actions: [{ kind: "start", workflow: "no-such-workflow", inputs: { goal: "x" } }],
      });
      expect(launched).not.toContain("collie_propose");
      expect(launched).toContain("no-such-workflow");
    }),
  ));

const offeringRun = Effect.fn("test.offeringRun")(function* () {
  yield* save(world.user, [
    "offered.workflow.ts",
    "graded.workflow.ts",
    "capability.ts",
    "house.ts",
  ]);
  return yield* startedRun(
    "offered",
    { note: "the diff" },
    (view) => view.status.status === "complete",
    undefined,
    "task-offering",
  );
});

test("collie_run names what a finished Run offers, and why one it declares cannot be made now", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* offeringRun();

      const offered = yield* call("collie_run", { run: run.id });
      expect(offered).toContain("grade-it  Grade what this found (graded)");
      expect(offered).toContain("look-again  Look again (offered)");

      yield* call("collie_do", {
        actions: [{ kind: "disposition", run: run.id, became: "abandoned" }],
      });
      expect(yield* call("collie_run", { run: run.id })).toContain(
        "grade-it  Grade what this found (graded) — unavailable: its conditions are not met",
      );
    }),
  ));

test("collie_do takes a Run's offer, and what it starts is that Run's child in its Task", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* offeringRun();

      const said = yield* call("collie_do", {
        actions: [
          {
            kind: "take_offer",
            run: run.id,
            offer: "grade-it",
            inputs: { note: "the diff", grade: "pass" },
          },
        ],
      });
      expect(said).toContain("take_offer: applied");
      const started = /Started run (\S+) from/.exec(said)?.[1] ?? "";
      const client = yield* connect(stateDir).pipe(Effect.orDie);
      const child = yield* client.run({ runId: started }).pipe(Effect.orDie);
      expect(child?.workflow).toBe("graded");
      expect(child?.parent).toBe(run.id);
      expect(child?.task).toBe("task-offering");
    }),
  ));

test("an offer's argument that is not text is taken from the text chat gives it", () =>
  inWorld(
    Effect.gen(function* () {
      yield* save(world.user, ["echo.workflow.ts"]);
      const run = yield* startedRun("echo", { text: "hi", times: 1 }, asking("keep"));
      yield* call("collie_do", {
        actions: [{ kind: "answer", run: run.id, choiceId: "keep", answer: "yes" }],
      });
      const client = yield* connect(stateDir).pipe(Effect.orDie);
      yield* until(
        () => client.run({ runId: run.id }).pipe(Effect.orDie),
        (view) => view?.status.status === "complete",
      );

      const said = yield* call("collie_do", {
        actions: [
          {
            kind: "take_offer",
            run: run.id,
            offer: "echo-louder",
            inputs: { text: "again", times: "2" },
          },
        ],
      });
      expect(said).toContain("take_offer: applied");
      const started = /Started run (\S+) from/.exec(said)?.[1] ?? "";
      const child = yield* until(
        () => client.run({ runId: started }).pipe(Effect.orDie),
        (view) => view !== null && view.waiting.length > 0,
      );
      expect(child?.input).toEqual({ text: "again", times: 2 });
    }),
  ));

test("an owning Run's own offer in a Task of several merge requests reads its arguments as it declares them", () =>
  inWorld(
    Effect.gen(function* () {
      yield* save(world.user, ["owns-mr.workflow.ts", "echo.workflow.ts"]);
      const done = (view: RunView) => view.status.status === "complete";
      const [app] = yield* Effect.forEach(["app", "api"], (repo) =>
        startedRun(
          "owns-mr",
          { mr: `https://gitlab.cego.dk/cego/${repo}/-/merge_requests/7` },
          done,
          undefined,
          "task-several",
        ),
      );

      const said = yield* call("collie_do", {
        actions: [
          {
            kind: "take_offer",
            run: app!.id,
            offer: "echo-louder",
            inputs: { text: "again", times: "2" },
          },
        ],
      });
      expect(said).toContain("take_offer: applied");
      const started = /Started run (\S+) from/.exec(said)?.[1] ?? "";
      const client = yield* connect(stateDir).pipe(Effect.orDie);
      const child = yield* until(
        () => client.run({ runId: started }).pipe(Effect.orDie),
        (view) => view !== null && view.waiting.length > 0,
      );
      expect(child?.input).toEqual({ text: "again", times: 2 });
    }),
  ));

test("an offer the Run does not make, or cannot make now, starts nothing and says why", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* offeringRun();
      const take = (offer: string) =>
        call("collie_do", {
          actions: [
            { kind: "take_offer", run: run.id, offer, inputs: { note: "x", grade: "pass" } },
          ],
        });

      expect(yield* take("deploy-it")).toContain(
        `take_offer: failed — run "${run.id}" does not offer "deploy-it" now`,
      );
      yield* call("collie_do", {
        actions: [{ kind: "disposition", run: run.id, became: "abandoned" }],
      });
      expect(yield* take("grade-it")).toContain(
        `take_offer: failed — run "${run.id}" does not offer "grade-it": its conditions are not met`,
      );
      expect(Arr.map(yield* listRuns(env), (one) => one.id)).toEqual([run.id]);
    }),
  ));

test("the definitions tool answers with the module an id runs, not the file below it", () =>
  inWorld(
    Effect.gen(function* () {
      // WARNING: This checkout is the installation, so the shipped modules are these, not the installed release.
      const shipped = readEnv({
        ...process.env,
        COLLIE_ROOT: new URL("../", import.meta.url).pathname,
        COLLIE_STATE_DIR: stateDir,
        COLLIE_USER_DIR: `${stateDir}/user`,
        COLLIE_CWD: stateDir,
      });
      const ask = (input: JsonObject) =>
        Effect.suspend(() => toolNamed("collie_definitions")!.call(shipped, input));

      const listed = yield* ask({});
      expect(listed).toContain("- implement (shipped):");

      const shown = yield* ask({ workflow: "implement" });
      expect(shown).toContain("implement (shipped)");
      expect(shown).toContain("inputs: plan");
      expect(shown).toContain("the host also settles: branch, task");
      expect(shown).toContain("result: ");
      expect(shown).toContain("workflows/implement.workflow.ts");
    }),
  ));

const chatting = Effect.fn("test.chatting")(function* () {
  yield* Effect.scoped(
    Effect.flatMap(connectCore(core.socketPath), (hc) =>
      hc.call("terminal.run", {
        name: CHAT_TERMINAL,
        argv: ["claude"],
        cwd: project,
        [SETUP]: true,
      }),
    ),
  ).pipe(Effect.ignore);
  yield* writeChat(yield* chatPath(stateDir, KEY), {
    harness: "claude",
    agent: "collie-chat",
    sessions: { claude: "s-1" },
    startedAt: "2026-10-02T09:00:00Z",
  });
});

const hookInput = (session: string, prompt: string) =>
  encodeJson({ session_id: session, hook_event_name: "UserPromptSubmit", prompt });
const stopInput = (session: string) => encodeJson({ session_id: session, hook_event_name: "Stop" });

test("Native chat cleans up its own Machine, with or without naming it, and refuses another", () =>
  inWorld(
    Effect.gen(function* () {
      yield* chatting();
      const proposing = (action: JsonObject) =>
        call("collie_propose", { interpretation: "clean up", actions: [action] });
      expect(yield* proposing({ kind: "cleanup" })).toContain("cleanup: applied");
      expect(yield* proposing({ kind: "cleanup", machine: hostname() })).toContain(
        "cleanup: applied",
      );
      for (const kind of ["cleanup", "home_cleanup"]) {
        expect(yield* proposing({ kind, machine: "another-machine" })).toContain(
          `${kind}: failed — Native chat acts on ${hostname()}`,
        );
      }
    }),
  ));

test("chat manages Schedules at once through the host, with the conversation and human's words", () =>
  inWorld(
    Effect.gen(function* () {
      yield* chatting();
      const words = "schedule the proof daily, then pause it";
      yield* hear(env, hookInput("s-1", words));
      const add = {
        kind: "schedule_add",
        name: "daily-proof",
        cron: "0 7 * * *",
        tz: "UTC",
        start: { workflow: "proof", workspace: project, inputs: { note: "daily" } },
      };
      const request = { interpretation: words, actions: [add], request_id: "schedule-chat-add" };
      const added = yield* call("collie_propose", request);
      expect(added).toContain("schedule_add: applied");
      expect(yield* call("collie_propose", request)).toBe(added);
      const list = () => scheduleListing(env, { origin: "chat" });
      const first = yield* list();
      expect(first).toMatchObject({
        ok: true,
        value: {
          schedules: [{ name: "daily-proof", paused: false, start: { verify: [] }, last: null }],
        },
      });
      if (!first.ok) {
        throw new Error(first.error.message);
      }
      const machine = first.value.machine;
      expect(added).toContain(machine.hostname);
      const installation = yield* call("collie_installation");
      expect(installation).toContain(`schedules on ${machine.hostname} (${machine.installation})`);
      expect(installation).toContain("daily-proof\t0 7 * * * UTC\tproof");
      expect(installation).toContain(first.value.schedules[0]?.next ?? "missing next occurrence");
      expect(installation).toContain("last nothing yet");
      expect((yield* readAudit(`${stateDir}/schedules/daily-proof`))[0]?.actor).toMatchObject({
        origin: "chat",
        conversation: NATIVE,
        said: words,
      });
      for (const change of ["pause", "resume", "remove"]) {
        const said = yield* call("collie_propose", {
          interpretation: change,
          actions: [{ kind: `schedule_${change}`, name: "daily-proof" }],
        });
        expect(said).toContain(`schedule_${change}: applied`);
        expect(said).toContain(machine.hostname);
        const now = yield* list();
        expect(now.ok).toBe(true);
        if (!now.ok) {
          throw new Error(now.error.message);
        }
        if (change === "remove") {
          expect(now.value.schedules).toEqual([]);
        } else {
          expect(now.value.schedules[0]?.paused).toBe(change === "pause");
          if (change === "pause") {
            expect(yield* call("collie_installation", {})).toMatch(/daily-proof\t.*\tpaused\t/);
          }
          expect(now.value.schedules[0]?.last).toBeNull();
          if (change === "resume") {
            expect(now.value.schedules[0]?.next).not.toBeNull();
          }
        }
      }
      const missing = yield* call("collie_propose", {
        interpretation: "schedule one without its Input",
        actions: [{ ...add, start: { workflow: "proof", workspace: project, inputs: {} } }],
      });
      expect(missing).toContain("schedule_add: failed");
      expect(missing).toContain("note");
      const direct = yield* changeSchedule(env, {
        door: { origin: "chat" },
        request: "schedule-missing-input",
        change: {
          change: "add",
          name: add.name,
          cron: add.cron,
          paused: false,
          start: { workflow: "proof", workspace: project, inputs: {}, verify: [] },
        },
      });
      expect(direct.ok).toBe(false);
      if (!direct.ok) {
        expect(missing).toContain(direct.error.message);
      }
      expect(
        yield* call("collie_propose", {
          interpretation: "schedule on a different Machine",
          actions: [{ ...add, machine: "another-machine" }],
        }),
      ).toContain("Native chat acts on");
      for (const action of [
        { ...add, start: { ...add.start, here: true } },
        { kind: "schedule_pause", name: 42 },
        { kind: "schedule_destroy", name: add.name },
      ]) {
        expect(
          yield* call("collie_propose", { interpretation: "bad request", actions: [action] }),
        ).toContain("InvalidInput");
      }
      expect(yield* list()).toMatchObject({ ok: true, value: { schedules: [] } });
      expect(pendingHerdWide(yield* readProposals(KEY), yield* Clock.currentTimeMillis)).toEqual(
        [],
      );
    }),
  ));

test("what collie_do does is recorded with the human's words from that turn", () =>
  inWorld(
    Effect.gen(function* () {
      yield* chatting();
      const run = yield* aRun("add a picker");
      yield* hear(env, hookInput("s-1", "stop the picker run, it is going nowhere"));
      const said = yield* call("collie_do", {
        actions: [{ kind: "disposition", run: run.id, became: "abandoned" }],
      });
      expect(said).toContain("disposition: applied");
      const actors = Arr.map(yield* readAudit(run.dir), (line) => line.actor);
      expect(actors.at(-1)).toMatchObject({
        origin: "chat",
        conversation: NATIVE,
        said: "stop the picker run, it is going nowhere",
      });
      yield* call("collie_do", { actions: [{ kind: "stop", run: run.id }] });
      expect(
        Option.getOrUndefined(
          Arr.findFirst(yield* readAudit(run.dir), (line) => line.operation === "stop"),
        )?.actor,
      ).toMatchObject({
        origin: "chat",
        conversation: NATIVE,
        said: "stop the picker run, it is going nowhere",
      });
    }),
  ));

test("a chat's hold of a Task holds every unfinished Run of it and none of another's", () =>
  inWorld(
    Effect.gen(function* () {
      yield* chatting();
      const client = yield* connect(world.state).pipe(Effect.orDie);
      const start = (place: { readonly task?: string; readonly taskLabel?: string }) =>
        Effect.gen(function* () {
          const request = yield* (yield* SecureRandom.SecureRandom).uuidV4();
          const started = yield* client
            .start({ project: world.project, id: "proof", request, input: { note: "x" }, ...place })
            .pipe(Effect.orDie);
          return started.runId;
        });
      const first = yield* start({ taskLabel: "Project | Picker" });
      const task = (yield* client.run({ runId: first }).pipe(Effect.orDie))?.task ?? "";
      const second = yield* start({ task });
      const other = yield* start({ taskLabel: "Project | Other" });

      yield* call("collie_hold", { task });
      const heldIn = (runId: string) =>
        Effect.map(readAudit(runDir(world.state, runId)), (trail) =>
          Arr.some(trail, (line) => line.operation === "hold"),
        );
      expect(yield* Effect.forEach([first, second, other], heldIn)).toEqual([true, true, false]);
    }),
  ));

test("a chat's hold and proposal are recorded with the human's words too", () =>
  inWorld(
    Effect.gen(function* () {
      yield* chatting();
      const run = yield* aRun("add a picker");
      yield* hear(env, hookInput("s-1", "hold the picker run while I look"));
      expect(yield* call("collie_hold", { run: run.id })).toContain("hold:");
      const voice = {
        origin: "chat",
        conversation: NATIVE,
        said: "hold the picker run while I look",
      };
      expect(
        Option.getOrUndefined(
          Arr.findFirst(yield* readAudit(run.dir), (line) => line.operation === "hold"),
        )?.actor,
      ).toMatchObject(voice);
      yield* call("collie_propose", {
        interpretation: "they want it stopped",
        actions: [{ kind: "stop", run: run.id }],
      });
      expect(
        Option.getOrUndefined(
          Arr.findFirst(yield* readAudit(run.dir), (line) => line.operation === "stop"),
        )?.actor,
      ).toMatchObject(voice);
    }),
  ));

test("the human's words are recorded redacted and bounded", () =>
  inWorld(
    Effect.gen(function* () {
      yield* chatting();
      const run = yield* aRun("add a picker");
      const token = "ghp_abcdefghijklmnopqrstuvwxyz0123";
      yield* hear(
        env,
        hookInput("s-1", `abandon it, token ${token}\n${pipe_("log line\n", Str.repeat(5000))}`),
      );
      yield* call("collie_do", {
        actions: [{ kind: "disposition", run: run.id, became: "abandoned" }],
      });
      const said = (yield* readAudit(run.dir)).at(-1)!.actor.said!;
      expect(said).toStartWith("abandon it, token <github token>");
      expect(said).not.toContain(token);
      expect(said.length).toBeLessThanOrEqual(HEARD_MAX);
    }),
  ));

test("a chat's amendment to an Intent is recorded with the human's words", () =>
  inWorld(
    Effect.gen(function* () {
      yield* chatting();
      const run = yield* aRun("add a picker");
      yield* hear(env, hookInput("s-1", "the goal is to ship the picker"));
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
      expect((yield* readIntent(run.dir))?.history.at(-1)).toMatchObject({
        conversation: NATIVE,
        said: "the goal is to ship the picker",
      });
    }),
  ));

test("the words are the tool host's to attach, never the model's", () =>
  inWorld(
    Effect.gen(function* () {
      yield* chatting();
      const run = yield* aRun("add a picker");
      const forged = yield* call("collie_do", {
        actions: [{ kind: "disposition", run: run.id, became: "abandoned" }],
        said: "the human told me to",
      });
      expect(forged).toContain("refused the request (InvalidInput)");
      yield* hear(env, hookInput("s-1", "abandon it"));
      yield* hear(env, stopInput("s-1"));
      yield* call("collie_do", {
        actions: [{ kind: "disposition", run: run.id, became: "abandoned" }],
      });
      expect((yield* readAudit(run.dir)).at(-1)!.actor.said).toBeUndefined();
      yield* hear(env, hookInput("s-old", "abandon everything"));
      yield* call("collie_do", {
        actions: [{ kind: "disposition", run: run.id, became: "abandoned" }],
      });
      const actor = (yield* readAudit(run.dir)).at(-1)!.actor;
      expect(actor.origin).toBe("chat");
      expect(actor.conversation).toBe(NATIVE);
      expect(actor.said).toBeUndefined();
    }),
  ));

test("a proposal chat settles carries the words it was settled with", () =>
  inWorld(
    Effect.gen(function* () {
      yield* chatting();
      const file = KEY;
      const proposal = yield* recordProposal(file, {
        interpretation: "nothing to do",
        targets: [],
        actions: [{ kind: "none", why: "nothing to do" }],
        allowedNow: [],
        intentVersions: {},
        by: "evaluator:e-1",
      });
      yield* hear(env, hookInput("s-1", "no, drop that"));
      expect(
        yield* call("collie_do", {
          actions: [{ kind: "decline", proposal: proposal.id, hash: proposal.content_hash }],
        }),
      ).toContain("decline: applied");
      const declined = Option.getOrUndefined(
        Arr.findFirst(yield* readProposals(file), (line) => line.kind === "declined"),
      );
      expect(declined).toMatchObject({ conversation: NATIVE, said: "no, drop that" });
    }),
  ));

const startedRun = Effect.fn("test.startedRun")(function* (
  module: string,
  input: JsonObject,
  ready: (view: RunView) => boolean,
  parent?: string,
  task?: string,
) {
  const client = yield* connect(stateDir).pipe(Effect.orDie);
  const { runId } = yield* client
    .start({
      project,
      id: module,
      request: yield* (yield* SecureRandom.SecureRandom).uuidV4(),
      input,
      parent,
      task,
    })
    .pipe(Effect.orDie);
  yield* until(
    () => client.run({ runId }).pipe(Effect.orDie),
    (view) => view !== null && ready(view),
  );
  return { id: runId, dir: runDir(stateDir, runId) };
});

const asking = (name: string) => (view: RunView) =>
  Arr.some(view.waiting, (one) => one.name === name && one.answer === null);

const answerAs = (as: Declaration, runId: string, decision: string, value: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const door = yield* frontDoor(socketOf(stateDir));
      yield* door.declare(as);
      yield* door.answer({
        runId,
        decision,
        value,
        request: yield* (yield* SecureRandom.SecureRandom).uuidV4(),
      });
    }),
  ).pipe(Effect.orDie);

const waitingOnTheHuman = (receipts: string) => Str.split(receipts, "### Sent")[0];

test("a Run waiting on a Choice says what it asks, every option, and how to answer it", () =>
  inWorld(
    Effect.gen(function* () {
      yield* save(world.user, ["branches.workflow.ts"]);
      const run = yield* startedRun("branches", { size: "big", goal: "pick" }, asking("approach"));

      const said = yield* call("collie_run", { run: run.id });
      expect(said).toContain('"approach": How should we tackle this?');
      expect(said).toContain("Options: quick | review-first");
      expect(said).toContain(
        `{"kind":"answer","run":"${run.id}","choiceId":"approach","answer":"<one of the options>"}`,
      );
      expect(said).not.toContain("answered in words");

      const waiting = waitingOnTheHuman(yield* call("collie_receipts", { run: run.id }));
      expect(waiting).toContain('"approach": How should we tackle this?');
      expect(waiting).toContain("Options: quick | review-first");
      expect(waiting).not.toContain("- nothing");
    }),
  ));

test("a Choice answered from Desktop says the answer, the computer and when, and what the Run ended with", () =>
  inWorld(
    Effect.gen(function* () {
      yield* save(world.user, ["branches.workflow.ts"]);
      const run = yield* startedRun("branches", { size: "big", goal: "pick" }, asking("approach"));
      yield* answerAs(
        { frontDoor: "desktop", from: { client: "mk-laptop" } },
        run.id,
        "approach",
        "review-first",
      );
      const client = yield* connect(stateDir).pipe(Effect.orDie);
      yield* until(
        () => client.run({ runId: run.id }).pipe(Effect.orDie),
        (view) => view !== null && isSettled(view),
      );

      const said = yield* call("collie_run", { run: run.id });
      expect(said).toMatch(
        /- "approach": review-first — desktop on mk-laptop at \d{4}-\d\d-\d\dT\d\d:\d\d/,
      );
      expect(said).toContain("Result: review-first");
      expect(said).not.toContain("Options:");
      expect(waitingOnTheHuman(yield* call("collie_receipts", { run: run.id }))).toContain(
        "- nothing",
      );
    }),
  ));

test("each answer says who gave it, the newest five are listed, and an unrecorded one says so", () =>
  inWorld(
    Effect.gen(function* () {
      yield* save(world.user, ["asks.workflow.ts"]);
      const run = yield* startedRun("asks", { goal: "ask" }, asking("q1"));
      const by: Array<Declaration> = [
        { frontDoor: "cli" },
        { frontDoor: "cli" },
        { frontDoor: "chat", conversation: "flock@mk-pc" },
        { frontDoor: "board" },
        { frontDoor: "cli-tty" },
        { frontDoor: "desktop", from: { client: "mk-laptop" } },
      ];
      const client = yield* connect(stateDir).pipe(Effect.orDie);
      for (const [n, as] of by.entries()) {
        yield* answerAs(as, run.id, `q${n + 1}`, "yes");
        yield* until(
          () => client.run({ runId: run.id }).pipe(Effect.orDie),
          (view) => view !== null && (n === 5 ? isSettled(view) : asking(`q${n + 2}`)(view)),
        );
      }
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM collie_run_lines WHERE run = ${run.id} AND journal = ${AUDIT_FILE}
          AND seq NOT IN (SELECT seq FROM collie_run_lines WHERE run = ${run.id}
            AND journal = ${AUDIT_FILE} ORDER BY seq DESC LIMIT 4)`;
      }).pipe(Effect.provide(recordsAt(stateDir)), Effect.orDie);

      const said = yield* call("collie_run", { run: run.id });
      const answered = Str.split(Str.split(said, "### Answered\n\n")[1]!, "\n\n")[0];
      expect(Str.split(answered, "\n")).toHaveLength(5);
      expect(answered).toContain('- "q6": yes — desktop on mk-laptop at ');
      expect(answered).toContain('- "q5": yes — cli at ');
      expect(answered).toContain('- "q4": yes — board at ');
      expect(answered).toContain('- "q3": yes — chat flock@mk-pc at ');
      expect(answered).toContain('- "q2": yes — who answered is not recorded');
      expect(answered).not.toContain('"q1"');
      const flow = yield* Schema.decodeEffect(Schema.fromJsonString(Flow))(
        Str.split(Str.split(said, "```json\n")[1]!, "\n```")[0],
      );
      expect(Arr.map(flow.lanes[0]!.nodes, (node) => [node.id, node.state])).toEqual([
        ["q1", "done"],
        ["q2", "done"],
        ["q3", "done"],
        ["q4", "done"],
        ["q5", "done"],
        ["q6", "done"],
      ]);
    }),
  ));

test("a Run lists the Runs it started, each with its workflow and state", () =>
  inWorld(
    Effect.gen(function* () {
      const parent = yield* aRun("start a child");
      const child = yield* startedRun("hello", { name: "child" }, isSettled, parent.id);
      expect(yield* call("collie_run", { run: parent.id })).toContain(
        `- run ${child.id}: hello, succeeded`,
      );
    }),
  ));

test("a Run's row for a Run it started shows that Run's merge request as the merge watch last said", () =>
  inWorld(
    Effect.gen(function* () {
      const parent = yield* aRun("start a child");
      const child = yield* startedRun("hello", { name: "child" }, isSettled, parent.id);
      const mr = "https://gitlab.cego.dk/mk/api/-/merge_requests/4";
      yield* RunRecords.use((records) => records.put(child.id, MERGE_REQUEST, `${mr}\n`));
      expect(yield* call("collie_run", { run: parent.id })).toContain(
        `- run ${child.id}: hello, succeeded; mk/api!4 not watched`,
      );

      yield* storedAnswers(
        stateDir,
        new Map([["gitlab.cego.dk/mk/api!4", "open"]]),
        new Map([["gitlab.cego.dk/mk/api!4", { checks: { state: "passed" }, head: null }]]),
      );
      expect(yield* call("collie_run", { run: parent.id })).toContain(
        `- run ${child.id}: hello, succeeded; mk/api!4 open, checks passed`,
      );
    }),
  ));

test("a Run's own merge request is shown as recorded, with what the merge watch last said of it", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* settledRun(world, "hello");
      const pull = "https://github.com/cego/collie/pull/61";
      yield* RunRecords.use((records) => records.put(run.id, MERGE_REQUEST, `${pull}\n`));
      expect(yield* call("collie_run", { run: run.id })).toContain(
        `Pull request: ${pull} — not watched`,
      );

      const id = "github.com/cego/collie#61";
      yield* storedAnswers(
        stateDir,
        new Map([[id, "open"]]),
        new Map([[id, { checks: { state: "failed", name: "test" }, head: null }]]),
      );
      expect(yield* call("collie_run", { run: run.id })).toContain(
        `Pull request: ${pull} — open, checks failed (test)`,
      );
    }),
  ));

test("a Run shows its plan, findings, disposition, outcome and the last lines it recorded", () =>
  inWorld(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const run = yield* settledRun(world, "hello", { outcome: "bug" });
      yield* fs.makeDirectory(`${run.dir}/plan/issues`, { recursive: true });
      yield* fs.writeFileString(`${run.dir}/plan/SPEC.md`, "# spec\n");
      for (const name of ["01-a.md", "02-b.md"]) {
        yield* fs.writeFileString(`${run.dir}/plan/issues/${name}`, "# ticket\n");
      }
      yield* fs.writeFileString(`${run.dir}/review.md`, "# review\n");
      yield* fs.writeFileString(
        `${run.dir}/findings.json`,
        encodeJson(
          Array.from({ length: 12 }, (_, n) => ({
            severity: "major",
            title: `f-${pipe_(String(n + 1), Str.padStart(2, "0"))}`,
          })),
        ),
      );
      yield* call("collie_do", {
        actions: [{ kind: "disposition", run: run.id, became: "merged", ref: "collie!151" }],
      });
      for (const line of ["step 1", "step 2", "step 3", "step 4", pipe_("x", Str.repeat(300))]) {
        yield* appendLog(run.dir, line);
      }
      yield* appendLog(run.dir, "hello picker, from hello");

      const said = yield* call("collie_run", { run: run.id });
      expect(said).toContain(`Plan: ${run.dir}/plan (2 tickets)`);
      expect(said).toContain("- (major) f-01");
      expect(said).toContain("- (major) f-10");
      expect(said).not.toContain("f-11");
      expect(said).toContain("(2 more)");
      expect(said).toContain("Disposition: merged collie!151");
      expect(said).toContain("Outcome to prove: bug");

      const recorded = Str.split(said, "### Last recorded")[1]!;
      expect(recorded).toContain("- step 1");
      expect(recorded).toContain("- step 4");
      expect(recorded).toContain(`- ${pipe_("x", Str.repeat(200))}…`);
      expect(recorded).not.toContain(pipe_("x", Str.repeat(201)));
      expect(recorded).not.toContain("hello picker");
      expect(Str.split(said, "hello picker, from hello").length).toBe(2);
    }),
  ));

test("a Run parked at the old evidence gate is waiting on the human for nothing", () =>
  inWorld(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* save(world.user, ["gated.workflow.ts"]);
      const run = yield* startedRun("gated", { note: "x" }, (view) => (view.parked ?? "") !== "");
      yield* fs.makeDirectory(`${project}/.collie`, { recursive: true });
      yield* fs.writeFileString(
        `${project}/.collie/verify.json`,
        '[{"name":"unit","executable":"true","argv":[],"cwd":"worktree"}]',
      );

      const waiting = waitingOnTheHuman(yield* call("collie_receipts", { run: run.id }));
      expect(waiting).toContain("- nothing");
      expect(waiting).not.toContain("evidence gate");
    }),
  ));

test("a Run with a branch and no merge request shows its branch", () =>
  inWorld(
    Effect.gen(function* () {
      const git = ["git", "-c", "user.email=t@example.test", "-c", "user.name=t"];
      yield* exec([...git, "commit", "-q", "--allow-empty", "-m", "init"], { cwd: project });
      yield* exec(["git", "remote", "add", "origin", "git@gitlab.example.com:group/app.git"], {
        cwd: project,
      });
      yield* save(world.user, ["builds.workflow.ts"]);
      yield* connect(stateDir, { hostEnv: { GITLAB_USER_LOGIN: "tester" } }).pipe(Effect.orDie);
      const run = yield* startedRun(
        "builds",
        { work: "add a picker" },
        (view) => view.branch !== null,
      );
      const said = yield* call("collie_run", { run: run.id });
      expect(said).toMatch(/Branch: \S+/);
      expect(said).not.toContain("Merge request:");
      const fs = yield* FileSystem.FileSystem;
      yield* until(
        () => fs.readFileString(core.logPath).pipe(Effect.orDie),
        (log) => pipe_(log, Str.includes(`"cmd":"terminal.send"`)),
      );
    }),
  ));

const directoryAt = (cwd: string) =>
  Effect.gen(function* () {
    rootAtWorldHome();
    yield* (yield* FileSystem.FileSystem).makeDirectory(cwd, { recursive: true });
  }).pipe(Effect.orDie);

const rootAtWorldHome = () => {
  env = { ...env, raw: { ...env.raw, GITTE_CWD: world.home } };
};

test("where work can start lists open Tasks, the Projects root and each workflow's Inputs and description", () =>
  inWorld(
    Effect.gen(function* () {
      yield* save(world.user, ["branches.workflow.ts"]);
      yield* directoryAt(project);
      const open = yield* newTask({ workspace: null, label: "picker", cwd: project, herd: null });
      const gone = yield* newTask({ workspace: null, label: "closed", cwd: project, herd: null });
      yield* writeTask(open);
      yield* writeTask({ ...gone, closed_at: "2026-11-16T00:00:00.000Z" });

      const said = yield* call("collie_workspaces");
      expect(said).toContain(`- task ${open.id} (picker): ${project}`);
      expect(said).not.toContain(gone.id);
      expect(said).toContain(`Projects root: ${world.home}`);
      expect(said).toContain("a checkout under it is named by its directory name");
      expect(said).toContain("- proof (note) — Records one launch, then waits to be answered.");
      expect(Str.split(said, "\n")).toContain("- hello (name)");
      expect(Str.split(said, "\n")).toContain("- branches (goal?, size)");
    }),
  ));

test("a start naming a path this Machine does not have is refused as no directory there", () =>
  inWorld(
    Effect.gen(function* () {
      rootAtWorldHome();
      for (const named of ["/nowhere/monorepo", "~/nowhere", "./src/nowhere"]) {
        const refused = yield* workspaceNamed(env, named);
        const error = refused !== null && "error" in refused ? refused.error : "";
        expect(error).toContain(`no directory "${named}" on this Machine`);
        expect(error).toContain(world.home);
      }
      const said = yield* call("collie_do", {
        actions: [
          {
            kind: "start",
            workflow: "proof",
            inputs: { note: "x" },
            workspace: "/nowhere/monorepo",
          },
        ],
      });
      expect(said).toContain('no directory "/nowhere/monorepo" on this Machine');
      const proposed = yield* call("collie_propose", {
        interpretation: "start a proof there",
        actions: [
          { kind: "start", workflow: "proof", inputs: { note: "x" }, workspace: "~/nowhere" },
        ],
      });
      expect(proposed).toContain('no directory "~/nowhere" on this Machine');
      expect(yield* listRuns(env)).toEqual([]);
    }),
  ));

test("a name that matches nothing says what was searched", () =>
  inWorld(
    Effect.gen(function* () {
      yield* directoryAt(project);
      const refused = yield* workspaceNamed(env, "monorepo");
      const error = refused !== null && "error" in refused ? refused.error : "";
      expect(error).toBe(
        `no directory or checkout under the Projects root ${world.home} is named "monorepo"`,
      );
    }),
  ));

test("a start rooted in Collie's own state is refused", () =>
  inWorld(
    Effect.gen(function* () {
      yield* directoryAt(`${stateDir}/home`);
      const said = yield* call("collie_do", {
        actions: [
          {
            kind: "start",
            workflow: "proof",
            inputs: { note: "x" },
            workspace: `${stateDir}/home`,
          },
        ],
      });
      expect(said).toContain("Collie's own namespace, not a checkout");
      expect(said).toContain("projects-root");
      expect(yield* listRuns(env)).toEqual([]);
    }),
  ));

const readThroughHost = (tool: (typeof FLOCK_READS)[number], input: JsonObject) =>
  Effect.scoped(
    Effect.gen(function* () {
      const door = yield* frontDoor(socketOf(stateDir));
      return yield* door.read({ tool, input });
    }),
  ).pipe(Effect.orDie);

test("the host answers a Flock chat's read with Native chat's own answer, deliveries included", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* aRun("add a picker");
      // WARNING: Settled first: asking and suspending are two steps, and a read between them differs.
      const native = yield* until(
        () => call("collie_run", { run: run.id }),
        (said) => pipe_(said, Str.includes("Status: waiting")),
      );
      expect(yield* readThroughHost("collie_run", { run: run.id })).toBe(native);

      yield* appendLine({
        id: "d-1",
        at: "2026-10-07T10:00:00.000Z",
        run: run.id,
        incarnation: "term-1",
        agent: "implementer-1",
        causal_key: "k",
        request_id: "q",
        cause: { kind: "nudge", ref: "x" },
        mode: "boundary",
        text_hash: "h",
        intent_version: 1,
        attempt: 1,
        state: "submitted",
      });
      expect(yield* readThroughHost("collie_receipts", { run: run.id })).toContain(
        "- d-1: submitted, for nudge",
      );
    }),
  ));

test("a read through the host takes only the three reads, and no selection stands in for a run", () =>
  inWorld(
    Effect.gen(function* () {
      const run = yield* aRun("the selected one");
      yield* writeSelection(yield* selectionPath(stateDir, KEY), {
        task: "t1",
        run: run.id,
        name: "Strapi prod seeder",
      });
      for (const tool of ["collie_run", "collie_receipts"] as const) {
        const said = yield* readThroughHost(tool, {});
        expect(said).toContain(`${tool} takes {"run": "<run id>"}`);
        expect(said).not.toContain("the selected one");
        expect(said).not.toContain("Strapi prod seeder");
      }

      const payload = FrontDoorRpcs.requests.get("read")!.payloadSchema;
      const write = Schema.decodeUnknownExit(payload)({
        tool: "collie_do",
        input: { actions: [{ kind: "stop", run: run.id }] },
      });
      expect(write._tag).toBe("Failure");
      expect(Schema.decodeExit(payload)({ tool: "collie_run", input: {} })._tag).toBe("Success");
    }),
  ));

test("collie_installation gives the Standing direction as it is now, with its edit date", () =>
  inWorld(
    Effect.gen(function* () {
      expect(yield* call("collie_installation")).not.toContain("standing direction");
      yield* setSetting(
        env.userDir,
        "standing_direction",
        "Stage only; production waits for my go.",
        "2026-10-02T09:30:00.000Z",
      );
      const first = yield* call("collie_installation");
      expect(first).toContain("Stage only; production waits for my go.");
      expect(first).toContain("2026-10-02");
      yield* setSetting(
        env.userDir,
        "standing_direction",
        "Ask before renovating.",
        "2026-10-03T08:00:00.000Z",
      );
      const second = yield* call("collie_installation");
      expect(second).toContain("Ask before renovating.");
      expect(second).toContain("2026-10-03");
      expect(second).not.toContain("Stage only");
    }),
  ));

test("collie_do disposes of a merge request of several on the Run that owns it, and of none outside the Task", () =>
  inWorld(
    Effect.gen(function* () {
      yield* save(world.user, ["fans-out.workflow.ts", "records-mr.workflow.ts"]);
      const mrOf = (repo: string, iid: number) =>
        `https://gitlab.cego.dk/cego/${repo}/-/merge_requests/${iid}`;
      const fan = yield* startedRun(
        "fans-out",
        { mrs: `${mrOf("api", 3)} ${mrOf("web", 8)}` },
        (view) => view.status.status === "complete",
        undefined,
        "task-fan",
      );
      const client = yield* connect(stateDir).pipe(Effect.orDie);
      const web = Option.getOrThrow(
        Arr.findFirst(
          yield* client.runs({ task: "task-fan" }).pipe(Effect.orDie),
          (one) => one.mr === mrOf("web", 8),
        ),
      );

      const marked = yield* call("collie_do", {
        actions: [{ kind: "disposition", run: fan.id, became: "abandoned", ref: "web!8" }],
      });
      expect(marked).toContain("disposition: applied");
      expect(yield* readDispositions(runDir(stateDir, web.runId))).toMatchObject([
        { kind: "abandoned", ref: "gitlab.cego.dk/cego/web!8" },
      ]);
      expect(yield* readDispositions(fan.dir)).toEqual([]);

      const refused = yield* call("collie_do", {
        actions: [{ kind: "disposition", run: fan.id, became: "merged", ref: mrOf("cli", 9) }],
      });
      expect(refused).toContain("disposition: failed");
      expect(refused).toMatch(/cego\/api!3.*cego\/web!8/);
    }),
  ));

test("a Heal Run's agent adds a constraint to another Run, which applies", () =>
  inWorld(
    Effect.gen(function* () {
      const target = yield* aRun("the Run a heal is looking at");
      const seated = yield* healerSeat();
      const said = yield* callAs(seated, "collie_propose", {
        interpretation: "the heal found a constraint worth keeping",
        actions: [
          {
            kind: "update_intent",
            run: target.id,
            change: "add-constraint",
            patch: constraintPatch,
            base_version: 1,
          },
        ],
      });
      expect(said).toContain("update_intent: applied");
      const intent = yield* readIntent(target.dir);
      expect(intent?.version).toBe(2);
      expect(Arr.map(intent?.constraints ?? [], (one) => one.text)).toContain(constraintPatch);
    }),
  ));

test("a Heal agent's constraint applies when the call is driven over MCP, not only through the tool", () =>
  inWorld(
    Effect.gen(function* () {
      const target = yield* aRun("the Run a heal is looking at");
      const seated = yield* healerSeat();
      const server = yield* openServer({
        ...seated.raw,
        COLLIE_RUN: seated.asker.from.run,
        COLLIE_AGENT: seated.asker.from.agent,
      });
      const answered = yield* server.request("tools/call", {
        name: "collie_propose",
        arguments: {
          interpretation: "the heal found a constraint worth keeping",
          actions: [
            {
              kind: "update_intent",
              run: target.id,
              change: "add-constraint",
              patch: constraintPatch,
              base_version: 1,
            },
          ],
        },
      });
      expect(encodeJson(answered.result)).toContain("update_intent: applied");
      expect(answered.error).toBeUndefined();
      yield* server.close;

      const intent = yield* readIntent(target.dir);
      expect(intent?.version).toBe(2);
      expect(Arr.map(intent?.constraints ?? [], (one) => one.text)).toContain(constraintPatch);
    }),
  ));

test("a Heal Run's agent's change against a version since amended is refused naming both, and the host logs it under the request", () =>
  inWorld(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const target = yield* aRun("the Run a heal is looking at");
      const seated = yield* healerSeat();
      const intent = yield* readIntent(target.dir);
      if (intent === null) {
        return yield* Effect.die(new Error("the Run has no Intent"));
      }
      yield* writeIntent(
        target.dir,
        amend(intent, { kind: "set-goal", goal: "a wider picker" }, "human:test", yield* nowIso),
      );
      const said = yield* callAs(seated, "collie_propose", {
        request_id: "heal-stale-1",
        interpretation: "the heal found a constraint worth keeping",
        actions: [
          {
            kind: "update_intent",
            run: target.id,
            change: "add-constraint",
            patch: constraintPatch,
            base_version: 1,
          },
        ],
      });
      expect(said).toContain("failed");
      expect(said).toContain("v1");
      expect(said).toContain("which is now v2");
      const after = yield* readIntent(target.dir);
      expect(after?.version).toBe(2);
      expect(Arr.map(after?.constraints ?? [], (one) => one.text)).not.toContain(constraintPatch);
      const log = yield* until(
        () => fs.readFileString(`${stateDir}/host.log`).pipe(Effect.orElseSucceed(() => "")),
        (text) => pipe_(text, Str.includes("heal-stale-1")),
      );
      expect(log).toContain("which is now v2");
    }),
  ));

test("a Heal Run's agent's constraint that says nothing is refused, naming the patch, and the Intent is unchanged", () =>
  inWorld(
    Effect.gen(function* () {
      const target = yield* aRun("the Run a heal is looking at");
      const seated = yield* healerSeat();
      const said = yield* callAs(seated, "collie_propose", {
        interpretation: "the heal found a constraint worth keeping",
        actions: [
          {
            kind: "update_intent",
            run: target.id,
            change: "add-constraint",
            patch: "   ",
            base_version: 1,
          },
        ],
      });
      expect(said).toContain("update_intent: failed");
      expect(said).toContain('"   "');
      const after = yield* readIntent(target.dir);
      expect(after?.version).toBe(1);
      expect(after?.constraints).toEqual([]);
    }),
  ));
