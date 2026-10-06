// The board's model: one TaskView per Task, and the one sentence a card says about it.
//
// The formatter is pure and table-driven, because the sentence is the whole of what a
// human reads on a card — a form nobody has a case for is a form nobody can trust.

import { expect, test } from "bun:test";
import { DateTime, Effect, Fiber, FileSystem, Schema } from "effect";
import {
  boardLines,
  buildBoard,
  checksAt,
  finishedLabel,
  heldLine,
  sentenceFor,
  whereItIs,
  workingLabel,
  type Sentence,
} from "../src/board";
import { mrLabel } from "../src/board-model";
import {
  Answered,
  Controlled,
  EVIDENCE_GATE,
  foldWaiting,
  headerSentence,
  matchesTask,
  sectionOf,
  sectionsOf,
  SECTIONS,
  sortBoard,
  type TaskView,
} from "../src/board-model";
import { recordAudit } from "../src/audit";
import { recordDisposition } from "../src/disposition";
import { nothingApproved } from "../src/outcome";
import {
  appendVerification,
  encodeVerifying,
  readVerifications,
  type Verification,
} from "../src/verify";
import { checkSentence, followLog } from "../src/checks";
import { readEnv } from "../src/env";
import type { AgentInfo } from "../src/herdr";
import { toldIn, toldLine, type Delivery } from "../src/steering";
import { herdLines } from "../src/toolkit";
import { append as appendProposal, type ProposalLine } from "../src/proposals";
import type { AgentEntry } from "../src/registry";
import type { RunFacts } from "../src/runs";
import type { TaskRecord } from "../src/task";
import { runEffect } from "./support/effect";
import { madeRun } from "./support/records";
import { collie, proves } from "./support/world";
import { stopHost, until } from "./support/host";
import { epochMs } from "../src/time";

function facts(over: Partial<Sentence> = {}): Sentence {
  return {
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
    abandoned: null,
    planReady: false,
    mrState: null,
    checks: null,
    agent: null,
    stalled: null,
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
    "mk/collie!65 is open; nothing has checked it.",
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

test("the header counts what is waiting on you this week, and the fold counts the rest", () => {
  const now = epochMs("2026-09-16T12:00:00.000Z");
  const views = [
    task({ id: "w", state: "active" }),
    task({ id: "recent", state: "failed", ended: now - 2 * 24 * 60 * 60 * 1000 }),
    task({ id: "old", state: "stopped", ended: now - 9 * 24 * 60 * 60 * 1000 }),
  ];
  // Given the clock, the header counts the week's endings; the fold's own line counts the
  // rest. Without it — a test's bare call — it counts them all.
  expect(headerSentence(views, now).text).toBe("Nothing needs you. 1 waiting on you. 1 working.");
  expect(headerSentence(views).text).toBe("Nothing needs you. 2 waiting on you. 1 working.");
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

test("a filter narrows the rows that are drawn and never what is supervised", () => {
  const views = [
    task({ id: "blocked", state: "blocked", decision: QUESTION }),
    task({ id: "b", name: "Passkey bridge race", state: "done" }),
  ];
  // The search hides the Task that needs you from what is drawn…
  expect(sectionsOf(views, "passkey").needs).toEqual([]);
  // …and what says something is waiting on you still counts it.
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
  // Given the clock, a dead Run that landed weeks ago is counted as older, not as today's.
  const now = epochMs("2026-09-17T08:00:00.000Z");
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

test("a step nobody named a verb for says what it is doing, never its id", () => {
  expect(sentenceFor(facts({ step: { id: "cego.lint", round: null } }))).not.toContain("cego.lint");
});

// The builder, against Runs as the host reports them: what a Task is, which Runs make one
// up, and where its pipeline has got to. No pane, no renderer, and no host either — the
// Runs are handed in, which is what a caller drawing several views does.

const scratch = Effect.fn("board.scratch")(function* () {
  const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectory({ prefix: "collie-board-" });
  return { dir, env: readEnv({ HERDR_PLUGIN_STATE_DIR: dir, COLLIE_CWD: "/project" }) };
});

const TASK: TaskRecord = {
  id: "task-1",
  workspace: "w1",
  label: "collie | Control plane",
  cwd: "/project",
  created_at: "2026-09-14T09:00:00Z",
};

/** What herdr says about a pane, which is all the board ever knows about one. */
function agent(name: string, status: AgentInfo["status"], title: string | null = null): AgentInfo {
  return {
    name,
    paneId: "p-1",
    workspaceId: "w1",
    status,
    title,
    terminalId: "t-1",
    agentSession: null,
  };
}

/** The register's word that an agent works for a Run. */
function registered(agent: string, runId: string): AgentEntry {
  return {
    role: "implementer",
    agent,
    paneId: "p-1",
    workspaceId: "w1",
    runId,
    workflow: "implement",
    at: "2026-09-14T10:00:00Z",
  };
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
      const task = views.find((view) => view.id === "task-1")!;
      expect(task.name).toBe("Control plane");
      expect(task.project).toBe("collie");
      expect(task.runs).toEqual(["r-build", "r-plan"]);
      // The Run with no Task names itself, and its checkout is its project.
      const own = views.find((view) => view.id === "r-alone")!;
      expect(own.name).toBe("Review");
      expect(own.project).toBe("spilnu");
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
      // The newest Run still going is the one the card speaks for.
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

      // The host's registry lists Runs in the order they were admitted.
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
        asking: [{ name: "scope", prompt: "Which repository?", options: ["core", "tiger"] }],
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

test("a working agent leaves the Task working, and its pane title is not the card's text", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, { task: "task-1" });
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${dir}/agents/${run.id}`, { recursive: true });
      yield* fs.writeFileString(`${dir}/agents/${run.id}/launches`, "build\nreview-1\n");

      for (const title of ["Claude Code", "Review-1.prompt.md", "cego.collie agent review"]) {
        const [view] = yield* board(env, [run], {
          alive: [agent("impl-1", "working", title)],
          registered: [registered("impl-1", run.id)],
        });

        expect(sectionOf(view!)).toBe("working");
        expect(view!.agents.map((one) => one.name)).toEqual(["impl-1"]);
        expect(view!.sentence).toBe("Reviewing, round 1.");
      }
    }),
  ));

test("a check Collie is running outranks what an idle agent last said", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, { task: "task-1" });
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${run.dir}/verifying`, "typecheck-spilnu");

      const [view] = yield* board(env, [run], {
        alive: [agent("impl-1", "idle", "Code review findings application")],
        registered: [registered("impl-1", run.id)],
      });

      // A marker in the old one-line shape still reads, as a name and nothing more.
      expect(view!.sentence).toBe("Running typecheck-spilnu.");
    }),
  ));

/** The steps the Driver launched agents for, oldest first, as it records them. */
const launched = Effect.fn("board.launched")(function* (
  stateDir: string,
  runId: string,
  operations: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(`${stateDir}/agents/${runId}`, { recursive: true });
  yield* fs.writeFileString(`${stateDir}/agents/${runId}/launches`, `${operations.join("\n")}\n`);
});

/** A file last written at this moment, which is what silence is measured from. */
const writtenAt = Effect.fn("board.writtenAt")(function* (file: string, at: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(file.slice(0, file.lastIndexOf("/")), { recursive: true });
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
      // Round 1's seats carry no round: this is seat 3 of the first review.
      const seated = yield* madeRun(dir, { id: "r-seat" });
      yield* launched(dir, seated.id, ["build", "review-1", "review-2", "review-3"]);
      const named = yield* madeRun(dir, { id: "r-named" });
      yield* launched(dir, named.id, ["build", "review-gpt-5", "synthesize", "review-2-gpt-5"]);

      const views = yield* board(env, [fixing, reviewing, ticket, seated, named]);
      const said = (id: string) => views.find((view) => view.run === id)!.sentence;

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
      const fs = yield* FileSystem.FileSystem;
      const old = "2026-09-14T09:00:00Z";
      const working = yield* madeRun(dir, { id: "r-working", task: "task-1" });
      const checking = yield* madeRun(dir, { id: "r-checking" });
      const writing = yield* madeRun(dir, { id: "r-writing" });
      const idle = yield* madeRun(dir, { id: "r-idle" });
      for (const run of [working, checking, writing, idle]) {
        yield* launched(dir, run.id, ["build"]);
        yield* writtenAt(`${run.dir}/log`, old);
        const then = DateTime.toDateUtc(DateTime.makeUnsafe(old));
        yield* fs.utimes(`${dir}/agents/${run.id}/launches`, then, then);
      }
      yield* writtenAt(`${checking.dir}/verifying`, old);
      yield* writtenAt(`${dir}/agents/${writing.id}/build.prompt.md`, "2026-09-14T10:04:00Z");

      const views = yield* board(env, [working, checking, writing, idle], {
        alive: [agent("impl-1", "working"), { ...agent("impl-2", "idle"), paneId: "p-2" }],
        registered: [registered("impl-1", working.id), registered("impl-2", idle.id)],
      });
      const view = (id: string) => views.find((one) => one.run === id)!;

      expect(view(working.id).state).toBe("active");
      expect(view(working.id).sentence).toBe("Building.");
      expect(view(checking.id).state).toBe("active");
      expect(view(writing.id).state).toBe("active");
      // An idle agent and nothing written for an hour is what quiet is.
      expect(view(idle.id).state).toBe("quiet");
      expect(view(idle.id).sentence).toBe("Building, but silent for 1 hour.");
    }),
  ));

test("what the host writes about a finished Run does not move when it ended", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const old = "2026-09-13T09:00:00Z";
      const run = yield* madeRun(dir, { state: "failed", branch: "mk/old-work" });
      yield* writtenAt(`${run.dir}/log`, old);
      // The diff kept for its drawer and the trail of who disposed of it.
      yield* writtenAt(`${run.dir}/diff.json`, "2026-09-14T10:04:00Z");
      yield* writtenAt(`${run.dir}/operations.jsonl`, "2026-09-14T10:04:00Z");

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
      // A merge request nobody has said landed is not a merge, but it is news.
      expect(before[0]!.sentence).toBe("content!1 is open; nothing has checked it.");

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
      // Both facts, on the card a person is looking at: how execution ended, and what
      // became of the work. Neither is edited to tidy the other away.
      expect(card!.state).toBe("failed");
      expect(card!.disposition).toBe("merged cego/collie!43");
      expect(card!.sentence).toBe(
        "Stopped: the tests never went green. Merged as cego/collie!43 1 hour ago.",
      );
    }),
  ));

test("a Run that ended with nothing to file is finished, not waiting", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      // Failed before it had a checkout: no branch, no merge request, nothing anyone
      // could mark merged or abandoned. Fifty of these are not fifty obligations.
      const bare = yield* madeRun(dir, { id: "r-bare", task: "t-bare", state: "failed" });
      // Failed with a branch: the work is somewhere, and what became of it is yours.
      const branched = yield* madeRun(dir, {
        id: "r-branch",
        task: "t-branch",
        state: "failed",
        branch: "mk/control-plane",
      });

      const views = yield* board(env, [bare, branched]);
      const by = (task: string) => views.find((view) => view.id === task)!;
      expect(by("t-bare").landed).toBe(true);
      expect(sectionOf(by("t-bare"))).toBe("finished");
      expect(by("t-branch").landed).toBe(false);
      expect(sectionOf(by("t-branch"))).toBe("waiting");
    }),
  ));

test("landed is a disposition, a merge the forge reports, or work with nothing to land", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const issues = Effect.fn("board.issues")(function* (run: RunFacts, count: number) {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${run.dir}/plan/issues`, { recursive: true });
        for (let at = 1; at <= count; at++)
          yield* fs.writeFileString(`${run.dir}/plan/issues/0${at}-thing.md`, `# ${at}\n`);
        return run;
      });
      const done = (id: string, over: Partial<RunFacts> = {}) =>
        madeRun(dir, { id, task: `t-${id}`, state: "succeeded", ...over });
      const runs = [
        yield* done("review", { workflow: "review" }),
        // Tickets and nothing else: work somebody can build from, whatever wrote them.
        yield* issues(yield* done("plan", { workflow: "plan" }), 3),
        // The same facts under a name that shares nothing with the shipped one.
        yield* issues(yield* done("renamed", { workflow: "shape-the-work" }), 2),
        // Named `plan` and wrote none: there is nothing to build from, so nothing is owed.
        yield* done("empty", { workflow: "plan" }),
        yield* done("merged", { mr: "https://gitlab.cego.dk/mk/collie/-/merge_requests/65" }),
        yield* done("closed", { mr: "https://gitlab.cego.dk/mk/collie/-/merge_requests/66" }),
      ];

      // What each module offers now: the shipped plan offers its build, the renamed one
      // declares nothing, and the card offers exactly that.
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
          ["mk/collie!65", "merged"],
          ["mk/collie!66", "closed"],
        ]),
        offers: (runId) => Effect.succeed(runId === "plan" ? [implementNow] : []),
      });
      const by = (task: string) => views.find((view) => view.id === `t-${task}`)!;
      expect(sectionOf(by("review"))).toBe("finished");
      expect(sectionOf(by("empty"))).toBe("finished");
      // Identical cards, under two names that share nothing.
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

test("the board reads every Herd's proposals, not only the one its host came from", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, { id: "r1", task: "task-1" });
      const proposal = (id: string): ProposalLine => ({
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
      yield* appendProposal(`${dir}/herd/other-session/proposals.jsonl`, proposal("p-other"));

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
      const finished = views.filter((view) => sectionOf(view) === "finished");

      expect(finished.map((view) => view.run)).toEqual([today.id]);
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

test(
  "`collie --json board` prints the TaskView list, from the host's Runs",
  () =>
    proves(
      "collie-board-cli-",
      (world) =>
        Effect.gen(function* () {
          const started = yield* collie(world, ["run", "start", "plain", "--input", "note=hi"]);
          expect(started.envelope.ok).toBe(true);
          const printed = yield* collie(world, ["board"]);
          yield* stopHost(world.state);
          expect(printed.envelope.ok).toBe(true);
          const tasks = Schema.decodeUnknownSync(
            Schema.Struct({ tasks: Schema.Array(Schema.Struct({ name: Schema.String })) }),
          )(printed.envelope.data).tasks;
          expect(tasks.map((one) => one.name)).toEqual(["Plain"]);
        }),
      ["plain.workflow.ts"],
    ),
  60_000,
);

/** A plan of three repositories, each waiting on the one before, in a root with their checkouts. */
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
        yield* launched(dir, run.id, ["build"]);
        yield* writtenAt(`${run.dir}/log`, old);
        yield* fs.utimes(`${dir}/agents/${run.id}/launches`, then, then);
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
      yield* writtenAt(`${dir}/agents/${web.id}/build.prompt.md`, "2026-09-14T10:04:00Z");
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

test("a Run parked at its evidence gate is a gate decision listing the checks it could be held to", () =>
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
        cwd,
        parked: nothingApproved("r1"),
      });

      const [view] = yield* board(env, [run]);

      expect(sectionOf(view!)).toBe("needs-you");
      expect(view!.decision).toEqual({
        kind: "gate",
        run: "r1",
        id: EVIDENCE_GATE,
        step: "evidence",
        verifications: ["test"],
      });
      expect(view!.sentence).toBe("Holding at the evidence gate until you approve the list.");
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
      // What to repair, because fixing the file brings the Run back.
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

// Ready to release: a succeeded Run's open merge request, and what checked it.

test("the sections come out in the board's order, and ready work leads Waiting on you", () => {
  const views = sortBoard([
    task({ id: "done", state: "done" }),
    task({ id: "working" }),
    task({
      id: "older-ready",
      state: "done",
      landed: false,
      ready: true,
      ended: 1,
    }),
    task({ id: "recent", state: "done", landed: false, ended: 2 }),
    task({ id: "blocked", state: "blocked", decision: QUESTION }),
  ]);
  expect(views.map((view) => view.id)).toEqual([
    "blocked",
    "older-ready",
    "recent",
    "working",
    "done",
  ]);
  expect(SECTIONS.map(([section]) => section)).toEqual([
    "needs-you",
    "waiting",
    "working",
    "finished",
  ]);
});

const PR = "https://github.com/cego/collie/pull/30";

test("an open merge request says whether it is ready, what failed, and the next move", () => {
  const open = (over: Partial<Sentence>) => sentenceFor(facts({ state: "done", mr: PR, ...over }));
  expect(open({ checks: { state: "passed", at: "1a2b3c4d5e" }, agent: "builder" })).toBe(
    "Ready to release: cego/collie#30 is open and its checks passed at 1a2b3c4. Next: merge it, or tell builder to.",
  );
  expect(open({ checks: { state: "passed", at: "1a2b3c4d5e" } })).toBe(
    "Ready to release: cego/collie#30 is open and its checks passed at 1a2b3c4. Next: merge it.",
  );
  expect(
    open({
      checks: { state: "failed", name: "lint", at: "1a2b3c4d5e" },
      agent: "builder",
    }),
  ).toBe("cego/collie#30 is open, but lint failed at 1a2b3c4. Next: fix lint, or tell builder to.");
  expect(open({ checks: { state: "unchecked" } })).toBe(
    "cego/collie#30 is open; nothing has checked it.",
  );
});

test("a GitHub pull request reads as owner/repo#N, and GitLab labels are unchanged", () => {
  expect(mrLabel(PR)).toBe("cego/collie#30");
  expect(mrLabel("https://gitlab.cego.dk/mk/collie/-/merge_requests/65")).toBe("mk/collie!65");
  expect(mrLabel("mr:gitlab.cego.dk/mk/collie!65")).toBe("mk/collie!65");
});

test("the header names what is ready to release before what else waits on you", () => {
  const views = [
    task({ id: "ready", state: "done", landed: false, ready: true }),
    task({ id: "w1", state: "failed" }),
    task({ id: "w2", state: "done", landed: false }),
    task({ id: "a1" }),
    task({ id: "a2" }),
    task({ id: "a3" }),
  ];
  expect(headerSentence(views).text).toBe(
    "Nothing needs you. 1 ready to release, 2 waiting on you. 3 working.",
  );
  expect(headerSentence([views[0]!]).text).toBe(
    "Nothing needs you. 1 ready to release. 0 working.",
  );
});

/** A Collie-collected check of `name` at `head`. */
const checked = (name: string, head: string, result: "pass" | "fail" = "pass"): Verification => ({
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

/** A checkout with `branch` at a commit of its own, and that commit's sha. */
const checkout = Effect.fn("board.checkout")(function* (branch: string) {
  const fs = yield* FileSystem.FileSystem;
  const repo = yield* fs.makeTempDirectory({ prefix: "collie-board-repo-" });
  const git = (...args: string[]) =>
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
  return { repo, head: (yield* git("rev-parse", "HEAD")).trim() };
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
      const view = Effect.map(board(env, [run]), (views) => views[0]!);

      expect((yield* view).sentence).toBe("cego/collie#30 is open; nothing has checked it.");

      // Green, but on a tree the branch has moved past: not evidence about this one.
      yield* appendVerification(run.evidence, checked("test", "0000000older"));
      expect((yield* view).checks).toEqual({ state: "unchecked" });
      expect((yield* view).ready).toBe(false);

      yield* appendVerification(run.evidence, checked("test", head));
      yield* appendVerification(run.evidence, checked("lint", head, "fail"));
      const red = yield* view;
      expect(red.checks).toEqual({ state: "failed", name: "lint", at: head });
      expect(red.sentence).toBe(
        `cego/collie#30 is open, but lint failed at ${head.slice(0, 7)}. Next: fix lint.`,
      );

      yield* appendVerification(run.evidence, checked("lint", head));
      const green = yield* board(env, [run], {
        alive: [agent("builder", "idle")],
        registered: [registered("builder", run.id)],
      });
      expect(green[0]!.ready).toBe(true);
      expect(sectionOf(green[0]!)).toBe("waiting");
      expect(green[0]!.sentence).toBe(
        `Ready to release: cego/collie#30 is open and its checks passed at ${head.slice(0, 7)}. Next: merge it, or tell builder to.`,
      );
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
      expect(view!.sentence).toContain("passed at bbbbbbb.");
    }),
  ));

// A check Collie is running: which pass, why, and how long against how long it usually takes.

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
];

for (const [form, given, expected] of PASS_SENTENCES) {
  test(`a running check's sentence for ${form}`, () => {
    expect(checkSentence(given)).toBe(expected);
  });
}

/** A marker as the host writes one while a check runs. */
const marking = Effect.fn("board.marking")(function* (
  run: RunFacts,
  over: Partial<Parameters<typeof encodeVerifying>[0]> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.writeFileString(
    `${run.dir}/verifying`,
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

/** A finished Collie run of `bun test` in `run`'s evidence that took `minutes`. */
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
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${dir}/agents/${run.id}`, { recursive: true });
      yield* fs.writeFileString(`${dir}/agents/${run.id}/launches`, "fix-1\n");
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
      // Six earlier: the oldest falls out, and the last five's median is 3 minutes.
      for (const [n, minutes] of [
        [0, 90],
        [1, 1],
        [2, 2],
        [3, 3],
        [4, 4],
        [5, 5],
      ] as const)
        yield* took(before, minutes, at(n));
      // Another repository's runs of the same command are not this one's usual.
      yield* took(elsewhere, 60, at(6));
      // Nor are this repository's runs of it with other arguments, or of another command.
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

      const view = (yield* board(env, [run, before, elsewhere])).find((one) => one.run === run.id);
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
      for (const one of [run, a, b]) yield* marking(one);
      const view = (yield* board(env, [run, a, b])).find((one) => one.run === run.id);
      expect(view!.sentence).toBe("Running test on the branch, 4 min. 2 other checks are running.");
    }),
  ));

test("a Verification recorded before passes were still reads, as a plain check", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir } = yield* scratch();
      const run = yield* madeRun(dir);
      const fs = yield* FileSystem.FileSystem;
      const {
        pass: _pass,
        round: _round,
        ...old
      } = { ...checked("test", "abc"), pass: "gate", round: 1 };
      yield* fs.makeDirectory(`${run.evidence}/steering`, { recursive: true });
      yield* fs.writeFileString(
        `${run.evidence}/steering/verifications.jsonl`,
        `${Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))(old)}\n`,
      );
      const [read] = yield* readVerifications(run.evidence);
      expect(read?.name).toBe("test");
      expect(read?.pass).toBeUndefined();
    }),
  ));

test(
  "`collie --json run checks` lists the running pass and the finished ones",
  () =>
    proves(
      "collie-run-checks-cli-",
      (world) =>
        Effect.gen(function* () {
          const started = yield* collie(world, ["run", "start", "plain", "--input", "note=hi"]);
          const runId = Schema.decodeUnknownSync(Schema.Struct({ runId: Schema.String }))(
            started.envelope.data,
          ).runId;
          const fs = yield* FileSystem.FileSystem;
          const run = yield* madeRun(world.state, { id: runId });
          yield* appendVerification(run.evidence, {
            ...checked("lint", "abc"),
            run: runId,
            pass: "gate",
          });
          yield* fs.writeFileString(
            `${run.dir}/verifying`,
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
            Schema.decodeUnknownSync(
              Schema.Struct({ running: Schema.Struct({ sentence: Schema.String }) }),
            )(listed.envelope.data).running.sentence,
          ).toStartWith("Running test after gate fix 1, ");
        }),
      ["plain.workflow.ts"],
    ),
  60_000,
);

// A finished Run Reopened by a steer to its live agent (ADR-0038 D5): derived from the
// ledger and herdr's word on the agent, never stored.

const steerAt = (at: string, state: Delivery["state"] = "submitted"): Delivery => ({
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

/** A succeeded Run whose builder was told "merge and tag it", with herdr saying `status`. */
const reopened = Effect.fn("board.reopened")(function* (
  status: AgentInfo["status"],
  steeredAt = "2026-09-14T10:02:00Z",
  over: Partial<Parameters<typeof buildBoard>[0]> = {},
) {
  const { dir, env } = yield* scratch();
  const run = yield* madeRun(dir, {
    task: "task-1",
    state: "succeeded",
    mr: "https://github.com/cego/collie/pull/30",
    finished: "2026-09-14T10:00:00Z",
  });
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(`${dir}/agents/${run.id}`, { recursive: true });
  yield* fs.writeFileString(
    `${dir}/agents/${run.id}/agents.log`,
    'builder: told "merge and tag it"\n',
  );
  const views = yield* board(env, [run], {
    alive: [agent("builder", status)],
    registered: [registered("builder", run.id)],
    deliveries: [steerAt(steeredAt)],
    ...over,
  });
  return views[0]!;
});

test("a succeeded Run whose agent works on what it was told after it ended is Working", () =>
  runEffect(
    Effect.gen(function* () {
      const card = yield* reopened("working");
      expect(sectionOf(card)).toBe("working");
      expect(card.sentence).toBe("Working on what you told builder: “merge and tag it”.");
      // The Workflow's steps are as they ended.
      expect(card.steps).toEqual([{ name: "implement", state: "done" }]);
      expect(card.reopened).toMatchObject({ agent: "builder", status: "working" });
      // Chat reads the same card, in the same section.
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
      const card = yield* reopened("idle", "2026-09-14T10:02:00Z", {
        forge: new Map([["cego/collie#30", { checks: { state: "passed" }, head: "abc1234def" }]]),
      });
      expect(sectionOf(card)).toBe("waiting");
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

test(
  "`collie run checks --follow` prints a running check's output as it is written, and how it ended",
  () =>
    proves(
      "collie-run-checks-follow-",
      (world) =>
        Effect.gen(function* () {
          const started = yield* collie(world, ["run", "start", "plain", "--input", "note=hi"]);
          const runId = Schema.decodeUnknownSync(Schema.Struct({ runId: Schema.String }))(
            started.envelope.data,
          ).runId;
          const fs = yield* FileSystem.FileSystem;
          const run = yield* madeRun(world.state, { id: runId });
          const log = `${run.evidence}/checks/unit.log`;
          yield* fs.makeDirectory(`${run.evidence}/checks`, { recursive: true });
          yield* fs.writeFileString(log, "compiling\n");
          const marker = `${run.dir}/verifying`;
          yield* fs.writeFileString(
            marker,
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

          let heard = "";
          const following = yield* Effect.forkChild(
            collie(world, ["run", "checks", runId, "--follow"], {}, (stderr) => {
              heard = stderr;
            }),
          );
          yield* until(
            () => Effect.succeed(heard),
            (stderr) => stderr.includes("compiling"),
          );
          yield* fs.writeFileString(log, "1 pass\n", { flag: "a" });
          yield* until(
            () => Effect.succeed(heard),
            (stderr) => stderr.includes("1 pass"),
          );
          yield* appendVerification(run.evidence, {
            ...checked("unit", "abc"),
            run: runId,
            log,
          });
          yield* fs.remove(marker);
          const followed = yield* Fiber.join(following);

          const none = yield* collie(world, ["run", "checks", runId, "--follow"]);
          yield* stopHost(world.state);
          // Under --json the output is stderr's: stdout is the one envelope.
          expect(followed.stderr).toContain("Running unit on the branch");
          expect(followed.stderr.indexOf("compiling")).toBeLessThan(
            followed.stderr.indexOf("1 pass"),
          );
          expect(followed.envelope.data).toMatchObject({ ended: { name: "unit", result: "pass" } });
          expect(none.envelope.data).toEqual({ run: runId, ended: null });
        }),
      ["plain.workflow.ts"],
    ),
  60_000,
);

test("work ready to release is never folded away, however long it has waited", () => {
  const now = epochMs("2026-09-16T12:00:00.000Z");
  const week = 8 * 24 * 60 * 60 * 1000;
  const views = [
    task({ id: "ready", state: "done", landed: false, ready: true, ended: now - week }),
    task({ id: "stale", state: "failed", ended: now - week }),
  ];
  const { recent, older } = foldWaiting(views, now);
  expect(recent.map((view) => view.id)).toEqual(["ready"]);
  expect(older.map((view) => view.id)).toEqual(["stale"]);
  expect(headerSentence(views, now).text).toBe("Nothing needs you. 1 ready to release. 0 working.");
});

test("only a steer herdr took, dated after the Run ended, reopens it", () =>
  runEffect(
    Effect.gen(function* () {
      const at = "2026-09-14T10:02:00Z";
      for (const state of ["reserved", "deferred", "failed", "unknown"] as const) {
        const card = yield* reopened("working", at, { deliveries: [steerAt(at, state)] });
        expect([state, card.reopened]).toEqual([state, null]);
      }
      const step = { ...steerAt(at), cause: { kind: "step" as const, ref: "build" } };
      expect((yield* reopened("working", at, { deliveries: [step] })).reopened).toBeNull();
      expect(
        (yield* reopened("working", at, { deliveries: [steerAt(at, "acknowledged")] })).reopened,
      ).not.toBeNull();
    }),
  ));

test("an agent's own record of a check never counts toward ready", () => {
  const claimed = { ...checked("test", "abc"), by: "agent" as const };
  expect(checksAt([claimed], "abc")).toEqual({ state: "unchecked" });
  expect(checksAt([claimed, checked("test", "abc")], "abc")).toEqual({
    state: "passed",
    at: "abc",
  });
});

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
      const said: string[] = [];
      const following = yield* Effect.forkChild(
        followLog(run, log, (text) => Effect.sync(() => void said.push(text))),
      );

      yield* fs.writeFileString(log, "1 pass\n", { flag: "a" });
      // Said with the marker still there: the check has not ended.
      yield* until(
        () => Effect.succeed(said.join("")),
        (text) => text.includes("1 pass"),
      );
      expect(yield* fs.exists(`${run.dir}/verifying`)).toBe(true);

      yield* fs.remove(`${run.dir}/verifying`);
      expect(yield* Fiber.join(following)).toBeNull();
      expect(said.join("")).toBe("1 pass\n");
    }),
  ));

test("the told line the agents write is the one a Reopened card reads back", () => {
  const log = [
    toldLine("builder", "merge and tag it\nthen release"),
    toldLine("reviewer", "look"),
  ].join("\n");
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
      expect(views.find((one) => one.run === "r-going")!.held).toBe("⏸ Held.");
      expect(views.find((one) => one.run === "r-ended")!.held).toBeNull();
    }),
  ));
