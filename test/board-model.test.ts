// The board's model is imported by a browser bundle as well as by the host, so it must
// bundle for a browser and load in a context that has no runtime to reach.

import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { Effect, Schema } from "effect";
import {
  cardActions,
  flowActions,
  givenOfferInput,
  mrUrlOf,
  mrWords,
  openMrLabel,
  primaryAction,
  readMrRef,
  readinessOfRun,
  readyToRelease,
  RunDetail,
  TaskView,
} from "../src/board-model";
import { task } from "./support/task";
import { flowNode, mainFlow } from "./support/flow";
import type { FlowNode, TaskView as Task } from "../src/board-model";

const acting = (node: Partial<FlowNode>, over: Partial<Task> = {}) => {
  const base = mainFlow();
  const flow = {
    ...base,
    lanes: [{ ...base.lanes[1]!, nodes: [flowNode("work", node)] }],
    release: null,
  };
  return flowActions(
    flow,
    task({
      run: "build-run",
      agents: [{ name: "builder", status: "working", now: null, run: "build-run" }],
      ...over,
    }),
  );
};

test.each([
  [
    "agent at work",
    { kind: "agent", state: "running", agent: "builder" },
    {},
    "terminal",
    ["tell", "note"],
  ],
  ["failed Step", { state: "failed" }, { state: "failed" }, "retry", ["note", "retry-noted"]],
  ["stopped Step", { state: "stopped" }, { state: "stopped" }, "retry", ["note", "retry-noted"]],
  [
    "open question",
    {
      kind: "question",
      state: "needs-you",
      questions: [{ name: "go", id: "go", open: true, asked: null, answered: null, by: null }],
      agent: "builder",
    },
    {},
    "answer",
    ["terminal"],
  ],
  [
    "pending proposal",
    { state: "needs-you", wait: "proposal" },
    { decision: { kind: "proposal", id: "p", hash: "h", text: "Proposed", actions: [] } },
    "proposal",
    ["note"],
  ],
  [
    "stalled agent",
    { state: "needs-you", wait: "stalled", agent: "builder" },
    {},
    "terminal",
    ["tell", "note"],
  ],
  [
    "parked agent",
    { state: "waiting", wait: "parked", agent: "builder" },
    {},
    "terminal",
    ["tell", "note"],
  ],
  ["held Step", { state: "waiting", wait: "hold" }, { held: "Held" }, "continue", ["note"]],
  ["done with agent open", { state: "done", agent: "builder" }, { state: "done" }, null, ["tell"]],
  ["release", { kind: "release", url: "https://forge/pipeline/1" }, {}, "open", []],
  [
    "merge request",
    { produces: "merge-request", url: "https://forge/mr/1" },
    {},
    "open",
    ["pause", "note"],
  ],
  [
    "linked Run",
    {
      kind: "link",
      link: { run: "child", machine: "laptop", state: "failed", said: null, canResume: true },
    },
    {},
    "open",
    ["retry"],
  ],
  [
    "primary offer",
    { id: "offer:next", kind: "offer" },
    { offer: { id: "next", title: "Next" } },
    "start",
    [],
  ],
] as const)("the Flow offers only what works for %s", (_title, node, over, primary, actions) => {
  const offered = acting(node, over).lanes[0]!.nodes[0]!;
  expect(offered.primary).toBe(primary);
  expect(offered.actions).toEqual([...actions]);
});

test.each([
  ["running cannot retry", { state: "failed" }, {}, ["note"]],
  ["agent gone", { state: "running", agent: "gone" }, {}, ["note"]],
  ["no hold", { state: "waiting", wait: "hold" }, {}, ["note"]],
  [
    "answered question",
    {
      kind: "question",
      state: "done",
      questions: [{ name: "go", id: "go", open: false, asked: null, answered: "then", by: "mk" }],
    },
    {},
    [],
  ],
  ["memory", { state: "waiting", wait: "memory", agent: "builder" }, {}, ["note"]],
  ["usage", { state: "waiting", wait: "usage", agent: "builder" }, {}, ["note"]],
  ["timer", { state: "waiting", wait: "timer" }, {}, ["note"]],
  ["check", { state: "waiting", wait: "check" }, {}, ["note"]],
  ["expected", { state: "expected", agent: "builder" }, {}, ["pause", "note"]],
  ["not run", { state: "not-run" }, {}, []],
] as const)("the Flow takes away actions when %s", (_title, node, over, actions) => {
  expect(acting(node, over).lanes[0]!.nodes[0]!).toMatchObject({
    primary: null,
    actions: [...actions],
  });
});

test("a Flow lane offers controls for its own state, and follow-up only on its leader", () => {
  expect(acting({ state: "running" }).lanes[0]!.actions).toEqual(["hold", "stop"]);
  expect(acting({ state: "waiting", wait: "hold" }, { held: "Held" }).lanes[0]!.actions).toEqual([
    "release",
    "stop",
  ]);
  expect(acting({ state: "failed" }, { state: "failed" }).lanes[0]!.actions).toEqual(["resume"]);
  const base = mainFlow();
  expect(flowActions(base, task({ run: "build-run", state: "done" })).lanes[0]!.actions).toEqual(
    [],
  );
  const done = {
    ...base,
    lanes: base.lanes.map((lane) => ({ ...lane, execution: "completed" as const })),
  };
  expect(flowActions(done, task({ run: "build-run", state: "done" })).lanes[1]!.actions).toEqual([
    "follow-up",
  ]);
});

test("a terminal workflow error cannot retry a Step through resume", () => {
  const base = mainFlow();
  const flow = {
    ...base,
    lanes: [
      {
        ...base.lanes[1]!,
        execution: "failed" as const,
        nodes: [flowNode("work", { state: "failed" })],
      },
    ],
  };
  expect(
    flowActions(flow, task({ run: "build-run", state: "failed" })).lanes[0]!.nodes[0]!.primary,
  ).toBeNull();
});

test.each([
  ["ci", "failed", "https://forge/pipeline/7"],
  ["merged", "stopped", "https://forge/mr/12"],
] as const)(
  "a forge Release node %s opens its address while its Run can resume",
  (id, state, url) => {
    const base = mainFlow();
    const flow = {
      ...base,
      release: [flowNode(id, { kind: "release", declared: false, state, url })],
    };
    const offered = flowActions(flow, task({ run: "build-run", state: "stopped" }));
    expect(offered.lanes[1]!.actions).toContain("resume");
    expect(offered.release![0]!).toMatchObject({ primary: "open", actions: [] });
  },
);

test("a Release node with no forge address offers no native Retry", () => {
  const base = mainFlow();
  const offered = flowActions(
    { ...base, release: [flowNode("ci", { kind: "release", declared: false, state: "failed" })] },
    task({ run: "build-run", state: "stopped" }),
  );
  expect(offered.release![0]!).toMatchObject({ primary: null, actions: [] });
});

test("a Step's reused agent stays addressable under another Run of the Task", () => {
  const offered = acting(
    { state: "running", agent: "builder" },
    { agents: [{ name: "builder", run: "another-run", status: "working", now: null }] },
  );
  expect(offered.lanes[0]!.nodes[0]!).toMatchObject({
    primary: "terminal",
    actions: ["tell", "note"],
  });
});

const MODULE = new URL("../src/board-model.ts", import.meta.url).pathname;
const RUNTIME_ONLY = /^(bun(:|$)|node:|@effect\/platform-bun|@opentui\/)/;

/** The module bundled for a browser, and every runtime-only import the bundle reached. */
const bundled = Effect.gen(function* () {
  const reached: string[] = [];
  const built = yield* Effect.promise(() =>
    Bun.build({
      entrypoints: [MODULE],
      target: "browser",
      format: "iife",
      plugins: [
        {
          name: "runtime-only",
          setup(build) {
            build.onResolve({ filter: RUNTIME_ONLY }, (args) => {
              reached.push(`${args.importer} imports ${args.path}`);
              return undefined;
            });
          },
        },
      ],
    }),
  );
  const errors = built.logs.filter((log) => log.level === "error");
  const code = built.success ? yield* Effect.promise(() => built.outputs[0]!.text()) : "";
  return { errors, reached, code };
});

test("the board model bundles for a browser without a Bun-only import", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { errors, reached, code } = yield* bundled;
      expect(errors).toEqual([]);
      expect(reached).toEqual([]);
      expect(code).not.toMatch(/\bBun\./);
    }),
  ));

test("loading the board model does nothing but define it", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const { code } = yield* bundled;
      // Only what a browser has that reaches nothing: process, timers, fetch or console at
      // load throws here. Bun's contexts carry a console of their own, so it is blanked.
      const sandbox = { TextEncoder, TextDecoder, console: undefined };
      expect(() => runInNewContext(code, sandbox)).not.toThrow();
      expect(Object.keys(sandbox)).toEqual(["TextEncoder", "TextDecoder", "console"]);
    }),
  ));

test("a TaskView carries its open questions, and one from an older host without them still decodes", () => {
  const question = {
    kind: "question" as const,
    run: "run-1",
    id: "c-1",
    step: "build",
    topic: "the branch",
    text: "Which branch?",
    options: [],
  };
  const older = {
    id: "task-1",
    name: "Pure board module",
    project: "/work/collie",
    state: "blocked",
    steps: [],
    sentence: "Waiting on your answer about the branch.",
    age: "2m",
    drift: null,
    held: null,
    heldBy: null,
    decision: question,
    agents: [],
    children: [],
    mr: null,
    branch: null,
    disposition: null,
    landed: false,
    ended: null,
    mrState: null,
    planReady: false,
    offer: null,
    run: "run-1",
    runs: ["run-1"],
    at: 1_700_000_000_000,
  };
  const decode = Schema.decodeUnknownSync(Schema.toCodecJson(TaskView));

  expect(decode(older).questions).toBeUndefined();
  const newer = { ...older, questions: [question, { ...question, id: "c-2" }] };
  expect(decode(JSON.parse(JSON.stringify(newer))).questions).toEqual(newer.questions);
});

test("a TaskView and a RunDetail survive a round trip through JSON", () => {
  const view: TaskView = {
    id: "task-1",
    name: "Pure board module",
    project: "/work/collie",
    state: "blocked",
    steps: [{ name: "build", state: "blocked" }],
    sentence: "Waiting on your answer about the branch.",
    age: "2m",
    drift: null,
    held: null,
    heldBy: null,
    decision: {
      kind: "question",
      run: "run-1",
      id: "c-1",
      step: "build",
      topic: "the branch",
      text: "Which branch?",
      options: [{ id: "main", title: "main", subtitle: null }],
    },
    agents: [{ name: "implementer", status: "working", now: null, run: "run-1" }],
    children: [{ repo: "api", run: null, state: "todo", mr: null }],
    mr: null,
    branch: "mk/board",
    disposition: null,
    landed: false,
    ended: null,
    mrState: "on-stage",
    planReady: false,
    offer: { id: "implement", title: "Implement it" },
    run: "run-1",
    runs: ["run-1"],
    at: 1_700_000_000_000,
  };
  const json = Schema.toCodecJson(TaskView);
  expect(Schema.decodeUnknownSync(json)(JSON.parse(JSON.stringify(view)))).toEqual(view);

  const detail: RunDetail = {
    id: "run-1",
    dir: "/state/runs/run-1",
    title: "Pure board module",
    status: "running",
    inputs: [{ name: "plan", value: "/plans/x", source: "flag" }],
    steps: [{ id: "build", status: "running", note: "", took: null, agents: ["implementer"] }],
    handoffs: [],
    intent: { goal: "One module", constraints: [] },
    review: { _tag: "None", reason: "no review yet" },
    plan: {
      spec: { _tag: "Text", text: "# Spec", truncated: false },
      tickets: [{ file: "01-a.md", title: "A", done: false }],
    },
    outputs: [{ step: "build", where: "out.json", state: "missing", text: "" }],
    tail: null,
    attention: { category: "none", reason: "running", explanation: "", actions: [] },
    outcome: {
      kind: null,
      gaps: [],
      obstacle: null,
      next: null,
      delivered: null,
      metrics: {
        timeToFirstEvidence: null,
        verifications: { pass: 0, fail: 0, unstable: 0, byCollie: 0 },
        slices: { done: 0, total: 1 },
        rework: 0,
        peakContext: null,
        halts: [],
        obstacles: [],
      },
    },
    finishedAt: 0,
    mr: { _tag: "Unavailable", reason: "no glab" },
    findings: [{ severity: "major", title: "Off by one", file: "a.ts", line: 3, detail: null }],
    verifications: [
      { id: "v1", name: "test", result: "pass", expect: "pass", exit: 0, at: "t", by: "collie" },
    ],
    steering: [],
    evidence: [{ name: "shot.png", bytes: 3 }],
    diff: {
      base: "abc",
      live: true,
      files: [{ path: "a.ts", status: "modified", added: 1, removed: null }],
    },
  };
  expect(
    Schema.decodeUnknownSync(Schema.toCodecJson(RunDetail))(JSON.parse(JSON.stringify(detail))),
  ).toEqual(detail);
});

const LAB = "gitlab.cego.dk/cego/app";
const HUB = "github.com/cego/collie";
const GITLAB_42 = {
  ref: { project: LAB, iid: "42" },
  target: `mr:${LAB}!42`,
  label: "cego/app!42",
  short: "app!42",
  url: `https://${LAB}/-/merge_requests/42`,
  noun: "merge request",
  checks: "pipeline",
  sign: "!",
};
const GITHUB_30 = {
  ref: { project: HUB, iid: "30" },
  target: `mr:${HUB}#30`,
  label: "cego/collie#30",
  short: "collie#30",
  url: `https://${HUB}/pull/30`,
  noun: "pull request",
  checks: "checks",
  sign: "#",
};

test.each([
  ["a GitLab target", `mr:${LAB}!42`, undefined, GITLAB_42],
  ["a GitLab URL", `https://${LAB}/-/merge_requests/42/diffs?tab=x`, undefined, GITLAB_42],
  ["a GitLab URL without its scheme", `${LAB}/-/merge_requests/42`, undefined, GITLAB_42],
  ["a typed !iid", "!42", { project: LAB }, GITLAB_42],
  ["a typed iid", " 42 ", { project: LAB }, GITLAB_42],
  ["a typed #iid in a GitLab checkout", "#42", { project: LAB }, GITLAB_42],
  ["a GitHub target", `mr:${HUB}#30`, undefined, GITHUB_30],
  ["a GitHub URL", `https://${HUB}/pull/30/files`, undefined, GITHUB_30],
  ["a typed #number", "#30", { project: HUB }, GITHUB_30],
  ["a typed number", "30", { project: HUB }, GITHUB_30],
  [
    "the old bare target",
    "mr:42",
    undefined,
    {
      ref: { project: null, iid: "42" },
      target: "mr:42",
      label: "42",
      short: "!42",
      url: null,
      noun: "merge request",
      checks: "pipeline",
      sign: "!",
    },
  ],
  ["GitHub's owner/repo#n", "cego/collie#30", undefined, GITHUB_30],
])("%s reads as one merge request and writes back", (_, text, typedIn, want) => {
  const ref = readMrRef(text, typedIn);
  expect(ref).toEqual(want.ref);
  const { ref: _ref, ...words } = want;
  expect(mrWords(ref!)).toEqual(words);
});

test.each([
  ["a URL on neither forge", "https://bitbucket.org/cego/app/pull-requests/3"],
  ["a pull URL off github.com", "https://example.com/cego/app/pull/3"],
  ["a GitHub URL that is not a pull request", `https://${HUB}/issues/3`],
  ["a target with no number", `mr:${LAB}`],
  ["a GitHub target written as GitLab's", `mr:${HUB}!30`],
  ["a GitLab target written as GitHub's", `mr:${LAB}#42`],
  ["a typed number nobody said was typed", "42"],
  ["a branch", "branch:main...x"],
])("%s is not a merge request", (_, text) => {
  expect(readMrRef(text)).toBeNull();
});

test.each([
  {
    mr: "https://github.com/cego/collie/pull/30",
    url: "https://github.com/cego/collie/pull/30",
    open: ["Open PR", "Open pull request"],
    ref: "collie#30",
  },
  {
    mr: "https://gitlab.cego.dk/cego/collie/-/merge_requests/151",
    url: "https://gitlab.cego.dk/cego/collie/-/merge_requests/151",
    open: ["Open MR", "Open merge request"],
    ref: "collie!151",
  },
])("a card offers to open $mr, and disposing of it records $ref", ({ mr, url, open, ref }) => {
  const waiting = task({ state: "done", landed: false, mr });
  const action = primaryAction(waiting);
  expect(action?.kind).toBe("open-mr");
  if (action?.kind !== "open-mr") return;
  expect(mrUrlOf(action.mr)).toBe(url);
  expect([openMrLabel(action.mr, true), openMrLabel(action.mr, false)]).toEqual([...open]);
  expect(cardActions(waiting).some((one) => one.kind === "open-mr")).toBe(true);
  expect(primaryAction({ ...waiting, mrState: "closed" })).toEqual({
    kind: "dispose",
    disposition: "superseded",
    ref,
  });
});

const MR = "mr:gitlab.example.com/mk/project!7";
const HEAD = "1a2b3c4d5e6f";
const mergeableNow = {
  succeeded: true,
  mr: MR,
  mrState: "open",
  draft: false,
  checks: { state: "passed", at: HEAD },
  ci: { state: "passed" },
  blocking: 0,
  mergeable: { state: "mergeable", said: "mergeable" },
} as const;

test("ready to release is mergeable now, and nothing is missing", () => {
  expect(readyToRelease(mergeableNow)).toEqual({ ready: true, missing: [] });
  // No pipeline at all is not a pipeline that has not passed.
  expect(readyToRelease({ ...mergeableNow, ci: { state: "none" } }).ready).toBe(true);
});

test("each fact ready to release needs is named when it is missing, and whether it may yet come", () => {
  const missing = (over: Partial<Parameters<typeof readyToRelease>[0]>) =>
    readyToRelease({ ...mergeableNow, ...over }).missing.map(({ fact, settling }) => [
      fact,
      settling,
    ]);
  expect(missing({ succeeded: false })).toEqual([["succeeded", false]]);
  expect(missing({ mr: null })).toEqual([["mr-open", false]]);
  expect(missing({ mrState: "merged" })).toEqual([["mr-open", false]]);
  expect(missing({ mrState: null })).toEqual([["mr-open", true]]);
  expect(missing({ draft: true })).toEqual([["not-draft", false]]);
  expect(missing({ checks: { state: "failed", name: "check", at: HEAD } })).toEqual([
    ["checks", false],
  ]);
  expect(missing({ checks: { state: "running" } })).toEqual([["checks", true]]);
  expect(missing({ checks: { state: "unchecked" } })).toEqual([["checks", false]]);
  expect(missing({ ci: { state: "failed", name: "lint" } })).toEqual([["ci", false]]);
  expect(missing({ ci: { state: "running" } })).toEqual([["ci", true]]);
  expect(missing({ ci: null })).toEqual([["ci", true]]);
  // A pipeline that exists and has not passed (canceled, manual, skipped, or of an older head).
  expect(missing({ ci: { state: "unknown" } })).toEqual([["ci", false]]);
  expect(missing({ blocking: 2 })).toEqual([["review", false]]);
  expect(missing({ mergeable: { state: "blocked", said: "not_approved" } })).toEqual([
    ["mergeable", false],
  ]);
  expect(missing({ mergeable: { state: "unknown", said: "checking" } })).toEqual([
    ["mergeable", true],
  ]);
  expect(missing({ mergeable: null })).toEqual([["mergeable", true]]);

  const said = readyToRelease({
    ...mergeableNow,
    ci: { state: "failed", name: "lint" },
    mergeable: { state: "blocked", said: "conflict" },
  }).missing.map((one) => one.said);
  expect(said).toEqual(["lint failed in CI", "the forge says it cannot merge: conflict"]);
});

test("one Run is ready only where it leads its card, and a Run on no card says whether one may come", () => {
  const ready = { ready: true, missing: [] };
  const card = task({ run: "r2", runs: ["r1", "r2"], ready: true, readiness: ready });
  expect(readinessOfRun("r2", card, true)).toEqual(ready);
  expect(readinessOfRun("r1", card, true)).toEqual({
    ready: false,
    missing: [{ fact: "leads", said: "r2 leads its Task now", settling: false }],
  });
  expect(readinessOfRun("r3", undefined, false).missing.map((one) => one.settling)).toEqual([true]);
  expect(readinessOfRun("r3", undefined, true).missing.map((one) => one.settling)).toEqual([false]);
});

test("an offer's text arguments are read as it declares them, null included, and none is added", () => {
  const drawn = {
    type: "object",
    properties: {
      note: { type: "string" },
      count: { anyOf: [{ type: "integer" }, { type: "null" }] },
      flag: { type: "boolean" },
    },
    required: ["note", "count", "flag"],
  };
  expect(givenOfferInput(drawn, { note: "null", count: "null" })).toEqual({
    note: "null",
    count: null,
  });
  expect(givenOfferInput(drawn, { count: "2", extra: "7" })).toEqual({ count: 2, extra: "7" });
});
