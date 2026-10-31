// A Run's record read from the host's Run model: nothing read or sent on a bare tick, and
// nothing read of another Task's Runs.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Queue, Stream } from "effect";
import { TestClock } from "effect/testing";
import type { RecordUnchanged, RunDetail } from "../src/board-model";
import { readEnv } from "../src/env";
import { recordFrames, type RecordSources } from "../src/record";
import { makeRunModel } from "../src/run-model";
import type { RunFacts } from "../src/runs";
import { writeTask } from "../src/task";
import { runEffect } from "./support/effect";
import { madeRun } from "./support/records";

type Frame = RunDetail | RecordUnchanged | null;

const isDone = (frame: Frame): frame is RunDetail =>
  frame !== null && !("_tag" in frame) && (frame.pending ?? []).length === 0;

/** `count` Runs, each in a Task of its own, with files under all three of their directories. */
const stateOf = (count: number) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-record-" });
    const runs = yield* Effect.forEach(Arr.range(1, count), (n) =>
      Effect.gen(function* () {
        const task = `task-${n}`;
        yield* writeTask(dir, {
          id: task,
          workspace: `w${n}`,
          label: `project | Work ${n}`,
          cwd: "/project",
          created_at: "2026-10-30T09:00:00Z",
        });
        const run = yield* madeRun(dir, {
          id: `r${n}`,
          task,
          state: n % 2 === 0 ? "succeeded" : "running",
          created: "2026-10-30T09:00:00Z",
          finished: n % 2 === 0 ? "2026-10-30T09:30:00Z" : null,
        });
        yield* fs.writeFileString(`${run.dir}/log.txt`, "started\n");
        yield* fs.writeFileString(`${run.evidence}/notes.txt`, "kept\n");
        yield* fs.makeDirectory(`${dir}/agents/${run.id}`, { recursive: true });
        yield* fs.writeFileString(`${dir}/agents/${run.id}/launches`, "");
        return run;
      }),
    );
    return { dir, runs };
  });

/** A model over `dir` whose every read of the disk beneath it is logged in `reads`. */
const loggedModel = (dir: string, reads: Array<string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const logged = (path: string) => Effect.sync(() => reads.push(path));
    return yield* makeRunModel(dir, "installation").pipe(
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
  });

/** A record's sources over these Runs; each build of it says when it starts with `started`. */
const sourcesOf = (
  dir: string,
  model: Effect.Success<ReturnType<typeof makeRunModel>>,
  runs: ReadonlyArray<RunFacts>,
  started: Effect.Effect<void> = Effect.void,
): RecordSources => ({
  env: readEnv({ HERDR_PLUGIN_STATE_DIR: dir, COLLIE_CWD: "/project" }),
  model,
  related: (runId, also) => {
    const task = Arr.findFirst(runs, (one) => one.id === runId);
    return started.pipe(
      Effect.as(
        Arr.filter(
          runs,
          (one) => also.includes(one.id) || (task._tag === "Some" && one.task === task.value.task),
        ),
      ),
    );
  },
  alive: Effect.succeed([]),
  offers: () => Effect.succeed([]),
  mr: () => Effect.succeed(null),
  plans: new Map(),
});

const KEY = { tail: true, pages: 1, refreshMr: false, parts: true } as const;

test("a bare tick reads none of a record's files and sends nothing; a change sends one frame", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { dir, runs } = yield* stateOf(3);
      const reads: Array<string> = [];
      const model = yield* loggedModel(dir, reads);
      const run = runs[0]!;
      const poked = yield* Queue.unbounded<void>();
      const frames = yield* Queue.unbounded<Frame>();
      // How much had been read when each build of the record began.
      const builds = yield* Queue.unbounded<number>();
      const started = Effect.suspend(() => Queue.offer(builds, reads.length));
      // As the host's board is told: on every tick, and on every write.
      const changes = Stream.merge(Stream.fromQueue(poked), Stream.tick("5 seconds"));
      yield* recordFrames(
        sourcesOf(dir, model, runs, Effect.asVoid(started)),
        { ...KEY, runId: run.id },
        changes,
      ).pipe(
        Stream.runForEach((frame) => Queue.offer(frames, frame)),
        Effect.forkScoped,
      );
      let first = yield* Queue.take(frames);
      while (!isDone(first)) first = yield* Queue.take(frames);

      // The first build, then the tick on subscribing, which finds what the first frame wrote.
      yield* Effect.replicateEffect(Queue.take(builds), 2);
      let quiet = 0;
      for (const tick of Arr.range(1, 12)) {
        // Lets the last build end, so the next tick is waiting on the clock.
        yield* TestClock.withLive(Effect.sleep("20 millis"));
        yield* TestClock.adjust("5 seconds");
        const at = yield* Queue.take(builds);
        if (tick === 1) quiet = at;
      }
      yield* fs.makeDirectory(`${run.dir}/handoffs`, { recursive: true });
      yield* model.writing.writeFileString(`${run.dir}/handoffs/next.md`, "the next step\n");
      yield* Queue.offer(poked, undefined);
      const ticked = yield* Queue.take(builds);
      const after = yield* Queue.take(frames);

      expect(reads.slice(quiet, ticked)).toEqual([]);
      expect(isDone(after) && after.handoffFiles).toEqual([{ name: "next.md", bytes: 14 }]);
      expect(isDone(after) && after.revision!.seq > first.revision!.seq).toBe(true);
      expect(yield* Queue.size(frames)).toBe(0);
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test(
  "opening a record among 500 Runs reads no file of another Task's Runs",
  () =>
    runEffect(
      Effect.gen(function* () {
        const { dir, runs } = yield* stateOf(500);
        const reads: Array<string> = [];
        const model = yield* loggedModel(dir, reads);
        const run = runs[41]!;
        const shown = yield* recordFrames(
          sourcesOf(dir, model, runs),
          { ...KEY, runId: run.id },
          Stream.never,
        ).pipe(Stream.takeUntil(isDone), Stream.runCollect);
        const others = Arr.flatMap(
          Arr.filter(runs, (one) => one.task !== run.task),
          (one: RunFacts) => [
            `${dir}/runs/${one.id}`,
            `${dir}/agents/${one.id}`,
            `${dir}/evidence/${one.id}`,
          ],
        );
        const theirs = Arr.filter(reads, (path) =>
          Arr.some(others, (other) => path === other || Str.startsWith(`${other}/`)(path)),
        );

        expect(Arr.some(shown, isDone)).toBe(true);
        expect(Arr.some(reads, Str.startsWith(run.dir))).toBe(true);
        expect(theirs).toEqual([]);
      }),
    ),
  60_000,
);
