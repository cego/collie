import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as Struct from "effect/Struct";
import { heapStats } from "bun:jsc";
import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber, FileSystem, Layer, Queue, Schema, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { TaskView } from "../src/board-model";
import { buildBoard } from "../src/board";
import { readEnv } from "../src/env";
import { makeRunModel, RunModel, runModelLayer } from "../src/run-model";
import { writeTask } from "../src/task";
import { epochMs } from "../src/time";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import { until } from "./support/host";
import { madeRun, recordsAt, runFacts } from "./support/records";

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
            yield* writeTask({
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

test("a Task written moves the Revision of its Runs, and no other Run's", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "collie-run-model-",
      });
      yield* Effect.gen(function* () {
        const model = yield* RunModel;
        yield* model.observe([
          runFacts({ id: "r1", task: "t1", dir: `${dir}/runs/r1` }),
          runFacts({ id: "r2", task: "t2", dir: `${dir}/runs/r2` }),
        ]);
        const before = [model.revision("r1").seq, model.revision("r2").seq];
        yield* writeTask({
          id: "t1",
          workspace: "w1",
          label: "project | Work",
          cwd: "/project",
          created_at: "2026-10-30T09:00:00Z",
        });
        expect(model.revision("r1").seq).toBeGreaterThan(before[0]!);
        expect(model.revision("r2").seq).toBe(before[1]!);
      }).pipe(
        Effect.provide(recordsAt(dir).pipe(Layer.provideMerge(runModelLayer(dir, "installation")))),
      );
    }),
  ));

test("files the model keeps as missing read as missing, and keep no Error alive", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-run-model-" });
      const model = yield* makeRunModel(dir, "installation");
      yield* model.observe([runFacts({ id: "r1", task: "t1", dir: `${dir}/runs/r1` })]);
      const missing = (n: number) =>
        model.reading.readFileString(`${dir}/runs/r1/missing-${n}.md`).pipe(
          Effect.flip,
          Effect.map((error) => error.reason._tag),
        );
      const errors = () => {
        Bun.gc(true);
        return heapStats().objectTypeCounts["Error"] ?? 0;
      };
      yield* missing(-1);
      const before = errors();

      const first = yield* Effect.forEach(Arr.range(0, 299), missing);
      const again = yield* Effect.forEach(Arr.range(0, 299), missing);

      expect(new Set([...first, ...again])).toEqual(new Set(["NotFound"]));
      expect(errors() - before).toBeLessThan(100);
    }),
  ));

test("a read kept while another Run's file changed is read from disk once", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-run-model-" });
      const file = `${dir}/runs/r1/log.txt`;
      yield* fs.makeDirectory(`${dir}/runs/r1`, { recursive: true });
      yield* fs.writeFileString(file, "started\n");
      const gate = yield* Deferred.make<void>();
      const reading = yield* Deferred.make<void>();
      let reads = 0;
      const model = yield* makeRunModel(dir, "installation").pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFileString: (path, encoding) =>
            path === file
              ? Effect.sync(() => reads++).pipe(
                  Effect.andThen(Deferred.succeed(reading, undefined)),
                  Effect.andThen(Deferred.await(gate)),
                  Effect.andThen(fs.readFileString(path, encoding)),
                )
              : fs.readFileString(path, encoding),
        }),
      );
      yield* model.observe([runFacts({ id: "r1", task: "t1", dir: `${dir}/runs/r1` })]);

      const first = yield* Effect.forkChild(model.reading.readFileString(file));
      yield* Deferred.await(reading);
      yield* model.invalidate(`${dir}/runs/r2/log.txt`);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(first);
      yield* model.reading.readFileString(file);

      expect(reads).toBe(1);
    }),
  ));

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

test("a record that moves while its Runs do not moves its Run, under any of its keys", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-run-model-" });
      const model = yield* makeRunModel(dir, "installation");
      yield* model.observe([runFacts({ id: "r1", task: "t1", dir: `${dir}/runs/r1` })]);
      const tailed = "r1 with its tail";
      const before = model.stampRecord(tailed, "r1", ["r1"], "merge request open");
      const after = model.stampRecord(tailed, "r1", ["r1"], "merge request merged");
      expect(after.seq).toBeGreaterThan(before.seq);
      expect(model.revision("r1").seq).toBe(after.seq);
      const untailed = "r1 without its tail";
      expect(model.stampRecord(untailed, "r1", ["r1"], "merge request merged").seq).toBe(after.seq);
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

test("two models of one state directory number their Runs as one, each told what the other moved", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-run-model-" });
      const run = yield* madeRun(dir, { id: "r1", created: "2026-10-30T09:00:00Z" });
      const log = `${run.dir}/log.txt`;
      yield* fs.writeFileString(log, "one\n");
      const counter = new Int32Array(new SharedArrayBuffer(4));
      const told: Array<Effect.Effect<void>> = [];
      let reader: Effect.Success<ReturnType<typeof makeRunModel>> | undefined;
      const writer = yield* makeRunModel(dir, "installation", {
        counter,
        epoch: "shared",
        touched: (id, seq, facts) =>
          void told.push(Effect.sync(() => reader!.heard(id, seq, facts))),
        invalidated: (path) => void told.push(Effect.suspend(() => reader!.forget(path))),
        disabled: () => {},
      });
      reader = yield* makeRunModel(dir, "installation", {
        counter,
        epoch: "shared",
        touched: (id, seq, facts) =>
          void told.push(Effect.sync(() => writer.heard(id, seq, facts))),
        invalidated: () => {},
        disabled: () => {},
      });
      const deliver = Effect.suspend(() => Effect.all(told.splice(0), { discard: true }));
      yield* writer.observe([run]);
      expect(yield* reader.reading.readFileString(log)).toBe("one\n");

      yield* writer.writing.writeFileString(log, "two\n");
      yield* deliver;
      expect(reader.revision("r1")).toEqual(writer.revision("r1"));
      expect(reader.revision("r1").seq).toBeGreaterThan(0);
      expect(reader.factsAt("r1")).toBe(writer.factsAt("r1"));
      expect(yield* reader.reading.readFileString(log)).toBe("two\n");

      // A record that moved while none of its Runs did moves its Run for both.
      reader.stampRecord("key", "r1", ["r1"], "first");
      const moved = reader.stampRecord("key", "r1", ["r1"], "second");
      yield* deliver;
      expect(writer.revision("r1")).toEqual(moved);
      expect(moved.epoch).toBe("shared");
    }).pipe(Effect.scoped),
  ));

test("only a Run's files or its row move what its facts were read at; a card or a record moving it does not", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-run-model-" });
      const run = yield* madeRun(dir, { id: "b", created: "2026-10-30T09:00:00Z" });
      const model = yield* makeRunModel(dir, "installation");
      yield* model.observe([run]);
      const read = model.factsAt("b");

      model.stamp([card({ sentence: "Working." })]);
      model.stamp([card({ sentence: "Still working." })]);
      model.stampRecord("key", "b", ["b"], "first");
      model.stampRecord("key", "b", ["b"], "second");
      expect(model.revision("b").seq).toBeGreaterThan(read);
      expect(model.factsAt("b")).toBe(read);

      yield* model.writing.writeFileString(`${run.dir}/log.txt`, "moved\n");
      expect(model.factsAt("b")).toBeGreaterThan(read);
      const written = model.factsAt("b");
      model.wrote(["b"]);
      expect(model.factsAt("b")).toBeGreaterThan(written);
    }).pipe(Effect.scoped),
  ));

test("a branch head read before its checkout is watched is read again, so a move then is not missed", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-run-model-" });
      const repo = `${dir}/repo`;
      const git = (...args: ReadonlyArray<string>) =>
        exec(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
      yield* fs.makeDirectory(repo, { recursive: true });
      yield* git("init", "-q", "-b", "mk/ship");
      yield* git("commit", "-q", "--allow-empty", "-m", "one");
      const watched = yield* Deferred.make<void>();
      const model = yield* makeRunModel(dir, "installation").pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          watch: (path, options) =>
            Stream.unwrap(Effect.as(Deferred.await(watched), fs.watch(path, options))),
        }),
      );
      const run = runFacts({ id: "r1", cwd: repo, branch: "mk/ship" });

      yield* model.head(run);
      yield* git("commit", "-q", "--allow-empty", "-m", "two");
      const two = Str.trim((yield* git("rev-parse", "HEAD")).stdout);
      expect(yield* model.head(run)).toBe(two);
    }).pipe(Effect.scoped),
  ));

test("a branch head read while its checkout moves is not kept, so the move reaches the next read", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-run-model-" });
      const repo = `${dir}/repo`;
      const git = (...args: ReadonlyArray<string>) =>
        exec(["git", "-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...args]);
      yield* fs.makeDirectory(repo, { recursive: true });
      yield* git("init", "-q", "-b", "mk/ship");
      yield* git("commit", "-q", "--allow-empty", "-m", "one");
      // The checkout's watches say it moved when the test does, and never by themselves.
      const moves = yield* Queue.unbounded<FileSystem.WatchEvent>();
      let installed = 0;
      // One read of the head has git's answer and is held before the model takes it.
      const gate = {
        armed: false,
        answered: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
      };
      const held = ChildProcessSpawner.make((command) =>
        spawner.spawn(command).pipe(
          Effect.tap((handle) =>
            Effect.suspend(() => {
              if (
                !gate.armed ||
                command._tag !== "StandardCommand" ||
                !command.args.includes("--verify")
              )
                return Effect.void;
              gate.armed = false;
              return handle.exitCode.pipe(
                Effect.andThen(Deferred.succeed(gate.answered, undefined)),
                Effect.andThen(Deferred.await(gate.release)),
              );
            }),
          ),
        ),
      );
      const model = yield* makeRunModel(dir, "installation").pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          watch: (_, options) =>
            Stream.unwrap(
              Effect.sync(() => {
                installed++;
                options?.onReady?.();
                return Stream.fromQueue(moves);
              }),
            ),
        }),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, held),
      );
      const run = runFacts({ id: "r1", cwd: repo, branch: "mk/ship" });

      yield* model.head(run);
      yield* until(
        () => Effect.sync(() => installed),
        (count) => count === 3,
      );
      gate.armed = true;
      const early = yield* Effect.forkChild(model.head(run));
      yield* Deferred.await(gate.answered);
      yield* git("commit", "-q", "--allow-empty", "-m", "two");
      const two = Str.trim((yield* git("rev-parse", "HEAD")).stdout);
      const before = yield* model.checkout(run);
      yield* Queue.offer(moves, { _tag: "Update", path: `${repo}/.git/refs/heads/mk/ship` });
      yield* until(
        () => model.checkout(run),
        (count) => count > before,
      );
      yield* Deferred.succeed(gate.release, undefined);
      yield* Fiber.join(early);
      expect(yield* model.head(run)).toBe(two);
    }).pipe(Effect.scoped),
  ));
