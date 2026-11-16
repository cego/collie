// Cleanup judged from the host's Run model: the decisions it makes from disk, and no read of a
// kept Run's files beyond what the board already read.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Clock, DateTime, Effect, FileSystem } from "effect";
import type { TaskView } from "../src/board-model";
import { buildBoard } from "../src/board";
import { judge, retentionSweeper, settlingOf, stateSweeper, sweepingWith } from "../src/cleanup";
import { writeMrStates } from "../src/merges";
import { Herdr } from "../src/herdr";
import { makeRunModel } from "../src/run-model";
import type { RunFacts } from "../src/runs";
import { writeTask, type TaskRecord } from "../src/task";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";
import { madeRun } from "./support/records";
import { task as view } from "./support/task";

const DAY_MS = 24 * 60 * 60_000;
const RUNS = 500;
const OLD = 3;

let rig: Rig;
beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      yield* rig.startCore();
    }),
  ),
);
afterEach(() => runEffect(rig.close()));

test("cleanup settles hidden history without looking for an interactive host", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const run = yield* madeRun(rig.stateDir, {
        state: "succeeded",
        branch: "mk/history",
        mr: "https://github.com/o/r/pull/5",
      });
      let hostLookups = 0;
      const settling = settlingOf({
        stateDir: rig.stateDir,
        runs: [run],
        views: [],
        tasks: [],
        protect: [],
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          exists: (path) =>
            path === `${rig.stateDir}/host.db`
              ? Effect.sync(() => {
                  hostLookups++;
                  return false;
                })
              : fs.exists(path),
        }),
      );
      yield* writeMrStates(
        rig.stateDir,
        new Map([["github.com/o/r#5", "open"]]),
        new Map([
          [
            "github.com/o/r#5",
            {
              checks: { state: "unknown" },
              head: null,
              read: "2026-11-16T10:00:00Z",
            },
          ],
        ]),
      );
      const open = yield* settling;
      expect(open.owedOn.size).toBe(1);
      expect(open.landedOn.size).toBe(0);
      yield* writeMrStates(
        rig.stateDir,
        new Map([["github.com/o/r#5", "merged"]]),
        new Map([
          [
            "github.com/o/r#5",
            {
              checks: { state: "unknown" },
              head: null,
              read: "2026-11-16T11:00:00Z",
            },
          ],
        ]),
      );
      const merged = yield* settling;
      expect(merged.owedOn.size).toBe(0);
      expect([...merged.landedOn.values()]).toEqual([{ why: "merged in o/r#5", heads: [] }]);
      expect(hostLookups).toBe(0);
    }),
  ));

test(
  "the sweep judges from the model as from disk, reading only the files of Runs it removes",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = rig.stateDir;
        const now = yield* Clock.currentTimeMillis;
        const tasks: TaskRecord[] = [];
        const runs: RunFacts[] = [];
        const views: TaskView[] = [];
        for (const n of Arr.range(1, RUNS)) {
          const record: TaskRecord = {
            id: `task-${n}`,
            workspace: `w${n}`,
            label: `project | Work ${n}`,
            cwd: "/project",
            created_at: "2026-09-01T00:00:00.000Z",
          };
          yield* writeTask(record);
          const run = yield* madeRun(dir, { id: `r${n}`, task: record.id, state: "succeeded" });
          const agents = `${dir}/agents/${run.id}`;
          yield* fs.makeDirectory(agents, { recursive: true });
          for (const at of [run.dir, agents, run.evidence])
            yield* fs.writeFileString(`${at}/notes.txt`, "kept\n");
          tasks.push(record);
          runs.push(run);
          views.push(
            view({
              id: record.id,
              state: "done",
              landed: true,
              ended: now - (n <= OLD ? 40 : 3) * DAY_MS,
            }),
          );
        }
        // A Run's directory no row names, quiet for two days.
        const quiet = DateTime.toDateUtc(DateTime.makeUnsafe(now - 2 * DAY_MS));
        yield* fs.makeDirectory(`${dir}/runs/ghost`);
        yield* fs.utimes(`${dir}/runs/ghost`, quiet, quiet);
        const sweepers = [
          stateSweeper(dir, new Set(Arr.map(runs, (run) => run.id))),
          retentionSweeper({
            stateDir: dir,
            sessions: [new Herdr(rig.pluginEnv())],
            facts: Effect.succeed({ tasks, views, runs }),
            retire: Effect.succeed,
          }),
        ];

        const reads: Array<string> = [];
        const logged = (path: string) => Effect.sync(() => reads.push(path));
        const model = yield* makeRunModel(dir, "installation").pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readFileString: (path, encoding) =>
              logged(path).pipe(Effect.andThen(fs.readFileString(path, encoding))),
            readDirectory: (path, options) =>
              logged(path).pipe(Effect.andThen(fs.readDirectory(path, options))),
            exists: (path) => logged(path).pipe(Effect.andThen(fs.exists(path))),
            stat: (path) => logged(path).pipe(Effect.andThen(fs.stat(path))),
          }),
        );
        // The host's model holds what its board has read.
        yield* buildBoard({
          env: rig.pluginEnv(),
          runs,
          registered: [],
          offers: () => Effect.succeed([]),
        }).pipe(Effect.provideService(FileSystem.FileSystem, model.reading));
        const boardRead = reads.length;

        const fromDisk = yield* judge(sweepers);
        const fromModel = yield* judge(Arr.map(sweepers, sweepingWith(model.reading)));
        const removed = Arr.map(fromModel.remove, (item) => item.target);
        const gone = new Set(["ghost", ...Arr.map(Arr.range(1, OLD), (n) => `r${n}`)]);
        const keptRunFiles = Arr.filter(reads.slice(boardRead), (path) => {
          const [top, run] = Str.split(Str.slice(dir.length + 1)(path), "/");
          return (
            (top === "runs" || top === "agents" || top === "evidence") &&
            run !== undefined &&
            !gone.has(run)
          );
        });

        expect(removed).toEqual([
          `${dir}/runs/ghost`,
          ...Arr.map(Arr.range(1, OLD), (n) => `task-${n}`),
        ]);
        expect(fromModel).toEqual(fromDisk);
        expect(keptRunFiles).toEqual([]);
      }),
    ),
  60_000,
);
