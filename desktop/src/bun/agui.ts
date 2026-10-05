// The Agent SDK's messages as AG-UI events, one message at a time. Pure, so a recorded SDK
// stream is its test; and decoded rather than typed against the SDK, which Collie's own
// suite does not install. Anything this does not know is skipped.

import { Option, Schema } from "effect";
import { isString } from "../../../src/schema";
import type { AguiEvent } from "../shared/agui";

const Block = Schema.Union([
  Schema.Struct({ type: Schema.Literals(["text", "thinking"]) }),
  Schema.Struct({ type: Schema.Literal("tool_use"), id: Schema.String, name: Schema.String }),
]);

const Delta = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text_delta"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("thinking_delta"), thinking: Schema.String }),
  Schema.Struct({ type: Schema.Literal("input_json_delta"), partial_json: Schema.String }),
]);

const StreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("message_start"),
    message: Schema.Struct({ id: Schema.String }),
  }),
  Schema.Struct({
    type: Schema.Literal("content_block_start"),
    index: Schema.Number,
    content_block: Block,
  }),
  Schema.Struct({
    type: Schema.Literal("content_block_delta"),
    index: Schema.Number,
    delta: Delta,
  }),
  Schema.Struct({ type: Schema.Literal("content_block_stop"), index: Schema.Number }),
]);

const Text = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });

const ToolResult = Schema.Struct({
  type: Schema.Literal("tool_result"),
  tool_use_id: Schema.String,
  content: Schema.Union([
    Schema.String,
    Schema.Array(Schema.Union([Text, Schema.Struct({ type: Schema.String })])),
  ]),
});

/** What is read of an SDK message. A subagent's (`parent_tool_use_id` set) is not. */
const Known = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("stream_event"),
    parent_tool_use_id: Schema.Null,
    event: StreamEvent,
  }),
  Schema.Struct({
    type: Schema.Literal("user"),
    parent_tool_use_id: Schema.Null,
    uuid: Schema.optionalKey(Schema.String),
    message: Schema.Struct({
      content: Schema.Union([
        Schema.String,
        Schema.Array(Schema.Union([ToolResult, Schema.Struct({ type: Schema.String })])),
      ]),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("result"),
    is_error: Schema.Boolean,
    subtype: Schema.String,
    result: Schema.optionalKey(Schema.String),
  }),
]);

const decodeKnown = Schema.decodeUnknownOption(Known);

/** An SDK message, as far as this needs to know before decoding it. */
export interface SdkMessage {
  readonly type: string;
}

interface Open {
  readonly kind: "text" | "thinking" | "tool_use";
  readonly id: string;
}

export interface AguiState {
  readonly thread: string;
  /** Turns started, which names the next one. */
  readonly turns: number;
  /** The turn under way, if any. */
  readonly run: string | null;
  /** The model message the open blocks belong to. */
  readonly message: string;
  readonly blocks: ReadonlyMap<number, Open>;
}

export const startState = (thread: string): AguiState => ({
  thread,
  turns: 0,
  run: null,
  message: "",
  blocks: new Map(),
});

const textOf = (content: typeof ToolResult.Type.content) =>
  isString(content)
    ? content
    : content.flatMap((part) => ("text" in part ? [part.text] : [])).join("\n");

/** What one SDK message adds to the stream, and the state after it. */
export const step = (
  state: AguiState,
  message: SdkMessage,
): readonly [AguiState, ReadonlyArray<AguiEvent>] => {
  const known = decodeKnown(message);
  if (Option.isNone(known)) return [state, []];
  const read = known.value;
  const begun: AguiEvent[] = [];
  let now = state;
  // A turn begins with the model's first word; anything before it is not this turn's.
  if (now.run === null) {
    if (read.type !== "stream_event") return [now, []];
    const run = `${now.thread}:${now.turns + 1}`;
    now = { ...now, turns: now.turns + 1, run };
    begun.push({ type: "RUN_STARTED", threadId: now.thread, runId: run });
  }
  const run = now.run ?? "";
  switch (read.type) {
    case "result": {
      const done: AguiEvent = read.is_error
        ? { type: "RUN_ERROR", runId: run, message: read.result ?? read.subtype }
        : { type: "RUN_FINISHED", threadId: now.thread, runId: run };
      return [{ ...now, run: null, blocks: new Map() }, [done]];
    }
    case "user": {
      const results = isString(read.message.content)
        ? []
        : read.message.content.flatMap((part) => ("tool_use_id" in part ? [part] : []));
      return [
        now,
        [
          ...begun,
          ...results.map((result): AguiEvent => ({
            type: "TOOL_CALL_RESULT",
            toolCallId: result.tool_use_id,
            messageId: `${result.tool_use_id}:result`,
            content: textOf(result.content),
            role: "tool",
          })),
        ],
      ];
    }
    case "stream_event": {
      const event = read.event;
      switch (event.type) {
        case "message_start":
          return [{ ...now, message: event.message.id, blocks: new Map() }, begun];
        case "content_block_start": {
          const block = event.content_block;
          const id = block.type === "tool_use" ? block.id : `${now.message}:${event.index}`;
          const blocks = new Map(now.blocks).set(event.index, { kind: block.type, id });
          const opened: AguiEvent[] =
            block.type === "tool_use"
              ? [
                  {
                    type: "TOOL_CALL_START",
                    toolCallId: id,
                    toolCallName: block.name,
                    parentMessageId: now.message,
                  },
                ]
              : block.type === "text"
                ? [{ type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" }]
                : [
                    { type: "REASONING_START", messageId: id },
                    { type: "REASONING_MESSAGE_START", messageId: id, role: "reasoning" },
                  ];
          return [{ ...now, blocks }, [...begun, ...opened]];
        }
        case "content_block_delta": {
          const open = now.blocks.get(event.index);
          if (open === undefined) return [now, begun];
          const delta = event.delta;
          const said: AguiEvent =
            delta.type === "text_delta"
              ? { type: "TEXT_MESSAGE_CONTENT", messageId: open.id, delta: delta.text }
              : delta.type === "thinking_delta"
                ? { type: "REASONING_MESSAGE_CONTENT", messageId: open.id, delta: delta.thinking }
                : { type: "TOOL_CALL_ARGS", toolCallId: open.id, delta: delta.partial_json };
          return [now, [...begun, said]];
        }
        case "content_block_stop": {
          const open = now.blocks.get(event.index);
          if (open === undefined) return [now, begun];
          const blocks = new Map(now.blocks);
          blocks.delete(event.index);
          const closed: AguiEvent[] =
            open.kind === "text"
              ? [{ type: "TEXT_MESSAGE_END", messageId: open.id }]
              : open.kind === "thinking"
                ? [
                    { type: "REASONING_MESSAGE_END", messageId: open.id },
                    { type: "REASONING_END", messageId: open.id },
                  ]
                : [{ type: "TOOL_CALL_END", toolCallId: open.id }];
          return [{ ...now, blocks }, [...begun, ...closed]];
        }
      }
    }
  }
};
