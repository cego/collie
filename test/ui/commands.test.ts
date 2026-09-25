// The Settings commands: what a value the human typed does to config.json, which is what
// every later Run reads its defaults from.

import type { BunServices } from "@effect/platform-bun/BunServices";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, PlatformError } from "effect";
import { Rig, type RigError } from "../support/recorder";
import { installBaseline } from "../support/engine";
import { installFakeSkills } from "../support/defs";
import { FakeBin, gitWorktreeCases } from "../support/bin";
import { runEffect } from "../support/effect";
import { runCommand, type ControlSession } from "../../src/flows";
import type { Jump } from "../../src/ui/state";
import { Herdr } from "../../src/herdr";
import { registerAgent, registryPath, scopeFor } from "../../src/registry";
import { loadDefaults, readConfig } from "../../src/config";
import type { RunFacts } from "../../src/runs";
import { madeRun } from "../support/records";
import { Path, FileSystem } from "effect";

let rig: Rig;
let bin: FakeBin;
/** The Runs the host would list. */
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
      // A skill nobody installed is a validation error, not a missing input, and every
      // workflow in these tests would fail on that before it could ask anything.
      yield* installFakeSkills(rig.root);
      // A Driver that exits at once: these tests are about what a command asks and what
      // it records, and a run that cannot start one bails with a notice that drowns both.
      bin = yield* FakeBin.make(`${rig.root}/bin`);
      yield* bin.add("stub-driver", "exit 0");
      // A mutating run resolves a branch before it starts, and the rig's project is not
      // a real checkout: this is the branch it is on and the default it cuts from.
      yield* bin.add(
        "git",
        `case "$*" in
      "rev-parse --abbrev-ref HEAD") echo feature ;;
      "symbolic-ref --short refs/remotes/origin/HEAD") echo origin/master ;;
${gitWorktreeCases(rig.projectDir)}
      *) exit 1 ;;
    esac`,
      );
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.restore();
      yield* rig.close();
    }),
  ),
);

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
  };
}

/** Nothing here asks the human anything; a prompt reached would be the bug. */
const prompts = {
  menu: () => Effect.succeed(null),
  ask: () => Effect.succeed(null),
};

const set = (key: string, value: string) =>
  runCommand(session(), rig.pluginEnv(), { _tag: "SetDefault", key, value }, prompts);

effectTest("a default given a value is written where loadDefaults reads it", function* () {
  const note = yield* set("harness", "codex");

  expect(note).toContain("codex");
  expect((yield* loadDefaults(rig.pluginEnv().userDir)).harness).toBe("codex");
});

effectTest("clearing a default unsets it rather than configuring an empty one", function* () {
  yield* set("harness", "codex");

  const note = yield* set("harness", "");

  // An empty harness is not a harness: every workflow validation would then fail on an
  // unknown one, while Settings showed the key as unset.
  expect(note).toContain("unset");
  expect(yield* readConfig(rig.pluginEnv().userDir)).not.toHaveProperty("harness");
  expect((yield* loadDefaults(rig.pluginEnv().userDir)).harness).toBe("claude");
});

effectTest(
  "permissions is refused unless it is a mode a Run can start an agent with",
  function* () {
    // Written, it would fail every later `loadDefaults` — including the Settings view
    // that would be used to put it right.
    const note = yield* set("permissions", "yolo");

    expect(note).toContain("auto, harness");
    expect(yield* readConfig(rig.pluginEnv().userDir)).not.toHaveProperty("permissions");
    expect(yield* set("permissions", "harness")).toContain("harness");
    expect((yield* loadDefaults(rig.pluginEnv().userDir)).permissions).toBe("harness");
  },
);

effectTest("scope is refused unless it is a board the tab can open on", function* () {
  // The board has to open on one of the two, and a tab that opened on nothing would
  // be the first thing a human tried to fix in this very view.
  const note = yield* set("scope", "everything");

  expect(note).toContain("local, all");
  expect(yield* readConfig(rig.pluginEnv().userDir)).not.toHaveProperty("scope");
  expect(yield* set("scope", "all")).toContain("all");
  expect((yield* loadDefaults(rig.pluginEnv().userDir)).scope).toBe("all");
});

effectTest("a default is written without the whitespace around it", function* () {
  // `codex ` is displayed as `codex` and then fails harness validation, because the
  // trim was only ever used for the checks and the original string was written.
  const note = yield* set("harness", "  codex  ");

  expect(note).toBe("harness is now codex");
  expect((yield* loadDefaults(rig.pluginEnv().userDir)).harness).toBe("codex");
});

/** One run of another workspace, with an agent, a tab and whatever else a test needs. */
const elsewhere = Effect.fn("commands.elsewhere")(function* (opts: {
  workspaceId: string;
  status?: "running" | "done";
  /** What it was pointed at, and the checkout it was working in. */
  target?: string;
  cwd?: string;
}) {
  const env = rig.pluginEnv();
  const run = yield* madeRun(env.stateDir, {
    id: `implement-glass-${runs.length + 1}`,
    cwd: opts.cwd ?? env.cwd,
    workspace: opts.workspaceId,
    state: opts.status === "done" ? "succeeded" : "running",
    settled: { inputs: opts.target ? { target: opts.target } : {}, strategies: {} },
  });
  runs = [run, ...runs];
  // Its agent, registered in the pane herdr opened for it.
  yield* registerAgent(yield* registryPath(env.stateDir, scopeFor(env, run.cwd)), {
    role: "implementer",
    agent: "impl-9",
    paneId: "w9:p1",
    workspaceId: opts.workspaceId,
    runId: run.id,
    workflow: run.workflow,
    at: "2026-09-14T10:00:00Z",
  });
  return run;
});

const jump = (jump: Jump) =>
  runCommand(session(), rig.pluginEnv(), { _tag: "Jump", jump }, prompts);

effectTest("Enter goes where the row points, in one call, and says where it went", function* () {
  yield* rig.startSocket();
  const run = yield* elsewhere({ workspaceId: "w9" });

  // A workspace row: whatever tab that workspace was last on, and nothing else.
  expect(yield* jump({ kind: "workspace", workspaceId: "w9", label: "Implement · glass" })).toBe(
    "went to Implement · glass",
  );
  expect(yield* rig.cmds()).toEqual(["workspace.focus"]);

  // A run row: its newest agent, resolved from the register now rather than from an id
  // the board cached when it drew the row.
  expect(yield* jump({ kind: "run", runId: run.id, label: "Implement · glass" })).toBe(
    "went to Implement · glass",
  );
  const focused = (yield* rig.calls()).filter((c) => c.cmd === "agent focus");
  expect(focused.map((c) => c.argv!.at(-1))).toEqual(["impl-9"]);

  // An agent row: by name, which selects the workspace, the tab and the pane at once.
  expect(yield* jump({ kind: "agent", agent: "impl-9", label: "Implementer" })).toBe(
    "went to Implementer",
  );
  expect((yield* rig.calls()).filter((c) => c.cmd === "agent focus")).toHaveLength(2);
});

effectTest("Enter on an Elsewhere row says so and asks herdr nothing", function* () {
  yield* rig.startSocket();

  const note = yield* jump({ kind: "none", label: "Elsewhere · collie-mr-roles-wt" });

  expect(note).toContain("nothing to jump to");
  expect(yield* rig.cmds()).toEqual([]);
});

effectTest("w on another workspace's run opens its merge request, not this repo's", function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // An unqualified target, which is what every run recorded before merge requests
  // carried their project: `glab` resolves the project from the directory it is run
  // in, so the run's own checkout is the only cwd that names the right one.
  const checkout = path.join(rig.root, "another-checkout");
  yield* fs.makeDirectory(checkout, { recursive: true });
  const run = yield* elsewhere({ workspaceId: "w9", target: "mr:42", cwd: checkout });
  const marker = path.join(rig.root, "glab-cwd.txt");
  yield* bin.add("glab", `pwd > ${JSON.stringify(marker)}`);

  const note = yield* runCommand(
    session(),
    rig.pluginEnv(),
    { _tag: "OpenMr", target: "mr:42", runId: run.id },
    prompts,
  );

  expect(note).toContain("opened");
  expect((yield* fs.readFileString(marker)).trim()).toBe(checkout);
});

effectTest("questions is refused unless it is a way of presenting one", function* () {
  const note = yield* set("questions", "shout");

  expect(note).toContain("focus, notify");
  expect(yield* readConfig(rig.pluginEnv().userDir)).not.toHaveProperty("questions");
  expect(yield* set("questions", "notify")).toContain("notify");
  expect((yield* loadDefaults(rig.pluginEnv().userDir)).questions).toBe("notify");
});
