// Summarises the record timing logs a human made on native Desktop, one log per cell:
// `bun bench/record-open/summarize.ts first.log repeat.log large.log` (desktop/README.md).

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { Console, Effect, FileSystem, Path, Schema } from "effect";
import { summaryOf } from "./stats";

const Mark = Schema.fromJsonString(
  Schema.Struct({ name: Schema.String, at: Schema.Finite, card: Schema.String }),
);
type Mark = typeof Mark.Type;

const marksIn = (log: string) =>
  Effect.forEach(
    Arr.filter(Str.split(log, "\n"), (line) => Str.trim(line) !== ""),
    (line) => Schema.decodeEffect(Mark)(line),
  );

const cell = (samples: ReadonlyArray<number>) => {
  const { p50, p95, max, n } = summaryOf(samples, 0);
  return { p50, p95, max, n };
};

/** Each open's click to usable; a usable whose click is not the last one logged is `unmatched`. */
export const nativeSummary = (log: string) =>
  Effect.gen(function* () {
    const samples: Array<number> = [];
    let unmatched = 0;
    let clicked: { readonly card: string; readonly at: number } | null = null;
    for (const { name, at, card } of yield* marksIn(log)) {
      if (name === "record:click") clicked = { card, at };
      if (name !== "record:usable") continue;
      if (clicked?.card === card) samples.push(at - clicked.at);
      else unmatched++;
      clicked = null;
    }
    return { ...cell(samples), unmatched };
  });

/** Each start to its card's next end; a start never ended, or an end never started, is `unmatched`. */
const spans = (marks: ReadonlyArray<Mark>, start: string, end: string) => {
  const started = new Map<string, number>();
  const samples: Array<number> = [];
  let unmatched = 0;
  for (const { name, at, card } of marks) {
    if (name === start) {
      if (started.has(card)) unmatched++;
      started.set(card, at);
    } else if (name === end) {
      const from = started.get(card);
      if (from === undefined) unmatched++;
      else samples.push(at - from);
      started.delete(card);
    }
  }
  return { ...cell(samples), unmatched: unmatched + started.size };
};

/** The time between each frame and the one before it in the same scroll. */
const frameIntervals = (marks: ReadonlyArray<Mark>) => {
  const last = new Map<string, number>();
  const samples: Array<number> = [];
  for (const { name, at, card } of marks) {
    if (name !== "frame") continue;
    const before = last.get(card);
    if (before !== undefined) samples.push(at - before);
    last.set(card, at);
  }
  return cell(samples);
};

/** Launch to the board usable, key to echo, chat chunk to drawn, and each scroll's frames. */
export const desktopSummary = (log: string) =>
  Effect.map(marksIn(log), (marks) => ({
    launch_to_board_usable: spans(marks, "launch", "board-usable"),
    key_to_echo: spans(marks, "terminal-key", "terminal-drawn"),
    chunk_to_drawn: spans(marks, "chat-chunk", "chat-drawn"),
    frame_interval: frameIntervals(marks),
  }));

const said = (numbers: Readonly<Record<string, number>>) =>
  Arr.join(
    Arr.map(Rec.toEntries(numbers), ([key, value]) => `${key} ${value}`),
    ", ",
  );

if (import.meta.main)
  BunRuntime.runMain(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const log of Arr.drop(Bun.argv, 2)) {
        const text = yield* fs.readFileString(log);
        const name = path.basename(log, ".log");
        const opens = yield* nativeSummary(text);
        if (opens.n > 0 || opens.unmatched > 0) yield* Console.log(`${name}: ${said(opens)}`);
        for (const [metric, numbers] of Rec.toEntries(yield* desktopSummary(text)))
          if (numbers.n > 0 || ("unmatched" in numbers && numbers.unmatched > 0))
            yield* Console.log(`${name} ${metric}: ${said(numbers)}`);
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );
