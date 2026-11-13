import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { runFacts } from "../src/operations";
import { buildRunDetail } from "../src/views";
import { readEnv } from "../src/env";
import { madeRun } from "./support/records";
import { runEffect } from "./support/effect";

for (const surface of ["chat", "Desktop record"] as const)
  test(`${surface} retains park status and recovery actions`, () =>
    runEffect(
      Effect.gen(function* () {
        const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "collie-park-reader-",
        });
        const run = yield* madeRun(root, {
          state: "waiting",
          park: { cause: "herdr-unavailable", kind: "rechecks" },
          parked: "herdr is down",
          recovery: ["rechecked uncleared — herdr did not answer"],
        });
        const env = readEnv({ HERDR_PLUGIN_STATE_DIR: root, COLLIE_CWD: root });
        if (surface === "chat") {
          const text = yield* runFacts(env, run, [run], Effect.succeed([]));
          expect(text).toContain("Parked: herdr-unavailable · Collie rechecks");
          expect(text).toContain("rechecked uncleared — herdr did not answer");
          expect(
            yield* runFacts(
              env,
              { ...run, park: null, parked: null, state: "succeeded" },
              [run],
              Effect.succeed([]),
            ),
          ).toContain("rechecked uncleared — herdr did not answer");
        } else {
          const detail = yield* buildRunDetail({
            env,
            runId: run.id,
            runs: [run],
            mr: null,
            parts: false,
          });
          expect(detail).toMatchObject({
            park: { cause: "herdr-unavailable", kind: "rechecks" },
            recovery: ["rechecked uncleared — herdr did not answer"],
          });
        }
      }),
    ));
