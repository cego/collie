// The rules that keep the merge-request panel from ruining the app: nothing fetches in a
// render path, nothing fetches for a list, one selection is one call, and a re-selection
// inside the TTL is none.

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
import type { Runner } from "../../src/mr";
import type { RunFacts } from "../../src/runs";
import { madeRun } from "../support/records";
import { recordDisposition } from "../../src/disposition";
import { writeMrStates } from "../../src/merges";
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
    configDir: env.configDir,
    paneId: env.paneId,
    pluginRoot: env.pluginRoot,
    runsOf: () => Effect.succeed(runs),
  };
}

/** The board's reads, over the Runs this test made rather than a host's. */
const appOver = (run: Runner) => appState(session(), rig.pluginEnv(), run);

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
  const asked = glab();
  const app = appOver(asked.run);

  const state = yield* app.load(focus({ view: "history", shown: ["runs", "history"] }));

  expect(state.history).toHaveLength(40);
  // Every row could show a badge; none of them is worth forty subprocesses to draw.
  expect(asked.views()).toEqual([]);
});

effectTest("selecting one run reads one merge request, and re-selecting reads none", function* () {
  const [first, second] = yield* seedMany(2);
  const asked = glab();
  const app = appOver(asked.run);

  yield* app.load(focus({ selected: `run:${first}` }));
  expect(asked.views()).toHaveLength(1);

  // The same merge request, inside the TTL: the cache answers and glab is not asked.
  yield* app.load(focus({ selected: `run:${first}` }));
  expect(asked.views()).toHaveLength(1);

  // A different one is a different ref, so it is read.
  yield* app.load(focus({ selected: `run:${second}` }));
  expect(asked.views()).toHaveLength(2);

  // And a re-read can be asked for, which is what the cache makes necessary.
  yield* app.load(focus({ selected: `run:${second}`, nonce: 1 }));
  expect(asked.views()).toHaveLength(3);
});

effectTest("a History selection reads the merge request its own row carries", function* () {
  // The board keeps five finished runs; History keeps two hundred, from every session
  // that ran here. A selection from the older part of that list is the case the board's
  // own two lists cannot answer.
  const ids = yield* seedMany(8);
  const oldest = ids[0]!;
  const asked = glab();
  const app = appOver(asked.run);

  const state = yield* app.load(
    focus({ view: "history", shown: ["runs", "history"], selected: `run:${oldest}` }),
  );

  // The precondition, asserted rather than assumed: this row is only in History.
  expect([...state.board.active, ...state.board.recent].map((r) => r.id)).not.toContain(oldest);
  expect(state.history?.map((r) => r.id)).toContain(oldest);
  // And the panel is filled, because the row carries the target it is filled from.
  expect(state.detail?.mr?._tag).toBe("Details");
  expect(asked.views()).toHaveLength(1);
});

effectTest("a run whose target is not a merge request has no panel and no call", function* () {
  const run = yield* made({
    workflow: "review",
    state: "succeeded",
    settled: { inputs: { target: "worktree" }, strategies: { target: "diff-target" } },
  });
  const asked = glab();
  const app = appOver(asked.run);

  const state = yield* app.load(focus({ selected: `run:${run.id}` }));

  expect(state.detail?.mr).toBeNull();
  expect(asked.views()).toEqual([]);
});

effectTest("a view nobody has opened is not read at all", function* () {
  yield* seedMany(3);
  const asked = glab();
  const app = appOver(asked.run);

  const state = yield* app.load(focus());

  // The laziness is in the state: History, Workflows and Settings cost nothing until
  // they are shown, which is what keeps opening the tab cheap.
  expect(state.history).toBeNull();
  expect(state.definitions).toBeNull();
  expect(state.settings).toBeNull();
});

effectTest("a glab that writes a notice to stderr is still read as a merge request", function* () {
  // glab writes non-fatal notices — a new version, a host warning — to stderr and still
  // exits 0. Folding those into the output made a merge request that had just been read
  // successfully report as "not a merge request", and the bad answer was then cached for
  // the whole TTL. Every other glab call in this repo that parses JSON ignores stderr.
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
  const quiet = yield* mrDetails(ref, rig.projectDir, (cmd, args, cwd) => shell(cmd, args, cwd));
  const noisy = yield* mrDetails(ref, rig.projectDir, (cmd, args, cwd) =>
    shell(cmd, args, cwd, "say"),
  );

  yield* bin.restore();

  expect(quiet._tag).toBe("Details");
  // And this is the failure the default was changed away from, pinned so the reason
  // cannot be forgotten: with stderr folded in, the same read is unreadable.
  expect(noisy).toEqual({
    _tag: "Unavailable",
    reason: "what glab said about gitlab.example.com/g/p!1 is not a merge request",
  });
});

effectTest("a card outside the legacy lists still fills its own record", function* () {
  // The board's five finished rows are not what a Task is: a card can name a Run neither
  // list holds, and its record used to come back as the whole Herd's evidence.
  const ids = yield* seedMany(8);
  const oldest = ids[0]!;
  const asked = glab();
  const app = appOver(asked.run);

  const state = yield* app.load(focus({ selected: `run:${oldest}` }));

  expect([...state.board.active, ...state.board.recent].map((r) => r.id)).not.toContain(oldest);
  expect(state.live?.run).toBe(oldest);
  expect(state.detail?.mr?._tag).toBe("Details");
});

effectTest("the merge request a Run opened is the one its record details", function* () {
  const run = yield* made({
    workflow: "implement",
    mr: "https://gitlab.example.com/g/p/-/merge_requests/7",
  });
  const asked = glab();
  const app = appOver(asked.run);

  // An implement Run's merge request is what it produced, not what it was pointed at.
  const state = yield* app.load(focus({ selected: `run:${run.id}` }));

  expect(state.detail?.mr?._tag).toBe("Details");
  expect(asked.views()).toHaveLength(1);
});

effectTest("selecting a card on the board keeps the merge request it opened", function* () {
  const run = yield* made({
    workflow: "implement",
    mr: "https://gitlab.example.com/g/p/-/merge_requests/7",
  });
  const asked = glab();
  const app = appOver(asked.run);

  // A click is a Selection change and nothing else, so the scan is reused. The row it
  // lands on carries no merge request of its own: the Run's record is what has one.
  yield* app.load(focus());
  const state = yield* app.load(focus({ selected: `run:${run.id}` }));

  expect([...state.board.active, ...state.board.recent].map((r) => r.id)).toContain(run.id);
  expect(state.detail?.mr?._tag).toBe("Details");
});
