// The replies a Run posted to reviewers in its human's name, recorded by its host as posted.

import { Effect, Path, Schema } from "effect";
import { RunReply } from "./board-model";
import { appendJournal, readJournal } from "./journal";

const RunReplyJson = Schema.fromJsonString(RunReply);

const repliesPath = Effect.fn("Replies.path")(function* (runDir: string) {
  const path = yield* Path.Path;
  return path.join(runDir, "replies.jsonl");
});

export const recordReply = Effect.fn("Replies.record")(function* (runDir: string, reply: RunReply) {
  yield* appendJournal(yield* repliesPath(runDir), RunReplyJson, reply);
});

export const readReplies = Effect.fn("Replies.read")(function* (runDir: string) {
  return yield* readJournal(yield* repliesPath(runDir), RunReplyJson);
});

/** The line a list of replies shows for one: what it was, on which comment, and when. */
export const replyLine = (reply: RunReply) =>
  `${reply.kind ?? "replied"} ${reply.comment} at ${reply.at}`;
