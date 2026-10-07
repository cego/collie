// A conversation already had, read back from the transcript Claude Code keeps of it. Decoded
// rather than typed against the SDK, like the live stream; anything unknown is skipped.

import { Option, Schema } from "effect";
import { isString } from "../../../src/schema";
import { attachmentPart, fromListing } from "../shared/attachments";
import type { ChatMessage } from "../shared/chat-view";

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

/** What Claude Code writes as a user message when a turn is interrupted. */
const INTERRUPTED = /^\[Request interrupted by user/;

const textOf = (
  content: string | ReadonlyArray<{ readonly type: string; readonly text?: string }>,
) =>
  isString(content)
    ? content
    : content.flatMap((part) => (isString(part.text) ? [part.text] : [])).join("\n");

/**
 * The human's words, then the files Desktop listed after them; the images and documents
 * the model was handed with them are not the view's.
 */
const humanParts = (content: Parameters<typeof textOf>[0]): Part[] => {
  if (isString(content)) return content === "" ? [] : [{ type: "text", content }];
  const texts = content.flatMap((part) =>
    part.type === "text" && isString(part.text) ? [part.text] : [],
  );
  const at = texts.findIndex((text) => fromListing(text) !== null);
  const words = (at < 0 ? texts : texts.slice(0, at)).join("\n");
  const files = at < 0 ? [] : (fromListing(texts[at]!) ?? []);
  return [
    ...(words === "" ? [] : [{ type: "text" as const, content: words }]),
    ...files.map(attachmentPart),
  ];
};

/** The human's messages and the answers, each answer one message however many model turns it took. */
export const transcriptOf = (entries: ReadonlyArray<unknown>): ReadonlyArray<ChatMessage> => {
  const messages: Array<{ id: string; role: ChatMessage["role"]; parts: Part[] }> = [];
  for (const entry of entries.map((entry) => decodeEntry(entry)).flatMap(Option.toArray)) {
    if (entry.type === "user") {
      const content = entry.message.content;
      const said = textOf(content);
      for (const part of isString(content) ? [] : content) {
        if (!("tool_use_id" in part)) continue;
        const answering = messages.at(-1)?.parts ?? [];
        const at = answering.findIndex(
          (call) => call.type === "tool-call" && call.id === part.tool_use_id,
        );
        const call = answering[at];
        if (call?.type === "tool-call") answering[at] = { ...call, output: textOf(part.content) };
      }
      if (INTERRUPTED.test(said)) continue;
      const parts = humanParts(content);
      if (parts.length > 0) messages.push({ id: entry.uuid, role: "user", parts });
      continue;
    }
    const parts = entry.message.content.flatMap((block): Part[] =>
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
                  arguments: JSON.stringify(block.input ?? {}),
                  state: "complete",
                },
              ]
            : [],
    );
    const last = messages.at(-1);
    if (last?.role === "assistant") last.parts.push(...parts);
    else messages.push({ id: entry.uuid, role: "assistant", parts });
  }
  return messages;
};
