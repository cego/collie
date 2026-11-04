import { expect, test } from "bun:test";
import { Config, Effect } from "effect";
import { HOLD_ENV } from "../tools/budget";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";

/** One fixture file under the suite's own preloads, in a `bun test` of its own, on this test's hold. */
const fixture = (name: string) =>
  Effect.gen(function* () {
    const hold = yield* Config.String(HOLD_ENV).pipe(Config.withDefault("nested"));
    return yield* exec(["bun", "test", `./test/fixtures/solid/${name}`], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, [HOLD_ENV]: hold },
    });
  });

test("a test file that loads no .tsx does not load the Solid transform", () =>
  runEffect(
    Effect.gen(function* () {
      const ran = yield* fixture("plain.fixture.ts");
      expect([ran.exitCode, ran.stdout + ran.stderr]).toEqual([
        0,
        expect.stringContaining(" 1 pass"),
      ]);
    }),
  ));

test("a test file that loads a .tsx has it compiled by the Solid transform", () =>
  runEffect(
    Effect.gen(function* () {
      const ran = yield* fixture("tsx.fixture.ts");
      expect([ran.exitCode, ran.stdout + ran.stderr]).toEqual([
        0,
        expect.stringContaining(" 1 pass"),
      ]);
    }),
  ));
