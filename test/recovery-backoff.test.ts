import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { ConfigProvider, Effect } from "effect";
import type { RunView } from "../src/engine";
import { recoverParks } from "../src/park-recovery";
import { readMetrics } from "../src/metrics";
import { mrId } from "../src/board-model";
import type { MrPanels } from "../src/merges";
import { forgeHttpLayer } from "../src/forge/http";
import { runEffect } from "./support/effect";
import { Rig, FakeHerdr } from "./support/recorder";
import { until } from "./support/host";

test("unchanged panel refreshes preserve backoff while changed facts reset it", () =>
  runEffect(
    Effect.gen(function* () {
      const rig = yield* Rig.scoped();
      const env = rig.pluginEnv();
      const mr = "https://gitlab.example.com/mk/project/-/merge_requests/7";
      const panels: MrPanels = new Map();
      const view: RunView = {
        runId: "r1",
        workflow: "any",
        project: rig.projectDir,
        task: null,
        parent: null,
        registration: "any@1",
        entry: "any.workflow.ts",
        input: {},
        provenance: {},
        strategies: {},
        options: {},
        cwd: rig.projectDir,
        branch: "work",
        workspace: null,
        worktree: null,
        outcome: "feature",
        created: "2026-01-01T00:00:00.000Z",
        status: { status: "suspended" },
        waiting: [],
        controls: [],
        diagnostic: null,
        parked: "job absent",
        park: {
          id: "p1",
          since: "2026-01-01T00:00:00.000Z",
          cause: "ci-job-absent",
          kind: "rechecks",
        },
        awaiting: null,
        mr,
        landing: null,
      };
      let refreshes = 0;
      let reason = "unchanged";
      yield* Effect.forkScoped(
        recoverParks({
          env,
          herdr: new FakeHerdr(env),
          reconnects: Effect.succeed(0),
          panels,
          views: Effect.sync(() => {
            panels.set(mrId(mr)!, { at: ++refreshes, panel: { _tag: "Unavailable", reason } });
            return [view];
          }),
          resume: () => Effect.die("an absent CI job must not resume"),
        }).pipe(
          Effect.provide(
            ConfigProvider.layerAdd(
              ConfigProvider.fromUnknown({ COLLIE_RECOVERY_EVERY: "20 millis" }),
            ),
          ),
        ),
      );
      yield* Effect.sleep("1 second");
      const reads = () =>
        readMetrics(`${env.stateDir}/evidence/r1`).pipe(
          Effect.map((lines) => Arr.filter(lines, (line) => line.action === "rechecked")),
        );
      const before = yield* reads();
      expect(refreshes).toBeGreaterThan(10);
      expect(Arr.map(before.slice(0, 4), (line) => line.value)).toEqual([20, 40, 80, 160]);
      reason = "the forge facts changed";
      const after = yield* until(
        reads,
        (lines) => Arr.filter(lines, (line) => line.value === 20).length === 2,
      );
      expect(after.length).toBeGreaterThan(before.length);
    }).pipe(Effect.provide(forgeHttpLayer)),
  ));
