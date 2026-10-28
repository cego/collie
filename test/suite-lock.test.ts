import { expect, test } from "bun:test";
import { Effect, Fiber, FileSystem, Path, Schema } from "effect";
import { processStartTime } from "../src/lock";
import { budgetOf, entriesOf } from "../tools/budget";
import { inTurn } from "../tools/suite-lock";
import {
  binDirectory,
  isTargeted,
  pressureAt,
  report,
  requestOf,
  startsSummary,
  timingFlags,
  turnFor,
} from "../tools/test-run";
import { until } from "./support/host";
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

test("a targeted run goes ahead at once while a suite holds the old lock, and a whole one admitted by the budget waits for it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { lock, holder } = yield* heldLock;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "suite-budget-" });
      const budget = budgetOf(24);
      const said: string[] = [];
      const say = (line: string) => Effect.sync(() => void said.push(line));
      const ran = (what: string) => () => Effect.succeed(what);

      expect(yield* turnFor(requestOf([], budget, true), dir, budget, lock, ran("now"), say)).toBe(
        "now",
      );
      expect(said).toEqual([]);

      let started = false;
      const suite = yield* Effect.forkChild(
        turnFor(
          requestOf([], budget, false),
          dir,
          budget,
          lock,
          () => Effect.sync(() => (started = true)).pipe(Effect.as("later")),
          say,
          "100 millis",
        ),
      );
      yield* until(
        () => Effect.succeed(said.length),
        (count) => count > 0,
      );
      expect(said[0]).toContain(`process ${holder.pid}`);
      const holds = yield* entriesOf(dir);
      expect(holds).toMatchObject([{ kind: "whole", state: "held", workers: 12 }]);
      expect(started).toBe(false);

      yield* fs.remove(lock);
      expect(yield* Fiber.join(suite)).toBe("later");
      expect(yield* entriesOf(dir)).toEqual([]);
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

test("a run asks for its kind's workers, or the --parallel its caller passed, which it hands on as its own", () => {
  const budget = budgetOf(24);
  expect(requestOf(["-t", "x"], budget, false)).toEqual({
    kind: "whole",
    asked: 12,
    args: ["-t", "x"],
  });
  expect(requestOf(["test/a.test.ts"], budget, true)).toEqual({
    kind: "small",
    asked: 2,
    args: ["test/a.test.ts"],
  });
  expect(requestOf(["--parallel=6", "test/a.test.ts"], budget, true)).toEqual({
    kind: "small",
    asked: 6,
    args: ["test/a.test.ts"],
  });
  expect(requestOf(["--parallel"], budget, false)).toEqual({ kind: "whole", asked: 12, args: [] });
  expect(requestOf(["--", "--parallel=4"], budget, true)).toEqual({
    kind: "small",
    asked: 2,
    args: ["--", "--parallel=4"],
  });
});

test("a run asks for the last --parallel it was passed and hands on none of them", () => {
  expect(requestOf(["--parallel=2", "--parallel=24"], budgetOf(24), false)).toEqual({
    kind: "whole",
    asked: 24,
    args: [],
  });
});

test("a value an option takes is never read as a --parallel", () => {
  expect(requestOf(["-t", "--parallel=24", "./fixture.test.ts"], budgetOf(24), true)).toEqual({
    kind: "small",
    asked: 2,
    args: ["-t", "--parallel=24", "./fixture.test.ts"],
  });
});

const ENDS = {
  admitted: { psi: 1.25, load: 3.5 },
  ended: { psi: 40, load: 14.25 },
};

test("a whole suite's report says where its time went, its longest file and the pressure at both ends", () => {
  expect(
    report({
      queued: 61.5,
      built: 20,
      ran: 400,
      workers: 12,
      budget: budgetOf(24),
      timings: { "test/a.test.ts": 100_000, "test/b.test.ts": 50_000, "test/c.test.ts": 250 },
      starts: "herdr agent list\nherdr agent list\ncollie host\n",
      ...ENDS,
    }),
  ).toEqual([
    "test: queued 61.50 s, built 20.00 s, ran 400.00 s",
    "test: 12 workers of a budget of 16, 4 of it kept for small runs",
    "test: longest file test/a.test.ts at 100.00 s, 25 % of the run; per-file time summed 150.25 s",
    "test: 3 processes started",
    "      2  herdr agent list",
    "      1  collie host",
    "test: CPU pressure (some avg60) 1.25 % at admission, 40.00 % at the end",
    "test: 1-minute load 3.50 at admission, 14.25 at the end",
    "test: 420.00 s including builds",
  ]);
});

test("a targeted run's report leaves out the files, and pressure a Machine cannot read is not available", () => {
  expect(
    report({
      queued: 0,
      built: 2.5,
      ran: 3,
      workers: 2,
      budget: budgetOf(2),
      timings: null,
      starts: "",
      admitted: { psi: null, load: 0.5 },
      ended: { psi: null, load: 0.75 },
    }),
  ).toEqual([
    "test: queued 0.00 s, built 2.50 s, ran 3.00 s",
    "test: 2 workers of a budget of 2, shared by every run",
    "test: 0 processes started",
    "test: CPU pressure (some avg60) not available at admission, not available at the end",
    "test: 1-minute load 0.50 at admission, 0.75 at the end",
    "test: 5.50 s including builds",
  ]);
});

test("CPU pressure is read from some avg60, and is null where there is no pressure file", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pressure-" });
      yield* fs.writeFileString(
        `${dir}/cpu`,
        "some avg10=2.50 avg60=7.25 avg300=1.00 total=123\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
      );
      expect((yield* pressureAt(`${dir}/cpu`)).psi).toBe(7.25);
      expect((yield* pressureAt(`${dir}/missing`)).psi).toBeNull();
    }).pipe(Effect.scoped),
  ));

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

test("a suite names the files that started the most processes, with each one's leading commands", () => {
  const record = [
    ...Array.from({ length: 5 }, () => "herdr agent list\ttest/a.test.ts"),
    ...Array.from({ length: 2 }, () => "herdr pane list\ttest/a.test.ts"),
    ...Array.from({ length: 4 }, () => "herdr pane list\ttest/b.test.ts"),
    ...Array.from({ length: 3 }, () => "collie host\ttest/b.test.ts"),
    "herdr session list\ttest/b.test.ts",
    "herdr session list\ttest/c.test.ts",
    "collie host",
  ];
  expect(startsSummary(`${record.join("\n")}\n`)).toEqual([
    "test: 17 processes started",
    "      6  herdr pane list",
    "      5  herdr agent list",
    "      4  collie host",
    "      2  herdr session list",
    "test: processes started by file",
    "      8  test/b.test.ts",
    "           4  herdr pane list",
    "           3  collie host",
    "           1  herdr session list",
    "      7  test/a.test.ts",
    "           5  herdr agent list",
    "           2  herdr pane list",
    "      1  test/c.test.ts",
    "           1  herdr session list",
  ]);
});
