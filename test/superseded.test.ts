// A question a human's message set aside is not a Decision on any surface, refuses a
// stale answer, and stays set aside across a restart, with the Workflow still waiting
// on it (ADR-draft-a-humans-message-supersedes-a-runs-open-question).

import * as Arr from "effect/Array";
import { afterEach, beforeEach, expect, test } from "bun:test";
import type { PlatformServices } from "../src/platform";
import * as Str from "effect/String";
import { Clock, Effect, FileSystem, Layer, Schema, type Scope } from "effect";
import { Rig, FakeHerdr } from "./support/recorder";
import { fastForward, runEffect as runLive } from "./support/effect";
import { installFakeSkills } from "./support/defs";
import { fixtures, until } from "./support/host";
import { agentsLayer } from "../src/agents";
import { Registry, foundationLayer, registryLayer, runDir, type HostServices } from "../src/engine";
import { Store } from "../src/store";
import { readAudit } from "../src/audit";
import { factsOfView } from "../src/runs";
import { laneFor } from "../src/flow-read";
import { runWaits } from "../src/run-waits";
import { buildBoard } from "../src/board";
import { describeWaiting, nextAction } from "../src/lifecycle";
import { reached } from "../src/following";
import { recordLaunch } from "../src/launches";
import { recordClaudeEvent } from "../src/compactors";
import { controlDir } from "../src/compaction";

const ROOT = new URL("../", import.meta.url).pathname;

let rig: Rig;

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.makeDirectory(rig.projectDir, { recursive: true })),
      );
      yield* installFakeSkills(rig.root);
    }),
  ),
);

afterEach(() => runEffect(rig.close()));

const env = () => rig.pluginEnv({ HERDR_PLUGIN_ROOT: ROOT });
const dir = () => env().stateDir;

const runEffect = <A, E>(effect: Effect.Effect<A, E, PlatformServices>) =>
  runLive(fastForward(effect));

const readsCounted = (reads: Array<string>) =>
  Layer.effect(Store)(
    Effect.gen(function* () {
      const store = yield* Store;
      return {
        ...store,
        asked: (run: string) =>
          Effect.suspend(() => {
            reads.push(`asked ${run}`);
            return store.asked(run);
          }),
        askedOf: (runs: ReadonlyArray<string>) =>
          Effect.suspend(() => {
            reads.push(`askedOf ${Arr.join(runs, ",")}`);
            return store.askedOf(runs);
          }),
      };
    }),
  );

/** One host over the state directory; a second call is that host restarted. */
const hosted = <A, E>(
  run: Effect.Effect<A, E, Registry | Store | HostServices | PlatformServices | Scope.Scope>,
  reads: Array<string> = [],
) =>
  run.pipe(
    Effect.provide(
      registryLayer(dir(), { placing: { herdr: new FakeHerdr(env()), env: env() } }).pipe(
        Layer.provide(readsCounted(reads)),
        Layer.provideMerge(
          agentsLayer({
            dir: dir(),
            env: env(),
            herdr: new FakeHerdr(env()),
            harness: "claude",
            model: "opus",
            permissions: "auto",
            compactAtTokens: 0,
            pollMs: 20,
            collectMs: 60_000,
          }),
        ),
        Layer.provideMerge(foundationLayer({ dir: dir(), userDir: rig.userDir })),
      ),
    ),
    Effect.scoped,
    Effect.orDie,
  );

const suspended = (runId: string) =>
  Registry.pipe(
    Effect.flatMap((registry) =>
      until(
        () => registry.view(runId),
        (view) => view?.status.status === "suspended" && view.waiting.length > 0,
      ),
    ),
    Effect.map((view) => view!),
  );

const refusal = (runId: string, decision: string | null) =>
  Registry.pipe(
    Effect.flatMap((registry) =>
      registry.answer({ runId, decision, value: "yes", request: `stale-${decision}` }),
    ),
    Effect.flip,
    Effect.map((refused) => refused.reason),
  );

test(
  "a superseded question is no Decision anywhere, refuses a stale answer, and survives a restart",
  () =>
    runEffect(
      Effect.gen(function* () {
        const runId = yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const asks = yield* registry.load(`${fixtures}/asks.workflow.ts`);
            const { runId } = yield* registry.start({
              generation: asks,
              request: "r1",
              project: rig.projectDir,
              input: { goal: "pick" },
              text: {},
              task: null,
            });
            const before = yield* suspended(runId);
            expect(describeWaiting(before)).toEqual([
              'waiting on "q1": Answer q1? (yes | no)',
              `  Hold the Run: collie run hold ${runId} --reason "held at question q1"`,
              "  ⚠ this workflow recommended none",
            ]);

            const superseded = yield* registry.supersede({
              runId,
              decision: "q1",
              cause: "delivery-1",
              by: { origin: "desktop" },
              agent: "planner",
            });
            expect(superseded._tag).toBe("accepted");

            const view = (yield* registry.view(runId))!;
            expect(describeWaiting(view)).toEqual([]);
            expect(nextAction(view)).toBeNull();
            expect(reached("attention", view, null, false)).not.toBe("reached");
            const facts = factsOfView(dir(), view);
            const now = yield* Clock.currentTimeMillis;
            expect((yield* runWaits(facts, [], [], now)).questions).toEqual([]);
            const [card] = Arr.filter(
              yield* buildBoard({
                env: env(),
                runs: [facts],
                tasks: [],
                registered: [],
                proposals: [],
                alive: [],
                mrStates: new Map(),
                forge: new Map(),
                offers: () => Effect.succeed([]),
              }),
              (one) => one.run === runId,
            );
            expect(card).toBeDefined();
            expect(card?.state).not.toBe("blocked");
            expect(card?.decision).toBeNull();

            expect(yield* refusal(runId, null)).toContain('"q1" was superseded');
            expect(yield* refusal(runId, "q1")).toContain("delivery-1");
            const audit = Arr.filter(
              yield* readAudit(runDir(dir(), runId)),
              (line) => line.operation === "supersede",
            );
            expect(audit).toHaveLength(1);
            expect(audit[0]).toMatchObject({
              request: "delivery-1",
              actor: { origin: "desktop" },
              result: { decision: "q1", agent: "planner" },
            });
            return runId;
          }),
        );

        yield* hosted(
          Effect.gen(function* () {
            const view = yield* suspended(runId);
            expect(Arr.map(view.waiting, (one) => one.name)).toEqual(["q1"]);
            expect(view.waiting[0]).toMatchObject({ answer: null, cause: "delivery-1" });
            expect(view.waiting[0]?.superseded).not.toBeNull();
            expect(describeWaiting(view)).toEqual([]);
          }),
        );
      }),
    ),
  120_000,
);

test(
  "a question asked again in its place is done in the Flow once its revision moves the Run on",
  () =>
    runEffect(
      hosted(
        Effect.gen(function* () {
          const registry = yield* Registry;
          const store = yield* Store;
          const asks = yield* registry.load(`${fixtures}/asks.workflow.ts`);
          const { runId } = yield* registry.start({
            generation: asks,
            request: "r1",
            project: rig.projectDir,
            input: { goal: "pick" },
            text: {},
            task: null,
          });
          yield* suspended(runId);
          yield* registry.supersede({
            runId,
            decision: "q1",
            cause: "delivery-1",
            by: { origin: "desktop" },
            agent: "planner",
          });
          const [q1] = yield* store.asked(runId);
          yield* store.revise({
            run: runId,
            decision: "q1",
            name: "q1.r2",
            messaged: q1!.messaged!,
          });
          yield* registry.answer({ runId, decision: "q1.r2", value: "yes", request: "a-1" });
          const view = yield* until(
            () => registry.view(runId),
            (one) => Arr.some(one?.waiting ?? [], (row) => row.name === "q2"),
          );

          const lane = yield* laneFor(env(), factsOfView(dir(), view!));
          const states = Arr.map(lane.nodes, (node) => [node.id, node.state]);
          expect(states).toContainEqual(["q1", "done"]);
          expect(states).toContainEqual(["q1.r2", "done"]);
        }),
      ),
    ),
  120_000,
);

test(
  "one pass over the human's messages reads its Runs' questions once, however many of them it acts on",
  () =>
    runEffect(
      Effect.gen(function* () {
        const reads: Array<string> = [];
        yield* hosted(
          Effect.gen(function* () {
            const registry = yield* Registry;
            const store = yield* Store;
            const asks = yield* registry.load(`${fixtures}/asks.workflow.ts`);
            const { runId } = yield* registry.start({
              generation: asks,
              request: "r1",
              project: rig.projectDir,
              input: { goal: "pick" },
              text: {},
              task: null,
            });
            yield* suspended(runId);
            for (const agent of ["planner", "reviewer"]) {
              yield* recordLaunch({
                agent,
                output: `${agent}.json`,
                reused: false,
                runId,
                operation: agent,
                role: agent,
                workflow: "asks",
                harness: "claude",
              });
              yield* recordClaudeEvent(
                yield* controlDir(dir(), agent),
                yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                  session_id: agent,
                  hook_event_name: "UserPromptSubmit",
                  prompt: `Over to you, ${agent}`,
                }).pipe(Effect.orDie),
              );
            }
            reads.length = 0;
            yield* registry.tendQuestions;

            const [q1] = yield* store.asked(runId);
            expect(q1?.superseded ?? null).not.toBeNull();
            expect(Arr.map(q1?.messaged ?? [], (one) => one.agent)).toEqual([
              "planner",
              "reviewer",
            ]);
            expect(Arr.filter(reads, Str.startsWith("asked "))).toEqual([]);
          }),
          reads,
        );
      }),
    ),
  120_000,
);
