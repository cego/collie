// Where a Run works, settled by the host before the Run exists.
//
// Two things a launch places, and never one as the other: the Task, whose workspace every
// Run of it lives in, and the checkout, which a workflow that changes the repository
// declares and the host cuts. A chained build is the same Task in the same workspace, on a
// worktree of its own; a workspace of its own is only ever something a Run asked for.
//
// The host here is the real registry, engine and agents over a stand-in herdr, and the
// repository is a real git one, so the worktree is one git actually made.

import { afterEach, beforeEach, expect, test } from "bun:test";
import type { BunServices } from "@effect/platform-bun";
import { Clock, ConfigProvider, Effect, FileSystem, Layer, Result, Schema } from "effect";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { Rig, FakeHerdr } from "./support/recorder";
import { exec } from "./support/command";
import { FakeBin } from "./support/bin";
import { forgeOnPath, serveForges } from "./support/forge";
import { fastForward, runEffect as runLive } from "./support/effect";
import { installFakeSkills } from "./support/defs";
import { fixtures, until } from "./support/host";
import { agentsLayer, type AgentHost } from "../src/agents";
import {
  Registry,
  evidenceDir,
  foundationLayer,
  registryLayer,
  runDir,
  type Generation,
  type HostServices,
} from "../src/engine";
import { Store } from "../src/store";
import { sweep, worktreesSweeper } from "../src/cleanup";
import { factsOfView } from "../src/runs";
import type * as MessageStorage from "effect/cluster/MessageStorage";
import { SqlClient } from "effect/sql";
import { VerifySpecSchema } from "../src/verify-spec";
import { readTask, writeTask, type TaskRecord } from "../src/task";
import { writeMrStates } from "../src/merges";
import { mrLabel, type MrState } from "../src/board-model";
import type { Call } from "./support/recorder";

const asJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const ROOT = new URL("../", import.meta.url).pathname;
const shipped = (name: string) => `${ROOT}workflows/${name}.workflow.ts`;
const LOGIN = "mk";

let rig: Rig;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      sessions = [rig.socketPath];
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(rig.projectDir, { recursive: true });
      yield* installFakeSkills(rig.root);
      yield* gitRepo(rig.projectDir);
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

/** A repository with one commit on master, which is all a worktree needs to be cut from. */
const gitRepo = Effect.fn("test.gitRepo")(function* (at: string) {
  const git = (...args: string[]) =>
    exec(["git", ...args], {
      cwd: at,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: rig.root,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    }).pipe(
      Effect.flatMap((done) =>
        done.exitCode === 0
          ? Effect.void
          : Effect.die(new Error(`git ${args.join(" ")}: ${done.stderr}`)),
      ),
    );
  yield* git("init", "--quiet", "-b", "master");
  yield* git("commit", "--quiet", "--allow-empty", "-m", "init");
  yield* git("remote", "add", "upstream", "git@gitlab.example.com:group/app.git");
});

/** The sockets `session list` names, or null for a herdr that will not list them. */
let sessions: ReadonlyArray<string> | null;
const env = () =>
  rig.pluginEnv({
    HERDR_PLUGIN_ROOT: ROOT,
    GITLAB_USER_LOGIN: LOGIN,
    FAKE_HERDR_SESSIONS:
      sessions === null
        ? ""
        : JSON.stringify(sessions.map((socket, at) => ({ name: `s${at}`, socket_path: socket }))),
  });
/** The state directory the host, its Tasks and its agents all share, as an install's do. */
const dir = () => env().stateDir;

const hostOf = (): AgentHost => ({
  dir: dir(),
  env: env(),
  herdr: new FakeHerdr(env()),
  harness: "claude",
  model: "opus",
  permissions: "auto",
  compactAtTokens: 0,
  pollMs: 20,
  collectMs: 60_000,
});

/** Every wait in here is on a clock that moves many times faster than the wall's. */
const runEffect = <A, E>(effect: Effect.Effect<A, E, BunServices.BunServices>) =>
  runLive(fastForward(effect));

const hosted = <A, E>(
  run: Effect.Effect<
    A,
    E,
    Registry | Store | HostServices | MessageStorage.MessageStorage | SqlClient.SqlClient
  >,
  agents: Partial<AgentHost> = {},
) =>
  run.pipe(
    Effect.provide(
      registryLayer(dir(), {
        placing: { herdr: new FakeHerdr(env()), env: env() },
        userDir: rig.userDir,
      }),
    ),
    Effect.provide(agentsLayer({ ...hostOf(), ...agents })),
    Effect.provide(foundationLayer({ dir: dir(), userDir: rig.userDir })),
    Effect.scoped,
    Effect.orDie,
  );

const worktreeOf = (branch: string) => `${rig.root}/.herdr/worktrees/project/${LOGIN}/${branch}`;

/** A Task whose workspace herdr has open, as a start inside one continues it. */
const aTask = Effect.gen(function* () {
  yield* rig.addWorkspace("wT", "Project | Picker", rig.projectDir);
  const task: TaskRecord = {
    id: "task-1",
    workspace: "wT",
    label: "Project | Picker",
    cwd: rig.projectDir,
    created_at: "2026-09-23T00:00:00.000Z",
  };
  yield* writeTask(env().stateDir, task);
  return task;
});

/** A command the operator approved for every Run, so a build has something to prove. */
const approvedByOperator = FileSystem.FileSystem.pipe(
  Effect.flatMap((fs) =>
    fs.writeFileString(
      `${rig.userDir}/verify.json`,
      '[{"name":"unit","executable":"true","argv":[],"cwd":"worktree"}]',
    ),
  ),
  Effect.orDie,
);

/** Which workspace each tab was opened in, and on which directory, in order. */
const tabs = (calls: ReadonlyArray<Call>) =>
  calls
    .filter((call) => call.cmd === "tab create")
    .map((call) => {
      const argv = call.argv ?? [];
      return {
        workspace: argv[argv.indexOf("--workspace") + 1] ?? "",
        cwd: argv[argv.indexOf("--cwd") + 1] ?? "",
      };
    });

const loaded = (registry: typeof Registry.Service, names: ReadonlyArray<string>) =>
  Effect.forEach(names, (name) => registry.load(name));

const finished = (runId: string) =>
  Registry.pipe(
    Effect.flatMap((registry) =>
      until(
        () => registry.view(runId),
        (view) => view !== null && isOver(view.status.status),
      ),
    ),
  );

const isOver = (status: string) => status === "complete" || status === "failed";

const start = (
  generation: Generation,
  ask: {
    readonly request: string;
    readonly project?: string;
    readonly text?: Readonly<Record<string, string>>;
    readonly options?: Readonly<Record<string, string>>;
    readonly task?: string;
    readonly taskLabel?: string;
  },
) =>
  Registry.pipe(
    Effect.flatMap((registry) =>
      registry.start({
        generation,
        request: ask.request,
        project: ask.project ?? rig.projectDir,
        input: {},
        text: ask.text ?? {},
        options: ask.options,
        task: ask.task ?? null,
        taskLabel: ask.taskLabel,
      }),
    ),
    Effect.result,
  );

const asPlacing = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      from: Schema.String,
      taskLabel: Schema.String,
      workspace: Schema.optionalKey(Schema.NullOr(Schema.String)),
      checkout: Schema.optionalKey(Schema.Null),
    }),
  ),
);

/** A claim as a dying host left it: the row, what to place it from, and what it had asked for. */
const claimCut = (
  receipt: { readonly workspace?: string | null; readonly checkout?: null } = {},
  workflow = "builds",
) =>
  hosted(
    Effect.gen(function* () {
      const registry = yield* Registry;
      const [claimed] = yield* loaded(registry, [`${fixtures}/${workflow}.workflow.ts`]);
      const store = yield* Store;
      const payload = { runId: "run-cut", input: { work: "Add a picker" } };
      yield* store.admit({
        request: "r1",
        run: "run-cut",
        workflow,
        project: rig.projectDir,
        input: payload.input,
        provenance: { work: "given" },
        options: {},
        placing: asPlacing({ from: rig.projectDir, taskLabel: "Project | P", ...receipt }),
        generation: claimed!.name,
        execution: yield* claimed!.registration.workflow.executionId(payload),
        task: null,
        parent: null,
      });
      return (yield* store.run("run-cut"))?.checkout ?? null;
    }),
  );

const refusedWith = (result: Result.Result<unknown, { readonly reason: string }>) =>
  Result.isFailure(result) ? result.failure.reason : "";

test(
  "a chained build is the same Task in the same workspace, on a worktree of its own",
  () =>
    runEffect(
      Effect.gen(function* () {
        const task = yield* aTask;
        yield* rig.queueOutputs([{ verdict: "clean" }, { verdict: "clean" }]);
        const views = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [chains] = yield* loaded(registry, [
              `${fixtures}/chains.workflow.ts`,
              `${fixtures}/builds.workflow.ts`,
            ]);
            const started = yield* start(chains!, { request: "r1", task: task.id });
            if (started._tag === "Failure") return yield* Effect.die(started.failure);
            const parent = yield* finished(started.success.runId);
            const child = yield* registry.view(`${started.success.runId}.build`);
            return { parent, child };
          }),
        );

        const worktree = worktreeOf("add-a-picker");
        expect(views.parent?.status.status).toBe("complete");
        // Both Runs are the Task's; the parent works where it was started, the child on the
        // branch it builds, and neither was given a workspace of its own.
        expect(views.parent).toMatchObject({
          task: "task-1",
          cwd: rig.projectDir,
          workspace: null,
        });
        expect(views.child).toMatchObject({
          task: "task-1",
          cwd: worktree,
          branch: `${LOGIN}/add-a-picker`,
          workspace: null,
        });
        // Nothing the parent was given reached the child as a placement.
        expect(views.child?.options).toEqual({ task: "add-a-picker" });
        expect(yield* FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.exists(worktree)))).toBe(
          true,
        );
        // Every agent opened in the Task's one workspace, each on its own Run's checkout.
        expect(tabs(yield* rig.calls())).toEqual([
          { workspace: "wT", cwd: rig.projectDir },
          { workspace: "wT", cwd: worktree },
        ]);
        expect(yield* rig.cmds()).not.toContain("workspace create");
        expect(yield* rig.cmds()).not.toContain("worktree create");
        expect((yield* readTask(env().stateDir, "task-1"))?.workspace).toBe("wT");
      }),
    ),
  120_000,
);

test(
  "a child that is work of its own is a Task of its own, in a workspace opened on its checkout",
  () =>
    runEffect(
      Effect.gen(function* () {
        const task = yield* aTask;
        yield* rig.queueOutputs([{ verdict: "clean" }, { verdict: "clean" }]);
        const views = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [spins] = yield* loaded(registry, [
              `${fixtures}/spins-off.workflow.ts`,
              `${fixtures}/builds.workflow.ts`,
            ]);
            const started = yield* start(spins!, { request: "r1", task: task.id });
            if (started._tag === "Failure") return yield* Effect.die(started.failure);
            const parent = yield* finished(started.success.runId);
            const child = yield* registry.view(`${started.success.runId}.build`);
            return { parent, child };
          }),
        );

        const worktree = worktreeOf("add-a-picker");
        expect(views.parent).toMatchObject({ task: "task-1", status: { status: "complete" } });
        expect(views.child).toMatchObject({ cwd: worktree, parent: views.parent?.runId });
        expect(views.child?.task).not.toBe("task-1");
        const own = yield* readTask(env().stateDir, views.child?.task ?? "");
        expect(own?.cwd).toBe(worktree);
        expect(own?.label).toBe("Project | Add a picker");
        expect(own?.workspace).not.toBe("wT");
        const created = (yield* rig.calls()).filter((call) => call.cmd === "workspace create");
        expect(created.map((call) => call.argv)).toEqual([
          expect.arrayContaining(["--cwd", worktree, "--no-focus"]),
        ]);
        expect(tabs(yield* rig.calls())).toEqual([{ workspace: "wT", cwd: rig.projectDir }]);
        const agents = (yield* rig.calls()).filter((call) => call.cmd === "agent start");
        expect(agents.at(-1)?.argv).toEqual(
          expect.arrayContaining(["--pane", `${own?.workspace}-p1`]),
        );
      }),
    ),
  120_000,
);

test(
  "a child that is work of its own joins the open Task working its target branch",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.startSocket();
        const parentTask = yield* aTask;
        yield* rig.queueOutputs([{ verdict: "clean" }, { verdict: "clean" }]);
        const views = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [builds, spins] = yield* loaded(registry, [
              `${fixtures}/builds.workflow.ts`,
              `${fixtures}/spins-off.workflow.ts`,
              `${fixtures}/targeted.workflow.ts`,
            ]);
            const built = yield* start(builds!, {
              request: "build",
              text: { work: "Add a picker" },
              taskLabel: "Project | Picker",
            });
            if (built._tag === "Failure") return yield* Effect.die(built.failure);
            const build = yield* finished(built.success.runId);
            const spun = yield* start(spins!, {
              request: "parent",
              task: parentTask.id,
              text: { target: `branch:master...${LOGIN}/add-a-picker` },
            });
            if (spun._tag === "Failure") return yield* Effect.die(spun.failure);
            const parent = yield* finished(spun.success.runId);
            return { build, parent, child: yield* registry.view(`${spun.success.runId}.build`) };
          }),
        );
        expect(views.parent?.status.status).toBe("complete");
        expect(views.child).toMatchObject({
          task: views.build?.task,
          parent: views.parent?.runId,
          status: { status: "complete" },
        });
        expect(views.child?.task).not.toBe(parentTask.id);
        expect((yield* rig.cmds()).filter((cmd) => cmd === "workspace create")).toHaveLength(1);
      }),
    ),
  120_000,
);

test(
  "a workflow that changes the repository, started from a directory that is not one, is refused naming it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const container = `${rig.root}/gitlab.example.com`;
        yield* fs.makeDirectory(container, { recursive: true });
        const outcome = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [builds] = yield* loaded(registry, [`${fixtures}/builds.workflow.ts`]);
            const refused = yield* start(builds!, {
              request: "r1",
              project: container,
              text: { work: "Add a picker" },
              taskLabel: "Project | Picker",
            });
            return { refused, rows: yield* (yield* Store).runs };
          }),
        );

        expect(refusedWith(outcome.refused)).toContain(`invalid_input:`);
        expect(refusedWith(outcome.refused)).toContain(container);
        // Nothing exists to clean up: no Run, no Task, no worktree, no workspace, no agent.
        expect(outcome.rows).toEqual([]);
        expect(yield* fs.exists(`${rig.root}/.herdr/worktrees`)).toBe(false);
        expect(yield* fs.exists(`${env().stateDir}/tasks`)).toBe(false);
        expect(yield* rig.cmds()).toEqual([]);
      }),
    ),
  120_000,
);

test(
  "a placement is decoded at admission, and one that asks for nothing this workflow has is refused",
  () =>
    runEffect(
      Effect.gen(function* () {
        const outcome = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [chains, builds] = yield* loaded(registry, [
              `${fixtures}/chains.workflow.ts`,
              `${fixtures}/builds.workflow.ts`,
            ]);
            return {
              nonsense: yield* start(builds!, {
                request: "r1",
                text: { work: "Add a picker" },
                options: { workspace: "elsewhere" },
              }),
              nowhere: yield* start(builds!, {
                request: "r2",
                text: { work: "Add a picker" },
                options: { workspace: `${rig.root}/not-there` },
              }),
              separate: yield* start(chains!, { request: "r3", options: { workspace: "new" } }),
              rows: yield* (yield* Store).runs,
            };
          }),
        );

        expect(refusedWith(outcome.nonsense)).toStartWith("invalid_input: workspace:");
        expect(refusedWith(outcome.nonsense)).toContain('"elsewhere"');
        expect(refusedWith(outcome.nowhere)).toStartWith("invalid_input: workspace:");
        expect(refusedWith(outcome.nowhere)).toContain(`${rig.root}/not-there`);
        expect(refusedWith(outcome.separate)).toStartWith("invalid_input: workspace:");
        expect(refusedWith(outcome.separate)).toContain('"chains"');
        expect(outcome.rows).toEqual([]);
        expect(yield* rig.cmds()).toEqual([]);
      }),
    ),
  120_000,
);

test(
  "a follow-up builds on its parent's branch, in its parent's worktree",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([{ verdict: "clean" }, { verdict: "clean" }]);
        const seen = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [builds] = yield* loaded(registry, [`${fixtures}/builds.workflow.ts`]);
            const started = yield* start(builds!, {
              request: "r1",
              text: { work: "Add a picker" },
              taskLabel: "Project | Picker",
            });
            if (started._tag === "Failure") return yield* Effect.die(started.failure);
            const parent = yield* finished(started.success.runId);
            const child = yield* registry
              .invoke({
                runId: started.success.runId,
                offer: "keep-going",
                input: { work: "Also sort it" },
                request: "r2",
              })
              .pipe(Effect.orDie);
            return { parent, child: yield* finished(child.runId) };
          }),
        );

        expect(seen.parent).toMatchObject({
          branch: `${LOGIN}/add-a-picker`,
          cwd: worktreeOf("add-a-picker"),
        });
        expect(seen.child).toMatchObject({
          branch: seen.parent?.branch,
          cwd: seen.parent?.cwd,
          task: seen.parent?.task,
        });
      }),
    ),
  120_000,
);

test(
  "a start whose branch's checkout path is held works one slot along, and its log says whose the path is",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const held = worktreeOf("add-a-picker");
        yield* fs.makeDirectory(held, { recursive: true });
        yield* fs.writeFileString(`${held}/notes.txt`, "mine\n");
        yield* rig.queueOutputs([{ verdict: "clean" }]);
        const seen = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [builds] = yield* loaded(registry, [`${fixtures}/builds.workflow.ts`]);
            const started = yield* start(builds!, {
              request: "r1",
              text: { work: "Add a picker" },
              taskLabel: "Project | Picker",
            });
            if (started._tag === "Failure") return yield* Effect.die(started.failure);
            return {
              run: yield* finished(started.success.runId),
              log: yield* fs.readFileString(`${dir()}/runs/${started.success.runId}/log.txt`),
            };
          }),
        );

        expect(seen.run?.cwd).toBe(`${held}-2`);
        expect(seen.log).toContain(
          `passing over ${held} is a checkout that does not say which repository it belongs to`,
        );
        expect(yield* fs.readFileString(`${held}/notes.txt`)).toBe("mine\n");
      }),
    ),
  120_000,
);

test(
  "a stopped Run on a branch offers no follow-up, since it could be resumed in that checkout",
  () =>
    runEffect(
      Effect.gen(function* () {
        const seen = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const store = yield* Store;
            const [waits] = yield* loaded(registry, [`${fixtures}/waits.workflow.ts`]);
            const started = yield* start(waits!, {
              request: "r1",
              text: { work: "Add a picker" },
              taskLabel: "Project | Picker",
            });
            if (started._tag === "Failure") return yield* Effect.die(started.failure);
            const runId = started.success.runId;
            yield* until(
              () => store.asked(runId),
              (rows) => rows.length > 0,
            );
            yield* registry.control({ runId, control: "stop", set: true });
            return {
              offers: yield* registry.offers(runId),
              invoked: yield* registry
                .invoke({ runId, offer: "carry-on", input: { work: "more" }, request: "r2" })
                .pipe(Effect.result),
              rows: yield* store.runs,
            };
          }),
        );

        expect(seen.offers[0]?.unavailable).toContain("could be resumed");
        expect(refusedWith(seen.invoked)).toContain("could be resumed");
        expect(seen.rows).toHaveLength(1);
      }),
    ),
  120_000,
);

test(
  "a fresh Task's workspace is rooted at the checkout its first Run was given",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.startSocket();
        yield* rig.queueOutputs([{ verdict: "clean" }]);
        const view = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [builds] = yield* loaded(registry, [`${fixtures}/builds.workflow.ts`]);
            const started = yield* start(builds!, {
              request: "r1",
              text: { work: "Add a picker" },
              taskLabel: "Project | Picker",
            });
            if (started._tag === "Failure") return yield* Effect.die(started.failure);
            const done = yield* finished(started.success.runId);
            // Nobody named the branch; the one the host inferred is what the offer sees.
            const offers = yield* registry.offers(started.success.runId);
            return { ...done!, offers: offers.map((one) => one.id) };
          }),
        );

        const worktree = worktreeOf("add-a-picker");
        expect(view.offers).toEqual(["keep-going"]);
        expect(view).toMatchObject({ cwd: worktree, workspace: null });
        const task = yield* readTask(env().stateDir, view?.task ?? "");
        expect(task).toMatchObject({ label: "Project | Picker", cwd: worktree });
        const created = (yield* rig.calls()).filter((call) => call.cmd === "workspace create");
        expect(created.map((call) => call.argv)).toEqual([
          expect.arrayContaining(["--cwd", worktree, "--no-focus"]),
        ]);
        // A start never takes the human away from what they are looking at.
        expect(yield* rig.cmds()).not.toContain("workspace.focus");
        // The first agent takes over the shell the workspace came with, rather than leaving
        // it an empty first tab beside one of its own.
        expect(tabs(yield* rig.calls())).toEqual([]);
        const agentStart = (yield* rig.calls()).find((call) => call.cmd === "agent start");
        expect(agentStart?.argv).toEqual(
          expect.arrayContaining(["--pane", `${task?.workspace}-p1`]),
        );
        expect(task?.root_pane ?? null).toBeNull();
      }),
    ),
  120_000,
);

test(
  "one request started twice at once is placed once: one worktree, one Task, one workspace",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([{ verdict: "clean" }]);
        const outcome = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [builds] = yield* loaded(registry, [`${fixtures}/builds.workflow.ts`]);
            const ask = { request: "r1", text: { work: "Add a picker" }, taskLabel: "Project | P" };
            const both = yield* Effect.all([start(builds!, ask), start(builds!, ask)], {
              concurrency: "unbounded",
            });
            const ids = both.map((one) => (one._tag === "Success" ? one.success.runId : ""));
            yield* finished(ids[0] ?? "");
            return { ids, rows: yield* (yield* Store).runs };
          }),
        );

        expect(new Set(outcome.ids).size).toBe(1);
        expect(outcome.rows).toHaveLength(1);
        const cmds = yield* rig.cmds();
        expect(cmds.filter((cmd) => cmd === "workspace create")).toHaveLength(1);
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.readDirectory(`${env().stateDir}/tasks`)).toHaveLength(1);
      }),
    ),
  120_000,
);

test(
  "a start the host died between claiming and placing is placed and run when it comes back",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([{ verdict: "clean" }]);
        expect(yield* claimCut()).toBeNull();

        const view = yield* hosted(finished("run-cut"));
        expect(view?.cwd).toStartWith(`${rig.root}/.herdr/worktrees/`);
        expect(view?.worktree?.path).toBe(view?.cwd);
        expect(view?.task).not.toBeNull();
        expect(view?.status.status).toBe("complete");
        expect((yield* rig.cmds()).filter((cmd) => cmd === "workspace create")).toHaveLength(1);
      }),
    ),
  120_000,
);

test(
  "a start the host died after herdr opened its workspace is placed in that workspace",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([{ verdict: "clean" }]);
        yield* rig.addWorkspace("wX", "Project | P", rig.projectDir);
        yield* claimCut({ workspace: "wX" });

        const view = yield* hosted(finished("run-cut"));
        expect(view?.status.status).toBe("complete");
        expect((yield* readTask(env().stateDir, view?.task ?? ""))?.workspace).toBe("wX");
        expect((yield* rig.cmds()).filter((cmd) => cmd === "workspace create")).toEqual([]);
      }),
    ),
  120_000,
);

test(
  "a start the host died opening a workspace for opens no second one, and keeps its claim",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* claimCut({ workspace: null });

        const again = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [builds] = yield* loaded(registry, [`${fixtures}/builds.workflow.ts`]);
            const ask = { request: "r1", text: { work: "Add a picker" }, taskLabel: "Project | P" };
            return {
              started: yield* start(builds!, ask),
              row: yield* (yield* Store).run("run-cut"),
            };
          }),
        );
        expect(refusedWith(again.started)).toContain("may have been opened for run-cut");
        expect(again.row?.checkout).toBeNull();
        expect((yield* rig.cmds()).filter((cmd) => cmd === "workspace create")).toEqual([]);
      }),
    ),
  120_000,
);

test(
  "a start the host died cutting a checkout for cuts no second one, and keeps its claim",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* claimCut({ checkout: null });

        const again = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [builds] = yield* loaded(registry, [`${fixtures}/builds.workflow.ts`]);
            const ask = { request: "r1", text: { work: "Add a picker" }, taskLabel: "Project | P" };
            return {
              started: yield* start(builds!, ask),
              row: yield* (yield* Store).run("run-cut"),
            };
          }),
        );
        expect(refusedWith(again.started)).toContain("may have been cut for run-cut");
        expect(again.row?.checkout).toBeNull();
        const fs = yield* FileSystem.FileSystem;
        expect(yield* fs.exists(`${rig.root}/.herdr/worktrees`)).toBe(false);
      }),
    ),
  120_000,
);

/** A plan whose tickets name checkouts under the project, the web one waiting on the api. */
const twoRepoPlan = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const plan = `${rig.root}/plan`;
  yield* fs.makeDirectory(`${plan}/issues`, { recursive: true });
  yield* fs.writeFileString(`${plan}/SPEC.md`, "# The spec\n");
  yield* fs.writeFileString(`${plan}/issues/01-api.md`, "# The api\n\n**Repo:** api\n");
  yield* fs.writeFileString(
    `${plan}/issues/02-web.md`,
    "# The web\n\n**Repo:** web\n\n**Blocked by:** 01\n",
  );
  return plan;
});

test(
  "implement started on a plan that spans repositories cuts no checkout, and starts each repository's Run",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const plan = yield* twoRepoPlan;
        for (const repo of ["api", "web"]) {
          yield* fs.makeDirectory(`${rig.projectDir}/${repo}/.collie`, { recursive: true });
          yield* gitRepo(`${rig.projectDir}/${repo}`);
        }
        yield* fs.writeFileString(
          `${rig.projectDir}/api/.collie/verify.json`,
          '[{"name":"api-unit","executable":"true","argv":[],"cwd":"worktree"}]',
        );
        yield* fs.writeFileString(
          `${rig.projectDir}/web/.collie/verify.json`,
          '[{"name":"web-unit","executable":"true","argv":[],"cwd":"worktree"}]',
        );

        const seen = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [implement] = yield* loaded(registry, [shipped("implement")]);
            const started = yield* start(implement!, { request: "r1", text: { plan } });
            if (started._tag === "Failure") return yield* Effect.die(started.failure);
            const runId = started.success.runId;
            // Until the api's Run is placed and held to what it approved, not merely admitted.
            const [api, approved] = yield* until(
              () =>
                Effect.all([
                  registry.view(`${runId}.implement-api`),
                  fs
                    .readFileString(`${evidenceDir(dir(), `${runId}.implement-api`)}/approved.json`)
                    .pipe(Effect.orElseSucceed(() => null)),
                ]),
              // Written in place, so a read can land between the open and the write.
              ([view, read]) => view?.branch != null && (read ?? "").trim() !== "",
            );
            return {
              runId,
              parent: yield* registry.view(runId),
              api,
              web: yield* registry.view(`${runId}.implement-web`),
              approved,
            };
          }),
        );
        expect(seen.parent?.worktree).toBeNull();
        expect(seen.parent?.cwd).toBe(rig.projectDir);
        expect(seen.api?.options).toMatchObject({ repo: "api" });
        expect(seen.api?.worktree?.path).toStartWith(`${rig.root}/.herdr/worktrees/api/`);
        expect(seen.api?.branch).toBe(`${LOGIN}/${seen.runId}`);
        // Held to what its own repository approved, not the project it was started from.
        expect(seen.approved).toContain('"api-unit"');
        // The web waits on the api, so nothing has started it yet.
        expect(seen.web).toBeNull();
      }),
    ),
  120_000,
);

test(
  "implement on a plan spanning repositories is admitted where one names no checks, and refuses one --verify for all",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const plan = yield* twoRepoPlan;
        for (const repo of ["api", "web"]) {
          yield* fs.makeDirectory(`${rig.projectDir}/${repo}/.collie`, { recursive: true });
          yield* gitRepo(`${rig.projectDir}/${repo}`);
        }
        yield* fs.writeFileString(
          `${rig.projectDir}/api/.collie/verify.json`,
          '[{"name":"api-unit","executable":"true","argv":[],"cwd":"worktree"}]',
        );
        const outcome = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [implement] = yield* loaded(registry, [shipped("implement")]);
            const verified = yield* registry
              .start({
                generation: implement!,
                request: "r0",
                project: rig.projectDir,
                input: {},
                text: { plan },
                verify: [{ name: "unit", executable: "true", argv: [], cwd: "worktree" }],
                task: null,
              })
              .pipe(Effect.result);
            const started = yield* start(implement!, { request: "r1", text: { plan } });
            const rows = yield* (yield* Store).runs;
            yield* fs.writeFileString(`${rig.projectDir}/web/.collie/verify.json`, '[{"name":');
            return {
              verified,
              started,
              rows,
              unreadable: yield* start(implement!, { request: "r2", text: { plan } }),
            };
          }),
        );
        expect(refusedWith(outcome.verified)).toContain("this plan spans repositories");
        expect(refusedWith(outcome.started)).toBe("");
        expect(outcome.rows.length).toBeGreaterThan(0);
        expect(refusedWith(outcome.unreadable)).toContain("web/.collie/verify.json");
      }),
    ),
  120_000,
);

const UNIT = { name: "unit", executable: "true", argv: [], cwd: "worktree" } as const;

/** What a Run was frozen with at admission. */
const frozen = (runId: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(`${evidenceDir(dir(), runId)}/approved.json`)),
    Effect.flatMap(
      Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(VerifySpecSchema))),
    ),
    Effect.orDie,
  );

test(
  "an empty set given with a start is none given, and the project's verify.json proves it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${rig.projectDir}/.collie`, { recursive: true });
        yield* fs.writeFileString(
          `${rig.projectDir}/.collie/verify.json`,
          '[{"name":"unit","executable":"true","argv":[],"cwd":"worktree"}]',
        );
        const started = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [proved] = yield* loaded(registry, [`${fixtures}/proved.workflow.ts`]);
            return yield* registry
              .start({
                generation: proved!,
                request: "r1",
                project: rig.projectDir,
                input: { note: "x" },
                verify: [],
              })
              .pipe(Effect.result);
          }),
        );
        expect(refusedWith(started)).toBe("");
        if (started._tag === "Success")
          expect(yield* frozen(started.success.runId)).toEqual([UNIT]);
      }),
    ),
  120_000,
);

test(
  "a chained child is held to its parent's checks, grants included, rather than the project's",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${rig.projectDir}/.collie`, { recursive: true });
        yield* fs.writeFileString(
          `${rig.projectDir}/.collie/verify.json`,
          '[{"name":"unit","executable":"true","argv":[],"cwd":"worktree"}]',
        );
        const task = yield* aTask;
        yield* rig.queueOutputs([{ verdict: "clean" }, { verdict: "clean" }]);
        const granted = { ...UNIT, name: "granted" };
        const runId = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [chains] = yield* loaded(registry, [
              `${fixtures}/chains.workflow.ts`,
              `${fixtures}/builds.workflow.ts`,
            ]);
            const started = yield* registry
              .start({
                generation: chains!,
                request: "r1",
                project: rig.projectDir,
                input: {},
                verify: [granted],
                task: task.id,
              })
              .pipe(Effect.result);
            if (started._tag === "Failure") return yield* Effect.die(started.failure);
            yield* finished(started.success.runId);
            return started.success.runId;
          }),
        );
        expect(yield* frozen(runId)).toEqual([granted]);
        expect(yield* frozen(`${runId}.build`)).toEqual([granted]);
      }),
    ),
  120_000,
);

test(
  "a Run started in a checkout with a remote begins with the checks remembered for it, over the user's",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* exec(["git", "remote", "add", "origin", "git@example.test:team/app.git"], {
          cwd: rig.projectDir,
        });
        yield* fs.writeFileString(
          `${rig.userDir}/verify.json`,
          '[{"name":"lint","executable":"false","argv":[],"cwd":"worktree"}]',
        );
        yield* fs.makeDirectory(`${rig.userDir}/verify/example.test/team`, { recursive: true });
        yield* fs.writeFileString(
          `${rig.userDir}/verify/example.test/team/app.json`,
          '[{"name":"unit","executable":"true","argv":[],"cwd":"worktree"}]',
        );
        const started = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [proved] = yield* loaded(registry, [`${fixtures}/proved.workflow.ts`]);
            return yield* registry
              .start({
                generation: proved!,
                request: "r1",
                project: rig.projectDir,
                input: { note: "x" },
              })
              .pipe(Effect.result);
          }),
        );
        expect(refusedWith(started)).toBe("");
        if (started._tag === "Success")
          expect(yield* frozen(started.success.runId)).toEqual([UNIT]);
      }),
    ),
  120_000,
);

test(
  "a retried start admitted before its set was frozen is frozen with the set it carries",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [proved] = yield* loaded(registry, [`${fixtures}/proved.workflow.ts`]);
            const input = { note: "x" };
            // The host died between admitting the Run and freezing what proves it.
            yield* (yield* Store).admit({
              request: "r1",
              run: "run-cut",
              workflow: "proved",
              project: rig.projectDir,
              input,
              provenance: { note: "given" },
              options: {},
              placing: asPlacing({ from: rig.projectDir, taskLabel: "Project | P" }),
              generation: proved!.name,
              execution: yield* proved!.registration.workflow.executionId({
                runId: "run-cut",
                input,
              }),
              task: null,
              parent: null,
            });
            const retried = yield* registry.start({
              generation: proved!,
              request: "r1",
              project: rig.projectDir,
              input,
              verify: [UNIT],
            });
            return retried.runId;
          }),
        );
        expect(runId).toBe("run-cut");
        expect(yield* frozen(runId)).toEqual([UNIT]);
      }),
    ),
  120_000,
);

test(
  "implement started on a plan it cannot fan out is refused, and nothing is admitted",
  () =>
    runEffect(
      Effect.gen(function* () {
        const plan = yield* twoRepoPlan;
        const outcome = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [implement] = yield* loaded(registry, [shipped("implement")]);
            return {
              started: yield* start(implement!, { request: "r1", text: { plan } }),
              rows: yield* (yield* Store).runs,
            };
          }),
        );
        expect(refusedWith(outcome.started)).toContain(
          '"implement" cannot run here: These repositories are named by a ticket but not checked out',
        );
        expect(outcome.rows).toEqual([]);
      }),
    ),
  120_000,
);

test(
  "a roaming start found holding a checkout when its host comes back keeps its claim",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* claimCut({}, "roams");
        const roaming = `${rig.root}/.herdr/worktrees/project/roaming`;
        yield* exec(["git", "worktree", "add", "--quiet", "--detach", roaming, "master"], {
          cwd: rig.projectDir,
        });

        const row = yield* hosted(
          Effect.gen(function* () {
            yield* Registry;
            return yield* (yield* Store).run("run-cut");
          }),
        );
        expect(row?.run).toBe("run-cut");
        expect(row?.checkout).toBeNull();
      }),
    ),
  120_000,
);

test(
  "a roaming start takes over the checkout a failed Run of the repository left, and moves it to the default branch",
  () =>
    runEffect(
      Effect.gen(function* () {
        const roaming = `${rig.root}/.herdr/worktrees/project/roaming`;
        const views = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [roams] = yield* loaded(registry, [`${fixtures}/roams.workflow.ts`]);
            const first = yield* start(roams!, { request: "r1", text: { work: "fail" } });
            if (first._tag === "Failure") return yield* Effect.die(first.failure);
            const failed = yield* finished(first.success.runId);
            // Where the failed Run left its checkout: somewhere other than the default branch.
            yield* exec(["git", "checkout", "--quiet", "-b", "renovate/left", "master"], {
              cwd: roaming,
            });
            const again = yield* start(roams!, { request: "r2", text: { work: "again" } });
            if (again._tag === "Failure") return yield* Effect.die(again.failure);
            return { failed, retried: yield* finished(again.success.runId) };
          }),
        );

        expect(views.failed?.status.status).toBe("failed");
        expect(views.retried?.status).toEqual({ status: "complete", value: roaming });
        expect(views.retried?.worktree?.path).toBe(roaming);
        const head = yield* exec(["git", "symbolic-ref", "-q", "HEAD"], { cwd: roaming });
        expect(head.exitCode).not.toBe(0);
        // The branch the failed Run left is still there, with whatever it held.
        const left = yield* exec(["git", "rev-parse", "--verify", "renovate/left"], {
          cwd: rig.projectDir,
        });
        expect(left.exitCode).toBe(0);
      }),
    ),
  120_000,
);

test(
  "self-improve started on a checkout works in a fresh worktree detached at origin's latest default branch, leaving the checkout alone",
  () =>
    runEffect(
      Effect.gen(function* () {
        const roaming = `${rig.root}/.herdr/worktrees/project/roaming`;
        const fs = yield* FileSystem.FileSystem;
        const git = (cwd: string, ...args: string[]) =>
          exec(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd });
        const origin = `${rig.root}/origin.git`;
        const elsewhere = `${rig.root}/elsewhere`;
        yield* git(rig.root, "init", "--quiet", "--bare", "-b", "master", origin);
        yield* git(rig.projectDir, "remote", "add", "origin", origin);
        yield* git(rig.projectDir, "push", "--quiet", "origin", "master");
        // origin moves on after this checkout last fetched.
        yield* git(rig.root, "clone", "--quiet", origin, elsewhere);
        yield* git(elsewhere, "commit", "--quiet", "--allow-empty", "-m", "later");
        yield* git(elsewhere, "push", "--quiet", "origin", "master");
        const latest = (yield* git(elsewhere, "rev-parse", "HEAD")).stdout.trim();
        yield* fs.writeFileString(`${rig.projectDir}/other-work.txt`, "someone else's");
        const view = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [improve] = yield* loaded(registry, [shipped("self-improve")]);
            const started = yield* start(improve!, {
              request: "r1",
              text: { runs: "checkout" },
              options: { workspace: rig.projectDir },
            });
            if (started._tag === "Failure") return yield* Effect.die(started.failure);
            return yield* finished(started.success.runId);
          }),
        );

        expect(view?.status.status).toBe("complete");
        expect(view?.worktree?.path).toBe(roaming);
        const head = yield* exec(["git", "symbolic-ref", "-q", "HEAD"], { cwd: roaming });
        expect(head.exitCode).not.toBe(0);
        expect((yield* git(roaming, "rev-parse", "HEAD")).stdout.trim()).toBe(latest);
        expect((yield* git(rig.projectDir, "rev-parse", "master")).stdout.trim()).not.toBe(latest);
        expect(yield* fs.exists(`${roaming}/other-work.txt`)).toBe(false);
        expect(yield* fs.readFileString(`${rig.projectDir}/other-work.txt`)).toBe("someone else's");
      }),
    ),
  120_000,
);

test(
  "a roaming start is refused the checkout of a Run that may still go on, stopped or waiting, with its changes in it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const roaming = `${rig.root}/.herdr/worktrees/project/roaming`;
        const fs = yield* FileSystem.FileSystem;
        const refusals = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [roams, waits] = yield* loaded(registry, [
              `${fixtures}/roams.workflow.ts`,
              `${fixtures}/roams-and-waits.workflow.ts`,
            ]);
            const waiting = yield* start(waits!, { request: "r1", text: { work: "wait" } });
            if (waiting._tag === "Failure") return yield* Effect.die(waiting.failure);
            yield* until(
              () => registry.view(waiting.success.runId),
              (view) => view?.status.status === "suspended",
            );
            yield* fs.writeFileString(`${roaming}/left.txt`, "live work");
            const whileWaiting = refusedWith(
              yield* start(roams!, { request: "r2", text: { work: "next" } }),
            );
            // A stopped Run has not ended either: a resume picks it up again in its checkout.
            const runId = waiting.success.runId;
            yield* registry.control({ runId, control: "stop", set: true });
            const whileStopped = refusedWith(
              yield* start(roams!, { request: "r2-stopped", text: { work: "next" } }),
            );
            yield* registry.control({ runId, control: "stop", set: false });
            yield* registry.answer({
              runId: waiting.success.runId,
              decision: "go",
              value: "yes",
              request: "answer-go",
            });
            const ended = yield* finished(waiting.success.runId);
            return { whileWaiting, whileStopped, ended };
          }),
        );

        expect(refusals.whileWaiting).toContain(`${roaming} is a checkout of`);
        expect(refusals.whileWaiting).toContain("has not ended");
        expect(refusals.whileStopped).toContain("has not ended");
        expect(refusals.whileWaiting).not.toContain("uncommitted changes");
        expect(refusals.whileStopped).not.toContain("uncommitted changes");
        // Nothing was closed under it: it answered and finished in its checkout.
        expect(refusals.ended?.status).toEqual({ status: "complete", value: roaming });
        expect(yield* fs.readFileString(`${roaming}/left.txt`)).toBe("live work");
      }),
    ),
  120_000,
);

const headOf = (at: string) =>
  exec(["git", "rev-parse", "HEAD"], { cwd: at }).pipe(Effect.map((done) => done.stdout.trim()));

const logOf = (runId: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(`${runDir(dir(), runId)}/log.txt`)),
    Effect.orElseSucceed(() => ""),
  );

const committing = (cwd: string, ...args: string[]) =>
  exec(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd });

const withOrigin = Effect.gen(function* () {
  const origin = `${rig.root}/origin.git`;
  yield* committing(rig.root, "init", "--quiet", "--bare", "-b", "master", origin);
  yield* committing(rig.projectDir, "remote", "add", "origin", origin);
  yield* committing(rig.projectDir, "push", "--quiet", "origin", "master");
  return origin;
});

/** A roaming start that fails at once, leaving its checkout to the next one. */
const endedIn = (roams: Generation, request: string) =>
  Effect.gen(function* () {
    const started = yield* start(roams, { request, text: { work: "fail" } });
    if (started._tag === "Failure") return yield* Effect.die(started.failure);
    const view = yield* finished(started.success.runId);
    return { runId: started.success.runId, at: view?.worktree?.path ?? "" };
  });

test(
  "a roaming start passes over the checkout an ended Run left changes in, and works in the next one",
  () =>
    runEffect(
      Effect.gen(function* () {
        const roaming = `${rig.root}/.herdr/worktrees/project/roaming`;
        const fs = yield* FileSystem.FileSystem;
        const seen = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [roams] = yield* loaded(registry, [`${fixtures}/roams.workflow.ts`]);
            const left = yield* endedIn(roams!, "r1");
            yield* fs.writeFileString(`${roaming}/left.txt`, "work");
            const kept = yield* headOf(roaming);
            const next = yield* start(roams!, { request: "r2", text: { work: "next" } });
            if (next._tag === "Failure") return yield* Effect.die(next.failure);
            return {
              left: left.runId,
              kept,
              view: yield* finished(next.success.runId),
              log: yield* logOf(next.success.runId),
            };
          }),
        );

        expect(seen.view?.status).toEqual({ status: "complete", value: `${roaming}-2` });
        expect(seen.log).toContain(
          `passed over ${roaming}: a checkout of ${rig.projectDir}, recorded by Run ${seen.left}, kept: uncommitted changes`,
        );
        expect(yield* fs.readFileString(`${roaming}/left.txt`)).toBe("work");
        expect(yield* headOf(roaming)).toBe(seen.kept);
      }),
    ),
  120_000,
);

test(
  "the cleanup sweep removes a clean roaming checkout an ended Run left past a kept one, and keeps the kept one",
  () =>
    runEffect(
      Effect.gen(function* () {
        const roaming = `${rig.root}/.herdr/worktrees/project/roaming`;
        const fs = yield* FileSystem.FileSystem;
        yield* withOrigin;
        const runs = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [roams] = yield* loaded(registry, [`${fixtures}/roams.workflow.ts`]);
            yield* endedIn(roams!, "r1");
            yield* fs.writeFileString(`${roaming}/left.txt`, "work");
            const next = yield* start(roams!, { request: "r2", text: { work: "next" } });
            if (next._tag === "Failure") return yield* Effect.die(next.failure);
            yield* finished(next.success.runId);
            // herdr lists the repository's checkouts, as it would git's.
            const state = `${rig.logPath}.state.json`;
            const was = Schema.decodeUnknownSync(
              Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
            )(yield* fs.readFileString(state).pipe(Effect.orElseSucceed(() => "{}")));
            const worktrees = [roaming, `${roaming}-2`].map((path) => ({
              path,
              branch: "",
              open_workspace_id: null,
            }));
            yield* fs.writeFileString(state, asJson({ ...was, worktrees }));
            return (yield* registry.views(null)).map((view) => factsOfView(dir(), view));
          }),
        );
        const herdr = new FakeHerdr(env());
        const report = yield* sweep(
          [
            worktreesSweeper({
              herdr,
              sessions: [herdr],
              stateDir: dir(),
              runs,
              registered: [],
              cwd: rig.projectDir,
            }),
          ],
          dir(),
          "host",
        );

        expect(report.remove.map((one) => one.target)).toEqual([`${roaming}-2`]);
        expect(report.keep).toContainEqual({
          kind: "worktree",
          target: roaming,
          reason: "uncommitted changes",
        });
        expect(yield* fs.exists(`${roaming}-2`)).toBe(false);
        expect(yield* fs.readFileString(`${roaming}/left.txt`)).toBe("work");
      }),
    ),
  120_000,
);

test(
  "a roaming start passes over the checkout an ended Run left a commit on no branch in",
  () =>
    runEffect(
      Effect.gen(function* () {
        const roaming = `${rig.root}/.herdr/worktrees/project/roaming`;
        const seen = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [roams] = yield* loaded(registry, [`${fixtures}/roams.workflow.ts`]);
            yield* endedIn(roams!, "r1");
            yield* committing(roaming, "commit", "--quiet", "--allow-empty", "-m", "kept");
            const kept = yield* headOf(roaming);
            const next = yield* start(roams!, { request: "r2", text: { work: "next" } });
            if (next._tag === "Failure") return yield* Effect.die(next.failure);
            return {
              kept,
              view: yield* finished(next.success.runId),
              log: yield* logOf(next.success.runId),
            };
          }),
        );

        expect(seen.view?.status).toEqual({ status: "complete", value: `${roaming}-2` });
        expect(seen.log).toContain(`passed over ${roaming}: `);
        expect(seen.log).toContain("kept: 1 commit on no branch or remote");
        expect(yield* headOf(roaming)).toBe(seen.kept);
      }),
    ),
  120_000,
);

test(
  "a roaming start takes over the next checkout an ended Run left clean rather than making another",
  () =>
    runEffect(
      Effect.gen(function* () {
        const roaming = `${rig.root}/.herdr/worktrees/project/roaming`;
        const fs = yield* FileSystem.FileSystem;
        const seen = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [roams] = yield* loaded(registry, [`${fixtures}/roams.workflow.ts`]);
            yield* endedIn(roams!, "r1");
            yield* fs.writeFileString(`${roaming}/left.txt`, "work");
            const first = yield* endedIn(roams!, "r2");
            const next = yield* start(roams!, { request: "r3", text: { work: "next" } });
            if (next._tag === "Failure") return yield* Effect.die(next.failure);
            return {
              first,
              view: yield* finished(next.success.runId),
              log: yield* logOf(next.success.runId),
            };
          }),
        );

        expect(seen.first.at).toBe(`${roaming}-2`);
        expect(seen.view?.status).toEqual({ status: "complete", value: `${roaming}-2` });
        expect(seen.log).toContain(`took worktree ${roaming}-2 over from Run ${seen.first.runId}`);
        expect(yield* fs.exists(`${roaming}-3`)).toBe(false);
      }),
    ),
  120_000,
);

test(
  "two roaming starts at once past a kept checkout: one works, the other is refused while it has not ended",
  () =>
    runEffect(
      Effect.gen(function* () {
        const roaming = `${rig.root}/.herdr/worktrees/project/roaming`;
        const fs = yield* FileSystem.FileSystem;
        const seen = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [roams, waits] = yield* loaded(registry, [
              `${fixtures}/roams.workflow.ts`,
              `${fixtures}/roams-and-waits.workflow.ts`,
            ]);
            yield* endedIn(roams!, "r1");
            yield* fs.writeFileString(`${roaming}/left.txt`, "work");
            const kept = yield* headOf(roaming);
            const both = yield* Effect.all(
              [
                start(waits!, { request: "r2", text: { work: "wait" } }),
                start(waits!, { request: "r3", text: { work: "wait" } }),
              ],
              { concurrency: "unbounded" },
            );
            const worked = both.filter(Result.isSuccess).map((one) => one.success.runId);
            const refused = both.filter(Result.isFailure).map(refusedWith);
            const places: string[] = [];
            for (const runId of worked) {
              const view = yield* until(
                () => registry.view(runId),
                (view) => view?.status.status === "suspended",
              );
              places.push(view?.worktree?.path ?? "");
              yield* registry.answer({
                runId,
                decision: "go",
                value: "yes",
                request: `go-${runId}`,
              });
              yield* finished(runId);
            }
            return { kept, worked, refused, places };
          }),
        );

        expect(seen.worked).toHaveLength(1);
        expect(seen.places).toEqual([`${roaming}-2`]);
        expect(seen.refused).toHaveLength(1);
        expect(seen.refused[0]).toContain(`${seen.worked[0]} has not ended`);
        expect(yield* fs.readFileString(`${roaming}/left.txt`)).toBe("work");
        expect(yield* headOf(roaming)).toBe(seen.kept);
      }),
    ),
  120_000,
);

test(
  "a roaming start passes over another clone's checkout of the same name and leaves it alone",
  () =>
    runEffect(
      Effect.gen(function* () {
        const roaming = `${rig.root}/.herdr/worktrees/project/roaming`;
        const fs = yield* FileSystem.FileSystem;
        const other = `${rig.root}/elsewhere/project`;
        yield* committing(rig.root, "clone", "--quiet", yield* withOrigin, other);
        yield* committing(other, "worktree", "add", "--quiet", "--detach", roaming, "master");
        yield* fs.writeFileString(`${roaming}/theirs.txt`, "theirs");
        const kept = yield* headOf(roaming);
        const listed = (yield* committing(other, "worktree", "list", "--porcelain")).stdout;
        const seen = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [roams] = yield* loaded(registry, [`${fixtures}/roams.workflow.ts`]);
            const next = yield* start(roams!, { request: "r1", text: { work: "next" } });
            if (next._tag === "Failure") return yield* Effect.die(next.failure);
            return {
              view: yield* finished(next.success.runId),
              log: yield* logOf(next.success.runId),
            };
          }),
        );

        expect(seen.view?.status).toEqual({ status: "complete", value: `${roaming}-2` });
        expect(seen.log).toContain(
          `passed over ${roaming}: a checkout of ${other}, kept: another clone's`,
        );
        expect(yield* fs.readFileString(`${roaming}/theirs.txt`)).toBe("theirs");
        expect(yield* headOf(roaming)).toBe(kept);
        expect((yield* committing(other, "worktree", "list", "--porcelain")).stdout).toBe(listed);
      }),
    ),
  120_000,
);

test(
  "a roaming start is refused once all three checkouts are kept, naming each and why",
  () =>
    runEffect(
      Effect.gen(function* () {
        const roaming = `${rig.root}/.herdr/worktrees/project/roaming`;
        const fs = yield* FileSystem.FileSystem;
        const seen = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [roams] = yield* loaded(registry, [`${fixtures}/roams.workflow.ts`]);
            const left: Array<{ runId: string; at: string; head: string }> = [];
            for (const request of ["r1", "r2", "r3"]) {
              const ended = yield* endedIn(roams!, request);
              yield* fs.writeFileString(`${ended.at}/left.txt`, request);
              left.push({ ...ended, head: yield* headOf(ended.at) });
            }
            const refused = refusedWith(
              yield* start(roams!, { request: "r4", text: { work: "next" } }),
            );
            return { left, refused };
          }),
        );

        expect(seen.left.map((one) => one.at)).toEqual([roaming, `${roaming}-2`, `${roaming}-3`]);
        for (const [at, one] of seen.left.entries()) {
          expect(seen.refused).toContain(
            `${one.at} is a checkout of ${rig.projectDir}, recorded by Run ${one.runId}, kept: uncommitted changes`,
          );
          expect(yield* fs.readFileString(`${one.at}/left.txt`)).toBe(`r${at + 1}`);
          expect(yield* headOf(one.at)).toBe(one.head);
        }
      }),
    ),
  120_000,
);

test(
  "a roaming claim that fails past a kept checkout leaves nothing behind, and the next start works",
  () =>
    runEffect(
      Effect.gen(function* () {
        const roaming = `${rig.root}/.herdr/worktrees/project/roaming`;
        const fs = yield* FileSystem.FileSystem;
        const origin = yield* withOrigin;
        const seen = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [roams] = yield* loaded(registry, [`${fixtures}/roams.workflow.ts`]);
            yield* endedIn(roams!, "r1");
            yield* fs.writeFileString(`${roaming}/left.txt`, "work");

            yield* committing(
              rig.projectDir,
              "remote",
              "set-url",
              "origin",
              `${rig.root}/gone.git`,
            );
            const unfetched = refusedWith(
              yield* start(roams!, { request: "r2", text: { work: "next" } }),
            );
            yield* committing(rig.projectDir, "remote", "set-url", "origin", origin);
            yield* fs.chmod(`${rig.root}/.herdr/worktrees/project`, 0o555);
            const unadded = refusedWith(
              yield* start(roams!, { request: "r3", text: { work: "next" } }),
            );
            yield* fs.chmod(`${rig.root}/.herdr/worktrees/project`, 0o755);
            const recorded = (yield* registry.views(null)).flatMap((view) =>
              view.worktree === null ? [] : [view.worktree.path],
            );
            const next = yield* start(roams!, { request: "r4", text: { work: "next" } });
            if (next._tag === "Failure") return yield* Effect.die(next.failure);
            return { unfetched, unadded, recorded, view: yield* finished(next.success.runId) };
          }),
        );

        expect(seen.unfetched).toContain("could not fetch origin");
        expect(seen.unadded).toContain(`${roaming}-2`);
        expect(seen.recorded).not.toContain(`${roaming}-2`);
        expect(seen.view?.status).toEqual({ status: "complete", value: `${roaming}-2` });
      }),
    ),
  120_000,
);

test(
  "a roaming start is refused an ended Run's checkout while another Run works in it or is being placed in it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const roaming = `${rig.root}/.herdr/worktrees/project/roaming`;
        const refusals = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const store = yield* Store;
            const [roams, waits] = yield* loaded(registry, [
              `${fixtures}/roams.workflow.ts`,
              `${fixtures}/waits-here.workflow.ts`,
            ]);
            const first = yield* start(roams!, { request: "r1", text: { work: "fail" } });
            if (first._tag === "Failure") return yield* Effect.die(first.failure);
            yield* finished(first.success.runId);

            // A Run that declares no checkout, started inside this one, records none.
            const borrower = yield* start(waits!, {
              request: "r2",
              project: roaming,
              text: { work: "wait" },
            });
            if (borrower._tag === "Failure") return yield* Effect.die(borrower.failure);
            yield* until(
              () => registry.view(borrower.success.runId),
              (view) => view?.status.status === "suspended",
            );
            const whileBorrowed = refusedWith(
              yield* start(roams!, { request: "r3", text: { work: "next" } }),
            );
            yield* registry.answer({
              runId: borrower.success.runId,
              decision: "go",
              value: "yes",
              request: "answer-go",
            });
            yield* finished(borrower.success.runId);

            // A start that has taken the checkout over and not finished being placed.
            const payload = { runId: "run-placing", input: { work: "next" } };
            const placed = { cwd: roaming, branch: null, workspace: null };
            yield* store.admit({
              request: "r-placing",
              run: "run-placing",
              workflow: "roams",
              project: rig.projectDir,
              input: payload.input,
              provenance: { work: "given" },
              options: {},
              placing: Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))({
                from: rig.projectDir,
                taskLabel: null,
                checkout: {
                  placed: {
                    ...placed,
                    worktree: (yield* registry.view(first.success.runId))?.worktree,
                  },
                  opened: null,
                },
              }),
              generation: roams!.name,
              execution: yield* roams!.registration.workflow.executionId(payload),
              task: null,
              parent: null,
            });
            const whilePlacing = refusedWith(
              yield* start(roams!, { request: "r4", text: { work: "next" } }),
            );
            return { whileBorrowed, whilePlacing };
          }),
        );

        expect(refusals.whileBorrowed).toContain(`${roaming} is a checkout of`);
        expect(refusals.whileBorrowed).toContain("has not ended");
        expect(refusals.whilePlacing).toContain("recorded by Run run-placing");
        expect(refusals.whilePlacing).toContain("run-placing has not ended");
      }),
    ),
  120_000,
);

test(
  "a roaming start is refused an ended Run's checkout while a Run works in it through a symlink",
  () =>
    runEffect(
      Effect.gen(function* () {
        const roaming = `${rig.root}/.herdr/worktrees/project/roaming`;
        const link = `${rig.root}/roaming-link`;
        const refused = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [roams, waits] = yield* loaded(registry, [
              `${fixtures}/roams.workflow.ts`,
              `${fixtures}/waits-here.workflow.ts`,
            ]);
            const first = yield* start(roams!, { request: "r1", text: { work: "fail" } });
            if (first._tag === "Failure") return yield* Effect.die(first.failure);
            yield* finished(first.success.runId);
            yield* (yield* FileSystem.FileSystem).symlink(roaming, link);
            const borrower = yield* start(waits!, {
              request: "r2",
              options: { workspace: link },
              text: { work: "wait" },
            });
            if (borrower._tag === "Failure") return yield* Effect.die(borrower.failure);
            yield* until(
              () => registry.view(borrower.success.runId),
              (view) => view?.status.status === "suspended",
            );
            return refusedWith(yield* start(roams!, { request: "r3", text: { work: "next" } }));
          }),
        );

        expect(refused).toContain(`${roaming} is a checkout of`);
        expect(refused).toContain("has not ended");
      }),
    ),
  120_000,
);

test(
  "a roaming start is refused an ended Run's checkout where moving it would overwrite an ignored file",
  () =>
    runEffect(
      Effect.gen(function* () {
        const roaming = `${rig.root}/.herdr/worktrees/project/roaming`;
        const fs = yield* FileSystem.FileSystem;
        const git = (...args: string[]) =>
          exec(["git", ...args], {
            cwd: rig.projectDir,
            env: {
              PATH: "/usr/bin:/bin",
              HOME: rig.root,
              GIT_AUTHOR_NAME: "t",
              GIT_AUTHOR_EMAIL: "t@example.com",
              GIT_COMMITTER_NAME: "t",
              GIT_COMMITTER_EMAIL: "t@example.com",
            },
          }).pipe(
            Effect.flatMap((done) =>
              done.exitCode === 0 ? Effect.void : Effect.die(new Error(done.stderr)),
            ),
          );
        const refused = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [roams] = yield* loaded(registry, [`${fixtures}/roams.workflow.ts`]);
            const first = yield* start(roams!, { request: "r1", text: { work: "fail" } });
            if (first._tag === "Failure") return yield* Effect.die(first.failure);
            yield* finished(first.success.runId);
            // The default branch now tracks a file the checkout holds, ignored, as its own.
            yield* fs.writeFileString(`${rig.projectDir}/.git/info/exclude`, "generated.txt\n");
            yield* fs.writeFileString(`${rig.projectDir}/generated.txt`, "tracked");
            yield* git("add", "-f", "generated.txt");
            yield* git("commit", "--quiet", "-m", "track generated.txt");
            yield* fs.writeFileString(`${roaming}/generated.txt`, "local");
            return refusedWith(yield* start(roams!, { request: "r2", text: { work: "next" } }));
          }),
        );

        expect(refused).toContain(`${roaming} is a checkout of`);
        expect(refused).toContain("would be overwritten");
        expect(yield* fs.readFileString(`${roaming}/generated.txt`)).toBe("local");
      }),
    ),
  120_000,
);

test(
  "a roaming start is refused an ended Run's checkout while another session's agent works in it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const roaming = `${rig.root}/.herdr/worktrees/project/roaming`;
        const other = `${rig.root}/other.sock`;
        sessions = [rig.socketPath, other];
        const refused = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [roams] = yield* loaded(registry, [`${fixtures}/roams.workflow.ts`]);
            const first = yield* start(roams!, { request: "r1", text: { work: "fail" } });
            if (first._tag === "Failure") return yield* Effect.die(first.failure);
            yield* finished(first.success.runId);
            yield* rig.addPane("p-far", "t-far", roaming, "claude", null, null, "working", other);
            return refusedWith(yield* start(roams!, { request: "r2", text: { work: "next" } }));
          }),
        );

        expect(refused).toContain("agent claude in pane p-far works in it");
      }),
    ),
  120_000,
);

test(
  "a roaming start is refused an ended Run's checkout while herdr will not list its sessions",
  () =>
    runEffect(
      Effect.gen(function* () {
        const roaming = `${rig.root}/.herdr/worktrees/project/roaming`;
        sessions = null;
        const refused = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [roams] = yield* loaded(registry, [`${fixtures}/roams.workflow.ts`]);
            const first = yield* start(roams!, { request: "r1", text: { work: "fail" } });
            if (first._tag === "Failure") return yield* Effect.die(first.failure);
            yield* finished(first.success.runId);
            return refusedWith(yield* start(roams!, { request: "r2", text: { work: "next" } }));
          }),
        );

        expect(refused).toContain(`${roaming} is a checkout of`);
        expect(refused).toContain("herdr would not list its sessions");
      }),
    ),
  120_000,
);

test(
  "a roaming start is refused an ended Run's checkout while an agent no Run recorded works in it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const roaming = `${rig.root}/.herdr/worktrees/project/roaming`;
        const refused = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [roams] = yield* loaded(registry, [`${fixtures}/roams.workflow.ts`]);
            const first = yield* start(roams!, { request: "r1", text: { work: "fail" } });
            if (first._tag === "Failure") return yield* Effect.die(first.failure);
            yield* finished(first.success.runId);
            // Started in the repository, and moved into the checkout since.
            yield* rig.addPane("p-moved", "t-moved", rig.projectDir, "claude", null, roaming);
            return refusedWith(yield* start(roams!, { request: "r2", text: { work: "next" } }));
          }),
        );

        expect(refused).toContain(`${roaming} is a checkout of`);
        expect(refused).toContain("agent claude in pane p-moved works in it");
      }),
    ),
  120_000,
);

test(
  "a roaming start is refused an ended Run's checkout while a server of an agent herdr no longer lists may write in it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const roaming = `${rig.root}/.herdr/worktrees/project/roaming`;
        const refused = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [roams] = yield* loaded(registry, [`${fixtures}/roams.workflow.ts`]);
            const first = yield* start(roams!, { request: "r1", text: { work: "fail" } });
            if (first._tag === "Failure") return yield* Effect.die(first.failure);
            yield* finished(first.success.runId);
            const fs = yield* FileSystem.FileSystem;
            const control = `${dir()}/compaction/r1-worker`;
            yield* fs.makeDirectory(control, { recursive: true });
            yield* fs.writeFileString(
              `${control}/control.json`,
              asJson({
                agent: "r1-worker",
                harness: "codex",
                cwd: roaming,
                dir: control,
                endpoint: "ws://127.0.0.1:1",
                pid: process.pid,
                command: null,
                started: null,
                attempt: null,
              }),
            );
            return refusedWith(yield* start(roams!, { request: "r2", text: { work: "next" } }));
          }),
        );

        expect(refused).toContain(`${roaming} is a checkout of`);
        expect(refused).toContain("r1-worker's server may still be writing in it");
      }),
    ),
  120_000,
);

test(
  "a stop closes the Run's agent and keeps its Task's workspace, and a resume starts the work again",
  () =>
    runEffect(
      Effect.gen(function* () {
        const task = yield* aTask;
        // Nothing the first time, so the stop lands while the work is out.
        yield* rig.queueOutputs([null, { verdict: "clean" }]);
        const view = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [builds] = yield* loaded(registry, [`${fixtures}/builds.workflow.ts`]);
            const started = yield* start(builds!, {
              request: "r1",
              text: { work: "Add a picker" },
              task: task.id,
            });
            if (started._tag === "Failure") return yield* Effect.die(started.failure);
            const runId = started.success.runId;
            yield* until(
              () => rig.cmds().pipe(Effect.orDie),
              (cmds) => cmds.includes("agent prompt"),
            );
            yield* registry.control({ runId, control: "stop", set: true });
            const stopped = yield* until(
              () => registry.view(runId),
              (seen) => seen?.status.status === "suspended",
            );
            expect(stopped?.controls).toEqual(["stop"]);
            expect(yield* rig.cmds()).toContain("pane close");
            yield* registry.control({ runId, control: "stop", set: false });
            return yield* finished(runId);
          }),
        );

        expect(view?.status.status).toBe("complete");
        const cmds = yield* rig.cmds();
        // Only the agent's pane went; the Task's workspace is where it was.
        expect(cmds.filter((cmd) => cmd === "pane close")).toHaveLength(1);
        expect(
          cmds.filter((cmd) => cmd.startsWith("workspace") && cmd !== "workspace list"),
        ).toEqual([]);
        expect(cmds.filter((cmd) => cmd === "agent start")).toHaveLength(2);
        expect(tabs(yield* rig.calls()).map((tab) => tab.workspace)).toEqual(["wT", "wT"]);
      }),
    ),
  120_000,
);

test(
  "a stop that closes the last pane in a Task's workspace leaves a shell there, and the resume takes it",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([null, { verdict: "clean" }]);
        const view = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [builds] = yield* loaded(registry, [`${fixtures}/builds.workflow.ts`]);
            const started = yield* start(builds!, {
              request: "r1",
              text: { work: "Add a picker" },
              taskLabel: "Project | Picker",
            });
            if (started._tag === "Failure") return yield* Effect.die(started.failure);
            const runId = started.success.runId;
            yield* until(
              () => rig.cmds().pipe(Effect.orDie),
              (cmds) => cmds.includes("agent prompt"),
            );
            yield* registry.control({ runId, control: "stop", set: true });
            yield* until(
              () => registry.view(runId),
              (seen) => seen?.status.status === "suspended",
            );
            yield* registry.control({ runId, control: "stop", set: false });
            return yield* finished(runId);
          }),
        );

        expect(view?.status.status).toBe("complete");
        const task = yield* readTask(env().stateDir, view?.task ?? "");
        const calls = yield* rig.calls();
        // The agent had the workspace's only pane, and herdr drops a workspace with its
        // last pane: the stop opened a shell there before it closed the agent's.
        const opened = tabs(calls);
        expect(opened).toEqual([{ workspace: task?.workspace ?? "", cwd: expect.any(String) }]);
        const cmds = calls.map((call) => call.cmd);
        expect(cmds.indexOf("tab create")).toBeLessThan(cmds.indexOf("pane close"));
        // And the resumed agent took that shell over: that one tab is the only one opened.
        expect(cmds.filter((cmd) => cmd === "agent start")).toHaveLength(2);
        expect(cmds.lastIndexOf("agent start")).toBeGreaterThan(cmds.indexOf("tab create"));
        expect(task?.root_pane ?? null).toBeNull();
      }),
    ),
  120_000,
);

test(
  "a stop that cannot close the Run's agent says so rather than confirming it",
  () =>
    runEffect(
      Effect.gen(function* () {
        const task = yield* aTask;
        yield* rig.queueOutputs([null]);
        const stopped = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [builds] = yield* loaded(registry, [`${fixtures}/builds.workflow.ts`]);
            const started = yield* start(builds!, {
              request: "r1",
              text: { work: "Add a picker" },
              task: task.id,
            });
            if (started._tag === "Failure") return yield* Effect.die(started.failure);
            yield* until(
              () => rig.cmds().pipe(Effect.orDie),
              (cmds) => cmds.includes("agent prompt"),
            );
            return yield* registry.control({
              runId: started.success.runId,
              control: "stop",
              set: true,
            });
          }),
          {
            herdr: new FakeHerdr(
              rig.pluginEnv({ FAKE_HERDR_FAIL: `{"pane close":"pane is busy"}` }),
            ),
          },
        );
        expect(stopped.left.join("\n")).toContain("would not close (");
      }),
    ),
  120_000,
);

test(
  "an offer of a plan that spans repositories is refused, and says how to build each",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        for (const repo of ["api", "web"]) {
          yield* fs.makeDirectory(`${rig.projectDir}/${repo}/.git`, { recursive: true });
        }
        const outcome = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [planned] = yield* loaded(registry, [
              `${fixtures}/planned.workflow.ts`,
              `${fixtures}/builds.workflow.ts`,
            ]);
            const started = yield* start(planned!, { request: "r1", text: { goal: "two repos" } });
            if (started._tag === "Failure") return yield* Effect.die(started.failure);
            const runId = started.success.runId;
            yield* finished(runId);
            const issues = `${runDir(dir(), runId)}/plan/issues`;
            yield* fs.makeDirectory(issues, { recursive: true });
            yield* fs.writeFileString(`${issues}/01-api.md`, "# The api\n\n**Repo:** api\n");
            yield* fs.writeFileString(
              `${issues}/02-web.md`,
              "# The web\n\n**Repo:** web\n\n**Blocked by:** 01\n",
            );
            return {
              offers: yield* registry.offers(runId),
              invoked: yield* registry
                .invoke({ runId, offer: "build-it", input: {}, request: "r2" })
                .pipe(Effect.result),
              rows: yield* (yield* Store).runs,
            };
          }),
        );

        expect(outcome.offers[0]?.unavailable).toContain("spans repositories (api, web)");
        expect(refusedWith(outcome.invoked)).toContain("`collie run start builds --input work=");
        expect(outcome.rows).toHaveLength(1);
      }),
    ),
  120_000,
);

test(
  "a Run that asks for a worktree workspace of its own gets one, and a fresh Task takes it as its own",
  () =>
    runEffect(
      Effect.gen(function* () {
        const task = yield* aTask;
        yield* rig.queueOutputs([{ verdict: "clean" }, { verdict: "clean" }]);
        const views = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [builds] = yield* loaded(registry, [`${fixtures}/builds.workflow.ts`]);
            const own = yield* start(builds!, {
              request: "r1",
              text: { work: "Add a picker" },
              options: { workspace: "new" },
              task: task.id,
            });
            if (own._tag === "Failure") return yield* Effect.die(own.failure);
            const fresh = yield* start(builds!, {
              request: "r2",
              text: { work: "Add a menu" },
              options: { workspace: "new" },
              taskLabel: "Project | Menu",
            });
            if (fresh._tag === "Failure") return yield* Effect.die(fresh.failure);
            return {
              own: yield* finished(own.success.runId),
              fresh: yield* finished(fresh.success.runId),
            };
          }),
        );

        // Inside a Task that already has a workspace, the one it asked for is its own.
        expect(views.own).toMatchObject({ task: "task-1", branch: `${LOGIN}/add-a-picker` });
        const own = views.own?.workspace ?? "";
        expect(own).not.toBe("wT");
        expect(own).not.toBe("");
        // A fresh Task's workspace is that one: herdr opened it, and no second one is made.
        const fresh = yield* readTask(env().stateDir, views.fresh?.task ?? "");
        expect(views.fresh?.workspace).toBeNull();
        expect(fresh).toMatchObject({ label: "Project | Menu", cwd: views.fresh?.cwd });
        expect(yield* rig.cmds()).not.toContain("workspace create");
        // The fresh Task's agent takes over the shell herdr opened its workspace with.
        expect(tabs(yield* rig.calls()).map((tab) => tab.workspace)).toEqual([own]);
        expect(fresh?.root_pane ?? null).toBeNull();
        expect((yield* rig.cmds()).filter((cmd) => cmd === "worktree create")).toHaveLength(2);
      }),
    ),
  120_000,
);

test(
  "a branch whose worktree herdr already has open is given that one, never a second",
  () =>
    runEffect(
      Effect.gen(function* () {
        const task = yield* aTask;
        const existing = `${rig.root}/elsewhere/add-a-picker`;
        yield* rig.addWorkspace("wW", "add-a-picker", existing);
        yield* rig.addWorktree(`${LOGIN}/add-a-picker`, existing, "wW");
        yield* rig.queueOutputs([{ verdict: "clean" }]);
        const view = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [builds] = yield* loaded(registry, [`${fixtures}/builds.workflow.ts`]);
            const started = yield* start(builds!, {
              request: "r1",
              text: { work: "Add a picker" },
              options: { workspace: "new" },
              task: task.id,
            });
            if (started._tag === "Failure") return yield* Effect.die(started.failure);
            return yield* finished(started.success.runId);
          }),
        );

        expect(view).toMatchObject({ cwd: existing, workspace: "wW" });
        expect(yield* rig.cmds()).toContain("worktree open");
        expect(yield* rig.cmds()).not.toContain("worktree create");
        expect(yield* rig.cmds()).not.toContain("workspace create");
      }),
    ),
  120_000,
);

// The shipped chains, as a planner or an architect hands their work to the build.

const REPORT = {
  verdict: "clean",
  findings: [],
  report: "plan/ARCHITECTURE.md",
  applied: [],
  deferred: [],
  slug: "one-registry",
  outcome: "refactor",
};
const GRILLED = {
  verdict: "clean",
  findings: [],
  slug: "one-registry",
  outcome: "feature",
  decided: [],
};
const SPEC = { verdict: "clean", findings: [], spec: "plan/SPEC.md" };
const TICKETS = { verdict: "clean", findings: [], issues_dir: "plan/issues", tickets: 1 };

/** A shipped workflow started in a Task, answered "Implement now" at its menu. */
const chainedFrom = (options: {
  readonly entry: string;
  readonly text: Readonly<Record<string, string>>;
  readonly decision: string;
  readonly project?: string;
}) =>
  hosted(
    Effect.gen(function* () {
      const registry = yield* Registry;
      const store = yield* Store;
      const [parent] = yield* loaded(registry, [options.entry, shipped("implement")]);
      const started = yield* start(parent!, {
        request: "r1",
        project: options.project,
        text: options.text,
        task: "task-1",
      });
      if (started._tag === "Failure") return yield* Effect.die(started.failure);
      const runId = started.success.runId;
      yield* until(
        () => store.asked(runId),
        (rows) => rows.some((row) => row.decision === options.decision),
      );
      yield* registry
        .answer({ runId, decision: options.decision, value: "Implement now", request: "a1" })
        .pipe(Effect.orDie);
      const child = `${runId}.implement`;
      // The child's first agent, or the parent's end where no child could be admitted.
      const settled = yield* until(
        () =>
          Effect.all({
            parent: registry.view(runId),
            child: registry.view(child),
            tabs: rig.calls().pipe(Effect.map(tabs), Effect.orDie),
          }),
        (seen) =>
          seen.tabs.length === 2 || (seen.parent !== null && isOver(seen.parent.status.status)),
      );
      return settled;
    }),
  );

const CHAINS: ReadonlyArray<{
  readonly name: string;
  readonly outputs: ReadonlyArray<Schema.Json>;
  readonly text: Readonly<Record<string, string>>;
  readonly decision: string;
}> = [
  {
    name: "architecture",
    outputs: [REPORT],
    text: { goal: "why are there two registries" },
    decision: "next",
  },
  {
    name: "plan",
    outputs: [GRILLED, SPEC, TICKETS],
    text: { goal: "make the registries one" },
    decision: "next-1",
  },
];

test(
  "a review's findings built in a full implement run are built on the branch that was reviewed",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* aTask;
        yield* approvedByOperator;
        // The reviewed branch, pushed where a build can fetch the reviewed work from.
        const origin = `${rig.root}/origin.git`;
        for (const args of [
          ["init", "--quiet", "--bare", origin],
          ["branch", "picker"],
          ["remote", "add", "origin", origin],
          ["push", "--quiet", "origin", "master", "picker"],
        ]) {
          yield* exec(["git", ...args], { cwd: rig.projectDir });
        }
        const finding = { severity: "major", title: "the guard is backwards", file: "a.ts" };
        yield* rig.queueOutputs([
          { verdict: "findings", findings: [finding] },
          {
            verdict: "findings",
            summary: "One thing.",
            findings: [finding],
            dropped: [],
            fixed: [],
          },
        ]);
        const seen = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const store = yield* Store;
            const [review] = yield* loaded(registry, [shipped("review"), shipped("implement")]);
            const started = yield* start(review!, {
              request: "r1",
              text: { target: "branch:master...picker" },
              task: "task-1",
            });
            if (started._tag === "Failure") return yield* Effect.die(started.failure);
            const runId = started.success.runId;
            yield* until(
              () => store.asked(runId),
              (rows) => rows.some((row) => row.decision === "post-1"),
            );
            yield* registry
              .answer({
                runId,
                decision: "post-1",
                value: "Fix findings in a full implement run",
                request: "a1",
              })
              .pipe(Effect.orDie);
            return yield* until(
              () =>
                Effect.all({
                  parent: registry.view(runId),
                  child: registry.view(`${runId}.implement`),
                }),
              (both) =>
                both.child?.branch != null ||
                (both.parent !== null && isOver(both.parent.status.status)),
            );
          }),
        );

        expect(seen.parent?.status.status === "failed" ? seen.parent.status.reason : "").toBe("");
        expect(seen.child).toMatchObject({ branch: "picker", task: "task-1" });
      }),
    ),
  180_000,
);

for (const chain of CHAINS) {
  test(
    `${chain.name} chained into implement: one Task, one workspace, the build on its own worktree`,
    () =>
      runEffect(
        Effect.gen(function* () {
          yield* aTask;
          yield* approvedByOperator;
          // A forge that finds no merge request from the branch, so the build may push.
          const bin = yield* Effect.acquireRelease(FakeBin.make(`${rig.root}/bin`), (made) =>
            made.restore(),
          );
          const api = yield* serveForges(
            yield* forgeOnPath(bin, "gitlab", {
              installed: true,
              loggedIn: ["gitlab.example.com"],
              login: LOGIN,
              mrs: [],
            }),
          );
          yield* rig.queueOutputs(chain.outputs);
          const seen = yield* chainedFrom({
            entry: shipped(chain.name),
            text: chain.text,
            decision: chain.decision,
          }).pipe(
            Effect.provide(
              ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ COLLIE_FORGE_API: api })),
            ),
          );

          const worktree = worktreeOf("one-registry");
          expect(seen.parent).toMatchObject({
            task: "task-1",
            cwd: rig.projectDir,
            workspace: null,
          });
          expect(seen.child).toMatchObject({
            task: "task-1",
            cwd: worktree,
            branch: `${LOGIN}/one-registry`,
            workspace: null,
          });
          expect(seen.child?.options.workspace).toBeUndefined();
          expect(seen.tabs).toEqual([
            { workspace: "wT", cwd: rig.projectDir },
            { workspace: "wT", cwd: worktree },
          ]);
          expect((yield* readTask(env().stateDir, "task-1"))?.workspace).toBe("wT");
          expect(yield* rig.cmds()).not.toContain("workspace create");
        }).pipe(Effect.scoped),
      ),
    180_000,
  );

  test(
    `${chain.name} started in a directory that is not a repository cannot chain into implement`,
    () =>
      runEffect(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const container = `${rig.root}/gitlab.example.com`;
          yield* fs.makeDirectory(container, { recursive: true });
          yield* aTask;
          yield* rig.queueOutputs(chain.outputs);
          const seen = yield* chainedFrom({
            entry: shipped(chain.name),
            text: chain.text,
            decision: chain.decision,
            project: container,
          });

          expect(seen.child).toBeNull();
          const status = seen.parent?.status;
          expect(status?.status === "failed" ? status.reason : "").toContain(container);
          expect(yield* fs.exists(`${rig.root}/.herdr/worktrees`)).toBe(false);
          expect(tabs(yield* rig.calls())).toEqual([{ workspace: "wT", cwd: container }]);
        }),
      ),
    180_000,
  );
}

test(
  "a fresh start about a branch an open Task works is that Task's; one about no branch is new",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.startSocket();
        yield* rig.queueOutputs([{ verdict: "clean" }]);
        const views = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [builds, targeted, hello] = yield* loaded(registry, [
              `${fixtures}/builds.workflow.ts`,
              `${fixtures}/targeted.workflow.ts`,
              `${fixtures}/hello.workflow.ts`,
            ]);
            const ids: string[] = [];
            for (const [generation, ask] of [
              [
                builds!,
                { request: "r1", text: { work: "Add a picker" }, taskLabel: "Project | P" },
              ],
              [
                targeted!,
                {
                  request: "r2",
                  text: { target: `branch:master...${LOGIN}/add-a-picker` },
                  taskLabel: "Project | Review",
                },
              ],
              [hello!, { request: "r3", text: { name: "you" }, taskLabel: "Project | Hello" }],
              // Typed in the Task's own checkout, but about no branch: not the Task's.
              [
                hello!,
                {
                  request: "r4",
                  project: worktreeOf("add-a-picker"),
                  text: { name: "there" },
                  taskLabel: "Project | There",
                },
              ],
            ] as const) {
              const started = yield* start(generation, ask);
              if (started._tag === "Failure") return yield* Effect.die(started.failure);
              ids.push(started.success.runId);
              yield* finished(started.success.runId);
            }
            return yield* Effect.forEach(ids, (id) => registry.view(id));
          }),
        );

        const [build, review, hello, there] = views;
        expect(review?.task).toBe(build?.task);
        expect(hello?.task).not.toBe(build?.task);
        expect(there?.task).not.toBe(build?.task);
        expect((yield* rig.cmds()).filter((cmd) => cmd === "workspace create")).toHaveLength(3);
        expect(yield* rig.cmds()).not.toContain("workspace.focus");
      }),
    ),
  120_000,
);

/** The incident's Task: rooted at the main checkout, its child building on a worktree. */
const builtByAChild = (
  registry: typeof Registry.Service,
  chain: Generation,
  task: string,
  mr = "",
) =>
  Effect.gen(function* () {
    const started = yield* start(chain, {
      request: `built-${task}`,
      task,
      text: mr === "" ? {} : { mr },
    });
    if (started._tag === "Failure") return yield* Effect.die(started.failure);
    yield* finished(started.success.runId);
    return started.success.runId;
  });

const MR_URL = "https://gitlab.example.com/group/app/-/merge_requests/355";
const MR_TARGET = "mr:gitlab.example.com/group/app!355";

test(
  "a fresh start on the branch an open Task's child built joins that Task, with no parent",
  () =>
    runEffect(
      Effect.gen(function* () {
        const task = yield* aTask;
        yield* rig.queueOutputs([{ verdict: "clean" }, { verdict: "clean" }]);
        const review = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [chains, , targeted] = yield* loaded(registry, [
              `${fixtures}/chains.workflow.ts`,
              `${fixtures}/builds.workflow.ts`,
              `${fixtures}/targeted.workflow.ts`,
            ]);
            yield* builtByAChild(registry, chains!, task.id);
            const started = yield* start(targeted!, {
              request: "r-review",
              text: { target: `branch:master...${LOGIN}/add-a-picker` },
              taskLabel: "Project | Review",
            });
            if (started._tag === "Failure") return yield* Effect.die(started.failure);
            return yield* finished(started.success.runId);
          }),
        );

        expect(review).toMatchObject({ task: "task-1", parent: null });
        expect(yield* rig.cmds()).not.toContain("workspace create");
      }),
    ),
  120_000,
);

test(
  "a fresh start on the merge request an open Task's child opened joins that Task, with no parent",
  () =>
    runEffect(
      Effect.gen(function* () {
        const task = yield* aTask;
        const release = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [chains, , targeted] = yield* loaded(registry, [
              `${fixtures}/chains-and-opens.workflow.ts`,
              `${fixtures}/opens.workflow.ts`,
              `${fixtures}/targeted.workflow.ts`,
            ]);
            yield* builtByAChild(registry, chains!, task.id, MR_URL);
            const started = yield* start(targeted!, {
              request: "r-release",
              text: { target: MR_TARGET },
              taskLabel: "Project | Release",
            });
            if (started._tag === "Failure") return yield* Effect.die(started.failure);
            return yield* finished(started.success.runId);
          }),
        );

        expect(release).toMatchObject({ task: "task-1", parent: null });
        expect(yield* rig.cmds()).not.toContain("workspace create");
      }),
    ),
  120_000,
);

/**
 * An open Task's planner, its build on `add-a-picker` with MR_URL, then a build started by
 * hand from the planner's own plan directory, as a human does where "Implement now" cannot
 * be used.
 */
const builtFromItsPlan = (mrState: MrState | null) =>
  Effect.gen(function* () {
    const task = yield* aTask;
    yield* rig.queueOutputs([{ verdict: "clean" }]);
    return yield* hosted(
      Effect.gen(function* () {
        const registry = yield* Registry;
        const fs = yield* FileSystem.FileSystem;
        const [chains, , builds] = yield* loaded(registry, [
          `${fixtures}/chains-and-opens.workflow.ts`,
          `${fixtures}/opens.workflow.ts`,
          `${fixtures}/builds.workflow.ts`,
        ]);
        const planner = yield* builtByAChild(registry, chains!, task.id, MR_URL);
        const plan = `${runDir(dir(), planner)}/plan`;
        yield* fs.makeDirectory(plan, { recursive: true });
        yield* fs.writeFileString(`${plan}/SPEC.md`, "# Add a picker\n");
        if (mrState !== null) yield* writeMrStates(dir(), new Map([[mrLabel(MR_URL), mrState]]));
        const started = yield* start(builds!, {
          request: "r-by-hand",
          text: { work: plan },
          taskLabel: "Project | By hand",
        });
        if (started._tag === "Failure") return yield* Effect.die(started.failure);
        return { runId: started.success.runId, view: yield* finished(started.success.runId) };
      }),
    );
  });

test(
  "a build started from another Run's plan directory is on that Run's Task branch, in its Task",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { view } = yield* builtFromItsPlan(null);

        expect(view).toMatchObject({ branch: `${LOGIN}/add-a-picker`, task: "task-1" });
        expect(yield* rig.cmds()).not.toContain("workspace create");
      }),
    ),
  120_000,
);

test(
  "a build started from a plan whose branch has merged is on a fresh branch named by the Run",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { runId, view } = yield* builtFromItsPlan("merged");

        expect(view?.branch).toBe(`${LOGIN}/${runId}`);
      }),
    ),
  120_000,
);

test(
  "a fresh start on a Finished Task's merge request joins it, and reopens its closed workspace",
  () =>
    runEffect(
      Effect.gen(function* () {
        const task = yield* aTask;
        yield* rig.queueOutputs([{ verdict: "released" }]);
        const release = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [chains, , releases] = yield* loaded(registry, [
              `${fixtures}/chains-and-opens.workflow.ts`,
              `${fixtures}/opens.workflow.ts`,
              `${fixtures}/releases.workflow.ts`,
            ]);
            yield* builtByAChild(registry, chains!, task.id, MR_URL);
            yield* rig.closeWorkspace("wT", []);
            const started = yield* start(releases!, {
              request: "r-release",
              text: { mr: MR_TARGET },
              taskLabel: "Project | Release",
            });
            if (started._tag === "Failure") return yield* Effect.die(started.failure);
            return yield* finished(started.success.runId);
          }),
        );

        expect(release).toMatchObject({
          task: "task-1",
          parent: null,
          status: { status: "complete" },
        });
        const created = (yield* rig.calls()).filter((call) => call.cmd === "workspace create");
        expect(created.map((call) => call.argv)).toEqual([
          expect.arrayContaining(["--cwd", rig.projectDir, "--label", "Project | Picker"]),
        ]);
        const reopened = (yield* readTask(env().stateDir, "task-1"))?.workspace;
        expect(reopened).not.toBe("wT");
        const agents = (yield* rig.calls()).filter((call) => call.cmd === "agent start");
        expect(agents.at(-1)?.argv).toEqual(expect.arrayContaining(["--pane", `${reopened}-p1`]));
      }),
    ),
  120_000,
);

test(
  "a fresh start on a merge request two Tasks share joins the one whose Run had it first",
  () =>
    runEffect(
      Effect.gen(function* () {
        // The older Task's Run comes second, so the Task's own age decides nothing.
        for (const [id, created] of [
          ["task-old", "2026-09-01T00:00:00.000Z"],
          ["task-new", "2026-09-20T00:00:00.000Z"],
        ] as const) {
          yield* writeTask(env().stateDir, {
            id,
            workspace: `w-${id}`,
            label: `Project | ${id}`,
            cwd: rig.projectDir,
            created_at: created,
          });
        }
        const fresh = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [targeted] = yield* loaded(registry, [`${fixtures}/targeted.workflow.ts`]);
            for (const task of ["task-new", "task-old"]) {
              const named = yield* start(targeted!, {
                request: `r-${task}`,
                text: { target: MR_TARGET },
                task,
              });
              if (named._tag === "Failure") return yield* Effect.die(named.failure);
              yield* finished(named.success.runId);
            }
            const started = yield* start(targeted!, {
              request: "r-fresh",
              text: { target: MR_TARGET },
              taskLabel: "Project | Release",
            });
            if (started._tag === "Failure") return yield* Effect.die(started.failure);
            return yield* finished(started.success.runId);
          }),
        );

        expect(fresh?.task).toBe("task-new");
      }),
    ),
  120_000,
);

test(
  "a fresh start on the branch of a Task whose workspace has closed is a Task of its own",
  () =>
    runEffect(
      Effect.gen(function* () {
        const task = yield* aTask;
        yield* rig.queueOutputs([{ verdict: "clean" }, { verdict: "clean" }]);
        const review = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [chains, , targeted] = yield* loaded(registry, [
              `${fixtures}/chains.workflow.ts`,
              `${fixtures}/builds.workflow.ts`,
              `${fixtures}/targeted.workflow.ts`,
            ]);
            yield* builtByAChild(registry, chains!, task.id);
            yield* rig.closeWorkspace("wT", []);
            const started = yield* start(targeted!, {
              request: "r-review",
              text: { target: `branch:master...${LOGIN}/add-a-picker` },
              taskLabel: "Project | Review",
            });
            if (started._tag === "Failure") return yield* Effect.die(started.failure);
            return yield* finished(started.success.runId);
          }),
        );

        expect(review?.task).not.toBe("task-1");
        expect(review?.task).not.toBeNull();
      }),
    ),
  120_000,
);

test(
  "forgetting a Run removes its row and what the engine kept of it, and leaves a claim alone",
  () =>
    runEffect(
      Effect.gen(function* () {
        yield* rig.queueOutputs([{ verdict: "clean" }]);
        const seen = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const store = yield* Store;
            const sql = yield* SqlClient.SqlClient;
            const [hello] = yield* loaded(registry, [`${fixtures}/hello.workflow.ts`]);
            const ids: string[] = [];
            for (const request of ["r1", "r2"]) {
              const started = yield* start(hello!, { request, text: { name: "you" } });
              if (started._tag === "Failure") return yield* Effect.die(started.failure);
              ids.push(started.success.runId);
              yield* finished(started.success.runId);
            }
            const gone = ids[0]!;
            const kept = ids[1]!;
            const execution = (yield* store.run(gone))!.execution;
            // A claim the engine never accepted, which recovery would hand over.
            yield* store.admit({
              request: "r-claim",
              run: "run-claimed",
              workflow: hello!.id,
              project: rig.projectDir,
              input: {},
              provenance: {},
              options: {},
              generation: hello!.name,
              execution: "e-claimed",
              task: null,
              parent: null,
            });

            const count = sql<{
              readonly n: number;
            }>`SELECT count(*) AS n FROM cluster_messages WHERE entity_id = ${execution}`;
            const before = (yield* count)[0]?.n;
            const forgotten = yield* registry.retire([gone, "run-claimed"]);
            const messages = yield* count;
            return {
              forgotten,
              view: yield* registry.view(gone),
              other: yield* registry.view(kept),
              listed: (yield* registry.views(null)).map((one) => one.runId),
              claim: yield* store.run("run-claimed"),
              before,
              messages: messages[0]?.n,
            };
          }),
        );

        expect(seen.forgotten).toHaveLength(1);
        expect(seen.view).toBeNull();
        // What every listing reads — the board, History, `run list` — no longer has it.
        expect(seen.listed).not.toContain(seen.forgotten[0]);
        expect(seen.listed).toContain(seen.other!.runId);
        expect(seen.other?.status.status).toBe("complete");
        expect(seen.claim).not.toBeNull();
        expect(seen.before).toBeGreaterThan(0);
        expect(seen.messages).toBe(0);
      }),
    ),
  120_000,
);

/** An engine that takes nothing handed to it, the way the one that wedged did. */
const stalled = Layer.effect(WorkflowEngine.WorkflowEngine)(
  Effect.map(WorkflowEngine.WorkflowEngine, (engine) => ({
    ...engine,
    // SAFETY: the same arguments reach the real engine; only a discarded send stalls.
    execute: ((workflow, options) =>
      options.discard ? Effect.never : engine.execute(workflow, options)) as typeof engine.execute,
  })),
);

test(
  "a start the engine never takes is refused within a bound, and stays recorded for the next host",
  () =>
    runEffect(
      Effect.gen(function* () {
        const task = yield* aTask;
        const outcome = yield* Effect.gen(function* () {
          const registry = yield* Registry;
          const [quiet] = yield* loaded(registry, [`${fixtures}/quiet.workflow.ts`]);
          const started = yield* start(quiet!, { request: "r1", task: task.id });
          const pending = yield* (yield* Store).pending;
          return { reason: refusedWith(started), pending: pending.map((row) => row.request) };
        }).pipe(
          Effect.provide(registryLayer(dir(), { userDir: rig.userDir })),
          Effect.provide(stalled),
          Effect.provide(agentsLayer(hostOf())),
          Effect.provide(foundationLayer({ dir: dir(), userDir: rig.userDir })),
          Effect.scoped,
          Effect.orDie,
        );
        expect(outcome.reason).toContain("the next host start hands it over");
        expect(outcome.pending).toEqual(["r1"]);
      }),
    ),
  120_000,
);

test(
  "a host whose recovery stalls on the engine still serves before that hand-over gives up",
  () =>
    runEffect(
      Effect.gen(function* () {
        // A Run a host admitted and died before handing over.
        yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const [quiet] = yield* loaded(registry, [`${fixtures}/quiet.workflow.ts`]);
            const payload = { runId: "run-left", input: {} };
            yield* (yield* Store).admit({
              request: "r1",
              run: "run-left",
              workflow: "quiet",
              project: rig.projectDir,
              input: payload.input,
              provenance: {},
              options: {},
              generation: quiet!.name,
              execution: yield* quiet!.registration.workflow.executionId(payload),
              task: null,
              parent: null,
            });
          }),
        );

        const before = yield* Clock.currentTimeMillis;
        const served = yield* Effect.gen(function* () {
          const held = yield* (yield* Registry).registrations;
          const pending = yield* (yield* Store).pending;
          return { live: held.live, pending: pending.map((row) => row.run) };
        }).pipe(
          Effect.provide(registryLayer(dir(), { userDir: rig.userDir })),
          Effect.provide(stalled),
          Effect.provide(agentsLayer(hostOf())),
          Effect.provide(foundationLayer({ dir: dir(), userDir: rig.userDir })),
          Effect.scoped,
          Effect.orDie,
        );
        expect(served.live).toHaveLength(1);
        expect(served.pending).toEqual(["run-left"]);
        expect((yield* Clock.currentTimeMillis) - before).toBeLessThan(30_000);
      }),
    ),
  120_000,
);
