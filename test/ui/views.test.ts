import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Rec from "effect/Record";
import type { PlatformServices } from "../../src/platform";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { PlatformError } from "effect";
import { DateTime, Effect, FileSystem, Path, Schema, flow, Result } from "effect";
import { Rig, type RigError } from "../support/recorder";
import { installBaseline } from "../support/engine";
import { installFakeSkills } from "../support/defs";
import { runEffect } from "../support/effect";
import {
  buildHistory,
  buildRunDetail,
  buildSettings,
  buildWorkflows,
  planTicket,
  type PlanCache,
} from "../../src/views";
import { FINDINGS_FILE, FindingSchema, REVIEW_FILE } from "../../src/output";
import type { RunFacts } from "../../src/runs";
import { madeRun } from "../support/records";
import { writeSettingsSet } from "../../src/config";
import { recordLaunch } from "../../src/launches";
import { writeCheckpoint } from "../../src/cards";
import type { Records } from "../../src/records";
import { stringifyJson } from "../../src/json";

let rig: Rig;
const encodeFindings = flow(
  Schema.encodeResult(Schema.fromJsonString(Schema.Array(FindingSchema))),
  Result.getOrThrow,
);
let runs: Array<RunFacts> = [];

function effectTest(
  name: string,
  body: () => Effect.gen.Return<
    void,
    RigError | PlatformError.PlatformError | Error,
    PlatformServices | Records
  >,
) {
  test(name, () => runEffect(Effect.gen(body)));
}

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      runs = [];
      yield* installBaseline(rig);
      yield* installFakeSkills(rig.root);
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

const seed = Effect.fn("viewsTest.seed")(function* (opts: {
  workflow: string;
  cwd?: string;
  target?: string;
  state?: RunFacts["state"];
  review?: string;
  findings?: number;
  settled?: RunFacts["settled"];
  repo?: string;
  change?: string;
}) {
  const env = rig.pluginEnv();
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const run = yield* madeRun(env.stateDir, {
    id: `r${runs.length + 1}`,
    workflow: opts.workflow,
    project: opts.cwd ?? env.cwd,
    cwd: opts.cwd ?? env.cwd,
    state: opts.state ?? "succeeded",
    created: `2026-09-0${runs.length + 1}T10:00:00.000Z`,
    finished: opts.state === "running" ? null : `2026-09-0${runs.length + 1}T11:00:00.000Z`,
    repo: opts.repo ?? null,
    change: opts.change ?? null,
    settled: opts.settled ?? {
      inputs: opts.target ? { target: opts.target } : {},
      strategies: { target: "diff-target" },
    },
  });
  if (opts.review !== undefined)
    yield* fs.writeFileString(path.join(run.dir, REVIEW_FILE), opts.review);
  if (opts.findings !== undefined)
    yield* fs.writeFileString(
      path.join(run.dir, FINDINGS_FILE),
      encodeFindings(
        Array.from({ length: opts.findings }, (_, i) => ({
          file: `f${i}.ts`,
          severity: "moderate" as const,
          title: `finding ${i}`,
          detail: "d",
        })),
      ),
    );
  runs = [run, ...runs];
  return run;
});

const detailOf = (run: { id: string }, over: Partial<Parameters<typeof buildRunDetail>[0]> = {}) =>
  buildRunDetail({ env: rig.pluginEnv(), runId: run.id, runs, mr: null, ...over });

effectTest("History is this repo's finished runs whatever session they came from", function* () {
  const env = rig.pluginEnv();
  yield* seed({ workflow: "review", target: "mr:host/g/p!1" });
  yield* seed({ workflow: "review", target: "worktree" });
  yield* seed({ workflow: "review", cwd: "/somewhere/else", target: "worktree" });
  yield* seed({ workflow: "plan", state: "running" });

  const history = yield* buildHistory({ cwd: env.cwd, runs });

  expect(history).toHaveLength(2);
  expect(Arr.every(history, (r) => pipe(r.title, Str.startsWith("Review")))).toBe(true);
  expect(Arr.map(history, (r) => r.target)).toEqual(["worktree", "mr:host/g/p!1"]);
});

effectTest("a run that can supply the work says so, and one that cannot does not", function* () {
  const env = rig.pluginEnv();
  yield* seed({ workflow: "review", target: "worktree", review: "# Review\n", findings: 2 });
  yield* seed({ workflow: "review", target: "branch:main...x", review: "# Review\n", findings: 0 });
  yield* seed({ workflow: "plan" });

  const history = yield* buildHistory({ cwd: env.cwd, runs });
  const by = (target: string | null) =>
    Option.getOrUndefined(Arr.findFirst(history, (r) => r.target === target))!;

  expect(by("worktree").fixable).toBe(true);
  expect(by("worktree").detail).toContain("2 finding(s) open");
  // WARNING: clean means nothing open to fix; offering fix would start an implement run over no findings.
  expect(by("branch:main...x").fixable).toBe(false);
  expect(by(null).fixable).toBe(false);
});

effectTest("Workflows carry their layer, their inputs and what checking them says", function* () {
  const env = rig.pluginEnv();

  const { workflows } = yield* buildWorkflows(env);

  const review = Option.getOrUndefined(Arr.findFirst(workflows, (w) => w.name === "review"))!;
  expect(review.layer).toBe("shipped");
  expect(review.inputs).toContain("target");
  expect(review.path).toContain("review.workflow.ts");

  expect(Arr.map(workflows, (w) => w.name)).not.toContain("reviewer");
});

effectTest("Settings shows the defaults and remembered values it can write back", function* () {
  const env = rig.pluginEnv();

  const before = yield* buildSettings(env);
  expect(
    Option.getOrUndefined(Arr.findFirst(before.defaults, (d) => d.key === "harness"))!.value,
  ).not.toBe("");

  yield* buildSettings(env);
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(env.userDir, { recursive: true });
  yield* fs.writeFileString(
    path.join(env.userDir, "config.json"),
    stringifyJson({ model: "opus", linear: { team: "CEG" } }),
  );

  const after = yield* buildSettings(env);
  expect(
    Option.getOrUndefined(Arr.findFirst(after.defaults, (d) => d.key === "model"))!.value,
  ).toBe("opus");
  expect(after.remembered).toContainEqual({ key: "linear.team", value: "CEG" });
});

effectTest("Settings knows which Desktop shares them with the Flock", function* () {
  const env = rig.pluginEnv();
  expect((yield* buildSettings(env)).flock).toBeNull();

  yield* writeSettingsSet(env.userDir, {
    set: {},
    flock: { by: "laptop", at: "2026-10-07T10:00:00Z" },
  });

  expect((yield* buildSettings(env)).flock).toBe("laptop");
});

effectTest("Settings offers every key loadDefaults reads, and repeats none of them", function* () {
  const env = rig.pluginEnv();
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(env.userDir, { recursive: true });
  yield* fs.writeFileString(
    path.join(env.userDir, "config.json"),
    `{ "handoff_timeout_ms": 60000 }`,
  );

  const settings = yield* buildSettings(env);

  expect(
    Option.getOrUndefined(Arr.findFirst(settings.defaults, (d) => d.key === "handoff_timeout_ms"))!
      .value,
  ).toBe("60000");
  expect(Arr.map(settings.remembered, (r) => r.key)).not.toContain("handoff_timeout_ms");
  expect(
    Option.getOrUndefined(Arr.findFirst(settings.defaults, (d) => d.key === "permissions"))!.value,
  ).toBe("auto");

  // WARNING: a hand-edited nonsense value must still render, because a read that threw would take the repair tool down.
  yield* fs.writeFileString(path.join(env.userDir, "config.json"), `{ "permissions": "yolo" }`);
  const broken = yield* buildSettings(env);
  expect(
    Option.getOrUndefined(Arr.findFirst(broken.defaults, (d) => d.key === "permissions"))!.value,
  ).toBe("yolo");
});

effectTest("a run's detail is its inputs and its review", function* () {
  const run = yield* seed({
    workflow: "review",
    target: "mr:host/g/p!3",
    review: "# Review\n\nSummary.\n\n## Findings\n\n- [strong] one\n",
  });

  const detail = yield* detailOf(run);

  expect(detail).not.toBeNull();
  if (!detail) return;
  expect(detail.title).toBe("Review · !3");
  expect(detail.inputs).toContainEqual({ name: "target", value: "mr:host/g/p!3", source: "" });
  expect(detail.review._tag).toBe("Text");
  if (detail.review._tag === "Text") {
    expect(detail.review.text).toContain("[strong] one");
    expect(detail.review.truncated).toBe(false);
  }
});

effectTest(
  "a run's detail lists what it was given, and nothing for a Run given none",
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const given = yield* seed({ workflow: "plan" });
    const none = yield* seed({ workflow: "plan" });
    yield* fs.makeDirectory(`${given.dir}/attachments`);
    yield* fs.writeFileString(`${given.dir}/attachments/shot.png`, "png!");
    yield* fs.writeFileString(`${given.dir}/attachments/notes.txt`, "hello");

    expect((yield* detailOf(given))?.attachments).toEqual([
      { name: "notes.txt", size: 5, mediaType: "text/plain" },
      { name: "shot.png", size: 4, mediaType: "image/png" },
    ]);
    expect((yield* detailOf(none))?.attachments).toEqual([]);
  },
);

effectTest("a run with no review says so", function* () {
  const run = yield* seed({ workflow: "review", target: "worktree" });

  const detail = yield* detailOf(run);

  if (!detail) throw new Error("expected a detail");
  expect(detail.review).toEqual({ _tag: "None", reason: "this run wrote no review.md" });
});

effectTest("a review too big to read is capped and says so", function* () {
  const run = yield* seed({ workflow: "review", review: pipe("x", Str.repeat(4_000_000)) });

  const detail = yield* detailOf(run);

  if (!detail || detail.review._tag !== "Text") throw new Error("expected review text");
  expect(detail.review.truncated).toBe(true);
  expect(detail.review.text.length).toBe(64 * 1024);
});

effectTest("a paged review reads another cap for each page asked for", function* () {
  const run = yield* seed({ workflow: "review", review: pipe("x", Str.repeat(4_000_000)) });

  const first = yield* detailOf(run);
  const third = yield* detailOf(run, { pages: 3 });

  if (first?.review._tag !== "Text" || third?.review._tag !== "Text") {
    throw new Error("expected review text");
  }
  expect(first.review.text.length).toBe(64 * 1024);
  expect(third.review.text.length).toBe(3 * 64 * 1024);
  expect(third.review.truncated).toBe(true);
});

effectTest("an empty review reads as empty rather than as no review at all", function* () {
  const run = yield* seed({ workflow: "review", review: "" });

  const detail = yield* detailOf(run);

  // WARNING: a file that is there and empty is not the same as a run that wrote none.
  expect(detail?.review).toEqual({ _tag: "Text", text: "", truncated: false });
});

effectTest("the log tail is the end of a long log, and only when it is asked for", function* () {
  const run = yield* seed({ workflow: "review" });
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i}`);
  yield* fs.writeFileString(path.join(run.dir, "log.txt"), `${Arr.join(lines, "\n")}\n`);

  const off = yield* detailOf(run);
  expect(off?.tail).toBeNull();

  const on = yield* detailOf(run, { tail: true });

  if (on?.tail?._tag !== "Text") throw new Error("expected tail text");
  expect(on.tail.truncated).toBe(true);
  expect(on.tail.text).toContain("line 19999");
  expect(on.tail.text).not.toContain("line 0\n");
  expect(Str.split(on.tail.text, "\n")[0]).toMatch(/^line \d+$/);
});

effectTest("a run with no log says so where the tail would be", function* () {
  const run = yield* seed({ workflow: "review" });

  const detail = yield* detailOf(run, { tail: true });

  expect(detail?.tail).toEqual({ _tag: "None", reason: "this run wrote no log" });
});

effectTest("a run that is not there has no detail rather than a failure", function* () {
  expect(yield* detailOf({ id: "no-such-run" })).toBeNull();
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

  // WARNING: no boxes is not all checked: an unmarked ticket is open.
  const bare = planTicket("03-no-heading.md", "just prose\n");
  expect(bare).toEqual({ file: "03-no-heading.md", title: "03-no-heading.md", done: false });
});

effectTest(
  "a run's plan is read from its own plan dir, or the one it was started from",
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const planner = yield* seed({ workflow: "plan" });
    const dir = path.join(planner.dir, "plan");
    yield* fs.makeDirectory(path.join(dir, "issues"), { recursive: true });
    yield* fs.writeFileString(path.join(dir, "SPEC.md"), "# Control Plane\n\nOne screen.\n");
    yield* fs.writeFileString(path.join(dir, "issues", "02-second.md"), "# Second\n\n- [ ] a\n");
    yield* fs.writeFileString(path.join(dir, "issues", "01-first.md"), "# First\n\n- [x] a\n");
    yield* fs.writeFileString(path.join(dir, "issues", "notes.txt"), "not a ticket\n");

    const own = yield* detailOf(planner);

    expect(own!.plan!.spec).toEqual({
      _tag: "Text",
      text: "# Control Plane\n\nOne screen.\n",
      truncated: false,
    });
    expect(own!.plan!.tickets).toMatchObject([
      { file: "01-first.md", title: "First", done: true },
      { file: "02-second.md", title: "Second", done: false },
    ]);

    const builder = yield* seed({
      workflow: "implement",
      settled: {
        inputs: { plan: dir, plan_kind: "plan-dir" },
        strategies: { plan: "work-source" },
      },
    });

    const started = yield* detailOf(builder);
    expect(Arr.map(started!.plan!.tickets, (t) => t.title)).toEqual(["First", "Second"]);

    const fixer = yield* seed({
      workflow: "implement",
      settled: { inputs: { plan: dir, plan_kind: "review" }, strategies: { plan: "work-source" } },
    });
    const none = yield* detailOf(fixer);
    expect(none!.plan).toBeNull();
  },
);

effectTest(
  "a finished run's plan is read again once rewritten; a running one's every time",
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const plans: PlanCache = new Map();

    const write = (run: { dir: string }, spec: string) =>
      Effect.gen(function* () {
        yield* fs.makeDirectory(path.join(run.dir, "plan"), { recursive: true });
        yield* fs.writeFileString(path.join(run.dir, "plan", "SPEC.md"), spec);
      });

    // WARNING: a stopped run's agent can still rewrite its plan, so a write is read again.
    const done = yield* seed({ workflow: "implement" });
    yield* write(done, "# first\n");
    expect((yield* detailOf(done, { plans }))!.plan!.spec).toMatchObject({ text: "# first\n" });
    yield* write(done, "# rewritten\n");
    expect((yield* detailOf(done, { plans }))!.plan!.spec).toMatchObject({
      text: "# rewritten\n",
    });

    // WARNING: a running plan may be written as it is read, so it is never cached.
    const going = yield* seed({ workflow: "implement", state: "running" });
    yield* write(going, "# first\n");
    expect((yield* detailOf(going, { plans }))!.plan!.spec).toMatchObject({ text: "# first\n" });
    yield* write(going, "# rewritten\n");
    expect((yield* detailOf(going, { plans }))!.plan!.spec).toMatchObject({
      text: "# rewritten\n",
    });
  },
);

const planned = Effect.fn("viewsTest.planned")(function* (
  dir: string,
  tickets: Record<string, string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.join(dir, "issues"), { recursive: true });
  const before = DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-01T00:00:00.000Z"));
  for (const [file, text] of Rec.toEntries(tickets)) {
    yield* fs.writeFileString(path.join(dir, "issues", file), text);
    yield* fs.utimes(path.join(dir, "issues", file), before, before);
  }
});

const hostDetailOf = (
  run: { id: string },
  over: Partial<Parameters<typeof buildRunDetail>[0]> = {},
) => detailOf(run, { runs: Arr.map(runs, (one) => ({ ...one, finished: null })), ...over });

const progressed = Effect.fn("viewsTest.progressed")(function* (
  run: { dir: string },
  ticket: string,
  status: "started" | "done",
) {
  yield* writeCheckpoint(run.dir, { ticket, status, claims: [], at: "2026-09-01T10:30:00.000Z" });
});

const stepped = Effect.fn("viewsTest.stepped")(function* (
  run: { id: string },
  operation: string,
  at = "2026-08-02T00:00:00.000Z",
) {
  const fs = yield* FileSystem.FileSystem;
  const dir = `${rig.pluginEnv().stateDir}/agents/${run.id}`;
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(`${dir}/${operation}.json`, "{}");
  const when = DateTime.toDateUtc(DateTime.makeUnsafe(at));
  yield* fs.utimes(`${dir}/${operation}.json`, when, when);
  yield* recordLaunch({
    agent: `${run.id}-build`,
    output: `${dir}/${operation}.json`,
    reused: false,
    runId: run.id,
    operation,
    role: "implementer",
    workflow: "implement",
    harness: "claude",
  });
});

effectTest(
  "a prose ticket is done once a succeeded Run built from its plan finished it",
  function* () {
    const path = yield* Path.Path;
    const planner = yield* seed({ workflow: "plan" });
    const dir = path.join(planner.dir, "plan");
    yield* planned(dir, {
      "01-landed.md": "# Landed\n\nProse only.\n",
      "02-stepped.md": "# Stepped\n\nProse only.\n",
      "03-started.md": "# Started\n\nProse only.\n",
      "04-failed.md": "# Failed\n\nProse only.\n",
      "05-boxes.md": "# Boxes\n\n- [ ] a\n",
    });
    const fromPlan = {
      inputs: { plan: dir, plan_kind: "plan-dir" },
      strategies: { plan: "work-source" },
    };

    const builder = yield* seed({ workflow: "implement", settled: fromPlan });
    yield* progressed(builder, "01-landed.md", "done");
    yield* stepped(builder, "02-stepped.md");
    yield* progressed(builder, "03-started.md", "started");
    // WARNING: a failed Run proves nothing, whatever its slices said.
    const failed = yield* seed({ workflow: "implement", state: "failed", settled: fromPlan });
    yield* progressed(failed, "04-failed.md", "done");
    yield* stepped(failed, "04-failed.md");

    const expected = [
      { file: "01-landed.md", done: true },
      { file: "02-stepped.md", done: true },
      { file: "03-started.md", done: false },
      { file: "04-failed.md", done: false },
      { file: "05-boxes.md", done: false },
    ];
    expect((yield* hostDetailOf(planner))!.plan!.tickets).toMatchObject(expected);
    expect((yield* hostDetailOf(builder))!.plan!.tickets).toMatchObject(expected);
  },
);

effectTest(
  "a succeeded Run's whole-plan build finishes the tickets it had, and nothing else",
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const whole = yield* seed({ workflow: "implement" });
    yield* planned(path.join(whole.dir, "plan"), {
      "01-one.md": "# One\n\nProse.\n",
      "02-two.md": "# Two\n\nProse.\n",
    });
    yield* stepped(whole, "build");
    const later = path.join(whole.dir, "plan", "issues", "03-later.md");
    yield* fs.writeFileString(later, "# Later\n");
    const added = DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-03T00:00:00.000Z"));
    yield* fs.utimes(later, added, added);

    expect((yield* hostDetailOf(whole))!.plan!.tickets).toMatchObject([
      { file: "01-one.md", done: true },
      { file: "02-two.md", done: true },
      { file: "03-later.md", done: false },
    ]);

    const planner = yield* seed({ workflow: "plan" });
    yield* planned(path.join(planner.dir, "plan"), { "01-one.md": "# One\n\nProse.\n" });
    expect((yield* hostDetailOf(planner))!.plan!.tickets).toMatchObject([
      { file: "01-one.md", done: false },
    ]);

    const stopped = yield* seed({ workflow: "implement", state: "stopped" });
    yield* planned(path.join(stopped.dir, "plan"), { "01-one.md": "# One\n\nProse.\n" });
    yield* stepped(stopped, "build");
    expect((yield* hostDetailOf(stopped))!.plan!.tickets).toMatchObject([
      { file: "01-one.md", done: false },
    ]);
  },
);

effectTest("a repository's build finishes only that repository's tickets", function* () {
  const path = yield* Path.Path;
  const planner = yield* seed({ workflow: "plan" });
  const dir = path.join(planner.dir, "plan");
  yield* planned(dir, {
    "01-api.md": "# Api\n\n**Repo:** api\n",
    "02-web.md": "# Web\n\n**Repo:** web\n",
  });
  const api = yield* seed({
    workflow: "implement",
    repo: "api",
    settled: { inputs: { plan: dir, plan_kind: "plan-dir" }, strategies: { plan: "work-source" } },
  });
  yield* stepped(api, "build");

  expect((yield* hostDetailOf(planner))!.plan!.tickets).toMatchObject([
    { file: "01-api.md", done: true },
    { file: "02-web.md", done: false },
  ]);
});

effectTest("a Change's build finishes only that Change's tickets", function* () {
  const path = yield* Path.Path;
  const planner = yield* seed({ workflow: "plan" });
  const dir = path.join(planner.dir, "plan");
  yield* planned(dir, {
    "01-api.md": "# Api\n\n**Repo:** .\n",
    "02-schema.md": "# Schema\n\n**Repo:** .\n**Change:** schema\n",
  });
  const schema = yield* seed({
    workflow: "implement",
    repo: ".",
    change: "schema",
    settled: { inputs: { plan: dir, plan_kind: "plan-dir" }, strategies: { plan: "work-source" } },
  });
  yield* stepped(schema, "build");

  expect((yield* hostDetailOf(planner))!.plan!.tickets).toMatchObject([
    { file: "01-api.md", done: false },
    { file: "02-schema.md", done: true },
  ]);
});

effectTest("a long ticket's repository is read past what the panel shows", function* () {
  const path = yield* Path.Path;
  const planner = yield* seed({ workflow: "plan" });
  const dir = path.join(planner.dir, "plan");
  yield* planned(dir, {
    "01-root.md": "# Root\n\n**Repo:** .\n",
    "02-web.md": `# Web\n\n${pipe("Prose.\n", Str.repeat(1500))}\n**Repo:** web\n`,
  });
  const root = yield* seed({
    workflow: "implement",
    repo: ".",
    settled: { inputs: { plan: dir, plan_kind: "plan-dir" }, strategies: { plan: "work-source" } },
  });
  yield* stepped(root, "build");

  expect((yield* hostDetailOf(planner))!.plan!.tickets).toMatchObject([
    { file: "01-root.md", done: true },
    { file: "02-web.md", done: false },
  ]);
});

effectTest("a root build leaves a ticket whose repository it cannot tell", function* () {
  const path = yield* Path.Path;
  const planner = yield* seed({ workflow: "plan" });
  const dir = path.join(planner.dir, "plan");
  yield* planned(dir, {
    "01-root.md": "# Root\n\n**Repo:** .\n",
    "02-wrapped.md": "# Wrapped\n\n**Repo:**\nweb\n",
    "03-far.md": `# Far\n\n${Str.repeat(1024 * 1024)("x")}\n**Repo:** web\n`,
  });
  const root = yield* seed({
    workflow: "implement",
    repo: ".",
    settled: { inputs: { plan: dir, plan_kind: "plan-dir" }, strategies: { plan: "work-source" } },
  });
  yield* stepped(root, "build");

  expect((yield* hostDetailOf(planner))!.plan!.tickets).toMatchObject([
    { file: "01-root.md", done: true },
    { file: "02-wrapped.md", done: false },
    { file: "03-far.md", done: false },
  ]);
});

effectTest("a plan named with a trailing slash is the same plan", function* () {
  const path = yield* Path.Path;
  const planner = yield* seed({ workflow: "plan" });
  const dir = path.join(planner.dir, "plan");
  yield* planned(dir, { "01-one.md": "# One\n\nProse.\n" });
  const builder = yield* seed({
    workflow: "implement",
    settled: {
      inputs: { plan: `${dir}/`, plan_kind: "plan-dir" },
      strategies: { plan: "work-source" },
    },
  });
  yield* stepped(builder, "build");

  expect((yield* hostDetailOf(planner))!.plan!.tickets).toMatchObject([
    { file: "01-one.md", done: true },
  ]);
});

effectTest("a finished Run's cached plan is read again once a ticket lands", function* () {
  const path = yield* Path.Path;
  const plans: PlanCache = new Map();
  const planner = yield* seed({ workflow: "plan" });
  const dir = path.join(planner.dir, "plan");
  yield* planned(dir, { "01-one.md": "# One\n\nProse.\n" });
  const builder = yield* seed({
    workflow: "implement",
    settled: { inputs: { plan: dir, plan_kind: "plan-dir" }, strategies: { plan: "work-source" } },
  });
  yield* progressed(builder, "01-one.md", "started");
  expect((yield* hostDetailOf(planner, { plans }))!.plan!.tickets[0]!.done).toBe(false);

  yield* progressed(builder, "01-one.md", "done");

  expect((yield* hostDetailOf(planner, { plans }))!.plan!.tickets[0]!.done).toBe(true);
});

effectTest(
  "Settings offers how a question is presented, defaulting to automatic focus",
  function* () {
    const env = rig.pluginEnv();
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    expect(
      Option.getOrUndefined(
        Arr.findFirst((yield* buildSettings(env)).defaults, (d) => d.key === "questions"),
      )!.value,
    ).toBe("focus");

    yield* fs.makeDirectory(env.userDir, { recursive: true });
    yield* fs.writeFileString(path.join(env.userDir, "config.json"), `{ "questions": "notify" }`);

    const set = yield* buildSettings(env);
    expect(
      Option.getOrUndefined(Arr.findFirst(set.defaults, (d) => d.key === "questions"))!.value,
    ).toBe("notify");
    expect(Arr.map(set.remembered, (r) => r.key)).not.toContain("questions");
  },
);

effectTest("a Run's detail carries the same interruption facts the CLI reports", function* () {
  const run = yield* seed({ workflow: "review", state: "failed" });

  const detail = yield* detailOf(run);

  // WARNING: the board and the CLI classify a stop the same way, so they cannot disagree about why a Run stopped.
  expect(detail!.attention.category).toBe("interrupted");
  expect(detail!.attention.reason).toBe("failed");
  expect(detail!.attention.actions).toEqual(["show", "actions"]);
});
