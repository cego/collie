// A contract against an installed harness, rather than against a mock.

import { test } from "bun:test";
import { Config, Effect, FileSystem } from "effect";

/**
 * The test, where that harness is on this machine, and skipped where it is not. What
 * these ask — does the installed Claude still take the flag the adapter passes — has no
 * answer on a runner with no Claude on it, and asserting one there fails on the harness's
 * absence rather than on the contract.
 */
export const onMachineWith = (harness: string) => (Bun.which(harness) === null ? test.skip : test);

/** Removes, when the test's scope closes, the cache an installed harness keeps in `TMPDIR`. */
export const removesCache = Effect.fn("live.removesCache")(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const tmp = yield* Config.String("TMPDIR");
  yield* Effect.addFinalizer(() =>
    Effect.ignore(fs.remove(`${tmp}/${name}`, { recursive: true, force: true })),
  );
});
