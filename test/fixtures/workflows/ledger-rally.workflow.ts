// The shipped rally over a local checkout, given a findings ledger that starts empty as an
// implement ticket's does. It answers with the last review's findings, ids and statuses.

import { FixOutputSchema, Host, Run, agentWork, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import { FIX_PROMPT, NO_MR, REVIEWER, ROUNDS, rally } from "../../../workflows/reviewing.ts";

export default defineWorkflow({
  id: "ledger-rally",
  input: Schema.Struct({ cwd: Schema.String, base: Schema.String }),
  output: Schema.String,
  hints: { cwd: "repository" },
  agents: { roles: { reviewer: REVIEWER } },
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const { id } = yield* Run;
      const { dir } = yield* host.place(id);
      const rallied = yield* rally({
        rounds: { n: 0 },
        cwd: input.cwd,
        plan: "",
        source: null,
        proves: Effect.succeed(""),
        risks: "",
        criteria: "",
        prefix: "",
        obstacle: "",
        ledger: [],
        integrate: () =>
          Effect.succeed({
            status: "unchanged" as const,
            branch: "",
            ref: "",
            sha: input.base,
            files: [],
            reason: "",
            base: input.base,
          }),
        fix: ({ operation, at }) =>
          agentWork({
            operation,
            role: "implementer",
            instructions: FIX_PROMPT,
            input: {
              inputs: { target: "", target_kind: "", plan: "", outcome: "" },
              target_repo: "",
              mr: NO_MR,
              base: input.base,
              run: { dir, id },
              branch: "",
              iteration: String(at),
              max_iterations: String(ROUNDS),
              findings: "",
              disputed: "",
            },
            output: FixOutputSchema,
          }),
      });
      return JSON.stringify(
        rallied.reviewed.findings.map(({ id, status, title }) => ({ id, status, title })),
      );
    }),
});
