import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { Effect, FileSystem, Schema } from "effect";
import { evidenceDir, runDir } from "./engine";
import { readAudit } from "./audit";
import { readFinalCard, REVIEW_ROLE } from "./cards";
import { checkProof } from "./check-proof";
import { readIntent } from "./intent";
import { readLaunches } from "./launches";
import { RunRecords } from "./run-records";
import { outputOf } from "./step-output";
import { readVerifications } from "./verify";
import { interventionsIn, ReviewedFinding } from "./trial-model";
import type { TrialRecords } from "./trial-model";

const ReviewedOutput = Schema.fromJsonString(
  Schema.Struct({ findings: Schema.optionalKey(Schema.Array(ReviewedFinding)) }),
);

export const trialRecordsOf = Effect.fn("Trial.records")(function* (
  stateDir: string,
  runId: string,
) {
  const records = yield* RunRecords;
  const dir = runDir(stateDir, runId);
  const reviews = yield* Effect.forEach(
    Arr.filter(yield* readLaunches(runId), (one) => one.role === REVIEW_ROLE),
    (one) =>
      Effect.gen(function* () {
        const held = yield* outputOf(records, one);
        return held === null
          ? Option.none()
          : Schema.decodeUnknownOption(ReviewedOutput)(held.text).pipe(
              Option.map((read) => read.findings ?? []),
            );
      }),
  );
  const final = Option.getOrUndefined(
    yield* readFinalCard(dir).pipe(Effect.orElseSucceed(() => Option.none())),
  );
  const required =
    (yield* readIntent(dir).pipe(Effect.orElseSucceed(() => null)))?.authority.run_verification ??
    [];
  const verifications = yield* readVerifications(evidenceDir(stateDir, runId)).pipe(
    Effect.orElseSucceed(() => []),
  );
  const passedOn = (final: { readonly head_sha: string; readonly fingerprint: string }) =>
    Arr.filter(required, (check) => {
      const { state } = checkProof({ verifications, final, approved: required }, check.name);
      return state === "passed" || state === "proved";
    }).length;
  return {
    reviews: Arr.getSomes(reviews),
    checks: final === undefined ? null : { passed: passedOn(final.revision), of: required.length },
    interventions: interventionsIn(
      runId,
      yield* readAudit(dir).pipe(Effect.orElseSucceed(() => [])),
    ),
    ended: final?.at ?? null,
  } satisfies TrialRecords;
});
