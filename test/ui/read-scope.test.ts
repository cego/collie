// A Task board reads the host's Task board. The older workspace lists are not another
// source of truth to rebuild whenever a Task changes.

import { afterEach, beforeEach, expect, test } from "bun:test";
import * as Arr from "effect/Array";
import { Effect } from "effect";
import { appState, type ControlSession } from "../../src/flows";
import { Herdr } from "../../src/herdr";
import { scopeFor } from "../../src/registry";
import type { RunFacts } from "../../src/runs";
import type { RunDetail } from "../../src/board-model";
import { appendCard, type Card } from "../../src/cards";
import type { ProposalLine, ProposalRecord } from "../../src/proposals";
import type { DetailKey } from "../../src/lifecycle";
import { Rig } from "../support/recorder";
import { runEffect } from "../support/effect";
import { installBaseline } from "../support/engine";
import { madeRun } from "../support/records";
import { task } from "../support/task";
import { focus } from "../support/focus";
import { runDetail } from "../support/run-detail";

let rig: Rig;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      yield* installBaseline(rig);
    }),
  ),
);
afterEach(() => runEffect(rig.close()));

function readers(runs: ReadonlyArray<RunFacts> = [], lines: ReadonlyArray<ProposalLine> = []) {
  const env = rig.pluginEnv();
  const reads = { runs: 0, records: 0, agents: 0, workspaces: 0, tasks: 0, usage: 0 };
  const details: Array<DetailKey | null> = [];
  let tasks = [task()];
  let detail: RunDetail | null = null;
  const herdr = new Herdr(env);
  herdr.agentList = () =>
    Effect.sync(() => {
      reads.agents++;
      return [];
    });
  herdr.workspaceList = () =>
    Effect.sync(() => {
      reads.workspaces++;
      return [];
    });
  const session: ControlSession = {
    herdr,
    ...scopeFor(env, env.cwd),
    stateDir: env.stateDir,
    userDir: env.userDir,
    pluginRoot: env.pluginRoot,
    runsOf: () =>
      Effect.sync(() => {
        reads.runs++;
        return runs;
      }),
    recordsOf: () =>
      Effect.sync(() => {
        reads.records++;
        return { tasks: [], registered: [] };
      }),
    tasksOf: () =>
      Effect.sync(() => {
        reads.tasks++;
        return { tasks, unreadable: null };
      }),
    usageOf: () =>
      Effect.sync(() => {
        reads.usage++;
        return [];
      }),
    detailOf: (key) =>
      Effect.sync(() => {
        details.push(key);
        return key === null ? null : detail;
      }),
    ledgers: {
      overridden: Effect.succeed(new Set()),
      deliveriesOf: () => Effect.succeed([]),
      proposals: () => Effect.succeed(lines),
    },
  };
  return {
    app: appState(session, env),
    reads,
    details,
    setTasks: (next: typeof tasks) => {
      tasks = next;
    },
    setDetail: (next: RunDetail) => {
      detail = next;
    },
  };
}

test("Task, Settings and Workflows refreshes do not rebuild the workspace lists", () =>
  runEffect(
    Effect.gen(function* () {
      for (const view of ["runs", "settings", "workflows"] as const) {
        const r = readers([], [proposal("herd", [])]);
        const at = focus({ view, shown: ["runs", view], filter: { kind: "all" } });
        const first = yield* r.app.load(at);
        expect(first.tasks[0]?.name).toBe("Strapi prod seeder");
        r.setTasks([task({ name: "The host's latest name" })]);
        const next = yield* r.app.load({ ...at, nonce: 1 });
        expect(next.tasks[0]?.name).toBe("The host's latest name");
        if (view === "runs")
          expect(Arr.map(next.live?.proposals ?? [], (one) => one.id)).toEqual(["herd"]);
        if (view === "settings") expect(next.settings).not.toBeNull();
        if (view === "workflows") expect(next.definitions).not.toBeNull();
        expect(r.reads).toEqual({
          runs: 0,
          records: 0,
          agents: 0,
          workspaces: 0,
          tasks: 2,
          usage: 2,
        });
      }
    }),
  ));

test("History alone reads the full Run list, and later reads include newly finished Runs", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();
      const runs = [
        yield* madeRun(env.stateDir, {
          id: "old",
          project: env.cwd,
          cwd: env.cwd,
          state: "succeeded",
        }),
      ];
      const r = readers(runs);
      yield* r.app.load(focus());
      const at = focus({ view: "history", shown: ["runs", "history"] });
      const opened = yield* r.app.load(at);
      expect(Arr.map(opened.history ?? [], (row) => row.id)).toEqual(["old"]);
      expect(r.reads.runs).toBe(1);

      runs.unshift(
        yield* madeRun(env.stateDir, {
          id: "new",
          project: env.cwd,
          cwd: env.cwd,
          state: "succeeded",
          created: "2026-09-15T10:00:00Z",
        }),
      );
      const refreshed = yield* r.app.load({ ...at, nonce: 1 });
      expect(Arr.map(refreshed.history ?? [], (row) => row.id)).toEqual(["new", "old"]);
      expect(r.reads.runs).toBe(2);
      expect([r.reads.records, r.reads.agents, r.reads.workspaces]).toEqual([0, 0, 0]);
    }),
  ));

const proposal = (id: string, targets: ProposalRecord["targets"]): ProposalRecord => ({
  kind: "proposal",
  id,
  content_hash: id,
  interpretation: id,
  targets,
  actions: [{ kind: "upgrade" }],
  allowed_now: [],
  created_at: "2026-01-01T00:00:00Z",
  expires_at: "2099-01-01T00:00:00Z",
  intent_versions: {},
  by: "chat:test",
  state: "pending",
});

test("opening one Run reads its own live evidence and keeps Herd proposals without listing Runs", () =>
  runEffect(
    Effect.gen(function* () {
      const env = rig.pluginEnv();
      const run = yield* madeRun(env.stateDir, { id: "selected", project: env.cwd, cwd: env.cwd });
      const card: Card = {
        id: "selected-card",
        run: run.id,
        kind: "slice",
        at: run.created,
        step: "build",
        iteration: 1,
        intent_version: 1,
        revision: { branch: "main", head_sha: "abc1234", fingerprint: "f1", dirty: false },
        changes: { files: [], commits: [] },
        requested: { goal: "read this Run", constraints: [] },
        readiness: "inspect-ready",
        verifications: [],
        claims: [],
        missing: [],
        inspect: [],
        links: {},
        drift: [],
        deliveries: [],
        narrative: null,
        aligned: "unverified",
        cross_run: "none",
        significance: "try-it",
      };
      yield* appendCard(run.dir, card);
      const r = readers([run], [proposal("herd", []), proposal("own", [{ run: run.id }])]);
      const detail = runDetail({ id: run.id, dir: run.dir });
      r.setDetail(detail);
      const state = yield* r.app.load(focus({ selected: `run:${run.id}` }));
      expect(state.detail).toEqual(detail);
      expect(r.details[0]?.runId).toBe(run.id);
      expect(state.live?.run).toBe(run.id);
      expect(Arr.map(state.live?.cards ?? [], (one) => one.id)).toEqual([card.id]);
      expect(Arr.map(state.live?.proposals ?? [], (one) => one.id)).toEqual(["own", "herd"]);
      expect([r.reads.runs, r.reads.records, r.reads.agents, r.reads.workspaces]).toEqual([
        0, 0, 0, 0,
      ]);
    }),
  ));
