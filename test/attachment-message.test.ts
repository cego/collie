import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { keepMessage, sha256Hex } from "../src/attachments";
import { runEffect } from "./support/effect";

test("keeping a long message preserves colliding attachments and reuses only matching bytes", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-message-" });
      const words = "Read these review comments whole.\n";
      const stem = `message-${pipe(sha256Hex(words), Str.slice(0, 8))}`;
      yield* fs.writeFileString(`${dir}/${stem}.md`, "uploaded attachment");
      yield* fs.writeFileString(`${dir}/${stem}-1.md`, "another attachment");

      const kept = yield* keepMessage(dir, words);
      expect(kept).not.toBe(`${stem}.md`);
      expect(kept).not.toBe(`${stem}-1.md`);
      expect(yield* fs.readFileString(`${dir}/${stem}.md`)).toBe("uploaded attachment");
      expect(yield* fs.readFileString(`${dir}/${stem}-1.md`)).toBe("another attachment");
      expect(yield* fs.readFileString(`${dir}/${kept}`)).toBe(words);
      expect(yield* keepMessage(dir, words)).toBe(kept);
      expect((yield* fs.readDirectory(dir)).length).toBe(3);
    }),
  ));
