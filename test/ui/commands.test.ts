// The Settings commands: what a value the human typed does to config.json, which is what
// every later Run reads its defaults from.

import type { BunServices } from "@effect/platform-bun/BunServices";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { ConfigProvider, Effect, Layer, PlatformError } from "effect";
import { Rig, type RigError } from "../support/recorder";
import { installBaseline } from "../support/engine";
import { installFakeSkills, writeDef } from "../support/defs";
import { FakeBin } from "../support/bin";
import { runEffect } from "../support/effect";
import { runCommand, type ControlSession } from "../../src/flows";
import { Herdr } from "../../src/herdr";
import { scopeFor } from "../../src/registry";
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

/** A finished run of this session, with a review beside it only if one is asked for. */
const seed = Effect.fn("commands.seed")(function* (opts: { target: string; review?: string }) {
  const env = rig.pluginEnv();
  const run = yield* new RunStore(env.stateDir).create({
    workflow: "review",
    cwd: env.cwd,
    session: env.socketPath,
    workspace: env.workspaceId,
    workspaceLabel: "test",
    inputs: { target: opts.target },
    inputSources: {},
    stepIds: ["review"],
    maxIterations: 1,
    primaryInput: opts.target,
  });
  run.record.status = "done";
  run.record.finished_at = run.record.created_at;
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
  // The board keeps five finished runs; History keeps two hundred. Every History row
  // offers `l`, so the sixth-oldest must not answer "has gone" while its run directory
  // and its runner.log are both still there.
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

effectTest("a workflow run from a row is asked its decisions before it starts", function* () {
  // `architecture` needs no Input and has one Choice step, which is the case that used to
  // start a Run with no decisions at all and then stop at that Choice hours later — the
  // opposite of deciding upfront, and the whole point of answering at launch.
  const { asked, prompts: scriptedPrompts } = scripted(["Stop here"]);

  yield* withDriver(
    runCommand(
      session(),
      rig.pluginEnv(),
      { _tag: "RunWorkflow", workflow: "architecture" },
      scriptedPrompts,
    ),
  );

  expect(asked).toEqual(["architecture — next"]);
  const runs = yield* new RunStore(rig.pluginEnv().stateDir).list();
  expect(runs.map((r) => r.record.workflow)).toEqual(["architecture"]);
  expect(runs[0]!.record.decisions).toEqual({ next: "Stop here" });
});

effectTest("a fix round is not asked again for the plan the row settled", function* () {
  const reviewed = yield* seed({ target: "worktree", review: "# Review\n" });
  const { asked, prompts: scriptedPrompts } = scripted([]);

  yield* withDriver(
    runCommand(
      session(),
      rig.pluginEnv(),
      { _tag: "FixFindings", runId: reviewed.id },
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

effectTest(
  "reviewing a target again names it, classified, and asks only the decision",
  function* () {
    const { asked, prompts: scriptedPrompts } = scripted(["Fix findings"]);

    yield* withDriver(
      runCommand(
        session(),
        rig.pluginEnv(),
        { _tag: "ReviewAgain", target: "mr:gitlab.example.com/g/p!12" },
        scriptedPrompts,
      ),
    );

    // Nothing to paste: the row carried the target. The one question is `review`'s own
    // Choice, which is answered before the Run exists rather than hours into it.
    expect(asked).toEqual(["review — post"]);
    const runs = yield* new RunStore(rig.pluginEnv().stateDir).list();
    const started = runs.find((r) => r.record.workflow === "review");
    expect(started?.record.inputs.target).toBe("mr:gitlab.example.com/g/p!12");
    expect(started?.record.inputs.target_kind).toBe("mr");
    expect(started?.record.decisions).toEqual({ post: "Fix findings" });
  },
);
