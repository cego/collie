import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { Effect } from "effect";
import type { Mutable } from "effect/Types";
import type { ActionSchema } from "../actions";
import { Command, Flag } from "effect/cli";
import { listRuns } from "../runs";
import { actAsked, hostTasks } from "../lifecycle";
import type { PluginEnv } from "../env";
import { hostInstallation } from "../project";
import type { Filing } from "../task";
import { err } from "../operations";
import { answering, cliDoor, mutating, requestIdFlag } from "./shared";

const whyNot = (filed: Filing) => {
  switch (filed.result) {
    case "stale":
      return `; it is in ${filed.membership.project?.id ?? "no Project"} (membership ${filed.membership.seq}), so read the board and file it again`;
    case "archived":
      return "; its Project is archived, so restore it before filing into it";
    case "missing":
      return "; no such Task or Project is here";
    case "unavailable":
      return "; the Machine that owns the Project could not be reached, so nothing changed and the same filing can be tried again";
    default:
      return "";
  }
};

// WARNING: a bare id is this Machine's own Project, and `<installation>:<id>` is another Machine's.
const projectRef = (env: PluginEnv, written: string) => {
  const at = Str.indexOf(":")(written);
  if (Option.isSome(at) && at.value > 0) {
    return Effect.succeed({
      installation: Str.slice(0, at.value)(written),
      id: Str.slice(at.value + 1)(written),
    });
  }
  return Effect.map(hostInstallation(env.stateDir), (here) => ({
    installation: here ?? "",
    id: written,
  }));
};

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
    project: Flag.String("project").pipe(
      Flag.withDescription("The Project on this Machine to file it in as it is queued"),
      Flag.optional,
    ),
    requestId: requestIdFlag,
  },
  ({ instruction, label, project, requestId }) =>
    mutating(
      {
        operation: "create_task",
        run: null,
        args: {
          instruction,
          label: label._tag === "Some" ? label.value : "",
          project: project._tag === "Some" ? project.value : "",
        },
      },
      requestId,
      (env, id) =>
        Effect.gen(function* () {
          // WARNING: an absent key, not a present undefined: the action's JSON refuses undefined where a string is optional.
          const action: Mutable<Extract<typeof ActionSchema.Encoded, { kind: "create_task" }>> = {
            kind: "create_task",
            instruction,
          };
          if (label._tag === "Some") {
            action.label = label.value;
          }
          if (project._tag === "Some") {
            action.project = project.value;
          }
          const [done] = yield* actAsked(env, {
            door: yield* cliDoor(env),
            actions: [action],
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

const file = Command.make(
  "file",
  {
    task: Flag.String("task").pipe(Flag.withDescription("The Task's id, as `task list` prints it")),
    project: Flag.String("project").pipe(
      Flag.withDescription(
        "The Project to file it in: its id on this Machine, or `<installation>:<id>` for a Project another Machine owns",
      ),
      Flag.optional,
    ),
    expected: Flag.Int("expected").pipe(
      Flag.withDescription(
        "The membership to move from, as the board showed it; a filing that names another is refused",
      ),
      Flag.optional,
    ),
    requestId: requestIdFlag,
  },
  ({ task, project, expected, requestId }) =>
    mutating(
      {
        operation: "task_file",
        run: null,
        args: { task, project: project._tag === "Some" ? project.value : "" },
      },
      requestId,
      (env, id) =>
        Effect.gen(function* () {
          // WARNING: an absent key, not a present undefined: the action's JSON refuses undefined where a string is optional.
          const filing: Mutable<
            Extract<typeof ActionSchema.Encoded, { kind: "task_file" }>["filings"][number]
          > = { task };
          if (project._tag === "Some") {
            filing.project = yield* projectRef(env, project.value);
          }
          if (expected._tag === "Some") {
            filing.expected = expected.value;
          }
          const [done] = yield* actAsked(env, {
            door: yield* cliDoor(env),
            actions: [{ kind: "task_file", filings: [filing] }],
            request: id,
          });
          const filed = done?.filed?.[0];
          if (done === undefined || filed === undefined) {
            return err("operation_failed", done?.note || "The host did not file the Task.");
          }
          const landed = filed.result === "filed" || filed.result === "already";
          const human = landed
            ? `${task}: ${filed.result}${filed.membership.project === null ? " unassigned" : ` in ${filed.membership.project.id}`} (membership ${filed.membership.seq})`
            : `${task}: ${filed.result}${whyNot(filed)}`;
          return landed
            ? {
                ok: true as const,
                data: { task, result: filed.result, membership: filed.membership },
                human,
              }
            : err("operation_failed", human, {
                task,
                result: filed.result,
                membership: filed.membership,
              });
        }),
    ),
).pipe(
  Command.withDescription(
    "File a Task into a Project on this Machine, or move it, or leave it unassigned",
  ),
);
const follow = (kind: "task_follow" | "task_unfollow", said: string) =>
  Command.make(
    said,
    {
      task: Flag.String("task").pipe(
        Flag.withDescription("The Task's id, as `task list` prints it"),
      ),
      requestId: requestIdFlag,
    },
    ({ task, requestId }) =>
      mutating({ operation: kind, run: null, args: { task } }, requestId, (env, id) =>
        Effect.gen(function* () {
          const [done] = yield* actAsked(env, {
            door: yield* cliDoor(env),
            actions: [{ kind, task }],
            request: id,
          });
          if (done === undefined || done.state !== "applied") {
            return err("operation_failed", done?.note || `The host did not ${said} it.`);
          }
          return { ok: true as const, data: { task }, human: done.note };
        }),
      ),
  ).pipe(Command.withDescription(`Stop or start keeping a Task in view (${said})`));
export const task = Command.make("task").pipe(
  Command.withDescription("The Tasks a Run can be started into"),
  Command.withSubcommands([
    list,
    create,
    file,
    follow("task_follow", "follow"),
    follow("task_unfollow", "unfollow"),
  ]),
);
