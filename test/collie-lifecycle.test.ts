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
import { processStartTime } from "../src/lock";
import { runEffect } from "./support/effect";

const root = new URL("../", import.meta.url).pathname;
let dir: string;
let env: CollieCliEnv;

interface CollieCliEnv extends Record<string, string> {
  PATH: string;
  /** The operator a generated branch is namespaced under, so no test asks a real glab. */
  GITLAB_USER_LOGIN: string;
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
const stringifyJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

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
      // A mutating workflow, so the branch a run works on has to be settled before it
      // starts. `implement` by name: that is what Collie knows changes the repository.
      yield* fs.writeFileString(
        path.join(plugin, "workflows", "implement.md"),
        `---
name: implement
title: Implement
description: Builds a plan.
inputs:
  plan: work-source
steps:
  - id: build
    persona: helper
    output: build.json
---
## build
Build {{inputs.plan}}.
`,
      );
      const herdr = path.join(dir, "herdr");
      yield* fs.writeFileString(
        herdr,
        `#!/bin/sh
if [ "$1 $2" = "workspace list" ]; then
  printf '%s\n' '{"result":{"workspaces":[{"workspace_id":"w1","label":"One","cwd":"${workspace}","worktree":{"path":"${workspace}"}},{"workspace_id":"w2","label":"Two","cwd":"${workspace}"}]}}'
elif [ "$1 $2" = "workspace create" ]; then
  n=$(cat "${path.join(dir, "workspaces")}" 2>/dev/null || echo 0)
  n=$((n + 1))
  printf '%s' "$n" > "${path.join(dir, "workspaces")}"
  printf '{"result":{"workspace":{"workspace_id":"task-ws-%s"}}}\n' "$n"
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
        GITLAB_USER_LOGIN: "tester",
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
  return yield* run(["--json", ...args]).pipe(
    Effect.map(({ stdout, stderr, exit }) => ({ body: parseJson(stdout), stderr, exit })),
  );
});

/** The CLI as a human runs it: what it printed, unenveloped. */
const run = Effect.fn("test.run")(function* (args: string[]) {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const process = yield* spawner.spawn(
    ChildProcess.make("bun", [path.join(root, "src/main.ts"), ...args], {
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
  return { stdout, stderr, exit };
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
    // And one task workspace: a replayed receipt opens nothing a second time.
    expect((yield* fs.readFileString(path.join(dir, "workspaces"))).trim()).toBe("1");

    const runId: string = first.body.data.runId;
    const shown = (yield* cli(["--workspace", "w1", "run", "show", runId])).body.data.run;
    // A fresh start is its own Task, in a workspace of its own — not the w1 it was
    // launched from, whose directory still roots it.
    expect(shown).toMatchObject({
      workspace: "task-ws-1",
      workspace_label: "ship",
      workspace_worktree: path.join(dir, "workspace"),
      cwd: path.join(dir, "workspace"),
    });

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

    // Scoping is by Task now: this Run is reachable from the workspace it was started
    // in and from its own Task's, and not from another Task's.
    expect((yield* cli(["--workspace", "task-ws-1", "run", "show", runId])).body.ok).toBe(true);
    const other = yield* cli([
      "--workspace",
      "w1",
      "run",
      "start",
      "demo",
      "--input",
      "goal=elsewhere",
      "--request-id",
      "start-2",
    ]);
    expect(Number(other.exit)).toBe(0);
    expect((yield* cli(["--workspace", "task-ws-2", "run", "show", runId])).body.error.code).toBe(
      "run_not_found",
    );
  },
  // Nine CLI subprocesses, each a cold Bun start; ten seconds was a coin toss on a
  // loaded machine. The budget is here to catch a hang, not to time the hardware.
  60_000,
);

/** The workspace as a real git checkout, for the tests that make a worktree of it. */
function checkout(at: string) {
  const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: at });
  git("init", "-b", "master");
  git("-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "--allow-empty", "-m", "x");
}

effectTest(
  "a run whose branch nothing names is given one, without asking",
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    // A real checkout, because the branch that is worked out makes a worktree of it.
    checkout(path.join(dir, "workspace"));

    // A plan directory whose own name is too long to slug: every such plan under one
    // `tasks/` directory clips to the same branch, and the branch is the key to the
    // worktree — so what the cap dropped comes back as a digest rather than a question.
    const plan = path.join(
      dir,
      "tasks",
      "a-plan-directory-whose-name-is-far-too-long-to-be-a-branch",
    );
    yield* fs.makeDirectory(plan, { recursive: true });
    yield* fs.writeFileString(path.join(plan, "SPEC.md"), "# A plan\n");

    const start = ["--workspace", "w1", "run", "start", "implement", "--input", `plan=${plan}`];
    const started = yield* cli([...start, "--request-id", "branch-1"]);
    expect(Number(started.exit)).toBe(0);

    const runId = Schema.decodeUnknownSync(Schema.String)(started.body.data.runId);
    const record = parseJson(
      yield* fs.readFileString(path.join(dir, "state", "runs", runId, "run.json")),
    );
    const branch = Schema.decodeUnknownSync(Schema.String)(record.worktree.branch);
    expect(branch.startsWith(`${env.GITLAB_USER_LOGIN}/`)).toBe(true);
    expect(record.worktree.path).toBe(
      path.join(dir, ".herdr", "worktrees", "workspace", ...branch.split("/")),
    );

    // Retried with the same request id, it is the same Run and the same checkout: a
    // generated name is a function of the work, so nothing new is created.
    const again = yield* cli([...start, "--request-id", "branch-1"]);
    expect(Schema.decodeUnknownSync(Schema.String)(again.body.data.runId)).toBe(runId);

    // An explicit branch still wins, and is taken exactly as it was given.
    const named = yield* cli([
      ...start,
      "--input",
      "branch=global-board",
      "--request-id",
      "branch-2",
    ]);
    expect(Number(named.exit)).toBe(0);
    const namedId = Schema.decodeUnknownSync(Schema.String)(named.body.data.runId);
    const second = parseJson(
      yield* fs.readFileString(path.join(dir, "state", "runs", namedId, "run.json")),
    );
    expect(second.worktree.branch).toBe("global-board");
  },
  // Several cold CLI starts, and a Driver start now ensures the Herd's Home before
  // anything else. Five seconds was a coin toss rather than a deadline.
  20_000,
);

effectTest(
  "run show lists a parent's repository runs, with their status",
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = yield* cli([
      "--workspace",
      "w1",
      "run",
      "start",
      "demo",
      "--input",
      "goal=ship",
      "--request-id",
      "parent-1",
    ]);
    const child = yield* cli([
      "--workspace",
      "w1",
      "run",
      "start",
      "demo",
      "--input",
      "goal=ship the api",
      "--request-id",
      "child-1",
    ]);
    const parentId = Schema.decodeUnknownSync(Schema.String)(parent.body.data.runId);
    const childId = Schema.decodeUnknownSync(Schema.String)(child.body.data.runId);
    // The fan-out as it stands after the first wave started, written the way the parent's
    // Driver writes it.
    const file = path.join(dir, "state", "runs", parentId, "run.json");
    const snapshot = parseJson(yield* fs.readFileString(file));
    snapshot.children = [childId];
    snapshot.fanout = {
      title: "Implement now",
      waves: [["cego/api"], ["cego/web"]],
      runs: { "cego/api": childId },
      mrs: {},
      wave: 1,
      blocked: null,
    };
    yield* fs.writeFileString(file, JSON.stringify(snapshot));

    const shown = yield* run(["--workspace", "w1", "run", "show", parentId]);

    // An agent driving Collie follows a fan-out from here: the child, which repository it
    // is building, and where it has got to.
    expect(shown.stdout).toContain(`${childId}\tcego/api\trunning`);
    // And the relation is in the payload as well, for a caller that parses it.
    const json = yield* cli(["--workspace", "w1", "run", "show", parentId]);
    expect(json.body.data.run.children).toEqual([childId]);
  },
  20_000,
);

effectTest("two plans under one directory are two runs, named apart", function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  checkout(path.join(dir, "workspace"));

  // Two plans whose names agree for the first 24 characters. The run's slug names its
  // agents, its tab and its row on the board, so two of these sharing one would put two
  // identical rows in front of the human with no way to tell which run is which.
  const plans = ["a-plan-directory-whose-name-is-one", "a-plan-directory-whose-name-is-two"];
  const slugs: string[] = [];
  for (const name of plans) {
    const plan = path.join(dir, "tasks", name);
    yield* fs.makeDirectory(plan, { recursive: true });
    yield* fs.writeFileString(path.join(plan, "SPEC.md"), "# A plan\n");
    const started = yield* cli([
      "--workspace",
      "w1",
      "run",
      "start",
      "implement",
      "--input",
      `plan=${plan}`,
    ]);
    expect(Number(started.exit)).toBe(0);
    const runId = Schema.decodeUnknownSync(Schema.String)(started.body.data.runId);
    const record = parseJson(
      yield* fs.readFileString(path.join(dir, "state", "runs", runId, "run.json")),
    );
    // The branch already names the work; the run is named the same way, so the two
    // cannot say the same thing.
    expect(record.worktree.branch).toBe(`${env.GITLAB_USER_LOGIN}/${name}`);
    slugs.push(Schema.decodeUnknownSync(Schema.String)(record.slug));
  }

  expect(slugs[0]).not.toBe(slugs[1]);
  // The task, not the whole branch: the login namespace is the same on every run this
  // operator starts, and spending the slug's cap on it made two long plans one row.
  expect(slugs[0]).toBe(`implement-${plans[0]}`);
  expect(slugs[1]).toBe(`implement-${plans[1]}`);
});

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
  // Four CLI subprocesses, each a cold Bun start. The default five seconds was close
  // enough to the real cost that a loaded machine lost the coin toss; this is a budget
  // that says "something is wrong" rather than "the machine was busy".
  30_000,
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

/** A Driver's pending question, written straight into the run directory. */
const askQuestion = Effect.fn("test.askQuestion")(function* (
  runDir: string,
  choice: {
    id: string;
    step?: string;
    header?: string;
    items?: Array<{ id: string; title: string }>;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.writeFileString(
    path.join(runDir, "choice.json"),
    stringifyJson({
      id: choice.id,
      kind: "menu",
      run: "r",
      step: choice.step ?? "work",
      header: choice.header ?? "Which way?",
      footer: "",
      items: choice.items ?? [{ id: "now", title: "Implement now" }],
    }),
  );
});

const startDemo = Effect.fn("test.startDemo")(function* (goal: string) {
  const path = yield* Path.Path;
  const started = yield* cli([
    "--workspace",
    "w1",
    "run",
    "start",
    "demo",
    "--input",
    `goal=${goal}`,
  ]);
  const runId: string = started.body.data.runId;
  return { runId, runDir: path.join(dir, "state", "runs", runId) };
});

const finishRun = Effect.fn("test.finishRun")(function* (runDir: string, status: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(runDir, "run.json");
  const snapshot = parseJson(yield* fs.readFileString(file));
  snapshot.status = status;
  snapshot.finished_at = yield* nowIso();
  snapshot.steps[0].status = status === "done" ? "done" : "failed";
  yield* fs.writeFileString(file, stringifyJson(snapshot));
});

/** The attention wait, as every test below asks for it. */
const waitAttention = (runId: string, timeout: string) =>
  cli(["--workspace", "w1", "run", "wait", runId, "--until", "attention", "--timeout", timeout]);

effectTest("wait --until attention returns a question that is already pending", function* () {
  const { runId, runDir } = yield* startDemo("attention-early");
  yield* askQuestion(runDir, { id: "c-1", header: "Implement or plan?" });
  const waited = yield* waitAttention(runId, "30 seconds");
  expect(Number(waited.exit)).toBe(0);
  expect(waited.body.data.run.status).toBe("waiting");
  const attention = waited.body.data.attention;
  expect(attention.category).toBe("question");
  expect(attention.reason).toBe("choice_pending");
  expect(attention.step).toBe("work");
  expect(attention.actions).toContain("answer");
  expect(attention.choice.id).toBe("c-1");
  expect(attention.choice.kind).toBe("menu");
  expect(attention.choice.header).toBe("Implement or plan?");
  expect(attention.choice.items.map((item: { id: string }) => item.id)).toEqual(["now"]);
});

effectTest(
  "wait --until attention reports a terminal outcome without inventing a Choice",
  function* () {
    const { runId, runDir } = yield* startDemo("attention-done");
    yield* finishRun(runDir, "done");
    const waited = yield* waitAttention(runId, "30 seconds");
    expect(Number(waited.exit)).toBe(0);
    expect(waited.body.data.run.status).toBe("succeeded");
    expect(waited.body.data.attention.category).toBe("completed");
    expect(waited.body.data.attention.reason).toBe("succeeded");
    expect(waited.body.data.attention.choice).toBe(null);
  },
);

effectTest("wait --until takes only terminal and attention", function* () {
  const { runId } = yield* startDemo("attention-bogus");
  const bad = yield* cli(["--workspace", "w1", "run", "wait", runId, "--until", "whenever"]);
  expect(bad.body.error.code).toBe("invalid_input");
  expect(Number(bad.exit)).toBe(2);
});

effectTest("awaiting text with no pending Choice is not something to answer", function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { runId, runDir } = yield* startDemo("attention-awaiting");
  // A Driver owns it, so the only thing that could end the wait is a question.
  yield* claimLive(runDir);
  const file = path.join(runDir, "run.json");
  const snapshot = parseJson(yield* fs.readFileString(file));
  snapshot.awaiting = "waiting for the agent to finish";
  yield* fs.writeFileString(file, stringifyJson(snapshot));
  const waited = yield* waitAttention(runId, "2 seconds");
  expect(waited.body.error.code).toBe("timeout");
});

effectTest("wait --until terminal waits through a question, as the default does", function* () {
  const { runId, runDir } = yield* startDemo("attention-terminal");
  yield* askQuestion(runDir, { id: "c-2" });
  const waited = yield* cli([
    "--workspace",
    "w1",
    "run",
    "wait",
    runId,
    "--until",
    "terminal",
    "--timeout",
    "2 seconds",
  ]);
  expect(waited.body.error.code).toBe("timeout");
});

effectTest("wait --until attention --follow ends on an attention event", function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const { runId, runDir } = yield* startDemo("attention-follow");
  // A Driver owns it, so nothing but the question below can end this wait.
  yield* claimLive(runDir);
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
        "--until",
        "attention",
        "--follow",
      ],
      { cwd: root, env, extendEnv: true, stdout: "pipe", stderr: "pipe" },
    ),
  );
  const ready = yield* Deferred.make<void>();
  const reader = yield* Effect.forkScoped(
    process.stdout.pipe(
      Stream.decodeText(),
      Stream.tap(() => Deferred.succeed(ready, undefined)),
      Stream.runFold(
        (): string => "",
        (out, chunk) => out + chunk,
      ),
    ),
  );
  // The snapshot proves the watch is subscribed, so the question below can only
  // arrive through a filesystem event.
  yield* Deferred.await(ready);
  yield* askQuestion(runDir, { id: "c-3" });
  const output = yield* Fiber.join(reader);
  expect(Number(yield* process.exitCode)).toBe(0);
  const events = output
    .trim()
    .split("\n")
    .map((line: string) => parseJson(line));
  expect(events[0].type).toBe("snapshot");
  expect(events.at(-1).type).toBe("attention");
  expect(events.at(-1).attention.choice.id).toBe("c-3");
  expect(events.filter((event: { type: string }) => event.type === "terminal")).toHaveLength(0);
  expect(yield* fs.exists(path.join(runDir, "inbox"))).toBe(false);
});

effectTest(
  "an answer for a replaced Choice is refused and leaves the current one alone",
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { runId, runDir } = yield* startDemo("attention-stale");
    yield* askQuestion(runDir, { id: "c-new" });
    const stale = yield* cli([
      "--workspace",
      "w1",
      "run",
      "answer",
      runId,
      "now",
      "--expect-choice",
      "c-old",
    ]);
    expect(stale.body.error.code).toBe("choice_mismatch");
    expect(stale.body.error.details.choiceId).toBe("c-new");
    expect(yield* fs.exists(path.join(runDir, "inbox"))).toBe(false);

    const fresh = yield* cli([
      "--workspace",
      "w1",
      "run",
      "answer",
      runId,
      "now",
      "--expect-choice",
      "c-new",
    ]);
    expect(fresh.body.ok).toBe(true);
    expect(yield* fs.readDirectory(path.join(runDir, "inbox"))).toHaveLength(1);
  },
);

/** A Driver claim in the run directory, for a pid that may or may not still be there. */
const claimDriver = Effect.fn("test.claimDriver")(function* (
  runDir: string,
  pid: number,
  start: string | null,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.writeFileString(
    path.join(runDir, "runner.pid"),
    `${stringifyJson({ pid, start, at: yield* nowIso() })}\n`,
  );
});

/** A pid that has certainly gone: claimed by a process spawned only to exit. */
const claimDead = Effect.fn("test.claimDead")(function* (runDir: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const gone = yield* spawner.spawn(ChildProcess.make("true", [], { stdout: "ignore" }));
  yield* gone.exitCode;
  yield* claimDriver(runDir, Number(gone.pid), null);
});

/** This test process as the Run's Driver: a claim that is unambiguously live. */
const claimLive = Effect.fn("test.claimLive")(function* (runDir: string) {
  const pid = globalThis.process.pid;
  yield* claimDriver(runDir, pid, yield* processStartTime(pid));
});

effectTest("a stopped Run says why it stopped, what is kept, and what is safe", function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { runId, runDir } = yield* startDemo("recover-stopped");
  const file = path.join(runDir, "run.json");
  const snapshot = parseJson(yield* fs.readFileString(file));
  snapshot.steps[0].status = "done";
  yield* fs.writeFileString(file, stringifyJson(snapshot));
  yield* fs.writeFileString(path.join(runDir, "stopped"), "");

  const waited = yield* waitAttention(runId, "30 seconds");
  const attention = waited.body.data.attention;
  expect(waited.body.data.run.status).toBe("stopped");
  expect(attention.category).toBe("interrupted");
  expect(attention.reason).toBe("stopped");
  expect(attention.driver).toBe("none");
  // Nothing is thrown away by resuming, and the explanation says which Steps those are.
  expect(attention.preserved).toEqual(["work"]);
  expect(attention.actions).toContain("resume");

  // `run show` says the same thing from the same facts, and reading it changed nothing.
  const shown = yield* cli(["--workspace", "w1", "run", "show", runId]);
  expect(shown.body.data.attention).toEqual(attention);
  expect(yield* fs.exists(path.join(runDir, "stopped"))).toBe(true);
  expect(parseJson(yield* fs.readFileString(file)).status).toBe("running");
});

effectTest("an exhausted review loop is named as one rather than a bare failure", function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { runId, runDir } = yield* startDemo("recover-exhausted");
  const file = path.join(runDir, "run.json");
  const snapshot = parseJson(yield* fs.readFileString(file));
  snapshot.status = "blocked";
  snapshot.iteration = snapshot.max_iterations;
  snapshot.outstanding = [{ severity: "major", title: "no story for the CLI", note: "" }];
  yield* fs.writeFileString(file, stringifyJson(snapshot));

  const waited = yield* waitAttention(runId, "30 seconds");
  // The lifecycle status is untouched: `blocked` is still reported as `failed`.
  expect(waited.body.data.run.status).toBe("failed");
  expect(waited.body.data.attention.category).toBe("interrupted");
  expect(waited.body.data.attention.reason).toBe("review_exhausted");
  expect(waited.body.data.attention.explanation).toContain("1 finding");
});

effectTest(
  "a converging loop that stopped says why, ahead of the exhausted-loop guess",
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { runId, runDir } = yield* startDemo("recover-no-progress");
    const file = path.join(runDir, "run.json");
    const snapshot = parseJson(yield* fs.readFileString(file));
    snapshot.status = "blocked";
    snapshot.iteration = snapshot.max_iterations;
    snapshot.halt = "no_progress";
    snapshot.outstanding = [{ severity: "blocker", title: "no exit code" }];
    snapshot.steps[0].status = "blocked";
    snapshot.steps[0].note =
      "no progress: review 2 raised the same 1 blocking finding(s) as review 1";
    yield* fs.writeFileString(file, stringifyJson(snapshot));

    const waited = yield* waitAttention(runId, "30 seconds");
    expect(waited.body.data.attention.category).toBe("interrupted");
    expect(waited.body.data.attention.reason).toBe("no_progress");
    expect(waited.body.data.attention.explanation).toContain("same 1 blocking finding(s)");
    expect(waited.body.data.attention.step).toBe(snapshot.steps[0].id);
  },
);

effectTest(
  "a Step that stopped for the human is named, and a bare failure is not guessed at",
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { runId, runDir } = yield* startDemo("recover-blocked");
    const file = path.join(runDir, "run.json");
    const blocked = parseJson(yield* fs.readFileString(file));
    blocked.status = "blocked";
    blocked.steps[0].status = "blocked";
    blocked.steps[0].note = "the agent needs a decision";
    yield* fs.writeFileString(file, stringifyJson(blocked));

    const named = yield* waitAttention(runId, "30 seconds");
    expect(named.body.data.attention.reason).toBe("step_blocked");
    expect(named.body.data.attention.step).toBe("work");
    expect(named.body.data.attention.explanation).toContain("the agent needs a decision");

    // Nothing recorded says why, so nothing is invented.
    const bare = parseJson(yield* fs.readFileString(file));
    bare.steps[0].status = "failed";
    bare.steps[0].note = null;
    bare.status = "failed";
    yield* fs.writeFileString(file, stringifyJson(bare));
    const guessed = yield* waitAttention(runId, "30 seconds");
    expect(guessed.body.data.attention.reason).toBe("failed");
    expect(guessed.body.data.attention.category).toBe("interrupted");
  },
);

effectTest(
  "a Driver that dies without writing anything still ends an attention wait",
  function* () {
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const { runId, runDir } = yield* startDemo("recover-lost");

    // A real, live process claims the Run, so the wait starts with a Driver in place and
    // nothing to report. Killing it writes nothing into the run directory: the watch
    // alone would wait for ever, which is the whole reason for the bounded health check.
    const driver = yield* spawner.spawn(
      ChildProcess.make("sleep", ["120"], { stdout: "ignore", stderr: "ignore" }),
    );
    const pid = Number(driver.pid);
    yield* claimDriver(runDir, pid, yield* processStartTime(pid));

    const waiting = yield* spawner.spawn(
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
          "--until",
          "attention",
          "--timeout",
          "60 seconds",
        ],
        { cwd: root, env, extendEnv: true, stdout: "pipe", stderr: "pipe" },
      ),
    );
    yield* Effect.sleep("1500 millis");
    yield* driver.kill({ killSignal: "SIGKILL" });
    yield* Effect.ignore(driver.exitCode);

    const output = yield* waiting.stdout.pipe(
      Stream.decodeText(),
      Stream.runFold(
        (): string => "",
        (out, chunk) => out + chunk,
      ),
    );
    expect(Number(yield* waiting.exitCode)).toBe(0);
    const body = parseJson(output.trim());
    expect(body.data.attention.category).toBe("interrupted");
    expect(body.data.attention.reason).toBe("driver_lost");
    expect(body.data.attention.driver).toBe("none");
    expect(body.data.attention.actions).toContain("resume");
  },
  90_000,
);

effectTest("a Run a live Driver still owns is not offered a resume", function* () {
  const { runId, runDir } = yield* startDemo("recover-live");
  yield* claimLive(runDir);

  const shown = yield* cli(["--workspace", "w1", "run", "show", runId]);
  expect(shown.body.data.attention.driver).toBe("live");
  expect(shown.body.data.attention.actions).not.toContain("resume");
  expect(shown.body.data.attention.actions).toContain("stop");

  // And the mutation refuses too, so advice that has gone stale cannot start a second
  // Driver for the same Run.
  const resumed = yield* cli(["--workspace", "w1", "run", "resume", runId]);
  expect(resumed.body.error.code).toBe("run_already_active");
});

effectTest(
  "a Run whose Driver has not claimed it yet is not reported as lost",
  function* () {
    // `run start` returns as soon as it has spawned a Driver; the claim lands a process
    // start later. Calling that gap a lost Driver would make the ordinary
    // start-then-wait sequence report every new Run as broken.
    const { runId } = yield* startDemo("attention-unclaimed");
    const waited = yield* waitAttention(runId, "3 seconds");
    expect(waited.body.error.code).toBe("timeout");
  },
  // Its own budget: three seconds of deliberate waiting, on top of a Driver start that
  // ensures the Herd's Home before it does anything else.
  20_000,
);

effectTest(
  "a question left behind by a dead Driver is recovery, not something to answer",
  function* () {
    // The Driver clears a stale `choice.json` as it starts, for the same reason: the
    // question belonged to a process that is gone, and an answer to it has nobody to
    // consume it. Offering `answer` here is how a Run stays stuck.
    const { runId, runDir } = yield* startDemo("attention-stale-choice");
    yield* claimDead(runDir);
    yield* askQuestion(runDir, { id: "c-stale" });

    const waited = yield* waitAttention(runId, "30 seconds");
    expect(waited.body.data.attention.category).toBe("interrupted");
    expect(waited.body.data.attention.reason).toBe("driver_lost");
    expect(waited.body.data.attention.choice).toBe(null);
    expect(waited.body.data.attention.actions).toContain("resume");
    expect(waited.body.data.attention.actions).not.toContain("answer");
  },
);

effectTest(
  "a Run whose Driver is still starting after a resume is not reported as lost",
  function* () {
    // `run resume` returns as soon as it has spawned a Driver, and the previous Driver's
    // dead claim is still on disk until the new one takes it. Reading that gap as a lost
    // Driver would offer a second resume while the first is still starting.
    const { runId, runDir } = yield* startDemo("attention-resuming");
    yield* claimDead(runDir);

    const lost = yield* waitAttention(runId, "30 seconds");
    expect(lost.body.data.attention.reason).toBe("driver_lost");

    yield* writeResumeCommand(runDir);
    const starting = yield* waitAttention(runId, "2 seconds");
    expect(starting.body.error.code).toBe("timeout");
  },
  // As above: two waits of its own, and a Driver start before either of them.
  20_000,
);

/** The inbox record `run resume` leaves for the Driver it has just spawned. */
const writeResumeCommand = Effect.fn("test.writeResumeCommand")(function* (runDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const inbox = path.join(runDir, "inbox");
  yield* fs.makeDirectory(inbox, { recursive: true });
  yield* fs.writeFileString(
    path.join(inbox, "req-resume.json"),
    `${stringifyJson({ type: "resume", requestId: "req-resume" })}\n`,
  );
});

effectTest("stopping a Run does not turn its orphaned question back into one", function* () {
  // `run stop` writes the marker and leaves `choice.json` alone, so a settled Run can
  // still have a question on disk. Nothing can consume an answer to it either way.
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { runId, runDir } = yield* startDemo("attention-stopped-choice");
  yield* claimDead(runDir);
  yield* askQuestion(runDir, { id: "c-orphan" });
  yield* fs.writeFileString(path.join(runDir, "stopped"), "");

  const waited = yield* waitAttention(runId, "30 seconds");
  expect(waited.body.data.attention.category).toBe("interrupted");
  expect(waited.body.data.attention.reason).toBe("stopped");
  expect(waited.body.data.attention.choice).toBe(null);
  expect(waited.body.data.attention.actions).not.toContain("answer");
  // And the envelope says it once: `run.choice` carrying the question while
  // `attention.choice` is null would tell an agent both that there is one and that
  // there is not.
  expect(waited.body.data.run.choice).toBe(null);
  const shown = yield* cli(["--workspace", "w1", "run", "show", runId]);
  expect(shown.body.data.run.choice).toBe(null);
});
