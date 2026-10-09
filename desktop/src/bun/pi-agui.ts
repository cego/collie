import { Schema } from "effect";
import { isString } from "../../../src/schema";
import type { AguiEvent } from "../shared/agui";
import type { TurnCost } from "./driver";

const Text = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const Content = Schema.Array(Schema.Union([Text, Schema.Struct({ type: Schema.String })]));
const ToolCall = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  arguments: Schema.Record(Schema.String, Schema.Json),
});
const Update = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["text_start", "text_end", "thinking_start", "thinking_end"]),
    contentIndex: Schema.Number,
  }),
  Schema.Struct({
    type: Schema.Literals(["text_delta", "thinking_delta"]),
    contentIndex: Schema.Number,
    delta: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("toolcall_start"),
    contentIndex: Schema.Number,
    id: Schema.String,
    toolName: Schema.String,
  }),
  Schema.Struct({
    type: Schema.Literal("toolcall_end"),
    contentIndex: Schema.Number,
    toolCall: ToolCall,
  }),
]);
const Usage = Schema.Struct({
  input: Schema.optionalKey(Schema.Number),
  output: Schema.optionalKey(Schema.Number),
  cacheRead: Schema.optionalKey(Schema.Number),
  cacheWrite: Schema.optionalKey(Schema.Number),
});
const Record = Schema.Union([
  Schema.Struct({ type: Schema.Literal("agent_start") }),
  Schema.Struct({ type: Schema.Literal("agent_settled"), aborted: Schema.Boolean }),
  Schema.Struct({
    type: Schema.Literal("message_start"),
    message: Schema.Struct({ role: Schema.String }),
  }),
  Schema.Struct({ type: Schema.Literal("message_update"), assistantMessageEvent: Update }),
  Schema.Struct({
    type: Schema.Literal("message_end"),
    message: Schema.Struct({
      role: Schema.String,
      usage: Schema.optionalKey(Usage),
      stopReason: Schema.optionalKey(Schema.String),
      errorMessage: Schema.optionalKey(Schema.String),
    }),
  }),
  Schema.Struct({
    type: Schema.Literal("tool_execution_start"),
    toolCallId: Schema.String,
    toolName: Schema.String,
    args: Schema.Record(Schema.String, Schema.Json),
  }),
  Schema.Struct({
    type: Schema.Literal("tool_execution_end"),
    toolCallId: Schema.String,
    result: Schema.Struct({ content: Content }),
  }),
  Schema.Struct({
    type: Schema.Literal("response"),
    command: Schema.String,
    success: Schema.Boolean,
    error: Schema.optionalKey(Schema.String),
    data: Schema.optionalKey(Schema.Struct({ disposition: Schema.optionalKey(Schema.String) })),
  }),
  Schema.Struct({
    type: Schema.Literal("auto_retry_end"),
    success: Schema.Boolean,
    finalError: Schema.optionalKey(Schema.String),
  }),
]);
export const decodePiRecord = Schema.decodeUnknownOption(Schema.fromJsonString(Record));
export type PiRecord = typeof Record.Type;

export const piToolName = (name: string) => {
  const stable = name.replace(/^mcp__cf_[0-9a-f]{32}__/, "mcp__collie__");
  return stable === "mcp__collie__AskUserQuestion" ? "AskUserQuestion" : stable;
};
export const piText = (content: typeof Content.Type) =>
  content.flatMap((part) => ("text" in part ? [part.text] : [])).join("\n");

export const piEvents = (thread: string) => {
  let turn = 0;
  let message = 0;
  let error: string | undefined;
  const tools = new Set<string>();
  let usage: TurnCost["usage"] = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  };
  const runId = () => `${thread}:${turn}`;
  const messageId = (index: number) => `${thread}:${message}:${index}`;
  const tool = (id: string, name: string, args?: Schema.Json): AguiEvent[] => {
    const events: AguiEvent[] = [];
    if (!tools.has(id)) {
      tools.add(id);
      events.push({
        type: "TOOL_CALL_START",
        toolCallId: id,
        toolCallName: piToolName(name),
        parentMessageId: `${thread}:${message}`,
      });
    }
    if (args !== undefined)
      events.push(
        { type: "TOOL_CALL_ARGS", toolCallId: id, delta: JSON.stringify(args) },
        { type: "TOOL_CALL_END", toolCallId: id },
      );
    return events;
  };
  const step = (record: PiRecord): ReadonlyArray<AguiEvent> => {
    switch (record.type) {
      case "agent_start":
        // Pi may start another low-level run while recovering; it is still this message.
        return [];
      case "message_start":
        if (record.message.role === "assistant") message++;
        return [];
      case "message_update": {
        const event = record.assistantMessageEvent;
        const id = messageId(event.contentIndex);
        switch (event.type) {
          case "text_start":
            return [{ type: "TEXT_MESSAGE_START", messageId: id, role: "assistant" }];
          case "text_delta":
            return [{ type: "TEXT_MESSAGE_CONTENT", messageId: id, delta: event.delta }];
          case "text_end":
            return [{ type: "TEXT_MESSAGE_END", messageId: id }];
          case "thinking_start":
            return [
              { type: "REASONING_START", messageId: id },
              { type: "REASONING_MESSAGE_START", messageId: id, role: "reasoning" },
            ];
          case "thinking_delta":
            return [{ type: "REASONING_MESSAGE_CONTENT", messageId: id, delta: event.delta }];
          case "thinking_end":
            return [
              { type: "REASONING_MESSAGE_END", messageId: id },
              { type: "REASONING_END", messageId: id },
            ];
          case "toolcall_start":
            return tool(event.id, event.toolName);
          case "toolcall_end":
            return tool(event.toolCall.id, event.toolCall.name, event.toolCall.arguments);
        }
      }
      case "tool_execution_start":
        return tools.has(record.toolCallId)
          ? []
          : tool(record.toolCallId, record.toolName, record.args);
      case "tool_execution_end":
        return [
          {
            type: "TOOL_CALL_RESULT",
            toolCallId: record.toolCallId,
            messageId: `${record.toolCallId}:result`,
            content: piText(record.result.content),
            role: "tool",
          },
        ];
      case "message_end": {
        if (record.message.role !== "assistant") return [];
        const counts = record.message.usage;
        usage = {
          input_tokens: usage.input_tokens + (counts?.input ?? 0),
          output_tokens: usage.output_tokens + (counts?.output ?? 0),
          cache_read_input_tokens: usage.cache_read_input_tokens + (counts?.cacheRead ?? 0),
          cache_creation_input_tokens:
            usage.cache_creation_input_tokens + (counts?.cacheWrite ?? 0),
        };
        error = record.message.stopReason === "error" ? record.message.errorMessage : undefined;
        return [];
      }
      case "auto_retry_end":
        if (!record.success) error = record.finalError;
        return [];
      case "response":
        if (record.command !== "prompt") return [];
        if (!record.success)
          return [
            {
              type: "RUN_ERROR",
              runId: runId(),
              message: record.error ?? "Pi refused the prompt.",
            },
          ];
        return record.data?.disposition === "handled"
          ? [{ type: "RUN_FINISHED", threadId: thread, runId: runId() }]
          : [];
      case "agent_settled":
        return isString(error) && !record.aborted
          ? [{ type: "RUN_ERROR", runId: runId(), message: error }]
          : [{ type: "RUN_FINISHED", threadId: thread, runId: runId() }];
    }
  };
  return {
    begin: (): AguiEvent => {
      turn++;
      error = undefined;
      tools.clear();
      usage = {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      };
      return { type: "RUN_STARTED", threadId: thread, runId: runId() };
    },
    step,
    usage: () => ({ ...usage }),
  };
};
