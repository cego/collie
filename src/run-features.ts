// What a Run's workflow does, fixed when the Run starts. A Run with no record started on an
// earlier release, and resumes doing what that release did, so its replay meets nothing new.

import { Effect, Schema } from "effect";
import { readConfig } from "./config";
import type { YamlMap } from "./yaml";
import { RunRecords } from "./run-records";

export const FEATURES_FILE = "features.json";

export const RunFeatures = Schema.Struct({
  /** Follow-up review rounds are told the prior head, what changed since and what is open. */
  review_delta: Schema.optionalKey(Schema.Boolean),
  /** Implement's review rounds give findings ledger ids. */
  findings_ledger: Schema.optionalKey(Schema.Boolean),
  /** An implement Run plans a source that is not a plan before building it. */
  inline_plan: Schema.optionalKey(Schema.Boolean),
});
export type RunFeatures = typeof RunFeatures.Type;

const FeaturesJson = Schema.fromJsonString(RunFeatures);

export const CURRENT_FEATURES: RunFeatures = { review_delta: true, findings_ledger: true };

export const recordFeatures = Effect.fn("RunFeatures.record")(function* (
  run: string,
  userDir: string,
) {
  const config = yield* readConfig(userDir).pipe(Effect.orElseSucceed((): YamlMap => ({})));
  const features = { ...CURRENT_FEATURES, inline_plan: config.inline_plan === "on" };
  const text = yield* Schema.encodeEffect(FeaturesJson)(features).pipe(Effect.orDie);
  yield* RunRecords.use((records) => records.put(run, FEATURES_FILE, text));
});

/** The features a Run started with; one with no record, or an unreadable one, has none. */
export const featuresOf = (run: string) =>
  RunRecords.use((records) => records.fact(run, FEATURES_FILE)).pipe(
    Effect.flatMap((text) =>
      text === null ? Effect.succeed({}) : Schema.decodeEffect(FeaturesJson)(text),
    ),
    Effect.orElseSucceed((): RunFeatures => ({})),
  );
