import { expect, test } from "bun:test";
import { Deferred, Effect, FileSystem, Stream } from "effect";
import { definitionChanges } from "../src/peers";
import { runEffect } from "./support/effect";
import { until } from "./support/host";

test("a definitions catch-up waits for every watch, so a save made before they are in place is still seen", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const userDir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-definition-changes-" });
      for (const kind of ["workflows", "personas"]) yield* fs.makeDirectory(`${userDir}/${kind}`);
      const watching = yield* Deferred.make<void>();
      const watchedFs: FileSystem.FileSystem = {
        ...fs,
        watch: (path, options) =>
          Stream.unwrap(Effect.as(Deferred.await(watching), fs.watch(path, options))),
      };
      const changes: Array<boolean> = [];
      yield* definitionChanges(userDir, ["workflows", "personas"]).pipe(
        Stream.runForEach(() => Effect.sync(() => changes.push(Deferred.isDoneUnsafe(watching)))),
        Effect.provideService(FileSystem.FileSystem, watchedFs),
        Effect.forkScoped,
      );

      yield* until(
        () => Effect.succeed(changes.length),
        (told) => told > 0,
      ).pipe(Effect.timeout("500 millis"), Effect.ignore);
      yield* Deferred.succeed(watching, undefined);
      yield* until(
        () => Effect.succeed(changes.length),
        (told) => told > 0,
      );
      expect(changes).toEqual([true]);
    }).pipe(Effect.scoped),
  ));
