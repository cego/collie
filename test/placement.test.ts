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
import { Effect, FileSystem, Result, Schema } from "effect";
import { Rig, FakeHerdr } from "./support/recorder";
import { runEffect } from "./support/effect";
import { installFakeSkills } from "./support/defs";
import { fixtures, until } from "./support/native";
import { agentsLayer, type AgentHost } from "../src/agents";
import {
  Registry,
  foundationLayer,
  registryLayer,
  type Generation,
  type HostServices,
} from "../src/native";
import { Store } from "../src/store";
import { readTask, writeTask, type TaskRecord } from "../src/task";
import type { Call } from "./support/recorder";

const ROOT = new URL("../", import.meta.url).pathname;
const shipped = (name: string) => `${ROOT}workflows/${name}.workflow.ts`;
const LOGIN = "mk";

let rig: Rig;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(rig.projectDir, { recursive: true });
      yield* installFakeSkills(rig.root);
      gitRepo(rig.projectDir);
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

/** A repository with one commit on master, which is all a worktree needs to be cut from. */
const gitRepo = (at: string) => {
  const git = (...args: string[]) => {
    const done = Bun.spawnSync(["git", ...args], {
      cwd: at,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: rig.root,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
    if (done.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${done.stderr.toString()}`);
  };
  git("init", "--quiet", "-b", "master");
  git("commit", "--quiet", "--allow-empty", "-m", "init");
};

const env = () => rig.pluginEnv({ HERDR_PLUGIN_ROOT: ROOT, GITLAB_USER_LOGIN: LOGIN });
/** The state directory the host, its Tasks and its agents all share, as an install's do. */
const dir = () => env().stateDir;

const hostOf = (): AgentHost => ({
  dir: dir(),
  env: env(),
  herdr: new FakeHerdr(env()),
  harness: "claude",
  model: "opus",
  permissions: "bypass",
  compactAtTokens: 0,
  pollMs: 20,
  collectMs: 60_000,
});

const hosted = <A, E>(run: Effect.Effect<A, E, Registry | Store | HostServices>) =>
  run.pipe(
    Effect.provide(registryLayer(dir(), { placing: { herdr: new FakeHerdr(env()), env: env() } })),
    Effect.provide(agentsLayer(hostOf())),
    Effect.provide(foundationLayer({ dir: dir(), configDir: rig.configDir })),
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
  "a fresh Task's workspace is rooted at the checkout its first Run was given",
  () =>
    runEffect(
      Effect.gen(function* () {
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
            return yield* finished(started.success.runId);
          }),
        );

        const worktree = worktreeOf("add-a-picker");
        expect(view).toMatchObject({ cwd: worktree, workspace: null });
        const task = yield* readTask(env().stateDir, view?.task ?? "");
        expect(task).toMatchObject({ label: "Project | Picker", cwd: worktree });
        const created = (yield* rig.calls()).filter((call) => call.cmd === "workspace create");
        expect(created.map((call) => call.argv)).toEqual([
          expect.arrayContaining(["--cwd", worktree]),
        ]);
        expect(tabs(yield* rig.calls())).toEqual([
          { workspace: task?.workspace ?? "", cwd: worktree },
        ]);
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
        expect(tabs(yield* rig.calls()).map((tab) => tab.workspace)).toEqual([
          own,
          fresh?.workspace ?? "",
        ]);
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
    text: {},
    decision: "next",
  },
  {
    name: "plan",
    outputs: [GRILLED, SPEC, TICKETS],
    text: { goal: "make the registries one" },
    decision: "next-1",
  },
];

for (const chain of CHAINS) {
  test(
    `${chain.name} chained into implement: one Task, one workspace, the build on its own worktree`,
    () =>
      runEffect(
        Effect.gen(function* () {
          yield* aTask;
          yield* rig.queueOutputs(chain.outputs);
          const seen = yield* chainedFrom({
            entry: shipped(chain.name),
            text: chain.text,
            decision: chain.decision,
          });

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
        }),
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
