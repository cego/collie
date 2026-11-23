import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { DateTime, Effect, FileSystem, Option } from "effect";
import { TestClock } from "effect/testing";
import { buildBoard, type ForgeFacts, type KeptCards } from "../src/board";
import type { MrState, OfferView, TaskView } from "../src/board-model";
import { readEnv } from "../src/env";
import type { AgentInfo } from "../src/herdr";
import type { AgentEntry } from "../src/registry";
import { makeRunModel } from "../src/run-model";
import type { RunFacts } from "../src/runs";
import { epochMs } from "../src/time";
import { runEffect } from "./support/effect";
import { madeRun } from "./support/records";

const NOW = epochMs("2026-10-30T10:00:00Z");
const FINISHED = "2026-10-30T09:30:00Z";
const mrOf = (n: number) => `https://github.com/cego/collie/pull/${n}`;
const mrIdOf = (n: number) => `github.com/cego/collie#${n}`;

const follow = (unavailable: string | null = null): OfferView => ({
  id: "build",
  title: "Build it",
  workflow: "implement",
  arguments: null,
  kind: "follow-up",
  primary: true,
  unavailable,
});

const agent = (status: AgentInfo["status"]): AgentInfo => ({
  name: "plan-1",
  paneId: "t-1",
  status,
  terminalId: "t-1",
  cwd: "/a",
  foregroundCwd: null,
});

/** Two finished planners, each in a checkout of its own with a merge request and a ready plan. */
const planners = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-board-offers-" });
  const created = DateTime.formatIso(DateTime.makeUnsafe(epochMs(FINISHED) - 60 * 60_000));
  const runs = yield* Effect.forEach(["a", "b"], (name, at) =>
    Effect.gen(function* () {
      const run = yield* madeRun(dir, {
        id: `r-${name}`,
        workflow: "plan",
        state: "succeeded",
        cwd: `/${name}`,
        mr: mrOf(at + 1),
        created,
        finished: FINISHED,
      });
      yield* fs.makeDirectory(`${run.dir}/plan/issues`, { recursive: true });
      yield* fs.writeFileString(`${run.dir}/plan/issues/01-first.md`, "# First\n");
      return run;
    }),
  );
  const model = yield* makeRunModel(dir, "installation");
  const registered: ReadonlyArray<AgentEntry> = [
    {
      role: "planner",
      agent: "plan-1",
      paneId: "p-1",
      workspaceId: "w1",
      runId: runs[0]!.id,
      workflow: "plan",
      at: FINISHED,
    },
  ];
  return {
    env: readEnv({ COLLIE_STATE_DIR: dir, COLLIE_CWD: "/a" }),
    runs,
    model,
    registered,
  };
});

/** A board whose every input a test can move, counting each Run the `offers` source is asked of. */
const rig = Effect.gen(function* () {
  yield* TestClock.setTime(NOW);
  const { env, runs, model, registered } = yield* planners;
  const asked: string[] = [];
  const shown: ReadonlyArray<RunFacts> = runs;
  const state = {
    runs: shown,
    alive: [agent("working")],
    mrStates: new Map<string, MrState>([
      [mrIdOf(1), "open"],
      [mrIdOf(2), "open"],
    ]),
    forge: new Map<string, ForgeFacts>(
      Arr.map([1, 2], (n) => [
        mrIdOf(n),
        { checks: { state: "unknown" }, head: null, read: "2026-10-30T09:59:00Z" },
      ]),
    ),
    offers: (_run: string): ReadonlyArray<OfferView> => [follow()],
  };
  const cards: KeptCards = {
    revision: model.inputsAt,
    content: model.content,
    modules: "/layer@1",
    connections: new Map([
      ["/a", "github=ok"],
      ["/b", "github=ok"],
    ]),
    kept: new Map(),
  };
  const build = Effect.gen(function* () {
    yield* model.observe(state.runs);
    return yield* buildBoard({
      env,
      runs: state.runs,
      registered,
      alive: state.alive,
      mrStates: state.mrStates,
      forge: state.forge,
      offers: (run) => Effect.sync(() => (asked.push(run), state.offers(run))),
      cards,
    }).pipe(Effect.provideService(FileSystem.FileSystem, model.reading));
  });
  yield* build;
  expect(asked.length).toBeGreaterThan(0);
  asked.length = 0;
  return { runs, state, cards, asked, build };
});

const viewOf = (views: ReadonlyArray<TaskView>, run: string) =>
  Option.getOrUndefined(Arr.findFirst(views, (view) => view.runs.includes(run)));

test("a card rebuilt because its agent turned idle asks no Offers and shows the agent", () =>
  runEffect(
    Effect.gen(function* () {
      const { runs, state, asked, build } = yield* rig;
      state.alive = [agent("idle")];
      const views = yield* build;
      expect(asked).toEqual([]);
      expect(Arr.map(viewOf(views, runs[0]!.id)?.agents ?? [], (one) => one.status)).toEqual([
        "idle",
      ]);
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("a forge answer read again unchanged asks no Offers", () =>
  runEffect(
    Effect.gen(function* () {
      const { state, asked, build } = yield* rig;
      state.forge = new Map(
        Arr.map([...state.forge], ([id, facts]) => [
          id,
          { ...facts, read: "2026-10-30T10:00:00Z" },
        ]),
      );
      yield* build;
      expect(asked).toEqual([]);
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test.each([
  [
    "its facts",
    (s: Awaited<Effect.Success<typeof rig>>) => {
      s.state.runs = [{ ...s.runs[0]!, summary: "New engine facts" }, s.runs[1]!];
    },
  ],
  [
    "its merge request's state",
    (s: Awaited<Effect.Success<typeof rig>>) => {
      s.state.mrStates = new Map([...s.state.mrStates, [mrIdOf(1), "merged"]]);
    },
  ],
  [
    "its merge request as the forge reads it",
    (s: Awaited<Effect.Success<typeof rig>>) => {
      s.state.forge = new Map([
        ...s.state.forge,
        [mrIdOf(1), { checks: { state: "passed" }, head: "abc", read: "2026-10-30T09:59:00Z" }],
      ]);
    },
  ],
  [
    "a Connection reading of its checkout",
    (s: Awaited<Effect.Success<typeof rig>>) => {
      s.cards.connections = new Map([...s.cards.connections!, ["/a", "github=missing"]]);
    },
  ],
] as const)("a move in %s asks that Run's Offers again, and no other's", (_, move) =>
  runEffect(
    Effect.gen(function* () {
      const s = yield* rig;
      s.state.offers = () => [follow(), { ...follow(), id: "again", title: "Again" }];
      move(s);
      const views = yield* s.build;
      expect([...new Set(s.asked)]).toEqual([s.runs[0]!.id]);
      const offered = (run: string) => Arr.map(viewOf(views, run)?.offers ?? [], (one) => one.id);
      expect(offered(s.runs[0]!.id)).toEqual(["build", "again"]);
      expect(offered(s.runs[1]!.id)).toEqual(["build"]);
    }).pipe(Effect.provide(TestClock.layer())),
  ),
);

test("a moved module revision asks every Run's Offers again", () =>
  runEffect(
    Effect.gen(function* () {
      const { runs, cards, asked, build } = yield* rig;
      cards.modules = "/layer@2";
      yield* build;
      expect([...new Set(asked)].sort()).toEqual(Arr.map(runs, (run) => run.id).sort());
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("an Offer's unavailable reason is kept until what it was derived from moves", () =>
  runEffect(
    Effect.gen(function* () {
      const { runs, state, asked, build } = yield* rig;
      const id = runs[0]!.id;
      state.offers = () => [follow("needs github: logged out")];
      state.runs = [{ ...runs[0]!, summary: "Moved" }, runs[1]!];
      const unavailable = yield* build;
      expect(asked).toContain(id);
      asked.length = 0;
      const reasons = (views: typeof unavailable) =>
        Arr.map(viewOf(views, id)?.offers ?? [], (one) => one.unavailable ?? null);
      expect(reasons(unavailable)).toEqual(["needs github: logged out"]);

      state.offers = () => [follow()];
      state.alive = [agent("idle")];
      expect(reasons(yield* build)).toEqual(["needs github: logged out"]);
      expect(asked).toEqual([]);

      state.runs = [{ ...runs[0]!, summary: "Moved again" }, runs[1]!];
      expect(reasons(yield* build)).toEqual([null]);
    }).pipe(Effect.provide(TestClock.layer())),
  ));

test("a Run that leaves the board and returns is asked for its Offers again", () =>
  runEffect(
    Effect.gen(function* () {
      const { runs, state, asked, build } = yield* rig;
      state.runs = [runs[1]!];
      yield* build;
      expect(asked).toEqual([]);
      state.runs = runs;
      yield* build;
      expect([...new Set(asked)]).toEqual([runs[0]!.id]);
    }).pipe(Effect.provide(TestClock.layer())),
  ));
