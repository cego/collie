import { expect, test } from "bun:test";
import { Clock, Effect, FileSystem, Layer, Option } from "effect";
import { TestClock } from "effect/testing";
import { foundationLayer, loadEntry } from "../src/engine";
import { Store } from "../src/store";
import { laneFor } from "../src/flow-read";
import { readStepLines } from "../src/steps";
import { readEnv } from "../src/env";
import { runFacts } from "./support/records";
import { runEffect } from "./support/effect";
import { fixtures, root, until } from "./support/host";
import { Rig, FakeHerdr } from "./support/recorder";
import { agentsLayer } from "../src/agents";
import { Children, Host } from "../src/sdk";
import { buildBoard } from "../src/board";
import { sectionOf, type Flow } from "../src/board-model";
import { ensureStepDurations } from "../src/step-durations";

test(
  "the host learns B from three completed Runs and keeps its usual time after their records go",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const rig = yield* Rig.scoped();
        const dir = rig.stateDir;
        const entry = `${dir}/step-times.workflow.ts`;
        yield* fs.copyFile(`${fixtures}/step-times.workflow.ts`, entry);
        const clock = yield* TestClock.make();
        const env = readEnv({
          HERDR_PLUGIN_ROOT: root,
          HERDR_PLUGIN_STATE_DIR: dir,
          COLLIE_CWD: dir,
        });
        yield* Effect.gen(function* () {
          const store = yield* Store;
          const loaded = yield* loadEntry(entry);
          const made = loaded.make("step-times@1");
          const start = (id: string, registered = made, workflow = loaded.id) =>
            Effect.gen(function* () {
              const input = { goal: "time", gate: `${dir}/${id}.gate` };
              yield* store.admit({
                request: id,
                run: id,
                workflow,
                project: dir,
                input,
                provenance: {},
                options: {},
                generation: registered.workflow.name,
                execution: id,
                task: null,
                parent: null,
              });
              const payload = { runId: id, input };
              yield* registered.workflow.execute(payload, { discard: true });
              yield* until(
                () => readStepLines(`${dir}/runs/${id}`),
                (lines) => lines.some((one) => one.kind === "enter"),
              );
              return payload;
            });
          const finish = (id: string, minutes: number, registered = made, workflow = loaded.id) =>
            Effect.gen(function* () {
              const payload = yield* start(id, registered, workflow);
              yield* clock.adjust(minutes * 60_000);
              yield* fs.writeFileString(payload.input.gate, "");
              const execution = yield* registered.workflow.executionId(payload);
              yield* until(() => registered.workflow.poll(execution), Option.isSome);
            });
          const read = (id: string) =>
            laneFor(
              env,
              runFacts({
                id,
                workflow: loaded.id,
                dir: `${dir}/runs/${id}`,
                evidence: `${dir}/evidence/${id}`,
              }),
            ).pipe(Effect.provideService(Clock.Clock, clock));
          yield* Effect.gen(function* () {
            yield* finish("one", 10);
            yield* finish("two", 12);
            const otherEntry = `${dir}/other-times.workflow.ts`;
            yield* fs.writeFileString(
              otherEntry,
              (yield* fs.readFileString(entry)).replace('id: "step-times"', 'id: "other-times"'),
            );
            const other = (yield* loadEntry(otherEntry)).make("other-times@1");
            yield* finish("other", 120, other, "other-times").pipe(Effect.provide(other.layer));
            const third = yield* start("three");
            expect((yield* read("three")).nodes[0]!.usual).toBeNull();
            yield* clock.adjust(14 * 60_000);
            yield* fs.writeFileString(third.input.gate, "");
            const execution = yield* made.workflow.executionId(third);
            yield* until(() => made.workflow.poll(execution), Option.isSome);
            yield* start("four");
            expect((yield* read("four")).nodes[0]!.usual).toBe(12 * 60_000);
            yield* fs.remove(`${dir}/step-durations.json`);
            yield* ensureStepDurations(dir, yield* store.runs);
            expect((yield* read("four")).nodes[0]!.usual).toBe(12 * 60_000);
            for (const id of ["one", "two", "three"])
              yield* fs.remove(`${dir}/runs/${id}`, { recursive: true });
            expect((yield* read("four")).nodes[0]!.usual).toBe(12 * 60_000);
            const board = () =>
              Effect.gen(function* () {
                const flows = new Map<string, Flow>();
                const cards = yield* buildBoard({
                  env,
                  flows,
                  runs: [
                    runFacts({
                      id: "four",
                      workflow: loaded.id,
                      dir: `${dir}/runs/four`,
                      evidence: `${dir}/evidence/four`,
                    }),
                  ],
                  tasks: [],
                  registered: [],
                  alive: [],
                  proposals: [],
                  mrStates: new Map(),
                  offers: () => Effect.succeed([]),
                });
                return { card: cards[0]!, flow: [...flows.values()][0]! };
              }).pipe(Effect.provideService(Clock.Clock, clock));
            yield* clock.adjust(23 * 60_000);
            const before = yield* board();
            expect(before.flow.lanes[0]!.nodes[0]!.long).toBe(false);
            expect(before.flow.notice).toBeNull();
            yield* clock.adjust(2 * 60_000);
            const after = yield* board();
            expect(after.flow.lanes[0]!.nodes[0]).toMatchObject({
              long: true,
              said: "Longer than usual",
            });
            expect(after.flow.notice).toBe("B is taking longer than usual: 25 min, usually 12.");
            expect(after.card.sentence).toBe(before.card.sentence);
            expect(sectionOf(after.card)).toBe(sectionOf(before.card));
          }).pipe(Effect.provide(made.layer));
        }).pipe(
          Effect.provide(
            agentsLayer({
              dir,
              env: rig.pluginEnv(),
              herdr: new FakeHerdr(rig.pluginEnv()),
              harness: "claude",
              model: "opus",
              permissions: "auto",
              compactAtTokens: 0,
            }),
          ),
          Effect.provide(
            Layer.succeed(Children)(
              Children.of({
                start: () => Effect.die("no child in this fixture"),
                result: () => Effect.die("no child in this fixture"),
              }),
            ),
          ),
          Effect.provide(
            Layer.effect(Host)(
              Effect.gen(function* () {
                const host = yield* Host;
                return Host.of({
                  ...host,
                  step: (id, note) =>
                    host.step(id, note).pipe(Effect.provideService(Clock.Clock, clock)),
                });
              }),
            ).pipe(Layer.provideMerge(foundationLayer({ dir }))),
          ),
          Effect.scoped,
        );
      }).pipe(Effect.orDie),
    ),
  120_000,
);
