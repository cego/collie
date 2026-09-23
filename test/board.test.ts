// The board's model: one TaskView per Task, and the one sentence a card says about it.
//
// The formatter is pure and table-driven, because the sentence is the whole of what a
// human reads on a card — a form nobody has a case for is a form nobody can trust.

import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
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
import { readEnv } from "../src/env";
import type { AgentInfo } from "../src/herdr";
import type { ProposalLine } from "../src/proposals";
import type { AgentEntry } from "../src/registry";
import type { RunFacts } from "../src/runs";
import type { TaskRecord } from "../src/task";
import { runEffect } from "./support/effect";
import { madeRun } from "./support/records";
import { collie, proves } from "./support/world";
import { stopHost } from "./support/host";

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
    now: Date.parse("2026-09-14T10:05:00Z"),
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

test("a working agent leaves the Task working, and says what it is doing", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, { task: "task-1" });

      const [view] = yield* board(env, [run], {
        alive: [agent("impl-1", "working", "Writing the failing test")],
        registered: [registered("impl-1", run.id)],
      });

      expect(sectionOf(view!)).toBe("working");
      expect(view!.agents.map((one) => one.name)).toEqual(["impl-1"]);
      expect(view!.sentence).toBe("Writing the failing test.");
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

      const now = Date.parse("2026-09-14T10:00:00Z");
      const before = yield* board(env, [run], { now });
      // A merge request nobody has said landed is not a merge, but it is news.
      expect(before[0]!.sentence).toBe("Finished; content!1 is open.");

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
