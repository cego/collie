import * as Arr from "effect/Array";
import { Option, Schema } from "effect";
import { isString } from "../../../src/schema";
import { attachmentPart, fromListing } from "../shared/attachments";
import { fromAboutNote } from "../shared/chat-view";
import type { About, ChatMessage } from "../shared/chat-view";
import { stringifyJson } from "../../../src/json";

const Text = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const Other = Schema.Struct({ type: Schema.String });

const Entry = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("user"),
    uuid: Schema.String,
    parent_tool_use_id: Schema.Null,
    message: Schema.Struct({
      content: Schema.Union([
        Schema.String,
        Schema.Array(
          Schema.Union([
            Text,
            Schema.Struct({
              type: Schema.Literal("tool_result"),
              tool_use_id: Schema.String,
              content: Schema.Union([Schema.String, Schema.Array(Schema.Union([Text, Other]))]),
            }),
            Other,
          ]),
        ),
      ]),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("assistant"),
    uuid: Schema.String,
    parent_tool_use_id: Schema.Null,
    message: Schema.Struct({
      content: Schema.Array(
        Schema.Union([
          Text,
          Schema.Struct({ type: Schema.Literal("thinking"), thinking: Schema.String }),
          Schema.Struct({
            type: Schema.Literal("tool_use"),
            id: Schema.String,
            name: Schema.String,
            input: Schema.Unknown,
          }),
          Other,
        ]),
      ),
    }),
  }),
]);
const decodeEntry = Schema.decodeUnknownOption(Entry);

type Part = ChatMessage["parts"][number];

// WARNING: Claude Code writes this text as the user message when a turn is interrupted.
const INTERRUPTED = /^\[Request interrupted by user/;

const textOf = (
  content: string | ReadonlyArray<{ readonly type: string; readonly text?: string }>,
) =>
  isString(content)
    ? content
    : Arr.join(
        Arr.flatMap(content, (part) => (isString(part.text) ? [part.text] : [])),
        "\n",
      );

const humanMessage = (content: Parameters<typeof textOf>[0]) => {
  if (isString(content)) {
    const parts: Array<Part> = content === "" ? [] : [{ type: "text", content }];
    return { parts, about: null };
  }
  const texts = Arr.flatMap(content, (part) =>
    part.type === "text" && isString(part.text) ? [part.text] : [],
  );
  const noted = Option.getOrElse(
    Arr.findFirstIndex(texts, (text) => fromAboutNote(text) !== null),
    () => -1,
  );
  const about = noted < 0 ? null : fromAboutNote(texts[noted]!);
  const own = Arr.filter(texts, (_, at) => at !== noted);
  const at = Option.getOrElse(
    Arr.findFirstIndex(own, (text) => fromListing(text) !== null),
    () => -1,
  );
  const words = Arr.join(at < 0 ? own : own.slice(0, at), "\n");
  const files = at < 0 ? [] : (fromListing(own[at]!) ?? []);
  const parts: Array<Part> = [
    ...(words === "" ? [] : [{ type: "text" as const, content: words }]),
    ...Arr.map(files, attachmentPart),
  ];
  return { parts, about };
};

export const transcriptOf = (entries: ReadonlyArray<unknown>) => {
  const messages: Array<{
    id: string;
    role: ChatMessage["role"];
    parts: Array<Part>;
    metadata?: { about: About };
  }> = [];
  for (const entry of Arr.flatMap(
    Arr.map(entries, (entry) => decodeEntry(entry)),
    Option.toArray,
  )) {
    if (entry.type === "user") {
      const content = entry.message.content;
      const said = textOf(content);
      for (const part of isString(content) ? [] : content) {
        if (!("tool_use_id" in part)) {
          continue;
        }
        const answering = messages.at(-1)?.parts ?? [];
        const at = Option.getOrElse(
          Arr.findFirstIndex(
            answering,
            (call) => call.type === "tool-call" && call.id === part.tool_use_id,
          ),
          () => -1,
        );
        const call = answering[at];
        if (call?.type === "tool-call") {
          answering[at] = { ...call, output: textOf(part.content) };
        }
      }
      if (INTERRUPTED.test(said)) {
        continue;
      }
      const { parts, about } = humanMessage(content);
      if (parts.length > 0) {
        messages.push(
          about === null
            ? { id: entry.uuid, role: "user", parts }
            : { id: entry.uuid, role: "user", parts, metadata: { about } },
        );
      }
      continue;
    }
    const parts = Arr.flatMap(entry.message.content, (block) => {
      const returned: Array<Part> =
        "text" in block
          ? [{ type: "text", content: block.text }]
          : "thinking" in block
            ? [{ type: "thinking", content: block.thinking }]
            : "input" in block
              ? [
                  {
                    type: "tool-call",
                    id: block.id,
                    name: block.name,
                    arguments: stringifyJson(block.input ?? {}),
                    state: "complete",
                  },
                ]
              : [];
      return returned;
    });
    const last = messages.at(-1);
    if (last?.role === "assistant") {
      last.parts.push(...parts);
    } else {
      messages.push({ id: entry.uuid, role: "assistant", parts });
    }
  }
  return messages;
};
