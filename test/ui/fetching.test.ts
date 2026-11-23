import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Option from "effect/Option";
import type { PlatformServices } from "../../src/platform";
import type { Records } from "../../src/records";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { PlatformError } from "effect";
import { Effect, Layer } from "effect";
import { Rig } from "../support/recorder";
import type { RigError } from "../support/recorder";
import { installBaseline } from "../support/engine";
import { runEffect } from "../support/effect";
import { FakeBin } from "../support/bin";
import { forgeHttpOnPath, forgeHttpOver, storedAnswers } from "../support/forge";
import { appState } from "../../src/flows";
import type { ControlSession } from "../../src/flows";
import { shell } from "../../src/mr";
import { mrDetails } from "../../src/forge/gitlab";
import { Herdr } from "../../src/herdr";
import { scopeFor } from "../../src/registry";
import type { RunFacts } from "../../src/runs";
import { madeRun } from "../support/records";
import { recordDisposition } from "../../src/disposition";
import { MERGE_POLL_MS, mrOf, watchedMr } from "../../src/merges";
import type { MrPanels } from "../../src/merges";
import { focus } from "../support/focus";
import { runDetail } from "../support/run-detail";
import { task } from "../support/task";
import { appendDrift } from "../../src/drift";
import { stringifyJson } from "../../src/json";

let rig: Rig;
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
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

const MR_JSON = stringifyJson({
  iid: 1,
  title: "one",
  state: "opened",
  updated_at: "2026-09-02T11:00:00.000Z",
});

function glab() {
  const calls: Array<Array<string>> = [];
  const run = (cmd: string, args: Array<string>) => {
    calls.push([cmd, ...args]);
    if (cmd !== "glab") {
      return Effect.succeed({ code: 1, stdout: "" });
    }
    if (args[0] === "--version") {
      return Effect.succeed({ code: 0, stdout: "glab 1.40" });
    }
    if (args[0] === "auth") {
      return Effect.succeed({ code: 0, stdout: "ok" });
    }
    return Effect.succeed({ code: 0, stdout: MR_JSON });
  };
  return {
    run,
    views: () =>
      Arr.filter(calls, (c) => c[1] === "api" && /\/merge_requests\/\d+$/.test(c.at(-1)!)),
  };
}

function session() {
  const env = rig.pluginEnv();
  const returned: ControlSession = {
    herdr: new Herdr(env),
    ...scopeFor(env.cwd),
    stateDir: env.stateDir,
    userDir: env.userDir,
    pluginRoot: env.pluginRoot,
    runsOf: () => Effect.succeed(runs),
    recordsOf: () => Effect.succeed({ tasks: [], registered: [] }),
    ledgers: {
      overridden: Effect.succeed(new Set()),
      deliveriesOf: () => Effect.succeed([]),
      proposals: () => Effect.succeed([]),
    },
    tasksOf: () => Effect.succeed({ tasks: [], unreadable: null }),
    detailOf: () => Effect.succeed(null),
  };
  return returned;
}

const app = () => appState(session(), rig.pluginEnv());

const watched = (
  run: RunFacts,
  asked: ReturnType<typeof glab>,
  over: { panels?: MrPanels; now?: number; fresh?: boolean } = {},
) => {
  const target = mrOf(run);
  return target === null
    ? Effect.succeed(null)
    : watchedMr({
        stateDir: rig.pluginEnv().stateDir,
        panels: over.panels ?? new Map(),
        target,
        cwd: rig.projectDir,
        run: asked.run,
        now: over.now ?? 0,
        fresh: over.fresh ?? false,
      }).pipe(Effect.provide(forgeHttpOver(asked.run)));
};

const made = Effect.fn("fetching.made")(function* (over: Partial<RunFacts>) {
  const env = rig.pluginEnv();
  const at = `2026-09-02T10:${pipe_(String(runs.length), Str.padStart(2, "0"))}:00.000Z`;
  const run = yield* madeRun(env.stateDir, {
    id: `r${runs.length + 1}`,
    project: env.cwd,
    cwd: env.cwd,
    workspace: null,
    created: at,
    ...over,
  });
  runs = [run, ...runs];
  return run;
});

const seedMany = Effect.fn("fetching.seedMany")(function* (count: number) {
  const env = rig.pluginEnv();
  const ids: Array<string> = [];
  for (let n = 1; n <= count; n++) {
    const run = yield* made({
      workflow: "review",
      state: "succeeded",
      finished: `2026-09-02T11:${pipe_(String(n), Str.padStart(2, "0"))}:00.000Z`,
      settled: {
        inputs: { target: `mr:gitlab.example.com/g/p!${n}` },
        strategies: { target: "diff-target" },
      },
    });
    // WARNING: disposed, so the background merge watch asks GitLab nothing and every counted glab call is the selection's own.
    yield* recordDisposition(run.dir, {
      at: run.created,
      by: "test",
      kind: "merged",
      ref: `!${n}`,
      note: null,
    });
    ids.push(run.id);
  }
  yield* storedAnswers(
    env.stateDir,
    new Map(Arr.map(ids, (_, at) => [`g/p!${at + 1}`, "in-prod"])),
  );
  return ids;
});

effectTest("a History of forty merge-request runs draws with no glab call at all", function* () {
  yield* seedMany(40);
  const state = yield* app().load(focus({ view: "history", shown: ["runs", "history"] }));

  expect(state.history).toHaveLength(40);
});

effectTest(
  "the merge watch reads one merge request once a poll, and again when asked",
  function* () {
    const [first, second] = yield* seedMany(2);
    const runOf = (id: string) =>
      Option.getOrUndefined(Arr.findFirst(runs, (run) => run.id === id))!;
    const asked = glab();
    const panels: MrPanels = new Map();

    yield* watched(runOf(first!), asked, { panels });
    expect(asked.views()).toHaveLength(1);

    yield* watched(runOf(first!), asked, { panels, now: MERGE_POLL_MS - 1 });
    expect(asked.views()).toHaveLength(1);

    yield* watched(runOf(second!), asked, { panels });
    expect(asked.views()).toHaveLength(2);

    yield* watched(runOf(second!), asked, { panels, fresh: true });
    expect(asked.views()).toHaveLength(3);
  },
);
effectTest("a run whose target is not a merge request has no panel and no call", function* () {
  const run = yield* made({
    workflow: "review",
    state: "succeeded",
    settled: { inputs: { target: "worktree" }, strategies: { target: "diff-target" } },
  });
  const asked = glab();

  expect(yield* watched(run, asked)).toBeNull();
  expect(asked.views()).toEqual([]);
});

effectTest("a view nobody has opened is not read at all", function* () {
  yield* seedMany(3);

  const state = yield* app().load(focus());

  // WARNING: the laziness is in the state; History, Workflows and Settings cost nothing until shown.
  expect(state.history).toBeNull();
  expect(state.definitions).toBeNull();
  expect(state.settings).toBeNull();
});

effectTest("a glab that writes a notice to stderr is still read as a merge request", function* () {
  const bin = yield* FakeBin.make(`${rig.root}/bin`);
  yield* bin.add(
    "glab",
    Arr.join(
      [
        `if [ "$1" = "--version" ]; then echo "glab 1.115.0"; exit 0; fi`,
        `if [ "$1" = "auth" ]; then echo ok; exit 0; fi`,
        `echo "A new version of glab is available" >&2`,
        `printf '%s' '${MR_JSON}'`,
      ],
      "\n",
    ),
  );

  const ref = { project: "gitlab.example.com/g/p", iid: "1" };
  const details = yield* mrDetails(ref, rig.projectDir, shell).pipe(
    Effect.provide(Layer.fresh(forgeHttpOnPath)),
  );

  yield* bin.restore();

  expect(details._tag).toBe("Details");
});

effectTest("a card outside the legacy lists still fills its own record", function* () {
  // WARNING: a card can name a Run neither list holds, and its record must not come back as the whole Herd's evidence.
  const ids = yield* seedMany(8);
  const oldest = ids[0]!;
  const run = Option.getOrThrow(Arr.findFirst(runs, (one) => one.id === oldest));
  yield* appendDrift(run.dir, {
    id: "oldest-drift",
    run: oldest,
    at: run.created,
    intent_version: 1,
    constraint: "keep this older Run's evidence visible",
    kind: "rule",
    severity: "warn",
    evidence: [],
    evidence_truncated: false,
    resolution: "open",
  });
  const detail = runDetail({ id: oldest, dir: run.dir, title: "The oldest Run's record" });
  const source = session();
  source.tasksOf = () =>
    Effect.succeed({ tasks: [task({ run: oldest, runs: [oldest] })], unreadable: null });
  source.detailOf = (key) => Effect.succeed(key?.runId === oldest ? detail : null);
  const state = yield* appState(source, rig.pluginEnv()).load(focus({ selected: `run:${oldest}` }));

  expect(state.detail).toEqual(detail);
  expect(state.live?.run).toBe(oldest);
  expect(Arr.map(state.live?.drift ?? [], (one) => one.id)).toEqual(["oldest-drift"]);
});

effectTest("the merge request a Run opened is the one its record details", function* () {
  const run = yield* made({
    workflow: "implement",
    mr: "https://gitlab.example.com/g/p/-/merge_requests/7",
  });
  const asked = glab();

  // WARNING: an implement Run's merge request is what it produced, not what it was pointed at.
  expect((yield* watched(run, asked))?._tag).toBe("Details");
  expect(asked.views()).toHaveLength(1);
});
