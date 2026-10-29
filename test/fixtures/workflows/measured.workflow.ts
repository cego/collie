// One Measurement through `host.measure`, answering with its id and how the outcome table
// reads the Run as `performance` afterwards.

import { Host, Run, defineWorkflow, endsWithoutPatchOf, evidenceGapsOf } from "collie";
import { Effect, Schema } from "effect";

export default defineWorkflow({
  id: "measured",
  title: "Measure a plan once",
  description: "Asks the host for one Measurement of this Run's checkout against a base.",
  input: Schema.Struct({ base: Schema.String, plan: Schema.String, pass: Schema.String }),
  hints: { base: "goal" },
  outcome: { fixed: "performance" },
  output: Schema.String,
  run: ({ input }) =>
    Effect.gen(function* () {
      const runId = (yield* Run).id;
      const host = yield* Host;
      const { cwd } = yield* host.place(runId);
      const { measurement } = yield* host.measure({
        runId,
        base: input.base,
        cwd,
        plan: JSON.parse(input.plan),
        pass: input.pass,
      });
      const asked = {
        kind: "performance" as const,
        evidence: yield* host.evidence(runId, cwd),
        approved: [],
        outputs: {},
        reviewed: [],
        roots: [],
        tickets: [],
      };
      return JSON.stringify({
        id: measurement.id,
        withoutPatch: endsWithoutPatchOf(asked),
        gaps: evidenceGapsOf(asked),
      });
    }),
});
