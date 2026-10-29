// `bun tools/timings-seed.ts <test-timings.json>…`: writes `tools/test-timings.json` from the
// shard records of several green CI runs, each file at its mean. One run's records carry
// how fast its runners happened to be, which then unbalances every later split.

import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect } from "effect";
import { seedFrom } from "./test-run";

const records = process.argv.slice(2);

BunRuntime.runMain(
  (records.length === 0
    ? Effect.die("usage: bun tools/timings-seed.ts <test-timings.json>…")
    : seedFrom(records, `${import.meta.dir}/test-timings.json`)
  ).pipe(Effect.provide(BunServices.layer)),
);
