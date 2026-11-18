import { test } from "bun:test";
import { Config, Effect, FileSystem } from "effect";
import { LIVE_HARNESSES } from "./live-switch";

export const onMachineWith = (harness: string) =>
  Bun.env[LIVE_HARNESSES] === "1" && Bun.which(harness) !== null ? test : test.skip;

export const removesCache = Effect.fn("live.removesCache")(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const tmp = yield* Config.String("TMPDIR");
  yield* Effect.addFinalizer(() =>
    Effect.ignore(fs.remove(`${tmp}/${name}`, { recursive: true, force: true })),
  );
});
