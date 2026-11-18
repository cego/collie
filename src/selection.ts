import { Effect, FileSystem, Path, Schema, flow, Result } from "effect";
import { herdDir } from "./steering";

export interface Selection {
  readonly task: string;
  readonly run: string;
  readonly name: string;
}

const SelectionSchema = Schema.Struct({
  task: Schema.String,
  run: Schema.String,
  name: Schema.String,
});
const SelectionJson = Schema.fromJsonString(SelectionSchema);
const encode = flow(Schema.encodeResult(SelectionJson), Result.getOrThrow);
const decode = Schema.decodeUnknownOption(SelectionJson);

export const selectionPath = Effect.fn("Selection.path")(function* (stateDir: string, key: string) {
  const path = yield* Path.Path;
  return path.join(yield* herdDir(stateDir, key), "selection.json");
});

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

export const readSelection = Effect.fn("Selection.read")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
  const found = decode(raw);
  return found._tag === "Some" ? found.value : null;
});

export function promptLine(on: Selection | null) {
  return on === null
    ? ""
    : `Board: "${on.name}" is open (run ${on.run}). "It", "this one" and the like mean this card; a Herd-wide question is still Herd-wide.`;
}

export function selectionLine(on: Selection | null) {
  return on === null ? "board selection: none · whole herd" : `board selection: ${on.name}`;
}
