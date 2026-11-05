// `bun tools/suite-bench.ts`: one whole `bun run test`, its output passed through to stderr and
// its exit code kept, then what a Measurement judges as the last stdout line (#215).

import { BunRuntime } from "@effect/platform-bun";
import { Console, Effect, Schema } from "effect";

const SuiteReadings = Schema.Struct({
  own_ms: Schema.Finite,
  queued_ms: Schema.Finite,
  passed: Schema.Finite,
  failed: Schema.Finite,
});
type SuiteReadings = typeof SuiteReadings.Type;

const ms = (seconds: string) => Math.round(Number(seconds) * 1000);

/** The runner's `test: queued …` line and Bun's summary; a missing one is an error, never a zero. */
export const suiteReadings = (
  output: string,
): { ok: true; readings: SuiteReadings } | { ok: false; error: string } => {
  const timed = /^test: queued ([\d.]+) s, built ([\d.]+) s, ran ([\d.]+) s$/m.exec(output);
  if (timed === null)
    return { ok: false, error: "no `test: queued …, built …, ran …` line in the suite's output" };
  const passed = /^ *(\d+) pass$/m.exec(output);
  const failed = /^ *(\d+) fail$/m.exec(output);
  if (passed === null || failed === null)
    return { ok: false, error: "no Bun `N pass` and `N fail` summary in the suite's output" };
  return {
    ok: true,
    readings: {
      own_ms: ms(timed[2]!) + ms(timed[3]!),
      queued_ms: ms(timed[1]!),
      passed: Number(passed[1]),
      failed: Number(failed[1]),
    },
  };
};

const passedThrough = (stream: ReadableStream<Uint8Array>) => {
  const decoder = new TextDecoder();
  let text = "";
  return stream
    .pipeTo(
      new WritableStream({
        write: (chunk) => {
          process.stderr.write(chunk);
          text += decoder.decode(chunk, { stream: true });
        },
      }),
    )
    .then(() => text);
};

if (import.meta.main)
  BunRuntime.runMain(
    Effect.gen(function* () {
      const child = Bun.spawn(["bun", "run", "test"], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err, exit] = yield* Effect.promise(() =>
        Promise.all([passedThrough(child.stdout), passedThrough(child.stderr), child.exited]),
      );
      const read = suiteReadings(`${out}\n${err}`);
      if (!read.ok) {
        yield* Console.error(`suite-bench: ${read.error}`);
        return exit === 0 ? 1 : exit;
      }
      yield* Console.log(
        yield* Schema.encodeEffect(Schema.fromJsonString(SuiteReadings))(read.readings),
      );
      return exit;
    }).pipe(Effect.flatMap((code) => Effect.sync(() => process.exit(code)))),
  );
