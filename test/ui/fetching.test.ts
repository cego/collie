// The rules that keep the merge-request panel from ruining the app: the app fetches
// nothing at all, and the host's merge watch reads one merge request once per poll, again
// only when asked to.

import type { BunServices } from "@effect/platform-bun/BunServices";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, PlatformError } from "effect";
import { Rig, type RigError } from "../support/recorder";
import { installBaseline } from "../support/engine";
import { runEffect } from "../support/effect";
import { FakeBin } from "../support/bin";
import { appState, type ControlSession } from "../../src/flows";
import { mrDetails, shell } from "../../src/mr";
import { Herdr } from "../../src/herdr";
import { scopeFor } from "../../src/registry";
import type { RunFacts } from "../../src/runs";
import { madeRun } from "../support/records";
import { recordDisposition } from "../../src/disposition";
import { mrOf } from "../../src/board";
import { MERGE_POLL_MS, watchedMr, writeMrStates, type MrPanels } from "../../src/merges";
import { focus } from "../support/focus";

let rig: Rig;
/** The Runs the host would list, newest first. */
let runs: RunFacts[] = [];

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
      runs = [];
      yield* installBaseline(rig);
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

const MR_JSON = JSON.stringify({
  iid: 1,
  title: "one",
  state: "opened",
  updated_at: "2026-09-02T11:00:00.000Z",
});

/** A glab that answers about any merge request, and counts what it was asked. */
function glab() {
  const calls: string[][] = [];
  const run = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    if (cmd !== "glab") return Effect.succeed({ code: 1, stdout: "" });
    if (args[0] === "--version") return Effect.succeed({ code: 0, stdout: "glab 1.40" });
    if (args[0] === "auth") return Effect.succeed({ code: 0, stdout: "ok" });
    return Effect.succeed({ code: 0, stdout: MR_JSON });
  };
  return { run, views: () => calls.filter((c) => c[0] === "glab" && c[1] === "mr") };
}

function session(): ControlSession {
  const env = rig.pluginEnv();
  return {
    herdr: new Herdr(env),
    ...scopeFor(env, env.cwd),
    stateDir: env.stateDir,
    userDir: env.userDir,
    paneId: env.paneId,
    pluginRoot: env.pluginRoot,
    runsOf: () => Effect.succeed(runs),
    tasksOf: () => Effect.succeed({ tasks: [], unreadable: null }),
    detailOf: () => Effect.succeed(null),
  };
}

/** The board's reads, over the Runs this test made rather than a host's. */
const app = () => appState(session(), rig.pluginEnv());

/** What the merge watch reads for this Run's drawer, through a glab that counts. */
const watched = (
  run: RunFacts,
  asked: ReturnType<typeof glab>,
  over: { panels?: MrPanels; now?: number; fresh?: boolean } = {},
) => {
  const target = mrOf(run);
  return target === null
    ? Effect.succeed(null)
    : watchedMr({
        panels: over.panels ?? new Map(),
        target,
        cwd: rig.projectDir,
        run: asked.run,
        now: over.now ?? 0,
        fresh: over.fresh ?? false,
      });
};

/** A Run of this workspace, remembered as the newest the host would list. */
const made = Effect.fn("fetching.made")(function* (over: Partial<RunFacts>) {
  const env = rig.pluginEnv();
  const at = `2026-09-02T10:${String(runs.length).padStart(2, "0")}:00.000Z`;
  const run = yield* madeRun(env.stateDir, {
    id: `r${runs.length + 1}`,
    project: env.cwd,
    cwd: env.cwd,
    workspace: env.workspaceId,
    created: at,
    ...over,
  });
  runs = [run, ...runs];
  return run;
});

/** Forty finished Runs, every one of them over a merge request. */
const seedMany = Effect.fn("fetching.seedMany")(function* (count: number) {
  const env = rig.pluginEnv();
  const ids: string[] = [];
  for (let n = 1; n <= count; n++) {
    const run = yield* made({
      workflow: "review",
      state: "succeeded",
      finished: `2026-09-02T11:${String(n).padStart(2, "0")}:00.000Z`,
      settled: {
        inputs: { target: `mr:gitlab.example.com/g/p!${n}` },
        strategies: { target: "diff-target" },
      },
    });
    // Disposed of, so the background merge watch has nothing to ask GitLab about and
    // every `glab` call counted below is the selection's own.
    yield* recordDisposition(run.dir, {
      at: run.created,
      by: "test",
      kind: "merged",
      ref: `!${n}`,
      note: null,
    });
    ids.push(run.id);
  }
  // And in production, as far as a merge can go: the watch that follows a merged card to
  // its deploy jobs has nothing left to ask about these either.
  yield* writeMrStates(env.stateDir, new Map(ids.map((_, at) => [`g/p!${at + 1}`, "in-prod"])));
  return ids;
});

effectTest("a History of forty merge-request runs draws with no glab call at all", function* () {
  yield* seedMany(40);
  const state = yield* app().load(focus({ view: "history", shown: ["runs", "history"] }));

  // Every row could show a badge; none of them is worth forty subprocesses to draw, and
  // the app asks GitLab nothing: the drawer's panel is the host's.
  expect(state.history).toHaveLength(40);
});

effectTest(
  "the merge watch reads one merge request once a poll, and again when asked",
  function* () {
    const [first, second] = yield* seedMany(2);
    const runOf = (id: string) => runs.find((run) => run.id === id)!;
    const asked = glab();
    const panels: MrPanels = new Map();

    yield* watched(runOf(first!), asked, { panels });
    expect(asked.views()).toHaveLength(1);

    // The same merge request, inside the poll: what the watch read answers.
    yield* watched(runOf(first!), asked, { panels, now: MERGE_POLL_MS - 1 });
    expect(asked.views()).toHaveLength(1);

    // A different one is a different ref, so it is read.
    yield* watched(runOf(second!), asked, { panels });
    expect(asked.views()).toHaveLength(2);

    // And a re-read can be asked for, which is what `R` in the drawer does.
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

  // The laziness is in the state: History, Workflows and Settings cost nothing until
  // they are shown, which is what keeps opening the tab cheap.
  expect(state.history).toBeNull();
  expect(state.definitions).toBeNull();
  expect(state.settings).toBeNull();
});

effectTest("a glab that writes a notice to stderr is still read as a merge request", function* () {
  // glab writes non-fatal notices — a new version, a host warning — to stderr and still
  // exits 0. Read as part of the answer, they made a merge request that had just been
  // read successfully report as "not a merge request", cached for the whole TTL.
  const bin = yield* FakeBin.make(`${rig.root}/bin`);
  yield* bin.add(
    "glab",
    [
      `if [ "$1" = "--version" ]; then echo "glab 1.115.0"; exit 0; fi`,
      `if [ "$1" = "auth" ]; then echo ok; exit 0; fi`,
      `echo "A new version of glab is available" >&2`,
      `printf '%s' '${MR_JSON}'`,
    ].join("\n"),
  );

  const ref = { project: "gitlab.example.com/g/p", iid: "1" };
  const details = yield* mrDetails(ref, rig.projectDir, shell);

  yield* bin.restore();

  expect(details._tag).toBe("Details");
});

effectTest("a card outside the legacy lists still fills its own record", function* () {
  // The board's five finished rows are not what a Task is: a card can name a Run neither
  // list holds, and its record used to come back as the whole Herd's evidence.
  const ids = yield* seedMany(8);
  const oldest = ids[0]!;
  const state = yield* app().load(focus({ selected: `run:${oldest}` }));

  expect([...state.board.active, ...state.board.recent].map((r) => r.id)).not.toContain(oldest);
  expect(state.live?.run).toBe(oldest);
});

effectTest("the merge request a Run opened is the one its record details", function* () {
  const run = yield* made({
    workflow: "implement",
    mr: "https://gitlab.example.com/g/p/-/merge_requests/7",
  });
  const asked = glab();

  // An implement Run's merge request is what it produced, not what it was pointed at.
  expect((yield* watched(run, asked))?._tag).toBe("Details");
  expect(asked.views()).toHaveLength(1);
});
