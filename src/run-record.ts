import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { Effect, FileSystem, Path, Schema } from "effect";
import { runDir } from "./engine";
import { IntentSchema } from "./intent";
import { MetricSchema } from "./metrics";
import { CardSchema } from "./cards";
import { DriftLineSchema } from "./drift";
import { VerificationSchema } from "./verify";
import { RunningCheck, Disposition } from "./board-model";

export const RunMetrics = Schema.Array(MetricSchema);
export const RunCards = Schema.Array(CardSchema);
export const RunDrift = Schema.Array(DriftLineSchema);
export const RunIntent = Schema.NullOr(IntentSchema);
export const RunDispositions = Schema.Array(Disposition);
export const RunOutputs = Schema.Array(
  Schema.Struct({
    path: Schema.String,
    value: Schema.optionalKey(Schema.Json),
    error: Schema.optionalKey(Schema.String),
  }),
);
export const DoneCheck = Schema.Struct({
  name: Schema.String,
  pass: Schema.String,
  round: Schema.NullOr(Schema.Int),
  result: Schema.String,
  seconds: Schema.Finite,
  revision: Schema.String,
  at: Schema.String,
  log: Schema.NullOr(Schema.String),
});
export const RunChecks = Schema.Struct({
  running: Schema.NullOr(RunningCheck),
  done: Schema.Array(DoneCheck),
});
export const CheckEvent = Schema.Union([
  Schema.TaggedStruct("Output", { text: Schema.String }),
  Schema.TaggedStruct("Ended", { check: Schema.NullOr(VerificationSchema) }),
]);

export const outputsOf = Effect.fn("RunRecord.outputs")(function* (state: string, run: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = runDir(state, run);
  const root = yield* fs.realPath(dir).pipe(Effect.orElseSucceed(() => dir));
  const files: string[] = [];
  const walk = (at: string, depth: number): Effect.Effect<void, never, FileSystem.FileSystem> =>
    Effect.gen(function* () {
      if (depth > 4) return;
      for (const name of yield* fs.readDirectory(at).pipe(Effect.orElseSucceed(() => []))) {
        const file = path.join(at, name);
        const real = yield* fs.realPath(file).pipe(Effect.orElseSucceed(() => ""));
        const relative = path.relative(root, real);
        if (
          real === "" ||
          relative === ".." ||
          pipe_(relative, Str.startsWith(`..${path.sep}`)) ||
          path.isAbsolute(relative)
        )
          continue;
        const info = yield* fs.stat(file).pipe(Effect.orElseSucceed(() => null));
        if (info?.type === "Directory") yield* walk(file, depth + 1);
        else if (info !== null && pipe_(name, Str.endsWith(".json"))) files.push(file);
      }
    });
  yield* walk(dir, 0);
  return yield* Effect.forEach(files.sort(), (file) =>
    fs.readFileString(file).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))),
      Effect.map((value) => ({ path: path.relative(dir, file), value })),
      Effect.catch((cause) =>
        Effect.succeed({ path: path.relative(dir, file), error: String(cause) }),
      ),
    ),
  );
});
