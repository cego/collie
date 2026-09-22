// The work an older Collie recorded, and the one pass that reads it into rows.
//
// The import is idempotent and belongs to the host, which is the one owner of the state
// directory. A host does it when it starts, so nobody has to know about it; this is the
// same pass on demand, so an installer can show an operator what was found — a record
// nobody can decode, or one something is still working on, has to be said out loud rather
// than left in a log nobody opens.

import { Effect, Option } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { describeKept, type Kept } from "../history";
import { importHistory, nativeHistory } from "../lifecycle";
import { attempt } from "../envelope";
import { context, root, selectedTask } from "./shared";

const historyList = Command.make(
  "list",
  {
    task: Flag.String("task").pipe(
      Flag.withDescription("Only the imported Runs of this Task, by its id"),
      Flag.optional,
    ),
  },
  ({ task }) =>
    Effect.gen(function* () {
      const global = yield* root;
      yield* attempt(
        Effect.gen(function* () {
          const resolved = yield* context(global, false);
          if (resolved._tag === "ContextFailure") return resolved.result;
          const scope = Option.getOrNull(task) ?? (yield* selectedTask(global));
          const found = yield* nativeHistory(resolved.env, scope);
          return {
            ok: true,
            data: { runs: found.rows, unreadable: found.unreadable },
            human:
              [
                ...found.rows.map(
                  (row) => `${row.run}\t${row.status}\t${row.workflow}\t${row.created}`,
                ),
                ...(found.unreadable === null ? [] : [`history: ${found.unreadable}`]),
              ].join("\n") || "No imported Runs.",
          };
        }),
        global.json,
      );
    }),
).pipe(Command.withDescription("The Runs an older Collie recorded; none of them can be run again"));

const historyImport = Command.make("import", {}, () =>
  Effect.gen(function* () {
    const global = yield* root;
    yield* attempt(
      Effect.gen(function* () {
        const resolved = yield* context(global, false);
        if (resolved._tag === "ContextFailure") return resolved.result;
        const asked = yield* importHistory(resolved.env);
        if ("ok" in asked) return asked;
        const kept: ReadonlyArray<Kept> = asked;
        const counted = (kind: string) => kept.filter((item) => item.kind === kind).length;
        return {
          ok: true,
          data: { imported: kept.map((item) => ({ ...item })) },
          human: [
            `${counted("imported")} imported, ${counted("already")} already here` +
              (counted("held") + counted("malformed") > 0
                ? `, ${counted("held")} still owned, ${counted("malformed")} unreadable`
                : ""),
            // Only what a human can act on. Saying "already imported" once per Run
            // would bury the one line that matters under a hundred that do not.
            ...kept
              .filter((item) => item.kind === "held" || item.kind === "malformed")
              .map(describeKept),
          ].join("\n"),
        };
      }),
      global.json,
    );
  }),
).pipe(
  Command.withDescription(
    "Read what an older Collie recorded into this installation; safe to run again",
  ),
);

export const history = Command.make("history").pipe(
  Command.withSubcommands([historyList, historyImport]),
  Command.withDescription("What an older Collie recorded, and the one pass that reads it in"),
);
