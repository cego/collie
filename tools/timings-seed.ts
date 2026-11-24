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
