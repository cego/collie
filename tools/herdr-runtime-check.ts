#!/usr/bin/env bun
// Whether the herdr that is actually installed has what the Herd's Home rests on.
//
//   bun run tools/herdr-runtime-check.ts
//
// Distinct from `contract:check`, which compares Collie's decoders against the *pinned*
// schema — what Collie was built against. This asks the binary in front of us, because a
// release older than the pin runs this code too, and the only honest answer then is to
// refuse rather than fall back to owning a workspace by its label.

import { BunServices } from "@effect/platform-bun";
import { Effect, ManagedRuntime } from "effect";
import { currentEnv } from "../src/env";
import { Herdr } from "../src/herdr";
import { REQUIRED_FIELDS, REQUIRED_RUNTIME, missingRuntime } from "../src/home";

const runtime = ManagedRuntime.make(BunServices.layer);

const check = Effect.fn("runtimeCheck")(function* () {
  const herdr = new Herdr(yield* currentEnv);
  const schema = yield* herdr.apiSchema().pipe(Effect.catch(() => Effect.succeed("")));
  if (schema === "") {
    yield* Effect.logError("herdr could not be asked for its schema");
    return 1;
  }
  // The table says what the gate decided, name by name. It used to check each row with
  // its own `includes`, which is neither what `missingRuntime` asks nor as strict — and a
  // table that disagrees with the gate is worse than no table.
  const missing = missingRuntime(schema);
  const rows = [
    ...REQUIRED_RUNTIME,
    ...REQUIRED_FIELDS.map(([type, field]) => `${type}.${field}`),
  ].map((name) => `| ${name} | ${missing.includes(name) ? "MISSING" : "present"} |`);
  yield* Effect.log(
    ["", "| what the Home needs | in the installed herdr |", "|---|---|", ...rows, ""].join("\n"),
  );
  if (missing.length > 0) {
    yield* Effect.logError(`herdr_capability_missing:${missing.join(",")}`);
    return 1;
  }
  return 0;
});

process.exitCode = await runtime.runPromise(check().pipe(Effect.orDie));
