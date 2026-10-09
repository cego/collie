import { Effect, FileSystem, Option, Schema } from "effect";
import { epochMs } from "../../../src/time";
import { isString } from "../../../src/schema";
import { fromAboutNote } from "../shared/chat-view";
import { fromListing } from "../shared/attachments";
import type { ContentBlock } from "./driver";
import { transcriptOf } from "./transcript";
import { piToolName } from "./pi-agui";

const NOTE = "\n\n[Desktop: context accompanying this message]\n";
const Text = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const Other = Schema.Struct({ type: Schema.String });
const Note = Schema.fromJsonString(
  Schema.Struct({ blocks: Schema.Array(Text), context: Schema.String }),
);
const decodeNote = Schema.decodeUnknownOption(Note);
const Header = Schema.Struct({
  type: Schema.Literal("session"),
  id: Schema.String,
  timestamp: Schema.String,
});
const Entry = Schema.Struct({
  type: Schema.String,
  id: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  timestamp: Schema.String,
  name: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(
    Schema.Struct({
      role: Schema.String,
      content: Schema.Union([
        Schema.String,
        Schema.Array(
          Schema.Union([
            Text,
            Schema.Struct({ type: Schema.Literal("thinking"), thinking: Schema.String }),
            Schema.Struct({
              type: Schema.Literal("toolCall"),
              id: Schema.String,
              name: Schema.String,
              arguments: Schema.Json,
            }),
            Other,
          ]),
        ),
      ]),
      toolCallId: Schema.optionalKey(Schema.String),
    }),
  ),
});
const JsonLine = Schema.fromJsonString(Schema.Json);
const decodeJson = Schema.decodeUnknownOption(JsonLine);
const decodeHeader = Schema.decodeUnknownOption(Header);
const decodeEntry = Schema.decodeUnknownOption(Entry);

export const piPrompt = (content: string | Array<ContentBlock>, context: string) => {
  const blocks = isString(content) ? [{ type: "text" as const, text: content }] : content;
  const texts = blocks.filter((block) => block.type === "text");
  const candidate = texts[0]?.text ?? "";
  const own = fromAboutNote(candidate) === null && fromListing(candidate) === null;
  const first = own ? candidate : "";
  const rest = texts.slice(own ? 1 : 0);
  return {
    message:
      rest.length === 0 && context === ""
        ? first
        : `${first}${NOTE}${Schema.encodeSync(Note)({ blocks: rest, context })}`,
    images: blocks.flatMap((block) =>
      block.type === "image"
        ? [{ type: "image" as const, data: block.source.data, mimeType: block.source.media_type }]
        : [],
    ),
  };
};
const humanBlocks = (content: NonNullable<typeof Entry.Type.message>) => {
  const text = isString(content.content)
    ? content.content
    : content.content.flatMap((block) => ("text" in block ? [block.text] : [])).join("\n");
  const at = text.lastIndexOf(NOTE);
  const note = at < 0 ? Option.none() : decodeNote(text.slice(at + NOTE.length));
  return Option.isNone(note)
    ? text
    : [{ type: "text", text: text.slice(0, at) }, ...note.value.blocks];
};

const readSession = Effect.fnUntraced(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(path);
  const lines = text.split("\n").flatMap((line) => Option.toArray(decodeJson(line)));
  const header = decodeHeader(lines[0]);
  if (Option.isNone(header)) return null;
  const entries = lines.slice(1).flatMap((line) => Option.toArray(decodeEntry(line)));
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch: typeof entries = [];
  let leaf = entries.at(-1);
  const visited = new Set<string>();
  while (leaf !== undefined && !visited.has(leaf.id)) {
    visited.add(leaf.id);
    branch.push(leaf);
    leaf = leaf.parentId === null ? undefined : byId.get(leaf.parentId);
  }
  const messages = branch.reverse().flatMap<Schema.Json>((entry) => {
    const message = entry.message;
    if (entry.type !== "message" || message === undefined) return [];
    const base = { uuid: entry.id, parent_tool_use_id: null };
    if (message.role === "user")
      return [{ ...base, type: "user", message: { content: humanBlocks(message) } }];
    if (message.role === "toolResult" && message.toolCallId !== undefined)
      return [
        {
          ...base,
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: message.toolCallId, content: message.content },
            ],
          },
        },
      ];
    if (message.role !== "assistant") return [];
    return [
      {
        ...base,
        type: "assistant",
        message: {
          content: isString(message.content)
            ? [{ type: "text", text: message.content }]
            : message.content.map((block) =>
                "arguments" in block
                  ? {
                      type: "tool_use",
                      id: block.id,
                      name: piToolName(block.name),
                      input: block.arguments,
                    }
                  : block,
              ),
        },
      },
    ];
  });
  const transcript = transcriptOf(messages);
  const first = transcript
    .find((message) => message.role === "user")
    ?.parts.find((part) => part.type === "text");
  return {
    session: header.value.id,
    path,
    transcript,
    title:
      entries.findLast((entry) => entry.type === "session_info")?.name ??
      (first?.type === "text" ? first.content.slice(0, 100) : "Conversation"),
    at: epochMs(entries.at(-1)?.timestamp ?? header.value.timestamp),
  };
});

export const piSessions = Effect.fn("Pi.sessions")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const files = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
  const sessions = yield* Effect.forEach(
    files.filter((file) => file.endsWith(".jsonl")),
    (file) => readSession(`${dir}/${file}`).pipe(Effect.orElseSucceed(() => null)),
  );
  return sessions.filter((session) => session !== null).sort((a, b) => b.at - a.at);
});
