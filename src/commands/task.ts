import * as Arr from "effect/Array";
import { Effect } from "effect";
import { Command, Flag } from "effect/cli";
import { listRuns } from "../runs";
import { actAsked, hostTasks } from "../lifecycle";
import { err } from "../operations";
import { answering, cliDoor, mutating, requestIdFlag } from "./shared";

const list = Command.make("list", {}, () =>
  answering((env) =>
    Effect.gen(function* () {
      const tasks = yield* hostTasks(env);
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
              (task) =>
                `${task.id}\t${task.label}\t${task.workspace ?? "-"}\t${task.runs.length} run(s)`,
            ),
            "\n",
          ) || "No tasks found.",
      };
    }),
  ),
).pipe(Command.withDescription("Every Task, its workspace and the Runs it owns"));

const create = Command.make(
  "create",
  {
    instruction: Flag.String("instruction").pipe(
      Flag.withDescription("What the Task is for, in the operator's own words"),
    ),
    label: Flag.String("label").pipe(
      Flag.withDescription("What the board calls it; the first line of the instruction by default"),
      Flag.optional,
    ),
    requestId: requestIdFlag,
  },
  ({ instruction, label, requestId }) =>
    mutating(
      {
        operation: "create_task",
        run: null,
        args: { instruction, label: label._tag === "Some" ? label.value : "" },
      },
      requestId,
      (env, id) =>
        Effect.gen(function* () {
          const [done] = yield* actAsked(env, {
            door: yield* cliDoor(env),
            actions: [
              label._tag === "Some"
                ? { kind: "create_task" as const, instruction, label: label.value }
                : { kind: "create_task" as const, instruction },
            ],
            request: id,
          });
          if (done === undefined || done.state !== "applied" || done.task === undefined) {
            return err("operation_failed", done?.note || "The host did not queue a Task.");
          }
          return {
            ok: true as const,
            data: { task: done.task },
            human: `Queued ${done.task}: ${instruction}`,
          };
        }),
    ),
).pipe(Command.withDescription("Queue a Task from one instruction, before any Run exists"));

export const task = Command.make("task").pipe(
  Command.withDescription("The Tasks a Run can be started into"),
  Command.withSubcommands([list, create]),
);
