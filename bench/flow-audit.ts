// Eighty lanes with about 10 MB of operation history, matching the observed board reads.
import { strict as assert } from "node:assert";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { Console, Effect, FileSystem, Schema } from "effect";
import { AuditLine } from "../src/audit";
import { readEnv } from "../src/env";
import { laneFor } from "../src/flow-read";
import { encodeStepLine, STEPS_FILE } from "../src/steps";
import { runEffect } from "../test/support/effect";
import { madeRun } from "../test/support/records";

await runEffect(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-flow-bench-" });
    const env = readEnv({ HERDR_PLUGIN_STATE_DIR: dir, COLLIE_CWD: "/project" });
    const audit = yield* Schema.encodeEffect(Schema.fromJsonString(AuditLine))({
      at: "2026-09-14T10:00:00Z",
      operation: "stop",
      request: "stop",
      actor: { origin: "cli", requestId: "stop" },
      result: Str.repeat(1000)("x"),
    });
    const runs = [];
    const states = ["running", "waiting", "succeeded", "failed"] as const;
    for (let n = 0; n < 80; n++) {
      const run = yield* madeRun(dir, {
        id: `r-${n}`,
        state: n % 20 === 0 ? "stopped" : states[n % 4],
      });
      yield* fs.writeFileString(`${run.dir}/operations.jsonl`, Str.repeat(128)(`${audit}\n`));
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
      runs.push(run);
    }
    let lanes = 0;
    let stopped = 0;
    for (let round = 0; round < 3; round++)
      for (const run of runs) {
        const lane = yield* laneFor(env, run, undefined, new Map());
        const named = Arr.some(lane.nodes, (node) => node.said === "Stopped by the CLI");
        assert.equal(named, run.state === "stopped");
        assert.equal(lane.nodes.length, 1);
        stopped += Number(named);
        lanes++;
      }
    assert.equal(lanes, 240);
    assert.equal(stopped, 12);
    yield* Console.log(
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({ lanes, stopped }),
    );
  }),
);
