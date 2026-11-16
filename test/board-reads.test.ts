// A board build reads its Runs' records in a fixed number of reads, however many Runs it
// draws, and none of them from files (ADR-draft-a-runs-own-records-are-rows-in-the-hosts-database, D6).
import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { buildBoard } from "../src/board";
import { readEnv } from "../src/env";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import {
  AWAITED,
  LEGACY_CONTROLS,
  LEGACY_FACT_PREFIXES,
  LEGACY_FACTS,
  LEGACY_JOURNALS,
  NOTIFIED,
  parentOf,
  RunRecords,
  type RunRecordsApi,
} from "../src/run-records";
import { epochMs } from "../src/time";
import { Launches } from "../src/launches";
import { Deliveries } from "../src/steering";
import { appendVerification, verificationsPath } from "../src/verify";
import { madeRun } from "./support/records";
import { runEffect } from "./support/effect";

/** `records` with every read of it counted. */
const counted = (records: RunRecordsApi, calls: { n: number }): RunRecordsApi => {
  const count = <A>(read: A) => {
    calls.n++;
    return read;
  };
  return {
    ...records,
    lines: (run, journal) => count(records.lines(run, journal)),
    linesOf: (runs, journal) => count(records.linesOf(runs, journal)),
    briefsOf: (runs, journal) => count(records.briefsOf(runs, journal)),
    lastOf: (runs, journal, kinds) => count(records.lastOf(runs, journal, kinds)),
    fact: (run, name) => count(records.fact(run, name)),
    factsOf: (runs, name) => count(records.factsOf(runs, name)),
    factsUnder: (run, prefix) => count(records.factsUnder(run, prefix)),
    activity: (runs) => count(records.activity(runs)),
    control: (control, run, key) => count(records.control(control, run, key)),
    controlsOf: (control, run) => count(records.controlsOf(control, run)),
    everyControl: (control) => count(records.everyControl(control)),
    controlsIn: (runs) => count(records.controlsIn(runs)),
  };
};

const readsFor = (runs: number) =>
  Effect.gen(function* () {
    const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
      prefix: "collie-board-reads-",
    });
    const records = yield* RunRecords;
    const made = [];
    for (let n = 0; n < runs; n++) {
      const run = yield* madeRun(dir, {
        id: `r${runs}-${n}`,
        task: `t${runs}-${n}`,
        state: "failed",
        created: "2026-09-13T08:00:00Z",
        finished: "2026-09-13T09:00:00Z",
      });
      yield* records.append(run.id, "steps.jsonl", [
        '{"kind":"entered","step":"build","at":"2026-09-13T08:01:00Z"}',
      ]);
      yield* records.put(run.id, "step-steering.json", '{"notes":[]}');
      made.push(run);
    }
    const calls = { n: 0 };
    const launches = yield* Launches;
    const deliveries = yield* Deliveries;
    const views = yield* buildBoard({
      env: readEnv({ HERDR_PLUGIN_STATE_DIR: dir, COLLIE_CWD: "/project" }),
      runs: made,
      tasks: [],
      registered: [],
      proposals: [],
      mrStates: new Map(),
      offers: () => Effect.succeed([]),
      now: epochMs("2026-09-13T10:00:00Z"),
    }).pipe(
      Effect.provideService(RunRecords, counted(records, calls)),
      Effect.provideService(Launches, {
        ...launches,
        of: (runs) => {
          calls.n++;
          return launches.of(runs);
        },
        recordsOf: (runs) => {
          calls.n++;
          return launches.recordsOf(runs);
        },
        lastOrderedOf: (runs) => {
          calls.n++;
          return launches.lastOrderedOf(runs);
        },
        lastOrdered: (run) => {
          calls.n++;
          return launches.lastOrdered(run);
        },
      }),
      Effect.provideService(Deliveries, {
        ...deliveries,
        ofRun: (run) => {
          calls.n++;
          return deliveries.ofRun(run);
        },
        newestOf: (runs) => {
          calls.n++;
          return deliveries.newestOf(runs);
        },
      }),
    );
    return { cards: views.length, reads: calls.n };
  }).pipe(Effect.scoped);

test("a board build reads its Runs' records in as many reads for five Runs as for two", () =>
  runEffect(
    Effect.gen(function* () {
      const two = yield* readsFor(2);
      const five = yield* readsFor(5);
      expect([two.cards, five.cards]).toEqual([2, 5]);
      expect(five.reads).toBe(two.reads);
    }),
  ));

/** Where an older build kept `run`'s records, each by its exact path or, ending `/`, under it. */
const recordPlaces = (dir: string, run: string) => [
  `${dir}/runs/${run}`,
  `${dir}/evidence/${run}`,
  `${dir}/agents/${run}`,
  ...Arr.map([...LEGACY_JOURNALS, ...LEGACY_FACTS], (name) =>
    Str.startsWith("evidence/")(name)
      ? `${dir}/evidence/${run}/${Str.slice("evidence/".length)(name)}`
      : `${dir}/runs/${run}/${name}`,
  ),
  ...Arr.flatMap(LEGACY_FACT_PREFIXES, (prefix) => [
    `${dir}/runs/${run}/${prefix}`,
    `${dir}/runs/${run}/${parentOf(prefix)}`,
  ]),
  ...Arr.map([...LEGACY_CONTROLS, NOTIFIED, AWAITED], (control) => `${dir}/${control}.${run}`),
  `${dir}/relaunch/${run}/`,
  `${dir}/running-checks/`,
];

test("a board build touches no file or directory an older build kept a Run's records in", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-board-io-" });
      const runs = [];
      for (const id of ["r1", "r2", "r3"])
        runs.push(
          yield* madeRun(dir, {
            id,
            task: `t-${id}`,
            state: id === "r1" ? "running" : "succeeded",
            created: "2026-09-13T08:00:00Z",
            finished: id === "r1" ? null : "2026-09-13T09:00:00Z",
          }),
        );
      const touched: string[] = [];
      const noted =
        <A extends ReadonlyArray<unknown>, B>(use: (path: string, ...rest: A) => B) =>
        (path: string, ...rest: A) => {
          touched.push(path);
          return use(path, ...rest);
        };
      const watched: FileSystem.FileSystem = {
        ...fs,
        readFileString: noted(fs.readFileString),
        readFile: noted(fs.readFile),
        readDirectory: noted(fs.readDirectory),
        stat: noted(fs.stat),
        exists: noted(fs.exists),
        access: noted(fs.access),
      };
      yield* buildBoard({
        env: readEnv({ HERDR_PLUGIN_STATE_DIR: dir, COLLIE_CWD: "/project" }),
        runs,
        tasks: [],
        registered: [],
        proposals: [],
        mrStates: new Map(),
        offers: () => Effect.succeed([]),
        now: epochMs("2026-09-13T10:00:00Z"),
      }).pipe(Effect.provideService(FileSystem.FileSystem, watched));
      const places = Arr.flatMap(runs, (run) => recordPlaces(dir, run.id));
      expect(
        Arr.filter(touched, (path) =>
          Arr.some(places, (place) =>
            Str.endsWith("/")(place) ? Str.startsWith(place)(`${path}/`) : path === place,
          ),
        ),
      ).toEqual([]);
    }).pipe(Effect.scoped),
  ));

test("a board build reads what each verification says of its Step, never the verifications whole", () =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "collie-board-proofs-",
      });
      const records = yield* RunRecords;
      const run = yield* madeRun(dir, {
        id: "r1",
        task: "t1",
        state: "failed",
        created: "2026-09-13T08:00:00Z",
        finished: "2026-09-13T09:00:00Z",
      });
      yield* records.append(run.id, "steps.jsonl", [
        '{"kind":"enter","key":"build","step":{"id":"build","title":"","description":"","kind":"agent","role":null,"produces":null},"place":null,"at":"2026-09-13T08:01:00Z"}',
      ]);
      yield* appendVerification(run.evidence, {
        id: "v1",
        run: run.id,
        name: "test",
        executable: "/usr/bin/false",
        argv: [],
        cwd: "/project",
        start: { head_sha: "h", fingerprint: "f" },
        end: { head_sha: "h", fingerprint: "f" },
        exit: 1,
        seconds: 1,
        expect: "pass",
        tail: { stdout: "", stderr: "it broke" },
        result: "fail",
        at: "2026-09-13T08:30:00Z",
        by: "collie",
        step: "build",
      });
      const whole: string[] = [];
      yield* buildBoard({
        env: readEnv({ HERDR_PLUGIN_STATE_DIR: dir, COLLIE_CWD: "/project" }),
        runs: [run],
        tasks: [],
        registered: [],
        proposals: [],
        mrStates: new Map(),
        offers: () => Effect.succeed([]),
        now: epochMs("2026-09-13T10:00:00Z"),
      }).pipe(
        Effect.provideService(RunRecords, {
          ...records,
          lines: (one, journal) => {
            whole.push(journal);
            return records.lines(one, journal);
          },
          linesOf: (some, journal) => {
            whole.push(journal);
            return records.linesOf(some, journal);
          },
        }),
      );
      expect(whole).not.toContain(verificationsPath(run.evidence).name);
    }).pipe(Effect.scoped),
  ));
