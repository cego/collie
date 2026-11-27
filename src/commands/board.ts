import * as Arr from "effect/Array";
import { Console, Effect } from "effect";
import { Command, Flag } from "effect/cli";
import { sectionOf } from "../board-model";
import type { TaskView } from "../board-model";
import { boardSnapshot } from "../lifecycle";
import { answering } from "./shared";

function line(view: TaskView) {
  return Arr.join([sectionOf(view), view.state, view.project, view.name, view.sentence], "\t");
}

const draw = Effect.gen(function* () {
  const [{ currentEnv }, { Herdr, herdrFailureReason }, { workspaceFlow }, { recordsReadLayer }] =
    yield* Effect.promise(() =>
      Promise.all([import("../env"), import("../herdr"), import("../flows"), import("../records")]),
    );
  const env = yield* currentEnv;
  process.exitCode = yield* workspaceFlow(new Herdr(env), env).pipe(
    Effect.catch((cause) => Console.error(herdrFailureReason(cause)).pipe(Effect.as(1))),
    Effect.provide(recordsReadLayer(env.stateDir)),
  );
});

export const board = Command.make(
  "board",
  {
    draw: Flag.Boolean("draw").pipe(
      Flag.withDescription("Draw the board in this terminal, as the board terminal on core does"),
      Flag.withDefault(false),
    ),
  },
  ({ draw: drawn }) =>
    drawn
      ? draw
      : answering((env) =>
          boardSnapshot(env).pipe(
            Effect.map((read) => {
              if (!read.ok) {
                return read;
              }
              const tasks = read.value.tasks;
              return {
                ok: true as const,
                data: { tasks, projects: read.value.projects ?? [] },
                human:
                  tasks.length === 0
                    ? "nothing on the board"
                    : Arr.join(Arr.map(tasks, line), "\n"),
              };
            }),
          ),
        ),
).pipe(Command.withDescription("Every Task on this Herd's board, as the host serves it"));
