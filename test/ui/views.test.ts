// The four Views are projections of state Effect produces. These are the producers'
// own tests; the components are tested against fixtures in app.test.tsx.

import type { BunServices } from "@effect/platform-bun/BunServices";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Path, PlatformError } from "effect";
import { Rig, type RigError } from "../support/recorder";
import { installBaseline } from "../support/engine";
import { installFakeSkills, writeDef } from "../support/defs";
import { runEffect } from "../support/effect";
import {
  buildHistory,
  buildRunDetail,
  buildSettings,
  buildWorkflows,
  planTicket,
  type PlanPanel,
} from "../../src/views";
import { REVIEW_FILE } from "../../src/output";
import { RUNNER_LOG } from "../../src/driver";
import { Herdr } from "../../src/herdr";
import { RunStore, type Run } from "../../src/run";

let rig: Rig;

function effectTest(
  name: string,
  body: () => Effect.gen.Return<void, RigError | PlatformError.PlatformError | Error, BunServices>,
) {
  test(name, () => runEffect(Effect.gen(body)));
}

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      yield* installBaseline(rig);
      // Skills are a prerequisite, not a definition error; without them every row
      // carries the same five "not installed" lines and says nothing about the fork.
      yield* installFakeSkills(rig.root);
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

/** A run in some session, with whatever the test needs settled on it. */
const seed = Effect.fn("viewsTest.seed")(function* (opts: {
  workflow: string;
  cwd?: string;
  session?: string | null;
  workspace?: string | null;
  target?: string;
  status?: Run["record"]["status"];
  review?: string;
  outstanding?: number;
}) {
  const env = rig.pluginEnv();
  const run = yield* new RunStore(env.stateDir).create({
    workflow: opts.workflow,
    cwd: opts.cwd ?? env.cwd,
    session: opts.session === undefined ? env.socketPath : opts.session,
    workspace: opts.workspace === undefined ? env.workspaceId : opts.workspace,
    workspaceLabel: "test",
    inputs: opts.target ? { target: opts.target } : {},
    inputSources: {},
    stepIds: ["one"],
    maxIterations: 1,
    namedAfter: opts.target ?? "goal",
  });
  run.record.status = opts.status ?? "done";
  run.record.finished_at = run.record.created_at;
  run.record.target_label = opts.target ?? null;
  run.record.outstanding = Array.from({ length: opts.outstanding ?? 0 }, (_, i) => ({
    file: `f${i}.ts`,
    severity: "moderate" as const,
    title: `finding ${i}`,
    detail: "d",
  }));
  yield* run.save();
  if (opts.review !== undefined) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(path.join(run.dir, REVIEW_FILE), opts.review);
  }
  return run;
});

effectTest("History is this repo's finished runs whatever session they came from", function* () {
  const env = rig.pluginEnv();
  yield* seed({ workflow: "review", target: "mr:host/g/p!1" });
  // Another herdr session and another workspace, same checkout: this is exactly what
  // History is for — the Runs view already hides these.
  yield* seed({ workflow: "review", session: "/other.sock", workspace: "9", target: "worktree" });
  // Another checkout is somebody else's history, not this one's.
  yield* seed({ workflow: "review", cwd: "/somewhere/else", target: "worktree" });
  // Still going, so it belongs to Runs rather than to History.
  yield* seed({ workflow: "plan", status: "running" });

  const history = yield* buildHistory({ stateDir: env.stateDir, cwd: env.cwd });

  expect(history).toHaveLength(2);
  expect(history.every((r) => r.title.startsWith("Review"))).toBe(true);
  expect(history.map((r) => r.target)).toEqual(["worktree", "mr:host/g/p!1"]);
});

effectTest("a run that can supply the work says so, and one that cannot does not", function* () {
  const env = rig.pluginEnv();
  yield* seed({ workflow: "review", target: "worktree", review: "# Review\n", outstanding: 2 });
  // A review that came back clean: it has a review.md, and nothing to fix.
  yield* seed({ workflow: "review", target: "branch:main...x", review: "# Review\n" });
  yield* seed({ workflow: "plan" });

  const history = yield* buildHistory({ stateDir: env.stateDir, cwd: env.cwd });
  const by = (target: string | null) => history.find((r) => r.target === target)!;

  expect(by("worktree").fixable).toBe(true);
  expect(by("worktree").detail).toContain("2 finding(s) open");
  // Clean, so there is nothing open to fix and the action is not offered — offering it
  // would start an implement run over no findings at all.
  expect(by("branch:main...x").fixable).toBe(false);
  // And no review.md at all, so nothing to build from either.
  expect(by(null).fixable).toBe(false);
});

effectTest("Workflows carry their layer, inputs, decisions and validation", function* () {
  const env = rig.pluginEnv();
  yield* writeDef(
    rig.baselineDir,
    "workflows",
    "broken",
    `---
name: broken
title: broken — points at nothing
inputs:
  goal: goal
steps:
  - id: build
    persona: no-such-persona
---
Do {{inputs.goal}}.
`,
  );

  const { workflows } = yield* buildWorkflows(env);

  const review = workflows.find((w) => w.name === "review")!;
  expect(review.layer).toBe("baseline");
  expect(review.inputs).toContain("target");
  expect(review.decisions.some((d) => d.titles.includes("Post to MR"))).toBe(true);
  expect(review.problems).toEqual([]);
  // Its execution shape, which is half of what "what does this workflow do" means.
  expect(review.steps.some((line) => line.startsWith("review"))).toBe(true);
  expect(review.steps.some((line) => line.includes("in parallel"))).toBe(true);
  expect(review.steps.some((line) => line.includes("choice"))).toBe(true);

  // A fork that cannot run is visible as broken without running it.
  const broken = workflows.find((w) => w.name === "broken")!;
  expect(broken.problems.join(" ")).toContain("no-such-persona");

  // Workflows and nothing else: a persona cannot be run, so the view does not list one
  // and there is no row here to build from it.
  expect(workflows.map((w) => w.name)).not.toContain("reviewer");
});

effectTest("Settings shows the defaults and remembered values it can write back", function* () {
  const env = rig.pluginEnv();

  const before = yield* buildSettings(env);
  expect(before.defaults.find((d) => d.key === "harness")!.value).not.toBe("");

  yield* buildSettings(env);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(env.configDir, { recursive: true });
  yield* fs.writeFileString(
    path.join(env.configDir, "config.json"),
    JSON.stringify({ model: "opus", linear: { team: "CEG" } }),
  );

  const after = yield* buildSettings(env);
  expect(after.defaults.find((d) => d.key === "model")!.value).toBe("opus");
  expect(after.remembered).toContainEqual({ key: "linear.team", value: "CEG" });
});

effectTest("Settings offers every key loadDefaults reads, and repeats none of them", function* () {
  const env = rig.pluginEnv();
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(env.configDir, { recursive: true });
  yield* fs.writeFileString(
    path.join(env.configDir, "config.json"),
    `{ "handoff_timeout_ms": 60000 }`,
  );

  const settings = yield* buildSettings(env);

  // A key a Run reads and Settings does not offer is one nobody can inspect or edit.
  expect(settings.defaults.find((d) => d.key === "handoff_timeout_ms")!.value).toBe("60000");
  expect(settings.remembered.map((r) => r.key)).not.toContain("handoff_timeout_ms");
  // Nothing about unattended agents is silent: the mode is a row like any other.
  expect(settings.defaults.find((d) => d.key === "permissions")!.value).toBe("bypass");

  // And a hand-edited nonsense value still renders, because Settings is where it is put
  // right: a read that threw would take the repair tool down with the problem.
  yield* fs.writeFileString(path.join(env.configDir, "config.json"), `{ "permissions": "yolo" }`);
  const broken = yield* buildSettings(env);
  expect(broken.defaults.find((d) => d.key === "permissions")!.value).toBe("yolo");
});

effectTest("a run's detail is its inputs, steps, hand-offs, review and Outputs", function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const env = rig.pluginEnv();
  const run = yield* seed({
    workflow: "review",
    target: "mr:host/g/p!3",
    review: "# Review\n\nSummary.\n\n## Findings\n\n- [strong] one\n",
  });
  run.record.steps[0]!.status = "done";
  run.record.steps[0]!.note = "two reviewers agreed";
  run.record.steps[0]!.variants = [
    {
      harness: "claude",
      model: "opus",
      effort: null,
      permissions: null,
      agent: "rev-1",
      label: "review/review/opus",
      tabId: null,
      paneId: null,
      status: "done",
      output: "steps/review/opus/reviewed.json",
      error: null,
      repairs: [],
      nudges: 0,
    },
  ];
  run.record.handoffs = [
    { direction: "sent", role: "implementer", agent: "impl-1", run: "other", at: "", note: "fix" },
  ];
  yield* run.save();
  yield* fs.makeDirectory(path.join(run.dir, "steps", "review", "opus"), { recursive: true });
  yield* fs.writeFileString(
    path.join(run.dir, "steps", "review", "opus", "reviewed.json"),
    '{"verdict":"clean"}\n',
  );

  const detail = yield* buildRunDetail({
    stateDir: env.stateDir,
    agents: new Herdr(env),
    runId: run.id,
    mr: null,
  });

  expect(detail).not.toBeNull();
  if (!detail) return;
  expect(detail.title).toContain("Review");
  expect(detail.inputs).toContainEqual({ name: "target", value: "mr:host/g/p!3", source: "" });
  expect(detail.steps[0]).toMatchObject({
    id: "one",
    status: "done",
    note: "two reviewers agreed",
  });
  expect(detail.handoffs[0]).toContain("implementer");
  // The point of the panel: the review is readable without splitting a pane.
  expect(detail.review._tag).toBe("Text");
  if (detail.review._tag === "Text") {
    expect(detail.review.text).toContain("[strong] one");
    expect(detail.review.truncated).toBe(false);
  }
  expect(detail.outputs).toContainEqual({
    step: "one",
    where: "steps/review/opus/reviewed.json",
    state: "recorded",
    text: '{"verdict":"clean"}',
  });
});

effectTest("a run with no review, and an Output nobody wrote, both say which", function* () {
  const env = rig.pluginEnv();
  const run = yield* seed({ workflow: "review", target: "worktree" });
  run.record.steps[0]!.variants = [
    {
      harness: "claude",
      model: "opus",
      effort: null,
      permissions: null,
      agent: "rev-1",
      label: "review/one/opus",
      tabId: null,
      paneId: null,
      status: "failed",
      output: "steps/one/opus/reviewed.json",
      error: "no Output at steps/one/opus/reviewed.json",
      repairs: [],
      nudges: 0,
    },
  ];
  yield* run.save();

  const detail = yield* buildRunDetail({
    stateDir: env.stateDir,
    agents: new Herdr(env),
    runId: run.id,
    mr: null,
  });

  if (!detail) throw new Error("expected a detail");
  // Stated, not thrown: a run that wrote no review is the common case, not an error.
  expect(detail.review).toEqual({ _tag: "None", reason: "this run wrote no review.md" });
  expect(detail.outputs[0]!.state).toBe("missing");
  expect(detail.outputs[0]!.text).toBe("no Output at steps/one/opus/reviewed.json");
});

effectTest("a review too big to read is capped and says so", function* () {
  const env = rig.pluginEnv();
  // Two orders of magnitude past the cap: an agent writes these, so a run dir can hold
  // an artifact this size, and the panel must neither show it all nor read it all.
  const run = yield* seed({ workflow: "review", review: "x".repeat(4_000_000) });

  const detail = yield* buildRunDetail({
    stateDir: env.stateDir,
    agents: new Herdr(env),
    runId: run.id,
    mr: null,
  });

  if (!detail || detail.review._tag !== "Text") throw new Error("expected review text");
  expect(detail.review.truncated).toBe(true);
  // The cap, not "less than the file": what the panel holds is bounded by the cap
  // however big the agent's review turned out to be, because only that much is read.
  expect(detail.review.text.length).toBe(64 * 1024);
});

effectTest("a paged review reads another cap for each page asked for", function* () {
  const env = rig.pluginEnv();
  const run = yield* seed({ workflow: "review", review: "x".repeat(4_000_000) });

  const first = yield* buildRunDetail({
    stateDir: env.stateDir,
    agents: new Herdr(env),
    runId: run.id,
    mr: null,
  });
  const third = yield* buildRunDetail({
    stateDir: env.stateDir,
    agents: new Herdr(env),
    runId: run.id,
    mr: null,
    pages: 3,
  });

  if (first?.review._tag !== "Text" || third?.review._tag !== "Text") {
    throw new Error("expected review text");
  }
  // The rest of a review the panel cut short, without leaving the tab for it — and the
  // log tail is no help with this, because review.md is not the runner's log.
  expect(first.review.text.length).toBe(64 * 1024);
  expect(third.review.text.length).toBe(3 * 64 * 1024);
  expect(third.review.truncated).toBe(true);
});

effectTest("an empty review reads as empty rather than as no review at all", function* () {
  const env = rig.pluginEnv();
  const run = yield* seed({ workflow: "review", review: "" });

  const detail = yield* buildRunDetail({
    stateDir: env.stateDir,
    agents: new Herdr(env),
    runId: run.id,
    mr: null,
  });

  // A file that is there and says nothing is not the same as a run that wrote none.
  expect(detail?.review).toEqual({ _tag: "Text", text: "", truncated: false });
});

effectTest("the log tail is the end of a long log, and only when it is asked for", function* () {
  const env = rig.pluginEnv();
  const run = yield* seed({ workflow: "review" });
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i}`);
  yield* fs.writeFileString(path.join(run.dir, RUNNER_LOG), `${lines.join("\n")}\n`);

  const off = yield* buildRunDetail({
    stateDir: env.stateDir,
    agents: new Herdr(env),
    runId: run.id,
    mr: null,
  });
  expect(off?.tail).toBeNull();

  const on = yield* buildRunDetail({
    stateDir: env.stateDir,
    agents: new Herdr(env),
    runId: run.id,
    mr: null,
    tail: true,
  });

  if (on?.tail?._tag !== "Text") throw new Error("expected tail text");
  expect(on.tail.truncated).toBe(true);
  expect(on.tail.text).toContain("line 19999");
  // Only the end, and no line cut in half at the start of it.
  expect(on.tail.text).not.toContain("line 0\n");
  expect(on.tail.text.split("\n")[0]).toMatch(/^line \d+$/);
});

effectTest("a run with no log says so where the tail would be", function* () {
  const env = rig.pluginEnv();
  const run = yield* seed({ workflow: "review" });

  const detail = yield* buildRunDetail({
    stateDir: env.stateDir,
    agents: new Herdr(env),
    runId: run.id,
    mr: null,
    tail: true,
  });

  expect(detail?.tail).toEqual({ _tag: "None", reason: "this run wrote no runner.log" });
});

effectTest("a run that is not there has no detail rather than a failure", function* () {
  const env = rig.pluginEnv();
  expect(
    yield* buildRunDetail({
      stateDir: env.stateDir,
      agents: new Herdr(env),
      runId: "no-such-run",
      mr: null,
    }),
  ).toBeNull();
});

test("a ticket's title is its first heading, and it is done when every box is checked", () => {
  const open = planTicket(
    "01-agent-now-line.md",
    "# 01: Each agent row says what it is doing\n\n- [x] boundary decodes it\n- [ ] rendered\n",
  );
  expect(open).toEqual({
    file: "01-agent-now-line.md",
    title: "01: Each agent row says what it is doing",
    done: false,
  });

  const closed = planTicket("02.md", "Preamble\n\n## Needs you first\n\n- [X] one\n- [x] two\n");
  expect(closed.title).toBe("Needs you first");
  expect(closed.done).toBe(true);

  // No boxes is not "all of them are checked": a ticket nobody has marked up is open,
  // and a file with no heading is named by its file.
  const bare = planTicket("03-no-heading.md", "just prose\n");
  expect(bare).toEqual({ file: "03-no-heading.md", title: "03-no-heading.md", done: false });
});

effectTest(
  "a run's plan is read from its own plan dir, or the one it was started from",
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const env = rig.pluginEnv();

    const planner = yield* seed({ workflow: "plan" });
    const dir = path.join(planner.dir, "plan");
    yield* fs.makeDirectory(path.join(dir, "issues"), { recursive: true });
    yield* fs.writeFileString(path.join(dir, "SPEC.md"), "# Control Plane\n\nOne screen.\n");
    yield* fs.writeFileString(path.join(dir, "issues", "02-second.md"), "# Second\n\n- [ ] a\n");
    yield* fs.writeFileString(path.join(dir, "issues", "01-first.md"), "# First\n\n- [x] a\n");
    yield* fs.writeFileString(path.join(dir, "issues", "notes.txt"), "not a ticket\n");

    const own = yield* buildRunDetail({
      stateDir: env.stateDir,
      agents: new Herdr(env),
      runId: planner.id,
      mr: null,
    });

    expect(own!.plan!.spec).toEqual({
      _tag: "Text",
      text: "# Control Plane\n\nOne screen.\n",
      truncated: false,
    });
    // Ordered by file, which is what the numbering is for, and only the markdown.
    expect(own!.plan!.tickets).toEqual([
      { file: "01-first.md", title: "First", done: true },
      { file: "02-second.md", title: "Second", done: false },
    ]);

    // An implement run has no plan of its own; it reads the directory it was started from.
    const builder = yield* seed({ workflow: "implement" });
    builder.record.inputs.plan = dir;
    builder.record.inputs.plan_kind = "plan-dir";
    yield* builder.save();

    const started = yield* buildRunDetail({
      stateDir: env.stateDir,
      agents: new Herdr(env),
      runId: builder.id,
      mr: null,
    });
    expect(started!.plan!.tickets.map((t) => t.title)).toEqual(["First", "Second"]);

    // A run built from a review rather than a plan dir has no plan at all.
    const fixer = yield* seed({ workflow: "implement" });
    fixer.record.inputs.plan = dir;
    fixer.record.inputs.plan_kind = "review";
    yield* fixer.save();
    const none = yield* buildRunDetail({
      stateDir: env.stateDir,
      agents: new Herdr(env),
      runId: fixer.id,
      mr: null,
    });
    expect(none!.plan).toBeNull();
  },
);

effectTest("a step left running by a run that stopped is timed to where it stopped", function* () {
  const env = rig.pluginEnv();
  const run = yield* seed({ workflow: "implement" });
  const step = run.record.steps[0]!;
  // What a SIGTERM or a driver that died leaves behind: the run has an end, the step
  // it was on does not.
  step.status = "running";
  step.started_at = "2026-09-02T12:00:00.000Z";
  step.finished_at = null;
  run.record.status = "failed";
  run.record.finished_at = "2026-09-02T12:07:00.000Z";
  yield* run.save();

  const detail = yield* buildRunDetail({
    stateDir: env.stateDir,
    agents: new Herdr(env),
    runId: run.id,
    mr: null,
  });

  // Seven minutes, and seven minutes tomorrow too — not however long ago it died.
  expect(detail!.steps[0]!.took).toBe("7m");
});

effectTest("a finished run's plan is read once; a running one's is read again", function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const env = rig.pluginEnv();
  const plans = new Map<string, PlanPanel | null>();

  const write = (run: { dir: string }, spec: string) =>
    Effect.gen(function* () {
      yield* fs.makeDirectory(path.join(run.dir, "plan"), { recursive: true });
      yield* fs.writeFileString(path.join(run.dir, "plan", "SPEC.md"), spec);
    });

  // Stopped: the plan it was built from cannot change, so the second read is the cache.
  const done = yield* seed({ workflow: "implement" });
  yield* write(done, "# first\n");
  const readOnce = {
    stateDir: env.stateDir,
    agents: new Herdr(env),
    runId: done.id,
    mr: null,
    plans,
  };
  expect((yield* buildRunDetail(readOnce))!.plan!.spec).toMatchObject({ text: "# first\n" });
  yield* write(done, "# rewritten\n");
  expect((yield* buildRunDetail(readOnce))!.plan!.spec).toMatchObject({ text: "# first\n" });

  // Still running: it may be writing that plan as we read it, so it is never cached.
  const going = yield* seed({ workflow: "implement", status: "running" });
  yield* write(going, "# first\n");
  const live = { stateDir: env.stateDir, agents: new Herdr(env), runId: going.id, mr: null, plans };
  expect((yield* buildRunDetail(live))!.plan!.spec).toMatchObject({ text: "# first\n" });
  yield* write(going, "# rewritten\n");
  expect((yield* buildRunDetail(live))!.plan!.spec).toMatchObject({ text: "# rewritten\n" });
});

effectTest(
  "Settings offers how a question is presented, defaulting to automatic focus",
  function* () {
    const env = rig.pluginEnv();
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    expect((yield* buildSettings(env)).defaults.find((d) => d.key === "questions")!.value).toBe(
      "focus",
    );

    yield* fs.makeDirectory(env.configDir, { recursive: true });
    yield* fs.writeFileString(path.join(env.configDir, "config.json"), `{ "questions": "notify" }`);

    const set = yield* buildSettings(env);
    expect(set.defaults.find((d) => d.key === "questions")!.value).toBe("notify");
    // Offered as a default, not left in the remembered values nobody can edit.
    expect(set.remembered.map((r) => r.key)).not.toContain("questions");
  },
);

effectTest("a Run's detail carries the same interruption facts the CLI reports", function* () {
  const env = rig.pluginEnv();
  const run = yield* seed({ workflow: "review", status: "blocked", outstanding: 2 });
  run.record.iteration = run.record.max_iterations;
  yield* run.save();

  const detail = yield* buildRunDetail({
    stateDir: env.stateDir,
    agents: new Herdr(env),
    runId: run.id,
    mr: null,
  });

  // The same shape `run show` and `run wait --until attention` return, built by the
  // same function: the board and the CLI cannot disagree about why a Run stopped.
  expect(detail!.attention.category).toBe("interrupted");
  expect(detail!.attention.reason).toBe("review_exhausted");
  expect(detail!.attention.driver).toBe("none");
  expect(detail!.attention.actions).toContain("resume");
});
