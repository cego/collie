// A listing pays only for what can still change: the engine is asked about a finished Run
// once, and everything a finished Run may still be given is read on every view.

import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Option from "effect/Option";
import * as Arr from "effect/Array";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { PlatformServices } from "../src/platform";
import { Effect, FileSystem, Layer, type Schema, type Scope } from "effect";
import * as WorkflowEngine from "effect/workflow/WorkflowEngine";
import { Rig, FakeHerdr } from "./support/recorder";
import { fastForward, runEffect as runLive } from "./support/effect";
import { installFakeSkills } from "./support/defs";
import { fixtures, until } from "./support/host";
import { agentsLayer } from "../src/agents";
import {
  HOLD,
  Registry,
  controlPath,
  foundationLayer,
  registryLayer,
  runDir,
  type Generation,
  type HostServices,
} from "../src/engine";
import type { RequestedBy } from "../src/board-model";
import { Store } from "../src/store";
import { writeTask } from "../src/task";
import { socketOf } from "../src/host";
import { reportsLayer } from "../src/reports";

const ROOT = new URL("../", import.meta.url).pathname;

let rig: Rig;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.makeDirectory(rig.projectDir, { recursive: true })),
      );
      yield* installFakeSkills(rig.root);
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

const env = () => rig.pluginEnv({ HERDR_PLUGIN_ROOT: ROOT });
const dir = () => env().stateDir;

const runEffect = <A, E>(effect: Effect.Effect<A, E, PlatformServices>) =>
  runLive(fastForward(effect));

/** How many times the engine was polled for each execution. */
let polls: Map<string, number>;

const counted = Layer.effect(WorkflowEngine.WorkflowEngine)(
  Effect.map(WorkflowEngine.WorkflowEngine, (engine) => ({
    ...engine,
    // SAFETY: the same arguments reach the real engine; only the count is added.
    poll: ((workflow, execution) => {
      polls.set(execution, (polls.get(execution) ?? 0) + 1);
      return engine.poll(workflow, execution);
    }) as typeof engine.poll,
  })),
);

const hosted = <A, E>(
  run: Effect.Effect<A, E, Registry | Store | HostServices | PlatformServices | Scope.Scope>,
) =>
  Effect.suspend(() => {
    polls = new Map();
    return run;
  }).pipe(
    Effect.provide(
      registryLayer(dir(), {
        placing: {
          herdr: new FakeHerdr(env()),
          env: env(),
        },
      }).pipe(
        Layer.provideMerge(counted),
        Layer.provideMerge(
          agentsLayer({
            dir: dir(),
            env: env(),
            herdr: new FakeHerdr(env()),
            harness: "claude",
            model: "opus",
            permissions: "auto",
            compactAtTokens: 0,
            pollMs: 20,
            collectMs: 60_000,
          }),
        ),
        Layer.provideMerge(
          foundationLayer({
            dir: dir(),
            userDir: rig.userDir,
          }),
        ),
      ),
    ),
    Effect.scoped,
    Effect.orDie,
  );

const started = Effect.fn("FinishedPoll.started")(function* (
  generation: Generation,
  request: string,
  input: Readonly<Record<string, Schema.Json>>,
  task: string | null = null,
  requestedBy?: RequestedBy,
) {
  const registry = yield* Registry;
  const { runId } = yield* registry.start({
    requestedBy,
    generation,
    request,
    project: rig.projectDir,
    input,
    text: {},
    task,
  });
  const store = yield* Store;
  const row = yield* store.run(runId);
  return { runId, execution: row?.execution ?? "" };
});

const settled = (runId: string, status: string) =>
  Registry.pipe(
    Effect.flatMap((registry) =>
      until(
        () => registry.view(runId),
        (view) => view?.status.status === status,
      ),
    ),
  );

const loaded = (name: string) =>
  Registry.pipe(
    Effect.flatMap((registry) => registry.load(`${fixtures}/${name}.workflow.ts`)),
    Effect.map((generation) => generation!),
  );

const write = (path: string, text: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) =>
      fs
        .makeDirectory(
          pipe_(
            path,
            Str.slice(
              0,
              Option.getOrElse(pipe_(path, Str.lastIndexOf("/")), () => -1),
            ),
          ),
          {
            recursive: true,
          },
        )
        .pipe(Effect.andThen(fs.writeFileString(path, text))),
    ),
    Effect.orDie,
  );

const REPORT = '{"state":"delivered","at":"2026-10-15T00:00:00.000Z","note":"done","closed":true}';

test(
  "a completed Run is polled at most once across two listings, and its files are read on each",
  () =>
    runEffect(
      hosted(
        Effect.gen(function* () {
          const registry = yield* Registry;
          const quiet = yield* loaded("quiet");
          const run = yield* started(quiet, "r1", {});
          yield* settled(run.runId, "complete");
          polls.delete(run.execution);

          const first = Option.getOrUndefined(
            Arr.findFirst(yield* registry.views(null), (view) => view.runId === run.runId),
          );
          expect(first?.report).toBeUndefined();
          expect(first?.controls).toEqual([]);

          yield* write(`${runDir(dir(), run.runId)}/report.json`, REPORT);
          yield* write(controlPath(dir(), HOLD, run.runId), "");
          const second = Option.getOrUndefined(
            Arr.findFirst(yield* registry.views(null), (view) => view.runId === run.runId),
          );

          expect(polls.get(run.execution) ?? 0).toBeLessThanOrEqual(1);
          expect(second?.status.status).toBe("complete");
          expect(second?.report?.note).toBe("done");
          expect(second?.controls).toEqual([HOLD]);
        }),
      ),
    ),
  120_000,
);

test(
  "a failed Run is polled at most once, and says the claim it kept only while the file is there",
  () =>
    runEffect(
      hosted(
        Effect.gen(function* () {
          const registry = yield* Registry;
          const retains = yield* loaded("retains");
          const run = yield* started(retains, "r1", { note: "half-merged" });
          yield* settled(run.runId, "failed");
          polls.delete(run.execution);
          const claim = `${runDir(dir(), run.runId)}/helle.json`;

          yield* write(claim, '{"slug":"project","claim":"mine"}');
          const held = Option.getOrUndefined(
            Arr.findFirst(yield* registry.views(null), (view) => view.runId === run.runId),
          );
          expect(held?.diagnostic).toContain("claim on project retained; recovery required");

          yield* FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.remove(claim)));
          const gone = Option.getOrUndefined(
            Arr.findFirst(yield* registry.views(null), (view) => view.runId === run.runId),
          );
          expect(gone?.status.status).toBe("failed");
          expect(gone?.diagnostic).toBeNull();
          expect(polls.get(run.execution) ?? 0).toBeLessThanOrEqual(1);
        }),
      ),
    ),
  120_000,
);

test(
  "a suspended Run is polled on every listing, and reads complete once it finishes",
  () =>
    runEffect(
      hosted(
        Effect.gen(function* () {
          const registry = yield* Registry;
          const echo = yield* loaded("echo");
          const run = yield* started(echo, "r1", { text: "hi", times: 1 });
          yield* settled(run.runId, "suspended");
          polls.delete(run.execution);

          yield* registry.views(null);
          yield* registry.views(null);
          expect(polls.get(run.execution)).toBe(2);

          yield* registry.answer({
            runId: run.runId,
            decision: "keep",
            value: "yes",
            request: "a1",
          });
          const after = yield* until(
            () => registry.views(null),
            (views) => Arr.some(views, (view) => view.status.status === "complete"),
          );
          expect(
            Option.getOrUndefined(Arr.findFirst(after, (view) => view.runId === run.runId))?.status
              .status,
          ).toBe("complete");
        }),
      ),
    ),
  120_000,
);

test(
  "a listing keeps every Run, finished ones included, in the store's order",
  () =>
    runEffect(
      hosted(
        Effect.gen(function* () {
          const registry = yield* Registry;
          const store = yield* Store;
          yield* rig.addWorkspace("wT", "Project | Picker", rig.projectDir);
          yield* writeTask(dir(), {
            id: "task-1",
            workspace: "wT",
            label: "Project | Picker",
            cwd: rig.projectDir,
            created_at: "2026-10-15T00:00:00.000Z",
          });
          const quiet = yield* loaded("quiet");
          const runs: string[] = [];
          for (const [at, task] of [null, "task-1", null, "task-1"].entries()) {
            const run = yield* started(quiet, `r${at}`, {}, task);
            yield* settled(run.runId, "complete");
            runs.push(run.runId);
          }

          const rows = yield* store.runs;
          const all = yield* registry.views(null);
          expect(Arr.map(all, (view) => view.runId)).toEqual(Arr.map(rows, (row) => row.run));
          expect(
            Arr.sortWith(
              Arr.map(all, (view) => view.runId),
              (value) => value,
              (a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0),
            ),
          ).toEqual(
            Arr.sortWith(
              runs,
              (value) => value,
              (a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0),
            ),
          );
          const ofTask = yield* registry.views("task-1");
          expect(Arr.map(ofTask, (view) => view.runId)).toEqual(
            Arr.map(
              Arr.filter(rows, (row) => row.task === "task-1"),
              (row) => row.run,
            ),
          );
          expect(ofTask).toHaveLength(2);
        }),
      ),
    ),
  120_000,
);

/** Each view the reports sweep builds: a Run's id, or the Task a listing was asked for. */
let built: Array<string | null>;

const sweeping = Effect.gen(function* () {
  built = [];
  const registry = yield* Registry;
  yield* write(socketOf(dir()), "");
  yield* Layer.build(
    reportsLayer({ env: env(), installation: "this-machine", stamp: "test" }).pipe(
      Layer.provide(
        Layer.succeed(Registry)({
          ...registry,
          view: (runId) =>
            Effect.sync(() => built.push(runId)).pipe(Effect.andThen(registry.view(runId))),
          views: (task) =>
            Effect.sync(() => built.push(task)).pipe(Effect.andThen(registry.views(task))),
        }),
      ),
    ),
  );
});

const asker: RequestedBy = {
  run: "asker-run",
  agent: "asker",
  machine: { installation: "this-machine", name: "here" },
};

const CLOSED = '{"state":"delivered","at":"2026-10-15T00:00:00.000Z","note":"done","closed":true}';

test(
  "the reports sweep builds a view only for the Run an agent started, and never delivers its closed report again",
  () =>
    runEffect(
      hosted(
        Effect.gen(function* () {
          const quiet = yield* loaded("quiet");
          const asked = yield* started(quiet, "r0", {}, null, asker);
          yield* settled(asked.runId, "complete");
          for (const request of ["r1", "r2"])
            yield* settled((yield* started(quiet, request, {})).runId, "complete");
          const report = `${runDir(dir(), asked.runId)}/report.json`;
          yield* write(report, CLOSED);

          yield* sweeping;
          yield* until(
            () => Effect.succeed(built),
            (views) => views.length >= 2,
          );

          expect(new Set(built)).toEqual(new Set([asked.runId]));
          const fs = yield* FileSystem.FileSystem;
          expect(yield* fs.readFileString(report)).toBe(CLOSED);
        }),
      ),
    ),
  120_000,
);

test(
  "the reports sweep closing a Task lists that Task's Runs only",
  () =>
    runEffect(
      hosted(
        Effect.gen(function* () {
          yield* rig.addWorkspace("wT", "Project | Picker", rig.projectDir);
          yield* writeTask(dir(), {
            id: "task-1",
            workspace: "wT",
            label: "Project | Picker",
            cwd: rig.projectDir,
            created_at: "2026-10-15T00:00:00.000Z",
          });
          const run = yield* started(yield* loaded("reported"), "r1", {}, "task-1");
          yield* settled(run.runId, "complete");
          const report = `${runDir(dir(), run.runId)}/report.json`;
          yield* write(report, pipe_(CLOSED, Str.replace('"closed":true', '"closed":false')));

          yield* sweeping;
          yield* until(
            () => Effect.succeed(built),
            (views) => views.includes("task-1"),
          );

          expect(Arr.filter(built, (one) => one !== run.runId)).toEqual(["task-1"]);
        }),
      ),
    ),
  120_000,
);
