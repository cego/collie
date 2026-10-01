// The board's model is imported by a browser bundle as well as by the host, so it must
// bundle for a browser and load in a context that has no runtime to reach.

import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { Effect, Schema } from "effect";
import { RunDetail, TaskView } from "../src/board-model";

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
  };
  expect(
    Schema.decodeUnknownSync(Schema.toCodecJson(RunDetail))(JSON.parse(JSON.stringify(detail))),
  ).toEqual(detail);
});
