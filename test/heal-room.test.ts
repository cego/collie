import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { ConfigProvider, Effect } from "effect";
import type { RunView } from "../src/engine";
import { foundationLayer } from "../src/engine";
import { Herdr } from "../src/herdr";
import { appendMetric, readMetrics } from "../src/metrics";
import { healParks } from "../src/park-recovery";
import { Host } from "../src/sdk";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";
import { until } from "./support/host";

const repo = new URL("../", import.meta.url).pathname;
const SINCE = "2026-01-01T00:00:00.000Z";

const parkedView: RunView = {
  runId: "r1",
  workflow: "any",
  project: "/tmp/project",
  task: null,
  parent: null,
  registration: "any@1",
  entry: "any.workflow.ts",
  input: {},
  provenance: {},
  strategies: {},
  options: {},
  cwd: "/tmp/project",
  branch: "work",
  workspace: null,
  worktree: null,
  outcome: "feature",
  created: SINCE,
  status: { status: "suspended" },
  waiting: [],
  controls: [],
  diagnostic: null,
  parked: "its agent went quiet for longer than its idle budget",
  park: { id: "p1", since: SINCE, cause: "idle-budget", kind: "needs-you" },
  awaiting: null,
  mr: null,
  landing: null,
};

const healView: RunView = {
  ...parkedView,
  runId: "run-heal",
  status: { status: "pending" },
  parked: null,
  park: null,
  created: "2026-01-01T00:00:01.000Z",
};

const claim = (stateDir: string) =>
  appendMetric(`${stateDir}/evidence/r1`, {
    at: SINCE,
    kind: "recovery",
    subject: "r1",
    note: "its agent went quiet for longer than its idle budget",
    value: 0,
    cause: "idle-budget",
    build: "test",
    action: "healed",
    outcome: "claimed",
    recoveryId: "recover:r1:p1:1",
    park: "p1",
    since: SINCE,
  });

const healLines = (env: ReturnType<Rig["pluginEnv"]>) =>
  Effect.map(readMetrics(`${env.stateDir}/evidence/r1`), (lines) =>
    Arr.filter(lines, (line) => line.action === "healed"),
  );

test("no Heal starts while no harness choice has room, and exactly one starts once one has", () =>
  runEffect(
    Effect.gen(function* () {
      const rig = yield* Rig.scoped();
      const env = rig.pluginEnv({ COLLIE_USER_DIR: repo });
      const placing = { herdr: new Herdr(env), env };
      const starts: Array<string> = [];
      let room = false;
      yield* Effect.gen(function* () {
        yield* claim(rig.stateDir);
        const host = yield* Host;
        yield* Effect.forkScoped(
          healParks({
            env,
            herdr: new Herdr(env),
            views: Effect.succeed([parkedView, healView]),
            start: (_view, _healer, request) =>
              Effect.sync(() => {
                starts.push(request);
                return "run-heal";
              }),
            notify: () => Effect.void,
            hasRoom: Effect.sync(() => room),
            host,
          }).pipe(
            Effect.provide(
              ConfigProvider.layerAdd(
                ConfigProvider.fromUnknown({ COLLIE_RECOVERY_EVERY: "20 millis" }),
              ),
            ),
          ),
        );
        yield* Effect.sleep("200 millis");
        expect(starts).toEqual([]);
        expect(yield* healLines(env)).toEqual([expect.objectContaining({ outcome: "claimed" })]);
        room = true;
        yield* until(
          () => Effect.sync(() => Arr.length(starts)),
          (started) => started > 0,
        );
        yield* Effect.sleep("200 millis");
        expect(starts).toEqual(["recover:r1:p1:1"]);
        expect(yield* healLines(env)).toEqual([
          expect.objectContaining({ outcome: "claimed" }),
          expect.objectContaining({ outcome: "started", heal: "run-heal", park: "p1" }),
        ]);
      }).pipe(Effect.provide(foundationLayer({ dir: rig.stateDir, userDir: repo, placing })));
    }).pipe(Effect.scoped),
  ));
