import { Herdr } from "../src/herdr";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { expect, test } from "bun:test";
import { Clock, ConfigProvider, Effect, FileSystem, Layer } from "effect";
import { TestClock } from "effect/testing";
import type { RunView } from "../src/engine";
import type { ParkCause } from "../src/park-cause";
import { recoverParks } from "../src/park-recovery";
import { readMetrics } from "../src/metrics";
import type { RunRecords } from "../src/run-records";
import { mrId } from "../src/board-model";
import type { MrPanels } from "../src/merges";
import { forgeHttpLayer } from "../src/forge/http";
import { rememberCiTarget } from "../src/park-recheck";
import { newsPath, read as readNews } from "../src/news";
import { herdOf } from "../src/steering";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";
import { until } from "./support/host";
import { platformLayer } from "../src/platform";
import { FakeBin } from "./support/bin";
import { FORGE_HOST, forgeOnPath, serveForges } from "./support/forge";
import type { ForgeModel } from "./support/forge";

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
    const settle = Effect.gen(function* () {
      for (let tries = 0; tries < 50; tries++) {
        yield* TestClock.withLive(Effect.sleep("2 millis"));
      }
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

const rechecksAgainst = (fault: ForgeModel["httpFault"]) =>
  Effect.gen(function* () {
    const rig = yield* Rig.scoped();
    const env = rig.pluginEnv();
    const bin = yield* Effect.acquireRelease(FakeBin.make(`${rig.root}/bin`), (one) =>
      one.restore(),
    );
    const head = "4f5a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6";
    const model: ForgeModel = {
      installed: true,
      loggedIn: [FORGE_HOST.gitlab],
      login: "tester",
      mrs: [
        {
          project: "gitlab.example.com/mk/project",
          iid: "7",
          state: "open",
          head,
          jobs: [{ name: "test", state: "passed" }],
        },
      ],
      httpFault: fault,
    };
    const forge = yield* forgeOnPath(bin, "gitlab", model);
    const forgeApi = yield* serveForges(forge);
    const mr = "https://gitlab.example.com/mk/project/-/merge_requests/7";
    yield* rememberCiTarget(`${env.stateDir}/runs/r1`, {
      head,
      job: "test",
      mr,
      cwd: rig.projectDir,
    });
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
        cause: "ci-job-absent",
        kind: "rechecks",
      },
      awaiting: null,
      mr,
      landing: null,
    };
    const clock = yield* TestClock.make();
    yield* clock.setTime(yield* Clock.currentTimeMillis);
    return yield* Effect.gen(function* () {
      yield* Effect.forkScoped(
        recoverParks({
          env,
          herdr: new Herdr(env),
          reconnects: Effect.succeed(0),
          panels: new Map(),
          views: Effect.succeed([view]),
          resume: () => Effect.die("an absent CI job must not resume"),
        }).pipe(
          Effect.provide(
            ConfigProvider.layerAdd(
              ConfigProvider.fromUnknown({ COLLIE_RECOVERY_EVERY: "10 millis" }),
            ),
          ),
        ),
      );
      const errors = Effect.map(readMetrics(`${env.stateDir}/evidence/r1`), (lines) =>
        Arr.filter(lines, (line) => line.action === "rechecked" && line.outcome === "error"),
      );
      const settle = Effect.gen(function* () {
        for (let tries = 0; tries < 50; tries++) {
          yield* TestClock.withLive(Effect.sleep("2 millis"));
        }
      });
      let rounds = 0;
      for (let tries = 0; tries < 60 && rounds < 3; tries++) {
        yield* clock.adjust("10 seconds");
        yield* settle;
        rounds = (yield* errors).length;
      }
      const key = yield* herdOf(env.raw.HC_SOCKET ?? null);
      const failing = Effect.map(readNews(yield* newsPath(env.stateDir, key)), (news) =>
        Arr.filter(
          news,
          (line) => line.kind === "item" && Str.startsWith("recovery-failing:")(line.key),
        ),
      );
      let items = yield* failing;
      for (let tries = 0; tries < 100 && items.length === 0; tries++) {
        yield* TestClock.withLive(Effect.sleep("10 millis"));
        items = yield* failing;
      }
      return { rounds, items };
    }).pipe(
      Effect.provideService(Clock.Clock, clock),
      Effect.provide(
        Layer.merge(
          forgeHttpLayer.pipe(
            Layer.provideMerge(platformLayer),
            Layer.provideMerge(
              ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ COLLIE_FORGE_API: forgeApi })),
            ),
          ),
          TestClock.layer(),
        ),
      ),
    );
  });

test("a settled CI park cleared while recovery is off is resumed once it is turned on, and not again for the same reads", () =>
  runEffect(
    Effect.gen(function* () {
      const rig = yield* Rig.scoped();
      const env = rig.pluginEnv();
      const bin = yield* Effect.acquireRelease(FakeBin.make(`${rig.root}/bin`), (one) =>
        one.restore(),
      );
      const head = "4f5a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6";
      const forge = yield* forgeOnPath(bin, "gitlab", {
        installed: true,
        loggedIn: [FORGE_HOST.gitlab],
        login: "tester",
        mrs: [
          {
            project: "gitlab.example.com/mk/project",
            iid: "7",
            state: "open",
            head,
            jobs: [{ name: "test", state: "cancelled", id: 1 }],
          },
        ],
      });
      const forgeApi = yield* serveForges(forge);
      const mr = "https://gitlab.example.com/mk/project/-/merge_requests/7";
      yield* rememberCiTarget(`${env.stateDir}/runs/r1`, {
        head,
        job: "test",
        mr,
        cwd: rig.projectDir,
      });
      const files = yield* FileSystem.FileSystem;
      const settings = (resume: boolean) =>
        files
          .writeFileString(
            `${env.userDir}/config.json.next`,
            `{"memory_hold":0,"recovery":{"resume":${resume}}}`,
          )
          .pipe(
            Effect.andThen(
              files.rename(`${env.userDir}/config.json.next`, `${env.userDir}/config.json`),
            ),
          );
      yield* settings(false);
      yield* Effect.gen(function* () {
        let resumed = 0;
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
            cause: "ci-job-absent",
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
            panels: new Map(),
            views: Effect.succeed([view]),
            resume: () =>
              Effect.sync(() => {
                resumed += 1;
                return { applied: true };
              }),
          }).pipe(
            Effect.provide(
              ConfigProvider.layerAdd(
                ConfigProvider.fromUnknown({ COLLIE_RECOVERY_EVERY: "10 millis" }),
              ),
            ),
          ),
        );
        const rechecks = (outcome: "cleared" | "uncleared") =>
          Effect.map(readMetrics(`${env.stateDir}/evidence/r1`), (lines) =>
            Arr.filter(lines, (line) => line.action === "rechecked" && line.outcome === outcome),
          );
        const settles = (done: Effect.Effect<boolean, never, RunRecords>) =>
          Effect.gen(function* () {
            for (let tries = 0; tries < 500 && !(yield* done); tries++) {
              yield* Effect.sleep("10 millis");
            }
          });
        yield* settles(Effect.map(rechecks("cleared"), (lines) => lines.length > 0));
        expect(resumed).toBe(0);
        yield* settings(true);
        yield* settles(Effect.sync(() => resumed > 0));
        expect(resumed).toBe(1);
        yield* settles(Effect.map(rechecks("uncleared"), (lines) => lines.length > 0));
        expect(resumed).toBe(1);
      }).pipe(
        Effect.provide(
          forgeHttpLayer.pipe(
            Layer.provideMerge(platformLayer),
            Layer.provideMerge(
              ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ COLLIE_FORGE_API: forgeApi })),
            ),
          ),
        ),
      );
    }),
  ));

test("three recheck rounds the forge answers rate-limited raise no Recovery is failing News item", () =>
  runEffect(
    Effect.map(
      rechecksAgainst({ status: 429, headers: { "retry-after": "0" } }),
      ({ rounds, items }) => {
        expect(rounds).toBeGreaterThanOrEqual(3);
        expect(items).toEqual([]);
      },
    ),
  ));

test("three recheck rounds that fail for another reason still raise one Recovery is failing News item", () =>
  runEffect(
    Effect.map(rechecksAgainst({ status: 503 }), ({ rounds, items }) => {
      expect(rounds).toBeGreaterThanOrEqual(3);
      expect(items).toHaveLength(1);
    }),
  ));
