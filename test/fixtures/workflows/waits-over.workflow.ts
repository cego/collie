import { Host, Run, defineWorkflow, leaveFindings } from "collie";
import type { FollowUp } from "collie";
import { Effect, Schema } from "effect";

const carryOver: FollowUp = {
  id: "carry-over",
  title: "Carry over",
  workflow: "holding",
  when: "succeeded",
  selects: "many",
  inputs: { findings: "findings" },
  eligible: (facts) => facts.openFindings > 0,
};

export default defineWorkflow({
  id: "waits-over",
  title: "Leave three findings and offer to carry them over",
  description: "Settles with three findings, and offers a Run per choice that waits to be told.",
  input: Schema.Struct({ note: Schema.String }),
  hints: { note: "goal" },
  output: Schema.String,
  followUps: [carryOver],
  run: () =>
    Effect.gen(function* () {
      const run = yield* Run;
      const { dir } = yield* (yield* Host).place(run.id);
      yield* leaveFindings(dir, [
        { severity: "major", title: "The first" },
        { severity: "major", title: "The second" },
        { severity: "minor", title: "The third" },
      ]);
      return "left three findings";
    }),
});
