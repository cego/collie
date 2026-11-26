import { Effect } from "effect";
import { encodeCheckRecord } from "../src/check-processes";
import type { CheckRecord } from "../src/check-processes";
import { RUNNING_CHECK, RunRecords } from "../src/run-records";
import type { RunFacts } from "../src/runs";

export const recordedCheck = (
  run: RunFacts,
  id: string,
  name = "lint",
  over: Partial<CheckRecord> = {},
) =>
  Effect.gen(function* () {
    yield* (yield* RunRecords).setControl(
      RUNNING_CHECK,
      "",
      encodeCheckRecord({
        id,
        run: run.id,
        name,
        pass: "recheck",
        by: "collie",
        leader: { pid: 4242, started: "1", group: 4242 },
        host: { pid: 4241, started: "1" },
        started: "2026-09-14T10:03:00Z",
        ...over,
      }),
      id,
    );
  });
