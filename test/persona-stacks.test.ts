import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";
import { root } from "./support/host";

test("no shipped persona, and not the review prompt, tells an agent to write an Output file", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const flat = (text: string) => pipe(text, Str.replaceAll(/\s+/g, " "));
      const personas = yield* fs.readDirectory(`${root}personas`);
      for (const file of personas) {
        const text = flat(yield* fs.readFileString(`${root}personas/${file}`));
        expect({ file, path: Str.includes("OUTPUT_PATH")(text) }).toEqual({ file, path: false });
        expect({ file, file_: Str.includes("Output file")(text) }).toEqual({ file, file_: false });
        if (Str.includes("## Output")(text)) {
          expect({ file, submits: Str.includes("collie_submit")(text) }).toEqual({
            file,
            submits: true,
          });
        }
      }
      const review = flat(yield* fs.readFileString(`${root}workflows/review.md`));
      expect(Str.includes("OUTPUT_PATH")(review)).toBe(false);
      expect(Str.includes("Output file")(review)).toBe(false);
    }),
  ));

test("the implementer, generalist and investigator say to take down the stack they bring up", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const line =
        "A stack you bring up to test outlives your turn and your process: containers, compose projects, workloads in a local cluster. Bring up only what the test needs. When the testing it was for is done, take it down with the tool that brought it up, unless the human asked to keep it. Say in your reply what you left running.";
      const flat = (text: string) => pipe(text, Str.replaceAll(/\s+/g, " "));
      for (const persona of ["implementer", "generalist", "investigator"]) {
        const text = flat(yield* fs.readFileString(`${root}personas/${persona}.md`));
        expect(text).toContain(line);
        const output = Option.getOrElse(pipe(text, Str.indexOf("## Output")), () => -1);
        if (output >= 0) {
          expect(Option.getOrElse(pipe(text, Str.indexOf(line)), () => -1)).toBeLessThan(output);
        }
      }
    }),
  ));
