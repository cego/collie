import { Host, Run, defineWorkflow, leaveFindings } from "collie";
import { Effect, Schema } from "effect";
import { fileToLinear, implementSelected } from "./selected.ts";

export default defineWorkflow({
  id: "submits",
  title: "Submit findings and an offer over them",
  description: "Settles with findings it offers to build, one at a time or all chosen.",
  connections: {
    uses: { linear: { with: "Files a finding as an issue", without: "Keeps them here" } },
  },
  input: Schema.Struct({ note: Schema.String }),
  hints: { note: "goal" },
  output: Schema.String,
  followUps: [
    implementSelected,
    {
      id: "build-one",
      title: "Build one",
      workflow: "implement",
      when: "succeeded",
      selects: "one",
      inputs: { plan: "run-dir", goal: "finding" },
      eligible: (facts) => facts.openFindings > 0,
    },
    fileToLinear,
  ],
  run: () =>
    Effect.gen(function* () {
      const run = yield* Run;
      const { dir } = yield* (yield* Host).place(run.id);
      yield* leaveFindings(dir, [
        {
          severity: "major",
          title: "The first",
          file: "src/first.ts",
          line: 4,
          basis: "fact",
          evidence: "the log names it twice",
        },
        { severity: "major", title: "The second" },
        { severity: "minor", title: "The third" },
      ]);
      return "left findings";
    }),
});
