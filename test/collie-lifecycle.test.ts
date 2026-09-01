import { nowIso } from "../src/time";
import type { BunServices } from "@effect/platform-bun";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  Config,
  ConfigProvider,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Path,
  PlatformError,
  Ref,
  Schema,
  Scope,
  Sink,
  Stdio,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { waitFor } from "../src/commands/run";
import { runEffect } from "./support/effect";

const root = new URL("../", import.meta.url).pathname;
let dir: string;
let env: CollieCliEnv;

interface CollieCliEnv extends Record<string, string> {
  PATH: string;
  HOME: string;
  HERDR_PLUGIN_ROOT: string;
  HERDR_PLUGIN_CONFIG_DIR: string;
  HERDR_PLUGIN_STATE_DIR: string;
  HERDR_BIN_PATH: string;
  COLLIE_DRIVER: string;
}

type TestError = Config.ConfigError | Error | PlatformError.PlatformError;
type TestServices = BunServices.BunServices | Scope.Scope;
type TestEffect = Effect.Effect<unknown, TestError, TestServices>;

const effectTest = (
  name: string,
  body: () => Generator<TestEffect, void, unknown>,
  timeout?: number,
) => test(name, () => runEffect(Effect.gen(body).pipe(Effect.scoped)), timeout);

const parseJson = (text: string) => JSON.parse(text);

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      dir = yield* fs.makeTempDirectory({ prefix: "collie-life-" });
      const plugin = path.join(dir, "plugin");
      const workspace = path.join(dir, "workspace");
      yield* fs.makeDirectory(path.join(plugin, "workflows"), { recursive: true });
      yield* fs.makeDirectory(path.join(plugin, "personas"), { recursive: true });
      yield* fs.makeDirectory(workspace);
      yield* fs.writeFileString(
        path.join(plugin, "workflows", "demo.md"),
        `---
name: demo
title: Demo
description: A demo.
inputs:
  goal: goal
steps:
  - id: work
    persona: helper
    output: out.json
---
## work
Do it.
`,
      );
      yield* fs.writeFileString(
        path.join(plugin, "personas", "helper.md"),
        `---
name: helper
description: Helps.
---
Help.
`,
      );
      const herdr = path.join(dir, "herdr");
      yield* fs.writeFileString(
        herdr,
        `#!/bin/sh
if [ "$1 $2" = "workspace list" ]; then
  printf '%s\n' '{"result":{"workspaces":[{"workspace_id":"w1","label":"One","cwd":"${workspace}","worktree":{"path":"${workspace}"}},{"workspace_id":"w2","label":"Two","cwd":"${workspace}"}]}}'
fi
`,
        { mode: 0o755 },
      );
      const driver = path.join(dir, "driver");
      yield* fs.writeFileString(
        driver,
        `#!/bin/sh
printf '%s\n' "$COLLIE_RUN" >> "${path.join(dir, "drivers")}"
`,
        { mode: 0o755 },
      );
      env = {
        PATH: yield* Config.string("PATH").pipe(Config.withDefault("")),
        HOME: dir,
        HERDR_PLUGIN_ROOT: plugin,
        HERDR_PLUGIN_CONFIG_DIR: path.join(dir, "config"),
        HERDR_PLUGIN_STATE_DIR: path.join(dir, "state"),
        HERDR_BIN_PATH: herdr,
        COLLIE_DRIVER: driver,
      };
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(dir, { recursive: true, force: true });
    }),
  ),
);

const cli = Effect.fn("test.cli")(function* (args: string[]) {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const process = yield* spawner.spawn(
    ChildProcess.make("bun", [path.join(root, "src/main.ts"), "--json", ...args], {
      cwd: root,
      env,
      extendEnv: true,
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const [stdout, stderr, exit] = yield* Effect.all(
    [
      process.stdout.pipe(
        Stream.decodeText(),
        Stream.runFold(
          () => "",
          (out, chunk) => out + chunk,
        ),
      ),
      process.stderr.pipe(
        Stream.decodeText(),
        Stream.runFold(
          () => "",
          (out, chunk) => out + chunk,
        ),
      ),
      process.exitCode,
    ],
    { concurrency: "unbounded" },
  ).pipe(Effect.scoped);
  if (stdout.trim() === "")
    return yield* Effect.fail(new Error(`empty stdout (exit ${Number(exit)}): ${stderr}`));
  return { body: parseJson(stdout), stderr, exit };
});

effectTest(
  "start, inspect, scope, and every mutation are retry-safe",
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const first = yield* cli([
      "--workspace",
      "w1",
      "run",
      "start",
      "demo",
      "--input",
      "goal=ship",
      "--request-id",
      "start-1",
    ]);
    const retry = yield* cli([
      "--workspace",
      "w1",
      "run",
      "start",
      "demo",
      "--input",
      "goal=ignored",
      "--request-id",
      "start-1",
    ]);
    expect(Number(first.exit)).toBe(0);
    const startedRunId = Schema.decodeUnknownSync(Schema.String)(first.body.data.runId);
    expect(first.body.data.requestId).toBe("start-1");
    expect(retry.body.data.runId).toBe(startedRunId);
    expect((yield* fs.readFileString(path.join(dir, "drivers"))).trim().split("\n")).toHaveLength(
      1,
    );

    const runId: string = first.body.data.runId;
    const shown = (yield* cli(["--workspace", "w1", "run", "show", runId])).body.data.run;
    expect(shown).toMatchObject({
      workspace: "w1",
      workspace_label: "One",
      workspace_worktree: path.join(dir, "workspace"),
      cwd: path.join(dir, "workspace"),
    });
    expect((yield* cli(["--workspace", "w2", "run", "show", runId])).body.error.code).toBe(
      "run_not_found",
    );

    const runDir = path.join(dir, "state", "runs", runId);
    const snapshotPath = path.join(runDir, "run.json");
    const snapshot = parseJson(yield* fs.readFileString(snapshotPath));
    snapshot.steps[0].status = "done";
    yield* fs.writeFileString(snapshotPath, JSON.stringify(snapshot));
    yield* fs.writeFileString(
      path.join(runDir, "choice.json"),
      JSON.stringify({
        id: "choice-1",
        kind: "menu",
        run: runId,
        step: "work",
        header: "Pick",
        footer: "",
        items: [{ id: "yes", title: "Yes" }],
      }),
    );
    const answer = yield* cli([
      "--workspace",
      "w1",
      "run",
      "answer",
      runId,
      "yes",
      "--request-id",
      "answer-1",
    ]);
    const answerRetry = yield* cli([
      "--workspace",
      "w1",
      "run",
      "answer",
      runId,
      "yes",
      "--request-id",
      "answer-1",
    ]);
    expect(answerRetry.body).toEqual(answer.body);
    expect(yield* fs.exists(path.join(runDir, "inbox", "answer-1.json"))).toBe(true);

    yield* fs.remove(path.join(runDir, "inbox"), { recursive: true, force: true });
    yield* fs.writeFileString(
      path.join(runDir, "choice.json"),
      JSON.stringify({
        id: "choice-2",
        kind: "ask",
        run: runId,
        step: "work",
        header: "What should change?",
        footer: "",
        items: [],
      }),
    );
    const text = yield* cli([
      "--workspace",
      "w1",
      "run",
      "answer",
      runId,
      "Use the smaller API",
      "--request-id",
      "answer-2",
    ]);
    expect(Number(text.exit)).toBe(0);
    expect(
      parseJson(yield* fs.readFileString(path.join(runDir, "inbox", "answer-2.json"))),
    ).toMatchObject({ type: "answer", choiceId: "choice-2", answer: "Use the smaller API" });

    const stopped = yield* cli([
      "--workspace",
      "w1",
      "run",
      "stop",
      runId,
      "--request-id",
      "stop-1",
    ]);
    const stoppedRetry = yield* cli([
      "--workspace",
      "w1",
      "run",
      "stop",
      runId,
      "--request-id",
      "stop-1",
    ]);
    expect(stopped.body.data.status).toBe("stopped");
    expect(stoppedRetry.body).toEqual(stopped.body);
    const stoppedRun = (yield* cli(["--workspace", "w1", "run", "show", runId])).body.data.run;
    expect(stoppedRun.finished_at).toBeString();
    const resumed = yield* cli([
      "--workspace",
      "w1",
      "run",
      "resume",
      runId,
      "--request-id",
      "resume-1",
    ]);
    const resumedRetry = yield* cli([
      "--workspace",
      "w1",
      "run",
      "resume",
      runId,
      "--request-id",
      "resume-1",
    ]);
    expect(resumed.body.data.status).toBe("running");
    expect(resumedRetry.body).toEqual(resumed.body);
    expect((yield* fs.readFileString(path.join(dir, "drivers"))).trim().split("\n")).toHaveLength(
      2,
    );
    expect(
      (yield* cli(["--workspace", "w1", "run", "show", runId])).body.data.run.steps[0].status,
    ).toBe("done");
  },
  10_000,
);

effectTest("a dead request lock is recovered instead of wedging the request id", function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lock = path.join(dir, "state", "requests", "run-start", "stale-request.json.lock");
  yield* fs.makeDirectory(path.dirname(lock), { recursive: true });
  yield* fs.writeFileString(lock, `${JSON.stringify({ pid: 2_000_000_000, start: "dead" })}\n`);

  const result = yield* cli([
    "--workspace",
    "w1",
    "run",
    "start",
    "demo",
    "--input",
    "goal=ship",
    "--request-id",
    "stale-request",
  ]);
  expect(Number(result.exit)).toBe(0);
  expect(result.body.data.requestId).toBe("stale-request");
  expect(yield* fs.exists(lock)).toBe(false);
});

effectTest("wait follows recorded progress to exactly one successful terminal event", function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const started = yield* cli(["--workspace", "w1", "run", "start", "demo", "--input", "goal=wait"]);
  const runId: string = started.body.data.runId;
  const runDir = path.join(dir, "state", "runs", runId);
  yield* fs.writeFileString(
    path.join(runDir, "progress.jsonl"),
    `${JSON.stringify({ at: yield* nowIso(), text: "finished work" })}\n`,
    { flag: "a" },
  );
  const snapshotPath = path.join(runDir, "run.json");
  const snapshot = parseJson(yield* fs.readFileString(snapshotPath));
  snapshot.status = "done";
  snapshot.finished_at = yield* nowIso();
  snapshot.steps[0].status = "done";
  yield* fs.writeFileString(snapshotPath, JSON.stringify(snapshot));

  const process = yield* spawner.spawn(
    ChildProcess.make(
      "bun",
      [
        path.join(root, "src/main.ts"),
        "--json",
        "--workspace",
        "w1",
        "run",
        "wait",
        runId,
        "--follow",
      ],
      {
        cwd: root,
        env,
        extendEnv: true,
        stdout: "pipe",
        stderr: "pipe",
      },
    ),
  );
  const [output, exit] = yield* Effect.all(
    [
      process.stdout.pipe(
        Stream.decodeText(),
        Stream.runFold(
          () => "",
          (out, chunk) => out + chunk,
        ),
      ),
      process.exitCode,
    ],
    { concurrency: "unbounded" },
  );
  expect(Number(exit)).toBe(0);
  const events = output
    .trim()
    .split("\n")
    .map((line) => parseJson(line));
  expect(events.map((event) => event.type)).toEqual(["snapshot", "progress", "terminal"]);
  expect(events.filter((event) => event.type === "terminal")).toHaveLength(1);
});

effectTest(
  "workflow and persona forks never overwrite and retries return the receipt",
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const workflow = yield* cli([
      "workflow",
      "fork",
      "demo",
      "--layer",
      "user",
      "--mode",
      "extends",
      "--name",
      "mine",
      "--step",
      "work",
      "--request-id",
      "wf-1",
    ]);
    expect(Number(workflow.exit)).toBe(0);
    expect(yield* fs.readFileString(workflow.body.data.path)).toContain("extends: demo");
    expect(
      (yield* cli([
        "workflow",
        "fork",
        "demo",
        "--layer",
        "user",
        "--mode",
        "extends",
        "--name",
        "mine",
        "--request-id",
        "wf-1",
      ])).body,
    ).toEqual(workflow.body);
    expect(
      (yield* cli([
        "workflow",
        "fork",
        "demo",
        "--layer",
        "user",
        "--mode",
        "copy",
        "--name",
        "mine",
      ])).body.error.code,
    ).toBe("target_exists");
    expect(
      (yield* cli([
        "workflow",
        "fork",
        "demo",
        "--layer",
        "user",
        "--mode",
        "copy",
        "--name",
        "../escape",
      ])).body.error.code,
    ).toBe("invalid_input");

    const personaArgs = [
      "persona",
      "fork",
      "helper",
      "--layer",
      "project",
      "--name",
      "project-helper",
      "--workspace",
      "w1",
      "--request-id",
      "persona-1",
    ];
    const persona = yield* cli(personaArgs);
    const personaRetry = yield* cli(personaArgs);
    expect(Number(persona.exit)).toBe(0);
    expect(personaRetry.body).toEqual(persona.body);
    expect(persona.body.data.path).toContain("/workspace/.herdr/personas/project-helper.md");
  },
);

effectTest("wait follow writes every event through the supplied Stdio service", function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const started = yield* cli([
    "--workspace",
    "w1",
    "run",
    "start",
    "demo",
    "--input",
    "goal=stdio",
  ]);
  const runId = Schema.decodeUnknownSync(Schema.String)(started.body.data.runId);
  const snapshotPath = path.join(dir, "state", "runs", runId, "run.json");
  const snapshot = parseJson(yield* fs.readFileString(snapshotPath));
  snapshot.status = "done";
  snapshot.finished_at = yield* nowIso();
  snapshot.steps[0].status = "done";
  yield* fs.writeFileString(snapshotPath, JSON.stringify(snapshot));

  const written: string[] = [];
  yield* waitFor({ workspace: Option.none(), json: true }, runId, true, Option.none()).pipe(
    Effect.provide(
      Stdio.layerTest({
        stdout: () =>
          Sink.forEach((chunk: string | Uint8Array) =>
            Effect.sync(() => {
              written.push(String(chunk));
            }),
          ),
      }),
    ),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
  );

  expect(
    written
      .join("")
      .trim()
      .split("\n")
      .map((line) => parseJson(line).type),
  ).toEqual(["snapshot", "terminal"]);
});

effectTest("wait picks up events written after it started, and ends on one terminal", function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const started = yield* cli(["--workspace", "w1", "run", "start", "demo", "--input", "goal=live"]);
  const runId: string = started.body.data.runId;
  const runDir = path.join(dir, "state", "runs", runId);

  // Nothing terminal yet, so the first emit cannot end the wait and the FileSystem.watch
  // stream is what has to deliver everything below. The other wait test writes its
  // events first, which returns on the first read and never exercises the watch.
  const process = yield* spawner.spawn(
    ChildProcess.make(
      "bun",
      [
        path.join(root, "src/main.ts"),
        "--json",
        "--workspace",
        "w1",
        "run",
        "wait",
        runId,
        "--follow",
      ],
      { cwd: root, env, extendEnv: true, stdout: "pipe", stderr: "pipe" },
    ),
  );

  const ready = yield* Deferred.make<void>();
  const progressSeen = yield* Deferred.make<void>();
  const observed = yield* Ref.make("");
  const reader = yield* Effect.forkScoped(
    process.stdout.pipe(
      Stream.decodeText(),
      Stream.tap((chunk) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(ready, undefined);
          const text = yield* Ref.updateAndGet(observed, (current) => current + chunk);
          if (text.includes("step one")) yield* Deferred.succeed(progressSeen, undefined);
        }),
      ),
      Stream.runFold(
        (): string => "",
        (out, chunk) => out + chunk,
      ),
    ),
  );

  // The first snapshot proves the subprocess subscribed its watch and completed its
  // initial read. Everything written after this must arrive through an event.
  yield* Deferred.await(ready);
  yield* fs.writeFileString(
    path.join(runDir, "progress.jsonl"),
    `${JSON.stringify({ at: yield* nowIso(), text: "step one" })}\n`,
    { flag: "a" },
  );
  yield* Deferred.await(progressSeen);
  const snapshotPath = path.join(runDir, "run.json");
  const snapshot = parseJson(yield* fs.readFileString(snapshotPath));
  snapshot.status = "done";
  snapshot.finished_at = yield* nowIso();
  snapshot.steps[0].status = "done";
  yield* fs.writeFileString(snapshotPath, JSON.stringify(snapshot));

  const output = yield* Fiber.join(reader);
  expect(Number(yield* process.exitCode)).toBe(0);
  const events = output
    .trim()
    .split("\n")
    .map((line: string) => parseJson(line));
  expect(events[0].type).toBe("snapshot");
  expect(
    events
      .filter((event: { type: string }) => event.type === "progress")
      .map((event: { text: string }) => event.text),
  ).toContain("step one");
  expect(events.filter((event: { type: string }) => event.type === "terminal")).toHaveLength(1);
  expect(events.at(-1).type).toBe("terminal");
});

effectTest("interrupting wait stops the waiter and leaves the Run alone", function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const started = yield* cli([
    "--workspace",
    "w1",
    "run",
    "start",
    "demo",
    "--input",
    "goal=ctrlc",
  ]);
  const runId: string = started.body.data.runId;
  const runDir = path.join(dir, "state", "runs", runId);

  const process = yield* spawner.spawn(
    ChildProcess.make(
      "bun",
      [
        path.join(root, "src/main.ts"),
        "--json",
        "--workspace",
        "w1",
        "run",
        "wait",
        runId,
        "--follow",
      ],
      { cwd: root, env, extendEnv: true, stdout: "pipe", stderr: "pipe" },
    ),
  );
  const ready = yield* Deferred.make<void>();
  yield* Effect.forkScoped(
    process.stdout.pipe(
      Stream.tap(() => Deferred.succeed(ready, undefined)),
      Stream.runDrain,
    ),
  );
  yield* Deferred.await(ready);
  yield* process.kill({ killSignal: "SIGINT" });
  // Dying from a signal is a failure to the spawner; that it ended is all this needs.
  yield* Effect.ignore(process.exitCode);

  // `run stop` is the explicit cancellation; Ctrl-C is not one. The Run is exactly as
  // it was: no stop marker, and still the status its own Driver last recorded.
  expect(yield* fs.exists(path.join(runDir, "stopped"))).toBe(false);
  expect(parseJson(yield* fs.readFileString(path.join(runDir, "run.json"))).status).toBe("running");
});
