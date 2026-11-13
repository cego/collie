// Benchmark marks from the host, bridge and Desktop, off unless COLLIE_RECORD_MARKS names a file.

import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import * as Str from "effect/String";
import { Clock, Config, Effect, FileSystem, Option, Stream } from "effect";

export type RecordMarkAt =
  | "host:emit"
  | "bridge:relay"
  | "desktop:read"
  | "desktop:serve"
  | "board:built";

/** A line per mark, with a Run id or board-build milliseconds, or null when marking is off. */
export const recordMarks = Effect.gen(function* () {
  const file = yield* Config.option(Config.String("COLLIE_RECORD_MARKS")).pipe(
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  if (Option.isNone(file)) return null;
  const fs = yield* FileSystem.FileSystem;
  return (at: RecordMarkAt, value: string) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((ms) =>
        fs.writeFileString(file.value, `${ms} ${at} ${value}\n`, { flag: "a" }),
      ),
      Effect.ignore,
    );
}).pipe(Effect.provide(BunFileSystem.layer));

/** Marks `at` when `frames` gives its first value. */
export const markFirst =
  (at: RecordMarkAt, runId: string) =>
  <A, E, R>(frames: Stream.Stream<A, E, R>) =>
    Stream.unwrap(
      Effect.map(recordMarks, (mark) => {
        if (mark === null) return frames;
        let first = true;
        return Stream.tap(frames, () => {
          if (!first) return Effect.void;
          first = false;
          return mark(at, runId);
        });
      }),
    );

const wholeLines = () => {
  let partial = "";
  return (chunk: string) => {
    const split = Str.split(partial + chunk, "\n");
    partial = split.pop() ?? "";
    return split;
  };
};

/** The Runs whose `runDetail` request the bridge passed to the host, by its first answer. */
export const relayedRecords = () => {
  const asked = new Map<string, string>();
  const requests = wholeLines();
  const answers = wholeLines();
  return {
    asked: (chunk: string) => {
      for (const line of requests(chunk)) {
        if (!Str.includes(`"tag":"runDetail"`)(line)) continue;
        const id = /"id":"?(\d+)/.exec(line)?.[1];
        const runId = /"runId":"([^"]+)"/.exec(line)?.[1];
        if (id !== undefined && runId !== undefined) asked.set(id, runId);
      }
    },
    answered: (chunk: string) => {
      const named: Array<string> = [];
      for (const line of answers(chunk))
        for (const [id, runId] of asked)
          if (new RegExp(`"requestId":"?${id}\\b`).test(line)) {
            asked.delete(id);
            named.push(runId);
          }
      return named;
    },
  };
};
