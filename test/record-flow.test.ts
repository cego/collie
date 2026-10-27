// A record builds its Task's Flow on every change while it is open, so the Flow reads
// only what its Task needs: every agent's delivery ledger only where a Run may be Reopened.

import { expect, test } from "bun:test";
import { Effect, FileSystem, Tracer } from "effect";
import { taskFlowOf } from "../src/board";
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

test("a running Run's Flow reads no agent's delivery ledger", () =>
  spansOfFlow({ state: "running" }).then((names) =>
    expect(names).not.toContain("Steering.everyDelivery"),
  ));

test("a finished Run's Flow reads the ledgers that say whether it was Reopened", () =>
  spansOfFlow({ state: "succeeded", finished: "2026-09-14T10:00:00Z" }).then((names) =>
    expect(names).toContain("Steering.everyDelivery"),
  ));
