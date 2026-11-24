import { Effect, Schema } from "effect";
import { RunReply } from "./board-model";
import { appendRunJournal, readRunJournal, runJournal } from "./journal";

const RunReplyJson = Schema.fromJsonString(RunReply);

const repliesPath = (runDir: string) => runJournal(runDir, "replies.jsonl");

export const recordReply = Effect.fn("Replies.record")(function* (runDir: string, reply: RunReply) {
  yield* appendRunJournal(repliesPath(runDir), RunReplyJson, reply);
});

export const readReplies = Effect.fn("Replies.read")(function* (runDir: string) {
  return yield* readRunJournal(repliesPath(runDir), RunReplyJson);
});

export const replyLine = (reply: RunReply) =>
  `${reply.kind ?? "replied"} ${reply.comment} at ${reply.at}`;
