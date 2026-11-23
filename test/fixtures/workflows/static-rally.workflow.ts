// The shipped rally over a local checkout, whose fixer is told what it is given and, with
// `fixes`, writes the `lint-ok` file a marked check looks for.

import { FixOutputSchema, Host, Run, agentWork, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import { FIX_PROMPT, NO_MR, REVIEWER, ROUNDS, rally } from "../../../workflows/reviewing.ts";

export default defineWorkflow({
  id: "static-rally",
  input: Schema.Struct({ cwd: Schema.String, fixes: Schema.Boolean }),
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
        integrate: () =>
          Effect.succeed({
            status: "unchanged" as const,
            branch: "",
            ref: "",
            sha: "",
            files: [],
            reason: "",
            base: "",
          }),
        fix: ({ operation, at, findings }) =>
          Effect.gen(function* () {
            const fixed = yield* agentWork({
              operation,
              role: "implementer",
              instructions: FIX_PROMPT,
              input: {
                inputs: { target: "", target_kind: "", plan: "", outcome: "" },
                target_repo: "",
                mr: NO_MR,
                base: "",
                run: { dir, id },
                branch: "",
                iteration: String(at),
                max_iterations: String(ROUNDS),
                findings,
                disputed: "",
              },
              output: FixOutputSchema,
            });
            if (input.fixes)
              yield* Effect.promise(() => Bun.write(`${input.cwd}/lint-ok`, "fixed\n"));
            return fixed;
          }),
      });
      return rallied.halted ?? "settled";
    }),
});
