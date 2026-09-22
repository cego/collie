// The Settings commands: what a value the human typed does to config.json, which is what
// every later Run reads its defaults from.

import type { BunServices } from "@effect/platform-bun/BunServices";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { ConfigProvider, Effect, Layer, PlatformError } from "effect";
import { Rig, type RigError } from "../support/recorder";
import { installBaseline } from "../support/engine";
import { installFakeSkills, writeDef } from "../support/defs";
import { FakeBin, gitWorktreeCases } from "../support/bin";
import { runEffect } from "../support/effect";
import { runCommand, type ControlSession } from "../../src/flows";
import type { Jump } from "../../src/ui/state";
import { Herdr } from "../../src/herdr";
import { registerAgent, registryPath, scopeFor, scopeOfRun } from "../../src/registry";
import { loadDefaults, readConfig } from "../../src/config";
import { RunStore } from "../../src/run";
import { REVIEW_FILE } from "../../src/output";
import { Path, FileSystem } from "effect";

let rig: Rig;
let bin: FakeBin;

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

/** With a Driver the runs can actually start, which is how the picker's own tests run. */
const withDriver = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provide(
    effect,
    Layer.succeed(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({ COLLIE_DRIVER: `${rig.root}/bin/stub-driver` }),
    ),
  );

function session(): ControlSession {
  const env = rig.pluginEnv();
  return {
    herdr: new Herdr(env),
    ...scopeFor(env, env.cwd),
    stateDir: env.stateDir,
    configDir: env.configDir,
    paneId: env.paneId,
    pluginRoot: env.pluginRoot,
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
  expect((yield* loadDefaults(rig.pluginEnv().configDir)).harness).toBe("codex");
});

effectTest("clearing a default unsets it rather than configuring an empty one", function* () {
  yield* set("harness", "codex");

  const note = yield* set("harness", "");

  // An empty harness is not a harness: every workflow validation would then fail on an
  // unknown one, while Settings showed the key as unset.
  expect(note).toContain("unset");
  expect(yield* readConfig(rig.pluginEnv().configDir)).not.toHaveProperty("harness");
  expect((yield* loadDefaults(rig.pluginEnv().configDir)).harness).toBe("claude");
});

effectTest(
  "permissions is refused unless it is a mode a Run can start an agent with",
  function* () {
    // Written, it would fail every later `loadDefaults` — including the Settings view
    // that would be used to put it right.
    const note = yield* set("permissions", "yolo");

    expect(note).toContain("bypass, harness");
    expect(yield* readConfig(rig.pluginEnv().configDir)).not.toHaveProperty("permissions");
    expect(yield* set("permissions", "harness")).toContain("harness");
    expect((yield* loadDefaults(rig.pluginEnv().configDir)).permissions).toBe("harness");
  },
);

effectTest("scope is refused unless it is a board the tab can open on", function* () {
  // The board has to open on one of the two, and a tab that opened on nothing would
  // be the first thing a human tried to fix in this very view.
  const note = yield* set("scope", "everything");

  expect(note).toContain("local, all");
  expect(yield* readConfig(rig.pluginEnv().configDir)).not.toHaveProperty("scope");
  expect(yield* set("scope", "all")).toContain("all");
  expect((yield* loadDefaults(rig.pluginEnv().configDir)).scope).toBe("all");
});

/** A finished run of this session, with a review beside it only if one is asked for. */
const seed = Effect.fn("commands.seed")(function* (opts: {
  target: string;
  review?: string;
  /** A finding left open, which is what makes "fix what is open" something to offer. */
  outstanding?: ReadonlyArray<{ severity: string; title: string }>;
}) {
  const env = rig.pluginEnv();
  const run = yield* new RunStore(env.stateDir).create({
    workflow: "review",
    cwd: env.cwd,
    session: env.socketPath,
    workspace: env.workspaceId,
    workspaceLabel: "test",
    inputs: { target: opts.target },
    inputSources: {},
    inputStrategies: { target: "diff-target" },
    stepIds: ["review"],
    maxIterations: 1,
    namedAfter: opts.target,
  });
  run.record.status = "done";
  run.record.finished_at = run.record.created_at;
  if (opts.outstanding) run.record.outstanding = [...opts.outstanding];
  yield* run.save();
  if (opts.review !== undefined) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.writeFileString(path.join(run.dir, REVIEW_FILE), opts.review);
  }
  return run;
});

effectTest("send review acts on the run it names, and says so when it cannot", function* () {
  const withReview = yield* seed({ target: "worktree", review: "# Review\n" });
  // Newer than the one with a review, and without one of its own: the hand-off used to
  // take whichever review was newest, so a selection with nothing to send silently sent
  // another run's review.
  const selected = yield* seed({ target: "mr:gitlab.example.com/g/p!7" });
  // The two runs have to be tellable apart in the note, which names the slug.
  expect(selected.record.slug).not.toBe(withReview.record.slug);

  const note = yield* runCommand(
    session(),
    rig.pluginEnv(),
    { _tag: "SendReview", runId: selected.id },
    prompts,
  );

  expect(note).toContain(selected.record.slug);
  expect(note).toContain(`no ${REVIEW_FILE} to send`);
  expect(note).not.toContain(withReview.record.slug);
});

effectTest("a default is written without the whitespace around it", function* () {
  // `codex ` is displayed as `codex` and then fails harness validation, because the
  // trim was only ever used for the checks and the original string was written.
  const note = yield* set("harness", "  codex  ");

  expect(note).toBe("harness is now codex");
  expect((yield* loadDefaults(rig.pluginEnv().configDir)).harness).toBe("codex");
});

effectTest("send review with no run selected sends nothing at all", function* () {
  // `s` is on the footer in every View, so it is pressed with a Settings or Workflows
  // row selected: that must not start a fix round for whichever review is newest.
  yield* seed({ target: "worktree", review: "# Review\n" });

  const note = yield* runCommand(
    session(),
    rig.pluginEnv(),
    { _tag: "SendReview", runId: null },
    prompts,
  );

  expect(note).toBe("select the run whose review should be sent");
});

effectTest("the log opens for a History row the board no longer keeps", function* () {
  yield* rig.startSocket();
  // The board keeps five finished runs; History keeps two hundred, and every History
  // row offers `l`. The sixth-oldest must not answer "has gone" while its run directory
  // and its runner.log are both still there — whichever list the row was drawn from.
  const oldest = yield* seed({ target: "mr:gitlab.example.com/g/p!1" });
  for (const n of [2, 3, 4, 5, 6, 7, 8]) {
    yield* seed({ target: `mr:gitlab.example.com/g/p!${n}` });
  }

  const note = yield* runCommand(
    session(),
    rig.pluginEnv(),
    { _tag: "OpenLog", runId: oldest.id },
    prompts,
  );

  expect(note).not.toContain("has gone");
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
  const run = yield* new RunStore(env.stateDir).create({
    workflow: "implement",
    cwd: opts.cwd ?? env.cwd,
    session: env.socketPath,
    workspace: opts.workspaceId,
    workspaceLabel: null,
    inputs: opts.target ? { target: opts.target } : {},
    inputSources: {},
    stepIds: ["build"],
    maxIterations: 5,
    namedAfter: "glass",
  });
  run.record.target_label = "glass";
  run.record.status = opts.status ?? "running";
  run.step("build").status = opts.status === "done" ? "done" : "running";
  run.step("build").variants.push({
    harness: "claude",
    model: "opus",
    effort: null,
    permissions: null,
    agent: "impl-9",
    label: "implement-glass/build",
    tabId: "w9:t2",
    paneId: "w9:p1",
    status: "running",
    output: null,
    error: null,
    repairs: [],
    nudges: 0,
  });
  yield* run.save();
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

  // A run row: the tab of its newest agent, resolved from the run now rather than from
  // an id the board cached when it drew the row.
  expect(yield* jump({ kind: "run", runId: run.id, label: "Implement · glass" })).toBe(
    "went to Implement · glass",
  );
  const focused = (yield* rig.calls()).filter((c) => c.cmd === "tab focus");
  expect(focused.map((c) => c.argv!.at(-1))).toEqual(["w9:t2"]);

  // An agent row: by name, which selects the workspace, the tab and the pane at once.
  expect(yield* jump({ kind: "agent", agent: "impl-9", label: "Implementer" })).toBe(
    "went to Implementer",
  );
  expect((yield* rig.calls()).filter((c) => c.cmd === "agent focus")).toHaveLength(1);
});

effectTest("Enter on an Elsewhere row says so and asks herdr nothing", function* () {
  yield* rig.startSocket();

  const note = yield* jump({ kind: "none", label: "Elsewhere · collie-mr-roles-wt" });

  expect(note).toContain("nothing to jump to");
  expect(yield* rig.cmds()).toEqual([]);
});

effectTest("a run in another workspace is stopped and logged from the wide board", function* () {
  yield* rig.startSocket();
  yield* rig.addWorkspace("w9", "Implement · glass", rig.projectDir);
  const run = yield* elsewhere({ workspaceId: "w9" });
  // The register its Driver wrote: keyed by the Run's own session, workspace and
  // checkout, which is not the one this board is in.
  const env = rig.pluginEnv();
  yield* registerAgent(yield* registryPath(env.stateDir, scopeOfRun(run.record)), {
    role: "implementer",
    agent: "impl-9",
    paneId: "w9:p1",
    workspaceId: "w9",
    runId: run.id,
    workflow: "implement",
    at: "t",
  });

  // The board of this workspace does not list it, so the lookup used to answer "has
  // gone" for a run whose row the human was looking at.
  const stopped = yield* runCommand(
    session(),
    rig.pluginEnv(),
    { _tag: "StopRun", runId: run.id },
    prompts,
  );
  expect(stopped).not.toContain("has gone");
  // And its agents are stopped, not just its Driver: closing the panes they are in is
  // the only thing that does that, and they are in another workspace's register.
  expect(
    (yield* rig.calls()).filter((c) => c.cmd === "pane close").map((c) => c.argv!.at(-1)),
  ).toEqual(["w9:p1"]);
  const logged = yield* runCommand(
    session(),
    rig.pluginEnv(),
    { _tag: "OpenLog", runId: run.id },
    prompts,
  );
  expect(logged).not.toContain("has gone");
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

/** A prompts that answers from a script and records every header it was shown. */
function scripted(answers: ReadonlyArray<string | null>) {
  const asked: string[] = [];
  const left = [...answers];
  const next = () => (left.length > 0 ? (left.shift() ?? null) : null);
  return {
    asked,
    left: () => left.length,
    prompts: {
      menu: (items: ReadonlyArray<{ id: string; title: string }>, opts: { header: string }) => {
        asked.push(opts.header);
        const answer = next();
        return Effect.succeed(
          answer === null ? null : (items.find((i) => i.id === answer) ?? null),
        );
      },
      ask: (question: string) => {
        asked.push(question);
        return Effect.succeed(next());
      },
    },
  };
}

effectTest("a workflow run from a row asks for its own inputs, in the tab", function* () {
  yield* writeDef(
    rig.baselineDir,
    "workflows",
    "goalful",
    `---
name: goalful
title: goalful — needs a goal
inputs:
  goal: goal
steps:
  - id: build
    persona: implementer
    output: build.json
---
## build

Do {{inputs.goal}}.
`,
  );
  const { asked, prompts: scriptedPrompts } = scripted(["Add a picker"]);

  yield* withDriver(
    runCommand(
      session(),
      rig.pluginEnv(),
      { _tag: "RunWorkflow", workflow: "goalful" },
      scriptedPrompts,
    ),
  );

  // The row already named the workflow, so the only question is its Input. Asking
  // "which workflow?" again could start a different one from the row that was clicked,
  // and it asked in a pane of its own rather than in the tab.
  expect(asked).toEqual(["What is the goal?"]);
  const runs = yield* new RunStore(rig.pluginEnv().stateDir).list();
  expect(runs.map((r) => r.record.workflow)).toEqual(["goalful"]);
  expect(runs[0]!.record.inputs.goal).toBe("Add a picker");
});

effectTest("a workflow run from a row with nothing to ask starts straight away", function* () {
  // `architecture` needs no Input and its one Choice is asked when the Run reaches it,
  // so there is nothing between the click and the Run.
  const { asked, prompts: scriptedPrompts } = scripted([]);

  yield* withDriver(
    runCommand(
      session(),
      rig.pluginEnv(),
      { _tag: "RunWorkflow", workflow: "architecture" },
      scriptedPrompts,
    ),
  );

  expect(asked).toEqual([]);
  const runs = yield* new RunStore(rig.pluginEnv().stateDir).list();
  expect(runs.map((r) => r.record.workflow)).toEqual(["architecture"]);
  expect(runs[0]!.record.decisions).toEqual({});
});

effectTest("a fix round is not asked again for the plan the row settled", function* () {
  const reviewed = yield* seed({
    target: "worktree",
    review: "# Review\n",
    outstanding: [{ severity: "blocker", title: "the empty list" }],
  });
  const { asked, prompts: scriptedPrompts } = scripted([]);

  yield* withDriver(
    runCommand(
      session(),
      rig.pluginEnv(),
      { _tag: "InvokeOffer", runId: reviewed.id, offer: "fix-open" },
      scriptedPrompts,
    ),
  );

  // The row named the work source by being clicked; asking for it again would let the
  // answer contradict the row, and `implement` has no Choice step to decide either.
  expect(asked).toEqual([]);
  const runs = yield* new RunStore(rig.pluginEnv().stateDir).list();
  const started = runs.find((r) => r.record.workflow === "implement");
  if (!started) throw new Error("expected an implement run");
  expect(started.record.inputs.plan).toBe(reviewed.dir);
  // The review is the spec and its findings are the tickets: `implement`'s build step
  // branches on the kind, so a run dir with a review in it has to arrive classified.
  expect(started.record.inputs.plan_kind).toBe("review");
  // Traceable both ways, using the same fields a chained Run uses.
  expect(started.record.parent).toBe(reviewed.id);
  const parent = yield* new RunStore(rig.pluginEnv().stateDir).load(reviewed.id);
  expect(parent.record.children).toContain(started.id);
});

effectTest("reviewing a target again names it, classified, and asks nothing", function* () {
  const { asked, prompts: scriptedPrompts } = scripted([]);
  // The offer is the review Workflow's own, and the target comes off the Run it is made
  // about rather than out of the row that drew the key.
  const reviewed = yield* seed({ target: "mr:gitlab.example.com/g/p!12", review: "# Review\n" });

  yield* withDriver(
    runCommand(
      session(),
      rig.pluginEnv(),
      { _tag: "InvokeOffer", runId: reviewed.id, offer: "run-again" },
      scriptedPrompts,
    ),
  );

  // Nothing to paste: the row carried the target, and `review`'s own Choice is asked
  // when the Run reaches it rather than before it exists.
  expect(asked).toEqual([]);
  const runs = yield* new RunStore(rig.pluginEnv().stateDir).list();
  const started = runs.find((r) => r.record.workflow === "review");
  expect(started?.record.inputs.target).toBe("mr:gitlab.example.com/g/p!12");
  expect(started?.record.inputs.target_kind).toBe("mr");
  expect(started?.record.decisions).toEqual({});
});

effectTest("questions is refused unless it is a way of presenting one", function* () {
  const note = yield* set("questions", "shout");

  expect(note).toContain("focus, notify");
  expect(yield* readConfig(rig.pluginEnv().configDir)).not.toHaveProperty("questions");
  expect(yield* set("questions", "notify")).toContain("notify");
  expect((yield* loadDefaults(rig.pluginEnv().configDir)).questions).toBe("notify");
});

effectTest("a run that finished inside the stop's grace is not stopped after it", function* () {
  yield* rig.addWorkspace("w9", "Implement · glass", rig.projectDir);
  // Over by the time the five seconds were up, which is the race the grace opens: the
  // board asked for a stop on a run that was still going when it was asked for.
  const run = yield* elsewhere({ workspaceId: "w9" });
  run.record.status = "failed";
  yield* run.save();

  const note = yield* runCommand(
    session(),
    rig.pluginEnv(),
    { _tag: "StopRun", runId: run.id },
    prompts,
  );

  expect(note).toContain("finished on its own");
  // Nothing was signalled and nothing was written: no inbox entry, no stopped marker.
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  expect(yield* fs.exists(path.join(run.dir, "stopped"))).toBe(false);
  expect(yield* fs.exists(path.join(run.dir, "inbox"))).toBe(false);
});
