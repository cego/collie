// The controls an operator sets over a Run, as the host keeps them: one row each.

import { Effect } from "effect";
import { RunRecords, type RunRecordsApi } from "./run-records";

export const HOLD = "hold";
export const STOP = "stop";

/** Whether any of `controls` is set over the Run. */
export const controlSet = (
  runId: string,
  ...controls: ReadonlyArray<string>
): Effect.Effect<boolean, never, RunRecords> =>
  Effect.gen(function* () {
    const records = yield* RunRecords;
    for (const control of controls)
      if ((yield* records.control(control, runId)) !== null) return true;
    return false;
  });

/** One control over one Run, read and set. */
export interface Control {
  readonly get: Effect.Effect<string | null>;
  readonly set: (data: string | null) => Effect.Effect<void>;
}

export const controlOf = (records: RunRecordsApi, control: string, runId: string): Control => ({
  get: records.control(control, runId),
  set: (data) => records.setControl(control, runId, data),
});
