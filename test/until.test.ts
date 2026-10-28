import { expect, test } from "bun:test";
import { Cause, ConfigProvider, Effect, Exit, Fiber, FileSystem } from "effect";
import { TestClock } from "effect/testing";
import { runEffect } from "./support/effect";
import { until } from "./support/host";

test("an until that runs out names its wait, the last value it read, and the end of the host's log", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const state = yield* fs.makeTempDirectoryScoped({ prefix: "until-" });
      const lines = Array.from({ length: 100 }, (_, at) => `log line ${at + 1}`);
      yield* fs.writeFileString(`${state}/host.log`, `${lines.join("\n")}\n`);
      let reads = 0;
      const waiting = yield* until(
        () => Effect.sync(() => ({ runs: [`run-${++reads}`] })),
        (now) => now.runs.includes("run-new"),
      ).pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ HERDR_PLUGIN_STATE_DIR: state })),
        ),
        Effect.forkScoped,
      );
      yield* TestClock.adjust("1 minute");
      const exit = yield* Fiber.await(waiting);

      expect(Exit.isFailure(exit)).toBe(true);
      const said = Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";
      expect(said).toContain('now.runs.includes("run-new")');
      expect(said).toContain(`run-${reads}`);
      expect(said).toContain("log line 100");
      expect(said).not.toContain("log line 1\n");
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  ));
