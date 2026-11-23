import * as Str from "effect/String";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { Seen } from "./board-model";
import { appendRunJournal, readRunJournal, runJournal } from "./journal";
import { epochMs } from "./time";

const SeenJson = Schema.fromJsonString(Seen);

export const seenPath = (runDir: string) => runJournal(runDir, "steering/seen.jsonl");

export const recordSeen = Effect.fn("Seen.record")(function* (runDir: string, line: Seen) {
  yield* appendRunJournal(seenPath(runDir), SeenJson, line);
});

export const readSeen = Effect.fn("Seen.read")(function* (runDir: string) {
  return yield* readRunJournal(seenPath(runDir), SeenJson);
});

const sincePath = Effect.fn("Seen.sincePath")(function* (stateDir: string) {
  const path = yield* Path.Path;
  return path.join(stateDir, "seen-since");
});

export const markSeenSince = Effect.fn("Seen.markSince")(function* (stateDir: string, at: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs
    .writeFileString(yield* sincePath(stateDir), at, { flag: "wx" })
    .pipe(
      Effect.catchTag("PlatformError", (cause) =>
        cause.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(cause),
      ),
    );
});

// WARNING: a Run that ended before recording began counts as seen.
export const seenSince = Effect.fn("Seen.since")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(yield* sincePath(stateDir))
    .pipe(Effect.option, Effect.map(Option.getOrNull));
  if (text === null) {
    return null;
  }
  const at = epochMs(Str.trim(text));
  return Number.isFinite(at) ? at : null;
});
