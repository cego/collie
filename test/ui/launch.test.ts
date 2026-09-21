// The launch flow, end to end, through the prompts a component answers. This is what the
// popup pane and the tab both run: the flow is a sequence of `menu`/`ask` calls, and a
// scripted answerer stands in for the human so the whole sequence can be asserted.

import type { BunServices } from "@effect/platform-bun/BunServices";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { ConfigProvider, Effect, Fiber, FileSystem, Layer, PlatformError } from "effect";
import { Rig, type RigError } from "../support/recorder";
import { installBaseline } from "../support/engine";
import { installFakeSkills, writeDef } from "../support/defs";
import { FakeBin } from "../support/bin";
import { runEffect } from "../support/effect";
import { layers } from "../../src/definitions";
import { forkFlow, pickFlow, resumeFlow } from "../../src/flows";
import { Herdr } from "../../src/herdr";
import { RunStore } from "../../src/run";
import { homePath, writeHome } from "../../src/home";
import { herdDir, herdOf } from "../../src/steering";
import { signalPrompts, type Pending } from "../../src/ui/prompts";

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
      yield* installFakeSkills(rig.root);
      bin = yield* FakeBin.make(`${rig.root}/bin`);
      yield* bin.add("glab", "exit 1");
      yield* bin.add("git", "echo main");
      // A Driver that does nothing: this is about what the flow asks and records.
      yield* bin.add("stub-driver", "exit 0");
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

/**
 * Answers each question in turn with what the script says, and records what it was
 * asked. `null` is an Esc. Running out of script is a cancel, so a flow that asks one
 * more question than expected fails the test rather than hanging it.
 */
const answering = Effect.fn("launch.answering")(function* (
  script: ReadonlyArray<string | null>,
  body: (
    prompts: ReturnType<typeof signalPrompts>["prompts"],
  ) => Effect.Effect<number, PlatformError.PlatformError | Error, BunServices>,
) {
  const { prompts, pending } = signalPrompts();
  const asked: string[] = [];
  const answers = [...script];

  // A Driver that exits at once: these tests are about what the flow asks and records,
  // not about the Run being executed.
  const flow = yield* Effect.forkChild(
    Effect.provide(
      body(prompts),
      Layer.succeed(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromUnknown({ COLLIE_DRIVER: `${rig.root}/bin/stub-driver` }),
      ),
    ),
  );
  const answer = (question: Pending) => {
    asked.push(question.ask.header);
    question.answer(answers.length > 0 ? (answers.shift() ?? null) : null);
  };
  // Answers whatever is on screen until the flow is finished with it.
  for (let tries = 0; tries < 2_000; tries++) {
    const question = pending();
    if (question) answer(question);
    const done = flow.pollUnsafe();
    if (done !== undefined) return { code: yield* done, asked, left: answers.length };
    yield* Effect.sleep("2 millis");
  }
  yield* Fiber.interrupt(flow);
  return yield* Effect.fail(new Error(`the flow never finished; it asked ${asked.join(" | ")}`));
});

const env = () => rig.pluginEnv();

effectTest("the launch flow asks for the workflow and its Inputs, and nothing else", function* () {
  // A Choice step is not a launch question any more: it is asked when the run reaches it.
  yield* writeDef(
    rig.baselineDir,
    "workflows",
    "goalful",
    `---
name: goalful
title: goalful — needs a goal and a decision
inputs:
  goal: goal
steps:
  - id: build
    persona: implementer
    output: build.json
  - id: next
    choices:
      - title: Stop here
        stop: true
      - title: Stop here too
        stop: true
---
## build

Do {{inputs.goal}}.
`,
  );

  const { code, asked, left } = yield* answering(["goalful", "Add a picker"], (prompts) =>
    pickFlow(new Herdr(env()), env(), prompts),
  );

  expect(code).toBe(0);
  expect(left).toBe(0);
  // Workflow, then the Input — and the run starts, with the Choice left for the Driver.
  expect(asked).toEqual(["Workflows — " + env().cwd, "What is the goal?"]);

  const runs = yield* new RunStore(env().stateDir).list();
  expect(runs).toHaveLength(1);
  expect(runs[0]!.record.workflow).toBe("goalful");
  expect(runs[0]!.record.inputs.goal).toBe("Add a picker");
  expect(runs[0]!.record.decisions).toEqual({});
});

effectTest("the picker asks visibly for a GitLab repository URL", function* () {
  yield* writeDef(
    rig.baselineDir,
    "workflows",
    "accept-url",
    `---
name: accept-url
title: accept-url — update dependencies
inputs:
  repository: gitlab-repository
steps:
  - id: update
    persona: implementer
    output: update.json
---
## update

Update dependencies.
`,
  );

  const url = "https://gitlab.example.com/acme/app";
  const { asked } = yield* answering(["accept-url", url], (prompts) =>
    pickFlow(new Herdr(env()), env(), prompts),
  );

  expect(asked).toEqual(["Workflows — " + env().cwd, "GitLab repository URL or local checkout"]);
  const [run] = yield* new RunStore(env().stateDir).list();
  expect(run?.record.inputs.repository).toBe(url);
});

effectTest("a branch nothing names is worked out, and the picker never asks for one", function* () {
  // `implement` by name: that is the workflow Collie knows changes the repository, and
  // so the one that needs a branch before it can start.
  yield* writeDef(
    rig.baselineDir,
    "workflows",
    "implement",
    `---
name: implement
checkout: branch
title: implement — needs somewhere to work
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

  // Too long to slug, so nothing the run was given names a branch short enough to be
  // one — which used to be a question put to whoever was standing at the picker.
  const goal = "Fix the parser so a diff of two refs with no branch on either side works";
  const { asked } = yield* answering(["implement", goal], (prompts) =>
    pickFlow(new Herdr(env()), env(), prompts),
  );

  // The workflow and its goal, and no branch: it is generated from the task and the
  // operator's own GitLab login. This rig's git makes no checkouts, so what is left
  // is the refusal that follows — and it names the branch that was decided on.
  expect(asked.slice(0, 2)).toEqual(["Workflows — " + env().cwd, "What is the goal?"]);
  expect(asked.some((question) => question.toLowerCase().includes("branch"))).toBe(false);
  expect(asked.at(-1)).toContain("could not be given a checkout");
  expect(yield* new RunStore(env().stateDir).list()).toHaveLength(0);
});

effectTest("a launch inline in the tab leaves the session's popup alone", function* () {
  yield* rig.startSocket();
  yield* writeDef(
    rig.baselineDir,
    "workflows",
    "simple",
    `---
name: simple
title: simple — nothing to ask
steps:
  - id: build
    persona: implementer
    output: build.json
---
## build

Do it.
`,
  );

  const inline = yield* answering(["simple"], (prompts) =>
    pickFlow(new Herdr(env()), env(), prompts, "inline"),
  );
  expect(inline.code).toBe(0);
  // The popup belongs to whatever herdr had focused, which is not this tab.
  expect(yield* rig.cmds()).not.toContain("popup.close");

  const popup = yield* answering(["simple"], (prompts) =>
    pickFlow(new Herdr(env()), env(), prompts),
  );
  expect(popup.code).toBe(0);
  expect(yield* new RunStore(env().stateDir).list()).toHaveLength(2);
  expect(yield* rig.cmds()).toContain("popup.close");
});

effectTest("cancelling at any question starts nothing", function* () {
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

  for (const script of [[null], ["goalful", null]]) {
    const { code } = yield* answering(script, (prompts) =>
      pickFlow(new Herdr(env()), env(), prompts),
    );
    expect(code).toBe(0);
    expect(yield* new RunStore(env().stateDir).list()).toEqual([]);
  }
});
effectTest("forking asks what, where and how, and writes what it was told", function* () {
  const fs = yield* FileSystem.FileSystem;
  const layerList = yield* layers(env());

  const full = yield* answering(["workflow:review", "user", "full"], (prompts) =>
    forkFlow(new Herdr(env()), env(), prompts),
  );

  expect(full.code).toBe(0);
  expect(full.asked[0]).toContain("Fork a definition");
  expect(full.asked[1]).toContain("into");
  expect(full.asked[2]).toContain("how");
  // The last question is the notice, and it carries the message `src/fork.ts` produced.
  expect(full.asked.at(-1)).toContain("review");
  const copy = `${layerList.user.dir}/workflows/review.md`;
  expect(yield* fs.exists(copy)).toBe(true);
  // A full copy stops following the original, so it is not an `extends:` stub.
  expect(yield* fs.readFileString(copy)).not.toContain("extends: review");

  // The other layer and the other mode: an `extends:` stub over one named step.
  const stub = yield* answering(["workflow:review", "project", "extends", "review"], (prompts) =>
    forkFlow(new Herdr(env()), env(), prompts),
  );

  expect(stub.code).toBe(0);
  expect(stub.asked[3]).toContain("Which step");
  const extended = `${layerList.project.dir}/workflows/review.md`;
  expect(yield* fs.readFileString(extended)).toContain("extends: review");
});

effectTest("a fork over one that is already there is refused, in fork.ts's words", function* () {
  const fs = yield* FileSystem.FileSystem;
  const layerList = yield* layers(env());
  // A fork never overwrites the one you have already edited.
  yield* fs.makeDirectory(`${layerList.user.dir}/workflows`, { recursive: true });
  yield* fs.writeFileString(`${layerList.user.dir}/workflows/review.md`, "mine\n");

  const { code, asked } = yield* answering(["workflow:review", "user", "full"], (prompts) =>
    forkFlow(new Herdr(env()), env(), prompts),
  );

  expect(code).toBe(1);
  // The flow says what `src/fork.ts` said rather than deciding again itself.
  expect(asked.at(-1)).toContain("already");
  expect(yield* fs.readFileString(`${layerList.user.dir}/workflows/review.md`)).toBe("mine\n");
});

effectTest("resume offers only runs with unfinished steps", function* () {
  const store = new RunStore(env().stateDir);
  const unfinished = yield* store.create({
    workflow: "review",
    cwd: env().cwd,
    session: env().socketPath,
    workspace: env().workspaceId,
    workspaceLabel: "test",
    inputs: {},
    inputSources: {},
    stepIds: ["review", "synthesize"],
    maxIterations: 1,
    namedAfter: "unfinished",
  });
  unfinished.record.status = "blocked";
  unfinished.record.steps[0]!.status = "done";
  yield* unfinished.save();

  const finished = yield* store.create({
    workflow: "review",
    cwd: env().cwd,
    session: env().socketPath,
    workspace: env().workspaceId,
    workspaceLabel: "test",
    inputs: {},
    inputSources: {},
    stepIds: ["review"],
    maxIterations: 1,
    namedAfter: "finished",
  });
  finished.record.status = "done";
  finished.record.steps[0]!.status = "done";
  yield* finished.save();

  // Esc at the list: what matters here is which runs it was offered.
  const { asked } = yield* answering([null], (prompts) =>
    resumeFlow(new Herdr(env()), env(), prompts),
  );

  expect(asked[0]).toBe("Resume a run");
});

effectTest("a launch from the Home asks which checkout the work is in", function* () {
  // The Home is Collie's own workspace and its directory is the Herd's namespace: a Run
  // rooted there would have nothing to work on, so the checkout is the first question.
  // The launch asks herdr which workspaces there are, so there has to be one to ask.
  yield* rig.startSocket();
  const at = env();
  const key = yield* herdOf(at.socketPath);
  const namespaceDir = yield* herdDir(at.stateDir, key);
  yield* writeHome(yield* homePath(at.stateDir, key), {
    workspaceId: "home",
    tabId: "home:1",
    paneId: "home-1",
    terminalId: "t-home-1",
    createdAt: "2026-09-10T10:00:00.000Z",
    token: key,
    state: "ready",
    previous: [],
  });
  yield* rig.addWorkspace("home", "🐕 Collie", namespaceDir);
  yield* rig.addWorkspace("w2", "collie · main", rig.projectDir);
  yield* writeDef(
    rig.baselineDir,
    "workflows",
    "goalful",
    `---
name: goalful
title: goalful
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

  const inHome = { ...at, workspaceId: "home", cwd: namespaceDir };
  const { code, asked } = yield* answering(
    // Answered by row id; an open workspace's row is named after the workspace herdr
    // has, and picking it picks that workspace's directory, not the Run's workspace.
    ["goalful", "ws:w2", "Add a picker"],
    (prompts) => pickFlow(new Herdr(inHome), inHome, prompts),
  );

  expect(code).toBe(0);
  expect(asked).toEqual(["Workflows — " + namespaceDir, "Which checkout?", "What is the goal?"]);
  // And rooted there rather than in Collie's own namespace.
  const runs = yield* new RunStore(at.stateDir).list();
  expect(runs).toHaveLength(1);
  expect(runs[0]!.record.cwd).toBe(rig.projectDir);
});

effectTest("a launch from a Home with nothing open takes the checkout as a path", function* () {
  // The whole point of the row: a fresh Task opens a workspace of its own whatever it
  // was launched from, so the only thing missing from the Home is the directory — and
  // requiring one already be open meant a repo nobody had opened could start nothing.
  yield* rig.startSocket();
  const at = env();
  const key = yield* herdOf(at.socketPath);
  const namespaceDir = yield* herdDir(at.stateDir, key);
  yield* writeHome(yield* homePath(at.stateDir, key), {
    workspaceId: "home",
    tabId: "home:1",
    paneId: "home-1",
    terminalId: "t-home-1",
    createdAt: "2026-09-10T10:00:00.000Z",
    token: key,
    state: "ready",
    previous: [],
  });
  yield* rig.addWorkspace("home", "🐕 Collie", namespaceDir);
  yield* writeDef(
    rig.baselineDir,
    "workflows",
    "goalful",
    `---
name: goalful
title: goalful
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

  const inHome = { ...at, workspaceId: "home", cwd: namespaceDir };
  const { code, asked } = yield* answering(
    ["goalful", "new", rig.projectDir, "Add a picker"],
    (prompts) => pickFlow(new Herdr(inHome), inHome, prompts),
  );

  expect(code).toBe(0);
  expect(asked).toEqual([
    "Workflows — " + namespaceDir,
    "Which checkout?",
    "Which checkout? Type the path to the project.",
    "What is the goal?",
  ]);
  const runs = yield* new RunStore(at.stateDir).list();
  expect(runs).toHaveLength(1);
  expect(runs[0]!.record.cwd).toBe(rig.projectDir);
});
