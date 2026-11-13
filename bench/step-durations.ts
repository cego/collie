// Pair a long Run's Step history through the same duration recording API as the host.
import { strict as assert } from "node:assert";
import { Console, DateTime, Effect, FileSystem, Schema } from "effect";
import { platformLayer } from "../src/platform";
import { rememberStepDurations, usualStepTimes } from "../src/step-durations";
import type { StepLine } from "../src/steps";

const lines: StepLine[] = [];
for (let n = 0; n < 10_000; n++) {
  const at = n * 2000;
  lines.push(
    {
      kind: "enter",
      key: String(n),
      at: DateTime.formatIso(DateTime.makeUnsafe(at)),
      step: {
        id: `step-${n % 8}`,
        title: "",
        description: "",
        kind: "check",
        role: null,
        produces: null,
      },
      place: null,
    },
    { kind: "leave", key: String(n), at: DateTime.formatIso(DateTime.makeUnsafe(at + 1000)) },
  );
}

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-duration-bench-" });
    for (let run = 0; run < 3; run++)
      yield* rememberStepDurations(dir, String(run), "bench", lines);
    const times = yield* usualStepTimes(dir, "bench");
    assert.equal(times.size, 8);
    for (const ms of times.values()) assert.equal(ms, 1000);
    yield* Console.log(
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        steps: lines.length / 2,
        medians: times.size,
      }),
    );
  }).pipe(Effect.scoped, Effect.provide(platformLayer)),
);
