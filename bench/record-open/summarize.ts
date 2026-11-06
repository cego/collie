// Summarises the record timing logs a human made on native Desktop, one log per cell:
// `bun bench/record-open/summarize.ts first.log repeat.log large.log` (desktop/README.md).

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { Console, Effect, FileSystem, Path, Schema } from "effect";
import { summaryOf } from "./stats";

const Mark = Schema.fromJsonString(
  Schema.Struct({ name: Schema.String, at: Schema.Finite, card: Schema.String }),
);

/** Each open's click to usable; a usable whose click is not the last one logged is `unmatched`. */
export const nativeSummary = (log: string) =>
  Effect.gen(function* () {
    const marks = yield* Effect.forEach(
      Arr.filter(Str.split(log, "\n"), (line) => Str.trim(line) !== ""),
      (line) => Schema.decodeEffect(Mark)(line),
    );
    const samples: Array<number> = [];
    let unmatched = 0;
    let clicked: { readonly card: string; readonly at: number } | null = null;
    for (const { name, at, card } of marks) {
      if (name === "record:click") clicked = { card, at };
      if (name !== "record:usable") continue;
      if (clicked?.card === card) samples.push(at - clicked.at);
      else unmatched++;
      clicked = null;
    }
    const { p50, p95, max, n } = summaryOf(samples, 0);
    return { p50, p95, max, n, unmatched };
  });

if (import.meta.main)
  BunRuntime.runMain(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const log of Arr.drop(Bun.argv, 2)) {
        const { p50, p95, max, n, unmatched } = yield* nativeSummary(yield* fs.readFileString(log));
        yield* Console.log(
          `${path.basename(log, ".log")}: p50 ${p50}, p95 ${p95}, max ${max}, n ${n}, unmatched ${unmatched}`,
        );
      }
    }).pipe(Effect.provide(BunServices.layer)),
  );
