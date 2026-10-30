import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";
import { root } from "./support/host";

test("the implementer, generalist and investigator say to take down the stack they bring up", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const line =
        "A stack you bring up to test outlives your turn and your process: containers, compose projects, workloads in a local cluster. Bring up only what the test needs. When the testing it was for is done, take it down with the tool that brought it up, unless the human asked to keep it. Say in your reply what you left running.";
      const flat = (text: string) => pipe(text, Str.replace(/\s+/g, " "));
      for (const persona of ["implementer", "generalist", "investigator"]) {
        const text = flat(yield* fs.readFileString(`${root}personas/${persona}.md`));
        expect(text).toContain(line);
        const output = Option.getOrElse(pipe(text, Str.indexOf("## Output")), () => -1);
        if (output >= 0)
          expect(Option.getOrElse(pipe(text, Str.indexOf(line)), () => -1)).toBeLessThan(output);
      }
    }),
  ));
