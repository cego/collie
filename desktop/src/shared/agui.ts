// The Flock chat as the view hears it: AG-UI events, the ones Desktop's main process makes
// from the Agent SDK's messages. No Bun-only import: the view bundles this.

import { Schema } from "effect";

const Message = { messageId: Schema.String };
const ToolCall = { toolCallId: Schema.String };

export const AguiEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("RUN_STARTED"),
    threadId: Schema.String,
    runId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("RUN_FINISHED"),
    threadId: Schema.String,
    runId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("RUN_ERROR"),
    message: Schema.String,
    runId: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("TEXT_MESSAGE_START"),
    ...Message,
    role: Schema.Literal("assistant"),
  }),
  Schema.Struct({ type: Schema.Literal("TEXT_MESSAGE_CONTENT"), ...Message, delta: Schema.String }),
  Schema.Struct({ type: Schema.Literal("TEXT_MESSAGE_END"), ...Message }),
  Schema.Struct({ type: Schema.Literal("REASONING_START"), ...Message }),
  Schema.Struct({
    type: Schema.Literal("REASONING_MESSAGE_START"),
    ...Message,
    role: Schema.Literal("reasoning"),
  }),
  Schema.Struct({
    type: Schema.Literal("REASONING_MESSAGE_CONTENT"),
    ...Message,
    delta: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("REASONING_MESSAGE_END"), ...Message }),
  Schema.Struct({ type: Schema.Literal("REASONING_END"), ...Message }),
  Schema.Struct({
    type: Schema.Literal("TOOL_CALL_START"),
    ...ToolCall,
    toolCallName: Schema.String,
    parentMessageId: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("TOOL_CALL_ARGS"), ...ToolCall, delta: Schema.String }),
  Schema.Struct({ type: Schema.Literal("TOOL_CALL_END"), ...ToolCall }),
  Schema.Struct({
    type: Schema.Literal("TOOL_CALL_RESULT"),
    ...ToolCall,
    ...Message,
    content: Schema.String,
    role: Schema.Literal("tool"),
  }),
]);
export type AguiEvent = typeof AguiEvent.Type;

/** Whether a turn's stream has said all it will. */
export const ends = (event: AguiEvent) =>
  event.type === "RUN_FINISHED" || event.type === "RUN_ERROR";
