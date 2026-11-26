import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { expect, test } from "bun:test";
import type { Path } from "effect";
import { Clock, DateTime, Effect, Fiber, FileSystem, Schema } from "effect";
import { TestClock } from "effect/testing";
import {
  boardLines,
  buildBoard,
  checksAt,
  withForge,
  finishedLabel,
  heldLine,
  sentenceFor,
  whereItIs,
  workingLabel,
} from "../src/board";
import type { Sentence } from "../src/board";
import { mrLabel } from "../src/board-model";
import type { Flow, ForgeChecks, Mergeability, MrState, OfferView } from "../src/board-model";
import { Branches, branchKey } from "../src/branches";
import { appendStepLine } from "../src/steps";
import type { StepLine, StepMeta } from "../src/steps";
import { machineName } from "../src/peers";
import { NOTHING_TO_LAND } from "../src/standing";
import { writeStageProof } from "../src/shipping";
import {
  Answered,
  Controlled,
  foldWaiting,
  headerSentence,
  matchesTask,
  sectionOf,
  sectionsOf,
  SECTIONS,
  sortBoard,
  primaryAction,
  cardActions,
  TaskView,
} from "../src/board-model";
import type { TaskMr } from "../src/board-model";
import { applyItem, EMPTY_FLOCK, flockCards } from "../desktop/src/shared/flock";
import { agentTabs } from "../desktop/src/shared/record-terminal";
import { recordAudit } from "../src/audit";
import { recordDisposition } from "../src/disposition";
import { readLogTail } from "../src/run-log";
import { keepQueued } from "../src/delivery-queue";
import { launchDir } from "../src/launches";
import { markSeenSince, recordSeen } from "../src/seen";
import {
  appendVerification,
  encodeVerifying,
  readVerifications,
  VERIFYING,
  verifyingOf,
} from "../src/verify";
import type { Verification } from "../src/verify";
import { checkSentence, followLog } from "../src/checks";
import { MEMORY_WAIT } from "../src/memory-wait";
import { encodeCheckRecord } from "../src/check-processes";
import { readEnv } from "../src/env";
import type { AgentInfo } from "../src/herdr";
import { appendLine, toldIn, toldLine } from "../src/steering";
import type { Delivery } from "../src/steering";
import { herdLines } from "../src/toolkit";
import { append as appendProposal } from "../src/proposals";
import type { ProposalLine } from "../src/proposals";
import type { AgentEntry } from "../src/registry";
import { factsOfView } from "../src/runs";
import type { RunFacts } from "../src/runs";
import type { RunView } from "../src/engine";
import type { TaskRecord } from "../src/task";
import { memoryRecords, runEffect } from "./support/effect";
import { hostRecords, hostRunRecords, madeRun, recordsAt } from "./support/records";
import { RUNNING_CHECK, RunRecords } from "../src/run-records";
import { exec } from "./support/command";
import { collie, proves } from "./support/world";
import { recordedCheck } from "./board.test-utils";
import { stopHost, until } from "./support/host";
import type { Launched } from "../src/launches";
import { orderLaunch, recordLaunch } from "../src/launches";
import { epochMs } from "../src/time";
import { seedIntent, writeIntent } from "../src/intent";
import { updateApproved } from "../src/verify-spec";
import { planDirOf } from "../src/run-detail";
import { connect } from "../src/host";
import { readCards } from "../src/cards";
import { toolNamed } from "../src/tools";
import { fixtures } from "./support/host";

test("a finished Run shows pushed branch movement without rewriting its failed record", () =>
  proves(
    "collie-board-moved-",
    (world) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const clean = {
          verdict: "clean",
          summary: "The requested work is complete.",
          scope_met: true,
          findings: [],
          dropped: [],
          fixed: [],
        };
        const outputs = `${world.home}/outputs.json`;
        yield* fs.writeFileString(
          outputs,
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))([clean]),
        );
        yield* fs.writeFileString(
          `${world.user}/historical-builder.workflow.ts`,
          `export { default } from "${fixtures}/reviewed-parent.workflow.ts";\n`,
        );
        const origin = `${world.home}/origin.git`;
        yield* exec(["git", "init", "--bare", "-q", origin], { cwd: world.project });
        for (const args of [
          ["init", "-q"],
          ["config", "user.name", "test"],
          ["config", "user.email", "test@example.com"],
          ["remote", "add", "origin", origin],
          ["remote", "add", "upstream", "https://gitlab.example.com/group/project.git"],
          ["commit", "--allow-empty", "-qm", "base"],
          ["push", "-qu", "origin", "HEAD"],
          ["remote", "set-head", "origin", "-a"],
        ]) {
          yield* exec(["git", ...args], { cwd: world.project });
        }
        const client = yield* connect(world.state).pipe(Effect.orDie);
        const started = yield* client
          .start({
            project: world.project,
            id: "recovery",
            request: "failed",
            taskLabel: "recover work",
            input: { goal: "recover work" },
            options: { branch: "feature" },
            verify: [{ name: "unit", executable: "true", argv: [], cwd: "worktree" }],
          })
          .pipe(Effect.orDie);
        const finished = yield* until(
          () => client.run({ runId: started.runId }).pipe(Effect.orDie),
          (view) => view?.status.status === "failed",
        );
        expect(finished?.branch).not.toBeNull();
        const cards = yield* until(
          () => hostRecords(world.state, readCards(`${world.state}/runs/${started.runId}`)),
          (cards) => Arr.some(cards, (card) => card.kind === "final"),
        );
        const ended = cards.at(-1)!.revision.head_sha;
        const cwd = finished!.cwd;
        yield* exec(["git", "commit", "--allow-empty", "-qm", "finish after the Run"], { cwd });
        yield* exec(["git", "push", "-qu", "origin", "HEAD"], { cwd });
        const head = Str.trim((yield* exec(["git", "rev-parse", "HEAD"], { cwd })).stdout);
        yield* stopHost(world.state);
        yield* connect(world.state).pipe(Effect.orDie);
        // WARNING: a host just started shows the card it was left; its git sync's first round reads the push.
        const data = yield* until(
          () =>
            collie(world, ["board"]).pipe(
              Effect.flatMap((board) =>
                Schema.decodeUnknownEffect(
                  Schema.Struct({
                    tasks: Schema.Array(
                      Schema.Struct({
                        state: Schema.String,
                        drift: Schema.NullOr(Schema.String),
                      }),
                    ),
                  }),
                )(board.envelope.data),
              ),
              Effect.orDie,
            ),
          (data) => data.tasks[0]?.drift != null,
        );
        expect(data.tasks[0]?.state).toBe("failed");
        expect(data.tasks[0]?.drift).toContain(`1 commit past ${ended}`);
        expect(data.tasks[0]?.drift).toContain(head);
        expect(data.tasks[0]?.drift).toContain("failed record is stale");
        const shown = yield* collie(world, ["run", "show", started.runId]);
        expect(
          (yield* Schema.decodeUnknownEffect(Schema.Struct({ branchProgress: Schema.String }))(
            shown.envelope.data,
          ).pipe(Effect.orDie)).branchProgress,
        ).toContain(head);
        expect(
          (yield* (yield* connect(world.state).pipe(Effect.orDie))
            .run({ runId: started.runId })
            .pipe(Effect.orDie))?.status.status,
        ).toBe("failed");
        expect(
          (yield* hostRecords(world.state, readCards(`${world.state}/runs/${started.runId}`))).at(
            -1,
          )?.revision.head_sha,
        ).toBe(ended);
        const env = readEnv({
          COLLIE_ROOT: world.install,
          COLLIE_STATE_DIR: world.state,
          COLLIE_USER_DIR: world.config,
          HOME: world.home,
          COLLIE_CWD: world.project,
        });
        const answer = yield* toolNamed("collie_run")!.call(env, { run: started.runId });
        expect(answer).toContain(head);
        expect(answer).toContain("failed record is stale");
        let current = yield* connect(world.state).pipe(Effect.orDie);
        expect(
          (yield* current.offers({ runId: started.runId }).pipe(Effect.orDie))[0]?.title,
        ).toContain("Review");
        const reviewed = yield* current
          .start({
            project: world.project,
            id: "historical-builder",
            request: "review-advanced",
            parent: started.runId,
            task: finished!.task!,
            input: { plan: "recover work" },
            options: { workspace: cwd },
          })
          .pipe(Effect.orDie);
        yield* until(
          () => current.run({ runId: reviewed.runId }).pipe(Effect.orDie),
          (view) => view?.status.status === "failed",
        );
        yield* stopHost(world.state);
        current = yield* connect(world.state).pipe(Effect.orDie);
        // WARNING: a listing reads the recovery the git syncer kept, so it follows that sync.
        const offered = yield* until(
          () => current.offers({ runId: started.runId }).pipe(Effect.orDie),
          (offers) => Str.includes("Checks")(offers[0]?.title ?? ""),
        );
        expect(offered[0]?.title).toContain("Checks");
        const child = yield* current
          .followUp({
            runId: started.runId,
            text: "recover work",
            request: "recover-reviewed-head",
          })
          .pipe(Effect.orDie);
        const checked = yield* until(
          () => current.run({ runId: child.runId }).pipe(Effect.orDie),
          (view) => view?.status.status === "complete" || view?.status.status === "failed",
        );
        expect(checked?.status).toMatchObject({
          status: "complete",
          value: "Checked existing head",
        });
        expect(checked?.branch).toBe(finished?.branch);
        expect(checked?.cwd).toBe(cwd);
        expect(yield* current.launches({ run: child.runId }).pipe(Effect.orDie)).toHaveLength(0);
        const records = yield* hostRecords(
          world.state,
          readVerifications(`${world.state}/evidence/${child.runId}`),
        );
        expect(records[0]?.end.head_sha).toBe(head);
        expect(
          (yield* current.run({ runId: started.runId }).pipe(Effect.orDie))?.status.status,
        ).toBe("failed");
        expect(
          (yield* hostRecords(world.state, readCards(`${world.state}/runs/${started.runId}`))).at(
            -1,
          )?.revision.head_sha,
        ).toBe(ended);
        const listed = yield* current.offers({ runId: started.runId }).pipe(Effect.orDie);
        expect(listed[0]?.title).toContain("Checks");
        yield* exec(["git", "commit", "--allow-empty", "-qm", "work after the offer"], { cwd });
        yield* exec(["git", "push", "-q", "origin", "HEAD"], { cwd });
        const stale = yield* current
          .invoke({
            runId: started.runId,
            offer: "recover",
            input: {},
            request: "recheck-stale-offer",
          })
          .pipe(Effect.orDie);
        const refused = yield* until(
          () => current.run({ runId: stale.runId }).pipe(Effect.orDie),
          (view) => view?.status.status === "failed" || view?.status.status === "complete",
        );
        expect(refused?.status).toMatchObject({
          status: "failed",
          reason: "A review is required",
        });
        expect(
          yield* hostRecords(
            world.state,
            readVerifications(`${world.state}/evidence/${stale.runId}`),
          ),
        ).toHaveLength(0);
      }),
    ["recovery.workflow.ts"],
  ));

function facts(over: Partial<Sentence> = {}) {
  const returned: Sentence = {
    state: "active",
    decision: null,
    step: { id: "build", round: null },
    verb: null,
    checking: null,
    reopened: null,
    silent: null,
    wave: null,
    failure: null,
    note: null,
    resumed: null,
    disposition: null,
    mr: null,
    summary: null,
    abandoned: null,
    planReady: false,
    mrState: null,
    checks: null,
    agent: null,
    stalled: null,
    ...over,
  };
  return returned;
}

const FORMS: Array<[string, Sentence, string]> = [
  ["working", facts(), "Building."],
  [
    "working, in a round of the loop",
    facts({ step: { id: "fix", round: { at: 3, of: 5 } } }),
    "Fixing the review findings, round 3 of 5.",
  ],
  [
    "working, with the step's own verb",
    facts({ step: { id: "build", round: null }, verb: "Reproducing the race with a failing test" }),
    "Reproducing the race with a failing test.",
  ],
  ["working, before the first step", facts({ step: null }), "Starting."],
  ["quiet", facts({ state: "quiet", silent: "49 hours" }), "Building, but silent for 49 hours."],
  [
    "question",
    facts({
      state: "blocked",
      decision: {
        kind: "question",
        run: "r1",
        id: "c1",
        step: "review",
        topic: "the failing specs",
        text: "Two withdrawal specs fail on node 24. How should I proceed?",
        options: [],
      },
    }),
    "Waiting on your answer about the failing specs.",
  ],
  [
    "proposal",
    facts({
      state: "blocked",
      decision: {
        kind: "proposal",
        id: "p-3f9",
        hash: "a81c",
        text: "Planner drifted: it is editing src/ui/App.tsx.",
        actions: [],
      },
    }),
    "Collie proposes a correction and waits for your yes.",
  ],
  [
    "failed",
    facts({ state: "failed", failure: { name: "bun test", times: 2 } }),
    "Stopped after bun test failed twice in a row.",
  ],
  [
    "failed more than twice",
    facts({ state: "failed", failure: { name: "typecheck", times: 4 } }),
    "Stopped after typecheck failed 4 times in a row.",
  ],
  [
    "failed with nothing to name",
    facts({ state: "failed", note: "the plan directory is empty" }),
    "Stopped: the plan directory is empty.",
  ],
  ["stopped", facts({ state: "stopped" }), "Stopped by you."],
  [
    "failed, and shipped by hand anyway",
    facts({
      state: "failed",
      note: "the tests never went green",
      disposition: { kind: "merged", ref: "cego/collie!43", ago: "an hour ago", by: "mk" },
    }),
    "Stopped: the tests never went green. Merged as cego/collie!43 an hour ago.",
  ],
  [
    "resumed after an answer",
    facts({ resumed: "Pin the CI image to node:24.3" }),
    "Resumed with “Pin the CI image to node:24.3”.",
  ],
  [
    "done and merged",
    facts({
      state: "done",
      disposition: { kind: "merged", ref: "content!1", ago: "1 hour ago", by: "mk" },
    }),
    "Merged as content!1 1 hour ago.",
  ],
  ["done with nothing merged", facts({ state: "done" }), "Finished; nothing merged yet."],
  [
    "done with a merge request open",
    facts({ state: "done", mr: "https://gitlab.cego.dk/mk/collie/-/merge_requests/65" }),
    "mk/collie!65 is open; its checks have not been read.",
  ],
  [
    "done and abandoned",
    facts({
      state: "done",
      disposition: { kind: "abandoned", ref: "", ago: "2 days ago", by: "mk" },
    }),
    "Abandoned.",
  ],
  [
    "a Run waiting for memory, which outranks a running check",
    facts({
      memory: "Waiting for memory on vm-mk: 2.1 of 62.0 GB available.",
      checking: "Running unit on the branch, 2 min.",
    }),
    "Waiting for memory on vm-mk: 2.1 of 62.0 GB available.",
  ],
  [
    "a wave of a plan that spans repositories",
    facts({
      wave: {
        at: 2,
        of: 3,
        landed: ["frontend-core"],
        building: ["happytiger"],
        stopped: [],
        next: ["spilnu"],
      },
    }),
    "Wave 2 of 3. frontend-core landed, happytiger is building, spilnu is next.",
  ],
];

for (const [form, given, expected] of FORMS) {
  test(`the sentence for ${form}`, () => {
    expect(sentenceFor(given)).toBe(expected);
  });
}

test("a held Task carries its own line under the sentence", () => {
  expect(heldLine(null)).toBe("⏸ Held.");
  expect(heldLine("14:00")).toBe("⏸ Held until 14:00.");
});

function task(over: Partial<TaskView> = {}) {
  const returned: TaskView = {
    id: "t1",
    name: "Strapi prod seeder",
    project: "content",
    state: "active",
    steps: [
      { name: "build", state: "done" },
      { name: "review", state: "active" },
      { name: "mr", state: "todo" },
    ],
    sentence: "Fixing the review findings, round 2 of 5.",
    age: "58m",
    drift: null,
    held: null,
    heldBy: null,
    decision: null,
    agents: [],
    children: [],
    mr: null,
    branch: "mk/strapi-seed",
    disposition: null,
    landed: (over.state ?? "active") === "done",
    ended: null,
    mrState: null,
    checks: null,
    ready: false,
    check: null,
    reopened: null,
    planReady: false,
    offer: null,
    run: "r1",
    runs: ["r1"],
    at: 0,
    ...over,
  };
  return returned;
}

const QUESTION: TaskView["decision"] = {
  kind: "question",
  run: "r9",
  id: "c1",
  step: "review",
  topic: "the upload cap",
  text: "Maps are 13 MB per brand. Split per chunk, or wait?",
  options: [],
};

const SENTENCES: Array<[string, Array<TaskView>, { text: string; urgent: boolean }]> = [
  ["an empty board", [], { text: "Nothing needs you. 0 working.", urgent: false }],
  [
    "nothing waiting",
    [task(), task({ id: "t2" })],
    { text: "Nothing needs you. 2 working.", urgent: false },
  ],
  [
    "one gone quiet",
    [task(), task({ id: "t2", state: "quiet" })],
    { text: "Nothing needs you. 2 working, 1 gone quiet.", urgent: false },
  ],
  [
    "one decision",
    [task({ state: "blocked", decision: QUESTION }), task({ id: "t2" })],
    { text: "One task is waiting on you. 1 working.", urgent: true },
  ],
  [
    "several decisions, and a quiet one behind them",
    [
      task({ state: "blocked", decision: QUESTION }),
      task({ id: "t2", state: "blocked", decision: QUESTION }),
      task({ id: "t3" }),
      task({ id: "t4", state: "quiet" }),
    ],
    { text: "2 tasks are waiting on you. 2 working, 1 gone quiet.", urgent: true },
  ],
  [
    "finished work, which the header does not count",
    [task({ id: "t2", state: "done", decision: null }), task()],
    { text: "Nothing needs you. 1 working.", urgent: false },
  ],
];

for (const [form, views, expected] of SENTENCES) {
  test(`the header sentence for ${form}`, () => {
    expect(headerSentence(views)).toEqual(expected);
  });
}

test("the five sections take every Task, in the board's own order", () => {
  const views = [
    task({ id: "blocked", state: "blocked", decision: QUESTION }),
    task({ id: "working" }),
    task({ id: "quiet", state: "quiet" }),
    task({ id: "failed", state: "failed" }),
    task({ id: "done", state: "done" }),
  ];

  const sections = sectionsOf(views, "");

  expect(Arr.map(sections.needs, (t) => t.id)).toEqual(["blocked"]);
  expect(Arr.map(sections.working, (t) => t.id)).toEqual(["working", "quiet"]);
  expect(Arr.map(sections.waiting, (t) => t.id)).toEqual(["failed"]);
  expect(Arr.map(sections.finished, (t) => t.id)).toEqual(["done"]);
});

test("the header counts what is waiting on you this week, and the fold counts the rest", () => {
  const now = epochMs("2026-09-16T12:00:00.000Z");
  const views = [
    task({ id: "w", state: "active" }),
    task({ id: "recent", state: "failed", ended: now - 2 * 24 * 60 * 60 * 1000 }),
    task({ id: "old", state: "stopped", ended: now - 9 * 24 * 60 * 60 * 1000 }),
  ];
  expect(headerSentence(views, now).text).toBe("Nothing needs you. 1 waiting on you. 1 working.");
  expect(headerSentence(views).text).toBe("Nothing needs you. 2 waiting on you. 1 working.");
  const { recent, older } = foldWaiting(sectionsOf(views, "").waiting, now);
  expect(Arr.map(recent, (t) => t.id)).toEqual(["recent"]);
  expect(Arr.map(older, (t) => t.id)).toEqual(["old"]);
});

test("a search matches the five things a human remembers about a task", () => {
  const view = task({
    name: "Strapi prod seeder",
    project: "content",
    branch: "mk/strapi-seed",
    agents: [{ name: "Reviewer", status: "working", now: "Review the seeder", run: "r1" }],
  });

  for (const query of ["seeder", "CONTENT", "strapi-seed", "reviewer", "review the"]) {
    expect(matchesTask(view, query)).toBe(true);
  }
  expect(matchesTask(view, "passkey")).toBe(false);
  expect(matchesTask(view, "  ")).toBe(true);
});

test("the sections are what the search left", () => {
  const views = [
    task({ id: "a", name: "Strapi prod seeder" }),
    task({ id: "b", name: "Passkey bridge race", state: "done" }),
  ];

  expect(sectionsOf(views, "passkey")).toEqual({
    needs: [],
    ready: [],
    working: [],
    waiting: [],
    finished: [views[1]!],
  });
});

test("a filter narrows the rows that are drawn and never what is supervised", () => {
  const views = [
    task({ id: "blocked", state: "blocked", decision: QUESTION }),
    task({ id: "b", name: "Passkey bridge race", state: "done" }),
  ];
  expect(sectionsOf(views, "passkey").needs).toEqual([]);
  expect(headerSentence(views)).toEqual({
    text: "One task is waiting on you. 0 working.",
    urgent: true,
  });
});

test("Finished is one line until it is opened", () => {
  const finished = [task({ state: "done" }), task({ id: "t2", state: "failed" })];
  expect(finishedLabel(finished, false)).toBe("2 finished today, 1 failed");
  expect(finishedLabel(finished, true)).toBe("Finished · 2");
  expect(finishedLabel([task({ state: "done" })], false)).toBe("1 finished today");
  const now = epochMs("2026-09-17T08:00:00.000Z");
  const fresh = Arr.map(finished, (view) => ({ ...view, ended: now - 60 * 60 * 1000 }));
  const old = task({ id: "t3", state: "abandoned", ended: now - 14 * 24 * 60 * 60 * 1000 });
  expect(finishedLabel([...fresh, old], false, now)).toBe("2 finished today, 1 failed, 1 older");
});

test("Working says how many are working", () => {
  expect(workingLabel([task(), task({ id: "t2" })])).toBe("Working · 2");
});

test("where a Task is, is the step it has got to", () => {
  expect(whereItIs(task())).toBe("review");
  expect(whereItIs(task({ steps: [{ name: "mr", state: "done" }] }))).toBe("done");
  expect(whereItIs(task({ steps: [] }))).toBe("");
});

test("the text board says the three sections and the sentence on every card", () => {
  const lines = boardLines([
    task({
      id: "t0",
      name: "RUM sourcemap upload",
      project: "frontend-core",
      state: "blocked",
      decision: QUESTION,
      sentence: "Waiting on your answer about the upload cap.",
    }),
    task({ drift: "editing src/ui/App.tsx, which is outside the slice" }),
    task({ id: "t2", name: "Docs run", state: "quiet", sentence: "Building, but silent for 3h." }),
    task({ id: "t3", name: "Typecheck to zero", state: "done", sentence: "Merged as !151." }),
  ]);

  expect(lines).toEqual([
    "",
    "Needs you",
    "  ◆ RUM sourcemap upload · frontend-core — Waiting on your answer about the upload cap.",
    "",
    "Working · 2",
    "  ● Strapi prod seeder · content — Fixing the review findings, round 2 of 5.",
    "    ↯ editing src/ui/App.tsx, which is outside the slice",
    "  ● Docs run · content — Building, but silent for 3h.",
    "",
    "Finished · 1",
    "  ✓ Typecheck to zero · content — Merged as !151.",
  ]);
});

test("the text board says a held task is held, and an empty section says so", () => {
  expect(boardLines([task({ held: "⏸ Held until 14:00." })])).toContain("    ⏸ Held until 14:00.");
  expect(boardLines([])).toEqual([
    "",
    "Needs you",
    "  (nothing)",
    "",
    "Working · 0",
    "  (nothing)",
  ]);
});

test("a step nobody named a verb for says what it is doing, never its id", () => {
  expect(sentenceFor(facts({ step: { id: "cego.lint", round: null } }))).not.toContain("cego.lint");
});

const scratch = Effect.fn("board.scratch")(function* () {
  const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
    prefix: "collie-board-",
  });
  return { dir, env: readEnv({ COLLIE_STATE_DIR: dir, COLLIE_CWD: "/project" }) };
});

const TASK: TaskRecord = {
  id: "task-1",
  workspace: "w1",
  label: "collie | Control plane",
  cwd: "/project",
  created_at: "2026-09-14T09:00:00Z",
};

function agent(name: string, status: AgentInfo["status"]) {
  const returned: AgentInfo = {
    name,
    paneId: "t-1",
    status,
    terminalId: "t-1",
    cwd: "/project",
    foregroundCwd: null,
  };
  return returned;
}

function registered(agent: string, runId: string) {
  const returned: AgentEntry = {
    role: "implementer",
    agent,
    paneId: "p-1",
    workspaceId: "w1",
    runId,
    workflow: "implement",
    at: "2026-09-14T10:00:00Z",
  };
  return returned;
}

const board = Effect.fn("board.build")(function* (
  env: ReturnType<typeof readEnv>,
  runs: ReadonlyArray<RunFacts>,
  over: Partial<Parameters<typeof buildBoard>[0]> = {},
) {
  return yield* buildBoard({
    env,
    runs,
    tasks: [TASK],
    registered: [],
    proposals: [],
    mrStates: new Map(),
    now: epochMs("2026-09-14T10:05:00Z"),
    ...over,
  });
});

test("a Task's Runs are one card, and a Run with no Task is its own", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const plan = yield* madeRun(dir, {
        id: "r-plan",
        workflow: "plan",
        task: "task-1",
        state: "succeeded",
        created: "2026-09-14T09:00:00Z",
      });
      const build = yield* madeRun(dir, {
        id: "r-build",
        task: "task-1",
        created: "2026-09-14T10:00:00Z",
      });
      const alone = yield* madeRun(dir, {
        id: "r-alone",
        workflow: "review",
        project: "/work/spilnu",
      });

      const views = yield* board(env, [alone, build, plan]);

      expect(views).toHaveLength(2);
      const task = Option.getOrUndefined(Arr.findFirst(views, (view) => view.id === "task-1"))!;
      expect(task.name).toBe("Control plane");
      expect(task.project).toBe("collie");
      expect(task.runs).toEqual(["r-build", "r-plan"]);
      const own = Option.getOrUndefined(Arr.findFirst(views, (view) => view.id === "r-alone"))!;
      expect(own.name).toBe("Review");
      expect(own.project).toBe("spilnu");
    }),
  ));

test("a Run that ended by itself with a report states its status, then quotes the report as its own", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const chore = yield* madeRun(dir, {
        id: "r-chore",
        workflow: "odd-job",
        task: "task-1",
        state: "succeeded",
        summary: "two blockers remain",
      });

      const [view] = yield* board(env, [chore]);

      expect(view!.sentence).toBe("Completed. It reported: “two blockers remain”");
      expect(view!.sentence).not.toStartWith("Finished;");
    }),
  ));

test("the pipeline is the Task's Runs in the order they started, each as it stands", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const plan = yield* madeRun(dir, {
        id: "r-plan",
        workflow: "plan",
        task: "task-1",
        state: "succeeded",
        created: "2026-09-14T09:00:00Z",
      });
      const build = yield* madeRun(dir, { id: "r-build", task: "task-1" });

      const [view] = yield* board(env, [build, plan]);

      expect(view!.steps).toEqual([
        { name: "plan", state: "done" },
        { name: "implement", state: "active" },
      ]);
      expect(view!.run).toBe("r-build");
    }),
  ));

test("a Task's card speaks for its newest Run, in whatever order the Runs arrive", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const plan = yield* madeRun(dir, {
        id: "r-plan",
        workflow: "plan",
        task: "task-1",
        state: "succeeded",
        created: "2026-09-14T09:00:00Z",
      });
      const build = yield* madeRun(dir, {
        id: "r-impl",
        task: "task-1",
        state: "failed",
        created: "2026-09-14T10:00:00Z",
      });

      const [view] = yield* board(env, [plan, build]);

      expect(view!.run).toBe("r-impl");
      expect(view!.state).toBe("failed");
    }),
  ));

test("a question the host holds is the card's Decision, and it is Needs you", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, {
        task: "task-1",
        state: "waiting",
        asking: [
          {
            name: "scope",
            prompt: "Which repository?",
            options: [
              { id: "core", title: "core" },
              { id: "tiger", title: "tiger" },
            ],
          },
        ],
      });

      const [view] = yield* board(env, [run]);

      expect(sectionOf(view!)).toBe("needs-you");
      expect(view!.decision).toMatchObject({
        kind: "question",
        run: run.id,
        id: "scope",
        text: "Which repository?",
        options: [
          { id: "core", title: "core", subtitle: null },
          { id: "tiger", title: "tiger", subtitle: null },
        ],
      });
      expect(view!.sentence).toBe("Waiting on your answer about scope.");
    }),
  ));

test("a Task's card lists every question its Runs have open, in the order it asks them", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const first = yield* madeRun(dir, {
        id: "r-first",
        task: "task-1",
        state: "waiting",
        created: "2026-09-14T09:00:00Z",
        asking: [
          {
            name: "scope",
            prompt: "Which repository?",
            options: [
              { id: "core", title: "core" },
              { id: "tiger", title: "tiger" },
            ],
          },
          { name: "team", prompt: "Which Linear team?", options: [] },
        ],
      });
      const second = yield* madeRun(dir, {
        id: "r-second",
        task: "task-1",
        state: "waiting",
        created: "2026-09-14T09:30:00Z",
        asking: [{ name: "branch", prompt: "Which branch?", options: [] }],
      });

      const [view] = yield* board(env, [first, second]);

      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(view!.questions), (present) =>
            Arr.map(present, (question) => [question.run, question.id]),
          ),
        ),
      ).toEqual([
        ["r-second", "branch"],
        ["r-first", "scope"],
        ["r-first", "team"],
      ]);
      expect(view!.questions?.[2]).toEqual({
        kind: "question",
        run: "r-first",
        id: "team",
        step: first.workflow,
        topic: "team",
        text: "Which Linear team?",
        options: [],
        steer: {
          agent: null,
          why: "no agent of this Run is live to redirect: pick a solution or stop the Run",
        },
      });
      expect(view!.decision).toEqual(view!.questions![0]!);
    }),
  ));

test("a Task with no question open lists none", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, { task: "task-1" });

      const [view] = yield* board(env, [run]);

      expect(view!.questions).toEqual([]);
      expect(view!.decision).toBeNull();
    }),
  ));

test("a Run parked with nothing to answer is Needs you, in its pane", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, {
        task: "task-1",
        state: "waiting",
        note: "the pane would not take the prompt",
      });

      const [view] = yield* board(env, [run]);

      expect(view!.state).toBe("blocked");
      expect(view!.decision).toBeNull();
      expect(view!.sentence).toBe("Waiting for you in its pane.");
    }),
  ));

test("a release Run awaiting CI and a teammate's approval is Working, saying so, however long it is silent", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const awaiting = {
        on: "CI and a teammate's approval on group/app!345",
        who: "a teammate",
        since: "2026-09-14T08:00:00Z",
      };
      const run = yield* madeRun(dir, { task: "task-1", workflow: "release", awaiting });

      const [view] = yield* board(env, [run], { quietMs: 1 });

      expect(sectionOf(view!)).toBe("working");
      expect(view!.state).toBe("active");
      expect(view!.sentence).toBe("Waiting for CI and a teammate's approval on group/app!345.");
    }),
  ));

test("a release Run a red pipeline holds back is Needs you", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const red = "group/app!345 cannot be released: the pipeline at 1d538252 failed (lint).";
      const run = yield* madeRun(dir, {
        task: "task-1",
        workflow: "release",
        state: "waiting",
        parked: red,
        note: red,
      });

      const [view] = yield* board(env, [run]);

      expect(sectionOf(view!)).toBe("needs-you");
    }),
  ));

test("an agent herdr reports blocked names its pane, with nothing recorded to say so", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, { task: "task-1" });

      const [view] = yield* board(env, [run], {
        alive: [agent("impl-1", "blocked")],
        registered: [registered("impl-1", run.id)],
      });

      expect(sectionOf(view!)).toBe("needs-you");
      expect(view!.sentence).toBe("Waiting for you in impl-1's pane.");
    }),
  ));

test("a working agent leaves the Task working, saying the step it works on", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, { task: "task-1" });
      yield* launched(dir, run.id, ["build", "review-1"]);

      const [view] = yield* board(env, [run], {
        alive: [agent("impl-1", "working")],
        registered: [registered("impl-1", run.id)],
      });

      expect(sectionOf(view!)).toBe("working");
      expect(Arr.map(view!.agents, (one) => one.name)).toEqual(["impl-1"]);
      expect(view!.sentence).toBe("Reviewing, round 1.");
    }),
  ));

test("a Run whose tickets moved to agents of their own shows each builder as a tab, the live one marked, until delivery takes over", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, { task: "task-1" });
      const builders = [
        registered("build-r1", run.id),
        registered("build-02-r1", run.id),
        registered("deliver-r1", run.id),
      ];
      const tabsWhile = (alive: ReadonlyArray<AgentInfo>, upTo: number) =>
        Effect.map(board(env, [run], { alive, registered: Arr.take(builders, upTo) }), ([view]) =>
          Arr.map(agentTabs(view!.agents, null), (tab) => [tab.name, tab.state]),
        );

      expect(yield* tabsWhile([agent("build-02-r1", "working")], 2)).toEqual([
        ["build-r1", "ended"],
        ["build-02-r1", "working"],
      ]);
      expect(yield* tabsWhile([agent("deliver-r1", "working")], 3)).toEqual([
        ["build-r1", "ended"],
        ["build-02-r1", "ended"],
        ["deliver-r1", "working"],
      ]);
      const [delivering] = yield* board(env, [run], {
        alive: [agent("deliver-r1", "working")],
        registered: builders,
      });
      expect(herdLines([delivering!], 0)).toContain("agents deliver-r1");
    }),
  ));

test("a live agent is shown as the role it was registered as", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, { task: "task-1" });

      const [view] = yield* board(env, [run], {
        alive: [agent("review-1", "working")],
        registered: [{ ...registered("review-1", run.id), role: "reviewer" }],
      });

      expect(view!.agents).toEqual([
        { name: "review-1", role: "reviewer", status: "working", now: null, run: run.id },
      ]);
    }),
  ));

test("a live agent's card entry names where a Fallback would move its work", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, { task: "task-1" });
      yield* recordLaunch({
        agent: "impl-1",
        output: `${dir}/agents/${run.id}/build.json`,
        reused: false,
        runId: run.id,
        operation: "build",
        role: "implementer",
        workflow: "implement",
        harness: "claude",
        model: "opus",
        next: { harness: "codex", model: "gpt-5.5", effort: "high" },
      });

      const [view] = yield* board(env, [run], {
        alive: [agent("impl-1", "working")],
        registered: [registered("impl-1", run.id)],
      });

      expect(view!.agents[0]?.fallback).toBe("codex/gpt-5.5 high");
    }),
  ));

test("a check Collie is running outranks what an idle agent last said", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, { task: "task-1" });
      yield* marking(run, {
        name: "typecheck-spilnu",
        executable: "",
        argv: [],
        pass: "check",
        revision: "",
        started: "",
      });

      const [view] = yield* board(env, [run], {
        alive: [agent("impl-1", "idle")],
        registered: [registered("impl-1", run.id)],
      });

      expect(view!.sentence).toBe("Running typecheck-spilnu.");
    }),
  ));

const launched = Effect.fn("board.launched")(function* (
  stateDir: string,
  runId: string,
  operations: ReadonlyArray<string>,
) {
  for (const operation of operations) {
    const launch: Launched = {
      agent: `${runId}-${operation}`,
      output: `${stateDir}/agents/${runId}/${operation}.json`,
      reused: false,
      runId,
      operation,
      role: "implementer",
      workflow: "implement",
      harness: "claude",
    };
    yield* recordLaunch(launch);
    yield* orderLaunch(launch);
  }
});

const atTime = <A, E, R>(iso: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const clock = yield* TestClock.make();
    yield* clock.setTime(epochMs(iso));
    return yield* effect.pipe(Effect.provideService(Clock.Clock, clock));
  });

const workedAt = (runId: string, iso: string) =>
  atTime(
    iso,
    RunRecords.use((records) => records.touch(runId)),
  );

const writtenAt = Effect.fn("board.writtenAt")(function* (file: string, at: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(
    pipe(
      file,
      Str.slice(
        0,
        Option.getOrElse(pipe(file, Str.lastIndexOf("/")), () => -1),
      ),
    ),
    { recursive: true },
  );
  yield* fs.writeFileString(file, "x");
  const when = DateTime.toDateUtc(DateTime.makeUnsafe(at));
  yield* fs.utimes(file, when, when);
});

test("a working card names the step the Run is on, with its round", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const fixing = yield* madeRun(dir, { id: "r-fix", task: "task-1" });
      const reviewing = yield* madeRun(dir, { id: "r-review" });
      const ticket = yield* madeRun(dir, { id: "r-ticket" });
      yield* launched(dir, fixing.id, ["build", "review-1", "fix-1"]);
      yield* launched(dir, reviewing.id, ["build", "review-1", "fix-1", "review-2-1"]);
      yield* launched(dir, ticket.id, ["01-parse.md", "02-one-launch-input-per-module.md"]);
      const seated = yield* madeRun(dir, { id: "r-seat" });
      yield* launched(dir, seated.id, ["build", "review-1", "review-2", "review-3"]);
      const named = yield* madeRun(dir, { id: "r-named" });
      yield* launched(dir, named.id, ["build", "review-gpt-5", "synthesize", "review-2-gpt-5"]);

      const views = yield* board(env, [fixing, reviewing, ticket, seated, named]);
      const said = (id: string) =>
        Option.getOrUndefined(Arr.findFirst(views, (view) => view.run === id))!.sentence;

      expect(said(fixing.id)).toBe("Fixing the review findings, round 1.");
      expect(said(reviewing.id)).toBe("Reviewing, round 2.");
      expect(said(ticket.id)).toBe("Building ticket 02.");
      expect(said(seated.id)).toBe("Reviewing, round 1.");
      expect(said(named.id)).toBe("Reviewing, round 2.");
    }),
  ));

test("a Run is not quiet while its agent works, a check runs, or its agents write", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const old = "2026-09-14T09:00:00Z";
      const working = yield* madeRun(dir, { id: "r-working", task: "task-1" });
      const checking = yield* madeRun(dir, { id: "r-checking" });
      const writing = yield* madeRun(dir, { id: "r-writing" });
      const idle = yield* madeRun(dir, { id: "r-idle" });
      for (const run of [working, checking, writing, idle]) {
        yield* atTime(old, launched(dir, run.id, ["build"]));
      }
      yield* marking(checking, { started: old });
      yield* workedAt(writing.id, "2026-09-14T10:04:00Z");

      const views = yield* board(env, [working, checking, writing, idle], {
        alive: [agent("impl-1", "working"), { ...agent("impl-2", "idle"), paneId: "p-2" }],
        registered: [registered("impl-1", working.id), registered("impl-2", idle.id)],
      });
      const view = (id: string) =>
        Option.getOrUndefined(Arr.findFirst(views, (one) => one.run === id))!;

      expect(view(working.id).state).toBe("active");
      expect(view(working.id).sentence).toBe("Building.");
      expect(view(checking.id).state).toBe("active");
      expect(view(writing.id).state).toBe("active");
      expect(view(idle.id).state).toBe("quiet");
      expect(view(idle.id).sentence).toBe("Building, but silent for 1 hour.");
    }),
  ));

test("a stopped Run whose check still runs is working, and stopped once the check is gone", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const records = yield* RunRecords;
      const run = yield* madeRun(dir, { id: "r-stopped", task: "task-1", state: "stopped" });
      yield* records.setControl(
        RUNNING_CHECK,
        "",
        encodeCheckRecord({
          id: "r-stopped@1-a",
          run: run.id,
          name: "unit",
          pass: "gate",
          by: "collie",
          leader: { pid: 4242, started: "1", group: 4242 },
          host: { pid: 4241, started: "1" },
          started: "2026-09-14T10:03:00Z",
        }),
        "r-stopped@1-a",
      );

      const [checking] = yield* board(env, [run]);
      expect(checking!.state).toBe("active");
      expect(sectionOf(checking!)).toBe("working");
      expect(checking!.sentence).toBe("Running unit on the branch, 2 min.");

      yield* records.setControl(RUNNING_CHECK, "", null, "r-stopped@1-a");
      const [stopped] = yield* board(env, [run]);
      expect(stopped!.state).toBe("stopped");
    }),
  ));

test("a card says how many messages are held behind the Check it is running", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, { id: "r-held", task: "task-1" });
      yield* (yield* RunRecords).setControl(
        VERIFYING,
        run.id,
        encodeVerifying({
          name: "unit",
          executable: "bun",
          argv: ["test"],
          pass: "gate",
          round: null,
          revision: "",
          base: null,
          started: "2026-09-14T10:03:00Z",
        }),
      );
      const [quiet] = yield* board(env, [run]);
      expect(quiet!.sentence).toBe("Running unit on the branch, 2 min.");
      for (const request of ["steer-1", "steer-2"]) {
        yield* keepQueued(launchDir(dir, run.id), {
          runId: run.id,
          request,
          text: "stay in src",
          result: null,
        });
      }
      const [held] = yield* board(env, [run]);
      expect(held!.sentence).toBe(
        "Running unit on the branch, 2 min. 2 messages are held behind it.",
      );
    }),
  ));

test("a check still running for an older Run of a Task keeps the Task working, even out of History", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const newer = yield* madeRun(dir, {
        id: "r-newer",
        task: "task-1",
        state: "succeeded",
        created: "2026-09-12T09:00:00Z",
        finished: "2026-09-12T09:30:00Z",
      });
      const older = yield* madeRun(dir, {
        id: "r-older",
        task: "task-1",
        state: "stopped",
        created: "2026-09-12T08:00:00Z",
        finished: "2026-09-12T08:30:00Z",
      });
      yield* recordDisposition(newer.dir, {
        at: "2026-09-12T10:00:00Z",
        by: "mk",
        kind: "merged",
        ref: "cego/collie!43",
        note: null,
      });
      yield* (yield* RunRecords).setControl(
        RUNNING_CHECK,
        "",
        encodeCheckRecord({
          id: "r-older@1-a",
          run: older.id,
          name: "unit",
          pass: "gate",
          by: "collie",
          leader: { pid: 4242, started: "1", group: 4242 },
          host: { pid: 4241, started: "1" },
          started: "2026-09-14T10:03:00Z",
        }),
        "r-older@1-a",
      );

      const [card] = yield* board(env, [newer, older]);
      expect(card?.state).toBe("active");
      expect(sectionOf(card!)).toBe("working");
      expect(card!.sentence).toContain("Running unit");
    }),
  ));

test("a check left behind by an attempt that ended does not keep its Task working", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const newer = yield* madeRun(dir, {
        id: "r-newer",
        task: "task-1",
        state: "succeeded",
        created: "2026-09-14T09:00:00Z",
        finished: "2026-09-14T09:30:00Z",
      });
      const older = yield* madeRun(dir, {
        id: "r-older",
        task: "task-1",
        state: "failed",
        created: "2026-09-14T08:00:00Z",
        finished: "2026-09-14T08:30:00Z",
      });
      yield* recordedCheck(older, "r-older@1-a");
      yield* marking(older, { name: "lint", pass: "recheck" });

      const [stale] = yield* board(env, [newer, older], { running: new Set<string>() });
      expect(stale?.state).not.toBe("active");
      expect(stale?.check).toBeNull();
      expect(stale!.sentence).not.toContain("Running lint");

      const [live] = yield* board(env, [newer, older], { running: new Set(["r-older@1-a"]) });
      expect(live?.state).toBe("active");
      expect(live!.sentence).toContain("Running lint again");

      const ending = yield* madeRun(dir, { id: "r-ending", task: "task-2" });
      yield* recordedCheck(ending, "r-ending@1-a");
      const [going] = yield* board(env, [ending], { running: new Set<string>() });
      expect(going?.state).toBe("active");
      expect(going!.sentence).toContain("Running lint");
    }),
  ));

test("a marker left behind does not borrow a check of its Run that is still collected", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, {
        id: "r-ended",
        task: "task-1",
        state: "stopped",
        created: "2026-09-14T09:00:00Z",
        finished: "2026-09-14T09:30:00Z",
      });
      yield* recordedCheck(run, "r-ended@1-a");
      yield* recordedCheck(run, "r-ended@1-b", "test");
      yield* marking(run, { name: "lint", pass: "recheck" });

      const [left] = yield* board(env, [run], { running: new Set(["r-ended@1-b"]) });
      expect(left?.check).toBeNull();
      expect(left!.sentence).not.toContain("Running lint");
    }),
  ));

test("what the host writes about a finished Run does not move when it ended", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const old = "2026-09-13T09:00:00Z";
      const run = yield* madeRun(dir, { state: "failed", branch: "mk/old-work" });
      yield* workedAt(run.id, old);
      yield* writtenAt(`${run.dir}/diff.json`, "2026-09-14T10:04:00Z");
      yield* recordAudit(run.dir, {
        operation: "disposition",
        request: "d-1",
        origin: "board",
        result: Schema.String,
        value: "abandoned",
      });

      const [view] = yield* board(env, [run]);
      expect(view!.ended).toBe(epochMs(old));
    }),
  ));

test("a hold is held, not a question: nothing is waiting for an answer", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, { task: "task-1", held: true });

      const [view] = yield* board(env, [run]);

      expect(sectionOf(view!)).toBe("working");
      expect(view!.held).toBe("⏸ Held.");
    }),
  ));

test("what became of the work is the disposition's answer and nobody else's", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, {
        state: "succeeded",
        mr: "content!1",
        created: "2026-09-14T08:00:00Z",
        finished: "2026-09-14T08:30:00Z",
      });

      const now = epochMs("2026-09-14T10:00:00Z");
      const before = yield* board(env, [run], { now });
      expect(before[0]!.sentence).toBe("content!1 is open; its checks have not been read.");

      yield* recordDisposition(run.dir, {
        at: "2026-09-14T09:00:00Z",
        by: "mk",
        kind: "merged",
        ref: "content!1",
        note: null,
      });
      const after = yield* board(env, [run], { now });
      expect(after[0]!.sentence).toBe("Merged as content!1 1 hour ago.");
      expect(after[0]!.disposition).toBe("merged content!1");
    }),
  ));

test("a Run whose work shipped by hand says so, without its status being edited", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, {
        state: "failed",
        note: "the tests never went green",
        created: "2026-09-14T08:00:00Z",
        finished: "2026-09-14T08:30:00Z",
      });
      yield* recordDisposition(run.dir, {
        at: "2026-09-14T09:00:00Z",
        by: "mk",
        kind: "merged",
        ref: "cego/collie!43",
        note: null,
      });

      const [card] = yield* board(env, [run], { now: epochMs("2026-09-14T10:00:00Z") });
      expect(card!.state).toBe("failed");
      expect(card!.disposition).toBe("merged cego/collie!43");
      expect(card!.sentence).toBe(
        "Stopped: the tests never went green. Merged as cego/collie!43 1 hour ago.",
      );
    }),
  ));

test("a Finished Task's report is unseen until someone sees it, and stays Finished either way", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      yield* markSeenSince(dir, "2026-09-14T09:00:00Z");
      const reported = {
        task: "task-1",
        state: "succeeded",
        summary: "two blockers remain",
        created: "2026-09-14T09:10:00Z",
        finished: "2026-09-14T10:00:00Z",
      } as const;
      const unseen = (run: RunFacts) =>
        Effect.map(board(env, [run]), ([view]) => [view!.unseen ?? false, sectionOf(view!)]);

      expect(yield* unseen(yield* madeRun(dir, { ...reported, id: "r-new" }))).toEqual([
        true,
        "finished",
      ]);
      const disposed = yield* madeRun(dir, { ...reported, id: "r-disposed" });
      yield* recordDisposition(disposed.dir, {
        at: "2026-09-14T10:01:00Z",
        by: "mk",
        kind: "abandoned",
        ref: "",
        note: null,
      });
      expect(yield* unseen(disposed)).toEqual([false, "finished"]);
      expect(
        yield* unseen(yield* madeRun(dir, { ...reported, id: "r-quiet", summary: "" })),
      ).toEqual([false, "finished"]);
      const seen = yield* madeRun(dir, { ...reported, id: "r-seen" });
      yield* recordSeen(seen.dir, { at: "2026-09-14T10:02:00Z", by: "human:ack-1" });
      expect(yield* unseen(seen)).toEqual([false, "finished"]);
      expect(
        yield* unseen(
          yield* madeRun(dir, {
            ...reported,
            id: "r-old",
            created: "2026-09-14T08:00:00Z",
            finished: "2026-09-14T08:30:00Z",
          }),
        ),
      ).toEqual([false, "finished"]);
      expect(
        yield* unseen(yield* madeRun(dir, { ...reported, id: "r-branch", branch: "mk/fix" })),
      ).toEqual([false, "waiting"]);
    }),
  ));

test("an unseen report is still drawn a day later, and a seen one goes to History", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      yield* markSeenSince(dir, "2026-09-14T09:00:00Z");
      const reported = {
        task: "task-1",
        state: "succeeded",
        summary: "two blockers remain",
        created: "2026-09-14T09:10:00Z",
        finished: "2026-09-14T10:00:00Z",
      } as const;
      const later = { now: epochMs("2026-09-16T10:00:00Z") };

      const [unseen] = yield* board(
        env,
        [yield* madeRun(dir, { ...reported, id: "r-unseen" })],
        later,
      );
      expect(unseen?.unseen).toBe(true);
      const seen = yield* madeRun(dir, { ...reported, id: "r-seen" });
      yield* recordSeen(seen.dir, { at: "2026-09-14T10:02:00Z", by: "human:ack-1" });
      expect(yield* board(env, [seen], later)).toEqual([]);
    }),
  ));

test("a month-old Task pruned after its record was read goes to History, and a record read brings none back", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const now = yield* Clock.currentTimeMillis;
      const monthAgo = DateTime.formatIso(DateTime.makeUnsafe(now - 30 * 86_400_000));
      const opts = { now };
      const unmerged = yield* madeRun(dir, {
        id: "r-unmerged",
        task: "task-1",
        state: "failed",
        branch: "mk/old-work",
        created: monthAgo,
      });
      const bare = yield* madeRun(dir, {
        id: "r-bare",
        task: "task-2",
        state: "failed",
        created: monthAgo,
      });
      for (const run of [unmerged, bare]) {
        yield* writtenAt(`${run.dir}/log.txt`, monthAgo);
      }
      const before = yield* board(env, [unmerged, bare], opts);
      expect(Arr.map(before, (view) => [view.run, sectionOf(view)])).toEqual([
        [unmerged.id, "waiting"],
      ]);

      for (const run of [unmerged, bare]) {
        yield* readLogTail(run.dir, 4096);
      }
      yield* recordDisposition(unmerged.dir, {
        kind: "abandoned",
        ref: "",
        at: DateTime.formatIso(DateTime.makeUnsafe(now)),
        by: "human",
        note: null,
      });

      expect(yield* board(env, [unmerged, bare], opts)).toEqual([]);
    }),
  ));

test("a Run that ended with nothing to file is finished, not waiting", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const bare = yield* madeRun(dir, { id: "r-bare", task: "t-bare", state: "failed" });
      const branched = yield* madeRun(dir, {
        id: "r-branch",
        task: "t-branch",
        state: "failed",
        branch: "mk/control-plane",
      });

      const views = yield* board(env, [bare, branched]);
      const by = (task: string) =>
        Option.getOrUndefined(Arr.findFirst(views, (view) => view.id === task))!;
      expect(by("t-bare").landed).toBe(true);
      expect(sectionOf(by("t-bare"))).toBe("finished");
      expect(by("t-branch").landed).toBe(false);
      expect(sectionOf(by("t-branch"))).toBe("waiting");
    }),
  ));

test("a Run that recorded it had nothing to land is finished, while another Run's branch still waits", () =>
  runEffect(
    Effect.gen(function* () {
      const records = yield* RunRecords;
      const { dir, env } = yield* scratch();
      const succeeded = (id: string, task: string) =>
        madeRun(dir, { id, task, state: "succeeded", branch: `mk/${id}` });
      const nothing = yield* succeeded("r-nothing", "t-nothing");
      yield* records.put(nothing.id, NOTHING_TO_LAND, "nothing to land\n");
      const shared = yield* succeeded("r-shared", "t-shared");
      yield* records.put(shared.id, NOTHING_TO_LAND, "nothing to land\n");
      const runs = [
        nothing,
        yield* succeeded("r-something", "t-something"),
        shared,
        yield* succeeded("r-other", "t-shared"),
      ];

      const views = yield* board(env, runs);
      const by = (task: string) =>
        Option.getOrUndefined(Arr.findFirst(views, (view) => view.id === task))!;
      expect(sectionOf(by("t-nothing"))).toBe("finished");
      expect(sectionOf(by("t-something"))).toBe("waiting");
      expect(sectionOf(by("t-shared"))).toBe("waiting");
    }),
  ));

test("a Task's card reads its Task: a stopped child's Disposition, not its waiting parent", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const plan = yield* madeRun(dir, {
        id: "r-plan",
        workflow: "plan",
        task: "task-1",
        created: "2026-09-14T08:00:00Z",
      });
      const implement = yield* madeRun(dir, {
        id: "r-plan.implement",
        task: "task-1",
        parent: "r-plan",
        state: "stopped",
        branch: "mk/control-plane",
        created: "2026-09-14T08:10:00Z",
        finished: "2026-09-14T08:30:00Z",
      });
      yield* recordDisposition(implement.dir, {
        at: "2026-09-14T09:00:00Z",
        by: "mk",
        kind: "merged",
        ref: "cego/collie#115",
        note: null,
      });

      const [card] = yield* board(env, [plan, implement]);
      expect(card!.state).toBe("stopped");
      expect(card!.sentence).toEndWith("Merged as cego/collie#115 1 hour ago.");
      expect(card!.disposition).toBe("merged cego/collie#115");
      expect(sectionOf(card!)).toBe("finished");
    }),
  ));

test("a Task's card reads its Task: the latest Disposition on any of its Runs", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const plan = yield* madeRun(dir, {
        id: "r-plan",
        workflow: "plan",
        task: "task-1",
        state: "succeeded",
        created: "2026-09-14T08:00:00Z",
        finished: "2026-09-14T08:05:00Z",
      });
      const implement = yield* madeRun(dir, {
        id: "r-implement",
        task: "task-1",
        state: "succeeded",
        branch: "mk/control-plane",
        created: "2026-09-14T08:10:00Z",
        finished: "2026-09-14T08:30:00Z",
      });
      const disposed = (run: RunFacts, at: string, ref: string) =>
        recordDisposition(run.dir, { at, by: "mk", kind: "merged", ref, note: null });

      yield* disposed(implement, "2026-09-14T09:00:00Z", "cego/collie#114");
      yield* disposed(plan, "2026-09-14T09:30:00Z", "cego/collie#115");
      expect((yield* board(env, [plan, implement]))[0]!.disposition).toBe("merged cego/collie#115");

      yield* disposed(implement, "2026-09-14T09:45:00Z", "cego/collie#116");
      const [card] = yield* board(env, [plan, implement]);
      expect(card!.disposition).toBe("merged cego/collie#116");
      expect(card!.landed).toBe(true);
    }),
  ));

test("a Task's card reads its Task: a line on a Run that carries no branch settles nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const plan = yield* madeRun(dir, {
        id: "r-plan",
        workflow: "plan",
        task: "task-1",
        state: "succeeded",
        created: "2026-09-14T08:00:00Z",
        finished: "2026-09-14T08:05:00Z",
      });
      const implement = yield* madeRun(dir, {
        id: "r-implement",
        task: "task-1",
        state: "succeeded",
        branch: "mk/control-plane",
        created: "2026-09-14T08:10:00Z",
        finished: "2026-09-14T08:30:00Z",
      });
      yield* recordDisposition(plan.dir, {
        at: "2026-09-14T09:30:00Z",
        by: "mk",
        kind: "superseded",
        ref: "r-implement",
        note: null,
      });
      const [card] = yield* board(env, [plan, implement]);
      expect(card!.disposition).toBe("superseded r-implement");
      expect(card!.landed).toBe(false);
      expect(sectionOf(card!)).toBe("waiting");
    }),
  ));

const M = "https://gitlab.cego.dk/mk/support/-/merge_requests/279";
const M_ID = "gitlab.cego.dk/mk/support!279";
const M_HEAD = "77215b10aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

test("an old open forge answer is historical, and a fresh answer removes that qualification", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, {
        state: "succeeded",
        mr: M,
        finished: "2026-09-14T09:00:00Z",
      });
      const read = (at: string) =>
        board(env, [run], {
          mrStates: new Map([[M_ID, "open"]]),
          forge: new Map([[M_ID, { checks: { state: "unknown" }, head: M_HEAD, read: at }]]),
        });
      const [old] = yield* read("2026-09-14T08:00:00Z");
      expect(old?.sentence).toContain("last read as open");
      expect(old?.sentence).not.toContain("is open");
      expect(old?.landed).toBe(false);
      const [fresh] = yield* read("2026-09-14T10:04:00Z");
      expect(fresh?.sentence).toContain("is open");
      expect(fresh?.sentence).not.toContain("last read");
    }),
  ));

test("a recorded merge overrides an older open answer in every card field until a fresh reopen", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, {
        task: TASK.id,
        state: "succeeded",
        mr: M,
        branch: "mk/landed",
        created: "2026-09-14T08:00:00Z",
        finished: "2026-09-14T09:00:00Z",
      });
      yield* recordDisposition(run.dir, {
        at: "2026-09-14T09:30:00Z",
        by: "mk",
        kind: "merged",
        ref: M,
        note: null,
      });
      const read = (at: string, runs: ReadonlyArray<RunFacts> = [run]) =>
        board(env, runs, {
          mrStates: new Map([[M_ID, "open"]]),
          forge: new Map([[M_ID, { checks: { state: "unknown" }, head: M_HEAD, read: at }]]),
        });
      const [settled] = yield* read("2026-09-14T09:00:00Z");
      expect(settled?.landed).toBe(true);
      expect(settled?.mrState).toBe("merged");
      expect(settled?.mrs?.[0]?.state).toBe("merged");
      expect(settled?.sentence).toContain("Merged as");
      const unique = yield* madeRun(dir, {
        id: "r-card-offers",
        task: TASK.id,
        state: "succeeded",
        branch: "mk/unpublished-card-offers",
        created: "2026-09-14T09:40:00Z",
        finished: "2026-09-14T09:50:00Z",
      });
      expect((yield* read("2026-09-14T09:00:00Z", [run, unique]))[0]?.landed).toBe(false);
      const [reopened] = yield* read("2026-09-14T10:00:00Z");
      expect(reopened?.landed).toBe(false);
      expect(reopened?.mrState).toBe("open");
      expect(reopened?.mrs?.[0]?.settled).toBeNull();
      expect(reopened?.sentence).not.toContain("Merged as");
    }),
  ));

test("a Repo run's branch without an MR keeps its Task out of Finished and History", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const parent = yield* madeRun(dir, {
        id: "r-parent",
        task: TASK.id,
        state: "succeeded",
        created: "2026-09-14T08:00:00Z",
      });
      const child = yield* madeRun(dir, {
        id: "r-api",
        parent: parent.id,
        repo: "api",
        task: TASK.id,
        state: "succeeded",
        project: "/project/api",
        branch: "mk/owed",
        created: "2026-09-14T09:00:00Z",
      });
      const cards = yield* board(env, [parent, child], {
        now: epochMs("2026-09-15T10:00:00Z"),
        head: () => Effect.succeed(null),
      });
      expect(cards).toHaveLength(1);
      expect(cards[0]!.landed).toBe(false);
      expect(sectionOf(cards[0]!)).toBe("waiting");
    }),
  ));

test("merging the leading Run's branch does not settle another Run's open MR", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const mr = yield* madeRun(dir, {
        id: "r-mr",
        task: TASK.id,
        state: "succeeded",
        branch: "mk/mr",
        mr: M,
        created: "2026-09-14T08:00:00Z",
      });
      const branch = yield* madeRun(dir, {
        id: "r-branch",
        task: TASK.id,
        state: "succeeded",
        branch: "mk/branch",
        created: "2026-09-14T09:00:00Z",
      });
      yield* recordDisposition(branch.dir, {
        at: "2026-09-14T09:30:00Z",
        by: "mk",
        kind: "merged",
        ref: "mk/branch",
        note: null,
      });
      const [card] = yield* board(env, [mr, branch], {
        mrStates: new Map([[M_ID, "open"]]),
        head: () => Effect.succeed(null),
      });
      expect(card!.landed).toBe(false);
      expect(card!.mrs![0]!.settled).toBeNull();
    }),
  ));

for (const withMr of [false, true]) {
  test(`an unsettled branch remains owed beside ${withMr ? "a merged MR" : "another settled branch"}`, () =>
    runEffect(
      Effect.gen(function* () {
        const { dir, env } = yield* scratch();
        const first = yield* madeRun(dir, {
          id: "r-settled",
          task: TASK.id,
          state: "succeeded",
          branch: "mk/one",
          mr: withMr ? M : null,
          created: "2026-09-14T08:00:00Z",
        });
        const second = yield* madeRun(dir, {
          id: "r-owed",
          task: TASK.id,
          state: "succeeded",
          branch: "mk/two",
          created: "2026-09-14T09:00:00Z",
        });
        yield* recordDisposition(first.dir, {
          at: "2026-09-14T09:30:00Z",
          by: "mk",
          kind: "merged",
          ref: withMr ? M : "mk/one",
          note: null,
        });
        const [card] = yield* board(env, [first, second], {
          mrStates: new Map([[M_ID, "merged"]]),
          head: () => Effect.succeed(null),
        });
        expect(card!.landed).toBe(false);
        expect(sectionOf(card!)).toBe("waiting");
      }),
    ));
}

const supersededChain = Effect.fn("board.supersededChain")(function* (dir: string) {
  const first = yield* madeRun(dir, {
    id: "r-first",
    task: "task-1",
    state: "failed",
    branch: "mk/nuxt-ci",
    mr: M,
    created: "2026-09-14T08:00:00Z",
    finished: "2026-09-14T08:30:00Z",
  });
  const second = yield* madeRun(dir, {
    id: "r-second",
    task: "task-1",
    state: "succeeded",
    branch: "mk/nuxt-ci",
    mr: M,
    created: "2026-09-14T08:40:00Z",
    finished: "2026-09-14T09:30:00Z",
  });
  yield* recordDisposition(first.dir, {
    at: "2026-09-14T09:00:00Z",
    by: "cli:recovery",
    kind: "superseded",
    ref: `r-second; ${M}`,
    note: null,
  });
  yield* appendVerification(second.evidence, checked("test", M_HEAD));
  return { first, second };
});

const unapproved = (state: MrState = "open") => ({
  mrStates: new Map<string, MrState>([[M_ID, state]]),
  forge: new Map([
    [
      M_ID,
      {
        checks: { state: "passed" as const },
        head: M_HEAD,
        mergeable: { state: "blocked" as const, said: "not approved" },
        read: "2026-09-14T10:04:00Z",
      },
    ],
  ]),
  head: () => Effect.succeed(M_HEAD),
});

for (const state of ["failed", "stopped"] as const) {
  test(`a ${state} Task reports its owed MR and failed forge read instead of an overruled merged line`, () =>
    runEffect(
      Effect.gen(function* () {
        const { dir, env } = yield* scratch();
        const run = yield* madeRun(dir, { task: TASK.id, state, branch: "mk/nuxt-ci", mr: M });
        yield* recordDisposition(run.dir, {
          at: "2026-09-14T09:00:00Z",
          by: "mk",
          kind: "merged",
          ref: M,
          note: null,
        });
        const [card] = yield* board(env, [run], {
          ...unapproved(),
          forge: new Map([
            [
              M_ID,
              {
                ...unapproved().forge.get(M_ID)!,
                read: "2026-09-14T09:30:00Z",
                asked: "2026-09-14T10:00:00Z",
              },
            ],
          ]),
        });
        expect(sectionOf(card!)).toBe("waiting");
        expect(card!.sentence).toContain("mk/support!279");
        expect(card!.sentence).toContain("could not be read");
        expect(card!.sentence).not.toContain("Merged as");
      }),
    ));
}

test("an owed Task discloses a removed checkout and refreshes when it is restored", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const fs = yield* FileSystem.FileSystem;
      const path = `${dir}/removed-checkout`;
      const run = yield* madeRun(dir, {
        task: TASK.id,
        state: "succeeded",
        branch: "mk/recovered",
        mr: M,
        worktree: {
          path,
          branch: "mk/recovered",
          created_by_collie: true,
          created_branch: false,
          created_on: null,
          managed_by: "git",
          workspace_id: null,
          made_at: null,
          root_tab_id: null,
          root_pane_id: null,
        },
      });
      const cards = { revision: () => 1, kept: new Map() };
      const read = () => board(env, [run], { ...unapproved(), cards });
      const [missing] = yield* read();
      expect(sectionOf(missing!)).toBe("waiting");
      expect(missing!.sentence).toContain("no checkout");
      expect(missing!.sentence).toContain("mk/support!279");
      expect(yield* fs.exists(path)).toBe(false);
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(TaskView))(missing!);
      const received = yield* Schema.decodeEffect(Schema.fromJsonString(TaskView))(encoded);
      expect(Arr.join(boardLines([received]), "\n")).toContain("no checkout");
      expect(herdLines([received], epochMs("2026-09-14T10:05:00Z"))).toContain("no checkout");
      yield* fs.makeDirectory(path);
      const [restored] = yield* read();
      expect(restored!.sentence).not.toContain("no checkout");
      yield* fs.remove(path, { recursive: true });
      const [removed] = yield* read();
      expect(removed!.sentence).toContain("no checkout");
      const [landed] = yield* board(env, [run], { ...unapproved("merged"), cards });
      expect(landed!.sentence).not.toContain("no checkout");
    }),
  ));

test("Merge uses the Release offer even when an unrelated follow-up is primary", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const { second } = yield* supersededChain(dir);
      const release: OfferView = {
        id: "release",
        title: "Release",
        workflow: "renamed-delivery",
        arguments: null,
        kind: "follow-up" as const,
        primary: false,
        unavailable: null,
      };
      const unrelated = { ...release, id: "follow-up", title: "Keep going on this", primary: true };
      const read = (offers: ReadonlyArray<typeof release>) =>
        board(env, [second], {
          ...unapproved(),
          forge: new Map([
            [
              M_ID,
              {
                ...unapproved().forge.get(M_ID)!,
                mergeable: { state: "mergeable", said: "approved" },
              },
            ],
          ]),
          head: () => Effect.succeed(M_HEAD),
          offers: () => Effect.succeed(offers),
        });
      const [ready] = yield* read([unrelated, release]);
      expect(primaryAction(ready!)).toEqual({
        kind: "offer",
        offer: { id: "release", title: "Release", run: "r-second" },
      });
      for (const offers of [
        [unrelated],
        [unrelated, { ...release, unavailable: "not connected" }],
        [],
      ]) {
        const [card] = yield* read(offers);
        expect(card!.offer).toBeNull();
        expect(primaryAction(card!)?.kind).toBe("open-mr");
      }
    }),
  ));

test("Ready to ship takes the offer that declares it releases before one that only merges, action or follow-up, and says that offer's title", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const { second } = yield* supersededChain(dir);
      const offer: (
        id: string,
        title: string,
        ships: "merge" | "release",
        kind?: OfferView["kind"],
      ) => OfferView = (id, title, ships, kind = "follow-up") => ({
        id,
        title,
        workflow: "delivery",
        arguments: null,
        kind,
        ships,
        primary: false,
        unavailable: null,
      });
      const read = (offers: ReadonlyArray<OfferView>) =>
        board(env, [second], {
          ...unapproved(),
          forge: new Map([
            [
              M_ID,
              {
                ...unapproved().forge.get(M_ID)!,
                mergeable: { state: "mergeable", said: "approved" },
              },
            ],
          ]),
          head: () => Effect.succeed(M_HEAD),
          offers: () => Effect.succeed(offers),
        });
      const merge = offer("merge", "Merge", "merge");
      const [both] = yield* read([merge, offer("deliver", "Release", "release")]);
      expect(primaryAction(both!)).toEqual({
        kind: "offer",
        offer: { id: "deliver", title: "Release", run: second.id },
      });
      expect(Arr.join(boardLines([both!]), "\n")).toContain(`Release: ${both!.sentence}`);
      expect(herdLines([both!], 0)).toContain(`Release: ${both!.sentence}`);
      const [alone] = yield* read([merge]);
      expect(primaryAction(alone!)).toEqual({
        kind: "offer",
        offer: { id: "merge", title: "Merge", run: second.id },
      });
      const ship = offer("ship", "Ship it", "release", "action");
      const [byAction] = yield* read([merge, ship]);
      expect(primaryAction(byAction!)).toEqual({
        kind: "offer",
        offer: { id: "ship", title: "Ship it", run: second.id },
      });
      const [actionAlone] = yield* read([ship]);
      expect(primaryAction(actionAlone!)).toEqual({
        kind: "offer",
        offer: { id: "ship", title: "Ship it", run: second.id },
      });
    }),
  ));

test("fresh green work preserves its declared Release title, revoked by a moved head, failed CI, stale answer or unknown mergeability", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const { second } = yield* supersededChain(dir);
      const fresh = {
        checks: { state: "passed" as const },
        head: M_HEAD,
        mergeable: { state: "mergeable" as const, said: "approved" },
        read: "2026-09-14T10:04:00Z",
      };
      const read = (facts: typeof fresh | Partial<typeof fresh>) =>
        board(env, [second], {
          mrStates: new Map([[M_ID, "open"]]),
          forge: new Map([[M_ID, { ...fresh, ...facts }]]),
          head: () => Effect.succeed(M_HEAD),
          offers: () =>
            Effect.succeed([
              {
                id: "release",
                title: "Release after review",
                workflow: "release",
                arguments: null,
                kind: "follow-up",
                primary: true,
                unavailable: null,
              },
            ]),
        });
      const [ready] = yield* read(fresh);
      expect(sectionOf(ready!)).toBe("ready-to-ship");
      expect(ready!.shipping).toBe("merge");
      expect(ready!.shippingMr).toBe(M);
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(TaskView))(ready!);
      const received = yield* Schema.decodeEffect(Schema.fromJsonString(TaskView))(encoded);
      const desktop = flockCards(
        applyItem(EMPTY_FLOCK, {
          machine: { installation: "host", profile: "local", name: "host" },
          message: {
            _tag: "Snapshot",
            installation: "host",
            build: "dev",
            protocol: 5,
            herds: [],
            tasks: [received],
            seq: 1,
          },
        }),
      ).tasks;
      expect(sectionsOf(desktop, "").ready).toHaveLength(1);
      expect(primaryAction(desktop[0]!)).toEqual({
        kind: "offer",
        offer: { id: "release", title: "Release after review", run: "r-second" },
      });
      const text = Arr.join(boardLines([received]), "\n");
      expect(text).toContain("Ready to ship · 1");
      const chat = herdLines([received], epochMs("2026-09-14T10:05:00Z"));
      expect(chat).toContain("## Ready to ship · 1");
      expect([text, chat]).toEqual([
        expect.stringContaining("Release after review: Ready to release: mk/support!279"),
        expect.stringContaining("Release after review: Ready to release: mk/support!279"),
      ]);
      const cards = { revision: () => 1, kept: new Map() };
      const cached = (now: string) =>
        board(env, [second], {
          mrStates: new Map([[M_ID, "open"]]),
          forge: new Map([[M_ID, fresh]]),
          cards,
          now: epochMs(now),
          head: () => Effect.succeed(M_HEAD),
        });
      expect(sectionOf((yield* cached("2026-09-14T10:13:59Z"))[0]!)).toBe("ready-to-ship");
      expect(sectionOf((yield* cached("2026-09-14T10:14:01Z"))[0]!)).toBe("waiting");
      for (const [over, missing] of [
        [{ head: "new-head" }, "checked"],
        [{ checks: { state: "failed", name: "test" } }, "test failed"],
        [{ read: "2026-09-14T09:30:00Z" }, "stale"],
        [{ mergeable: { state: "unknown", said: "checking" } }, "merge"],
      ] as const) {
        const [card] = yield* board(env, [second], {
          mrStates: new Map([[M_ID, "open"]]),
          forge: new Map([[M_ID, { ...fresh, ...over }]]),
          head: () => Effect.succeed(M_HEAD),
        });
        expect(sectionOf(card!)).toBe("waiting");
        expect(card!.shipping ?? null).toBeNull();
        expect(card!.sentence).toContain(missing);
      }
    }),
  ));

test("a declared shipping Go holds only at its head and gates; an ordinary question stays in Needs you", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const { second } = yield* supersededChain(dir);
      const fresh = {
        checks: { state: "passed" as const },
        head: M_HEAD,
        mergeable: { state: "mergeable" as const, said: "approved" },
        read: "2026-09-14T10:04:00Z",
      };
      const read = (
        action: "merge" | "stage" | null,
        head = M_HEAD,
        approved = true,
        workflow = "release",
      ) =>
        board(
          env,
          [
            {
              ...second,
              workflow,
              state: "waiting",
              asking: [
                {
                  name: action === null ? "go-1" : "any-name",
                  prompt: "Go?",
                  options: [
                    { id: "Release", title: "Release", recommended: true },
                    { id: "Finish", title: "Finish" },
                  ],
                  shipping: action === null ? undefined : { action, head: M_HEAD },
                },
              ],
            },
          ],
          {
            mrStates: new Map([[M_ID, "open"]]),
            forge: new Map([
              [
                M_ID,
                {
                  ...fresh,
                  head,
                  mergeable: approved
                    ? fresh.mergeable
                    : { state: "blocked", said: "not approved" },
                },
              ],
            ]),
            head: () => Effect.succeed(M_HEAD),
          },
        );
      for (const action of ["merge", "stage"] as const) {
        const [ready] = yield* read(action);
        expect(sectionOf(ready!)).toBe("ready-to-ship");
        expect(ready!.shipping).toBe(action);
        expect(ready!.shippingMr).toBe(M);
        const [moved] = yield* read(action, "new-head");
        expect(sectionOf(moved!)).toBe("needs-you");
        expect(moved!.sentence).toContain("no longer holds for 77215b1");
        expect(moved!.shipping).toBeNull();
        const [blocked] = yield* read(action, M_HEAD, false);
        expect(sectionOf(blocked!)).toBe("needs-you");
        expect(blocked!.sentence).toContain("not approved");
      }
      for (const workflow of ["release", "stage"]) {
        const [ordinary] = yield* read(null, M_HEAD, true, workflow);
        expect(sectionOf(ordinary!)).toBe("needs-you");
      }
    }),
  ));

test("a head Deploy Go needs a current forge answer whose read time is not in the future", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, {
        task: TASK.id,
        mr: M,
        state: "waiting",
        asking: [
          {
            name: "production",
            prompt: "Ship it?",
            options: [],
            shipping: { action: "deploy", head: M_HEAD },
          },
        ],
      });
      yield* writeStageProof(run.dir, { head: M_HEAD, tag: null, proved: true, why: null });
      const read = (read: string, asked = read) =>
        board(env, [run], {
          mrStates: new Map([[M_ID, "open"]]),
          forge: new Map([[M_ID, { head: M_HEAD, read, asked, checks: { state: "unknown" } }]]),
        });

      const [future] = yield* read("2026-09-14T10:06:00Z");
      expect(sectionOf(future!)).toBe("needs-you");
      expect(future!.shipping).toBeNull();
      expect(future!.sentence).toContain("no longer holds for 77215b1");
      const [fresh] = yield* read("2026-09-14T10:04:00Z");
      expect(sectionOf(fresh!)).toBe("ready-to-ship");
      expect(fresh!.shipping).toBe("deploy");
      for (const [readAt, askedAt] of [
        ["invalid", "invalid"],
        ["2026-09-14T09:54:00Z", "2026-09-14T09:54:00Z"],
        ["2026-09-14T10:04:00Z", "2026-09-14T10:05:00Z"],
      ] as const) {
        const [card] = yield* read(readAt, askedAt);
        expect(sectionOf(card!)).toBe("needs-you");
        expect(card!.shipping).toBeNull();
      }
    }),
  ));

test("a Deploy Go uses the host's stage proof for its exact tag, and loses readiness when that proof fails", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, {
        task: TASK.id,
        mr: M,
        state: "waiting",
        asking: [
          {
            name: "any-production-name",
            prompt: "Ship it?",
            options: [],
            shipping: { action: "deploy", tag: "v1.2.3" },
          },
        ],
      });
      const fs = yield* FileSystem.FileSystem;
      for (const [tag, proved] of [
        ["v1.2.3", true],
        ["v1.2.4", true],
        ["v1.2.3", false],
      ] as const) {
        yield* fs.writeFileString(
          `${run.dir}/shipping-stage.json`,
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            head: M_HEAD,
            tag,
            proved,
            why: proved ? null : "stage failed",
          }),
        );
        const [card] = yield* board(env, [run]);
        expect(sectionOf(card!)).toBe(tag === "v1.2.3" && proved ? "ready-to-ship" : "needs-you");
        if (proved && tag === "v1.2.3") {
          expect(card!.shipping).toBe("deploy");
        } else {
          expect(card!.sentence).toContain("stage");
        }
      }
    }),
  ));

test("a follow-up that finished at an open merge request leaves its Task owing it, whatever its predecessor's line", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const { first, second } = yield* supersededChain(dir);
      const [card] = yield* board(env, [first, second], unapproved());
      expect(card!.landed).toBe(false);
      expect(sectionOf(card!)).toBe("waiting");
      expect(card!.sentence).toContain("mk/support!279");
      expect(card!.sentence).toContain("not approved");
      expect(card!.readiness?.missing).toContainEqual({
        fact: "mergeable",
        said: "the forge says it cannot merge: not approved",
        settling: false,
      });
      expect(card!.sentence).not.toContain("Superseded by");
    }),
  ));

test("a Task still owing a merge request is not folded into History a day later", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const { first, second } = yield* supersededChain(dir);
      const views = yield* board(env, [first, second], {
        ...unapproved(),
        now: epochMs("2026-09-15T10:30:00Z"),
      });
      expect(Arr.map(views, (view) => view.id)).toEqual(["task-1"]);
      expect(sectionOf(views[0]!)).toBe("waiting");
    }),
  ));

test("a line handing the work to a Run of another Task lands its own Task, and the other owes what it carries", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const first = yield* madeRun(dir, {
        id: "r-first",
        task: "task-1",
        state: "failed",
        branch: "mk/nuxt-ci",
        mr: M,
        created: "2026-09-14T08:00:00Z",
        finished: "2026-09-14T08:30:00Z",
      });
      const elsewhere = yield* madeRun(dir, {
        id: "r-elsewhere",
        task: "task-2",
        state: "succeeded",
        branch: "mk/nuxt-ci",
        mr: M,
        created: "2026-09-14T08:40:00Z",
        finished: "2026-09-14T09:30:00Z",
      });
      yield* recordDisposition(first.dir, {
        at: "2026-09-14T09:00:00Z",
        by: "mk",
        kind: "superseded",
        ref: "r-elsewhere",
        note: null,
      });
      const views = yield* board(env, [first, elsewhere], {
        ...unapproved(),
        tasks: [TASK, { ...TASK, id: "task-2" }],
      });
      const by = (task: string) =>
        Option.getOrUndefined(Arr.findFirst(views, (view) => view.id === task))!;
      expect(by("task-1").landed).toBe(true);
      expect(sectionOf(by("task-1"))).toBe("finished");
      expect(by("task-1").sentence).toContain("Superseded by r-elsewhere");
      expect(by("task-2").landed).toBe(false);
      expect(sectionOf(by("task-2"))).toBe("waiting");
      expect(by("task-2").sentence).toContain("mk/support!279");
    }),
  ));

test("a superseded branch-only Run hands its work to a successor that carries a merge request", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const first = yield* madeRun(dir, {
        id: "r-first",
        task: "task-1",
        state: "stopped",
        branch: "mk/old",
        created: "2026-09-14T08:00:00Z",
        finished: "2026-09-14T08:30:00Z",
      });
      const successor = yield* madeRun(dir, {
        id: "r-successor",
        task: "task-2",
        state: "succeeded",
        branch: "mk/new",
        mr: M,
        created: "2026-09-14T08:40:00Z",
        finished: "2026-09-14T09:30:00Z",
      });
      yield* recordDisposition(first.dir, {
        at: "2026-09-14T09:00:00Z",
        by: "chat",
        kind: "superseded",
        ref: successor.id,
        note: null,
      });

      const views = yield* board(env, [first, successor], {
        tasks: [TASK, { ...TASK, id: "task-2" }],
        mrStates: new Map([[M_ID, "merged"]]),
      });
      const firstCard = Option.getOrThrow(Arr.findFirst(views, (view) => view.id === "task-1"));
      expect(firstCard.landed).toBe(true);
      expect(sectionOf(firstCard)).toBe("finished");
      expect(firstCard.sentence).toContain("Superseded by r-successor");
    }),
  ));

test("a handoff lands a Run only on the same branch, or on a successor's merge request where it records none itself", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const tasks = [TASK, { ...TASK, id: "task-other" }, { ...TASK, id: "task-third" }];
      const landedOn = (first: RunFacts, successor: RunFacts) =>
        Effect.gen(function* () {
          yield* recordDisposition(first.dir, {
            at: "2026-09-14T09:00:00Z",
            by: "chat",
            kind: "superseded",
            ref: successor.id,
            note: null,
          });
          const views = yield* board(env, [first, successor], { tasks });
          return Option.getOrThrow(Arr.findFirst(views, (view) => view.id === first.task!)).landed;
        });

      const bare = yield* madeRun(dir, {
        id: "r-bare",
        task: "task-1",
        state: "failed",
        branch: "mk/support",
        mr: "!279",
        created: "2026-09-14T08:00:00Z",
        finished: "2026-09-14T08:30:00Z",
      });
      const unrelated = yield* madeRun(dir, {
        id: "r-unrelated",
        task: "task-other",
        state: "succeeded",
        branch: "mk/other",
        mr: "https://gitlab.cego.dk/mk/other/-/merge_requests/7",
        created: "2026-09-14T08:40:00Z",
        finished: "2026-09-14T09:30:00Z",
      });
      expect(yield* landedOn(bare, unrelated)).toBe(false);

      const carried = yield* madeRun(dir, {
        id: "r-carried",
        task: "task-1",
        state: "failed",
        branch: "mk/support",
        mr: M,
        created: "2026-09-14T08:00:00Z",
        finished: "2026-09-14T08:30:00Z",
      });
      const sameBranch = yield* madeRun(dir, {
        id: "r-same-branch",
        task: "task-third",
        state: "succeeded",
        branch: "mk/support",
        created: "2026-09-14T08:40:00Z",
        finished: "2026-09-14T09:30:00Z",
      });
      expect(yield* landedOn(carried, sameBranch)).toBe(true);
    }),
  ));

test("a different local Task cannot take an unrelated carrier's obligation", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const source = yield* madeRun(dir, {
        id: "r-source",
        task: "task-1",
        state: "failed",
        mr: M,
        branch: "mk/support",
        finished: "2026-09-14T09:00:00Z",
      });
      const unrelated = yield* madeRun(dir, {
        id: "r-unrelated",
        task: "task-other",
        state: "running",
        mr: "https://gitlab.cego.dk/mk/other/-/merge_requests/279",
        branch: "mk/other",
      });
      yield* recordDisposition(source.dir, {
        at: "2026-09-14T09:30:00Z",
        by: "mk",
        kind: "superseded",
        ref: unrelated.id,
        note: null,
      });
      const views = yield* board(env, [source, unrelated], {
        tasks: [TASK, { ...TASK, id: "task-other" }],
      });
      expect(
        Option.getOrUndefined(Arr.findFirst(views, (one) => one.id === "task-1"))?.landed,
      ).toBe(false);
      expect(
        Option.getOrUndefined(Arr.findFirst(views, (one) => one.id === "task-other"))?.state,
      ).toBe("active");
    }),
  ));

test("a superseded ref naming its successor as <machine>:<run> hands the work on only where the machine is this host", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const here = { ...env, machine: "vm-mk.cegohost.dk" };
      const next = yield* madeRun(dir, {
        id: "r-next",
        task: "task-next",
        state: "running",
        branch: "mk/carried",
      });
      const refs = [
        ["task-full", "vm-mk.cegohost.dk:r-next"],
        ["task-short", "vm-mk:r-next"],
        ["task-other", "mk-laptop:r-next"],
        ["task-unknown", "vm-mk:r-none"],
        ["task-url", "https://vm-mk/r-next"],
      ] as const;
      const runs = [next];
      for (const [task, ref] of refs) {
        const run = yield* madeRun(dir, {
          id: `r-${task}`,
          task,
          state: "failed",
          branch: "mk/carried",
          created: "2026-09-14T08:00:00Z",
          finished: "2026-09-14T08:30:00Z",
        });
        yield* recordDisposition(run.dir, {
          at: "2026-09-14T09:00:00Z",
          by: "chat",
          kind: "superseded",
          ref,
          note: null,
        });
        runs.push(run);
      }

      const views = yield* board(here, runs, {
        tasks: Arr.map(["task-next", ...Arr.map(refs, ([task]) => task)], (id) => ({
          ...TASK,
          id,
        })),
      });
      expect(
        Arr.map(refs, ([task]) => [
          task,
          Arr.findFirst(views, (view) => view.id === task).pipe(
            Option.map((view) => view.landed),
            Option.getOrUndefined,
          ),
        ]),
      ).toEqual([
        ["task-full", true],
        ["task-short", true],
        ["task-other", false],
        ["task-unknown", false],
        ["task-url", false],
      ]);
    }),
  ));

test("a superseded merge request is settled while its forge reads it closed, and owed again once reopened", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, {
        task: "task-1",
        state: "succeeded",
        branch: "mk/nuxt-ci",
        mr: M,
        finished: "2026-09-14T09:30:00Z",
      });
      yield* recordDisposition(run.dir, {
        at: "2026-09-14T09:40:00Z",
        by: "mk",
        kind: "superseded",
        ref: "support!279",
        note: null,
      });
      const [closed] = yield* board(env, [run], unapproved("closed"));
      expect(closed!.landed).toBe(true);
      expect(closed!.mrs![0]!.settled).toBe("superseded");
      const [reopened] = yield* board(env, [run], unapproved("open"));
      expect(reopened!.landed).toBe(false);
      expect(reopened!.mrs![0]!.settled).toBeNull();
      expect(sectionOf(reopened!)).toBe("waiting");
    }),
  ));

test("a Task with one merge request merged and one open is not landed, and says which is open", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const merged = yield* madeRun(dir, {
        id: "r-merged",
        task: "task-1",
        state: "succeeded",
        branch: "mk/one",
        mr: "https://gitlab.cego.dk/mk/support/-/merge_requests/278",
        created: "2026-09-14T08:00:00Z",
        finished: "2026-09-14T08:30:00Z",
      });
      const open = yield* madeRun(dir, {
        id: "r-open",
        task: "task-1",
        state: "succeeded",
        branch: "mk/nuxt-ci",
        mr: M,
        created: "2026-09-14T08:40:00Z",
        finished: "2026-09-14T09:30:00Z",
      });
      const [card] = yield* board(env, [merged, open], {
        mrStates: new Map<string, MrState>([
          ["gitlab.cego.dk/mk/support!278", "merged"],
          [M_ID, "open"],
        ]),
      });
      expect(card!.landed).toBe(false);
      expect(sectionOf(card!)).toBe("waiting");
      expect(card!.sentence).toBe("1 of 2 merged; support!279 is open.");
    }),
  ));

test("a Task whose leading Run was abandoned is landed while its merge request is still open", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const { first, second } = yield* supersededChain(dir);
      yield* recordDisposition(second.dir, {
        at: "2026-09-14T09:50:00Z",
        by: "mk",
        kind: "abandoned",
        ref: "",
        note: null,
      });
      const [card] = yield* board(env, [first, second], unapproved());
      expect(card!.landed).toBe(true);
      expect(sectionOf(card!)).toBe("finished");
      expect(card!.sentence).toBe("Abandoned.");
      expect(card!.mrs![0]!.settled).toBe("abandoned");
    }),
  ));

test("a Task's card reads its Task: a landed plan and implement Task folds into History", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const fs = yield* FileSystem.FileSystem;
      const plan = yield* madeRun(dir, {
        id: "r-plan",
        workflow: "plan",
        task: "task-1",
        state: "succeeded",
        created: "2026-09-12T08:00:00Z",
        finished: "2026-09-12T08:05:00Z",
      });
      yield* fs.makeDirectory(`${plan.dir}/plan/issues`, { recursive: true });
      yield* fs.writeFileString(`${plan.dir}/plan/issues/01-thing.md`, "# 1\n");
      const implement = yield* madeRun(dir, {
        id: "r-plan.implement",
        task: "task-1",
        parent: "r-plan",
        state: "succeeded",
        branch: "mk/control-plane",
        created: "2026-09-12T08:10:00Z",
        finished: "2026-09-12T08:30:00Z",
      });
      yield* recordDisposition(implement.dir, {
        at: "2026-09-12T09:00:00Z",
        by: "mk",
        kind: "merged",
        ref: "cego/collie#115",
        note: null,
      });

      expect(yield* board(env, [plan, implement])).toEqual([]);
    }),
  ));

test("a Task's card reads its Task: a going child leads its going parent", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const plan = yield* madeRun(dir, {
        id: "r-plan",
        workflow: "plan",
        task: "task-1",
        created: "2026-09-14T08:00:00Z",
      });
      const implement = yield* madeRun(dir, {
        id: "r-plan.implement",
        task: "task-1",
        parent: "r-plan",
        summary: "Building the card",
        created: "2026-09-14T08:10:00Z",
      });

      const [card] = yield* board(env, [plan, implement], { quietMs: Infinity });
      expect(card!.run).toBe("r-plan.implement");
      expect(card!.state).toBe("active");
    }),
  ));

test("a Task's card reads its Task: a parent that went on to its own question still leads it", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const parent = yield* madeRun(dir, {
        id: "r-reviewed",
        task: "task-1",
        state: "waiting",
        asking: [{ name: "sign-off", prompt: "Sign this review off?", options: [] }],
        created: "2026-09-12T08:00:00Z",
      });
      const child = yield* madeRun(dir, {
        id: "r-reviewed.grade-one",
        task: "task-1",
        parent: "r-reviewed",
        state: "succeeded",
        created: "2026-09-12T08:10:00Z",
        finished: "2026-09-12T08:30:00Z",
      });

      const [card] = yield* board(env, [parent, child]);
      expect(card!.run).toBe("r-reviewed");
      expect(sectionOf(card!)).toBe("needs-you");
    }),
  ));

test("a Task's card reads its Task: a parent going on after its children succeeded still leads it", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const parent = yield* madeRun(dir, {
        id: "r-reviewed",
        task: "task-1",
        summary: "Writing the review",
        created: "2026-09-14T08:00:00Z",
      });
      const child = yield* madeRun(dir, {
        id: "r-reviewed.grade-one",
        task: "task-1",
        parent: "r-reviewed",
        state: "succeeded",
        created: "2026-09-14T08:10:00Z",
        finished: "2026-09-14T08:30:00Z",
      });

      const [card] = yield* board(env, [parent, child], { quietMs: Infinity });
      expect(card!.run).toBe("r-reviewed");
      expect(card!.state).toBe("active");
    }),
  ));

test("landed is a disposition, a merge the forge reports, or work with nothing to land", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const issues = Effect.fn("board.issues")(function* (run: RunFacts, count: number) {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${run.dir}/plan/issues`, { recursive: true });
        for (let at = 1; at <= count; at++) {
          yield* fs.writeFileString(`${run.dir}/plan/issues/0${at}-thing.md`, `# ${at}\n`);
        }
        return run;
      });
      const done = (id: string, over: Partial<RunFacts> = {}) =>
        madeRun(dir, { id, task: `t-${id}`, state: "succeeded", ...over });
      const runs = [
        yield* done("review", { workflow: "review" }),
        yield* issues(yield* done("plan", { workflow: "plan" }), 3),
        yield* issues(yield* done("renamed", { workflow: "shape-the-work" }), 2),
        yield* done("empty", { workflow: "plan" }),
        yield* done("merged", { mr: "https://gitlab.cego.dk/mk/collie/-/merge_requests/65" }),
        yield* done("closed", { mr: "https://gitlab.cego.dk/mk/collie/-/merge_requests/66" }),
      ];

      const implementNow = {
        id: "implement-now",
        title: "Implement now",
        workflow: "implement",
        arguments: null,
        kind: "follow-up" as const,
        primary: true,
        unavailable: null,
      };
      const views = yield* board(env, runs, {
        mrStates: new Map([
          ["gitlab.cego.dk/mk/collie!65", "merged"],
          ["gitlab.cego.dk/mk/collie!66", "closed"],
        ]),
        offers: (runId) => Effect.succeed(runId === "plan" ? [implementNow] : []),
      });
      const by = (task: string) =>
        Option.getOrUndefined(Arr.findFirst(views, (view) => view.id === `t-${task}`))!;
      expect(sectionOf(by("review"))).toBe("finished");
      expect(sectionOf(by("empty"))).toBe("finished");
      for (const task of ["plan", "renamed"]) {
        expect([task, sectionOf(by(task))]).toEqual([task, "waiting"]);
        expect([task, by(task).sentence]).toEqual([task, "Plan ready to implement."]);
      }
      expect(by("plan").offer).toEqual({ id: "implement-now", title: "Implement now" });
      expect(by("renamed").offer).toBeNull();
      expect(sectionOf(by("merged"))).toBe("finished");
      expect(sectionOf(by("closed"))).toBe("waiting");
      expect(by("closed").sentence).toBe("Merge request mk/collie!66 closed without merging.");
    }),
  ));

test("a child Run's proposal is its Task's own decision", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const parent = yield* madeRun(dir, {
        id: "r-parent",
        task: "task-1",
        created: "2026-09-14T09:00:00Z",
      });
      const child = yield* madeRun(dir, {
        id: "r-child",
        task: "task-1",
        parent: "r-parent",
        created: "2026-09-14T09:10:00Z",
      });
      const proposal: ProposalLine = {
        kind: "proposal",
        id: "p-child",
        created_at: "2026-09-14T09:00:00Z",
        expires_at: "2026-09-14T11:00:00Z",
        interpretation: "the core run drifted: it is editing docs",
        targets: [{ run: child.id }],
        actions: [{ kind: "stop", run: child.id }],
        allowed_now: [],
        intent_versions: {},
        content_hash: "abc",
        by: "evaluator:call-1",
        state: "pending",
      };

      const views = yield* board(env, [child, parent], { proposals: [proposal] });

      expect(views).toHaveLength(1);
      expect(sectionOf(views[0]!)).toBe("needs-you");
      expect(views[0]!.decision).toMatchObject({ kind: "proposal", id: "p-child" });
    }),
  ));

test("a waiting proposal stays the decision, and the card still lists the questions open", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, {
        task: "task-1",
        state: "waiting",
        asking: [
          { name: "scope", prompt: "Which repository?", options: [{ id: "core", title: "core" }] },
        ],
      });
      const proposal: ProposalLine = {
        kind: "proposal",
        id: "p-1",
        created_at: "2026-09-14T09:00:00Z",
        expires_at: "2026-09-14T11:00:00Z",
        interpretation: "the run drifted: it is editing docs",
        targets: [{ run: run.id }],
        actions: [{ kind: "stop", run: run.id }],
        allowed_now: [],
        intent_versions: {},
        content_hash: "abc",
        by: "evaluator:call-1",
        state: "pending",
      };

      const [view] = yield* board(env, [run], { proposals: [proposal] });

      expect(view!.decision).toMatchObject({ kind: "proposal", id: "p-1" });
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(view!.questions), (present_) =>
            Arr.map(present_, (question) => question.id),
          ),
        ),
      ).toEqual(["scope"]);
    }),
  ));

test("the board reads every Herd's proposals, not only the one its host came from", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, { id: "r1", task: "task-1" });
      const proposal: (id: string) => ProposalLine = (id) => ({
        kind: "proposal",
        id,
        created_at: "2026-09-14T09:00:00Z",
        expires_at: "2026-09-14T11:00:00Z",
        interpretation: "follow up on the review",
        targets: [{ run: run.id }],
        actions: [{ kind: "stop", run: run.id }],
        allowed_now: [],
        intent_versions: {},
        content_hash: "abc",
        by: "evaluator:call-1",
        state: "pending",
      });
      yield* appendProposal("other-session", proposal("p-other"));

      const views = yield* board(env, [run], { proposals: undefined });

      expect(views[0]!.decision).toMatchObject({ kind: "proposal", id: "p-other" });
    }),
  ));

test("Finished is today's work, and older finished Runs are History's", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const today = yield* madeRun(dir, {
        id: "r-today",
        workflow: "review",
        state: "succeeded",
        created: "2026-09-14T09:00:00Z",
        finished: "2026-09-14T09:30:00Z",
      });
      const week = yield* madeRun(dir, {
        id: "r-week",
        workflow: "review",
        state: "succeeded",
        created: "2026-09-07T09:00:00Z",
        finished: "2026-09-07T09:30:00Z",
      });

      const views = yield* board(env, [today, week]);
      const finished = Arr.filter(views, (view) => sectionOf(view) === "finished");

      expect(Arr.map(finished, (view) => view.run)).toEqual([today.id]);
      expect(finishedLabel(finished, false)).toBe("1 finished today");
    }),
  ));

test("a Task named after a filesystem path reads as what the path points at", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, { workflow: "renovate", task: "task-path" });
      const path =
        "/home/mk/work/gitte2/gitlab.cego.dk/cego/npm-packages/eslint-config-nodejs-typescript";

      const [view] = yield* board(env, [run], {
        tasks: [{ ...TASK, id: "task-path", label: path }],
      });
      expect(view!.name).toBe("Renovate");
      expect(view!.project).toBe("eslint-config-nodejs-typescript");
    }),
  ));

test("`collie --json board` prints the TaskView list, from the host's Runs", () =>
  proves(
    "collie-board-cli-",
    (world) =>
      Effect.gen(function* () {
        const started = yield* collie(world, ["run", "start", "plain", "--input", "note=hi"]);
        expect(started.envelope.ok).toBe(true);
        const printed = yield* collie(world, ["board"]);
        yield* stopHost(world.state);
        expect(printed.envelope.ok).toBe(true);
        const tasks = (yield* Schema.decodeUnknownEffect(
          Schema.Struct({ tasks: Schema.Array(Schema.Struct({ name: Schema.String })) }),
        )(printed.envelope.data).pipe(Effect.orDie)).tasks;
        expect(Arr.map(tasks, (one) => one.name)).toEqual(["Hi"]);
      }),
    ["plain.workflow.ts"],
  ));

const threeRepoPlan = Effect.fn("board.threeRepoPlan")(function* (runDir: string, root: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(`${runDir}/plan/issues`, { recursive: true });
  const tickets: Array<[string, string, string]> = [
    ["01-api.md", "api", "None"],
    ["02-web.md", "web", "01"],
    ["03-cli.md", "cli", "02"],
  ];
  for (const [file, repo, blocked] of tickets) {
    yield* fs.makeDirectory(`${root}/${repo}/.git`, { recursive: true });
    yield* fs.writeFileString(
      `${runDir}/plan/issues/${file}`,
      `# ${file}\n\n**Blocked by:** ${blocked}\n\n**Repo:** ${repo}\n`,
    );
  }
});

test("a fan-out's card lists its Repo runs and every repository still to come, by wave", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const root = `${dir}/root`;
      const parent = yield* madeRun(dir, { id: "r-fan", task: "task-1", cwd: root });
      yield* threeRepoPlan(parent.dir, root);
      const api = yield* madeRun(dir, {
        id: "r-api",
        task: "task-1",
        parent: "r-fan",
        repo: "api",
        state: "succeeded",
        mr: "mr:cego/api!4",
      });
      const web = yield* madeRun(dir, {
        id: "r-web",
        task: "task-1",
        parent: "r-fan",
        repo: "web",
      });

      const views = yield* board(env, [web, api, parent]);

      expect(views).toHaveLength(1);
      expect(views[0]!.run).toBe("r-fan");
      expect(views[0]!.children).toEqual([
        { repo: "api", run: "r-api", state: "done", mr: "mr:cego/api!4" },
        { repo: "web", run: "r-web", state: "active", mr: null },
        { repo: "cli", run: null, state: "todo", mr: null },
      ]);
      expect(views[0]!.sentence).toBe("Wave 2 of 3. api landed, web is building, cli is next.");
    }),
  ));

test("a fan-out's card lists each Change run of one repository, by wave", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { dir, env } = yield* scratch();
      const root = `${dir}/root`;
      const parent = yield* madeRun(dir, { id: "r-fan", task: "task-1", cwd: root });
      yield* fs.makeDirectory(`${parent.dir}/plan/issues`, { recursive: true });
      yield* fs.makeDirectory(`${root}/.git`, { recursive: true });
      yield* fs.writeFileString(
        `${parent.dir}/plan/issues/01-api.md`,
        "# 01-api.md\n\n**Blocked by:** None\n\n**Repo:** .\n",
      );
      yield* fs.writeFileString(
        `${parent.dir}/plan/issues/02-schema.md`,
        "# 02-schema.md\n\n**Blocked by:** 01\n\n**Repo:** .\n\n**Change:** schema\n",
      );
      const api = yield* madeRun(dir, {
        id: "r-api",
        task: "task-1",
        parent: "r-fan",
        repo: ".",
        state: "succeeded",
        mr: "mr:cego/api!4",
      });
      const schema = yield* madeRun(dir, {
        id: "r-schema",
        task: "task-1",
        parent: "r-fan",
        repo: ".",
        change: "schema",
      });

      const views = yield* board(env, [schema, api, parent]);

      expect(views[0]!.children).toEqual([
        { repo: ".", run: "r-api", state: "done", mr: "mr:cego/api!4" },
        { repo: ".--schema", run: "r-schema", state: "active", mr: null },
      ]);
    }),
  ));

const GITLAB = (repo: string, iid: number) =>
  `https://gitlab.cego.dk/cego/${repo}/-/merge_requests/${iid}`;
const idOf = (repo: string, iid: number) => `gitlab.cego.dk/cego/${repo}!${iid}`;

const fannedOut = Effect.fn("board.fannedOut")(function* (
  dir: string,
  mrs: ReadonlyArray<readonly [repo: string, iid: number]>,
) {
  const fs = yield* FileSystem.FileSystem;
  const root = `${dir}/root`;
  const parent = yield* madeRun(dir, {
    id: "r-fan",
    task: "task-1",
    cwd: root,
    state: "succeeded",
    created: "2026-09-14T09:00:00Z",
  });
  yield* fs.makeDirectory(`${parent.dir}/plan/issues`, { recursive: true });
  for (const [at, [repo]] of mrs.entries()) {
    yield* fs.makeDirectory(`${root}/${repo}/.git`, { recursive: true });
    yield* fs.writeFileString(
      `${parent.dir}/plan/issues/0${at + 1}-${repo}.md`,
      `# ${repo}\n\n**Blocked by:** ${at === 0 ? "None" : `0${at}`}\n\n**Repo:** ${repo}\n`,
    );
  }
  const children = yield* Effect.forEach(mrs, ([repo, iid], at) =>
    madeRun(dir, {
      id: `r-${repo}`,
      task: "task-1",
      parent: "r-fan",
      repo,
      state: "succeeded",
      mr: GITLAB(repo, iid),
      created: `2026-09-14T09:0${mrs.length - at}:00Z`,
    }),
  );
  return [...children, parent];
});

test("a multi-repository fan-out's card lists each Repo run's merge request by wave, and says the first", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const runs = yield* fannedOut(dir, [
        ["api", 7],
        ["web", 8],
      ]);

      const [view] = yield* board(env, runs);

      expect(Arr.map(view!.mrs ?? [], (one) => [one.id, one.short, one.run])).toEqual([
        [idOf("api", 7), "api!7", "r-api"],
        [idOf("web", 8), "web!8", "r-web"],
      ]);
      expect(view!.mr).toBe(GITLAB("api", 7));
    }),
  ));

test("a Run released with a set of merge requests adds none of its own beside its children's", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const single = (target: string) => ({
        settled: { inputs: { mr: target }, strategies: { mr: "diff-target" as const } },
      });
      const app = `mr:${idOf("app", 12)}`;
      const api = `mr:${idOf("api", 7)}`;
      const runs = [
        yield* madeRun(dir, { id: "r-set", task: "task-1", ...single(`${app} ${api}`) }),
        yield* madeRun(dir, { id: "r-set.app", task: "task-1", parent: "r-set", ...single(app) }),
        yield* madeRun(dir, { id: "r-set.api", task: "task-1", parent: "r-set", ...single(api) }),
      ];

      const [view] = yield* board(env, runs);

      expect(
        Arr.sort(
          Arr.map(view!.mrs ?? [], (one) => one.id),
          Order.String,
        ),
      ).toEqual([idOf("api", 7), idOf("app", 12)]);
    }),
  ));

test("a Task of several merge requests lands once each merged or was disposed of, and nothing is going", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const runs = yield* fannedOut(dir, [
        ["api", 7],
        ["web", 8],
        ["cli", 9],
      ]);
      const states = (api: MrState, web: MrState, cli: MrState) =>
        new Map([
          [idOf("api", 7), api],
          [idOf("web", 8), web],
          [idOf("cli", 9), cli],
        ]);

      const [one] = yield* board(env, runs, { mrStates: states("merged", "open", "open") });
      expect(one!.landed).toBe(false);
      expect(sectionOf(one!)).toBe("waiting");
      expect(one!.sentence).toBe("1 of 3 merged; web!8 is open; cli!9 is open.");

      yield* recordDisposition(`${dir}/runs/r-cli`, {
        at: "2026-09-14T10:00:00Z",
        by: "mk",
        kind: "abandoned",
        ref: "",
        note: null,
      });
      const settled = states("merged", "merged", "closed");
      const [still] = yield* board(
        env,
        Arr.map(runs, (run) => (run.id === "r-web" ? { ...run, state: "running" as const } : run)),
        { mrStates: settled },
      );
      expect(still!.landed).toBe(false);

      const [landed] = yield* board(env, runs, { mrStates: settled });
      expect(landed!.landed).toBe(true);
      expect(sectionOf(landed!)).toBe("finished");
      expect(landed!.sentence).toBe("2 of 3 merged; cli!9 abandoned.");
    }),
  ));

test("a hostless Disposition an earlier host wrote names the merge request of its own Run's checkout, not one of the same path on another host", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { dir, env } = yield* scratch();
      const on = Effect.fn("board.on")(function* (host: string) {
        const cwd = `${dir}/${host}`;
        yield* fs.makeDirectory(cwd, { recursive: true });
        yield* exec(["git", "init", "-q"], { cwd });
        yield* exec(["git", "remote", "add", "origin", `git@${host}:group/app.git`], { cwd });
        return yield* madeRun(dir, {
          id: `r-${host}`,
          task: "task-1",
          cwd,
          state: "succeeded",
          mr: `https://${host}/group/app/-/merge_requests/42`,
        });
      });
      const runs = [yield* on("gitlab-a.example"), yield* on("gitlab-b.example")];
      yield* recordDisposition(runs[0]!.dir, {
        at: "2026-09-14T10:00:00Z",
        by: "gitlab",
        kind: "merged",
        ref: "group/app!42",
        note: null,
      });

      const [view] = yield* board(env, runs);

      expect(
        Arr.sort(
          Arr.map(view!.mrs ?? [], (one) => `${one.id} ${one.disposition}`),
          Order.String,
        ),
      ).toEqual([
        "gitlab-a.example/group/app!42 merged group/app!42",
        "gitlab-b.example/group/app!42 null",
      ]);
    }),
  ));

test("a merge request of several that closed without merging, with nobody saying why, keeps its Task waiting on you by name", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const runs = yield* fannedOut(dir, [
        ["api", 7],
        ["web", 8],
      ]);

      const [view] = yield* board(env, runs, {
        mrStates: new Map<string, MrState>([
          [idOf("api", 7), "merged"],
          [idOf("web", 8), "closed"],
        ]),
      });

      expect(view!.landed).toBe(false);
      expect(sectionOf(view!)).toBe("waiting");
      expect(view!.sentence).toBe("1 of 2 merged; web!8 closed without merging.");
    }),
  ));

test("Ready to release is each merge request's own, at its own head", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const runs = yield* fannedOut(dir, [
        ["api", 7],
        ["web", 8],
      ]);
      const sha = (digit: string) => pipe(digit, Str.repeat(40));
      const [apiHead, webHead, movedHead] = [sha("a"), sha("b"), sha("c")];
      yield* appendVerification(`${dir}/evidence/r-api`, checked("test", apiHead));
      yield* appendVerification(`${dir}/evidence/r-web`, checked("test", webHead));
      const forgeSays = (web: string) =>
        board(env, runs, {
          mrStates: new Map<string, MrState>([
            [idOf("api", 7), "open"],
            [idOf("web", 8), "open"],
          ]),
          forge: new Map([
            [
              idOf("api", 7),
              {
                checks: { state: "passed" as const },
                head: apiHead,
                mergeable: { state: "mergeable" as const, said: "mergeable" },
                read: "2026-09-14T10:04:00Z",
              },
            ],
            [
              idOf("web", 8),
              {
                checks: { state: "passed" as const },
                head: web,
                mergeable: { state: "blocked" as const, said: "not approved" },
              },
            ],
          ]),
        });

      const [approved] = yield* forgeSays(webHead);
      expect(Arr.map(approved!.mrs ?? [], (one) => [one.short, one.ready, one.head])).toEqual([
        ["api!7", true, apiHead],
        ["web!8", false, webHead],
      ]);
      expect(approved!.ready).toBe(true);
      expect(approved!.sentence).toBe("0 of 2 merged; api!7 ready to release; web!8 is open.");

      const [moved] = yield* forgeSays(movedHead);
      expect(Arr.map(moved!.mrs ?? [], (one) => [one.short, one.ready, one.head])).toEqual([
        ["api!7", true, apiHead],
        ["web!8", false, movedHead],
      ]);
    }),
  ));

test("a merge request whose target branch is another's source branch waits on it", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const runs = yield* fannedOut(dir, [
        ["app", 12],
        ["api", 7],
      ]);
      const unchecked = { checks: { state: "unknown" as const }, head: null };

      const [view] = yield* board(env, runs, {
        mrStates: new Map<string, MrState>([
          [idOf("app", 12), "open"],
          [idOf("api", 7), "open"],
        ]),
        forge: new Map([
          [idOf("app", 12), { ...unchecked, source: "mk/app", target: "master" }],
          [idOf("api", 7), { ...unchecked, source: "mk/api", target: "mk/app" }],
        ]),
      });

      expect(Arr.map(view!.mrs ?? [], (one) => [one.short, one.waitsOn])).toEqual([
        ["app!12", []],
        ["api!7", [idOf("app", 12)]],
      ]);
      expect(view!.sentence).toBe("0 of 2 merged; app!12 is open; api!7 waits on app!12.");
    }),
  ));

const waitingForMemory = (runId: string) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* (yield* RunRecords).setControl(
      MEMORY_WAIT,
      runId,
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        what: 'collie verify "unit"',
        sentence: "waiting for memory on vm-mk: 2.1 of 62.0 GB available",
        since: now,
        read: now,
        every: 15_000,
        asker: null,
      }).pipe(Effect.orDie),
      "1-1.json",
    );
  }).pipe(Effect.orDie);

test("a fan-out's card says a Repo run waits for memory", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const root = `${dir}/root`;
      const parent = yield* madeRun(dir, { id: "r-fan", task: "task-1", cwd: root });
      yield* threeRepoPlan(parent.dir, root);
      const web = yield* madeRun(dir, {
        id: "r-web",
        task: "task-1",
        parent: "r-fan",
        repo: "web",
      });
      yield* waitingForMemory(web.id);

      const [view] = yield* board(env, [web, parent]);

      expect(view!.sentence).toBe("Waiting for memory on vm-mk: 2.1 of 62.0 GB available.");
    }),
  ));

test("a finished Run's card says a verify of it waits for memory", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, { id: "r-done", task: "task-1", state: "succeeded" });
      yield* waitingForMemory(run.id);

      const [view] = yield* board(env, [run]);

      expect(view!.sentence).toBe("Waiting for memory on vm-mk: 2.1 of 62.0 GB available.");
    }),
  ));

test("a fan-out's card lists the question each of its Repo runs is waiting on", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const root = `${dir}/root`;
      const parent = yield* madeRun(dir, { id: "r-fan", task: "task-1", cwd: root });
      yield* threeRepoPlan(parent.dir, root);
      const api = yield* madeRun(dir, {
        id: "r-api",
        task: "task-1",
        parent: "r-fan",
        repo: "api",
        state: "waiting",
        asking: [{ name: "api-scope", prompt: "Which endpoints?", options: [] }],
      });
      const web = yield* madeRun(dir, {
        id: "r-web",
        task: "task-1",
        parent: "r-fan",
        repo: "web",
        state: "waiting",
        asking: [{ name: "web-scope", prompt: "Which pages?", options: [] }],
      });

      const [view] = yield* board(env, [api, web, parent]);

      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(view!.questions), (present__) =>
            Arr.map(present__, (question) => [question.run, question.id]),
          ),
        ),
      ).toEqual([
        ["r-api", "api-scope"],
        ["r-web", "web-scope"],
      ]);
      expect(view!.decision).toEqual(view!.questions![0]!);
    }),
  ));

test("a child that is work of its own is its own card, and its parent's card lists no child", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const parent = yield* madeRun(dir, { id: "r-self", task: "task-1" });
      const own = yield* madeRun(dir, {
        id: "r-self.improve",
        task: "task-2",
        parent: "r-self",
        repo: ".",
      });

      const views = yield* board(env, [own, parent]);

      expect(Arr.map(views, (view) => [view.run, view.children])).toEqual([
        ["r-self.improve", []],
        ["r-self", []],
      ]);
    }),
  ));

const startedFromPlan = Effect.fn("board.startedFromPlan")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const root = `${dir}/root`;
  const planner = yield* madeRun(dir, { id: "r-plan", state: "succeeded" });
  const plan = `${planner.dir}/plan`;
  yield* fs.makeDirectory(`${plan}/issues`, { recursive: true });
  yield* fs.writeFileString(`${plan}/SPEC.md`, "# Spec\n");
  const tickets: Array<[string, string, string]> = [
    ["01-api.md", "api", "None"],
    ["02-web.md", "web", "None"],
    ["03-cli.md", "cli", "01"],
  ];
  for (const [file, repo, blocked] of tickets) {
    yield* fs.makeDirectory(`${root}/${repo}/.git`, { recursive: true });
    yield* fs.writeFileString(
      `${plan}/issues/${file}`,
      `# ${file}\n\n**Blocked by:** ${blocked}\n\n**Repo:** ${repo}\n`,
    );
  }
  const parent = yield* madeRun(dir, {
    id: "r-fan",
    workflow: "implement",
    task: "task-1",
    cwd: root,
    settled: { inputs: { plan }, strategies: { plan: "work-source" } },
  });
  return { root, plan, parent };
});

test("a fan-out started from a plan's end menu lists every repository its plan names, by wave", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const { parent } = yield* startedFromPlan(dir);
      const api = yield* madeRun(dir, {
        id: "r-api",
        task: "task-1",
        parent: "r-fan",
        repo: "api",
      });

      const [view] = yield* board(env, [api, parent]);

      expect(view!.children).toEqual([
        { repo: "api", run: "r-api", state: "active", mr: null },
        { repo: "web", run: null, state: "todo", mr: null },
        { repo: "cli", run: null, state: "todo", mr: null },
      ]);
      expect(view!.sentence).toBe("Wave 1 of 2. api is building, web, cli are next.");
    }),
  ));

const oldGate = (run: string) =>
  "nothing is approved for Collie to run, so no command can prove this Run. " +
  `Grant it one with \`collie run intent verification ${run} --name <name> -- <command>\` ` +
  `and \`collie run resume ${run}\`; for Runs started later, add .collie/verify.json, ` +
  "or `collie run intent remember <run>` once a Run has them, for that repository's later Runs, " +
  "or verify.json in your Collie config — a Run reads that file only when it starts";

test("a Repo run parked by the old evidence gate puts no Decision on its fan-out's card", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const fs = yield* FileSystem.FileSystem;
      const { parent, root } = yield* startedFromPlan(dir);
      yield* fs.makeDirectory(`${root}/api/.collie`, { recursive: true });
      yield* fs.writeFileString(
        `${root}/api/.collie/verify.json`,
        '[{"name":"test","executable":"bun","argv":["test"],"cwd":"worktree"}]',
      );
      const api = yield* madeRun(dir, {
        id: "r-api",
        task: "task-1",
        parent: "r-fan",
        repo: "api",
        state: "waiting",
        cwd: `${root}/api`,
        parked: oldGate("r-api"),
      });

      const [view] = yield* board(env, [api, parent]);

      expect(view!.decision).toBeNull();
      expect(view!.sentence).not.toContain("gate");
    }),
  ));

test("the drawer's plan for a Run whose work source is a plan directory, with no kind recorded, is that directory", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir } = yield* scratch();
      const { parent, plan } = yield* startedFromPlan(dir);
      expect(yield* planDirOf(parent)).toBe(plan);
    }),
  ));

test("a fan-out is not quiet while one of its Repo runs works or writes", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const fs = yield* FileSystem.FileSystem;
      const old = "2026-09-14T09:00:00Z";
      const root = `${dir}/root`;
      const parent = yield* madeRun(dir, { id: "r-fan", task: "task-1", cwd: root });
      yield* threeRepoPlan(parent.dir, root);
      const web = yield* madeRun(dir, {
        id: "r-web",
        task: "task-1",
        parent: "r-fan",
        repo: "web",
      });
      const then = DateTime.toDateUtc(DateTime.makeUnsafe(old));
      yield* fs.utimes(`${parent.dir}/plan`, then, then);
      for (const run of [parent, web]) {
        yield* atTime(old, launched(dir, run.id, ["build"]));
      }
      const stateOf = (over: Partial<Parameters<typeof buildBoard>[0]>) =>
        board(env, [web, parent], over).pipe(Effect.map((views) => views[0]!.state));

      expect(yield* stateOf({})).toBe("quiet");
      expect(
        yield* stateOf({
          alive: [agent("impl-web", "working")],
          registered: [registered("impl-web", web.id)],
        }),
      ).toBe("active");
      yield* workedAt(web.id, "2026-09-14T10:04:00Z");
      expect(yield* stateOf({})).toBe("active");
    }),
  ));

test("a held card names who held it and why, from the hold its trail recorded", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, { task: "task-1", held: true });
      const controlled = {
        runId: run.id,
        control: "hold",
        set: true,
        applied: true,
        detail: "",
        left: [],
      };
      yield* recordAudit(run.dir, {
        operation: "hold",
        request: "h-1",
        origin: "chat",
        reason: "waiting for the API freeze",
        result: Controlled,
        value: controlled,
      });

      const [view] = yield* board(env, [run]);

      expect(view!.heldBy).toEqual({ by: "chat", reason: "waiting for the API freeze" });
    }),
  ));

test("a Run parked by the old evidence gate is no Decision, whatever its checkout offers", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const fs = yield* FileSystem.FileSystem;
      const cwd = `${dir}/checkout`;
      yield* fs.makeDirectory(`${cwd}/.collie`, { recursive: true });
      yield* fs.writeFileString(
        `${cwd}/.collie/verify.json`,
        '[{"name":"test","executable":"bun","argv":["test"],"cwd":"worktree"}]',
      );
      const run = yield* madeRun(dir, {
        task: "task-1",
        state: "waiting",
        id: "r-single",
        cwd,
        parked: oldGate("r-single"),
      });

      const [view] = yield* board(env, [run]);

      expect(view!.decision).toBeNull();
      expect(view!.sentence).not.toContain("approve");
    }),
  ));

test("a Run carrying on with an answer says so until it launches anything", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, { task: "task-1" });
      yield* recordAudit(run.dir, {
        operation: "answer",
        request: "a-1",
        origin: "board",
        result: Answered,
        value: { runId: run.id, decision: "scope", value: "core", fresh: true },
      });

      const [view] = yield* board(env, [run]);

      expect(view!.sentence).toBe("Resumed with “core”.");
    }),
  ));

test("a Run nothing drives and no agent works on is abandoned", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const broken = "workflows/plain.workflow.ts does not load: Unexpected token";
      const run = yield* madeRun(dir, { task: "task-1", undriven: true, note: broken });

      const [view] = yield* board(env, [run]);

      expect(view!.state).toBe("abandoned");
      expect(view!.sentence).toStartWith("Its Driver died ");
      expect(view!.sentence).toContain(broken);
    }),
  ));

test("a question outranks a Run nothing drives: it is still waiting on you", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, {
        task: "task-1",
        undriven: true,
        state: "waiting",
        asking: [{ name: "scope", prompt: "Which brands?", options: [] }],
      });

      const [view] = yield* board(env, [run]);

      expect(view!.decision).toMatchObject({ kind: "question" });
      expect(sectionOf(view!)).toBe("needs-you");
    }),
  ));

test("the sections come out in the board's order, and ready work has its own section", () => {
  const views = sortBoard([
    task({ id: "done", state: "done" }),
    task({ id: "working" }),
    task({
      id: "older-ready",
      state: "done",
      landed: false,
      ready: true,
      shipping: "merge",
      ended: 1,
    }),
    task({ id: "recent", state: "done", landed: false, ended: 2 }),
    task({ id: "blocked", state: "blocked", decision: QUESTION }),
  ]);
  expect(Arr.map(views, (view) => view.id)).toEqual([
    "blocked",
    "older-ready",
    "recent",
    "working",
    "done",
  ]);
  expect(Arr.map(SECTIONS, ([section]) => section)).toEqual([
    "needs-you",
    "ready-to-ship",
    "waiting",
    "working",
    "finished",
  ]);
});

const PR = "https://github.com/cego/collie/pull/30";

test("an open merge request says whether it is ready, what failed, and the next move", () => {
  const open = (over: Partial<Sentence>) => sentenceFor(facts({ state: "done", mr: PR, ...over }));
  expect(open({ checks: { state: "passed", at: "1a2b3c4d5e" }, agent: "builder" })).toBe(
    "Ready to release: cego/collie#30 is open and its checks passed at 1a2b3c4. Next: Release, or tell builder to.",
  );
  expect(open({ checks: { state: "passed", at: "1a2b3c4d5e" } })).toBe(
    "Ready to release: cego/collie#30 is open and its checks passed at 1a2b3c4. Next: Release.",
  );
  expect(
    open({
      checks: { state: "failed", name: "lint", at: "1a2b3c4d5e" },
      agent: "builder",
    }),
  ).toBe("cego/collie#30 is open, but lint failed at 1a2b3c4. Next: fix lint, or tell builder to.");
  expect(open({ checks: { state: "unchecked" } })).toBe(
    "cego/collie#30 is open; its checks have not been read.",
  );
  expect(
    open({ checks: { state: "unchecked" }, forge: { checks: { state: "unknown" }, head: null } }),
  ).toBe("cego/collie#30 is open; its checks have not been read.");
  expect(
    open({ checks: { state: "unchecked" }, forge: { checks: { state: "none" }, head: null } }),
  ).toBe("cego/collie#30 is open; its checks have not been read.");
  expect(
    open({
      checks: { state: "unchecked" },
      forge: { checks: { state: "none" }, head: "1a2b3c4d5e" },
    }),
  ).toBe("cego/collie#30 is open; nothing has checked it.");
  expect(
    open({ checks: { state: "unchecked" }, forge: { checks: { state: "passed" }, head: null } }),
  ).toBe("cego/collie#30 is open; its checks have not been read.");
  expect(
    open({
      checks: { state: "unchecked" },
      forge: { checks: { state: "passed" }, head: "1a2b3c4d5e" },
    }),
  ).toBe(
    "cego/collie#30 is open; its checks passed at 1a2b3c4, but Collie has not checked it there.",
  );
});

test.each([
  {
    forge: "gitlab",
    mr: "https://gitlab.cego.dk/mk/collie/-/merge_requests/65",
    label: "mk/collie!65",
    noun: "Merge request",
    running: "its pipeline is still running",
    by: "gitlab",
  },
  {
    forge: "github",
    mr: PR,
    label: "cego/collie#30",
    noun: "Pull request",
    running: "its checks are still running",
    by: "github",
  },
] as const)("a $forge card names its merge request as its forge does", (one) => {
  const done = (over: Partial<Sentence>) =>
    sentenceFor(facts({ state: "done", mr: one.mr, ...over }));
  expect(done({ checks: { state: "passed", at: "1a2b3c4d5e" } })).toBe(
    `Ready to release: ${one.label} is open and its checks passed at 1a2b3c4. Next: Release.`,
  );
  expect(done({ checks: { state: "failed", name: "lint", at: "1a2b3c4d5e" } })).toBe(
    `${one.label} is open, but lint failed at 1a2b3c4. Next: fix lint.`,
  );
  expect(done({ checks: { state: "running" } })).toBe(`${one.label} is open; ${one.running}.`);
  expect(done({ checks: { state: "unchecked" } })).toBe(
    `${one.label} is open; its checks have not been read.`,
  );
  expect(done({ mrState: "closed" })).toBe(`${one.noun} ${one.label} closed without merging.`);
  const merged = (mrState: Sentence["mrState"]) =>
    done({
      mrState,
      disposition: { kind: "merged", ref: one.label, ago: "an hour ago", by: one.by },
    });
  expect(merged("merged")).toBe(`Merged as ${one.label}.`);
  expect(merged("on-stage")).toBe(`Merged as ${one.label}. On stage.`);
  expect(merged("in-prod")).toBe(`Merged as ${one.label}. In production.`);
});

test("a GitHub pull request reads as owner/repo#N, and GitLab labels are unchanged", () => {
  expect(mrLabel(PR)).toBe("cego/collie#30");
  expect(mrLabel("https://gitlab.cego.dk/mk/collie/-/merge_requests/65")).toBe("mk/collie!65");
  expect(mrLabel("mr:gitlab.cego.dk/mk/collie!65")).toBe("mk/collie!65");
});

test("the header names what is ready to release before what else waits on you", () => {
  const views = [
    task({ id: "ready", state: "done", landed: false, ready: true, shipping: "merge" }),
    task({ id: "w1", state: "failed" }),
    task({ id: "w2", state: "done", landed: false }),
    task({ id: "a1" }),
    task({ id: "a2" }),
    task({ id: "a3" }),
  ];
  expect(headerSentence(views).text).toBe(
    "Nothing needs you. 1 ready to ship, 2 waiting on you. 3 working.",
  );
  expect(headerSentence([views[0]!]).text).toBe("Nothing needs you. 1 ready to ship. 0 working.");
});

const checked: (name: string, head: string, result?: "pass" | "fail") => Verification = (
  name,
  head,
  result = "pass",
) => ({
  id: `v-${name}-${head}`,
  run: "r1",
  name,
  executable: "/usr/bin/true",
  argv: [],
  cwd: "/project",
  start: { head_sha: head, fingerprint: "f" },
  end: { head_sha: head, fingerprint: "f" },
  exit: result === "pass" ? 0 : 1,
  seconds: 1,
  expect: "pass",
  tail: { stdout: "", stderr: "" },
  result,
  at: "2026-09-14T09:00:00Z",
  by: "collie",
});

const checkout = Effect.fn("board.checkout")(function* (branch: string) {
  const fs = yield* FileSystem.FileSystem;
  const repo = yield* fs.makeTempDirectoryScoped({ prefix: "collie-board-repo-" });
  const git = (...args: Array<string>) =>
    Effect.promise(() => Bun.$`git ${args}`.cwd(repo).quiet().text());
  yield* git("init", "-q", "-b", branch);
  yield* git(
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "one",
  );
  return { repo, head: Str.trim(yield* git("rev-parse", "HEAD")) };
});

test("a succeeded Run's open merge request is ready only on checks at its branch's head", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const { repo, head } = yield* checkout("mk/ship");
      const run = yield* madeRun(dir, {
        task: "task-1",
        state: "succeeded",
        branch: "mk/ship",
        cwd: repo,
        mr: PR,
        finished: "2026-09-14T09:30:00Z",
      });
      yield* Branches.use((branches) =>
        branches.put(
          new Map([[branchKey(repo, "mk/ship"), { head, project: null, movement: null }]]),
        ),
      );
      const view = Effect.map(board(env, [run]), (views) => views[0]!);

      expect((yield* view).sentence).toBe("cego/collie#30 is open; its checks have not been read.");

      yield* appendVerification(run.evidence, checked("test", "0000000older"));
      expect((yield* view).checks).toEqual({ state: "unchecked" });
      expect((yield* view).ready).toBe(false);

      yield* appendVerification(run.evidence, checked("test", head));
      yield* appendVerification(run.evidence, checked("lint", head, "fail"));
      const red = yield* view;
      expect(red.checks).toEqual({ state: "failed", name: "lint", at: head });
      expect(red.sentence).toBe(
        `cego/collie#30 is open, but lint failed at ${pipe(head, Str.slice(0, 7))}. Next: fix lint.`,
      );

      yield* appendVerification(run.evidence, checked("lint", head));
      const forgeSays = (mergeable: Mergeability) =>
        board(env, [run], {
          alive: [agent("builder", "idle")],
          registered: [registered("builder", run.id)],
          mrStates: new Map([["github.com/cego/collie#30", "open"]]),
          forge: new Map([
            [
              "github.com/cego/collie#30",
              { checks: { state: "passed" }, head, mergeable, read: "2026-09-14T10:04:00Z" },
            ],
          ]),
        });
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr((yield* view).readiness), (present___) =>
            Arr.map(present___.missing, (one) => one.fact),
          ),
        ),
      ).toEqual(["mr-open", "ci", "mergeable"]);
      const green = yield* forgeSays({ state: "mergeable", said: "mergeable" });
      expect(green[0]!.ready).toBe(true);
      expect(green[0]!.readiness).toEqual({ ready: true, missing: [] });
      expect(sectionOf(green[0]!)).toBe("ready-to-ship");
      expect(green[0]!.sentence).toBe(
        `Ready to release: cego/collie#30 is open and its checks passed at ${pipe(head, Str.slice(0, 7))}. Next: Release, or tell builder to.`,
      );
      const unapproved = yield* forgeSays({ state: "blocked", said: "not approved" });
      expect(unapproved[0]!.ready).toBe(false);
      expect(unapproved[0]!.sentence).toBe(
        `cego/collie#30 is open and its checks passed at ${pipe(head, Str.slice(0, 7))}, but the forge says it cannot merge: not approved.`,
      );
    }),
  ));

test("a card says its checks passed where the forge read them, and that Collie has not checked it there", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const { repo, head } = yield* checkout("mk/ship");
      const run = yield* madeRun(dir, {
        task: "task-1",
        state: "succeeded",
        branch: "mk/ship",
        cwd: repo,
        mr: PR,
        finished: "2026-09-14T09:30:00Z",
      });
      yield* Branches.use((branches) =>
        branches.put(
          new Map([[branchKey(repo, "mk/ship"), { head, project: null, movement: null }]]),
        ),
      );
      const forge = (checks: ForgeChecks, at: string | null = head) =>
        new Map([
          [
            "github.com/cego/collie#30",
            {
              checks,
              head: at,
              mergeable: { state: "mergeable" as const, said: "mergeable" },
              read: "2026-09-14T10:04:00Z",
            },
          ],
        ]);
      const seen = (forgeFacts?: ReturnType<typeof forge>) =>
        board(env, [run], {
          mrStates: new Map([["github.com/cego/collie#30", "open"]]),
          ...(forgeFacts === undefined ? {} : { forge: forgeFacts }),
        });

      const [green] = yield* seen(forge({ state: "passed" }));
      expect(green!.sentence).toBe(
        `cego/collie#30 is open; its checks passed at ${pipe(head, Str.slice(0, 7))}, but Collie has not checked it there.`,
      );
      expect(green!.ready).toBe(false);
      expect(Arr.map(green!.readiness!.missing, (one) => one.fact)).toEqual(["checks"]);

      const [unread] = yield* seen();
      expect(unread!.sentence).toBe("cego/collie#30 is open; its checks have not been read.");

      const [none] = yield* seen(forge({ state: "none" }));
      expect(none!.sentence).toBe("cego/collie#30 is open; nothing has checked it.");

      const [unbound] = yield* seen(forge({ state: "none" }, null));
      expect(unbound!.sentence).toBe("cego/collie#30 is open; its checks have not been read.");
    }),
  ));

test("where the branch cannot be read, the newest revision Collie checked counts", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, {
        state: "succeeded",
        branch: "mk/gone",
        cwd: `${dir}/no-such-checkout`,
        mr: PR,
      });
      yield* appendVerification(run.evidence, checked("test", "aaaaaaaold", "fail"));
      yield* appendVerification(run.evidence, checked("test", "bbbbbbbnew"));
      const [view] = yield* board(env, [run]);
      expect(view!.checks).toEqual({ state: "passed", at: "bbbbbbbnew" });
      expect(view!.sentence).toContain("passed at bbbbbbb");
    }),
  ));

const PASS_SENTENCES: Array<[string, Parameters<typeof checkSentence>[0], string]> = [
  [
    "the gate",
    {
      name: "test",
      pass: "gate",
      round: null,
      base: null,
      elapsedMs: 4 * 60_000,
      usualMs: 20 * 60_000,
      others: 0,
    },
    "Running test on the branch, 4 min of a usual 20.",
  ],
  [
    "the baseline, with contention",
    {
      name: "test",
      pass: "baseline",
      round: null,
      base: "master",
      elapsedMs: 12 * 60_000,
      usualMs: 20 * 60_000,
      others: 3,
    },
    "Running test where the branch left master, to see whether it failed before this Run, 12 min of a usual 20. 3 other checks are running.",
  ],
  [
    "a recheck over its usual time",
    {
      name: "test",
      pass: "recheck",
      round: null,
      base: null,
      elapsedMs: 25 * 60_000,
      usualMs: 20 * 60_000,
      others: 1,
    },
    "Running test again on the same tree to rule out a flake, 25 min, longer than the usual 20. 1 other check is running.",
  ],
  [
    "a fix, with nothing to compare against",
    {
      name: "lint",
      pass: "fix",
      round: 1,
      base: null,
      elapsedMs: 30_000,
      usualMs: null,
      others: 0,
    },
    "Running lint after gate fix 1, 30 s.",
  ],
  [
    "the finish",
    {
      name: "test",
      pass: "finish",
      round: null,
      base: null,
      elapsedMs: 90_000,
      usualMs: 40_000,
      others: 0,
    },
    "Running test as the Run finishes, 2 min, longer than the usual 40 s.",
  ],
  [
    "a plain check",
    {
      name: "test",
      pass: "check",
      round: null,
      base: null,
      elapsedMs: null,
      usualMs: null,
      others: 0,
    },
    "Running test.",
  ],
  [
    "a check left to CI",
    {
      name: "nuxi",
      pass: "ci",
      round: null,
      base: null,
      revision: "0123456789abcdef",
      job: "nuxi-typecheck",
      elapsedMs: 3 * 60_000,
      usualMs: null,
      others: 0,
    },
    "Waiting on nuxi's CI job nuxi-typecheck at 0123456789ab, 3 min.",
  ],
];

for (const [form, given, expected] of PASS_SENTENCES) {
  test(`a running check's sentence for ${form}`, () => {
    expect(checkSentence(given)).toBe(expected);
  });
}

const marking = Effect.fn("board.marking")(function* (
  run: RunFacts,
  over: Partial<Parameters<typeof encodeVerifying>[0]> = {},
) {
  yield* (yield* RunRecords).setControl(
    VERIFYING,
    run.id,
    encodeVerifying({
      name: "test",
      executable: "bun",
      argv: ["test"],
      pass: "gate",
      round: null,
      revision: "abc",
      base: null,
      started: "2026-09-14T10:01:00Z",
      ...over,
    }),
  );
});

const took = (run: RunFacts, minutes: number, at: string) =>
  appendVerification(run.evidence, {
    ...checked("test", "abc"),
    id: `v-${run.id}-${at}`,
    run: run.id,
    executable: "/usr/bin/bun",
    argv: ["test"],
    seconds: minutes * 60,
    at,
  });

test("a running check never borrows the round of the agent operation before it", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, { task: "task-1" });
      yield* launched(dir, run.id, ["fix-1"]);
      yield* marking(run, { pass: "recheck" });

      const [view] = yield* board(env, [run]);
      expect(view!.sentence).toBe(
        "Running test again on the same tree to rule out a flake, 4 min.",
      );
      expect(view!.sentence).not.toContain("round");
      expect(view!.check?.pass).toBe("recheck");
    }),
  ));

test("usually is the median of the last five runs of that check in the same repository", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, { task: "task-1" });
      const before = yield* madeRun(dir, {
        id: "r-before",
        state: "succeeded",
        created: "2026-09-13T10:00:00Z",
      });
      const elsewhere = yield* madeRun(dir, {
        id: "r-elsewhere",
        state: "succeeded",
        project: "/elsewhere",
      });
      yield* marking(run);
      const at = (n: number) => `2026-09-13T1${n}:00:00Z`;
      for (const [n, minutes] of [
        [0, 90],
        [1, 1],
        [2, 2],
        [3, 3],
        [4, 4],
        [5, 5],
      ] as const) {
        yield* took(before, minutes, at(n));
      }
      yield* took(elsewhere, 60, at(6));
      yield* appendVerification(before.evidence, {
        ...checked("test", "abc"),
        id: "v-other-args",
        run: before.id,
        executable: "/usr/bin/bun",
        argv: ["test", "--bail"],
        seconds: 90 * 60,
        at: at(7),
      });
      yield* appendVerification(before.evidence, {
        ...checked("test", "abc"),
        id: "v-other-command",
        run: before.id,
        executable: "/usr/bin/npm",
        argv: ["test"],
        seconds: 90 * 60,
        at: at(8),
      });

      const view = Option.getOrUndefined(
        Arr.findFirst(yield* board(env, [run, before, elsewhere]), (one) => one.run === run.id),
      );
      expect(view!.sentence).toBe("Running test on the branch, 4 min, longer than the usual 3.");
    }),
  ));

test("with nothing to compare against, a running check says only how long it has run", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, { task: "task-1" });
      yield* marking(run);
      const [view] = yield* board(env, [run]);
      expect(view!.sentence).toBe("Running test on the branch, 4 min.");
    }),
  ));

test("a running check counts the other checks this host is running", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, { task: "task-1" });
      const a = yield* madeRun(dir, { id: "r-a", task: "t-a" });
      const b = yield* madeRun(dir, { id: "r-b", task: "t-b" });
      for (const one of [run, a, b]) {
        yield* marking(one);
      }
      const view = Option.getOrUndefined(
        Arr.findFirst(yield* board(env, [run, a, b]), (one) => one.run === run.id),
      );
      expect(view!.sentence).toBe("Running test on the branch, 4 min. 2 other checks are running.");
    }),
  ));

test("a Verification recorded before passes were still reads, as a plain check", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir } = yield* scratch();
      const run = yield* madeRun(dir);
      const {
        pass: _pass,
        round: _round,
        ...old
      } = { ...checked("test", "abc"), pass: "gate", round: 1 };
      yield* (yield* RunRecords).append(run.id, "evidence/steering/verifications.jsonl", [
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(old).pipe(Effect.orDie),
      ]);
      const [read] = yield* readVerifications(run.evidence);
      expect(read?.name).toBe("test");
      expect(read?.pass).toBeUndefined();
    }),
  ));

test("`collie --json run checks` lists the running pass and the finished ones", () =>
  proves(
    "collie-run-checks-cli-",
    (world) =>
      Effect.gen(function* () {
        const started = yield* collie(world, ["run", "start", "plain", "--input", "note=hi"]);
        const runId = (yield* Schema.decodeUnknownEffect(Schema.Struct({ runId: Schema.String }))(
          started.envelope.data,
        ).pipe(Effect.orDie)).runId;
        const run = yield* madeRun(world.state, { id: runId });
        yield* appendVerification(run.evidence, {
          ...checked("lint", "abc"),
          run: runId,
          pass: "gate",
        }).pipe(Effect.provide(recordsAt(world.state)));
        yield* hostRunRecords(() => world.state).setControl(
          VERIFYING,
          runId,
          encodeVerifying({
            name: "test",
            executable: "bun",
            argv: ["test"],
            pass: "fix",
            round: 1,
            revision: "abc",
            base: null,
            started: "2026-09-14T10:00:00Z",
          }),
        );

        const listed = yield* collie(world, ["run", "checks", runId]);
        yield* stopHost(world.state);
        expect(listed.envelope.ok).toBe(true);
        expect(listed.envelope.data).toMatchObject({
          run: runId,
          running: { name: "test", pass: "fix", round: 1 },
          done: [{ name: "lint", pass: "gate", result: "pass", revision: "abc" }],
        });
        expect(
          (yield* Schema.decodeUnknownEffect(
            Schema.Struct({ running: Schema.Struct({ sentence: Schema.String }) }),
          )(listed.envelope.data).pipe(Effect.orDie)).running.sentence,
        ).toStartWith("Running test after gate fix 1, ");
      }),
    ["plain.workflow.ts"],
  ));

const steerAt: (at: string, state?: Delivery["state"]) => Delivery = (at, state = "submitted") => ({
  id: `d-${at}`,
  at,
  run: "r1",
  incarnation: "term-builder",
  agent: "builder",
  causal_key: "steer:req-1",
  request_id: "req-1",
  cause: { kind: "steer", ref: "req-1" },
  mode: "now",
  text_hash: "h",
  intent_version: 1,
  attempt: 1,
  state,
});

const reopened = Effect.fn("board.reopened")(function* (
  status: AgentInfo["status"],
  steeredAt = "2026-09-14T10:02:00Z",
  {
    delivered = steerAt(steeredAt),
    ...over
  }: Partial<Parameters<typeof buildBoard>[0]> & {
    delivered?: Delivery;
  } = {},
  passedAt?: string,
) {
  const { dir, env } = yield* scratch();
  const run = yield* madeRun(dir, {
    task: "task-1",
    state: "succeeded",
    mr: "https://github.com/cego/collie/pull/30",
    finished: "2026-09-14T10:00:00Z",
  });
  if (passedAt !== undefined) {
    yield* appendVerification(run.evidence, checked("test", passedAt));
  }
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(`${dir}/agents/${run.id}`, { recursive: true });
  yield* fs.writeFileString(
    `${dir}/agents/${run.id}/agents.log`,
    'builder: told "merge and tag it"\n',
  );
  yield* appendLine(delivered);
  const views = yield* board(env, [run], {
    alive: [agent("builder", status)],
    registered: [registered("builder", run.id)],
    ...over,
  });
  return views[0]!;
}, Effect.provide(memoryRecords));

test("a succeeded Run whose agent works on what it was told after it ended is Working", () =>
  runEffect(
    Effect.gen(function* () {
      const card = yield* reopened("working");
      expect(sectionOf(card)).toBe("working");
      expect(card.sentence).toBe("Working on what you told builder: “merge and tag it”.");
      expect(card.steps).toEqual([{ name: "implement", state: "done" }]);
      expect(card.reopened).toMatchObject({ agent: "builder", status: "working" });
      const said = herdLines([card], epochMs("2026-09-14T10:05:00Z"));
      expect(said).toContain("## Working · 1");
      expect(said).toContain(card.sentence);
    }),
  ));

test("a Reopened Run whose agent is blocked needs you, in that agent's pane", () =>
  runEffect(
    Effect.gen(function* () {
      const card = yield* reopened("blocked");
      expect(sectionOf(card)).toBe("needs-you");
      expect(card.sentence).toBe("Waiting for you in builder's pane.");
    }),
  ));

test("a Reopened Run whose agent is idle again stands on its own facts", () =>
  runEffect(
    Effect.gen(function* () {
      const card = yield* reopened(
        "idle",
        "2026-09-14T10:02:00Z",
        {
          mrStates: new Map([["github.com/cego/collie#30", "open"]]),
          forge: new Map([
            [
              "github.com/cego/collie#30",
              {
                checks: { state: "passed" },
                head: "abc1234def",
                mergeable: { state: "mergeable", said: "mergeable" },
                read: "2026-09-14T10:04:00Z",
              },
            ],
          ]),
        },
        "abc1234def",
      );
      expect(sectionOf(card)).toBe("ready-to-ship");
      expect(card.ready).toBe(true);
      expect(card.sentence).toStartWith("Ready to release: cego/collie#30");
    }),
  ));

test("a steer sent before the Run finished does not reopen it", () =>
  runEffect(
    Effect.gen(function* () {
      const card = yield* reopened("working", "2026-09-14T09:58:00Z");
      expect(card.reopened).toBeNull();
      expect(sectionOf(card)).toBe("waiting");
    }),
  ));

test("`collie run checks --follow` prints a running check's output as it is written, and how it ended", () =>
  proves(
    "collie-run-checks-follow-",
    (world) =>
      Effect.gen(function* () {
        const started = yield* collie(world, ["run", "start", "plain", "--input", "note=hi"]);
        const runId = (yield* Schema.decodeUnknownEffect(Schema.Struct({ runId: Schema.String }))(
          started.envelope.data,
        ).pipe(Effect.orDie)).runId;
        const fs = yield* FileSystem.FileSystem;
        const run = yield* madeRun(world.state, { id: runId });
        const log = `${run.evidence}/checks/unit.log`;
        yield* fs.makeDirectory(`${run.evidence}/checks`, { recursive: true });
        yield* fs.writeFileString(log, "compiling\n");
        const records = hostRunRecords(() => world.state);
        yield* records.setControl(
          VERIFYING,
          runId,
          encodeVerifying({
            name: "unit",
            executable: "bun",
            argv: ["test"],
            pass: "gate",
            round: null,
            revision: "abc",
            base: null,
            started: "2026-09-14T10:00:00Z",
            log,
          }),
        );

        let seen = "";
        const following = yield* Effect.forkChild(
          collie(world, ["run", "checks", runId, "--follow"], {}, (chunk) =>
            Effect.sync(() => {
              seen += chunk;
            }),
          ),
        );
        yield* until(
          () => Effect.succeed(seen),
          (out) => pipe(out, Str.includes("compiling\n")),
        );
        yield* fs.writeFileString(log, "1 pass\n", { flag: "a" });
        yield* until(
          () => Effect.succeed(seen),
          (out) => pipe(out, Str.includes("1 pass\n")),
        );
        yield* appendVerification(run.evidence, {
          ...checked("unit", "abc"),
          run: runId,
          log,
        }).pipe(Effect.provide(recordsAt(world.state)));
        yield* records.setControl(VERIFYING, runId, null);
        const followed = yield* Fiber.join(following);

        const none = yield* collie(world, ["run", "checks", runId, "--follow"]);
        yield* stopHost(world.state);
        expect(followed.stderr).toContain("Running unit on the branch");
        expect(
          Option.getOrElse(pipe(followed.stderr, Str.indexOf("compiling")), () => -1),
        ).toBeLessThan(Option.getOrElse(pipe(followed.stderr, Str.indexOf("1 pass")), () => -1));
        expect(followed.envelope.data).toMatchObject({ ended: { name: "unit", result: "pass" } });
        expect(none.envelope.data).toEqual({ run: runId, ended: null });
      }),
    ["plain.workflow.ts"],
  ));

test("work ready to release is never folded away, however long it has waited", () => {
  const now = epochMs("2026-09-16T12:00:00.000Z");
  const week = 8 * 24 * 60 * 60 * 1000;
  const views = [
    task({
      id: "ready",
      state: "done",
      landed: false,
      ready: true,
      shipping: "merge",
      ended: now - week,
    }),
    task({ id: "stale", state: "failed", ended: now - week }),
  ];
  const { recent, older } = foldWaiting(sectionsOf(views, "").waiting, now);
  expect(Arr.map(recent, (view) => view.id)).toEqual([]);
  expect(Arr.map(sectionsOf(views, "").ready, (view) => view.id)).toEqual(["ready"]);
  expect(Arr.map(older, (view) => view.id)).toEqual(["stale"]);
  expect(headerSentence(views, now).text).toBe("Nothing needs you. 1 ready to ship. 0 working.");
});

test("only a steer herdr took, dated after the Run ended, reopens it", () =>
  runEffect(
    Effect.gen(function* () {
      const at = "2026-09-14T10:02:00Z";
      for (const state of ["reserved", "deferred", "failed", "unknown"] as const) {
        const card = yield* reopened("working", at, { delivered: steerAt(at, state) });
        expect([state, card.reopened]).toEqual([state, null]);
      }
      const step = { ...steerAt(at), cause: { kind: "step" as const, ref: "build" } };
      expect((yield* reopened("working", at, { delivered: step })).reopened).toBeNull();
      expect(
        (yield* reopened("working", at, { delivered: steerAt(at, "acknowledged") })).reopened,
      ).not.toBeNull();
    }),
  ));

test("the forge's pass never stands in for a check of Collie's that has not run", () => {
  const forge = { checks: { state: "passed" as const }, head: "abc" };
  expect(withForge({ state: "unchecked" }, forge)).toEqual({ state: "unchecked" });
  expect(withForge({ state: "passed", at: "abc" }, forge)).toEqual({ state: "passed", at: "abc" });
});

test("an agent's own record of a check never counts toward ready", () => {
  const claimed = { ...checked("test", "abc"), by: "agent" as const };
  expect(checksAt([claimed], "abc")).toEqual({ state: "unchecked" });
  expect(checksAt([claimed, checked("test", "abc")], "abc")).toEqual({
    state: "passed",
    at: "abc",
  });
});

test("a Run's checks are its Intent's as they stand, each passed as the command it names now", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const { repo, head } = yield* checkout("mk/ship");
      const run = yield* madeRun(dir, {
        task: "task-1",
        state: "succeeded",
        branch: "mk/ship",
        cwd: repo,
        mr: PR,
        finished: "2026-09-14T09:30:00Z",
      });
      const spec = (
        name: string,
        executable = "true",
        cwd = "worktree",
        argv: ReadonlyArray<string> = [],
      ) => ({ name, executable, argv, cwd });
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${repo}/packages/b`, { recursive: true });
      yield* updateApproved(run.evidence, () => [spec("test")]);
      const ran = (name: string, result: "pass" | "fail" = "pass") => ({
        ...checked(name, head, result),
        executable: Bun.which("true")!,
        cwd: repo,
      });
      yield* appendVerification(run.evidence, ran("test"));
      const checks = Effect.map(board(env, [run]), (views) => views[0]!.checks);
      expect(yield* checks).toEqual({ state: "passed", at: head });

      const intent = seedIntent(run.id, { runVerification: [spec("test")] });
      const amended = (verification: ReadonlyArray<ReturnType<typeof spec>>) =>
        writeIntent(run.dir, {
          ...intent,
          authority: { ...intent.authority, run_verification: verification },
        });
      yield* amended([spec("test"), spec("typecheck", "true", "worktree", ["typecheck"])]);
      expect(yield* checks).toEqual({ state: "unchecked" });
      yield* amended([spec("test", "false")]);
      expect(yield* checks).toEqual({ state: "unchecked" });
      yield* amended([spec("test", "/opt/new/true")]);
      expect(yield* checks).toEqual({ state: "unchecked" });
      yield* amended([spec("test", "true", "packages/b")]);
      expect(yield* checks).toEqual({ state: "unchecked" });
      yield* appendVerification(run.evidence, { ...ran("lint", "fail"), argv: ["lint"] });
      yield* amended([spec("test")]);
      expect(yield* checks).toEqual({ state: "passed", at: head });
    }),
  ));

test("a Run whose gate relied on an agent's pass of the check's command reads as passed", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const { repo, head } = yield* checkout("mk/ship");
      const run = yield* madeRun(dir, {
        task: "task-1",
        state: "succeeded",
        branch: "mk/ship",
        cwd: repo,
        mr: PR,
        finished: "2026-09-14T09:30:00Z",
      });
      yield* updateApproved(run.evidence, () => [
        { name: "test", executable: "true", argv: [], cwd: "worktree" },
      ]);
      const agents = (name: string, argv: ReadonlyArray<string>) => ({
        ...checked(name, head),
        by: "agent" as const,
        executable: Bun.which("true")!,
        argv: [...argv],
        cwd: repo,
      });
      const checks = Effect.map(board(env, [run]), (views) => views[0]!.checks);
      yield* appendVerification(run.evidence, agents("test", ["--other"]));
      expect(yield* checks).toEqual({ state: "unchecked" });
      yield* appendVerification(run.evidence, agents("true", []));
      expect(yield* checks).toEqual({ state: "passed", at: head });
    }),
  ));

test("following a check hands on each line while the check is still running", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir } = yield* scratch();
      const run = yield* madeRun(dir);
      const fs = yield* FileSystem.FileSystem;
      const log = `${run.evidence}/checks/unit.log`;
      yield* fs.makeDirectory(`${run.evidence}/checks`, { recursive: true });
      yield* fs.writeFileString(log, "");
      yield* marking(run, { log });
      const said: Array<string> = [];
      const following = yield* Effect.forkChild(
        followLog(run, log, (text) => Effect.sync(() => void said.push(text))),
      );

      yield* fs.writeFileString(log, "1 pass\n", { flag: "a" });
      yield* until(
        () => Effect.succeed(Arr.join(said, "")),
        (text) => pipe(text, Str.includes("1 pass")),
      );
      expect(yield* verifyingOf(run.id)).not.toBeNull();

      yield* (yield* RunRecords).setControl(VERIFYING, run.id, null);
      expect(yield* Fiber.join(following)).toBeNull();
      expect(Arr.join(said, "")).toBe("1 pass\n");
    }),
  ));

test("the told line the agents write is the one a Reopened card reads back", () => {
  const log = Arr.join(
    [toldLine("builder", "merge and tag it\nthen release"), toldLine("reviewer", "look")],
    "\n",
  );
  expect(toldIn(log, "builder")).toBe("merge and tag it");
  expect(toldIn(log, "nobody")).toBeNull();
});

test("a hold left on a Run that ended is not drawn: it holds nothing now", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const going = yield* madeRun(dir, { id: "r-going", task: "t-going", held: true });
      const ended = yield* madeRun(dir, {
        id: "r-ended",
        task: "t-ended",
        held: true,
        state: "succeeded",
      });
      const views = yield* board(env, [going, ended]);
      expect(
        Option.getOrUndefined(Arr.findFirst(views, (one) => one.run === "r-going"))!.held,
      ).toBe("⏸ Held.");
      expect(
        Option.getOrUndefined(Arr.findFirst(views, (one) => one.run === "r-ended"))!.held,
      ).toBeNull();
    }),
  ));

test("chat's line for a card names its merge request as the board does", () => {
  const line = (mr: string) => herdLines([task({ id: "r1", state: "done", landed: false, mr })], 0);
  expect(line(PR)).toContain(", pull request cego/collie#30");
  expect(line("https://gitlab.cego.dk/mk/collie/-/merge_requests/65")).toContain(
    ", merge request mk/collie!65",
  );
});

test("chat's line for a card of several merge requests names each, with its state, readiness and wait", () => {
  const entry: (repo: string, iid: number, over: Partial<TaskMr>) => TaskMr = (
    repo,
    iid,
    over,
  ) => ({
    id: idOf(repo, iid),
    mr: GITLAB(repo, iid),
    label: `cego/${repo}!${iid}`,
    short: `${repo}!${iid}`,
    url: GITLAB(repo, iid),
    run: `r-${repo}`,
    state: "open",
    checks: null,
    head: null,
    ready: false,
    disposition: null,
    waitsOn: [],
    ...over,
  });
  const app = entry("app", 12, { ready: true, head: pipe("a", Str.repeat(40)) });
  const api = entry("api", 7, { waitsOn: [app.id] });
  const said = herdLines(
    [task({ id: "r1", state: "done", landed: false, mr: app.mr, mrs: [app, api] })],
    0,
  );
  expect(said).toContain(
    ", merge requests app!12 (open, ready to release at aaaaaaaa); api!7 (open, not ready to release, waits on app!12)",
  );
});

test("two checks with the same command are each passed by a record of that command", () => {
  const command = { executable: "/usr/bin/true", argv: [], cwd: "/project" };
  const both = [
    { name: "unit", ...command },
    { name: "all", ...command },
  ];
  expect(checksAt([checked("unit", "abc"), checked("all", "abc")], "abc", both)).toEqual({
    state: "passed",
    at: "abc",
  });
});

test("an expected failure of a check's command is not a pass, whether it failed or not", () => {
  const unit = [{ name: "unit", executable: "/usr/bin/true", argv: [], cwd: "/project" }];
  const expecting = (result: "pass" | "fail") => ({
    ...checked("unit", "abc", result),
    expect: "fail" as const,
  });
  expect(checksAt([expecting("fail")], "abc", unit)).toEqual({
    state: "failed",
    name: "unit",
    at: "abc",
  });
  expect(checksAt([expecting("pass")], "abc", unit)).toEqual({
    state: "failed",
    name: "unit",
    at: "abc",
  });
});

const declared: (id: string, over?: Partial<StepMeta>) => StepMeta = (id, over = {}) => ({
  id,
  title: id,
  description: "",
  kind: "agent",
  role: null,
  produces: null,
  ...over,
});

const stepsRecorded = Effect.fn("board.stepsRecorded")(function* (
  run: RunFacts,
  path: ReadonlyArray<StepMeta>,
  entered: ReadonlyArray<{ readonly step: StepMeta; readonly left: boolean }>,
) {
  const now = yield* DateTime.now;
  const ago = (ms: number) => DateTime.formatIso(DateTime.subtract(now, { milliseconds: ms }));
  const minutes = 60_000;
  const lines: Array<StepLine> = [
    { kind: "forecast", steps: path, at: ago((entered.length + 1) * 4 * minutes) },
  ];
  Arr.forEach(entered, ({ step, left }, at) => {
    const since = (entered.length - at) * 4 * minutes;
    lines.push({ kind: "enter", key: step.id, step, place: null, at: ago(since) });
    if (left) {
      lines.push({ kind: "leave", key: step.id, at: ago(since - minutes) });
    }
  });
  yield* Effect.forEach(lines, (line) => appendStepLine(run.dir, line));
});

const boardAndFlows = Effect.fn("board.boardAndFlows")(function* (
  env: ReturnType<typeof readEnv>,
  runs: ReadonlyArray<RunFacts>,
  over: Partial<Parameters<typeof buildBoard>[0]> = {},
) {
  const flows = new Map<string, Flow>();
  const views = yield* board(env, runs, { ...over, flows });
  return { views, flow: (task: string) => flows.get(task)! };
});

const BUILD = declared("build");
const SHIP = declared("ship", { produces: "merge-request" });

const deliveryOffers: ReadonlyArray<OfferView> = [
  {
    id: "release",
    title: "Release",
    workflow: "release",
    arguments: null,
    kind: "follow-up",
    primary: true,
    unavailable: null,
  },
  {
    id: "stage",
    title: "Stage",
    workflow: "stage",
    arguments: null,
    kind: "follow-up",
    primary: false,
    unavailable: null,
  },
];

test("an Improvement's finished delivery names Release and Stage on its implement Run, including its Flow", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const improvement = yield* madeRun(dir, {
        id: "improve",
        workflow: "self-improve",
        task: "task-1",
        state: "succeeded",
        created: "2026-09-14T08:00:00Z",
      });
      const plan = yield* madeRun(dir, {
        id: "plan",
        parent: improvement.id,
        workflow: "plan",
        task: "task-1",
        state: "succeeded",
        created: "2026-09-14T08:30:00Z",
        // oxlint-disable-next-line unicorn/no-thenable -- The Workflow's input is named then.
        settled: { inputs: { then: "implement" }, strategies: {}, sources: {} },
      });
      const implement = yield* madeRun(dir, {
        id: "implement",
        parent: plan.id,
        task: "task-1",
        state: "succeeded",
        mr: M,
        created: "2026-09-14T09:00:00Z",
        // oxlint-disable-next-line unicorn/no-thenable -- The Workflow's input is named then.
        settled: { inputs: { then: "finish" }, strategies: {}, sources: {} },
      });
      yield* appendVerification(implement.evidence, checked("test", M_HEAD));
      yield* stepsRecorded(
        implement,
        [BUILD, SHIP],
        [
          { step: BUILD, left: true },
          { step: SHIP, left: true },
        ],
      );
      const { views, flow } = yield* boardAndFlows(env, [implement, plan, improvement], {
        mrStates: new Map([[M_ID, "open"]]),
        forge: new Map([
          [
            M_ID,
            {
              checks: { state: "passed" },
              head: M_HEAD,
              mergeable: { state: "mergeable", said: "approved" },
              read: "2026-09-14T10:04:00Z",
            },
          ],
        ]),
        head: () => Effect.succeed(M_HEAD),
        offers: (run) => Effect.succeed(run === implement.id ? deliveryOffers : []),
      });
      const card = views[0]!;
      expect(primaryAction(card)).toEqual({
        kind: "offer",
        offer: { id: "release", title: "Release", run: implement.id },
      });
      expect(Arr.filter(cardActions(card), (action) => action.kind === "offer")).toEqual([
        { kind: "offer", offer: { id: "release", title: "Release", run: implement.id } },
        { kind: "offer", offer: { id: "stage", title: "Stage", run: implement.id } },
      ]);
      const lane = Option.getOrThrow(
        Arr.findFirst(flow("task-1").lanes, (lane) => lane.run === implement.id),
      );
      expect(lane.nodes.at(-1)).toMatchObject({ id: "offer:release", primary: "start" });
      expect(card.flow?.glyphs.at(-1)?.title).toBe("Release");
      expect(card.sentence).toContain("Next: Release");
    }),
  ));

test("a fan-out lists Release and Stage per Change, with no Offer on its leading Run", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const runs = yield* fannedOut(dir, [
        ["api", 7],
        ["web", 8],
      ]);
      for (const run of Arr.filter(runs, (run) => run.mr !== null)) {
        yield* appendVerification(run.evidence, checked("test", M_HEAD));
      }
      const [card] = yield* board(env, runs, {
        mrStates: new Map([
          [idOf("api", 7), "open"],
          [idOf("web", 8), "open"],
        ]),
        forge: new Map(
          Arr.map(["api", "web"], (repo, at) => [
            idOf(repo, at + 7),
            {
              checks: { state: "passed" as const },
              head: M_HEAD,
              mergeable: { state: "mergeable" as const, said: "approved" },
              read: "2026-09-14T10:04:00Z",
            },
          ]),
        ),
        head: () => Effect.succeed(M_HEAD),
        offers: (run) => Effect.succeed(run === "r-fan" ? [] : deliveryOffers),
      });
      expect(Arr.filter(cardActions(card!), (action) => action.kind === "offer")).toEqual([
        { kind: "offer", offer: { id: "release", title: "Release api!7", run: "r-api" } },
        { kind: "offer", offer: { id: "stage", title: "Stage api!7", run: "r-api" } },
        { kind: "offer", offer: { id: "release", title: "Release web!8", run: "r-web" } },
        { kind: "offer", offer: { id: "stage", title: "Stage web!8", run: "r-web" } },
      ]);
      expect(primaryAction(card!)).toEqual({
        kind: "offer",
        offer: { id: "release", title: "Release", run: "r-api" },
      });
      expect(card!.flow?.glyphs.at(-1)?.title).toBe("Release");
    }),
  ));

test.each([1, 2])(
  "a fan-out's Release stays actionable in its Repo owner's Flow lane (%s repositories)",
  (count) =>
    runEffect(
      Effect.gen(function* () {
        const { dir, env } = yield* scratch();
        const runs = yield* fannedOut(
          dir,
          count === 1
            ? [["api", 7]]
            : [
                ["api", 7],
                ["web", 8],
              ],
        );
        for (const run of Arr.filter(runs, (run) => run.mr !== null)) {
          yield* appendVerification(run.evidence, checked("test", M_HEAD));
        }
        const { flow } = yield* boardAndFlows(env, runs, {
          mrStates: new Map([
            [idOf("api", 7), "open"],
            [idOf("web", 8), "open"],
          ]),
          forge: new Map(
            Arr.map(["api", "web"], (repo, at) => [
              idOf(repo, at + 7),
              {
                checks: { state: "passed" as const },
                head: M_HEAD,
                mergeable: { state: "mergeable" as const, said: "approved" },
                read: "2026-09-14T10:04:00Z",
              },
            ]),
          ),
          head: () => Effect.succeed(M_HEAD),
          offers: (run) => Effect.succeed(run === "r-api" ? deliveryOffers : []),
        });
        const full = flow("task-1");
        const offers = Arr.flatMap(full.lanes, (lane) =>
          Arr.map(
            Arr.filter(lane.nodes, (node) => node.kind === "offer"),
            (node) => ({
              run: lane.run,
              id: node.id,
              primary: node.primary,
            }),
          ),
        );
        expect(offers).toEqual([{ run: "r-api", id: "offer:release", primary: "start" }]);
        expect(
          Arr.flatMap(full.lanes[0]!.nodes, (node) => Arr.map(node.runs, (run) => run.link?.run)),
        ).toContain("r-api");
      }),
    ),
);

test("an attended implement answered Finish keeps named Offers as CI becomes green on the same board", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const implement = yield* madeRun(dir, {
        id: "r-attended",
        task: "task-1",
        state: "succeeded",
        mr: M,
        answered: [{ name: "next", prompt: "What next?", options: [], answer: "finish" }],
      });
      yield* appendVerification(implement.evidence, checked("test", M_HEAD));
      const cards = { revision: () => 1, kept: new Map() };
      const read = (state: "running" | "passed") =>
        board(env, [implement], {
          cards,
          mrStates: new Map([[M_ID, "open"]]),
          forge: new Map([
            [
              M_ID,
              {
                checks: { state },
                head: M_HEAD,
                mergeable: { state: "mergeable", said: "approved" },
                read: "2026-09-14T10:04:00Z",
              },
            ],
          ]),
          head: () => Effect.succeed(M_HEAD),
          offers: () => Effect.succeed(deliveryOffers),
        });
      const [pending] = yield* read("running");
      expect(sectionOf(pending!)).toBe("waiting");
      expect(pending!.sentence).toContain("pipeline is still running");
      expect(Arr.filter(cardActions(pending!), (action) => action.kind === "offer")).toEqual([
        { kind: "offer", offer: { id: "release", title: "Release", run: implement.id } },
        { kind: "offer", offer: { id: "stage", title: "Stage", run: implement.id } },
      ]);
      const [ready] = yield* read("passed");
      expect(sectionOf(ready!)).toBe("ready-to-ship");
      expect(primaryAction(ready!)).toEqual({
        kind: "offer",
        offer: { id: "release", title: "Release", run: implement.id },
      });
    }),
  ));

test("a card keeps unavailable Offers and their host's reasons after the available ones", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const { first, second } = yield* supersededChain(dir);
      for (const [state, reasons] of [
        ["open", ["a Release of this merge request is still going: r-release", null]],
        ["merged", [`${M} is merged`, `${M} is merged`]],
      ] as const) {
        const [card] = yield* board(env, [second, first], {
          mrStates: new Map([[M_ID, state]]),
          offers: (run) =>
            Effect.succeed(
              run === second.id
                ? Arr.map(deliveryOffers, (offer, at) => ({ ...offer, unavailable: reasons[at]! }))
                : [],
            ),
        });
        const offers = Arr.flatMap(cardActions(card!), (action) =>
          action.kind === "offer" ? [action.offer] : [],
        );
        expect(offers).toEqual(
          state === "open"
            ? [
                { id: "stage", title: "Stage", run: second.id },
                { id: "release", title: "Release", run: second.id, unavailable: reasons[0] },
              ]
            : [
                { id: "release", title: "Release", run: second.id, unavailable: reasons[0] },
                { id: "stage", title: "Stage", run: second.id, unavailable: reasons[1] },
              ],
        );
        expect(primaryAction(card!)?.kind).not.toBe("offer");
      }
    }),
  ));

test("a launch from before a Run's Steps is drawn as the Step it was, once", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, { task: "task-1" });
      yield* launched(dir, run.id, ["grill", "spec"]);
      for (const operation of ["grill", "spec"]) {
        yield* recordLaunch({
          agent: `${run.id}-${operation}-r1`,
          output: `${dir}/agents/${run.id}/${operation}.json`,
          reused: false,
          runId: run.id,
          operation,
          role: "planner",
          workflow: "plan",
          harness: "claude",
          model: "opus",
          at: epochMs("2026-09-14T08:00:00Z"),
        });
      }
      const grill = declared("grill", { title: "Grill" });
      yield* stepsRecorded(run, [grill, BUILD], [{ step: grill, left: true }]);
      const { flow } = yield* boardAndFlows(env, [run]);
      const nodes = flow("task-1").lanes[0]!.nodes;
      const names = Arr.map(nodes, (node) => node.id);
      expect(
        Arr.sortWith(
          names,
          (value) => value,
          (a, b) => pipe(a, Str.localeCompare(b)),
        ),
      ).toEqual(["build", "grill", "spec"]);
      expect(
        Option.getOrUndefined(Arr.findFirst(nodes, (node) => node.id === "grill")),
      ).toMatchObject({
        title: "Grill",
        agent: `${run.id}-grill-r1`,
        ranOn: "claude/opus",
      });
    }),
  ));

const waitingIn = (
  setUp: (
    run: RunFacts,
    dir: string,
  ) => Effect.Effect<
    Partial<Parameters<typeof buildBoard>[0]>,
    never,
    FileSystem.FileSystem | Path.Path | RunRecords
  >,
  over: Partial<RunFacts> = {},
) =>
  Effect.gen(function* () {
    const { dir, env } = yield* scratch();
    const run = yield* madeRun(dir, { task: "task-1", ...over });
    yield* stepsRecorded(run, [BUILD, SHIP], [{ step: BUILD, left: false }]);
    const given = yield* setUp(run, dir);
    const { flow } = yield* boardAndFlows(env, [run], given);
    return Arr.map(flow("task-1").lanes[0]!.nodes, (node) => ({
      id: node.id,
      state: node.state,
      wait: node.wait,
      said: node.said,
    }));
  });

const shipExpected = { id: "ship", state: "expected" as const, wait: null, said: null };

test("a proposal waits on the Step in progress, on you", () =>
  runEffect(
    Effect.gen(function* () {
      const nodes = yield* waitingIn((run) =>
        Effect.succeed({
          proposals: [
            {
              kind: "proposal",
              id: "p-1",
              created_at: "2026-09-14T09:00:00Z",
              expires_at: "2026-09-14T11:00:00Z",
              interpretation: "it drifted into the docs",
              targets: [{ run: run.id }],
              actions: [{ kind: "stop", run: run.id }],
              allowed_now: [],
              intent_versions: {},
              content_hash: "abc",
              by: "evaluator:call-1",
              state: "pending",
            },
          ],
        }),
      );
      expect(nodes).toEqual([
        { id: "build", state: "needs-you", wait: "proposal", said: "Collie proposes a correction" },
        shipExpected,
      ]);
    }),
  ));

test("an agent herdr reports blocked is a stalled Step, waiting for you in its pane", () =>
  runEffect(
    Effect.gen(function* () {
      const nodes = yield* waitingIn((run) =>
        Effect.succeed({
          alive: [agent("impl-1", "blocked")],
          registered: [registered("impl-1", run.id)],
        }),
      );
      expect(nodes[0]).toEqual({
        id: "build",
        state: "needs-you",
        wait: "stalled",
        said: "Waiting for you in its pane",
      });
    }),
  ));

test("a Run parked with nothing to answer says why on the Step it parked in", () =>
  runEffect(
    Effect.gen(function* () {
      const nodes = yield* waitingIn(() => Effect.succeed({}), {
        state: "waiting",
        parked: "No Output after 2 h idle",
      });
      expect(nodes[0]).toEqual({
        id: "build",
        state: "needs-you",
        wait: "parked",
        said: "No Output after 2 h idle",
      });
    }),
  ));

test("a hold says who held it, as the card's held line does", () =>
  runEffect(
    Effect.gen(function* () {
      const nodes = yield* waitingIn(
        (run) =>
          recordAudit(run.dir, {
            operation: "hold",
            request: "h-1",
            origin: "chat",
            reason: "",
            result: Controlled,
            value: {
              runId: run.id,
              control: "hold",
              set: true,
              applied: true,
              detail: "",
              left: [],
            },
          }).pipe(Effect.orDie, Effect.as({})),
        { held: true },
      );
      expect(nodes[0]).toEqual({
        id: "build",
        state: "waiting",
        wait: "hold",
        said: "Held by chat",
      });
    }),
  ));

test("a wait for memory names the Machine short of it", () =>
  runEffect(
    Effect.gen(function* () {
      const nodes = yield* waitingIn((run) => waitingForMemory(run.id).pipe(Effect.as({})));
      expect(nodes[0]).toEqual({
        id: "build",
        state: "waiting",
        wait: "memory",
        said: `${machineName()} is short of memory`,
      });
    }),
  ));

test("a wait for usage says whose session resets, and when", () =>
  runEffect(
    Effect.gen(function* () {
      const nodes = yield* waitingIn(() => Effect.succeed({}), {
        usage: { account: "claude", resetsAt: "2026-09-14T15:45:00.000Z" },
      });
      expect(nodes[0]).toEqual({
        id: "build",
        state: "waiting",
        wait: "usage",
        said: "claude's session resets 15:45",
      });
    }),
  ));

test("a check Collie runs says what it is and how long it has run", () =>
  runEffect(
    Effect.gen(function* () {
      const nodes = yield* waitingIn((run) => marking(run).pipe(Effect.orDie, Effect.as({})));
      expect(nodes[0]).toEqual({
        id: "build",
        state: "waiting",
        wait: "check",
        said: "test · 4 min",
      });
    }),
  ));

test("a wait on CI is still running", () =>
  runEffect(
    Effect.gen(function* () {
      const nodes = yield* waitingIn(() => Effect.succeed({}), {
        awaiting: { on: "CI on cego/collie#30", who: null, since: "2026-09-14T10:02:00Z" },
      });
      expect(nodes[0]).toEqual({
        id: "build",
        state: "waiting",
        wait: "ci",
        said: "Still running",
      });
    }),
  ));

test("a Run held between two Steps holds the next path Step, which is waiting", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, { task: "task-1", held: true });
      yield* stepsRecorded(run, [BUILD, SHIP], [{ step: BUILD, left: true }]);
      const { flow } = yield* boardAndFlows(env, [run]);
      expect(
        Arr.map(flow("task-1").lanes[0]!.nodes, (node) => [node.id, node.state, node.wait]),
      ).toEqual([
        ["build", "done", null],
        ["ship", "waiting", "hold"],
      ]);
    }),
  ));

test("the Release row follows a merge request through CI, the merge and the furthest deploy", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, { task: "task-1", state: "succeeded", mr: PR });
      yield* stepsRecorded(
        run,
        [BUILD, SHIP],
        [
          { step: BUILD, left: true },
          { step: SHIP, left: true },
        ],
      );
      const release = (state: MrState, checks: ForgeChecks) =>
        Effect.map(
          boardAndFlows(env, [run], {
            mrStates: new Map([["github.com/cego/collie#30", state]]),
            forge: new Map([["github.com/cego/collie#30", { checks, head: null }]]),
          }),
          ({ flow }) =>
            Arr.map(flow("task-1").release ?? [], (node) => [
              node.title,
              node.state,
              node.wait,
              node.said,
            ]),
        );
      expect(yield* release("open", { state: "running" })).toEqual([
        ["CI", "waiting", "ci", "Still running"],
        ["Merged", "expected", null, null],
      ]);
      expect(yield* release("merged", { state: "passed" })).toEqual([
        ["CI", "done", null, null],
        ["Merged", "done", null, null],
      ]);
      expect(yield* release("in-prod", { state: "passed" })).toEqual([
        ["CI", "done", null, null],
        ["Merged", "done", null, null],
        ["In prod", "done", null, null],
      ]);
      expect((yield* release("closed", { state: "passed" }))[1]).toEqual([
        "Merged",
        "stopped",
        null,
        "Closed without merging",
      ]);
    }),
  ));

test("a fan-out's Flow has a release row per merge request, by wave, its release row the first", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const runs = yield* fannedOut(dir, [
        ["api", 7],
        ["web", 8],
      ]);

      const { flow } = yield* boardAndFlows(env, runs, {
        mrStates: new Map<string, MrState>([
          [idOf("api", 7), "merged"],
          [idOf("web", 8), "open"],
        ]),
        forge: new Map([[idOf("web", 8), { checks: { state: "running" as const }, head: null }]]),
      });

      const fan = flow("task-1");
      expect(
        Arr.map(fan.releases ?? [], (row) => [
          row.mr,
          Arr.map(row.nodes, (node) => [node.title, node.state, node.url]),
        ]),
      ).toEqual([
        [
          idOf("api", 7),
          [
            ["CI", "done", undefined],
            ["Merged", "done", GITLAB("api", 7)],
          ],
        ],
        [
          idOf("web", 8),
          [
            ["CI", "waiting", undefined],
            ["Merged", "expected", GITLAB("web", 8)],
          ],
        ],
      ]);
      expect(fan.release).toEqual(fan.releases![0]!.nodes);

      const alone = yield* madeRun(dir, {
        id: "r-alone",
        task: "task-2",
        state: "succeeded",
        mr: PR,
      });
      const single = yield* boardAndFlows(env, [alone], {
        tasks: [TASK, { ...TASK, id: "task-2" }],
      });
      expect(single.flow("task-2").release).not.toBeNull();
      expect(single.flow("task-2").releases).toBeUndefined();
    }),
  ));

test("the Step that made an open merge request says what Ready to release still lacks", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const { repo, head } = yield* checkout("mk/ship");
      const run = yield* madeRun(dir, {
        task: "task-1",
        state: "succeeded",
        branch: "mk/ship",
        cwd: repo,
        mr: PR,
        finished: "2026-09-14T09:30:00Z",
      });
      yield* stepsRecorded(
        run,
        [BUILD, SHIP],
        [
          { step: BUILD, left: true },
          { step: SHIP, left: true },
        ],
      );
      yield* appendVerification(run.evidence, checked("test", head));
      const { views, flow } = yield* boardAndFlows(env, [run], {
        mrStates: new Map([["github.com/cego/collie#30", "open"]]),
        forge: new Map([
          [
            "github.com/cego/collie#30",
            {
              checks: { state: "passed" },
              head,
              mergeable: { state: "blocked", said: "not approved" },
            },
          ],
        ]),
      });
      const [missing] = views[0]!.readiness!.missing;
      expect(missing!.fact).toBe("mergeable");
      expect(
        Option.getOrUndefined(
          Arr.findFirst(flow("task-1").lanes[0]!.nodes, (node) => node.id === "ship"),
        )!.said,
      ).toBe(missing!.said);
    }),
  ));

test("a finished Run's primary offer ends its row until a Run is started from it", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const fs = yield* FileSystem.FileSystem;
      const plan = yield* madeRun(dir, {
        id: "plan",
        workflow: "plan",
        task: "task-1",
        state: "succeeded",
        created: "2026-09-14T09:00:00Z",
      });
      yield* fs.makeDirectory(`${plan.dir}/plan/issues`, { recursive: true });
      yield* fs.writeFileString(`${plan.dir}/plan/issues/01-thing.md`, "# 1\n");
      yield* stepsRecorded(plan, [BUILD], [{ step: BUILD, left: true }]);
      const offers = () =>
        Effect.succeed([
          {
            id: "implement-now",
            title: "Implement now",
            workflow: "implement",
            arguments: null,
            kind: "follow-up" as const,
            primary: true,
            unavailable: null,
          },
        ]);
      const offered = yield* boardAndFlows(env, [plan], { offers });
      expect(offered.flow("task-1").lanes[0]!.nodes.at(-1)).toMatchObject({
        id: "offer:implement-now",
        kind: "offer",
        title: "Implement now",
        state: "expected",
        said: "Offered",
      });

      const implement = yield* madeRun(dir, {
        id: "implement",
        task: "task-1",
        parent: "plan",
        created: "2026-09-14T10:00:00Z",
      });
      const taken = yield* boardAndFlows(env, [implement, plan], { offers });
      const lane = Option.getOrUndefined(
        Arr.findFirst(taken.flow("task-1").lanes, (one) => one.run === "plan"),
      )!;
      expect(Arr.map(lane.nodes, (node) => node.kind)).toEqual(["agent"]);
    }),
  ));

test("a card's strip is its leading Run's Steps, then the Release row, and where the work is", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const plan = yield* madeRun(dir, {
        id: "plan",
        workflow: "plan",
        task: "task-1",
        state: "succeeded",
        created: "2026-09-14T09:00:00Z",
      });
      yield* stepsRecorded(plan, [declared("spec")], [{ step: declared("spec"), left: true }]);
      const build = yield* madeRun(dir, {
        id: "build",
        task: "task-1",
        parent: "plan",
        created: "2026-09-14T10:00:00Z",
        mr: PR,
      });
      yield* stepsRecorded(build, [BUILD, SHIP], [{ step: BUILD, left: false }]);
      const { views, flow } = yield* boardAndFlows(env, [build, plan], {
        mrStates: new Map([["github.com/cego/collie#30", "open"]]),
        forge: new Map([
          ["github.com/cego/collie#30", { checks: { state: "running" }, head: null }],
        ]),
      });
      const whole = flow("task-1");
      expect(Arr.map(whole.lanes, (lane) => lane.run)).toEqual(["plan", "build"]);
      expect(whole.current).toEqual({ run: "build", node: "build" });
      expect(views[0]!.flow).toEqual({
        glyphs: [
          { title: "build", state: "running" },
          { title: "ship", state: "expected" },
          { title: "CI", state: "waiting" },
          { title: "Merged", state: "expected" },
        ],
        release: 2,
        current: { title: "build", said: "4 min" },
      });
    }),
  ));

test.each([false, true])("a fan-out's Repo runs appear once, by Wave (item calls: %s)", (items) =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const fs = yield* FileSystem.FileSystem;
      const root = `${dir}/root`;
      const parent = yield* madeRun(dir, { id: "r-fan", task: "task-1", cwd: root });
      yield* fs.makeDirectory(`${parent.dir}/plan/issues`, { recursive: true });
      for (const [file, repo, blocked] of [
        ["01-a.md", "a", "None"],
        ["02-b.md", "b", "None"],
        ["03-c.md", "c", "01, 02"],
      ] as const) {
        yield* fs.makeDirectory(`${root}/${repo}/.git`, { recursive: true });
        yield* fs.writeFileString(
          `${parent.dir}/plan/issues/${file}`,
          `# ${file}\n\n**Blocked by:** ${blocked}\n\n**Repo:** ${repo}\n`,
        );
      }
      const fan = declared("fan", { kind: "workflow" });
      const startedIn: Array<StepLine> = items
        ? [
            { kind: "forecast", steps: [fan], at: "2026-09-14T10:00:00.000Z" },
            {
              kind: "enter",
              key: "fan@a",
              step: fan,
              place: { item: "a", items: ["a", "b", "c"] },
              at: "2026-09-14T10:01:00.000Z",
            },
            { kind: "child", key: "fan@a", run: "r-a", at: "2026-09-14T10:01:10.000Z" },
            {
              kind: "enter",
              key: "fan@b",
              step: fan,
              place: { item: "b", items: ["a", "b", "c"] },
              at: "2026-09-14T10:01:15.000Z",
            },
            { kind: "child", key: "fan@b", run: "r-b", at: "2026-09-14T10:01:20.000Z" },
          ]
        : [
            { kind: "forecast", steps: [fan], at: "2026-09-14T10:00:00.000Z" },
            { kind: "enter", key: "fan", step: fan, place: null, at: "2026-09-14T10:01:00.000Z" },
            { kind: "child", key: "fan", run: "r-a", at: "2026-09-14T10:01:10.000Z" },
            { kind: "child", key: "fan", run: "r-b", at: "2026-09-14T10:01:20.000Z" },
          ];
      yield* Effect.forEach(startedIn, (line) => appendStepLine(parent.dir, line));
      const repoRun = (id: string, repo: string, over: Partial<RunFacts> = {}) =>
        madeRun(dir, { id, task: "task-1", parent: "r-fan", repo, ...over });
      const runsOf = (flow: Flow) =>
        Arr.map(flow.lanes[0]!.nodes[0]!.runs, (one) => ({
          title: one.title,
          wave: one.wave,
          run: one.link?.run ?? null,
          state: one.state,
        }));

      const building = yield* boardAndFlows(env, [
        yield* repoRun("r-b", "b"),
        yield* repoRun("r-a", "a"),
        parent,
      ]);
      expect(building.flow("task-1").lanes).toHaveLength(1);
      expect(runsOf(building.flow("task-1"))).toEqual([
        { title: "a", wave: 1, run: "r-a", state: "running" },
        { title: "b", wave: 1, run: "r-b", state: "running" },
        { title: "c", wave: 2, run: null, state: "expected" },
      ]);

      const merged = yield* boardAndFlows(
        env,
        [
          yield* repoRun("r-b", "b"),
          yield* repoRun("r-a", "a", { state: "succeeded", mr: "mr:gitlab.cego.dk/cego/a!12" }),
          parent,
        ],
        { mrStates: new Map([["gitlab.cego.dk/cego/a!12", "merged"]]) },
      );
      expect(merged.flow("task-1").lanes[0]!.nodes[0]!.runs[0]!.said).toBe("!12 merged");
    }),
  ),
);

test("a Task whose Runs were stopped is not waiting on you, though an earlier one stopped at its question", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const next = {
        name: "next",
        prompt: "What next?",
        options: [
          { id: "Finish", title: "Finish" },
          { id: "Release", title: "Release" },
        ],
      };
      const engineView: (runId: string, over: Partial<RunView>) => RunView = (runId, over) => ({
        runId,
        workflow: "implement",
        project: "/project",
        task: "task-1",
        parent: null,
        registration: "implement@1",
        entry: "/project/.collie/workflows/implement.workflow.ts",
        input: {},
        provenance: {},
        strategies: {},
        options: {},
        cwd: "/project",
        branch: null,
        workspace: null,
        worktree: null,
        outcome: "unspecified",
        created: "2026-09-14T09:00:00Z",
        status: { status: "suspended" },
        waiting: [],
        controls: [],
        diagnostic: null,
        parked: null,
        awaiting: null,
        mr: null,
        landing: null,
        ...over,
      });
      const facts = (view: RunView) => madeRun(dir, factsOfView(dir, view));
      const runs = [
        yield* facts(engineView("r-old", { workflow: "plan", created: "2026-09-14T09:00:00Z" })),
        yield* facts(
          engineView("r-old.implement", {
            parent: "r-old",
            created: "2026-09-14T09:10:00Z",
            controls: ["stop"],
            waiting: [{ ...next, answer: null }],
          }),
        ),
        yield* facts(engineView("r-new", { workflow: "plan", created: "2026-09-14T09:20:00Z" })),
        yield* facts(
          engineView("r-new.implement", {
            parent: "r-new",
            created: "2026-09-14T09:30:00Z",
            controls: ["stop"],
            waiting: [{ ...next, answer: "Finish" }],
          }),
        ),
      ];

      const [card] = yield* board(env, runs, { quietMs: Infinity });
      expect(card!.run).toBe("r-new.implement");
      expect(card!.state).toBe("stopped");
      expect(sectionOf(card!)).not.toBe("needs-you");
    }),
  ));
