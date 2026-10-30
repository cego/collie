import * as Order from "effect/Order";
import * as Option from "effect/Option";
import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import type { PlatformServices } from "../src/platform";
import { Effect, FileSystem, Layer, Schema, type Scope, flow, Result } from "effect";
import type { FetchLike } from "forges";
import { forgeHttpTest, type ForgeHttp } from "../src/forge/http";
import { recordAudit } from "../src/audit";
import { buildBoard } from "../src/board";
import { sectionOf } from "../src/board-model";
import { readDispositions, recordDisposition } from "../src/disposition";
import {
  MERGE_POLL_MS,
  readForge,
  readMrStates,
  settleMerges,
  watchedMr,
  writeMrStates,
} from "../src/merges";
import { foundationLayer, runDir } from "../src/engine";
import { Agents, agentsLayer } from "../src/agents";
import { Launched } from "../src/launches";
import { FakeHerdr, Rig } from "./support/recorder";
import type { RunFacts } from "../src/runs";
import { sinceReview } from "../src/mr";
import { appendVerification } from "../src/verify";
import type { Runner } from "../src/mr";
import { readEnv } from "../src/env";
import { madeRun } from "./support/records";
import { task } from "./support/task";
import { runEffect } from "./support/effect";
import { epochMs } from "../src/time";
import { readLanding, writeLanding, type Landing } from "../src/landing";
import { fakeForge, type Check, type FakeMr, type ForgeModel } from "./support/forge";

const GITLAB = "gitlab.cego.dk/mk/collie";
const asLaunch = flow(Schema.encodeResult(Schema.fromJsonString(Launched)), Result.getOrThrow);

/** The fake of each forge `forge` made last, which ForgeHttp asks. */
const latest = new Map<"gitlab" | "github", { readonly run: Runner; readonly fetch: FetchLike }>();

/** The shared fake of a forge, with its calls and requests also kept in `log`. */
function forge(name: "gitlab" | "github", over: Partial<ForgeModel>, log: string[] = []): Runner {
  const fake = fakeForge(name, {
    installed: true,
    loggedIn: [name === "gitlab" ? "gitlab.cego.dk" : "github.com"],
    login: "mk",
    mrs: [],
    ...over,
  });
  const run: Runner = (cmd, args, cwd) =>
    Effect.tap(fake.run(cmd, args, cwd), () => Effect.sync(() => log.push(fake.calls.at(-1)!)));
  latest.set(name, {
    run,
    fetch: (input: string, init?: RequestInit) => {
      log.push(`${init?.method ?? "GET"} ${input}`);
      return fake.fetch(input, init);
    },
  });
  return run;
}

/** ForgeHttp asking the fake of each forge made last. */
const forgeHttp = forgeHttpTest(
  (cmd, args, cwd) => latest.get(cmd === "gh" ? "github" : "gitlab")!.run(cmd, args, cwd),
  (input, init) =>
    latest.get(new URL(input).host === "api.github.com" ? "github" : "gitlab")!.fetch(input, init),
);

/** `runEffect`, with ForgeHttp asking the fake of each forge made last. */
const runWithForge = <A, E>(
  effect: Effect.Effect<A, E, ForgeHttp | Scope.Scope | PlatformServices>,
) => runEffect(effect.pipe(Effect.provide(Layer.fresh(forgeHttp))));

const mr65 = (over: Partial<FakeMr>): FakeMr => ({
  project: GITLAB,
  iid: "65",
  state: "open",
  title: "Cards",
  ...over,
});

/** A GitLab that answers every readiness check and says one thing about its MR. */
const gitlab = (state: FakeMr["state"], log: string[] = []) =>
  forge("gitlab", { mrs: [mr65({ state })] }, log);

const mrUrl = (iid: string) => `https://gitlab.cego.dk/mk/collie/-/merge_requests/${iid}`;
const MR = mrUrl("65");

const seeded = Effect.fn("merges.seeded")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-merges-" });
  const env = readEnv({ HERDR_PLUGIN_STATE_DIR: stateDir, COLLIE_CWD: "/project" });
  const run = yield* madeRun(stateDir, {
    state: "succeeded",
    mr: MR,
    created: "2026-09-17T09:00:00Z",
  });
  return {
    stateDir,
    run,
    board: (over: Omit<Parameters<typeof buildBoard>[0], "env" | "runs"> = {}) =>
      buildBoard({ env, runs: [run], ...over }),
  };
});

test("a merge GitLab reports lands the work: a disposition by gitlab, and the card moves", () =>
  runWithForge(
    Effect.gen(function* () {
      const { stateDir, run, board: boardOf } = yield* seeded();
      const before = yield* boardOf({ mrStates: new Map() });
      expect(before[0]!.sentence).toBe("mk/collie!65 is open; nothing has checked it.");

      const states = new Map();
      yield* settleMerges({
        stateDir,
        cwd: "/project",
        runs: [],
        record: () => Effect.void,
        stop: () => Effect.die("nothing here is stopped"),
        run: gitlab("merged"),
        views: before,
        now: epochMs("2026-09-17T10:00:00Z"),
        checked: new Map(),
        states,
        panels: new Map(),
        making: new Set(),
      });

      const recorded = yield* readDispositions(run.dir);
      expect(Arr.map(recorded, (line) => [line.by, line.kind, line.ref])).toEqual([
        ["gitlab", "merged", "mk/collie!65"],
      ]);
      expect(yield* readMrStates(stateDir)).toEqual(new Map([["mk/collie!65", "merged"]]));
      // Nothing passed in: the CLI's board reads what the pane's watch wrote.
      const after = yield* boardOf({ now: epochMs("2026-09-17T11:00:00Z") });
      expect(after[0]!.landed).toBe(true);
      expect(after[0]!.sentence).toBe("Merged as mk/collie!65.");
    }),
  ));

test("a closed merge request is news, not a verdict, and a fresh answer is not asked for again", () =>
  runWithForge(
    Effect.gen(function* () {
      const { stateDir, run, board: boardOf } = yield* seeded();
      const views = yield* boardOf({ mrStates: new Map() });
      const log: string[] = [];
      const checked = new Map<string, number>();
      const states = new Map();
      const now = epochMs("2026-09-17T10:00:00Z");
      yield* settleMerges({
        stateDir,
        cwd: "/project",
        runs: [],
        record: () => Effect.void,
        stop: () => Effect.die("nothing here is stopped"),
        run: gitlab("closed", log),
        views,
        now,
        checked,
        states,
        panels: new Map(),
        making: new Set(),
      });
      expect(yield* readDispositions(run.dir)).toEqual([]);
      const again = yield* boardOf({ mrStates: states, now });
      expect(again[0]!.sentence).toBe("Merge request mk/collie!65 closed without merging.");
      expect(again[0]!.landed).toBe(false);

      // Two minutes on: nothing is asked, the last answer stands.
      const asked = log.length;
      yield* settleMerges({
        stateDir,
        cwd: "/project",
        runs: [],
        record: () => Effect.void,
        stop: () => Effect.die("nothing here is stopped"),
        run: gitlab("closed", log),
        views,
        now: now + 120_000,
        checked,
        states,
        panels: new Map(),
        making: new Set(),
      });
      expect(log.length).toBe(asked);
    }),
  ));

/** A GitLab whose merge landed and whose deploy jobs have taken it as far as `live` says. */
function deployed(live: { stage: string; prod: string | null }, log: string[] = []): Runner {
  const merged = "35ae2cea5e5848602729dbc0e8a87ed0d9049c46";
  return forge(
    "gitlab",
    {
      mrs: [mr65({ state: "merged", mergedSha: merged })],
      environments: [
        { name: "stage", tier: "staging", deployed: live.stage },
        { name: "prod", tier: "production", deployed: live.prod ?? "0000000" },
        { name: "review/x", tier: "development", deployed: merged },
      ],
      // Only a descendant of the merge commit has it as the merge-base.
      ancestry: { child: [merged] },
    },
    log,
  );
}

test("a merged card follows its deploy jobs: on stage, then in production, then asked no more", () =>
  runWithForge(
    Effect.gen(function* () {
      const { stateDir, run, board: boardOf } = yield* seeded();
      const states = new Map();
      const checked = new Map<string, number>();
      let now = epochMs("2026-09-17T10:00:00Z");
      const settle = (gitlab: Runner, log: string[] = []) =>
        Effect.gen(function* () {
          const current = yield* boardOf({ mrStates: states, now });
          yield* settleMerges({
            stateDir,
            cwd: "/project",
            runs: [],
            record: () => Effect.void,
            stop: () => Effect.die("nothing here is stopped"),
            run: gitlab,
            views: current,
            now,
            checked,
            states,
            panels: new Map(),
            making: new Set(),
          });
          return log;
        });

      // Stage has a child of the merge commit; prod still runs something older.
      yield* settle(deployed({ stage: "child", prod: "0000000" }));
      expect(states.get("mk/collie!65")).toBe("on-stage");
      expect(Arr.map(yield* readDispositions(run.dir), (line) => line.kind)).toEqual(["merged"]);
      let board = yield* boardOf({ now });
      expect(board[0]!.landed).toBe(true);
      expect(board[0]!.sentence).toBe("Merged as mk/collie!65. On stage.");

      // Disposed of, and still followed: production now has the merge commit itself.
      now += 6 * 60_000;
      yield* settle(deployed({ stage: "child", prod: "35ae2cea5e5848602729dbc0e8a87ed0d9049c46" }));
      expect(states.get("mk/collie!65")).toBe("in-prod");
      board = yield* boardOf({ now });
      expect(board[0]!.sentence).toBe("Merged as mk/collie!65. In production.");
      // One merged disposition, not one per round.
      expect(Arr.map(yield* readDispositions(run.dir), (line) => line.kind)).toEqual(["merged"]);

      // In production is as far as it goes: GitLab is not asked about it again.
      now += 6 * 60_000;
      const log: string[] = [];
      yield* settle(deployed({ stage: "child", prod: "child" }, log), log);
      expect(log).toEqual([]);
    }),
  ));

test("what is working is asked about, and what is already disposed of is not", () =>
  runWithForge(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-merges-" });
      const log: string[] = [];
      const merged = (iid: string) => mr65({ iid, state: "merged" });
      yield* settleMerges({
        stateDir,
        cwd: "/project",
        run: forge("gitlab", { mrs: [merged("65"), merged("66"), merged("67")] }, log),
        views: [
          task({ id: "working", state: "active", mr: MR, run: "r-working" }),
          task({ id: "needs-you", state: "blocked", mr: mrUrl("67"), run: "r-needs-you" }),
          task({
            id: "landed",
            state: "done",
            landed: true,
            mr: mrUrl("66"),
            disposition: "superseded mk/collie!66",
          }),
          task({ id: "no-mr", state: "failed" }),
        ],
        runs: [],
        record: () => Effect.die("nothing is found without a Run on the branch"),
        stop: () => Effect.die("nothing here is stopped"),
        now: epochMs("2026-09-17T10:00:00Z"),
        checked: new Map(),
        states: new Map(),
        panels: new Map(),
        making: new Set(),
      });
      // A merge while a Run is busy or parked still lands its Task.
      for (const [run, label] of [
        ["r-working", "mk/collie!65"],
        ["r-needs-you", "mk/collie!67"],
      ] as const)
        expect(
          Arr.map(yield* readDispositions(runDir(stateDir, run)), (line) => [line.by, line.ref]),
        ).toEqual([["gitlab", label]]);
      expect(Arr.filter(log, (call) => /[ /]66\b/.test(call))).toEqual([]);
    }),
  ));

// A merge request opened from a Task's branch by anyone: found, recorded and followed.

const BRANCH = "mk/reused-agent-token-cost";
const REPO = {
  github: { project: "github.com/cego/collie", origin: "git@github.com:cego/collie.git" },
  gitlab: { project: "gitlab.cego.dk/mk/collie", origin: "git@gitlab.cego.dk:mk/collie.git" },
} as const;
const LABEL = { github: "cego/collie#115", gitlab: "mk/collie!115" } as const;
const URL115 = {
  github: "https://github.com/cego/collie/pull/115",
  gitlab: "https://gitlab.cego.dk/mk/collie/-/merge_requests/115",
} as const;

/** #115 from the Task's branch, opened after the Task's first Run. */
const fromBranch = (name: "gitlab" | "github", over: Partial<FakeMr> = {}): FakeMr => ({
  project: REPO[name].project,
  iid: "115",
  state: "open",
  sourceBranch: BRANCH,
  createdAt: "2026-10-15T08:20:00Z",
  head: HEAD,
  ...over,
});

/** A Task on `BRANCH` with no merge request recorded, and rounds of the watch over it. */
const onBranch = Effect.fn("merges.onBranch")(function* (
  name: "gitlab" | "github",
  mrs: ReadonlyArray<FakeMr>,
  over: { run?: Partial<RunFacts>; model?: Partial<ForgeModel> } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-discover-" });
  const env = readEnv({ HERDR_PLUGIN_STATE_DIR: stateDir, COLLIE_CWD: "/project" });
  const made = yield* madeRun(stateDir, {
    id: "r-implement",
    task: "task-1",
    state: "succeeded",
    branch: BRANCH,
    created: "2026-10-15T08:00:00Z",
    finished: "2026-10-15T08:30:00Z",
    ...over.run,
  });
  const log: string[] = [];
  const runner = forge(name, { origin: REPO[name].origin, mrs, ...over.model }, log);
  const recorded = new Map<string, string>();
  const checked = new Map<string, number>();
  const states = new Map();
  const runs = () => [{ ...made, mr: recorded.get(made.id) ?? null }];
  const card = (now: number) =>
    buildBoard({ env, runs: runs(), now, quietMs: Infinity }).pipe(Effect.map((all) => all[0]!));
  const round = Effect.fn("merges.round")(function* (now: number) {
    yield* settleMerges({
      stateDir,
      cwd: "/project",
      run: runner,
      views: yield* buildBoard({ env, runs: runs(), now, quietMs: Infinity }),
      runs: runs(),
      record: (run, url) => Effect.sync(() => void recorded.set(run, url)),
      stop: () => Effect.die("nothing here is stopped"),
      now,
      checked,
      states,
      panels: new Map(),
      making: new Set(),
    });
  });
  return { run: made, log, recorded, card, round };
});

const TEN = epochMs("2026-10-15T10:00:00Z");

test("a merge request opened from a Task's branch by anyone is found, recorded as its Run's, and lands it", () =>
  runWithForge(
    Effect.gen(function* () {
      for (const name of ["github", "gitlab"] as const) {
        const { run, recorded, card, round } = yield* onBranch(name, [
          fromBranch(name, { state: "merged", mergedAt: "2026-10-15T08:40:00Z", mergedSha: HEAD }),
        ]);
        expect((yield* card(TEN)).mr).toBeNull();
        yield* round(TEN);
        expect(recorded).toEqual(new Map([["r-implement", URL115[name]]]));
        expect(
          Arr.map(yield* readDispositions(run.dir), (line) => [line.by, line.kind, line.ref]),
        ).toEqual([[name, "merged", LABEL[name]]]);
        const after = yield* card(TEN);
        expect(after.mr).not.toBeNull();
        expect(after.disposition).toBe(`merged ${LABEL[name]}`);
        expect(after.sentence).toBe(`Merged as ${LABEL[name]}.`);
      }
    }),
  ));

test("a merge request opened from a Task's branch that ended before the Task began is not its", () =>
  runWithForge(
    Effect.gen(function* () {
      const { run, recorded, card, round } = yield* onBranch("github", [
        fromBranch("github", {
          state: "merged",
          createdAt: "2026-10-01T08:00:00Z",
          mergedAt: "2026-10-01T09:00:00Z",
        }),
        fromBranch("github", {
          iid: "116",
          state: "closed",
          createdAt: "2026-10-15T07:00:00Z",
          closedAt: "2026-10-15T07:30:00Z",
        }),
      ]);
      yield* round(TEN);
      expect(recorded).toEqual(new Map());
      expect(yield* readDispositions(run.dir)).toEqual([]);
      expect((yield* card(TEN)).mr).toBeNull();
    }),
  ));

test("a merge request opened from a Task's branch is found in Working and in Needs you, and its checks read", () =>
  runWithForge(
    Effect.gen(function* () {
      const lint = { name: "lint", state: "failed" } as const;
      for (const [over, section] of [
        [{ state: "running", finished: null }, "working"],
        [{ state: "waiting", finished: null }, "needs-you"],
      ] as const) {
        const { recorded, card, round } = yield* onBranch(
          "github",
          [fromBranch("github", { checks: [lint] })],
          { run: over },
        );
        expect(sectionOf(yield* card(TEN))).toBe(section);
        yield* round(TEN);
        expect(recorded).toEqual(new Map([["r-implement", URL115.github]]));
        const after = yield* card(TEN);
        expect(after.mr).not.toBeNull();
        expect(after.mrState).toBe("open");
        expect(after.readiness?.missing).toContainEqual({
          fact: "ci",
          said: "lint failed in CI",
          settling: false,
        });
      }
    }),
  ));

test("a merge request opened from a Task's branch is looked for once a round at most, and a forge that cannot say changes nothing", () =>
  runWithForge(
    Effect.gen(function* () {
      for (const model of [{ installed: false }, { loggedIn: [] }, {}]) {
        const { run, log, recorded, card, round } = yield* onBranch("github", [], { model });
        yield* round(TEN);
        const asked = log.length;
        expect(asked).toBeGreaterThan(0);
        yield* round(TEN + MERGE_POLL_MS - 1);
        expect(log.length).toBe(asked);
        yield* round(TEN + MERGE_POLL_MS);
        expect(log.length).toBeGreaterThan(asked);
        expect(recorded).toEqual(new Map());
        expect(yield* readDispositions(run.dir)).toEqual([]);
        expect((yield* card(TEN)).mr).toBeNull();
      }
    }),
  ));

// A merge settles its Task: what in it is still going, and began before the merge, is stopped.

const MERGED_AT = "2026-10-15T09:00:00Z";

/** A plan Run waiting on its parked builder, whose merge request merged, and rounds of the watch. */
const merging = Effect.fn("merges.merging")(function* (
  others: ReadonlyArray<Partial<RunFacts>> = [],
  mergedAt: string | null = MERGED_AT,
  /** What the host does with a stop, beside recording it. */
  stopping: (stateDir: string, run: string, reason: string) => Effect.Effect<void> = () =>
    Effect.void,
  /** More of the merged merge request, and the Run directories whose attempt is being made. */
  over: { readonly mr?: Partial<FakeMr>; readonly making?: ReadonlySet<string> } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-settle-" });
  const env = readEnv({ HERDR_PLUGIN_STATE_DIR: stateDir, COLLIE_CWD: "/project" });
  const of = (over: Partial<RunFacts>) =>
    madeRun(stateDir, { task: "task-1", created: "2026-10-15T08:00:00Z", ...over });
  let runs = [
    yield* of({ id: "r-plan", workflow: "plan", state: "running" }),
    yield* of({
      id: "r-plan.implement",
      workflow: "implement",
      parent: "r-plan",
      state: "waiting",
      parked: "Cannot open the merge request",
      branch: BRANCH,
      mr: MR,
      created: "2026-10-15T08:10:00Z",
    }),
  ];
  for (const over of others) runs.push(yield* of(over));
  const stops: Array<readonly [string, string]> = [];
  const runner = forge("gitlab", {
    mrs: [
      mr65({
        ...(mergedAt === null ? { state: "merged" } : { state: "merged", mergedAt }),
        ...over.mr,
      }),
    ],
  });
  const checked = new Map<string, number>();
  const states = new Map();
  const panels = new Map();
  const round = Effect.fn("merges.settleRound")(function* (now: number) {
    yield* settleMerges({
      stateDir,
      cwd: "/project",
      run: runner,
      views: yield* buildBoard({ env, runs, now, quietMs: Infinity }),
      runs,
      record: () => Effect.void,
      stop: (run, reason) =>
        Effect.sync(() => void stops.push([run, reason])).pipe(
          Effect.andThen(stopping(stateDir, run, reason)),
        ),
      now,
      checked,
      states,
      panels,
      making: over.making ?? new Set(),
    });
  });
  /** The Runs as the host reads them once each stop it was handed took. */
  const stopped = () => {
    const ids = new Set(Arr.map(stops, ([run]) => run));
    runs = Arr.map(runs, (run) => (ids.has(run.id) ? { ...run, state: "stopped" as const } : run));
  };
  const join = (over: Partial<RunFacts>) => Effect.map(of(over), (run) => void runs.push(run));
  return { stateDir, env, stops, round, stopped, join, runs: () => runs };
});

test("a merge stops what in its Task is still going: the parked builder and the plan waiting on it, once", () =>
  runWithForge(
    Effect.gen(function* () {
      const { stateDir, stops, round, stopped } = yield* merging([
        { id: "r-review", workflow: "review", state: "stopped" },
        { id: "r-investigate", workflow: "investigate", state: "succeeded" },
      ]);
      yield* round(TEN);
      expect(
        Arr.map(yield* readDispositions(runDir(stateDir, "r-plan.implement")), (line) => [
          line.by,
          line.kind,
          line.ref,
        ]),
      ).toEqual([["gitlab", "merged", "mk/collie!65"]]);
      expect(
        Arr.sort(
          stops,
          Order.mapInput(Order.String, ([run]: readonly [string, string]) => run),
        ),
      ).toEqual([
        ["r-plan", "mk/collie!65 merged"],
        ["r-plan.implement", "mk/collie!65 merged"],
      ]);
      stopped();
      yield* round(TEN + MERGE_POLL_MS);
      expect(stops).toHaveLength(2);
    }),
  ));

test("a merge's stop ends the Run's agents through the one end, and its log names the merge", () =>
  runWithForge(
    Effect.gen(function* () {
      const rig = yield* Rig.make();
      yield* rig.startSocket();
      yield* rig.addWorkspace("w1", "Project | Task", "/project");
      yield* rig.addPane("p0", "t0", "/project", null, "w1");
      yield* rig.addPane("p1", "t1", "/project", "claude", "w1");
      yield* rig.addAgent("impl", "p1");
      const services = yield* Effect.context<PlatformServices>();
      const halting = (stateDir: string, run: string, reason: string) =>
        Agents.pipe(
          Effect.flatMap((agents) => agents.halt(run, reason)),
          Effect.provide(
            agentsLayer({
              dir: stateDir,
              env: rig.pluginEnv(),
              herdr: new FakeHerdr(rig.pluginEnv()),
              harness: "claude",
              model: "opus",
              permissions: "auto",
              compactAtTokens: 0,
              help: () => Effect.succeed(""),
            }).pipe(
              Layer.provideMerge(
                foundationLayer({
                  dir: stateDir,
                }),
              ),
            ),
          ),
          Effect.scoped,
          Effect.orDie,
          Effect.asVoid,
          Effect.provideContext(services),
        );
      const { stateDir, round } = yield* merging([], MERGED_AT, halting);
      const fs = yield* FileSystem.FileSystem;
      const agents = `${stateDir}/agents/r-plan.implement`;
      yield* fs.makeDirectory(agents, { recursive: true });
      yield* fs.writeFileString(
        `${agents}/build.launch.json`,
        asLaunch({
          agent: "impl",
          output: `${agents}/build.json`,
          reused: false,
          runId: "r-plan.implement",
          operation: "build",
          role: "implementer",
          workflow: "implement",
          harness: "claude",
          terminalId: "term-impl",
        }),
      );
      yield* round(TEN);
      const closed = Arr.filter(yield* rig.calls(), (call) => call.cmd === "pane close");
      expect(Arr.map(closed, (call) => call.argv?.at(2))).toEqual(["p1"]);
      expect(yield* fs.readFileString(`${agents}/agents.log`)).toContain(
        "impl ended: mk/collie!65 merged",
      );
      yield* rig.close();
    }),
  ));

test("a Run of the Task started after the merge is not stopped by it", () =>
  runWithForge(
    Effect.gen(function* () {
      const { stops, round } = yield* merging([
        {
          id: "r-follow-up",
          workflow: "implement",
          state: "running",
          created: "2026-10-15T09:30:00Z",
        },
      ]);
      yield* round(TEN);
      expect(Arr.map(stops, ([run]) => run).sort()).toEqual(["r-plan", "r-plan.implement"]);
    }),
  ));

test("where the forge gives no merge time, the time the watch first read it merged is used", () =>
  runWithForge(
    Effect.gen(function* () {
      const { stops, round } = yield* merging(
        [
          { id: "r-before", workflow: "review", state: "running", created: "2026-10-15T09:59:00Z" },
          { id: "r-after", workflow: "review", state: "running", created: "2026-10-15T10:01:00Z" },
        ],
        null,
      );
      yield* round(TEN);
      expect(Arr.map(stops, ([run]) => run).sort()).toEqual([
        "r-before",
        "r-plan",
        "r-plan.implement",
      ]);
    }),
  ));

test("a Run that follows the merge is not stopped when it leads the Task, however the forge dates the merge", () =>
  runWithForge(
    Effect.gen(function* () {
      const { stops, round, stopped, join } = yield* merging([], null);
      yield* round(TEN);
      stopped();
      yield* join({ id: "r-follow-up", workflow: "implement", created: "2026-10-15T10:01:00Z" });
      yield* round(TEN + MERGE_POLL_MS);
      expect(Arr.map(stops, ([run]) => run).sort()).toEqual(["r-plan", "r-plan.implement"]);
    }),
  ));

test("the forge's merge time is the cutoff, not when a merge was recorded by hand", () =>
  runWithForge(
    Effect.gen(function* () {
      const { stateDir, stops, round } = yield* merging([
        {
          id: "r-follow-up",
          workflow: "implement",
          state: "running",
          created: "2026-10-15T09:30:00Z",
        },
      ]);
      yield* recordDisposition(runDir(stateDir, "r-plan.implement"), {
        at: "2026-10-15T10:00:00Z",
        by: "mk",
        kind: "merged",
        ref: "mk/collie!65",
        note: null,
      });
      yield* round(TEN);
      yield* round(TEN + 60_000);
      expect([...new Set(Arr.map(stops, ([run]) => run))].sort()).toEqual([
        "r-plan",
        "r-plan.implement",
      ]);
    }),
  ));

test("a stop that did not take is asked again next round, before the forge is due and once it is in production", () =>
  runWithForge(
    Effect.gen(function* () {
      const { stops, round } = yield* merging();
      yield* round(TEN);
      yield* round(TEN + 60_000);
      expect(Arr.map(stops, ([run]) => run).sort()).toEqual([
        "r-plan",
        "r-plan",
        "r-plan.implement",
        "r-plan.implement",
      ]);

      const restored = yield* merging();
      yield* writeMrStates(restored.stateDir, new Map([["mk/collie!65", "in-prod"]]));
      yield* recordDisposition(runDir(restored.stateDir, "r-plan.implement"), {
        at: MERGED_AT,
        by: "gitlab",
        kind: "merged",
        ref: "mk/collie!65",
        note: null,
      });
      yield* restored.round(TEN);
      expect(Arr.map(restored.stops, ([run]) => run).sort()).toEqual([
        "r-plan",
        "r-plan.implement",
      ]);
    }),
  ));

// The Run that lands a merge request, and the Runs it was started from, are left running.

const LANDED_HEAD = "head-1";
/** A Release Run under the parked builder, and a sibling review of the same Task. */
const RELEASE: ReadonlyArray<Partial<RunFacts>> = [
  {
    id: "r-release",
    workflow: "release",
    parent: "r-plan.implement",
    state: "running",
    created: "2026-10-15T08:20:00Z",
  },
  { id: "r-review", workflow: "review", state: "running", created: "2026-10-15T08:30:00Z" },
];
const attempt = (over: Partial<Landing> = {}): Landing => ({
  state: "attempt",
  mr: MR,
  head: LANDED_HEAD,
  at: "2026-10-15T08:55:00Z",
  ...over,
});
const stoppedIds = (stops: ReadonlyArray<readonly [string, string]>) =>
  [...new Set(Arr.map(stops, ([run]) => run))].sort();
const EVERY_RUN = ["r-plan", "r-plan.implement", "r-release", "r-review"];

test("a landed Run, its parent and its grandparent are spared by the merge; a sibling is stopped", () =>
  runWithForge(
    Effect.gen(function* () {
      const { stateDir, stops, round } = yield* merging(RELEASE);
      const landed = attempt({ state: "landed", sha: "m1" });
      yield* writeLanding(runDir(stateDir, "r-release"), landed);
      yield* round(TEN);
      expect(stoppedIds(stops)).toEqual(["r-review"]);
      expect(yield* readLanding(runDir(stateDir, "r-release"))).toEqual(landed);
    }),
  ));

test("an attempt this host is making is spared, with its lineage, before it records landed", () =>
  runWithForge(
    Effect.gen(function* () {
      const making = new Set<string>();
      const { stateDir, stops, round } = yield* merging(RELEASE, MERGED_AT, undefined, {
        making,
        mr: { mergedBy: "alice" },
      });
      making.add(runDir(stateDir, "r-release"));
      yield* writeLanding(runDir(stateDir, "r-release"), attempt());
      yield* round(TEN);
      expect(stoppedIds(stops)).toEqual(["r-review"]);
      expect((yield* readLanding(runDir(stateDir, "r-release")))?.state).toBe("attempt");
    }),
  ));

test("a withdrawn landing, or one of another merge request, spares nothing", () =>
  runWithForge(
    Effect.gen(function* () {
      for (const landing of [
        attempt({ state: "withdrawn", why: "the head moved to head-2" }),
        attempt({ state: "landed", sha: "m1", mr: mrUrl("66") }),
      ]) {
        const { stateDir, stops, round } = yield* merging(RELEASE);
        yield* writeLanding(runDir(stateDir, "r-release"), landing);
        yield* round(TEN);
        expect(stoppedIds(stops)).toEqual(EVERY_RUN);
      }
    }),
  ));

test("an interrupted attempt is someone else's where another login, an earlier merge or another head merged it: withdrawn, and every Run stopped", () =>
  runWithForge(
    Effect.gen(function* () {
      for (const mr of [
        { mergedBy: "alice", head: LANDED_HEAD, mergedAt: "2026-10-15T09:00:00Z" },
        { mergedBy: "mk", head: LANDED_HEAD, mergedAt: "2026-10-15T08:53:00Z" },
        { mergedBy: "mk", head: "head-2", mergedAt: "2026-10-15T09:00:00Z" },
      ]) {
        const { stateDir, stops, round } = yield* merging(RELEASE, mr.mergedAt, undefined, {
          mr: { ...mr, mergedSha: "m1" },
        });
        yield* writeLanding(runDir(stateDir, "r-release"), attempt());
        yield* round(TEN);
        expect(stoppedIds(stops)).toEqual(EVERY_RUN);
        expect(yield* readLanding(runDir(stateDir, "r-release"))).toMatchObject({
          state: "withdrawn",
          why: `merged outside this Run by ${mr.mergedBy}`,
        });
      }
    }),
  ));

test("an interrupted attempt merged by Collie's login at its head after it was written is landed, and spared", () =>
  runWithForge(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // Within the minute the forge's clock may run behind the host's.
      const { stateDir, stops, round } = yield* merging(
        RELEASE,
        "2026-10-15T08:54:30Z",
        undefined,
        {
          mr: { mergedBy: "mk", head: LANDED_HEAD, mergedSha: "m1" },
        },
      );
      yield* writeLanding(runDir(stateDir, "r-release"), attempt());
      yield* round(TEN);
      expect(stoppedIds(stops)).toEqual(["r-review"]);
      expect(yield* readLanding(runDir(stateDir, "r-release"))).toEqual(
        attempt({ state: "landed", sha: "m1" }),
      );
      expect(yield* fs.readFileString(`${runDir(stateDir, "r-release")}/log.txt`)).toContain(
        `landing: merged ${MR} at ${LANDED_HEAD} as m1`,
      );
    }),
  ));

test("a Task its merge stopped is Finished and reads as the merge; one a human stopped still says so", () =>
  runWithForge(
    Effect.gen(function* () {
      for (const [origin, sentence] of [
        ["host", "Merged as mk/collie!65."],
        ["board", "Stopped by you. Merged as mk/collie!65."],
      ] as const) {
        const { env, stops, round, stopped, runs } = yield* merging();
        yield* round(TEN);
        for (const [run, reason] of stops)
          yield* recordAudit(runDir(env.stateDir, run), {
            operation: "stop",
            request: `stop-${run}`,
            origin,
            reason,
            result: Schema.Struct({}),
            value: {},
          });
        stopped();
        const [card] = yield* buildBoard({ env, runs: runs(), now: TEN, quietMs: Infinity });
        expect(sectionOf(card!)).toBe("finished");
        expect(card!.sentence).toBe(sentence);
      }
    }),
  ));

test("a card whose Run ended is still followed while its Reopened agent works or waits", () =>
  runWithForge(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-merges-" });
      const log: string[] = [];
      const reopened = (status: string) => ({ delivery: "d1", agent: "a1", told: null, status });
      yield* settleMerges({
        stateDir,
        cwd: "/project",
        run: gitlab("open", log),
        views: [task({ id: "reopened", state: "active", mr: MR, reopened: reopened("working") })],
        runs: [],
        record: () => Effect.void,
        stop: () => Effect.die("nothing here is stopped"),
        now: epochMs("2026-09-17T10:00:00Z"),
        checked: new Map(),
        states: new Map(),
        panels: new Map(),
        making: new Set(),
      });
      expect(log).not.toEqual([]);
      const asked = log.length;
      yield* settleMerges({
        stateDir,
        cwd: "/project",
        run: gitlab("open", log),
        views: [task({ id: "reopened", state: "blocked", mr: MR, reopened: reopened("blocked") })],
        runs: [],
        record: () => Effect.void,
        stop: () => Effect.die("nothing here is stopped"),
        now: epochMs("2026-09-17T11:00:00Z"),
        checked: new Map(),
        states: new Map(),
        panels: new Map(),
        making: new Set(),
      });
      expect(log.length).toBeGreaterThan(asked);
    }),
  ));

// The forge's own checks, beside the state: what the card says about whether it is ready.

const HEAD = "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b";

/** A GitLab whose merge request is open with its head pipeline `state`. */
const piped = (state: Check["state"]): Runner =>
  forge("gitlab", { mrs: [mr65({ head: HEAD, checks: [{ name: "build", state }] })] });

const PR = "https://github.com/cego/collie/pull/30";

/** A GitHub whose pull request #30 is `state`, with `checks`. */
const github = (
  state: FakeMr["state"],
  checks: ReadonlyArray<Check>,
  over: Partial<ForgeModel> = {},
): Runner =>
  forge("github", {
    mrs: [
      {
        project: "github.com/cego/collie",
        iid: "30",
        state,
        head: HEAD,
        mergedSha: state === "merged" ? HEAD : "",
        checks,
      },
    ],
    ...over,
  });

/** A check Collie ran for the Run, at a revision. */
const collieRan = (run: string, at: string, result: "pass" | "fail" = "pass") => ({
  id: `v-${at}`,
  run,
  name: "test",
  executable: result === "pass" ? "/usr/bin/true" : "/usr/bin/false",
  argv: [],
  cwd: "/project",
  start: { head_sha: at, fingerprint: "f" },
  end: { head_sha: at, fingerprint: "f" },
  exit: result === "pass" ? 0 : 1,
  seconds: 1,
  expect: "pass" as const,
  tail: { stdout: "", stderr: "" },
  result,
  at: "2026-09-17T09:00:00Z",
  by: "collie" as const,
});

/**
 * The card after one round of the watch, read back the way the CLI's board reads it, with
 * Collie's own checks passed at `passedAt` where one is given.
 */
const cardAfter = Effect.fn("merges.cardAfter")(function* (
  mr: string,
  run: Runner,
  passedAt?: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-forge-" });
  const env = readEnv({ HERDR_PLUGIN_STATE_DIR: stateDir, COLLIE_CWD: "/project" });
  const made = yield* madeRun(stateDir, {
    state: "succeeded",
    mr,
    created: "2026-09-17T09:00:00Z",
  });
  if (passedAt !== undefined)
    yield* appendVerification(made.evidence, collieRan(made.id, passedAt));
  const now = epochMs("2026-09-17T10:00:00Z");
  const views = yield* buildBoard({ env, runs: [made], now });
  yield* settleMerges({
    stateDir,
    cwd: "/project",
    runs: [],
    record: () => Effect.void,
    stop: () => Effect.die("nothing here is stopped"),
    run,
    views,
    now,
    checked: new Map(),
    states: new Map(),
    panels: new Map(),
    making: new Set(),
  });
  const [card] = yield* buildBoard({ env, runs: [made], now });
  return { card: card!, run: made, stateDir };
});

test("a GitLab pipeline that failed, is running or passed is what the card's checks say", () =>
  runWithForge(
    Effect.gen(function* () {
      const red = (yield* cardAfter(MR, piped("failed"))).card;
      expect(red.checks).toEqual({ state: "failed", name: "pipeline", at: HEAD });
      expect(red.sentence).toBe(
        "mk/collie!65 is open, but pipeline failed at 1a2b3c4. Next: fix pipeline.",
      );
      const going = (yield* cardAfter(MR, piped("running"))).card;
      expect(going.checks).toEqual({ state: "running" });
      expect(going.sentence).toBe("mk/collie!65 is open; its pipeline is still running.");
      expect((yield* cardAfter(MR, piped("passed"))).card.ready).toBe(false);
      const green = (yield* cardAfter(MR, piped("passed"), HEAD)).card;
      expect(green.ready).toBe(true);
      expect(green.sentence).toBe(
        "Ready to release: mk/collie!65 is open and its checks passed at 1a2b3c4. Next: merge it.",
      );
    }),
  ));

test("a GitHub check rollup that is red, pending or green is what the card's checks say", () =>
  runWithForge(
    Effect.gen(function* () {
      const lint = { name: "lint", state: "failed" } as const;
      const tests = { name: "test", state: "passed" } as const;
      const queued = { name: "e2e", state: "running" } as const;

      const red = (yield* cardAfter(PR, github("open", [tests, lint]))).card;
      expect(red.checks).toEqual({ state: "failed", name: "lint", at: HEAD });
      expect(red.sentence).toBe(
        "cego/collie#30 is open, but lint failed at 1a2b3c4. Next: fix lint.",
      );
      expect((yield* cardAfter(PR, github("open", [tests, queued]))).card.checks).toEqual({
        state: "running",
      });
      const green = (yield* cardAfter(PR, github("open", [tests]), HEAD)).card;
      expect(green.ready).toBe(true);
      expect(green.sentence).toBe(
        "Ready to release: cego/collie#30 is open and its checks passed at 1a2b3c4. Next: merge it.",
      );
    }),
  ));

test("a draft, and what the forge says of merging, reach the card's readiness", () =>
  runWithForge(
    Effect.gen(function* () {
      const green = [{ name: "build", state: "passed" }] as const;
      const draft = (yield* cardAfter(
        MR,
        forge("gitlab", { mrs: [mr65({ head: HEAD, draft: true, checks: green })] }),
        HEAD,
      )).card;
      expect(draft.ready).toBe(false);
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(draft.readiness), (present) =>
            Arr.map(present.missing, (one) => one.fact),
          ),
        ),
      ).toEqual(["not-draft"]);

      const conflicted = (yield* cardAfter(
        PR,
        github("open", green, {
          mrs: [
            {
              project: "github.com/cego/collie",
              iid: "30",
              state: "open",
              head: HEAD,
              checks: green,
              mergeable: "conflict",
            },
          ],
        }),
        HEAD,
      )).card;
      expect(conflicted.readiness?.missing).toEqual([
        {
          fact: "mergeable",
          said: "the forge says it cannot merge: conflicting",
          settling: false,
        },
      ]);
    }),
  ));

test("a merged GitHub pull request lands its card, by github's word", () =>
  runWithForge(
    Effect.gen(function* () {
      const { card, run } = yield* cardAfter(PR, github("merged", []));
      const recorded = yield* readDispositions(run.dir);
      expect(Arr.map(recorded, (line) => [line.by, line.kind, line.ref])).toEqual([
        ["github", "merged", "cego/collie#30"],
      ]);
      expect(sectionOf(card)).toBe("finished");
      expect(card.sentence).toBe("Merged as cego/collie#30.");
    }),
  ));

test("no gh, or a gh nobody logged in to, leaves the card unchecked and says nothing of it", () =>
  runWithForge(
    Effect.gen(function* () {
      for (const over of [{ installed: false }, { loggedIn: [] }]) {
        const { card } = yield* cardAfter(PR, github("open", [], over));
        expect(card.checks).toEqual({ state: "unchecked" });
        expect(card.sentence).toBe("cego/collie#30 is open; nothing has checked it.");
      }
    }),
  ));

test("a board file in the old shape still reads, with nothing known of the forge's checks", () =>
  runWithForge(
    Effect.gen(function* () {
      const { stateDir, board: boardOf } = yield* seeded();
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${stateDir}/board`, { recursive: true });
      yield* fs.writeFileString(`${stateDir}/board/mr-states.json`, '{"mk/collie!65":"open"}\n');
      expect(yield* readMrStates(stateDir)).toEqual(new Map([["mk/collie!65", "open"]]));
      expect(yield* readForge(stateDir)).toEqual(new Map());
      const [card] = yield* boardOf({ now: epochMs("2026-09-17T10:00:00Z") });
      expect(card!.mrState).toBe("open");
      expect(card!.checks).toEqual({ state: "unchecked" });
    }),
  ));

test("green forge checks never stand in for Collie's own, which count only at the forge's head", () =>
  runWithForge(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-forge-older-" });
      const env = readEnv({ HERDR_PLUGIN_STATE_DIR: stateDir, COLLIE_CWD: "/project" });
      const made = yield* madeRun(stateDir, { state: "succeeded", mr: PR });
      // Red, but on a tree the pull request has moved past.
      yield* appendVerification(made.evidence, collieRan(made.id, "0ld0ld0", "fail"));
      const now = epochMs("2026-09-17T10:00:00Z");
      const tests = { name: "test", state: "passed" } as const;
      yield* settleMerges({
        stateDir,
        cwd: "/project",
        run: github("open", [tests]),
        views: yield* buildBoard({ env, runs: [made], now }),
        runs: [made],
        record: () => Effect.void,
        stop: () => Effect.die("nothing here is stopped"),
        now,
        checked: new Map(),
        states: new Map(),
        panels: new Map(),
        making: new Set(),
      });
      const [card] = yield* buildBoard({ env, runs: [made], now });
      expect(card!.checks).toEqual({ state: "unchecked" });
      expect(card!.ready).toBe(false);
      yield* appendVerification(made.evidence, collieRan(made.id, HEAD));
      const [passed] = yield* buildBoard({ env, runs: [made], now });
      expect(passed!.checks).toEqual({ state: "passed", at: HEAD });
      expect(passed!.sentence).toContain("passed at 1a2b3c4.");
    }),
  ));

test("a pull request's panel is read for the drawer as a merge request's is, and says whether it moved", () =>
  runWithForge(
    Effect.gen(function* () {
      const reviewedAt = epochMs("2026-09-17T09:00:00Z");
      for (const [target, run] of [
        [MR, forge("gitlab", { mrs: [mr65({ head: HEAD, updatedAt: "2026-09-17T11:00:00Z" })] })],
        [
          PR,
          forge("github", {
            mrs: [
              {
                project: "github.com/cego/collie",
                iid: "30",
                state: "open",
                title: "Cards",
                head: HEAD,
                updatedAt: "2026-09-17T11:00:00Z",
              },
            ],
          }),
        ],
      ] as const) {
        const panel = yield* watchedMr({
          panels: new Map(),
          target,
          cwd: "/project",
          run,
          now: epochMs("2026-09-17T12:00:00Z"),
          fresh: true,
        });
        expect(panel).toMatchObject({ _tag: "Details", title: "Cards", headSha: "1a2b3c4" });
        expect(panel?._tag === "Details" ? sinceReview(panel, reviewedAt) : "").toBe(
          "changed 2h after this review — head 1a2b3c4",
        );
      }
    }),
  ));

test("a merged pull request is followed to stage, then production, then asked no more", () =>
  runWithForge(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-pr-deploys-" });
      const env = readEnv({ HERDR_PLUGIN_STATE_DIR: stateDir, COLLIE_CWD: "/project" });
      const made = yield* madeRun(stateDir, {
        state: "succeeded",
        mr: PR,
        created: "2026-09-17T09:00:00Z",
      });
      const states = new Map();
      const checked = new Map<string, number>();
      let now = epochMs("2026-09-17T10:00:00Z");
      const deployedTo = (prod: string, log: string[] = []) =>
        forge(
          "github",
          {
            mrs: [
              { project: "github.com/cego/collie", iid: "30", state: "merged", mergedSha: HEAD },
            ],
            environments: [
              { name: "staging", tier: "staging", deployed: "child" },
              { name: "production", tier: "production", deployed: prod },
            ],
            ancestry: { child: [HEAD] },
          },
          log,
        );
      const settle = (run: Runner) =>
        Effect.gen(function* () {
          yield* settleMerges({
            stateDir,
            cwd: "/project",
            run,
            views: yield* buildBoard({ env, runs: [made], mrStates: states, now }),
            runs: [made],
            record: () => Effect.void,
            stop: () => Effect.die("nothing here is stopped"),
            now,
            checked,
            states,
            panels: new Map(),
            making: new Set(),
          });
          return (yield* buildBoard({ env, runs: [made], now }))[0]!;
        });
      expect((yield* settle(deployedTo("0ld"))).sentence).toBe(
        "Merged as cego/collie#30. On stage.",
      );
      now += 6 * 60_000;
      expect((yield* settle(deployedTo(HEAD))).sentence).toBe(
        "Merged as cego/collie#30. In production.",
      );
      now += 6 * 60_000;
      const log: string[] = [];
      yield* settle(deployedTo(HEAD, log));
      expect(log).toEqual([]);
    }),
  ));

/** A fan-out whose Repo runs opened merge requests 65 and 66, one per repository listed. */
const fannedOut = Effect.fn("merges.fannedOut")(function* (
  repos: ReadonlyArray<{ repo: string; iid: string }>,
) {
  const fs = yield* FileSystem.FileSystem;
  const stateDir = yield* fs.makeTempDirectoryScoped({
    prefix: "collie-fan-merges-",
  });
  const env = readEnv({
    HERDR_PLUGIN_STATE_DIR: stateDir,
    COLLIE_CWD: "/project",
  });
  const of = (over: Partial<RunFacts>) =>
    madeRun(stateDir, {
      task: "task-1",
      created: "2026-10-15T08:00:00Z",
      ...over,
    });
  const parent = yield* of({ id: "r-fan", state: "running" });
  const runs = [parent];
  for (const { repo, iid } of repos)
    runs.push(
      yield* of({
        id: `r-fan.${repo}`,
        parent: "r-fan",
        repo,
        state: "running",
        branch: `mk/${repo}`,
        mr: mrUrl(iid),
        created: "2026-10-15T08:10:00Z",
      }),
    );
  return { stateDir, env, runs };
});

test("a fan-out's Repo run's merge request is watched: its facts recorded, its merge landing and stopping that Repo run", () =>
  runWithForge(
    Effect.gen(function* () {
      const { stateDir, env, runs } = yield* fannedOut([
        { repo: "api", iid: "65" },
        { repo: "web", iid: "66" },
      ]);
      const stops: Array<readonly [string, string]> = [];
      yield* settleMerges({
        stateDir,
        cwd: "/project",
        run: forge("gitlab", {
          mrs: [
            mr65({ state: "merged", mergedAt: MERGED_AT, head: HEAD }),
            mr65({
              iid: "66",
              head: HEAD,
              checks: [{ name: "test", state: "passed" }],
            }),
          ],
        }),
        views: yield* buildBoard({ env, runs, now: TEN, quietMs: Infinity }),
        runs,
        record: () => Effect.die("a Repo run's merge request is its own"),
        stop: (run, reason) => Effect.sync(() => void stops.push([run, reason])),
        now: TEN,
        checked: new Map(),
        states: new Map(),
        panels: new Map(),
        making: new Set(),
      });

      expect(
        Arr.map(yield* readDispositions(runDir(stateDir, "r-fan.api")), (line) => [
          line.by,
          line.kind,
          line.ref,
        ]),
      ).toEqual([["gitlab", "merged", "mk/collie!65"]]);
      expect(yield* readDispositions(runDir(stateDir, "r-fan"))).toEqual([]);
      expect(yield* readMrStates(stateDir)).toEqual(
        new Map([
          ["mk/collie!65", "merged"],
          ["mk/collie!66", "open"],
        ]),
      );
      const facts = (yield* readForge(stateDir)).get("mk/collie!66");
      expect(facts?.head).toBe(HEAD);
      expect(facts?.checks.state).toBe("passed");
      expect(facts?.draft).toBe(false);
      expect(facts?.mergeable?.state).toBe("mergeable");
      expect(stops).toEqual([["r-fan.api", "mk/collie!65 merged"]]);
    }),
  ));

/** A finished fan-out whose plan has one repository, api, whose Repo run opened 65. */
const singleRepo = Effect.fn("merges.singleRepo")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const { stateDir, env, runs: made } = yield* fannedOut([{ repo: "api", iid: "65" }]);
  const root = `${stateDir}/root`;
  yield* fs.makeDirectory(`${root}/api/.git`, { recursive: true });
  yield* fs.makeDirectory(`${made[0]!.dir}/plan/issues`, {
    recursive: true,
  });
  yield* fs.writeFileString(
    `${made[0]!.dir}/plan/issues/01-api.md`,
    "# api\n\n**Blocked by:** None\n\n**Repo:** api\n",
  );
  const runs = Arr.map(made, (run) => ({
    ...run,
    state: "succeeded" as const,
    cwd: run.repo === null ? root : run.cwd,
  }));
  return { stateDir, env, runs };
});

test("a single-repository fan-out's card is its one merge request's, watched, and no plan left to implement", () =>
  runWithForge(
    Effect.gen(function* () {
      const { stateDir, env, runs } = yield* singleRepo();
      const states = new Map();
      yield* settleMerges({
        stateDir,
        cwd: "/project",
        run: forge("gitlab", {
          mrs: [mr65({ head: HEAD, checks: [{ name: "test", state: "passed" }] })],
        }),
        views: yield* buildBoard({ env, runs, now: TEN, quietMs: Infinity }),
        runs,
        record: () => Effect.die("a Repo run's merge request is its own"),
        stop: () => Effect.die("nothing here is stopped"),
        now: TEN,
        checked: new Map(),
        states,
        panels: new Map(),
        making: new Set(),
      });

      const [card] = yield* buildBoard({
        env,
        runs,
        now: TEN,
        quietMs: Infinity,
      });
      expect(card!.mr).toBe(MR);
      expect(card!.mrState).toBe("open");
      expect(card!.planReady).toBe(false);
      expect(card!.sentence).toBe("mk/collie!65 is open; nothing has checked it.");
      // Only Collie's own checks are missing: nothing has checked the Repo run's head.
      expect(
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(card!.readiness), (present_) =>
            Arr.map(present_.missing, (one) => one.fact),
          ),
        ),
      ).toEqual(["checks"]);
    }),
  ));

test("a single-repository fan-out's card says what became of its Repo run's work", () =>
  runWithForge(
    Effect.gen(function* () {
      const { stateDir, env, runs } = yield* singleRepo();
      yield* recordDisposition(runDir(stateDir, "r-fan.api"), {
        at: "2026-10-15T10:00:00Z",
        by: "gitlab",
        kind: "merged",
        ref: "mk/collie!65",
        note: null,
      });
      const [card] = yield* buildBoard({ env, runs, now: TEN, quietMs: Infinity });
      expect(card!.sentence).toBe("Merged as mk/collie!65.");
      expect(card!.disposition).toBe("merged mk/collie!65");
    }),
  ));

test("a single-repository fan-out's merge request is not watched once its Repo run's work is abandoned", () =>
  runWithForge(
    Effect.gen(function* () {
      const { stateDir, env, runs } = yield* singleRepo();
      yield* recordDisposition(runDir(stateDir, "r-fan.api"), {
        at: "2026-10-15T10:00:00Z",
        by: "mk",
        kind: "abandoned",
        ref: "",
        note: null,
      });
      const log: string[] = [];
      yield* settleMerges({
        stateDir,
        cwd: "/project",
        run: forge("gitlab", { mrs: [mr65({})] }, log),
        views: yield* buildBoard({ env, runs, now: TEN, quietMs: Infinity }),
        runs,
        record: () => Effect.die("nothing is recorded"),
        stop: () => Effect.die("nothing here is stopped"),
        now: TEN,
        checked: new Map(),
        states: new Map(),
        panels: new Map(),
        making: new Set(),
      });
      expect(log).toEqual([]);
    }),
  ));
