// A record builds its Task's Flow on every change while it is open, so the Flow reads
// only what its Task needs: a Run's deliveries only where it may be Reopened.

import { expect, test } from "bun:test";
import * as Arr from "effect/Array";
import { Effect, FileSystem, Schema, Tracer } from "effect";
import { buildBoard, taskFlowOf } from "../src/board";
import { recordAudit } from "../src/audit";
import { laneFor } from "../src/flow-read";
import { encodeStepLine, STEPS_FILE } from "../src/steps";
import { readEnv } from "../src/env";
import type { RunFacts } from "../src/runs";
import { runEffect } from "./support/effect";
import { madeRun } from "./support/records";

const spansOfFlow = (over: Partial<RunFacts>) =>
  runEffect(
    Effect.gen(function* () {
      const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "collie-record-flow-",
      });
      const env = readEnv({ HERDR_PLUGIN_STATE_DIR: dir, COLLIE_CWD: "/project" });
      const run = yield* madeRun(dir, { id: "r-build", task: "task-1", ...over });
      const names = new Set<string>();
      const tracer = Tracer.make({
        span: (options) => {
          names.add(options.name);
          return new Tracer.NativeSpan(options);
        },
      });
      const flow = yield* taskFlowOf(
        { env, runs: [run], tasks: [], registered: [], proposals: [], mrStates: new Map() },
        run.id,
      ).pipe(Effect.withTracer(tracer));
      expect(flow).not.toBeNull();
      return names;
    }),
  );

test("a running Run's Flow reads none of its deliveries", () =>
  spansOfFlow({ state: "running" }).then((names) =>
    expect(names).not.toContain("Steering.deliveriesOf"),
  ));

test("a finished Run's Flow reads the deliveries that say whether it was Reopened", () =>
  spansOfFlow({ state: "succeeded", finished: "2026-09-14T10:00:00Z" }).then((names) =>
    expect(names).toContain("Steering.deliveriesOf"),
  ));

test("a lane reads stop attribution only while its Run is stopped", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-flow-audit-" });
      const env = readEnv({ HERDR_PLUGIN_STATE_DIR: dir, COLLIE_CWD: "/project" });
      const run = yield* madeRun(dir);
      yield* fs.writeFileString(
        `${run.dir}/${STEPS_FILE}`,
        encodeStepLine({
          kind: "enter",
          key: "work",
          at: "2026-09-14T10:00:00Z",
          place: null,
          step: {
            id: "work",
            title: "Work",
            description: "",
            kind: "check",
            role: null,
            produces: null,
          },
        }),
      );
      yield* recordAudit(run.dir, {
        operation: "stop",
        request: "stop",
        origin: "cli",
        result: Schema.String,
        value: "stopped",
      });
      for (const state of ["running", "waiting", "succeeded", "failed", "stopped"] as const) {
        let reads = 0;
        const lane = yield* laneFor(env, { ...run, state }, undefined, new Map()).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fs,
            readFileString: (path, encoding) => {
              if (path === `${run.dir}/operations.jsonl`) reads++;
              return fs.readFileString(path, encoding);
            },
          }),
        );
        expect(reads).toBe(state === "stopped" ? 1 : 0);
        expect(Arr.some(lane.nodes, (node) => node.said === "Stopped by the CLI")).toBe(
          state === "stopped",
        );
      }
    }),
  ));

test("two Tasks share one reading of the installation and step duration index", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-flow-inputs-" });
      const env = readEnv({ HERDR_PLUGIN_STATE_DIR: dir, COLLIE_CWD: "/project" });
      const runs = [
        yield* madeRun(dir, { id: "first", task: "task-a", state: "running" }),
        yield* madeRun(dir, { id: "second", task: "task-b", state: "running" }),
      ];
      const reads: string[] = [];
      const views = yield* buildBoard({
        env,
        runs,
        tasks: [],
        registered: [],
        proposals: [],
        mrStates: new Map(),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          readFileString: (path, encoding) =>
            Effect.sync(() => reads.push(path)).pipe(
              Effect.andThen(fs.readFileString(path, encoding)),
            ),
        }),
      );
      expect(views).toHaveLength(2);
      expect(Arr.filter(reads, (path) => path === `${dir}/installation`)).toHaveLength(1);
      expect(Arr.filter(reads, (path) => path === `${dir}/step-durations.json`)).toHaveLength(1);
    }),
  ));
