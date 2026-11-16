// A board build reads its Runs' records in a fixed number of reads, however many Runs it
// draws (ADR-draft-a-runs-own-records-are-rows-in-the-hosts-database, D6).
import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { buildBoard } from "../src/board";
import { readEnv } from "../src/env";
import { RunRecords, type RunRecordsApi } from "../src/run-records";
import { epochMs } from "../src/time";
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
      });
      yield* records.append(run.id, "steps.jsonl", [
        '{"kind":"entered","step":"build","at":"2026-09-13T08:01:00Z"}',
      ]);
      yield* records.put(run.id, "step-steering.json", '{"notes":[]}');
      made.push(run);
    }
    const calls = { n: 0 };
    const views = yield* buildBoard({
      env: readEnv({ HERDR_PLUGIN_STATE_DIR: dir, COLLIE_CWD: "/project" }),
      runs: made,
      tasks: [],
      registered: [],
      proposals: [],
      mrStates: new Map(),
      offers: () => Effect.succeed([]),
      now: epochMs("2026-09-13T10:00:00Z"),
    }).pipe(Effect.provideService(RunRecords, counted(records, calls)));
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
