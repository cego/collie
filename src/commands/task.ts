// The Tasks this Herd has: what `run start --task` names, and what a picker offers.

import * as Arr from "effect/Array";
import { Effect } from "effect";
import { Command } from "effect/cli";
import { listRuns } from "../runs";
import { listTasks } from "../task";
import { answering } from "./shared";

const list = Command.make("list", {}, () =>
  answering((env) =>
    Effect.gen(function* () {
      const tasks = yield* listTasks(env.stateDir);
      const runs = yield* listRuns(env);
      const data = Arr.map(tasks, (task) => ({
        ...task,
        runs: Arr.map(
          Arr.filter(runs, (run) => run.task === task.id),
          (run) => run.id,
        ),
      }));
      return {
        ok: true,
        data: { tasks: data },
        human:
          Arr.join(
            Arr.map(
              data,
              (task) => `${task.id}\t${task.label}\t${task.workspace}\t${task.runs.length} run(s)`,
            ),
            "\n",
          ) || "No tasks found.",
      };
    }),
  ),
).pipe(Command.withDescription("Every Task, its workspace and the Runs it owns"));

export const task = Command.make("task").pipe(
  Command.withDescription("The Tasks a Run can be started into"),
  Command.withSubcommands([list]),
);
