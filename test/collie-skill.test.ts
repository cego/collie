// What the operator skill teaches an agent about the CLI has to be what the CLI does, and
// must not teach a command substitution a security scanner flags.

import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";

const ROOT = new URL("../", import.meta.url).pathname;
const read = (path: string) =>
  FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.readFileString(`${ROOT}${path}`)));

test("the collie skill says only --decide is refused, and --goal and --constraint are recorded", () =>
  runEffect(
    Effect.gen(function* () {
      const skill = pipe_(yield* read("skills/collie/SKILL.md"), Str.replace(/\s+/g, " "));
      expect(skill).toContain("so `--decide` is refused");
      expect(skill).toContain("`--goal` and `--constraint` are recorded into the Run's Intent");
    }),
  ));

test("neither the collie skill nor the CLI docs teach command substitution for a request id", () =>
  runEffect(
    Effect.gen(function* () {
      for (const path of ["skills/collie/SKILL.md", "docs/cli.md"]) {
        const text = yield* read(path);
        expect([path, pipe_(text, Str.includes("$("))]).toEqual([path, false]);
        expect([path, pipe_(text, Str.includes("uuidgen"))]).toEqual([path, false]);
      }
    }),
  ));
