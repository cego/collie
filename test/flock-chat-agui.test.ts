// The Flock chat's window hears AG-UI, which Desktop's main process makes from the Agent
// SDK's messages. Tested against streams recorded from a real session.

import { expect, test } from "bun:test";
import { type SdkMessage, startState, step } from "../desktop/src/bun/agui";
import type { AguiEvent } from "../desktop/src/shared/agui";
import thinkingTurn from "./fixtures/flock-chat-thinking-turn.json";
import toolTurn from "./fixtures/flock-chat-tool-turn.json";

const eventsOf = (messages: ReadonlyArray<SdkMessage>) => {
  let state = startState("session-1");
  const events: AguiEvent[] = [];
  for (const message of messages) {
    const [next, said] = step(state, message);
    state = next;
    events.push(...said);
  }
  return events;
};

/** Each run of deltas to one message as one entry, so a test reads a turn in order. */
const sequence = (events: ReadonlyArray<AguiEvent>) =>
  events
    .map((event) => event.type)
    .filter((type, at, all) => !(type.endsWith("_CONTENT") && all[at - 1] === type));

test("a turn that calls a Collie tool is the call, its result and the answer, in one run", () => {
  const events = eventsOf(toolTurn);
  expect(sequence(events)).toEqual([
    "RUN_STARTED",
    "TOOL_CALL_START",
    "TOOL_CALL_ARGS",
    "TOOL_CALL_END",
    "TOOL_CALL_RESULT",
    "TEXT_MESSAGE_START",
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_END",
    "RUN_FINISHED",
  ]);
  expect(events[0]).toEqual({ type: "RUN_STARTED", threadId: "session-1", runId: "session-1:1" });
  expect(events[1]).toMatchObject({
    toolCallId: "toolu_017VQNFZFbGXZjC6trgtC2uz",
    toolCallName: "mcp__collie__collie_herd",
  });
  const result = events.find((event) => event.type === "TOOL_CALL_RESULT");
  expect(result).toMatchObject({
    toolCallId: "toolu_017VQNFZFbGXZjC6trgtC2uz",
    content: expect.stringContaining("run vm-mk:run-04ab8fe5: Fix board bugs"),
  });
  const answer = events
    .flatMap((event) => (event.type === "TEXT_MESSAGE_CONTENT" ? [event.delta] : []))
    .join("");
  expect(answer).toBe(
    'The board has one Run, vm-mk:run-04ab8fe5 ("Fix board bugs" on branch mk/board), which is working on round 2 of 5 of the review fixes, and nothing needs you right now.',
  );
  expect(events.at(-1)).toEqual({
    type: "RUN_FINISHED",
    threadId: "session-1",
    runId: "session-1:1",
  });
});

test("thinking is a reasoning message of its own, before the answer", () => {
  const events = eventsOf(thinkingTurn);
  expect(sequence(events)).toEqual([
    "RUN_STARTED",
    "REASONING_START",
    "REASONING_MESSAGE_START",
    "REASONING_MESSAGE_CONTENT",
    "REASONING_MESSAGE_END",
    "REASONING_END",
    "TEXT_MESSAGE_START",
    "TEXT_MESSAGE_CONTENT",
    "TEXT_MESSAGE_END",
    "RUN_FINISHED",
  ]);
  const thought = events
    .flatMap((event) => (event.type === "REASONING_MESSAGE_CONTENT" ? [event.delta] : []))
    .join("");
  expect(thought).toStartWith("Starting with 17 unfinished, I'm tracking each hour");
});

test("the next turn is a run of its own, and a failed one ends in an error", () => {
  const twice = eventsOf([...toolTurn, ...toolTurn]);
  expect(twice.filter((event) => event.type === "RUN_STARTED")).toEqual([
    { type: "RUN_STARTED", threadId: "session-1", runId: "session-1:1" },
    { type: "RUN_STARTED", threadId: "session-1", runId: "session-1:2" },
  ]);
  const failure = { type: "result", subtype: "error_during_execution", is_error: true };
  const failed = eventsOf([...toolTurn.slice(0, -1), failure]);
  expect(failed.at(-1)).toEqual({
    type: "RUN_ERROR",
    runId: "session-1:1",
    message: "error_during_execution",
  });
});

test("a turn that fails before the model's first word still starts and ends, with the error", () => {
  const apiError = {
    type: "assistant",
    parent_tool_use_id: null,
    error: "rate_limit",
    message: { content: [{ type: "text", text: "API Error: rate limited" }] },
  };
  const failed = {
    type: "result",
    subtype: "success",
    is_error: true,
    result: "API Error: rate limited",
  };
  expect(eventsOf([apiError, failed])).toEqual([
    { type: "RUN_STARTED", threadId: "session-1", runId: "session-1:1" },
    {
      type: "RUN_ERROR",
      runId: "session-1:1",
      message: "API Error: rate limited",
    },
  ]);
  const answered = { type: "result", subtype: "success", is_error: false };
  expect(eventsOf([answered])).toEqual([
    { type: "RUN_STARTED", threadId: "session-1", runId: "session-1:1" },
    { type: "RUN_FINISHED", threadId: "session-1", runId: "session-1:1" },
  ]);
});
