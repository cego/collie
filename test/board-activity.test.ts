// When a Run last did work, as its host records it and the board reads it
// (ADR-draft-a-runs-own-records-are-rows-in-the-hosts-database, D4).
import { expect, test } from "bun:test";
import { Clock, Effect, FileSystem, Schema } from "effect";
import { TestClock } from "effect/testing";
import { buildBoard } from "../src/board";
import { readEnv } from "../src/env";
import { appendLogLine } from "../src/run-log";
import { recordAudit } from "../src/audit";
import { recordLaunch } from "../src/launches";
import { appendLine } from "../src/steering";
import { RunRecords } from "../src/run-records";
import { epochMs } from "../src/time";
import { madeRun } from "./support/records";
import { runEffect } from "./support/effect";

const scratch = Effect.fn("activity.scratch")(function* () {
  const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
    prefix: "collie-board-activity-",
  });
  return { dir, env: readEnv({ HERDR_PLUGIN_STATE_DIR: dir, COLLIE_CWD: "/project" }) };
});

/** `effect` with the clock at `iso`. */
const at = <A, E, R>(iso: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const clock = yield* TestClock.make();
    yield* clock.setTime(epochMs(iso));
    return yield* effect.pipe(Effect.provideService(Clock.Clock, clock));
  });

const lastWork = (run: string) =>
  RunRecords.use((records) => records.activity([run])).pipe(Effect.map((all) => all.get(run)));

test("a Run ended when it last did work, whatever was written in its directories since", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir, env } = yield* scratch();
      const run = yield* madeRun(dir, { state: "failed" });
      yield* at(
        "2026-09-13T09:00:00Z",
        RunRecords.use((records) => records.touch(run.id)),
      );
      yield* (yield* FileSystem.FileSystem).writeFileString(`${run.dir}/notes.md`, "later");

      const [view] = yield* buildBoard({
        env,
        runs: [run],
        tasks: [],
        registered: [],
        proposals: [],
        mrStates: new Map(),
        now: epochMs("2026-09-13T10:00:00Z"),
      });
      expect(view!.ended).toBe(epochMs("2026-09-13T09:00:00Z"));
    }),
  ));

test("a line in a Run's log is work, and what the host writes about the Run is not", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir } = yield* scratch();
      const run = yield* madeRun(dir, { state: "failed" });
      yield* at("2026-09-13T09:00:00Z", appendLogLine(run.dir, "it built"));
      expect(yield* lastWork(run.id)).toBe(epochMs("2026-09-13T09:00:00Z"));

      yield* at(
        "2026-09-14T09:00:00Z",
        recordAudit(run.dir, {
          operation: "disposition",
          request: "d-1",
          origin: "board",
          result: Schema.String,
          value: "abandoned",
        }),
      );
      expect(yield* lastWork(run.id)).toBe(epochMs("2026-09-13T09:00:00Z"));
    }),
  ));

test("launching a Run's agent and delivering to it are work", () =>
  runEffect(
    Effect.gen(function* () {
      const { dir } = yield* scratch();
      yield* at(
        "2026-09-13T09:00:00Z",
        recordLaunch({
          agent: "r1-build",
          output: `${dir}/agents/r1/build.json`,
          reused: false,
          runId: "r1",
          operation: "build",
          role: "implementer",
          workflow: "implement",
          harness: "claude",
        }),
      );
      expect(yield* lastWork("r1")).toBe(epochMs("2026-09-13T09:00:00Z"));

      yield* at(
        "2026-09-14T09:00:00Z",
        appendLine({
          id: "d-1",
          at: "2026-09-14T09:00:00Z",
          run: "r1",
          incarnation: "term-builder",
          agent: "builder",
          causal_key: "steer:req-1",
          request_id: "req-1",
          cause: { kind: "steer", ref: "req-1" },
          mode: "now",
          text_hash: "h",
          intent_version: 1,
          attempt: 1,
          state: "submitted",
        }),
      );
      expect(yield* lastWork("r1")).toBe(epochMs("2026-09-14T09:00:00Z"));
    }),
  ));
