// Desktop's own copies of what the human gives the Flock chat: a file named by its path is
// copied in or refused with its reason, and a copy is pruned once it is a month old.

import { expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Clock, Effect, FileSystem } from "effect";
import { stagePath } from "../desktop/src/bun/attachments";
import { desktopVerdicts } from "../src/desktop";
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

test("cleanup removes a copy unused for 30 days and a transfer abandoned for a day, and keeps a newer one", () =>
  inDir((dir) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${dir}/old.txt`, "old");
      yield* fs.writeFileString(`${dir}/new.txt`, "new");
      const old = pathOf(yield* stagePath(dir, `${dir}/old.txt`));
      yield* stagePath(dir, `${dir}/new.txt`);
      yield* fs.makeDirectory(`${dir}/attachments/.partial`, { recursive: true });
      yield* fs.writeFileString(`${dir}/attachments/.partial/1-5`, "half");
      yield* fs.writeFileString(`${dir}/attachments/.partial/2-5`, "half");
      const now = yield* Clock.currentTimeMillis;
      // In seconds, as utimes takes a number.
      const daysAgo = (days: number) => (now - days * 24 * 60 * 60 * 1000) / 1000;
      const copy = old.slice(0, old.lastIndexOf("/"));
      yield* fs.utimes(copy, daysAgo(31), daysAgo(31));
      yield* fs.utimes(`${dir}/attachments/.partial/1-5`, daysAgo(2), daysAgo(2));

      const verdicts = yield* desktopVerdicts({
        root: `${dir}/none`,
        state: dir,
        hash: null,
        version: null,
      });
      expect(verdicts.remove.map(({ target }) => target).sort()).toEqual(
        [copy, `${dir}/attachments/.partial/1-5`].sort(),
      );
    }),
  ));
