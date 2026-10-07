// The Flock chat's files on a Machine: Claude Code's Read, Glob, Grep, Write and Edit,
// answered by that Machine's host over the chat's own channel, with each path written
// `<machine>:<path>`. Desktop's own tools, not the Toolkit's, so Native chat's reach is
// unchanged (ADR-0011, the Flock chat reaches files).

import { Crypto, Effect, Encoding, Result, Schema } from "effect";
import { HostRefused, RUN_FILE_BYTES, type HostFile } from "../../../src/board-model";
import type { JsonObject } from "../../../src/schema";
import { decodeStrict } from "../../../src/toolkit";
import { readWhole } from "./carried";
import { boardOf, type ChatMachine, type FlockChat, reasonOf, speaking } from "./flock-tools";

/** What a file tool hands the model: text, or an image it can see. */
export type ToolContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

const described = <S extends Schema.Top>(schema: S, description: string) =>
  schema.annotate({ description });

const OnMachine = (what: string) =>
  described(Schema.String, `${what}, as <machine>:<absolute path>`);
const Lines = (what: string) => Schema.optionalKey(described(Schema.Int, what));
const Flag = (what: string) => Schema.optionalKey(described(Schema.Boolean, what));

const ReadInput = Schema.Struct({
  file_path: OnMachine("The file to read"),
  offset: Lines("The line to start at, from 1"),
  limit: Lines("How many lines to read"),
});
const GlobInput = Schema.Struct({
  pattern: described(Schema.String, 'The glob to match, such as "**/*.ts"'),
  path: OnMachine("The directory to search in"),
});
const GrepInput = Schema.Struct({
  pattern: described(Schema.String, "The regular expression to search for"),
  path: OnMachine("The file or directory to search in"),
  glob: Schema.optionalKey(
    described(Schema.String, 'Only files matching this glob, such as "*.js"'),
  ),
  type: Schema.optionalKey(
    described(Schema.String, 'Only files of this ripgrep type, such as "py"'),
  ),
  output_mode: Schema.optionalKey(
    described(
      Schema.Literals(["content", "files_with_matches", "count"]),
      "Matching lines, the files that match (the default), or a count per file",
    ),
  ),
  "-i": Flag("Ignore case"),
  "-n": Flag("Number the matching lines, in content mode"),
  "-A": Lines("Lines of context after each match, in content mode"),
  "-B": Lines("Lines of context before each match, in content mode"),
  "-C": Lines("Lines of context around each match, in content mode"),
  head_limit: Lines("At most this many lines of the answer"),
  multiline: Flag("Let a pattern span lines"),
});
const WriteInput = Schema.Struct({
  file_path: OnMachine("The file to write"),
  content: described(Schema.String, "The whole of its new content"),
});
const EditInput = Schema.Struct({
  file_path: OnMachine("The file to edit"),
  old_string: described(Schema.String, "The text to replace, unique in the file"),
  new_string: described(Schema.String, "What replaces it"),
  replace_all: Flag("Replace every occurrence rather than one unique one"),
});

const tool = (
  name: string,
  title: string,
  description: string,
  input: Schema.Top,
  readOnly: boolean,
) => ({
  name,
  title,
  description,
  input: (): JsonObject => {
    const document = Schema.toJsonSchemaDocument(input, { onExcessProperty: "error" });
    // SAFETY: a JSON Schema document is JSON, which is what JsonObject says.
    return { ...document.schema, $defs: document.definitions } as JsonObject;
  },
  readOnly,
});

export const FILE_TOOLS = [
  tool(
    "collie_read",
    "Read a file on a Machine",
    "Reads a file on a Machine, as Read does here: numbered lines, an image as the image, any other binary by its name, size and type.",
    ReadInput,
    true,
  ),
  tool(
    "collie_glob",
    "Find files on a Machine",
    "The files under a directory on a Machine that a glob matches, newest first, as Glob does here.",
    GlobInput,
    true,
  ),
  tool(
    "collie_grep",
    "Search files on a Machine",
    "Searches the files under a path on a Machine with ripgrep, as Grep does here.",
    GrepInput,
    true,
  ),
  tool(
    "collie_write",
    "Write a file on a Machine",
    "Writes a whole file on a Machine, as Write does here. Never inside a host's state directory.",
    WriteInput,
    false,
  ),
  tool(
    "collie_edit",
    "Edit a file on a Machine",
    "Replaces text in a file on a Machine, as Edit does here. Never inside a host's state directory.",
    EditInput,
    false,
  ),
];

export const isFileTool = (name: string) => FILE_TOOLS.some((one) => one.name === name);

const text = (said: string): ReadonlyArray<ToolContent> => [{ type: "text", text: said }];

/** Where a `<machine>:<path>` points, or why it does not. */
const placed = (flock: FlockChat, named: string) => {
  const colon = named.indexOf(":");
  const machine = flock.machines().find((one) => one.name === named.slice(0, colon));
  if (colon <= 0)
    return Result.fail(
      `${named} names no Machine: write it as <machine>:<path>, one of ${flock
        .machines()
        .map((one) => one.name)
        .join(", ")}. Files on this computer are read with Read.`,
    );
  if (machine === undefined) return Result.fail(`No Machine "${named.slice(0, colon)}".`);
  return Result.succeed({ machine, path: named.slice(colon + 1) });
};

/** The Machine's board, refused where its host does not take files. */
const takingFiles = Effect.fn("FileTools.takingFiles")(function* (machine: ChatMachine) {
  const board = yield* boardOf(machine);
  if (board === null)
    return yield* new HostRefused({ reason: `${machine.name}'s board could not be read` });
  if (board.files !== true)
    return yield* new HostRefused({
      reason: `${machine.name}'s Collie does not take files; upgrade Collie on ${machine.name}`,
    });
  return [{ machine, board }];
});

const TEXTUAL = /^text\/|json|xml|javascript|yaml|toml|x-sh/;
/** The images the model is shown as images, and the most of one it takes. */
const SHOWN = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const IMAGE_BYTES = 5 * 1024 * 1024;
/** How many lines a read gives when it is not told. */
const READ_LINES = 2000;

const numbered = (lines: ReadonlyArray<string>, from: number) =>
  lines.map((line, at) => `${String(from + at).padStart(6)}\t${line}`).join("\n");

const read = Effect.fn("FileTools.read")(function* (
  machine: ChatMachine,
  path: string,
  input: typeof ReadInput.Type,
) {
  const named = `${machine.name}:${path}`;
  const from = Math.max(1, input.offset ?? 1);
  const limit = Math.max(1, input.limit ?? READ_LINES);
  const newlines = (bytes: Uint8Array) => bytes.filter((byte) => byte === 10).length;
  // The first part says what the file is, so only what is shown is read whole.
  const head = yield* readWhole(machine, path, () => true);
  const { mediaType, size } = head.file;
  const textual =
    TEXTUAL.test(mediaType) ||
    (mediaType === "application/octet-stream" && !head.bytes.subarray(0, 8192).includes(0));
  if (SHOWN.has(mediaType) && size <= IMAGE_BYTES)
    return [
      {
        type: "image",
        data: Encoding.encodeBase64((yield* readWhole(machine, path)).bytes),
        mimeType: mediaType,
      },
    ] as const;
  if (!textual) return text(`${named} is ${mediaType}, ${size} bytes.`);
  const { file, bytes } = yield* readWhole(machine, path, (all) => newlines(all) >= from + limit);
  if (file.size === 0) return text(`${named} is empty.`);
  const lines = new TextDecoder().decode(bytes).replace(/\n$/, "").split("\n");
  const shown = lines.slice(from - 1, from - 1 + limit);
  return text(
    shown.length === 0
      ? `${named} has ${lines.length} lines; there is nothing from line ${from}.`
      : numbered(shown, from),
  );
});

/** A line a host answered that starts with one of its paths, named by its Machine. */
const onMachine = (machine: ChatMachine, line: string) =>
  line.startsWith("/") ? `${machine.name}:${line}` : line;

const answered = (
  machine: ChatMachine,
  lines: ReadonlyArray<string>,
  omitted: number,
  none: string,
) =>
  text(
    lines.length === 0
      ? none
      : [
          ...lines.map((line) => onMachine(machine, line)),
          ...(omitted > 0 ? [`(and ${omitted} more)`] : []),
        ].join("\n"),
  );

const newRequest = Effect.flatMap(Crypto.Crypto, (crypto) => crypto.randomUUIDv4);

const answer = Effect.fn("FileTools.answer")(function* (
  flock: FlockChat,
  name: string,
  input: JsonObject,
) {
  const where = (path: string) => placed(flock, path);
  switch (name) {
    case "collie_read": {
      const asked = decodeStrict(ReadInput)(input);
      if (Result.isFailure(asked)) return text(`collie_read: ${asked.failure}`);
      const at = where(asked.success.file_path);
      if (Result.isFailure(at)) return text(at.failure);
      yield* takingFiles(at.success.machine);
      return yield* read(at.success.machine, at.success.path, asked.success);
    }
    case "collie_glob": {
      const asked = decodeStrict(GlobInput)(input);
      if (Result.isFailure(asked)) return text(`collie_glob: ${asked.failure}`);
      const at = where(asked.success.path);
      if (Result.isFailure(at)) return text(at.failure);
      const { machine, path } = at.success;
      yield* takingFiles(machine);
      const found = yield* machine.door.glob({ pattern: asked.success.pattern, path });
      return answered(machine, found.paths, found.omitted, "No files found.");
    }
    case "collie_grep": {
      const asked = decodeStrict(GrepInput)(input);
      if (Result.isFailure(asked)) return text(`collie_grep: ${asked.failure}`);
      const at = where(asked.success.path);
      if (Result.isFailure(at)) return text(at.failure);
      const { machine, path } = at.success;
      yield* takingFiles(machine);
      const one = asked.success;
      const found = yield* machine.door.grep({
        pattern: one.pattern,
        path,
        glob: one.glob,
        type: one.type,
        outputMode: one.output_mode,
        ignoreCase: one["-i"],
        lineNumbers: one["-n"],
        after: one["-A"],
        before: one["-B"],
        context: one["-C"],
        headLimit: one.head_limit,
        multiline: one.multiline,
      });
      const lines = found.text.split("\n").filter((line) => line !== "");
      return answered(machine, lines, found.omitted, "No matches found.");
    }
    case "collie_write": {
      const asked = decodeStrict(WriteInput)(input);
      if (Result.isFailure(asked)) return text(`collie_write: ${asked.failure}`);
      const at = where(asked.success.file_path);
      if (Result.isFailure(at)) return text(at.failure);
      const { machine, path } = at.success;
      yield* speaking(flock, machine, yield* takingFiles(machine));
      const done = yield* machine.door.writeFile({
        path,
        content: asked.success.content,
        request: yield* newRequest,
      });
      return text(`Wrote ${machine.name}:${done.path} (${done.bytes} bytes).`);
    }
    case "collie_edit": {
      const asked = decodeStrict(EditInput)(input);
      if (Result.isFailure(asked)) return text(`collie_edit: ${asked.failure}`);
      const at = where(asked.success.file_path);
      if (Result.isFailure(at)) return text(at.failure);
      const { machine, path } = at.success;
      yield* speaking(flock, machine, yield* takingFiles(machine));
      const done = yield* machine.door.editFile({
        path,
        oldString: asked.success.old_string,
        newString: asked.success.new_string,
        replaceAll: asked.success.replace_all,
        request: yield* newRequest,
      });
      return text(`Replaced ${done.replaced} in ${machine.name}:${done.path}.`);
    }
    default:
      return text(`${name} is not one of Desktop's file tools.`);
  }
});

/** One call to a file tool, answered as content, a refusal included. */
export const callFileTool = (flock: FlockChat, name: string, input: JsonObject) =>
  answer(flock, name, input).pipe(
    Effect.catch((error) => Effect.succeed(text(`${name}: ${reasonOf(error)}`))),
  );
