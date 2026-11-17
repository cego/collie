// The shipped rally over a local checkout, then the final review of the integrated tree as
// implement's delivery asks for it. A fix that `moves` commits, so the next round's head moved;
// with `upstream`, the default branch moves on and is merged in before round 2.

import { FixOutputSchema, Host, Run, agentWork, defineWorkflow } from "collie";
import { Effect, Schema } from "effect";
import {
  FIX_PROMPT,
  NO_MR,
  REVIEWER,
  ROUNDS,
  rally,
  reviewPass,
} from "../../../workflows/reviewing.ts";

const git = (cwd: string, ...args: string[]) =>
  Effect.promise(async () => {
    const child = Bun.spawn(["git", ...args], { cwd });
    const stdout = await new Response(child.stdout).text();
    await child.exited;
    return stdout;
  });

export default defineWorkflow({
  id: "delta-rally",
  input: Schema.Struct({
    cwd: Schema.String,
    base: Schema.String,
    moves: Schema.Boolean,
    upstream: Schema.Boolean,
  }),
  output: Schema.String,
  hints: { cwd: "repository" },
  agents: { roles: { reviewer: REVIEWER } },
  run: ({ input }) =>
    Effect.gen(function* () {
      const host = yield* Host;
      const { id } = yield* Run;
      const { dir } = yield* host.place(id);
      let base = input.base;
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
        integrate: (operation) =>
          Effect.gen(function* () {
            if (input.upstream && operation === "merge-2") {
              yield* git(input.cwd, "checkout", "-q", "-b", "upstream", input.base);
              yield* Effect.promise(() =>
                Bun.write(`${input.cwd}/upstream.ts`, "export const upstream = 1;\n"),
              );
              yield* git(input.cwd, "add", "-A");
              yield* git(input.cwd, "commit", "-qm", "upstream moved");
              base = (yield* git(input.cwd, "rev-parse", "HEAD")).trim();
              yield* git(input.cwd, "checkout", "-q", "-");
              yield* git(input.cwd, "merge", "-q", "--no-edit", "upstream");
            }
            return {
              status: "unchanged" as const,
              branch: "",
              ref: "",
              sha: base,
              files: [],
              reason: "",
              base,
            };
          }),
        fix: ({ operation, at }) =>
          Effect.gen(function* () {
            const fixed = yield* agentWork({
              operation,
              role: "implementer",
              instructions: FIX_PROMPT,
              input: {
                inputs: { target: "", target_kind: "", plan: "", outcome: "" },
                target_repo: "",
                mr: NO_MR,
                base,
                run: { dir, id },
                branch: "",
                iteration: String(at),
                max_iterations: String(ROUNDS),
                findings: "",
                disputed: "",
              },
              output: FixOutputSchema,
            });
            if (input.moves) {
              yield* Effect.promise(() =>
                Bun.write(`${input.cwd}/fixed-${at}.ts`, `export const fixed = ${at};\n`),
              );
              yield* git(input.cwd, "add", "-A");
              yield* git(input.cwd, "commit", "-qm", `fix round ${at}`);
            }
            return fixed;
          }),
      });
      yield* reviewPass({
        target: "",
        plan: "",
        source: null,
        proves: "",
        previous: `${dir}/review.md`,
        answered: "",
        risks: "",
        base,
        at: ROUNDS + 1,
        of: ROUNDS + 1,
        disputed: [],
      });
      return rallied.halted ?? "settled";
    }),
});
