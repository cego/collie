// A workflow wrapped around a tool that makes a checkout of its own, as bodil does: the
// tool's "up" cuts a worktree on a branch, a child works in it, and the tool's "down" runs
// once the child has settled, whether it succeeded or not.

import { WorkflowError, ask, child, defineWorkflow } from "collie";
import { Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as Activity from "effect/workflow/Activity";

/** What a command of the tool's printed, or its own words where it fails. */
const tool = (script: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const ran = yield* spawner.spawn(
      ChildProcess.make("sh", ["-c", script], { stdout: "pipe", stderr: "pipe" }),
    );
    const [out, err, code] = yield* Effect.all(
      [
        Stream.mkString(Stream.decodeText(ran.stdout)),
        Stream.mkString(Stream.decodeText(ran.stderr)),
        ran.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    if (code !== 0) return yield* new WorkflowError({ reason: err.trim() || `${script} failed` });
    return out.trim();
  }).pipe(
    Effect.scoped,
    Effect.catchTag("PlatformError", (cause) => new WorkflowError({ reason: cause.message })),
  );

export default defineWorkflow({
  id: "provisions",
  title: "Work in a checkout a tool made",
  description: "Brings the tool's instance up, has a child work in it, and takes it down.",
  input: Schema.Struct({
    /** The repository the tool cuts its worktree from. */
    source: Schema.String,
    name: Schema.String,
    ending: Schema.Literals(["succeed", "fail"]),
  }),
  hints: { name: "goal" },
  output: Schema.String,
  run: ({ input }) =>
    Effect.gen(function* () {
      const log = `${input.source}/../tool.log`;
      const worktree = `${input.source}/../worktrees/${input.name}`;
      const branch = yield* Activity.make({
        name: "up",
        success: Schema.String,
        error: WorkflowError,
        execute: tool(
          `echo up >> ${log} && git -C ${input.source} worktree add -q -b ${input.name} ${worktree} && git -C ${worktree} branch --show-current`,
        ),
      });
      // Answering replays this body from the top, after "up" has been recorded.
      yield* ask({ name: "go", prompt: "Start the work?" });
      const built = yield* Effect.exit(
        child({
          invocation: "build",
          workflow: "placed",
          input: { work: `build in ${input.name}`, ending: input.ending },
          options: { workspace: worktree, branch },
        }),
      );
      yield* Activity.make({
        name: "down",
        success: Schema.String,
        error: WorkflowError,
        execute: tool(`echo down >> ${log}`),
      });
      return String(yield* built);
    }),
});
