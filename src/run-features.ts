// What a Run's workflow does, fixed when the Run starts. A Run with no record started on an
// earlier release, and resumes doing what that release did, so its replay meets nothing new.

import { Effect, Schema } from "effect";
import { RunRecords } from "./run-records";

export const FEATURES_FILE = "features.json";

export const RunFeatures = Schema.Struct({
  /** Follow-up review rounds are told the prior head, what changed since and what is open. */
  review_delta: Schema.optionalKey(Schema.Boolean),
});
export type RunFeatures = typeof RunFeatures.Type;

const FeaturesJson = Schema.fromJsonString(RunFeatures);

export const CURRENT_FEATURES: RunFeatures = { review_delta: true };

export const recordFeatures = (run: string) =>
  Effect.flatMap(Schema.encodeEffect(FeaturesJson)(CURRENT_FEATURES).pipe(Effect.orDie), (text) =>
    RunRecords.use((records) => records.put(run, FEATURES_FILE, text)),
  );

/** The features a Run started with; one with no record, or an unreadable one, has none. */
export const featuresOf = (run: string) =>
  RunRecords.use((records) => records.fact(run, FEATURES_FILE)).pipe(
    Effect.flatMap((text) =>
      text === null ? Effect.succeed({}) : Schema.decodeEffect(FeaturesJson)(text),
    ),
    Effect.orElseSucceed((): RunFeatures => ({})),
  );
