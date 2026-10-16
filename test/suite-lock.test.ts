import { expect, test } from "bun:test";
import { Effect, FileSystem, Path, Schema } from "effect";
import { processStartTime } from "../src/lock";
import { inTurn } from "../tools/suite-lock";
import {
  binDirectory,
  isTargeted,
  startsSummary,
  timingFlags,
  turnFor,
  workersFor,
} from "../tools/test-run";
import { runEffect } from "./support/effect";

/** A claim as `src/lock.ts` writes one. */
const asClaim = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ pid: Schema.Int, start: Schema.NullOr(Schema.String) })),
);

const STILL = /^test: still waiting, (\d+m )?\d+s so far$/;

test("a free lock runs at once and says nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "suite-lock-" });
      const said: string[] = [];
      const got = yield* inTurn(`${dir}/suite.lock`, Effect.succeed(7), (line) =>
        Effect.sync(() => void said.push(line)),
      );
      expect(got).toBe(7);
      expect(said).toEqual([]);
    }).pipe(Effect.scoped),
  ));

test("a held lock names its holder once, then the wait as it grows, and falls quiet once it runs", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "suite-lock-" });
      const lock = `${dir}/suite.lock`;
      const holder = Bun.spawn(["sleep", "30"]);
      yield* Effect.addFinalizer(() => Effect.sync(() => holder.kill()));
      const start = yield* processStartTime(holder.pid);
      yield* fs.writeFileString(lock, `${asClaim({ pid: holder.pid, start })}\n`);

      const said: string[] = [];
      // The holder's suite ends once the waiter has said twice how long it has waited.
      const say = (line: string) =>
        Effect.gen(function* () {
          said.push(line);
          if (said.filter((one) => STILL.test(one)).length === 2) yield* fs.remove(lock);
        }).pipe(Effect.orDie);
      let atStart = -1;
      // A suite that runs for several intervals, as a real one does for minutes.
      const suite = Effect.sync(() => (atStart = said.length)).pipe(
        Effect.andThen(Effect.sleep("500 millis")),
        Effect.as("ran"),
      );
      const got = yield* inTurn(lock, suite, say, "100 millis");

      expect(got).toBe("ran");
      const [named, ...waited] = said;
      expect(named).toContain(`process ${holder.pid}`);
      expect(named).toContain("sleep 30");
      expect(named).toMatch(/since \w{3} \w{3} +\d+ \d\d:\d\d:\d\d \d{4}/);
      expect(waited.length).toBeGreaterThanOrEqual(2);
      for (const line of waited) expect(line).toMatch(STILL);
      expect(said).toHaveLength(atStart);
    }).pipe(Effect.scoped),
  ));

const heldLock = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "suite-lock-" });
  const lock = `${dir}/suite.lock`;
  const holder = Bun.spawn(["sleep", "30"]);
  yield* Effect.addFinalizer(() => Effect.sync(() => holder.kill()));
  const start = yield* processStartTime(holder.pid);
  yield* fs.writeFileString(lock, `${asClaim({ pid: holder.pid, start })}\n`);
  return { lock, holder };
});

test("a run naming an existing path or --changed is targeted, anything else is the whole suite", () =>
  runEffect(
    Effect.gen(function* () {
      const targeted = (...args: string[]) => isTargeted(args);
      expect(yield* targeted("test/suite-lock.test.ts")).toBe(true);
      expect(yield* targeted("test/support")).toBe(true);
      expect(yield* targeted("--changed")).toBe(true);
      expect(yield* targeted("--changed=origin/master")).toBe(true);
      expect(yield* targeted()).toBe(false);
      expect(yield* targeted("-t", "foo")).toBe(false);
      expect(yield* targeted("-t", "test")).toBe(false);
      expect(yield* targeted("lock")).toBe(false);
      expect(yield* targeted("--timings", "tools/test-timings.json")).toBe(false);
      expect(yield* targeted("--preload", "test/support")).toBe(false);
      expect(yield* targeted("--coverage", "test/suite-lock.test.ts")).toBe(true);
      expect(yield* targeted("--bail", "test/suite-lock.test.ts")).toBe(true);
      expect(yield* targeted("--", "test/suite-lock.test.ts")).toBe(true);
      expect(yield* targeted("--parallel", "test/suite-lock.test.ts")).toBe(true);
    }),
  ));

test("a targeted run goes ahead at once while a suite holds the lock, and a whole one waits for it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { lock, holder } = yield* heldLock;
      const said: string[] = [];
      const say = (line: string) =>
        Effect.sync(() => void said.push(line)).pipe(Effect.andThen(fs.remove(lock)), Effect.orDie);

      expect(yield* turnFor(true, lock, Effect.succeed("now"), say)).toBe("now");
      expect(said).toEqual([]);

      expect(yield* turnFor(false, lock, Effect.succeed("later"), say, "100 millis")).toBe("later");
      expect(said[0]).toContain(`process ${holder.pid}`);
    }).pipe(Effect.scoped),
  ));

test("a targeted run builds into a directory of its own and removes it, and a whole one into the checkout's", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const shared = (yield* Path.Path).resolve(".scratch/test-bin");
      expect(yield* binDirectory(false)).toBe(shared);

      const own = yield* Effect.scoped(
        Effect.gen(function* () {
          const dir = yield* binDirectory(true);
          expect(dir).not.toBe(shared);
          expect(yield* fs.exists(dir)).toBe(true);
          return dir;
        }),
      );
      expect(yield* fs.exists(own)).toBe(false);
    }).pipe(Effect.scoped),
  ));

test("a targeted run reads the timings and never updates them", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "suite-timings-" });
      const timings = `${dir}/test-timings.json`;
      const seed = "tools/test-timings.json";
      expect(yield* timingFlags(false, timings, seed)).toEqual([
        `--timings=${timings}`,
        "--update-timings",
      ]);
      expect(yield* timingFlags(true, timings, seed)).toEqual([`--timings=${seed}`]);
      yield* fs.writeFileString(timings, "{}");
      expect(yield* timingFlags(true, timings, seed)).toEqual([`--timings=${timings}`]);
    }).pipe(Effect.scoped),
  ));

/** `os.cpus()` for `cores` cores, each with `idle` and `busy` ms so far. */
const sample = (cores: number, idle: number, busy: number) =>
  Array.from({ length: cores }, () => ({
    times: { user: busy, nice: 0, sys: 0, idle, irq: 0 },
  }));

test("a suite takes the cores that were idle over the sample, at least 2 and at most one per core", () => {
  const before = sample(16, 1_000, 1_000);
  expect(workersFor([], before, sample(16, 2_000, 1_000), 16)).toEqual({
    workers: 16,
    line: "test: 16 workers (16.0 of 16 cores free)",
  });
  expect(workersFor([], before, sample(16, 1_000, 2_000), 16)).toEqual({
    workers: 2,
    line: "test: 2 workers (0.0 of 16 cores free)",
  });
  expect(workersFor([], before, sample(16, 1_500, 1_500), 16)).toEqual({
    workers: 8,
    line: "test: 8 workers (8.0 of 16 cores free)",
  });
  expect(workersFor([], before, before, 16)).toEqual({
    workers: 16,
    line: "test: 16 workers (16.0 of 16 cores free)",
  });
});

test("a --parallel the caller passed stands, and one after -- is a test's argument", () => {
  const before = sample(16, 1_000, 1_000);
  const busy = sample(16, 1_000, 2_000);
  expect(workersFor(["--parallel=4", "test/engine.test.ts"], before, busy, 16)).toEqual({
    workers: "caller",
    line: "test: workers as the caller's --parallel=4 says",
  });
  expect(workersFor(["--parallel"], before, busy, 16)).toEqual({
    workers: "caller",
    line: "test: workers as the caller's --parallel says",
  });
  expect(workersFor(["--", "--parallel=4"], before, busy, 16).workers).toBe(2);
});

test("a suite counts the processes it started and names the ten largest sources", () => {
  const sources = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];
  const lines = sources.flatMap((source, at) =>
    Array.from({ length: at + 1 }, () => `herdr ${source}`),
  );
  expect(startsSummary(`${lines.join("\n")}\ncollie host\n`)).toEqual([
    "test: 79 processes started",
    "     12  herdr l",
    "     11  herdr k",
    "     10  herdr j",
    "      9  herdr i",
    "      8  herdr h",
    "      7  herdr g",
    "      6  herdr f",
    "      5  herdr e",
    "      4  herdr d",
    "      3  herdr c",
  ]);
  expect(startsSummary("")).toEqual(["test: 0 processes started"]);
});
