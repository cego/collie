import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { err } from "../operations";
import { taskOfWorkspace } from "../task";
import { collect, insideRun } from "../verify";
import { printResult } from "../envelope";
import { answering, readRun } from "./shared";

/**
 * A command whose result Collie watched, bound to the tree it ran on. Not a mutation:
 * running the tests twice is running the tests twice, and a request id that replayed the
 * receipt would hand back a result about a tree that has since moved.
 *
 * The exit status is the command's own, so anything wrapping `collie verify -- bun test`
 * behaves as it would around `bun test`.
 */
export const verify = Command.make(
  "verify",
  {
    runId: Flag.string("run").pipe(
      Flag.withDescription("The Run this is a verification of; its tree is what is fingerprinted"),
    ),
    cwd: Flag.string("cwd").pipe(
      Flag.withDescription("Where to run it; must be inside that Run's own checkout"),
      Flag.optional,
    ),
    name: Flag.string("name").pipe(
      Flag.withDescription("What to call it on a card; the executable by default"),
      Flag.optional,
    ),
    expect: Flag.string("expect").pipe(
      Flag.withDescription(
        "What a pass looks like: `pass` (default), or `fail` for a reproduction that must fail",
      ),
      Flag.optional,
    ),
    command: Argument.string("command").pipe(
      Argument.withDescription("The executable and its arguments, after `--`"),
      Argument.variadic({ min: 1 }),
    ),
  },
  ({ runId, cwd, name, expect, command }) => {
    const [executable, ...argv] = command;
    if (executable === undefined)
      return printResult(err("invalid_input", "verify needs a command to run."), true);
    const wanted = Option.getOrElse(expect, () => "pass");
    if (wanted !== "pass" && wanted !== "fail")
      return printResult(
        err("invalid_input", `--expect is "pass" or "fail", not "${wanted}".`),
        true,
      );
    return answering((env) =>
      Effect.gen(function* () {
        const here = yield* taskOfWorkspace(env.stateDir, env.workspaceId);
        const found = yield* readRun(env, runId, here?.id ?? null);
        if (found._tag === "RunFailure") return found.result;
        const run = found.run;
        const where = Option.getOrElse(cwd, () => run.record.worktree?.path ?? run.record.cwd);
        if (
          !(yield* insideRun(where, {
            cwd: run.record.cwd,
            worktree: run.record.worktree?.path ?? null,
          }))
        )
          return err(
            "invalid_input",
            `"${where}" is not inside run ${run.id}; a verification names the tree it ran on.`,
          );
        return yield* collect(run.dir, {
          run: run.id,
          name: Option.getOrElse(name, () => executable),
          executable,
          argv,
          cwd: where,
          by: "agent",
          expect: wanted,
        }).pipe(
          Effect.map((record) => {
            // The command's own exit, passed through: a wrapper around this must behave
            // the way it would around the command itself.
            process.exitCode = record.exit;
            return {
              ok: true as const,
              data: { verification: record },
              human: `${record.name}: ${record.result} (exit ${record.exit})`,
            };
          }),
          Effect.catchTag("VerifyRefused", (cause) =>
            Effect.succeed(err("invalid_input", cause.why)),
          ),
        );
      }),
    );
  },
).pipe(
  Command.withDescription("Run a command and record its result against this Run's tree"),
  Command.withExamples([
    {
      command: "collie --json verify --run implement-picker-20260909-101112 -- bun test",
      description: "Record a test run against that Run's own checkout",
    },
    {
      command: "collie verify --run <id> --name typecheck -- bun run typecheck",
      description: "Name it, so a card can say which verification passed",
    },
    {
      command:
        "collie verify --run <id> --name regression --expect fail -- bun test test/bug.test.ts",
      description: "Prove a bug exists: the record passes because the command failed",
    },
  ]),
);
