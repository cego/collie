import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { appendLogLine, readLogTail } from "../src/run-log";
import { runEffect } from "./support/effect";

test("concurrent log writers each receive the line they actually wrote", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-log-lines-" });
      const [first, second] = yield* Effect.all(
        [appendLogLine(dir, "first"), appendLogLine(dir, "second")],
        { concurrency: "unbounded" },
      );
      expect(new Set([first, second])).toEqual(new Set([1, 2]));
      const lines = Str.split(Str.trimEnd(yield* fs.readFileString(`${dir}/log.txt`)), "\n");
      expect(lines[first - 1]).toBe("first");
      expect(lines[second - 1]).toBe("second");
    }),
  ));

test("a capped log tail keeps absolute line numbers and rebuilds a stale count", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-log-tail-" });
      for (let n = 1; n <= 20; n++)
        yield* appendLogLine(dir, `line ${pipe(String(n), Str.padStart(2, "0"))}`);
      expect(yield* readLogTail(dir, 20)).toEqual({
        panel: { _tag: "Text", text: "line 19\nline 20\n", truncated: true },
        firstLine: 19,
      });
      yield* fs.writeFileString(`${dir}/log.txt`, "outside\n", { flag: "a" });
      expect(yield* readLogTail(dir, 20)).toEqual({
        panel: { _tag: "Text", text: "line 20\noutside\n", truncated: true },
        firstLine: 20,
      });
    }),
  ));
