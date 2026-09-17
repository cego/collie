// The board's model: one TaskView per Task, and the one sentence a card says about it.
//
// The formatter is pure and table-driven, because the sentence is the whole of what a
// human reads on a card — a form nobody has a case for is a form nobody can trust.

import { expect, test } from "bun:test";
import { Clock, Effect, FileSystem, Path, Schema } from "effect";
import {
  boardLines,
  buildBoard,
  finishedLabel,
  headerSentence,
  foldWaiting,
  heldLine,
  matchesTask,
  sectionOf,
  sectionsOf,
  sentenceFor,
  whereItIs,
  workingLabel,
  type Sentence,
  type TaskView,
} from "../src/board";
import { recordDisposition } from "../src/disposition";
import { RUNNER_PID, writeChoice } from "../src/driver";
import type { ProposalLine } from "../src/proposals";
import { RunStore, type Run } from "../src/run";
import { writeTask } from "../src/task";
import { runEffect } from "./support/effect";
import { untilFrom } from "../src/time";

function facts(over: Partial<Sentence> = {}): Sentence {
  return {
    state: "active",
    decision: null,
    step: { id: "build", round: null },
    verb: null,
    silent: null,
    wave: null,
    failure: null,
    note: null,
    resumed: null,
    disposition: null,
    mr: null,
    abandoned: null,
    planReady: false,
    mrState: null,
    ...over,
  };
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
    "gate",
    facts({
      state: "blocked",
      decision: { kind: "gate", run: "r1", id: "g1", step: "review", verifications: ["bun test"] },
    }),
    "Holding at the review gate until you approve the list.",
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
    "Finished; mk/collie!65 is open.",
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

// The builder, against run dirs on disk: what a Task is, which Runs make one up, and
// where its pipeline has got to. Tasks and Runs only — no pane, no renderer.

/** The envelope `collie --json board` writes, as much of it as this test reads. */
const BoardEnvelope = Schema.fromJsonString(
  Schema.Struct({
    ok: Schema.Boolean,
    data: Schema.Struct({
      tasks: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          state: Schema.String,
          sentence: Schema.String,
          steps: Schema.Array(Schema.Struct({ name: Schema.String })),
        }),
      ),
    }),
  }),
);

const stateDir = Effect.fn("board.stateDir")(function* () {
  return yield* (yield* FileSystem.FileSystem).makeTempDirectory({ prefix: "collie-board-" });
});

const seed = Effect.fn("board.seed")(function* (opts: {
  stateDir: string;
  workflow: string;
  steps: string[];
  task?: string | null;
  label?: string;
  status?: Run["record"]["status"];
  createdAt?: string;
  /** `false` for an implement with no checkout, which is what an ended one has nothing to file for. */
  branch?: boolean;
}) {
  const run = yield* new RunStore(opts.stateDir).create({
    workflow: opts.workflow,
    cwd: "/project",
    session: null,
    workspace: "w1",
    workspaceLabel: opts.label ?? "collie | Control plane",
    inputs: {},
    inputSources: {},
    stepIds: opts.steps,
    maxIterations: 4,
    namedAfter: "control-plane",
    // An implement works in a checkout of its own, so the fixture has one unless a test
    // is about the Run that never got that far.
    worktree:
      opts.workflow === "implement" && opts.branch !== false
        ? {
            path: "/project/.worktrees/control-plane",
            branch: "mk/control-plane",
            created_by_collie: true,
            managed_by: "git",
            workspace_id: null,
            made_at: null,
            root_tab_id: null,
            root_pane_id: null,
          }
        : null,
  });
  run.record.task = opts.task ?? null;
  run.record.status = opts.status ?? "running";
  if (opts.createdAt) run.record.created_at = opts.createdAt;
  yield* run.save();
  return run;
});

test("a Task's Runs are one card, and a Run with no Task is its own", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* stateDir();
      yield* writeTask(dir, {
        id: "task-1",
        workspace: "w1",
        label: "collie | Control plane",
        cwd: "/project",
        created_at: "2026-09-14T09:00:00Z",
      });
      yield* seed({
        stateDir: dir,
        workflow: "plan",
        steps: ["grill", "spec"],
        task: "task-1",
        status: "done",
        createdAt: "2026-09-14T09:00:00Z",
      });
      yield* seed({
        stateDir: dir,
        workflow: "implement",
        steps: ["build", "review", "fix", "mr"],
        task: "task-1",
        createdAt: "2026-09-14T10:00:00Z",
      });
      yield* seed({ stateDir: dir, workflow: "review", steps: ["review"], label: "spilnu" });

      const board = yield* buildBoard({ stateDir: dir, now: Date.parse("2026-09-14T10:05:00Z") });

      expect(board).toHaveLength(2);
      const task = board.find((view) => view.id === "task-1")!;
      expect(task.name).toBe("Control plane");
      expect(task.project).toBe("collie");
      expect(task.runs).toHaveLength(2);
      // The Run with no Task keeps the workspace as its project and names itself.
      const alone = board.find((view) => view.id !== "task-1")!;
      expect(alone.project).toBe("spilnu");
      expect(alone.runs).toHaveLength(1);
    }),
  ));

test("the pipeline is the Task's Runs' steps in order, each shown once", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* stateDir();
      const plan = yield* seed({
        stateDir: dir,
        workflow: "plan",
        steps: ["grill", "spec"],
        task: "task-1",
        status: "done",
        createdAt: "2026-09-14T09:00:00Z",
      });
      for (const step of plan.record.steps) step.status = "done";
      yield* plan.save();

      const build = yield* seed({
        stateDir: dir,
        workflow: "implement",
        steps: ["build", "review", "fix", "mr"],
        task: "task-1",
        createdAt: "2026-09-14T10:00:00Z",
      });
      build.step("build").status = "done";
      // The loop has been round twice; the record keeps one entry for the step either way.
      build.step("review").status = "running";
      build.step("review").iteration = 3;
      yield* build.save();

      const board = yield* buildBoard({ stateDir: dir, now: Date.parse("2026-09-14T10:05:00Z") });

      expect(board[0]!.steps).toEqual([
        { name: "grill", state: "done" },
        { name: "spec", state: "done" },
        { name: "build", state: "done" },
        { name: "review", state: "active" },
        { name: "fix", state: "todo" },
        { name: "mr", state: "todo" },
      ]);
      expect(board[0]!.sentence).toBe("Reviewing, round 3 of 4.");
    }),
  ));

test("a question puts the Task in Needs you and blocks the step it is asked from", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* stateDir();
      const run = yield* seed({
        stateDir: dir,
        workflow: "implement",
        steps: ["build", "review"],
        task: "task-1",
      });
      yield* writeChoice(run.dir, {
        id: "c1",
        kind: "menu",
        run: run.id,
        step: "review",
        header: "the failing specs",
        footer: "",
        items: [{ id: "pin", title: "Pin the CI image" }],
      });

      const board = yield* buildBoard({ stateDir: dir, now: Date.parse("2026-09-14T10:05:00Z") });

      expect(board[0]!.state).toBe("blocked");
      expect(sectionOf(board[0]!)).toBe("needs-you");
      expect(board[0]!.sentence).toBe("Waiting on your answer about the failing specs.");
      expect(board[0]!.steps).toContainEqual({ name: "review", state: "blocked" });
      expect(board[0]!.decision).toMatchObject({ kind: "question", id: "c1", run: run.id });
    }),
  ));

test("a gate is a decision card of its own, with the list it is about", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* stateDir();
      const run = yield* seed({
        stateDir: dir,
        workflow: "implement",
        steps: ["build", "mr"],
        task: "task-1",
      });
      yield* writeChoice(run.dir, {
        id: "g1",
        kind: "gate",
        run: run.id,
        step: "mr",
        header: "Approve what proves this run: tests, lint",
        footer: "",
        items: [
          { id: "approve", title: "Approve" },
          { id: "skip", title: "Skip" },
        ],
        verifications: ["tests", "lint"],
      });

      const board = yield* buildBoard({ stateDir: dir, now: Date.parse("2026-09-14T10:05:00Z") });

      expect(board[0]!.state).toBe("blocked");
      expect(sectionOf(board[0]!)).toBe("needs-you");
      expect(board[0]!.sentence).toBe("Holding at the mr gate until you approve the list.");
      expect(board[0]!.decision).toEqual({
        kind: "gate",
        run: run.id,
        id: "g1",
        step: "mr",
        verifications: ["tests", "lint"],
      });
    }),
  ));

test("a plan that spans repositories is one card with its repositories as children", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* stateDir();
      const core = yield* seed({
        stateDir: dir,
        workflow: "implement",
        steps: ["build"],
        status: "done",
        createdAt: "2026-09-14T09:10:00Z",
      });
      const tiger = yield* seed({
        stateDir: dir,
        workflow: "implement",
        steps: ["build"],
        createdAt: "2026-09-14T09:20:00Z",
      });
      const parent = yield* seed({
        stateDir: dir,
        workflow: "plan",
        steps: ["tickets", "next"],
        createdAt: "2026-09-14T09:00:00Z",
      });
      parent.record.fanout = {
        step: "next",
        title: "Build every repository",
        waves: [["frontend-core"], ["happytiger"], ["spilnu"]],
        runs: { "frontend-core": core.id, happytiger: tiger.id },
        mrs: { "frontend-core": "core!2571" },
        wave: 2,
        blocked: null,
      };
      yield* parent.save();

      const board = yield* buildBoard({ stateDir: dir, now: Date.parse("2026-09-14T09:25:00Z") });

      expect(board).toHaveLength(1);
      expect(board[0]!.children).toEqual([
        { repo: "frontend-core", run: core.id, state: "done", mr: "core!2571" },
        { repo: "happytiger", run: tiger.id, state: "active", mr: null },
        { repo: "spilnu", run: null, state: "todo", mr: null },
      ]);
      expect(board[0]!.sentence).toBe(
        "Wave 2 of 3. frontend-core landed, happytiger is building, spilnu is next.",
      );
    }),
  ));

test("the board is ordered by section, then by state", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* stateDir();
      yield* seed({ stateDir: dir, workflow: "implement", steps: ["build"], status: "done" });
      yield* seed({ stateDir: dir, workflow: "implement", steps: ["build"] });
      // Not backdated: a Choice is only answerable while a Driver could still claim the
      // Run, which is what keeps the board from offering an answer nothing will read.
      const asking = yield* seed({ stateDir: dir, workflow: "implement", steps: ["build"] });
      yield* writeChoice(asking.dir, {
        id: "c1",
        kind: "menu",
        run: asking.id,
        step: "build",
        header: "what next",
        footer: "",
        items: [],
      });

      const board = yield* buildBoard({ stateDir: dir });

      // An implement that succeeded and nobody disposed of is waiting on you, not finished.
      expect(board.map((view) => view.state)).toEqual(["blocked", "active", "done"]);
      expect(board.map(sectionOf)).toEqual(["needs-you", "working", "waiting"]);
    }),
  ));

test("what became of the work is the disposition's answer and nobody else's", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* stateDir();
      const run = yield* seed({
        stateDir: dir,
        workflow: "implement",
        steps: ["build"],
        status: "done",
        createdAt: "2026-09-14T08:00:00Z",
      });
      run.record.mr_url = "content!1";
      yield* run.save();

      const now = Date.parse("2026-09-14T10:00:00Z");
      const before = yield* buildBoard({ stateDir: dir, now });
      // A merge request nobody has said landed is not a merge, but it is news.
      expect(before[0]!.sentence).toBe("Finished; content!1 is open.");

      yield* recordDisposition(run.dir, {
        at: "2026-09-14T09:00:00Z",
        by: "mk",
        kind: "merged",
        ref: "content!1",
        note: null,
      });
      const after = yield* buildBoard({ stateDir: dir, now });
      expect(after[0]!.sentence).toBe("Merged as content!1 1 hour ago.");
      expect(after[0]!.disposition).toBe("merged content!1");
    }),
  ));

test("`collie --json board` prints the TaskView list", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectory({ prefix: "collie-board-cli-" });
      const state = path.join(home, "state");
      yield* fs.makeDirectory(path.join(home, "config"), { recursive: true });
      const run = yield* seed({ stateDir: state, workflow: "implement", steps: ["build", "mr"] });
      run.step("build").status = "done";
      run.step("mr").status = "running";
      yield* run.save();

      const root = new URL("../", import.meta.url).pathname;
      const proc = Bun.spawn(
        [Bun.argv[0] ?? "bun", path.join(root, "src/main.ts"), "--json", "board"],
        {
          cwd: root,
          env: {
            HERDR_PLUGIN_ROOT: root,
            HERDR_PLUGIN_CONFIG_DIR: path.join(home, "config"),
            HERDR_PLUGIN_STATE_DIR: state,
            HOME: home,
            PWD: root,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const stdout = yield* Effect.promise(() => new Response(proc.stdout).text());
      yield* Effect.promise(() => proc.exited);
      yield* fs.remove(home, { recursive: true, force: true });

      const envelope = yield* Schema.decodeUnknownEffect(BoardEnvelope)(stdout);
      expect(envelope.ok).toBe(true);
      expect(envelope.data.tasks).toHaveLength(1);
      expect(envelope.data.tasks[0]!.id).toBe(run.id);
      expect(envelope.data.tasks[0]!.sentence).toBe("Opening the merge request.");
      expect(envelope.data.tasks[0]!.steps.map((step) => step.name)).toEqual(["build", "mr"]);
    }),
  ));

test("`collie --json board` reads the quiet threshold the pane reads", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectory({ prefix: "collie-board-quiet-" });
      const state = path.join(home, "state");
      yield* fs.makeDirectory(path.join(home, "config"), { recursive: true });
      // An hour, so a Run untouched for ten minutes is working in the pane — and must be
      // working here too, or the two disagree about what a Task is doing.
      yield* fs.writeFileString(
        path.join(home, "config", "config.json"),
        `{"board_quiet_ms": 3600000}\n`,
      );
      const run = yield* seed({ stateDir: state, workflow: "implement", steps: ["build"] });
      run.step("build").status = "running";
      yield* run.save();
      // A Driver that is alive — this process — or ten silent minutes would read as a Run
      // nothing drives, which is Abandoned whatever the threshold says.
      yield* fs.writeFileString(
        path.join(run.dir, RUNNER_PID),
        `{"pid":${process.pid},"start":null,"at":"2026-09-08T09:00:00.000Z"}\n`,
      );
      // Ten minutes ago, which is quiet under the five-minute default and not under this.
      // Every file in the directory: what the board reads is the newest of them.
      const when = ((yield* Clock.currentTimeMillis) - 10 * 60 * 1000) / 1000;
      for (const name of yield* fs.readDirectory(run.dir))
        yield* fs.utimes(path.join(run.dir, name), when, when);

      const root = new URL("../", import.meta.url).pathname;
      const proc = Bun.spawn(
        [Bun.argv[0] ?? "bun", path.join(root, "src/main.ts"), "--json", "board"],
        {
          cwd: root,
          env: {
            HERDR_PLUGIN_ROOT: root,
            HERDR_PLUGIN_CONFIG_DIR: path.join(home, "config"),
            HERDR_PLUGIN_STATE_DIR: state,
            HOME: home,
            PWD: root,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const stdout = yield* Effect.promise(() => new Response(proc.stdout).text());
      yield* Effect.promise(() => proc.exited);
      yield* fs.remove(home, { recursive: true, force: true });

      const envelope = yield* Schema.decodeUnknownEffect(BoardEnvelope)(stdout);
      expect(envelope.data.tasks[0]!.state).toBe("active");
    }),
  ));

test("a held Task carries its own line under the sentence", () => {
  expect(heldLine(null)).toBe("⏸ Held.");
  expect(heldLine("14:00")).toBe("⏸ Held until 14:00.");
});

// The three sections the board draws, the one sentence over them, and the same thing
// as text for a pane whose renderer will not start.

function task(over: Partial<TaskView> = {}): TaskView {
  return {
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
    // A finished fixture has landed unless the test says otherwise: most tests are about
    // the other sections, and an unlanded done Task is its own case.
    landed: (over.state ?? "active") === "done",
    ended: null,
    mrState: null,
    planReady: false,
    run: "r1",
    runs: ["r1"],
    at: 0,
    ...over,
  };
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

const SENTENCES: Array<[string, TaskView[], { text: string; urgent: boolean }]> = [
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
    { text: "One decision is waiting on you. 1 working.", urgent: true },
  ],
  [
    "several decisions, and a quiet one behind them",
    [
      task({ state: "blocked", decision: QUESTION }),
      task({ id: "t2", state: "blocked", decision: QUESTION }),
      task({ id: "t3" }),
      task({ id: "t4", state: "quiet" }),
    ],
    { text: "2 decisions are waiting on you. 2 working, 1 gone quiet.", urgent: true },
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

test("the four sections take every Task, in the board's own order", () => {
  const views = [
    task({ id: "blocked", state: "blocked", decision: QUESTION }),
    task({ id: "working" }),
    task({ id: "quiet", state: "quiet" }),
    task({ id: "failed", state: "failed" }),
    task({ id: "done", state: "done" }),
  ];

  const sections = sectionsOf(views, "");

  expect(sections.needs.map((t) => t.id)).toEqual(["blocked"]);
  expect(sections.working.map((t) => t.id)).toEqual(["working", "quiet"]);
  // Failed work nobody disposed of is still yours; a landed done Task is finished.
  expect(sections.waiting.map((t) => t.id)).toEqual(["failed"]);
  expect(sections.finished.map((t) => t.id)).toEqual(["done"]);
});

test("a Run nothing drives and nobody works on is abandoned, and waiting on you", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* stateDir();
      const run = yield* seed({ stateDir: dir, workflow: "implement", steps: ["build"] });
      run.step("build").status = "running";
      yield* run.save();
      const when = ((yield* Clock.currentTimeMillis) - 13 * 24 * 60 * 60 * 1000) / 1000;
      for (const name of yield* fs.readDirectory(run.dir))
        yield* fs.utimes(path.join(run.dir, name), when, when);

      // A Run stopped at a question two weeks ago is just as dead as one mid-step.
      const asking = yield* seed({
        stateDir: dir,
        workflow: "review",
        steps: ["review"],
        task: "t-asking",
      });
      asking.record.awaiting = "review";
      yield* asking.save();
      for (const name of yield* fs.readDirectory(asking.dir))
        yield* fs.utimes(path.join(asking.dir, name), when, when);

      const board = yield* buildBoard({ stateDir: dir });
      const view = board.find((entry) => entry.runs[0] === run.id);
      expect(view!.state).toBe("abandoned");
      expect(sectionOf(view!)).toBe("waiting");
      expect(view!.sentence).toBe("Its Driver died 13 days ago.");
      const stuck = board.find((entry) => entry.runs[0] === asking.id);
      expect(stuck!.state).toBe("abandoned");

      // A disposition recorded now — by a human, or by the merge watch — is bookkeeping
      // about the Run, not the Run doing something: it stays dead, and its work landed.
      yield* recordDisposition(run.dir, {
        at: "2026-09-16T12:00:00Z",
        by: "gitlab",
        kind: "merged",
        ref: "mk/collie!16",
        note: null,
      });
      const disposed = (yield* buildBoard({ stateDir: dir })).find(
        (entry) => entry.runs[0] === run.id,
      )!;
      expect(disposed.state).toBe("abandoned");
      expect(disposed.landed).toBe(true);
      expect(sectionOf(disposed)).toBe("finished");
      expect(disposed.sentence).toBe("Its Driver died 13 days ago. Merged as mk/collie!16.");

      // The same record with a live Driver is working, however long it has been silent.
      const alive = yield* buildBoard({ stateDir: dir, driversLive: new Set([run.id]) });
      const kept = alive.find((entry) => entry.runs[0] === run.id)!;
      expect(kept.state).toBe("quiet");
      expect(sectionOf(kept)).toBe("working");
    }),
  ));

test("a Run that ended with nothing to file is finished, not waiting", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* stateDir();
      // Failed before it had a checkout: no branch, no merge request, nothing anyone
      // could mark merged or abandoned. Fifty of these are not fifty obligations.
      yield* seed({
        stateDir: dir,
        workflow: "implement",
        steps: ["build"],
        status: "failed",
        branch: false,
        task: "t-bare",
      });
      // Failed with a branch: the work is somewhere, and what became of it is yours.
      yield* seed({
        stateDir: dir,
        workflow: "implement",
        steps: ["build"],
        status: "failed",
        task: "t-branch",
      });
      const board = yield* buildBoard({ stateDir: dir });
      const by = (task: string) => board.find((view) => view.id === task)!;
      expect(by("t-bare").landed).toBe(true);
      expect(sectionOf(by("t-bare"))).toBe("finished");
      expect(by("t-branch").landed).toBe(false);
      expect(sectionOf(by("t-branch"))).toBe("waiting");
    }),
  ));

test("landed is a disposition, a merge GitLab reports, or a Workflow with nothing to land", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* stateDir();
      yield* seed({
        stateDir: dir,
        workflow: "review",
        steps: ["review"],
        status: "done",
        task: "t-review",
      });
      yield* seed({
        stateDir: dir,
        workflow: "plan",
        steps: ["spec"],
        status: "done",
        task: "t-plan",
      });
      const merged = yield* seed({
        stateDir: dir,
        workflow: "implement",
        steps: ["build"],
        status: "done",
        task: "t-merged",
      });
      merged.record.mr_url = "https://gitlab.cego.dk/mk/collie/-/merge_requests/65";
      yield* merged.save();
      const closed = yield* seed({
        stateDir: dir,
        workflow: "implement",
        steps: ["build"],
        status: "done",
        task: "t-closed",
      });
      closed.record.mr_url = "https://gitlab.cego.dk/mk/collie/-/merge_requests/66";
      yield* closed.save();

      const board = yield* buildBoard({
        stateDir: dir,
        mrStates: new Map([
          ["mk/collie!65", "merged"],
          ["mk/collie!66", "closed"],
        ]),
      });
      const of = (workflow: string) => board.find((view) => view.runs[0]!.startsWith(workflow))!;
      expect(sectionOf(of("review"))).toBe("finished");
      expect(sectionOf(of("plan"))).toBe("waiting");
      expect(of("plan").sentence).toBe("Plan ready to implement.");
      const mrViews = board.filter((view) => view.mr !== null);
      const mergedView = mrViews.find((view) => view.mr!.endsWith("/65"))!;
      const closedView = mrViews.find((view) => view.mr!.endsWith("/66"))!;
      expect(sectionOf(mergedView)).toBe("finished");
      expect(sectionOf(closedView)).toBe("waiting");
      expect(closedView.sentence).toBe("Merge request mk/collie!66 closed without merging.");
    }),
  ));

test("the header counts what is waiting on you this week, and the fold counts the rest", () => {
  const now = Date.parse("2026-09-16T12:00:00.000Z");
  const views = [
    task({ id: "w", state: "active" }),
    task({ id: "recent", state: "failed", ended: now - 2 * 24 * 60 * 60 * 1000 }),
    task({ id: "old", state: "stopped", ended: now - 9 * 24 * 60 * 60 * 1000 }),
  ];
  // Given the clock, the header counts the week's endings; the fold's own line counts the
  // rest. Without it — a test's bare call — it counts them all.
  expect(headerSentence(views, now).text).toBe("Nothing needs you. 1 working. 1 waiting on you.");
  expect(headerSentence(views).text).toBe("Nothing needs you. 1 working. 2 waiting on you.");
  const { recent, older } = foldWaiting(sectionsOf(views, "").waiting, now);
  expect(recent.map((t) => t.id)).toEqual(["recent"]);
  expect(older.map((t) => t.id)).toEqual(["old"]);
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
  // An empty query is not a filter: every Task matches it.
  expect(matchesTask(view, "  ")).toBe(true);
});

test("the sections are what the search left", () => {
  const views = [
    task({ id: "a", name: "Strapi prod seeder" }),
    task({ id: "b", name: "Passkey bridge race", state: "done" }),
  ];

  expect(sectionsOf(views, "passkey")).toEqual({
    needs: [],
    working: [],
    waiting: [],
    finished: [views[1]!],
  });
});

test("Finished is one line until it is opened", () => {
  const finished = [task({ state: "done" }), task({ id: "t2", state: "failed" })];
  expect(finishedLabel(finished, false)).toBe("2 finished today, 1 failed");
  expect(finishedLabel(finished, true)).toBe("Finished · 2");
  expect(finishedLabel([task({ state: "done" })], false)).toBe("1 finished today");
  // Given the clock, a dead Run that landed weeks ago is counted as older, not as today's.
  const now = Date.parse("2026-09-17T08:00:00.000Z");
  const fresh = finished.map((view) => ({ ...view, ended: now - 60 * 60 * 1000 }));
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

// The text board: the escape hatch a pane too dumb to render falls back to. The same
// three sections and the same sentences, because a human on it must not be shown a
// shorter, more reassuring version of the herd.

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

test("a held Task says until when, and who held it, from the record", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* stateDir();
      const run = yield* seed({ stateDir: dir, workflow: "implement", steps: ["build"] });
      const now = Date.parse("2026-09-14T10:05:00Z");
      run.record.awaiting = "hold";
      // Two in the afternoon on the human's own clock, which is what they asked for and
      // what the card has to say back.
      run.record.held = { reason: "leaving for lunch", by: "mk", until: untilFrom("14:00", now)! };
      yield* run.save();

      const board = yield* buildBoard({ stateDir: dir, now });

      // "tomorrow" where the hold's own day has already turned, which is a fact about
      // where the reader is rather than about the hold.
      expect(board[0]!.held).toMatch(/^⏸ Held until 14:00( tomorrow)?\.$/);
      expect(board[0]!.heldBy).toEqual({ by: "mk", reason: "leaving for lunch" });

      // A hold with no end is one only a human lifts, and the card says that much.
      run.record.held = { reason: "the branch is wrong", by: "mk", until: null };
      yield* run.save();
      expect((yield* buildBoard({ stateDir: dir, now }))[0]!.held).toBe("⏸ Held.");
    }),
  ));

test("a child Run's gate is the plan's own decision, answerable on the parent's card", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* stateDir();
      const child = yield* seed({
        stateDir: dir,
        workflow: "implement",
        steps: ["build", "mr"],
        task: null,
        label: "collie | Core",
      });
      const parent = yield* seed({
        stateDir: dir,
        workflow: "implement",
        steps: ["build", "next"],
        task: "task-1",
      });
      parent.record.fanout = {
        step: "next",
        title: "implement everywhere",
        waves: [["core"]],
        runs: { core: child.id },
        mrs: {},
        wave: 1,
        blocked: null,
      };
      yield* parent.save();
      yield* writeChoice(child.dir, {
        id: "g1",
        kind: "gate",
        run: child.id,
        step: "mr",
        header: "Approve what proves this run: tests",
        footer: "",
        items: [{ id: "approve", title: "Approve" }],
        verifications: ["tests"],
      });

      const board = yield* buildBoard({ stateDir: dir, now: Date.parse("2026-09-14T10:05:00Z") });

      // One card for the plan, and the child's gate is what it is waiting on: a
      // repository run has no card of its own to answer it from.
      expect(board).toHaveLength(1);
      expect(sectionOf(board[0]!)).toBe("needs-you");
      expect(board[0]!.decision).toMatchObject({ kind: "gate", id: "g1", run: child.id });
    }),
  ));

test("a child Run's proposal is the plan's own decision too", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* stateDir();
      const now = Date.parse("2026-09-14T10:05:00Z");
      const child = yield* seed({
        stateDir: dir,
        workflow: "implement",
        steps: ["build", "mr"],
        task: null,
        label: "collie | Core",
      });
      const parent = yield* seed({
        stateDir: dir,
        workflow: "implement",
        steps: ["build", "next"],
        task: "task-1",
      });
      parent.record.fanout = {
        step: "next",
        title: "implement everywhere",
        waves: [["core"]],
        runs: { core: child.id },
        mrs: {},
        wave: 1,
        blocked: null,
      };
      yield* parent.save();

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

      const board = yield* buildBoard({ stateDir: dir, now, proposals: [proposal] });

      // The plan's card is the only place a repository run's confirmation can be given.
      expect(board).toHaveLength(1);
      expect(sectionOf(board[0]!)).toBe("needs-you");
      expect(board[0]!.decision).toMatchObject({ kind: "proposal", id: "p-child" });
    }),
  ));

test("Finished is today's work, and older finished Runs are History's", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* stateDir();
      const now = Date.parse("2026-09-14T10:05:00Z");
      const today = yield* seed({
        stateDir: dir,
        workflow: "review",
        steps: ["review"],
        status: "done",
        createdAt: "2026-09-14T09:00:00Z",
      });
      today.record.finished_at = "2026-09-14T09:30:00Z";
      yield* today.save();
      const week = yield* seed({
        stateDir: dir,
        workflow: "review",
        steps: ["review"],
        status: "done",
        createdAt: "2026-09-07T09:00:00Z",
        label: "collie | Last week",
      });
      week.record.finished_at = "2026-09-07T09:30:00Z";
      yield* week.save();

      const board = yield* buildBoard({ stateDir: dir, now });
      const finished = board.filter((view) => sectionOf(view) === "finished");

      expect(finished.map((view) => view.run)).toEqual([today.id]);
      expect(finishedLabel(finished, false)).toBe("1 finished today");
    }),
  ));

test("a step's sentence is the verb its frozen definition gave it", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* stateDir();
      const run = yield* seed({
        stateDir: dir,
        workflow: "renovate",
        steps: ["claim", "update"],
        task: null,
      });
      run.record.steps[0]!.status = "running";
      run.record.steps[0]!.summary = "Claiming the repository";
      yield* run.save();

      const board = yield* buildBoard({ stateDir: dir, now: Date.parse("2026-09-14T10:05:00Z") });

      expect(board[0]!.sentence).toBe("Claiming the repository.");
    }),
  ));

test("a step nobody named a verb for says what it is doing, never its id", () => {
  expect(sentenceFor(facts({ step: { id: "cego.lint", round: null } }))).not.toContain("cego.lint");
});

test("a Run named after a plan directory's path is named after the directory", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* stateDir();
      const run = yield* seed({
        stateDir: dir,
        workflow: "implement",
        steps: ["build"],
        label: "Collie TUI",
      });
      run.record.named_after = null;
      run.record.inputs = { plan: "/home/mk/work/gitte2/collie-tui-plan", plan_kind: "plan-dir" };
      yield* run.save();

      const [view] = yield* buildBoard({ stateDir: dir, now: Date.parse("2026-09-14T10:00:00Z") });
      expect(view!.project).toBe("Collie TUI");
      expect(view!.name).toBe("Implement · collie-tui-plan");
    }),
  ));

test("a name that is a filesystem path reads as what the path points at", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* stateDir();
      const run = yield* seed({
        stateDir: dir,
        workflow: "renovate",
        steps: ["track"],
        label:
          "/home/mk/work/gitte2/gitlab.cego.dk/cego/npm-packages/eslint-config-nodejs-typescript",
      });
      // A renovate Run is named after the checkout it roams in, which is a path — and its
      // slug is that whole path slugged, which is what the label would otherwise show.
      run.record.named_after =
        "/home/mk/work/gitte2/gitlab.cego.dk/cego/npm-packages/eslint-config-nodejs-typescript";
      run.record.slug = "renovate-home-mk-work-gitte2-gitlab-cego-dk-cego";
      yield* run.save();

      const [view] = yield* buildBoard({ stateDir: dir, now: Date.parse("2026-09-14T10:00:00Z") });
      expect(view!.name).toBe("Renovate · eslint-config-nodejs-typescript");
      // Said once: the workspace was named after the same checkout.
      expect(view!.project).toBe("");
    }),
  ));
