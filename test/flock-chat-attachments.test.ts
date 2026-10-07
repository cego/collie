// Desktop's own copies of what the human gives the Flock chat: a file named by its path is
// copied in or refused with its reason, and a copy is pruned once it is a month old.

import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Clock, Effect, FileSystem } from "effect";
import { pruneAttachments, stagePath } from "../desktop/src/bun/attachments";
import type { StagedOrRefused } from "../desktop/src/shared/attachments";

const inDir = <A, E>(body: (dir: string) => Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* body(yield* fs.makeTempDirectoryScoped({ prefix: "flock-attach-" }));
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

const pathOf = (staged: StagedOrRefused) => ("path" in staged ? staged.path : "");

test("a file named by its path is copied in, and a directory or a missing file is refused", () =>
  inDir((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${dir}/notes.txt`, "hello");
      const kept = yield* stagePath(`${dir}/chat`, `${dir}/notes.txt`);
      expect(kept).toMatchObject({ name: "notes.txt", size: 5, mediaType: "text/plain" });
      expect(yield* fs.readFileString(pathOf(kept))).toBe("hello");
      expect(yield* stagePath(`${dir}/chat`, dir)).toEqual({ refused: `${dir} is a directory` });
      expect(yield* stagePath(`${dir}/chat`, `${dir}/nope.png`)).toEqual({
        refused: `${dir}/nope.png cannot be read`,
      });
    }),
  ));

test("a copy is pruned 30 days after it was made, and a newer one kept", () =>
  inDir((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${dir}/old.txt`, "old");
      yield* fs.writeFileString(`${dir}/new.txt`, "new");
      const old = pathOf(yield* stagePath(dir, `${dir}/old.txt`));
      const fresh = pathOf(yield* stagePath(dir, `${dir}/new.txt`));
      const now = yield* Clock.currentTimeMillis;
      // In seconds, as utimes takes a number.
      const monthAgo = (now - 31 * 24 * 60 * 60 * 1000) / 1000;
      yield* fs.utimes(old.slice(0, old.lastIndexOf("/")), monthAgo, monthAgo);

      yield* pruneAttachments(dir, now);
      expect(yield* fs.exists(old)).toBe(false);
      expect(yield* fs.exists(fresh)).toBe(true);
    }),
  ));
