// The board as JSON, so `collie --json board` and the Home's pane can never disagree
// about a Task. Herd-wide, like the board it prints: a workspace is a filter over one
// board, not a board of its own (ADR-0009).

import { Effect } from "effect";
import { Command } from "effect/unstable/cli";
import { buildBoard, sectionOf, type TaskView } from "../board";
import { loadDefaults } from "../config";
import { Herdr } from "../herdr";
import { answering } from "./shared";

function line(view: TaskView): string {
  return [sectionOf(view), view.state, view.project, view.name, view.sentence].join("\t");
}

export const board = Command.make("board", {}, () =>
  answering((env) =>
    Effect.gen(function* () {
      const alive = yield* new Herdr(env).agentList().pipe(Effect.catch(() => Effect.succeed([])));
      const tasks = yield* buildBoard({
        env,
        alive,
        // The human's own threshold, as the pane reads it: a Run is quiet in both or in
        // neither, or the two disagree about what a Task is doing.
        quietMs: (yield* loadDefaults(env.configDir)).boardQuietMs,
      });
      return {
        ok: true as const,
        data: { tasks },
        human: tasks.length === 0 ? "nothing on the board" : tasks.map(line).join("\n"),
      };
    }),
  ),
).pipe(Command.withDescription("Every Task on this Herd's board, as the Home draws it"));
