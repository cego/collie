// WARNING: fixed at start: a Run with no record started on an earlier release, so its replay meets nothing new.
import { Effect, Schema } from "effect";
import { readConfig } from "./config";
import type { YamlMap } from "./yaml";
import { RunRecords } from "./run-records";

export const FEATURES_FILE = "features.json";

export const RunFeatures = Schema.Struct({
  review_delta: Schema.optionalKey(Schema.Boolean),
  findings_ledger: Schema.optionalKey(Schema.Boolean),
  inline_plan: Schema.optionalKey(Schema.Boolean),
  agent_sessions: Schema.optionalKey(Schema.Literals(["run", "ticket", "round"])),
  before_review: Schema.optionalKey(Schema.Boolean),
});
export type RunFeatures = typeof RunFeatures.Type;

const FeaturesJson = Schema.fromJsonString(RunFeatures);

export const CURRENT_FEATURES: RunFeatures = {
  review_delta: true,
  findings_ledger: true,
  before_review: true,
};

export const recordFeatures = Effect.fn("RunFeatures.record")(function* (
  run: string,
  userDir: string,
) {
  const config = yield* readConfig(userDir).pipe(
    Effect.orElseSucceed(() => {
      const none: YamlMap = {};
      return none;
    }),
  );
  const features: RunFeatures = {
    ...CURRENT_FEATURES,
    inline_plan: config.inline_plan === "on",
    agent_sessions:
      config.agent_sessions === "ticket" || config.agent_sessions === "round"
        ? config.agent_sessions
        : "run",
  };
  const text = yield* Schema.encodeEffect(FeaturesJson)(features).pipe(Effect.orDie);
  yield* RunRecords.use((records) => records.put(run, FEATURES_FILE, text));
});

export const featuresOf = (run: string) =>
  RunRecords.use((records) => records.fact(run, FEATURES_FILE)).pipe(
    Effect.flatMap((text) =>
      text === null ? Effect.succeed({}) : Schema.decodeEffect(FeaturesJson)(text),
    ),
    Effect.orElseSucceed(() => ({})),
  );
