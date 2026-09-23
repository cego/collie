import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import type { PluginEnv } from "../env";
import { err } from "../operations";
import { runView, treeOf } from "../lifecycle";
import { noteVerification } from "../metrics";
import { evidenceDir } from "../engine";
import { collect, insideRun } from "../verify";
import { printResult } from "../envelope";
import { answering } from "./shared";

/** A Run to verify against: where its journal goes, and the tree it is about. */
interface Target {
  readonly id: string;
  readonly dir: string;
  readonly cwd: string;
  readonly worktree: string | null;
  /** Whether the collector records the metric: a Run with steps does it at its gate. */
  readonly note: boolean;
}

/** The Run this verification is about, as the host has it. Null where it has no such Run. */
const targetOf = Effect.fn("collie.verify.target")(function* (env: PluginEnv, runId: string) {
  const view = yield* runView(env, runId);
  if (view === null || !("runId" in view)) return null;
  const target: Target = {
    id: view.runId,
    dir: evidenceDir(env.stateDir, view.runId),
    cwd: treeOf(view),
    worktree: null,
    note: true,
  };
  return target;
});

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
    runId: Flag.String("run").pipe(
      Flag.withDescription("The Run this is a verification of; its tree is what is fingerprinted"),
    ),
    cwd: Flag.String("cwd").pipe(
      Flag.withDescription("Where to run it; must be inside that Run's own checkout"),
      Flag.optional,
    ),
    name: Flag.String("name").pipe(
      Flag.withDescription("What to call it on a card; the executable by default"),
      Flag.optional,
    ),
    expect: Flag.String("expect").pipe(
      Flag.withDescription(
        "What a pass looks like: `pass` (default), or `fail` for a reproduction that must fail",
      ),
      Flag.optional,
    ),
    command: Argument.String("command").pipe(
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
    const verified = Effect.fn("collie.verify.collect")(function* (target: Target) {
      const where = Option.getOrElse(cwd, () => target.worktree ?? target.cwd);
      if (!(yield* insideRun(where, { cwd: target.cwd, worktree: target.worktree })))
        return err(
          "invalid_input",
          `"${where}" is not inside run ${target.id}; a verification names the tree it ran on.`,
        );
      return yield* collect(target.dir, {
        run: target.id,
        name: Option.getOrElse(name, () => executable),
        executable,
        argv,
        cwd: where,
        by: "agent",
        expect: wanted,
      }).pipe(
        Effect.tap((record) => (target.note ? noteVerification(target.dir, record) : Effect.void)),
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
    });
    return answering((env) =>
      Effect.gen(function* () {
        const target = yield* targetOf(env, runId);
        if (target === null)
          return err("run_not_found", `Run "${runId}" was not found.`, { run: runId });
        return yield* verified(target);
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
