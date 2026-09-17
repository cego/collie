// What the board has selected, written where chat can read it.
//
// This is the one place the two halves of the Home touch. It is an **input**, never a
// filter: the Herd-wide reads stay Herd-wide whatever is selected, and a tool that
// accepts the selection takes it because it was asked with no run of its own and says
// out loud that it did (ADR-0012).
//
// Small, and rewritten rather than appended to: there is one board per Herd, what it has
// open is true only right now, and a record of what used to be selected would be a thing
// chat could answer about after the human closed it.

import { Effect, FileSystem, Path, Schema } from "effect";
import { herdDir } from "./steering";

export interface Selection {
  /** The Task, as the board's own model names it. */
  readonly task: string;
  /** The Run its card acts on, which is what a run-scoped tool takes. */
  readonly run: string;
  /** What the human sees on the card, which is what the status line prints. */
  readonly name: string;
}

const SelectionSchema = Schema.Struct({
  task: Schema.String,
  run: Schema.String,
  name: Schema.String,
});
const SelectionJson = Schema.fromJsonString(SelectionSchema);
const encode = Schema.encodeSync(SelectionJson);
const decode = Schema.decodeUnknownOption(SelectionJson);

export const selectionPath = Effect.fn("Selection.path")(function* (stateDir: string, key: string) {
  const path = yield* Path.Path;
  return path.join(yield* herdDir(stateDir, key), "selection.json");
});

/** `null` clears it, which is what closing the record does. */
export const writeSelection = Effect.fn("Selection.write")(function* (
  file: string,
  on: Selection | null,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (on === null) return yield* fs.remove(file, { force: true });
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  yield* fs.writeFileString(file, `${encode(on)}\n`);
});

/** What is selected, or null for no board, no selection and a record nobody can read. */
export const readSelection = Effect.fn("Selection.read")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")));
  const found = decode(raw);
  return found._tag === "Some" ? found.value : null;
});

/**
 * What a submitted prompt is prefaced with, or nothing. Attached when the human sends a
 * message and never when they click: a card opened and never asked about costs the
 * conversation nothing.
 */
export function promptLine(on: Selection | null): string {
  return on === null
    ? ""
    : `Board: "${on.name}" is open (run ${on.run}). "It", "this one" and the like mean this card; a Herd-wide question is still Herd-wide.`;
}

/** The line under the chat prompt: what "it" means right now, for both halves of the Home. */
export function selectionLine(on: Selection | null): string {
  return on === null ? "board selection: none · whole herd" : `board selection: ${on.name}`;
}
