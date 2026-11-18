/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/global-console, no-restricted-globals, effecttsgo/prefer-effect-array, effecttsgo/prefer-schema-over-json -- an offline benchmark's driver, on its own copy of a state directory. */
import { Effect, ManagedRuntime } from "effect";
import { buildBoard } from "../../src/board";
import { readEnv } from "../../src/env";
import { platformLayer } from "../../src/platform";
import { recordsAt } from "../../src/records";
import { factsOfView } from "../../src/runs";
import { stringifyJson } from "../../src/json";

if (Bun.argv.slice(2).some((arg) => arg !== "--open")) process.exit(2);
Bun.env.COLLIE_HOST = "/bin/false";

const NOW = Date.parse("2026-11-16T16:00:00Z");
const root = new URL("../../", import.meta.url).pathname;
const work = `${root}.scratch/board-reads`;
const state = `${work}/state`;
Bun.env.PATH = `${work}/bin:${Bun.env.PATH}`;
Bun.env.HOME = `${work}/home`;

const runtime = ManagedRuntime.make(platformLayer);
const opened = performance.now();
const result = await runtime.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const open_ms = performance.now() - opened;
      if (Bun.argv.includes("--open")) return { open_ms };
      const env = readEnv({
        HERDR_PLUGIN_STATE_DIR: state,
        COLLIE_CWD: root,
        HOME: `${work}/home`,
      });
      const listed: { data: { runs: Array<Parameters<typeof factsOfView>[1]> } } =
        yield* Effect.promise(() => Bun.file(`${work}/views.json`).json());
      const runs = listed.data.runs.map((view) => factsOfView(state, view));
      const build = buildBoard({ env, runs, now: NOW, offers: () => Effect.succeed([]) });
      const first = performance.now();
      yield* build;
      const second = performance.now();
      const views = yield* build;
      const update_ms = performance.now() - second;
      return {
        open_ms,
        first_ms: second - first,
        update_ms,
        runs: runs.length,
        tasks: views.length,
        digest: Number(
          BigInt(
            Bun.hash(
              stringifyJson(
                views.map((view) => [
                  view.id,
                  view.name,
                  view.state,
                  view.landed,
                  view.ended,
                  view.mr,
                  view.held,
                  view.run,
                  view.runs,
                ]),
              ),
            ),
          ) % 1_000_000_007n,
        ),
      };
    }).pipe(Effect.provide(recordsAt(state))),
  ),
);
await runtime.dispose();
console.log(stringifyJson(result));
