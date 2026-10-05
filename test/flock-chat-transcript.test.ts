// A Flock conversation reopened, or shown in a second window, is read back from the
// transcript Claude Code keeps: the human's words, the answers, and each tool call with
// what it came back with.

import { expect, test } from "bun:test";
import { transcriptOf } from "../desktop/src/bun/transcript";
import recorded from "./fixtures/flock-chat-transcript.json";

test("a recorded conversation reads back as the human's message and one answer with its tool call", () => {
  const messages = transcriptOf(recorded);
  expect(messages.map(({ role }) => role)).toEqual(["user", "assistant"]);
  expect(messages[0]!.parts).toEqual([
    {
      type: "text",
      content: "What is on the board? Use collie_herd, then answer in one short sentence.",
    },
  ]);
  const [call, said] = messages[1]!.parts;
  expect(call).toMatchObject({
    type: "tool-call",
    id: "toolu_01LHit6nWcJEcBC351ReCvQy",
    name: "mcp__collie__collie_herd",
    arguments: "{}",
    state: "complete",
  });
  expect(call).toHaveProperty("output", expect.stringContaining("Nothing needs you. 1 working."));
  expect(said).toEqual({
    type: "text",
    content: expect.stringContaining("One Run is working"),
  });
});

test("thinking reads back as thinking, and a subagent's messages are not this conversation's", () => {
  const messages = transcriptOf([
    {
      type: "user",
      uuid: "u1",
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "text", text: "hi" }] },
    },
    {
      type: "assistant",
      uuid: "a1",
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Greeting.", signature: "s" }],
      },
    },
    {
      type: "assistant",
      uuid: "a2",
      parent_tool_use_id: "toolu_x",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "inner" }],
      },
    },
    {
      type: "assistant",
      uuid: "a3",
      parent_tool_use_id: null,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Hello." }],
      },
    },
  ]);
  expect(messages).toEqual([
    { id: "u1", role: "user", parts: [{ type: "text", content: "hi" }] },
    {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "thinking", content: "Greeting." },
        { type: "text", content: "Hello." },
      ],
    },
  ]);
});

test("Claude Code's note that a turn was interrupted is not read back as the human's words", () => {
  const messages = transcriptOf([
    {
      type: "user",
      uuid: "u1",
      parent_tool_use_id: null,
      message: { role: "user", content: "hi" },
    },
    {
      type: "user",
      uuid: "u2",
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] },
    },
  ]);
  expect(messages.map(({ id }) => id)).toEqual(["u1"]);
});
