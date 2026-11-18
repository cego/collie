import { Effect, Schema } from "effect";
import { RunRecords } from "./run-records";

export const FEATURES_FILE = "features.json";

export const RunFeatures = Schema.Struct({
  review_delta: Schema.optionalKey(Schema.Boolean),
});
export type RunFeatures = typeof RunFeatures.Type;

const FeaturesJson = Schema.fromJsonString(RunFeatures);

export const CURRENT_FEATURES: RunFeatures = { review_delta: true };

export const recordFeatures = (run: string) =>
  Effect.flatMap(Schema.encodeEffect(FeaturesJson)(CURRENT_FEATURES).pipe(Effect.orDie), (text) =>
    RunRecords.use((records) => records.put(run, FEATURES_FILE, text)),
  );

export const featuresOf = (run: string) =>
  RunRecords.use((records) => records.fact(run, FEATURES_FILE)).pipe(
    Effect.flatMap((text) =>
      text === null ? Effect.succeed({}) : Schema.decodeEffect(FeaturesJson)(text),
    ),
    Effect.orElseSucceed(() => ({})),
  );
