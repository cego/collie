import { Clock, DateTime } from "effect";
import { nowIso } from "../src/time";
import { COLLIE_TAB } from "../src/naming";
import { readEnv } from "../src/env";

/** A Date this far back, without reaching for the global clock. */
const dateFromMillis = (milliseconds: number) =>
  DateTime.toDateUtc(DateTime.makeUnsafe(milliseconds));
import type { BunServices } from "@effect/platform-bun";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  Config,
  ConfigProvider,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Path,
  PlatformError,
  Scope,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { FakeHerdr, Rig } from "./support/recorder";
import { FakeBin } from "./support/bin";
import { installBaseline, runWorkflow, scriptedPrompts } from "./support/engine";
import { writeDef } from "./support/defs";
import {
  acquireDriver,
  answerChoice,
  appendProgress,
  CHOICE,
  CHOICE_ANSWER,
  driverAlive,
  filePrompts,
  lastProgress,
  readChoice,
  readProgress,
  clearPreviousDriver,
  releaseDriver,
  stoppedBefore,
  STOPPED,
  RUNNER_LOG,
  RUNNER_PID,
  stopDriver,
  writeChoice,
} from "../src/driver";
import { answerKey, openLog } from "../src/flows";
import { driverCommand, spawnDriver } from "../src/operations";
import type { HerdrError } from "../src/herdr";
import { processStartTime } from "../src/lock";
import type { Asking, RunRow, WorkspaceView } from "../src/workspace";
import { askingRun, buildView, renderWorkspace } from "../src/workspace";
import { scopeFor } from "../src/registry";
import { RunStore } from "../src/run";
import { runEffect } from "./support/effect";

let rig: Rig;

const SOLO = `---
name: solo
title: solo — one step
inputs:
  goal: goal
steps:
  - id: solo
    persona: planner
    output: solo.json
---
Do the thing for {{inputs.goal}}.
`;

const CHOOSE = `---
name: choose
title: choose — one menu
inputs:
  goal: goal
steps:
  - id: next
    choices:
      - title: Stop here
        stop: true
      - title: Carry on
        stop: true
---
Goal: {{inputs.goal}}
`;

const CLEAN = { verdict: "clean", findings: [] };

interface InboxAnswer {
  type: "answer";
  requestId: string;
  choiceId: string;
  answer: string;
}

type TestError =
  | Config.ConfigError
  | Error
  | HerdrError
  | PlatformError.PlatformError
  | readonly [string, ...string[]];
type TestServices = BunServices.BunServices | Scope.Scope;
type TestEffect = Effect.Effect<unknown, TestError, TestServices>;

const effectTest = (
  name: string,
  body: () => Generator<TestEffect, void, unknown>,
  timeout?: number,
) => test(name, () => runEffect(Effect.gen(body).pipe(Effect.scoped)), timeout);

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      yield* rig.startSocket();
      yield* installBaseline(rig);
      yield* writeDef(rig.baselineDir, "workflows", "solo", SOLO);
      yield* writeDef(rig.baselineDir, "workflows", "choose", CHOOSE);
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

const board = Effect.fn("test.board")(function* (now?: number) {
  const env = rig.pluginEnv();
  return yield* buildView({
    ...scopeFor(env, env.cwd),
    workspaceLabel: "test",
    stateDir: env.stateDir,
    alive: [],
    now,
  });
});

const configLayer = (driver?: string) =>
  ConfigProvider.layer(
    ConfigProvider.fromUnknown(driver === undefined ? {} : { COLLIE_DRIVER: driver }),
  );

const currentPid = Effect.sync(() => globalThis.process.pid);
const fakeHerdrFail = '{"agent prompt":"no such agent"}';

effectTest("a review is one run tab of agent panes, and the plugin keeps one pane", function* () {
  yield* rig.queueOutputs([CLEAN, CLEAN, { ...CLEAN, summary: "nothing to fix", dropped: [] }]);

  const { run, status } = yield* runWorkflow(
    rig,
    "review",
    {},
    {
      prompts: scriptedPrompts(["Don't post"]),
    },
  );

  expect(status).toBe("done");
  // One tab for the run — the reviewers' — plus the Collie tab's, and no pane of
  // the run's own anywhere: no runner pane to move, swap or name.
  const cmds = yield* rig.cmds();
  const calls = yield* rig.calls();
  expect(cmds.filter((c) => c === "tab create")).toHaveLength(1);
  for (const cmd of ["pane move", "pane swap"]) expect(cmds).not.toContain(cmd);
  expect(calls.filter((c) => c.cmd === "plugin pane")).toHaveLength(1);
  const panes = calls.filter((c) => c.cmd === "pane rename").map((c) => c.argv?.at(-1));
  expect(panes).toEqual([COLLIE_TAB, "Opus", "Sonnet", "Synthesize"]);
  expect(run.step("review").variants).toHaveLength(2);
});

effectTest("a workflow reuses the untouched numbered tab it was launched from", function* () {
  const herdr = new FakeHerdr(rig.pluginEnv());
  expect(yield* herdr.tabCreate({})).toEqual({ tabId: "1:1", paneId: "1-1" });
  yield* rig.queueOutputs([CLEAN, CLEAN, { ...CLEAN, summary: "done", dropped: [] }]);

  yield* runWorkflow(rig, "review", {}, { prompts: scriptedPrompts(["Don't post"]) });

  const calls = yield* rig.calls();
  expect(calls.filter((call) => call.cmd === "tab create")).toHaveLength(1);
  expect(calls.find((call) => call.cmd === "agent start")?.argv).toContain("1-1");
});

effectTest("the driver's progress is a file, and the board shows the last of it", function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const run = yield* new RunStore(rig.stateDir).create({
    workflow: "review",
    cwd: rig.projectDir,
    session: rig.pluginEnv().socketPath,
    workspace: "1",
    workspaceLabel: "test",
    inputs: { target: "worktree" },
    inputSources: { target: "inferred" },
    stepIds: ["review"],
    maxIterations: 5,
    primaryInput: "worktree",
  });
  run.record.target_label = "worktree";
  run.step("review").status = "running";
  yield* run.save();

  yield* appendProgress(run.dir, "▶ review (2 in parallel) — iteration 1");
  yield* appendProgress(run.dir, "  ✓ opus");

  // Both shapes: one line per event for the board, and a plain log for a human.
  expect((yield* readProgress(run.dir)).map((l) => l.text)).toEqual([
    "▶ review (2 in parallel) — iteration 1",
    "  ✓ opus",
  ]);
  expect(yield* lastProgress(run.dir)).toBe("  ✓ opus");
  expect(yield* fs.readFileString(path.join(run.dir, RUNNER_LOG))).toContain(
    "▶ review (2 in parallel)",
  );

  const row = (yield* board()).active[0];
  if (!row) return yield* Effect.fail(new Error("expected one active run"));
  expect(row.detail).toBe("review · iteration 1/5 ·   ✓ opus");
});

effectTest("a Choice asked through the run dir is answered through it", function* () {
  const answered: string[] = [];
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Stands in for the Control Plane: sees choice.json, writes choice-answer.json.
  const answerer = yield* Effect.gen(function* () {
    for (let i = 0; i < 200; i++) {
      const run = (yield* new RunStore(rig.stateDir).list())[0] ?? null;
      const choice = run ? yield* readChoice(run.dir) : null;
      if (run && choice) {
        answered.push(...choice.items.map((it) => it.title));
        yield* answerChoice(run.dir, { id: choice.id, choice: "Carry on" });
        return;
      }
      yield* Effect.sleep("25 millis");
    }
  }).pipe(Effect.forkScoped);

  const { run, status } = yield* runWorkflow(
    rig,
    "choose",
    { goal: "g" },
    {
      // Exactly what the driver builds: the question goes into this run's own dir.
      promptsFor: (r) =>
        filePrompts({ dir: r.dir, run: r.id, step: () => "next", timeoutMs: 10_000, pollMs: 25 }),
    },
  );
  yield* Fiber.join(answerer);

  // The question reached the file, the answer came back through it, and the run
  // recorded the choice exactly as a menu in a pane used to.
  expect(answered).toEqual(["Stop here", "Carry on"]);
  expect(status).toBe("done");
  expect(run.record.choices.map((c) => c.title)).toEqual(["Carry on"]);
  // Neither file is left behind to be answered twice.
  expect(yield* fs.exists(path.join(run.dir, CHOICE))).toBe(false);
  expect(yield* fs.exists(path.join(run.dir, CHOICE_ANSWER))).toBe(false);
});

effectTest("a decided run finishes headless, asking nobody anything", function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const { run, status } = yield* runWorkflow(
    rig,
    "choose",
    { goal: "g" },
    {
      decisions: { next: "Carry on" },
      promptsFor: (r) =>
        filePrompts({ dir: r.dir, run: r.id, step: () => "next", timeoutMs: 150, pollMs: 25 }),
    },
  );

  expect(status).toBe("done");
  expect(run.record.choices.map((c) => c.title)).toEqual(["Carry on"]);
  // Nothing was ever asked, so no question was written for anyone to answer.
  expect(yield* fs.exists(path.join(run.dir, CHOICE))).toBe(false);
});

effectTest(
  "a question nobody answers leaves the step unfinished, not the run wedged",
  function* () {
    const { run, status } = yield* runWorkflow(
      rig,
      "choose",
      { goal: "g" },
      {
        promptsFor: (r) =>
          filePrompts({ dir: r.dir, run: r.id, step: () => "next", timeoutMs: 150, pollMs: 25 }),
      },
    );

    expect(status).toBe("blocked");
    expect(run.step("next").status).toBe("blocked");
    expect(run.step("next").note).toBe("no choice taken");
  },
);

effectTest(
  "a pending choice renders under its run, and survives the board being reopened",
  function* () {
    const run = yield* new RunStore(rig.stateDir).create({
      workflow: "plan",
      cwd: rig.projectDir,
      session: rig.pluginEnv().socketPath,
      workspace: "1",
      workspaceLabel: "test",
      inputs: {},
      inputSources: {},
      stepIds: ["grill", "next"],
      maxIterations: 1,
      primaryInput: "add-a-picker",
    });
    run.record.target_label = "add-a-picker";
    run.record.awaiting = "next";
    yield* run.save();
    yield* writeChoice(run.dir, {
      id: "c1",
      kind: "menu",
      run: run.id,
      step: "next",
      header: "plan-add-a-picker — next",
      footer: "↑↓ move · Enter choose",
      items: [
        { id: "Implement now", title: "Implement now", subtitle: "runs implement" },
        { id: "Refine", title: "Refine", subtitle: "a fresh agent" },
      ],
    });

    // Read from the file every time, so closing and reopening the pane loses nothing.
    for (const pass of [1, 2]) {
      const view = yield* board();
      const waiting = askingRun(view);
      expect(waiting?.id, `pass ${pass}`).toBe(run.id);
      const text = renderWorkspace(view, undefined, { index: 1, typed: "" });
      expect(text).toContain("⚠ Plan · add-a-picker");
      expect(text).toContain("plan-add-a-picker — next");
      expect(text).toContain("  Implement now");
      expect(text).toContain("❯ Refine");
      // While a run is asking, the board's own keys are that question's.
      expect(text).toContain("answering Plan · add-a-picker");
      expect(text).not.toContain("p run a workflow");
    }
  },
);

effectTest("the board's keys answer the question, and Esc leaves the run open", function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const run = yield* new RunStore(rig.stateDir).create({
    workflow: "plan",
    cwd: rig.projectDir,
    inputs: {},
    inputSources: {},
    stepIds: ["next"],
    maxIterations: 1,
    primaryInput: "x",
  });
  // The board answers against the run dir's own choice, the way the CLI does.
  const menu = {
    id: "c1",
    kind: "menu",
    run: run.id,
    step: "next",
    header: "h",
    footer: "f",
    items: [
      { id: "one", title: "One" },
      { id: "two", title: "Two" },
    ],
  } as const;
  yield* writeChoice(run.dir, menu);
  const row: RunRow = {
    id: run.id,
    dir: run.dir,
    glyph: "⚠",
    title: "Plan · x",
    detail: "",
    // Hand-built, so nothing says when it last changed; only the app reads this.
    at: 0,
    target: null,
    fixable: false,
    choice: menu,
    needsYou: false,
  };
  const start: Asking = { index: 0, typed: "" };

  // Down moves, and Enter sends the highlighted option's id.
  const moved = yield* answerKey(row, start, "\x1b[B");
  expect(moved.asking.index).toBe(1);
  yield* answerKey(row, moved.asking, "\r");
  const commands = Effect.gen(function* () {
    return yield* Effect.forEach(yield* fs.readDirectory(path.join(run.dir, "inbox")), (name) =>
      fs
        .readFileString(path.join(run.dir, "inbox", name))
        .pipe(Effect.map((text): InboxAnswer => JSON.parse(text))),
    );
  });
  expect(yield* commands).toContainEqual({
    type: "answer",
    requestId: expect.any(String),
    choiceId: "c1",
    answer: "two",
  });

  // A second answer to the same choice is refused, exactly as `collie run answer` is.
  const again = yield* answerKey(row, moved.asking, "\r");
  expect(again.note).toContain("already has an answer");
  expect((yield* commands).filter((c) => c.choiceId === "c1")).toHaveLength(1);

  // Esc is an answer too: it is what leaves the run open for a resume.
  const dismissed = { ...menu, id: "c3" };
  yield* writeChoice(run.dir, dismissed);
  yield* answerKey({ ...row, choice: dismissed }, start, "\x1b");
  expect(yield* commands).toContainEqual({
    type: "answer",
    requestId: expect.any(String),
    choiceId: "c3",
    answer: "",
  });

  // A typed question collects characters and sends the text.
  const typed = {
    id: "c2",
    kind: "ask",
    run: run.id,
    step: "next",
    header: "h",
    footer: "f",
    items: [],
  } as const;
  yield* writeChoice(run.dir, typed);
  const ask: RunRow = { ...row, choice: typed };
  let asking = start;
  for (const key of ["c", "e", "g", "o"]) asking = (yield* answerKey(ask, asking, key)).asking;
  asking = (yield* answerKey(ask, asking, "\x7f")).asking;
  expect(asking.typed).toBe("ceg");
  yield* answerKey(ask, asking, "\r");
  expect(yield* commands).toContainEqual({
    type: "answer",
    requestId: expect.any(String),
    choiceId: "c2",
    answer: "ceg",
  });
});

effectTest("a run nothing is driving is abandoned; one with a live driver is not", function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = new RunStore(rig.stateDir);
  const run = yield* store.create({
    workflow: "review",
    cwd: rig.projectDir,
    session: rig.pluginEnv().socketPath,
    workspace: "1",
    workspaceLabel: "test",
    inputs: { target: "worktree" },
    inputSources: { target: "inferred" },
    stepIds: ["review"],
    maxIterations: 1,
    primaryInput: "worktree",
  });
  run.record.target_label = "worktree";
  run.step("review").status = "running";
  run.step("review").note = "herdr agent start failed (exit 1)";
  yield* run.save();
  const later = (yield* Clock.currentTimeMillis) + 3_600_000;

  // This test process is a live driver as far as the ownership claim is concerned.
  expect(yield* acquireDriver(run.dir)).toBe(true);
  expect(yield* driverAlive(run.dir)).toBe(true);
  expect((yield* board(later)).active.map((r) => r.title)).toEqual(["Review · worktree"]);
  // And resume will not start a second one for it.
  const resumable = yield* store.resumable();
  const withoutDriver = yield* Effect.filter(resumable, (r) =>
    driverAlive(r.dir).pipe(Effect.map((alive) => !alive)),
  );
  expect(withoutDriver).toEqual([]);

  yield* releaseDriver(run.dir);
  expect(yield* driverAlive(run.dir)).toBe(false);
  const gone = yield* board(later);
  expect(gone.active).toEqual([]);
  // Why it stopped is on the row, because there is no pane it could have printed in.
  expect(gone.recent[0]!.detail).toBe("abandoned · herdr agent start failed (exit 1)");

  // A claim left behind by a driver that died is not a driver, and neither is a
  // legacy plain-pid file naming a process that no longer exists.
  yield* fs.writeFileString(path.join(run.dir, RUNNER_PID), "999999\n");
  expect(yield* driverAlive(run.dir)).toBe(false);
});

effectTest(
  "a failed run says why on its row, and its log opens in a pane of its own",
  function* () {
    yield* rig.queueOutputs([]);
    const env = rig.pluginEnv({
      FAKE_HERDR_FAIL: fakeHerdrFail,
    });

    const { run, status } = yield* runWorkflow(
      rig,
      "solo",
      { goal: "g" },
      { env: { FAKE_HERDR_FAIL: fakeHerdrFail } },
    );
    expect(status).toBe("failed");
    yield* appendProgress(run.dir, "✗ solo — herdr agent prompt failed (exit 1): no such agent");

    // The row carries the reason, because there is no pane it could have printed in.
    const view = yield* board();
    const row = view.recent[0];
    if (!row) return yield* Effect.fail(new Error("expected one recent run"));
    expect(row.glyph).toBe("✗");
    expect(row.detail).toContain("failed");
    expect(row.detail).toContain("no such agent");
    // And a toast said so at the time.
    const toast = (yield* rig.calls()).filter((c) => c.cmd === "notification show").at(-1)?.argv;
    expect(toast?.[2]).toBe(`project · ${run.record.slug} failed`);

    // `l` puts the detail in a pane of its own, split off the board's.
    const before = (yield* rig.calls()).length;
    const note = yield* openLog(
      {
        herdr: new FakeHerdr(env),
        ...scopeFor(env, env.cwd),
        stateDir: env.stateDir,
        configDir: env.configDir,
        paneId: "1-1",
        pluginRoot: env.pluginRoot,
      },
      view,
    );
    expect(note).toContain(row.title);
    const after = (yield* rig.calls()).slice(before);
    expect(after.map((c) => c.cmd)).toEqual(["pane split", "pane run"]);
    expect(after[0]?.argv?.slice(2, 5)).toEqual(["1-1", "--direction", "down"]);
    expect(after[1]?.argv?.at(-1)).toBe(`less +G '${run.dir}/${RUNNER_LOG}'`);
  },
);

effectTest("a run can be stopped, because closing a pane no longer does it", function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const run = yield* new RunStore(rig.stateDir).create({
    workflow: "review",
    cwd: rig.projectDir,
    session: rig.pluginEnv().socketPath,
    workspace: "1",
    workspaceLabel: "test",
    inputs: {},
    inputSources: {},
    stepIds: ["review"],
    maxIterations: 1,
    primaryInput: "worktree",
  });
  run.step("review").status = "running";
  yield* run.save();

  // A driver that is not there cannot be stopped, and says so rather than lying.
  expect(yield* stopDriver(run.dir)).toBe(false);

  // A live process whose identity does not match the claim is not the driver: a
  // pid reused by something unrelated must never be signalled. It stays alive.
  const bystander = yield* spawner.spawn(
    ChildProcess.make("sleep", ["30"], { stdout: "ignore", stderr: "ignore" }),
  );
  yield* fs.writeFileString(
    path.join(run.dir, RUNNER_PID),
    `${JSON.stringify({ pid: Number(bystander.pid), start: "not-its-start-time", at: yield* nowIso() })}\n`,
  );
  expect(yield* driverAlive(run.dir)).toBe(false);
  expect(yield* stopDriver(run.dir)).toBe(false);
  expect(yield* bystander.isRunning).toBe(true);

  // A verified owner: a real process, asked to stop. The claim stays while it
  // dies — a resume in that window must still see the run as owned — and reads
  // as stale once the process is gone, which is when a new claim may be taken.
  const child = yield* spawner.spawn(
    ChildProcess.make("sleep", ["30"], { stdout: "ignore", stderr: "ignore" }),
  );
  yield* fs.writeFileString(
    path.join(run.dir, RUNNER_PID),
    `${JSON.stringify({ pid: Number(child.pid), start: yield* processStartTime(Number(child.pid)), at: yield* nowIso() })}\n`,
  );
  expect(yield* driverAlive(run.dir)).toBe(true);
  expect(yield* stopDriver(run.dir)).toBe(true);
  expect(yield* fs.exists(path.join(run.dir, RUNNER_PID))).toBe(true);
  yield* child.exitCode.pipe(Effect.ignore);
  expect(yield* driverAlive(run.dir)).toBe(false);
  // The dead owner's claim is stale, so the next driver can take the run over.
  expect(yield* acquireDriver(run.dir)).toBe(true);
  yield* releaseDriver(run.dir);
  yield* bystander.kill();
});

effectTest(
  "ownership: one winner, stale claims recovered, and only your own claim released",
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const run = yield* new RunStore(rig.stateDir).create({
      workflow: "solo",
      cwd: rig.projectDir,
      inputs: {},
      inputSources: {},
      stepIds: ["solo"],
      maxIterations: 1,
      primaryInput: "x",
    });
    const root = new URL("../", import.meta.url).pathname;
    const claimAndHold = `import { BunServices } from "@effect/platform-bun";
import { Effect, ManagedRuntime } from "effect";
const { acquireDriver } = await import(${JSON.stringify(`${root}src/driver.ts`)});
const runtime = ManagedRuntime.make(BunServices.layer);
console.log(await runtime.runPromise(acquireDriver(${JSON.stringify(run.dir)})));
await runtime.runPromise(Effect.sleep("5 seconds"));`;

    // Two concurrent claims on one run: exactly one owner, one clean refusal. The
    // winner holds its claim (and stays alive) until this test kills it.
    const spawnClaim = () =>
      spawner.spawn(
        ChildProcess.make("bun", ["-e", claimAndHold], { stdout: "pipe", stderr: "ignore" }),
      );
    const firstLine = (process: ChildProcessSpawner.ChildProcessHandle) =>
      process.stdout.pipe(
        Stream.decodeText(),
        Stream.splitLines,
        Stream.runHead,
        Effect.map(Option.getOrElse(() => "")),
      );
    const a = yield* spawnClaim();
    const b = yield* spawnClaim();
    const won = yield* Effect.all([firstLine(a), firstLine(b)], { concurrency: "unbounded" }).pipe(
      Effect.map((lines) => lines.map((line) => line === "true")),
    );
    expect(won.filter(Boolean)).toHaveLength(1);
    expect(yield* driverAlive(run.dir)).toBe(true);

    // A different process cannot release the owner's claim.
    yield* releaseDriver(run.dir);
    expect(yield* driverAlive(run.dir)).toBe(true);

    // The owner dies without cleanup: the stale claim is recovered, not respected.
    yield* a.kill();
    yield* b.kill();
    yield* Effect.all([a.exitCode, b.exitCode], { concurrency: "unbounded" }).pipe(Effect.ignore);
    expect(yield* driverAlive(run.dir)).toBe(false);
    expect(yield* acquireDriver(run.dir)).toBe(true);
    expect(yield* driverAlive(run.dir)).toBe(true);
    // And a second claim while this one lives is refused.
    expect(yield* acquireDriver(run.dir)).toBe(false);
    yield* releaseDriver(run.dir);
    expect(yield* fs.exists(path.join(run.dir, RUNNER_PID))).toBe(false);
  },
  20_000,
);

effectTest(
  "the driver outlives the process that started it",
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const store = new RunStore(rig.stateDir);
    const run = yield* store.create({
      workflow: "solo",
      cwd: rig.projectDir,
      session: rig.pluginEnv().socketPath,
      workspace: "1",
      workspaceLabel: "test",
      inputs: { goal: "Add a picker" },
      inputSources: { goal: "asked" },
      stepIds: ["solo"],
      maxIterations: 5,
      primaryInput: "Add a picker",
    });
    yield* rig.queueOutputs([CLEAN]);

    // A parent that starts a driver and exits at once, which is what the picker does.
    const root = new URL("../", import.meta.url).pathname;
    const parent = path.join(rig.root, "parent.ts");
    yield* fs.writeFileString(
      parent,
      `import { readEnv } from "${root}src/env";
import { spawnDriver } from "${root}src/operations";
import { runEffect } from "${root}test/support/effect";
const env = readEnv(Bun.env);
await runEffect(spawnDriver(env, Bun.env.RUN_ID ?? "", env.cwd));
`,
    );
    expect(
      Number(
        yield* spawner.exitCode(
          ChildProcess.make("bun", [parent], {
            env: rig.env({
              COLLIE_DRIVER: JSON.stringify(["bun", `${root}src/main.ts`]),
              RUN_ID: run.id,
            }),
            extendEnv: true,
            stdout: "ignore",
            stderr: "ignore",
          }),
        ),
      ),
    ).toBe(0);

    // The parent is gone; the run finishes anyway.
    for (let i = 0; i < 200 && (yield* store.load(run.id)).record.status === "running"; i++)
      yield* Effect.sleep("100 millis");
    const finished = yield* store.load(run.id);
    expect(finished.record.status).toBe("done");
    expect(finished.step("solo").status).toBe("done");
    // And it said what it was doing where the board can read it.
    expect((yield* readProgress(finished.dir)).map((l) => l.text)).toContain(
      "▶ solo — iteration 1",
    );
    // The pid file is cleaned up, so nothing thinks it is still being driven — the
    // driver is a moment behind the record it just saved, so give it that moment.
    for (let i = 0; i < 40 && (yield* driverAlive(finished.dir)); i++)
      yield* Effect.sleep("50 millis");
    expect(yield* driverAlive(finished.dir)).toBe(false);
  },
  30_000,
);

effectTest(
  "the compiled driver path is one executable, and overrides are explicit arguments",
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const env = rig.pluginEnv();
    expect(yield* driverCommand(env).pipe(Effect.provide(configLayer()))).toEqual([
      `${env.pluginRoot}/bin/collie`,
    ]);

    expect(
      yield* driverCommand(env).pipe(
        Effect.provide(configLayer(JSON.stringify(["bun", "/a dir with spaces/main.ts"]))),
      ),
    ).toEqual(["bun", "/a dir with spaces/main.ts"]);

    // Anything that is not a JSON array is one executable path, spaces and all —
    // as long as it actually exists.
    const spaced = path.join(rig.root, "my tools", "collie");
    yield* fs.makeDirectory(path.join(rig.root, "my tools"), { recursive: true });
    yield* fs.writeFileString(spaced, "#!/bin/sh\n", { mode: 0o755 });
    expect(yield* driverCommand(env).pipe(Effect.provide(configLayer(spaced)))).toEqual([spaced]);

    // A non-JSON override is always one executable path, spaces and all.
    expect(yield* driverCommand(env).pipe(Effect.provide(configLayer("bun src/main.ts")))).toEqual([
      "bun src/main.ts",
    ]);

    for (const driver of ['["bun", 42]', "[not json"]) {
      yield* driverCommand(env).pipe(
        Effect.provide(configLayer(driver)),
        Effect.flip,
        Effect.map((error) => expect(error.message).toContain("COLLIE_DRIVER")),
      );
    }
  },
);

effectTest(
  "driver startup works from a plugin root with spaces and shell metacharacters",
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const pluginRoot = path.join(rig.root, "plu gin's root; touch pwned");
    const marker = path.join(rig.root, "launched.txt");
    yield* fs.makeDirectory(path.join(pluginRoot, "bin"), { recursive: true });
    yield* fs.writeFileString(
      path.join(pluginRoot, "bin", "collie"),
      `#!/bin/sh\nprintf '%s %s %s' "$1" "$2" "$COLLIE_RUN" > ${JSON.stringify(marker)}\n`,
      { mode: 0o755 },
    );

    const env = rig.pluginEnv({ HERDR_PLUGIN_ROOT: pluginRoot });
    yield* spawnDriver(env, "run-1", rig.projectDir).pipe(Effect.provide(configLayer()));
    for (let i = 0; i < 100 && !(yield* fs.exists(marker)); i++) yield* Effect.sleep("25 millis");

    // The path reached exec whole: the fake driver ran, with the run in its env,
    // and the metacharacters in the path stayed path characters.
    expect(yield* fs.readFileString(marker)).toBe("herdr drive run-1");
    expect(yield* fs.exists(path.join(rig.root, "pwned"))).toBe(false);
    expect(yield* fs.exists("pwned")).toBe(false);
  },
);

effectTest(
  "a log path with spaces and metacharacters is one argument to less, not syntax",
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const env = rig.pluginEnv();
    const dir = path.join(rig.root, "state's dir; touch pwned", "run dir");
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(path.join(dir, RUNNER_LOG), "hello\n");
    const row = {
      id: "r",
      dir,
      glyph: "✓",
      title: "Review · x",
      detail: "",
      at: 0,
      target: null,
      fixable: false,
      choice: null,
      needsYou: false,
    };
    const view: WorkspaceView = {
      repo: "r",
      cwd: env.cwd,
      worktrees: [],
      behind: null,
      now: 0,
      agents: [],
      extraAgents: 0,
      active: [],
      recent: [row],
    };

    const note = yield* openLog(
      {
        herdr: new FakeHerdr(env),
        ...scopeFor(env, env.cwd),
        stateDir: env.stateDir,
        configDir: env.configDir,
        paneId: "1-1",
        pluginRoot: env.pluginRoot,
      },
      view,
    );
    expect(note).toContain("Review · x");

    // Run the exact command the pane was given through a real shell, with `less`
    // faked: the whole path must arrive as one argument, and nothing else must run.
    const command =
      (yield* rig.calls())
        .filter((c) => c.cmd === "pane run")
        .at(-1)
        ?.argv?.at(-1) ?? "";
    const bin = yield* FakeBin.make(path.join(rig.root, "fakebin"));
    const marker = path.join(rig.root, "less-arg.txt");
    yield* bin.add("less", `printf '%s' "$2" > ${JSON.stringify(marker)}`);
    const pathValue = yield* Config.string("PATH").pipe(Config.withDefault(""));
    const exit = yield* spawner.exitCode(
      ChildProcess.make("sh", ["-c", command], {
        env: { PATH: `${bin.dir}:${pathValue}` },
        extendEnv: true,
        stdout: "ignore",
        stderr: "ignore",
      }),
    );
    yield* bin.restore();

    expect(Number(exit)).toBe(0);
    expect(yield* fs.readFileString(marker)).toBe(path.join(dir, RUNNER_LOG));
    expect(yield* fs.exists(path.join(rig.root, "pwned"))).toBe(false);
    expect(yield* fs.exists("pwned")).toBe(false);
  },
);

effectTest(
  "a contender mid-takeover blocks others from clearing the claim, and its crash does not wedge the run",
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const run = yield* new RunStore(rig.stateDir).create({
      workflow: "solo",
      cwd: rig.projectDir,
      inputs: {},
      inputSources: {},
      stepIds: ["solo"],
      maxIterations: 1,
      primaryInput: "x",
    });
    const claim = path.join(run.dir, RUNNER_PID);
    const lock = `${claim}.takeover`;
    // A stale claim (dead pid), with a live contender holding the takeover lock —
    // this test process stands in for that contender.
    yield* fs.writeFileString(claim, `${JSON.stringify({ pid: 999999, start: "1", at: "" })}\n`);
    yield* fs.writeFileString(
      lock,
      `${JSON.stringify({ pid: yield* currentPid, start: yield* processStartTime(yield* currentPid) })}\n`,
    );

    // This attempt loses cleanly and, crucially, does not remove the claim: the
    // lock holder may already have cleared it and written a fresh one of its own.
    expect(yield* acquireDriver(run.dir)).toBe(false);
    expect(yield* fs.exists(claim)).toBe(true);

    // The lock holder crashed: a dead holder's lock is broken at once — no ageing
    // needed — and the run is not wedged.
    yield* fs.writeFileString(lock, `${JSON.stringify({ pid: 424242, start: "1" })}\n`);
    expect(yield* acquireDriver(run.dir)).toBe(true);
    yield* releaseDriver(run.dir);
    expect(yield* fs.exists(lock)).toBe(false);
  },
);

effectTest(
  "an unreadable young claim is a winner mid-write, not a stale claim to remove",
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const run = yield* new RunStore(rig.stateDir).create({
      workflow: "solo",
      cwd: rig.projectDir,
      inputs: {},
      inputSources: {},
      stepIds: ["solo"],
      maxIterations: 1,
      primaryInput: "x",
    });
    const claim = path.join(run.dir, RUNNER_PID);
    // wx creation and the JSON write are not one operation; a contender arriving
    // between them sees an empty claim. It must lose cleanly, not remove it.
    yield* fs.writeFileString(claim, "");
    expect(yield* acquireDriver(run.dir)).toBe(false);
    expect(yield* fs.exists(claim)).toBe(true);

    // Aged past any plausible write, the unreadable claim is leftovers.
    const old = dateFromMillis((yield* Clock.currentTimeMillis) - 60_000);
    yield* fs.utimes(claim, old, old);
    expect(yield* acquireDriver(run.dir)).toBe(true);
    yield* releaseDriver(run.dir);
  },
);

effectTest("a fresh Driver ignores what the last one left in the run dir", function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const run = yield* new RunStore(rig.stateDir).create({
    workflow: "plan",
    cwd: rig.projectDir,
    inputs: {},
    inputSources: {},
    stepIds: ["next"],
    maxIterations: 1,
    primaryInput: "x",
  });

  // What a stop against a mid-Step Run leaves: the command is written before the
  // signal, and the SIGTERM path consumes nothing. Plus the dead Driver's question.
  const inbox = path.join(run.dir, "inbox");
  yield* fs.makeDirectory(inbox, { recursive: true });
  yield* fs.writeFileString(
    path.join(inbox, "old-stop.json"),
    `${JSON.stringify({ type: "stop", requestId: "old-stop" })}\n`,
  );
  yield* writeChoice(run.dir, {
    id: `${run.id}-1`,
    kind: "menu",
    run: run.id,
    step: "next",
    header: "h",
    footer: "f",
    items: [{ id: "one", title: "One" }],
  });

  yield* clearPreviousDriver(run.dir);

  // Left in place, that stop would have made the next Driver kill itself at its first
  // Choice, so any Workflow that asks a question would never resume.
  expect(yield* fs.readDirectory(inbox)).toEqual([]);
  expect(yield* readChoice(run.dir)).toBeNull();
});

effectTest("the Driver is spawned with a usable environment, not just herdr's keys", function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const seen = path.join(rig.root, "driver-env");
  const driver = path.join(rig.root, "env-driver");
  yield* fs.writeFileString(driver, `#!/bin/sh\nprintf '%s' "$PATH" > "${seen}"\n`, {
    mode: 0o755,
  });

  const run = yield* new RunStore(rig.stateDir).create({
    workflow: "plan",
    cwd: rig.projectDir,
    inputs: {},
    inputSources: {},
    stepIds: ["next"],
    maxIterations: 1,
    primaryInput: "x",
  });
  // Built the way production builds it: `currentEnv` reads only the keys env.ts lists,
  // and PATH is not one of them, so `env.raw` here has none — exactly as in a real
  // action or pane entrypoint.
  const production = readEnv({
    HOME: rig.root,
    HERDR_PLUGIN_ROOT: rig.baselineDir,
    HERDR_PLUGIN_STATE_DIR: rig.stateDir,
    COLLIE_CWD: rig.projectDir,
  });
  expect(production.raw["PATH"]).toBeUndefined();

  yield* spawnDriver(production, run.id, run.record.cwd).pipe(Effect.provide(configLayer(driver)));

  for (let i = 0; i < 50 && !(yield* fs.exists(seen)); i++) yield* Effect.sleep("20 millis");
  // Bun substitutes a default PATH when given an explicit env, so the miss was not an
  // empty PATH but a reduced one: /bin and /usr/bin only, without ~/.local/bin — which
  // is where this project's own setup.sh installs — so a git or glab there is
  // unfindable, and `shell` reads that as exit 127, which the MR and diff paths cannot
  // tell from "no GitLab here". The Driver gets the environment its parent had.
  expect(yield* fs.exists(seen)).toBe(true);
  expect(yield* fs.readFileString(seen)).toBe(
    yield* Config.string("PATH").pipe(Config.withDefault("")),
  );
});

effectTest("a stop that lands before the Driver claims the Run is honoured", function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const run = yield* new RunStore(rig.stateDir).create({
    workflow: "plan",
    cwd: rig.projectDir,
    inputs: {},
    inputSources: {},
    stepIds: ["next"],
    maxIterations: 1,
    primaryInput: "x",
  });

  // What `run stop` leaves when it finds no owner in the window between the spawn and
  // the child writing runner.pid: it has already reported the Run stopped.
  yield* fs.makeDirectory(path.join(run.dir, "inbox"), { recursive: true });
  yield* fs.writeFileString(
    path.join(run.dir, "inbox", "req.json"),
    `${JSON.stringify({ type: "stop", requestId: "req" })}\n`,
  );
  yield* fs.writeFileString(path.join(run.dir, STOPPED), `${yield* nowIso()}\n`);

  // The Driver that arrives next must not drive it, and must give the claim back.
  expect(yield* acquireDriver(run.dir)).toBe(true);
  expect(yield* stoppedBefore(run.dir)).toBe(true);
  yield* releaseDriver(run.dir);
  expect(yield* driverAlive(run.dir)).toBe(false);
});

effectTest("a resume command is read by the Driver it starts, then cleared", function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const run = yield* new RunStore(rig.stateDir).create({
    workflow: "plan",
    cwd: rig.projectDir,
    inputs: {},
    inputSources: {},
    stepIds: ["next"],
    maxIterations: 1,
    primaryInput: "x",
  });
  const inbox = path.join(run.dir, "inbox");
  yield* fs.makeDirectory(inbox, { recursive: true });
  yield* fs.writeFileString(
    path.join(inbox, "resume-7.json"),
    `${JSON.stringify({ type: "resume", requestId: "resume-7" })}\n`,
  );

  // The Run's own audit trail records that a resume asked for this Driver, which is
  // what the inbox is for; the command itself does not outlive being read.
  expect(yield* clearPreviousDriver(run.dir)).toBe("resume-7");
  expect(yield* fs.readDirectory(inbox)).toEqual([]);
});
