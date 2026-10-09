// The board as JSON: the first snapshot of the board the host serves (ADR-0038). Herd-wide,
// like the board it prints: a workspace is a filter over one board, not a board of its own
// (ADR-0009).

import { Effect } from "effect";
import { Command } from "effect/cli";
import { sectionOf, type TaskView } from "../board-model";
import { boardSnapshot } from "../lifecycle";
import { answering } from "./shared";

function line(view: TaskView): string {
  return [sectionOf(view), view.state, view.project, view.name, view.sentence].join("\t");
}

export const board = Command.make("board", {}, () =>
  answering((env) =>
    boardSnapshot(env).pipe(
      Effect.map((read) => {
        if (!read.ok) return read;
        const tasks = read.value.tasks;
        return {
          ok: true as const,
          data: { tasks },
          human: tasks.length === 0 ? "nothing on the board" : tasks.map(line).join("\n"),
        };
      }),
    ),
  ),
).pipe(Command.withDescription("Every Task on this Herd's board, as the host serves it"));
