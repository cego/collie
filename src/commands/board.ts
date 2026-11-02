// The board as JSON: the first snapshot of the board the host serves (ADR-0038). Herd-wide,
// like the board it prints: a workspace is a filter over one board, not a board of its own
// (ADR-0009). With `--draw`, the board itself, as the host's board terminal runs it.

import * as Arr from "effect/Array";
import { Console, Effect } from "effect";
import { Command, Flag } from "effect/cli";
import { sectionOf, type TaskView } from "../board-model";
import { boardSnapshot } from "../lifecycle";
import { answering } from "./shared";

function line(view: TaskView): string {
  return Arr.join([sectionOf(view), view.state, view.project, view.name, view.sentence], "\t");
}

/** The renderer arrives through dynamic imports, so the rest of the CLI never loads it. */
const draw = Effect.gen(function* () {
  const [{ currentEnv }, { Herdr, herdrFailureReason }, { workspaceFlow }] = yield* Effect.promise(
    () => Promise.all([import("../env"), import("../herdr"), import("../flows")]),
  );
  const env = yield* currentEnv;
  process.exitCode = yield* workspaceFlow(new Herdr(env), env).pipe(
    Effect.catch((cause) => Console.error(herdrFailureReason(cause)).pipe(Effect.as(1))),
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
              if (!read.ok) return read;
              const tasks = read.value.tasks;
              return {
                ok: true as const,
                data: { tasks },
                human:
                  tasks.length === 0
                    ? "nothing on the board"
                    : Arr.join(Arr.map(tasks, line), "\n"),
              };
            }),
          ),
        ),
).pipe(Command.withDescription("Every Task on this Herd's board, as the host serves it"));
