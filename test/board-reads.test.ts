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

/** `records` with every call to it counted. */
const counted = (records: RunRecordsApi, calls: { n: number }): RunRecordsApi =>
  new Proxy(records, {
    get: (target, name) => {
      const value = Reflect.get(target, name);
      return typeof value === "function"
        ? (...args: ReadonlyArray<unknown>) => {
            calls.n++;
            return Reflect.apply(value, target, args);
          }
        : value;
    },
  });

const readsFor = (runs: number) =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "collie-board-reads-",
      });
      const records = yield* RunRecords;
      const made = [];
      for (let n = 0; n < runs; n++) {
        const run = yield* madeRun(dir, {
          id: `r${n}`,
          task: `t${n}`,
          state: "failed",
          created: "2026-09-13T08:00:00Z",
        });
        yield* records.append(run.id, "steps.jsonl", [
          JSON.stringify({ kind: "entered", step: "build", at: "2026-09-13T08:01:00Z" }),
        ]);
        yield* records.put(run.id, "step-steering.json", JSON.stringify({ notes: [] }));
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
    }),
  );

test("a board build reads its Runs' records in as many reads for five Runs as for two", async () => {
  const two = await readsFor(2);
  const five = await readsFor(5);
  expect([two.cards, five.cards]).toEqual([2, 5]);
  expect(five.reads).toBe(two.reads);
});
