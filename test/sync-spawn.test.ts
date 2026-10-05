// A synchronous spawn can lose its child's exit and spin its process forever
// (oven-sh/bun#34069): a test worker that does it times out every test it has left.

import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";

const root = new URL("../", import.meta.url).pathname;

test("nothing the suite runs spawns a process synchronously", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const offenders: string[] = [];
      for (const dir of ["src", "test"]) {
        for (const name of yield* fs.readDirectory(`${root}${dir}`, { recursive: true })) {
          if (!/\.tsx?$/.test(name)) continue;
          const file = `${dir}/${name}`;
          const text = yield* fs.readFileString(`${root}${file}`);
          if (/\b(spawn|exec|execFile)Sync\(/.test(text)) offenders.push(file);
        }
      }
      expect(offenders).toEqual([]);
    }),
  ));
