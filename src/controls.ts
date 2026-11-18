import { Effect } from "effect";
import { RunRecords, type RunRecordsApi } from "./run-records";

export const HOLD = "hold";
export const STOP = "stop";

export const controlSet = (runId: string, ...controls: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const records = yield* RunRecords;
    for (const control of controls)
      if ((yield* records.control(control, runId)) !== null) return true;
    return false;
  });

export interface Control {
  readonly get: Effect.Effect<string | null>;
  readonly set: (data: string | null) => Effect.Effect<void>;
}

export const controlOf: (records: RunRecordsApi, control: string, runId: string) => Control = (
  records,
  control,
  runId,
) => ({
  get: records.control(control, runId),
  set: (data) => records.setControl(control, runId, data),
});
