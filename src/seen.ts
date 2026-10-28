// Whether anyone has seen what a finished Run reported, recorded by its host once for the
// whole Flock (ADR-draft-a-finished-run-is-seen-once-for-the-flock).

import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { Seen } from "./board-model";
import { appendJournal, readJournal } from "./journal";
import { epochMs } from "./time";

const SeenJson = Schema.fromJsonString(Seen);

export const seenPath = Effect.fn("Seen.path")(function* (runDir: string) {
  const path = yield* Path.Path;
  return path.join(runDir, "steering", "seen.jsonl");
});

export const recordSeen = Effect.fn("Seen.record")(function* (runDir: string, line: Seen) {
  yield* appendJournal(yield* seenPath(runDir), SeenJson, line);
});

export const readSeen = Effect.fn("Seen.read")(function* (runDir: string) {
  return yield* readJournal(yield* seenPath(runDir), SeenJson);
});

const sincePath = Effect.fn("Seen.sincePath")(function* (stateDir: string) {
  const path = yield* Path.Path;
  return path.join(stateDir, "seen-since");
});

/** The first host to record seen notes when it started; a later start keeps that moment. */
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

/** When seen began to be recorded here, or null where no host has; a Run that ended earlier counts as seen. */
export const seenSince = Effect.fn("Seen.since")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs
    .readFileString(yield* sincePath(stateDir))
    .pipe(Effect.option, Effect.map(Option.getOrNull));
  if (text === null) return null;
  const at = epochMs(text.trim());
  return Number.isFinite(at) ? at : null;
});
