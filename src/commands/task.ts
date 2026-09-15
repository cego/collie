// The Tasks this Herd has: what `run start --task` names, and what a picker offers.

import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { RunStore } from "../run";
import { listTasks } from "../task";
import { answering } from "./shared";

const list = Command.make("list", {}, () =>
  answering((env) =>
    Effect.gen(function* () {
      const tasks = yield* listTasks(env.stateDir);
      const runs = yield* new RunStore(env.stateDir).list();
      const data = tasks.map((task) => ({
        ...task,
        runs: runs.filter((run) => run.record.task === task.id).map((run) => run.id),
      }));
      return {
        ok: true,
        data: { tasks: data },
        human:
          data
            .map(
              (task) => `${task.id}\t${task.label}\t${task.workspace}\t${task.runs.length} run(s)`,
            )
            .join("\n") || "No tasks found.",
      };
    }),
  ),
).pipe(Command.withDescription("Every Task, its workspace and the Runs it owns"));

export const task = Command.make("task").pipe(
  Command.withDescription("The Tasks a Run can be started into"),
  Command.withSubcommands([list]),
);
