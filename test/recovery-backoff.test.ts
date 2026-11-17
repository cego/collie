import { Herdr } from "../src/herdr";
import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { ConfigProvider, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import type { RunView } from "../src/engine";
import type { ParkCause } from "../src/park-cause";
import { recoverParks } from "../src/park-recovery";
import { readMetrics } from "../src/metrics";
import { mrId } from "../src/board-model";
import type { MrPanels } from "../src/merges";
import { forgeHttpLayer } from "../src/forge/http";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";
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
          herdr: new Herdr(env),
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

/** How often a park on `cause` is rechecked by 90 s and by 100 s, under a forge reset at 90 s. */
const rechecksUnderRateLimit = (cause: ParkCause) =>
  Effect.gen(function* () {
    const rig = yield* Rig.scoped();
    const env = rig.pluginEnv();
    const mr = "https://gitlab.example.com/mk/project/-/merge_requests/7";
    const panels: MrPanels = new Map([
      [
        mrId(mr)!,
        {
          at: 0,
          panel: {
            _tag: "Unavailable",
            reason: "gitlab.example.com answered 429: rate limited, until 1970-01-01T00:01:30.000Z",
          },
        },
      ],
    ]);
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
      created: "1970-01-01T00:00:00.000Z",
      status: { status: "suspended" },
      waiting: [],
      controls: [],
      diagnostic: null,
      parked: "job absent",
      park: {
        id: "p1",
        since: "1970-01-01T00:00:00.000Z",
        cause,
        kind: "rechecks",
      },
      awaiting: null,
      mr,
      landing: null,
    };
    yield* Effect.forkScoped(
      recoverParks({
        env,
        herdr: new Herdr(env),
        reconnects: Effect.succeed(0),
        panels,
        views: Effect.succeed([view]),
        resume: () => Effect.die("an absent CI job must not resume"),
      }).pipe(
        Effect.provide(
          ConfigProvider.layerAdd(
            ConfigProvider.fromUnknown({ COLLIE_RECOVERY_EVERY: "10 seconds" }),
          ),
        ),
      ),
    );
    const rechecks = readMetrics(`${env.stateDir}/evidence/r1`).pipe(
      Effect.map((lines) => Arr.filter(lines, (line) => line.action === "rechecked").length),
    );
    /** Lets each round do its file IO, which the test clock does not drive. */
    const settle = Effect.gen(function* () {
      for (let tries = 0; tries < 50; tries++) yield* TestClock.withLive(Effect.sleep("2 millis"));
    });
    for (let at = 10; at <= 90; at += 10) {
      yield* TestClock.adjust("10 seconds");
      yield* settle;
    }
    const byReset = yield* rechecks;
    yield* TestClock.adjust("10 seconds");
    yield* settle;
    return [byReset, yield* rechecks];
  }).pipe(Effect.provide(Layer.merge(forgeHttpLayer, TestClock.layer())));

test("a forge rate limit with a reset is waited out before the park is asked about again", () =>
  runEffect(
    Effect.map(rechecksUnderRateLimit("ci-job-absent"), (counts) => expect(counts).toEqual([0, 1])),
  ));

test("a forge rate limit holds no recheck that asks only herdr", () =>
  runEffect(
    Effect.map(rechecksUnderRateLimit("herdr-unavailable"), ([byReset]) =>
      expect(byReset).toBeGreaterThan(0),
    ),
  ));
