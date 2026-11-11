// A Heal's resume is refused where the Stop is cleared, under the permit a Stop is set
// under, so a person's Stop that lands while the resume is on its way still stands.

import { afterEach, beforeEach, expect, test } from "bun:test";
import type { PlatformServices } from "../src/platform";
import { Effect, FileSystem, Layer, type Scope } from "effect";
import { Rig, FakeHerdr } from "./support/recorder";
import { fastForward, runEffect as runLive } from "./support/effect";
import { installFakeSkills } from "./support/defs";
import { fixtures, until } from "./support/host";
import { agentsLayer } from "../src/agents";
import { Registry, foundationLayer, registryLayer, type HostServices } from "../src/engine";
import { STOP } from "../src/controls";

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

const runEffect = <A, E>(effect: Effect.Effect<A, E, PlatformServices>) =>
  runLive(fastForward(effect));

const hosted = <A, E>(
  run: Effect.Effect<A, E, Registry | HostServices | PlatformServices | Scope.Scope>,
) =>
  run.pipe(
    Effect.provide(
      registryLayer(env().stateDir, { placing: { herdr: new FakeHerdr(env()), env: env() } }).pipe(
        Layer.provideMerge(
          agentsLayer({
            dir: env().stateDir,
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
        Layer.provideMerge(foundationLayer({ dir: env().stateDir, userDir: rig.userDir })),
      ),
    ),
    Effect.scoped,
    Effect.orDie,
  );

test(
  "a resume that keeps a Stop is refused on a stopped Run, and the Stop stands",
  () =>
    runEffect(
      hosted(
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
          yield* until(
            () => registry.view(runId),
            (view) => view?.status.status === "suspended",
          );
          yield* registry.control({ runId, control: STOP, set: true });
          expect(yield* registry.resume(runId, undefined, "park-1")).toMatchObject({
            applied: false,
            detail: expect.stringContaining("a person stopped it"),
          });
          expect((yield* registry.view(runId))?.controls).toContain(STOP);
        }),
      ),
    ),
  60_000,
);
