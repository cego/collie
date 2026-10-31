import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as Struct from "effect/Struct";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { TaskView } from "../src/board-model";
import { buildBoard } from "../src/board";
import { readEnv } from "../src/env";
import { makeRunModel } from "../src/run-model";
import { writeTask } from "../src/task";
import { epochMs } from "../src/time";
import { runEffect } from "./support/effect";
import { madeRun, runFacts } from "./support/records";

const RUNS = 500;

/** A card as the board draws one, for what the model stamps on it. */
const card = (over: Partial<TaskView> = {}): TaskView => ({
  id: "t1",
  name: "Work",
  project: "project",
  state: "active",
  steps: [],
  sentence: "Working.",
  age: "1m",
  drift: null,
  held: null,
  heldBy: null,
  decision: null,
  agents: [],
  children: [],
  mr: null,
  branch: null,
  disposition: null,
  landed: false,
  ended: null,
  mrState: null,
  planReady: false,
  offer: null,
  run: "b",
  runs: ["b", "a"],
  at: 0,
  ...over,
});

test(
  "a change to one Run re-reads only that Run's files, and the board still equals one read from disk",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-run-model-" });
        const env = readEnv({ HERDR_PLUGIN_STATE_DIR: dir, COLLIE_CWD: "/project" });
        const runs = yield* Effect.forEach(Arr.range(1, RUNS), (n) =>
          Effect.gen(function* () {
            const task = `task-${n}`;
            yield* writeTask(dir, {
              id: task,
              workspace: "w1",
              label: `project | Work ${n}`,
              cwd: "/project",
              created_at: "2026-10-30T09:00:00Z",
            });
            const run = yield* madeRun(dir, {
              id: `r${n}`,
              task,
              state: n % 2 === 0 ? "succeeded" : "running",
              created: "2026-10-30T09:00:00Z",
            });
            yield* fs.writeFileString(`${run.dir}/log.txt`, "started\n");
            return run;
          }),
        );
        const reads: string[] = [];
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
        const now = epochMs("2026-10-30T10:00:00Z");
        const build = (through: FileSystem.FileSystem) =>
          buildBoard({
            env,
            runs,
            now,
            registered: [],
            offers: () => Effect.succeed([]),
          }).pipe(Effect.provideService(FileSystem.FileSystem, through));
        yield* build(model.reading);
        expect(reads.length).toBeGreaterThan(RUNS);

        reads.length = 0;
        const changed = runs[41]!;
        yield* model.writing.makeDirectory(`${changed.dir}/plan/issues`, { recursive: true });
        yield* model.writing.writeFileString(`${changed.dir}/plan/issues/01-next.md`, "# Next\n");
        const fromModel = yield* build(model.reading);

        const own = [changed.dir, changed.evidence, `${dir}/agents/${changed.id}`];
        const elsewhere = Arr.filter(
          reads,
          (path) => !Arr.some(own, (mine) => path === mine || Str.startsWith(`${mine}/`)(path)),
        );
        expect(elsewhere).toEqual([]);
        expect(Arr.some(reads, Str.startsWith(changed.dir))).toBe(true);
        expect(fromModel).toEqual(yield* build(fs));
      }),
    ),
  60_000,
);

test("revisions grow within an epoch, per Run, and a Task's is the highest of its Runs'", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-run-model-" });
      const model = yield* makeRunModel(dir, "installation");
      const a = runFacts({ id: "a", task: "t1", dir: `${dir}/runs/a` });
      const b = runFacts({ id: "b", task: "t1", dir: `${dir}/runs/b` });
      const c = runFacts({ id: "c", task: "t2", dir: `${dir}/runs/c` });
      yield* model.observe([a, b, c]);
      const seqOf = (run: string) => model.revision(run).seq;
      const first = { a: seqOf("a"), b: seqOf("b"), c: seqOf("c") };
      expect(model.revision("a").epoch).toBe(model.epoch);

      yield* model.invalidate(`${dir}/runs/a/log.txt`);
      expect(seqOf("a")).toBeGreaterThan(first.a);
      expect([seqOf("b"), seqOf("c")]).toEqual([first.b, first.c]);

      const afterA = seqOf("a");
      yield* model.observe([a, { ...b, state: "succeeded" }, c]);
      expect(seqOf("b")).toBeGreaterThan(afterA);
      expect([seqOf("a"), seqOf("c")]).toEqual([afterA, first.c]);

      // Seen again unchanged, nothing moves.
      const settled = { a: seqOf("a"), b: seqOf("b"), c: seqOf("c") };
      yield* model.observe([a, { ...b, state: "succeeded" }, c]);
      expect({ a: seqOf("a"), b: seqOf("b"), c: seqOf("c") }).toEqual(settled);

      const [stamped] = model.stamp([card()]);
      expect(stamped!.revision).toEqual({
        epoch: model.epoch,
        seq: Math.max(settled.a, settled.b),
      });
      // A card that moved with no Run's revision moving still says so.
      const [moved] = model.stamp([card({ sentence: "Quiet for 6 minutes." })]);
      expect(moved!.revision!.seq).toBeGreaterThan(stamped!.revision!.seq);
      expect(seqOf("c")).toBe(first.c);

      const restarted = yield* makeRunModel(dir, "installation");
      expect(restarted.epoch).not.toBe(model.epoch);
      expect(Str.startsWith("installation")(restarted.epoch)).toBe(true);
    }),
  ));

test("the model indexes Runs by Task, parent, requester and plan", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-run-model-" });
      const model = yield* makeRunModel(dir, "installation");
      const machine = { installation: "installation", name: "vm" };
      yield* model.observe([
        runFacts({ id: "plan", task: "t1" }),
        runFacts({
          id: "build",
          task: "t1",
          parent: "plan",
          settled: {
            inputs: { plan: "/state/runs/plan/plan" },
            strategies: { plan: "plan-dir" },
            sources: {},
          },
        }),
        runFacts({ id: "asked", task: "t2", requestedBy: { machine, run: "plan", agent: "a" } }),
      ]);
      const { byTask, byParent, byRequester, byPlan } = model.indexes();
      expect(byTask.get("t1")).toEqual(new Set(["plan", "build"]));
      expect(byParent.get("plan")).toEqual(new Set(["build"]));
      expect(byRequester.get("plan")).toEqual(new Set(["asked"]));
      expect(byPlan.get("/state/runs/plan/plan")).toEqual(new Set(["build"]));

      yield* model.observe([runFacts({ id: "plan", task: "t1" })]);
      expect(model.indexes().byTask.get("t1")).toEqual(new Set(["plan"]));
      expect(model.indexes().byParent.get("plan")).toBeUndefined();
    }),
  ));

test("a board item with its revision decodes with the item schema as it was before it", () =>
  runEffect(
    Effect.gen(function* () {
      const before = Schema.Struct(Struct.omit(TaskView.fields, ["revision"]));
      const item = card();
      const revised = { ...item, revision: { epoch: "installation.start", seq: 7 } };
      expect(yield* Schema.decodeEffect(before)(revised)).toEqual(item);
      expect(yield* Schema.decodeEffect(TaskView)(item)).toEqual(item);
      expect(yield* Schema.decodeEffect(TaskView)(revised)).toEqual(revised);
    }),
  ));
