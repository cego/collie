// A Flock conversation reopened, or shown in a second window, is read back from the
// transcript Claude Code keeps: the human's words, the answers, and each tool call with
// what it came back with.

import { expect, test } from "bun:test";
import { transcriptOf } from "../desktop/src/bun/transcript";
import { attachmentPart, listing } from "../desktop/src/shared/attachments";
import { aboutNote } from "../desktop/src/shared/chat-view";
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

test("Desktop's listing of a message's files reads back as attachments, and a message of files alone is kept", () => {
  const sha = "b".repeat(64);
  const shot = {
    id: `${sha}/shot.png`,
    name: "shot.png",
    size: 2048,
    mediaType: "image/png",
    path: `/state/collie-desktop/attachments/${sha}/shot.png`,
  };
  const image = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "AA==" },
  };
  const messages = transcriptOf([
    {
      type: "user",
      uuid: "u1",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "text", text: listing([shot]) },
          image,
        ],
      },
    },
    {
      type: "user",
      uuid: "u2",
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "text", text: listing([shot]) }, image] },
    },
  ]);
  const part = attachmentPart(shot);
  expect(messages).toEqual([
    { id: "u1", role: "user", parts: [{ type: "text", content: "what is this?" }, part] },
    { id: "u2", role: "user", parts: [part] },
  ]);
});

test("Desktop's note of a message's card reads back as the message's card, never as its words", () => {
  const about = { machine: "vm-mk", task: "t-1", run: "r-2", name: "Fix board bugs" };
  const sha = "c".repeat(64);
  const shot = {
    id: `${sha}/shot.png`,
    name: "shot.png",
    size: 2048,
    mediaType: "image/png",
    path: `/state/collie-desktop/attachments/${sha}/shot.png`,
  };
  const messages = transcriptOf([
    {
      type: "user",
      uuid: "u1",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          { type: "text", text: "what is this one doing?" },
          { type: "text", text: aboutNote(about) },
        ],
      },
    },
    {
      type: "user",
      uuid: "u2",
      parent_tool_use_id: null,
      message: { role: "user", content: "and now?" },
    },
    {
      type: "user",
      uuid: "u3",
      parent_tool_use_id: null,
      message: {
        role: "user",
        content: [
          { type: "text", text: "and this?" },
          { type: "text", text: aboutNote(about) },
          { type: "text", text: listing([shot]) },
        ],
      },
    },
  ]);
  expect(messages).toEqual([
    {
      id: "u1",
      role: "user",
      parts: [{ type: "text", content: "what is this one doing?" }],
      metadata: { about },
    },
    { id: "u2", role: "user", parts: [{ type: "text", content: "and now?" }] },
    {
      id: "u3",
      role: "user",
      parts: [{ type: "text", content: "and this?" }, attachmentPart(shot)],
      metadata: { about },
    },
  ]);
});
