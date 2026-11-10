import * as Str from "effect/String";
import { Deferred, Effect, Fiber, FileSystem } from "effect";
import { expect, test } from "bun:test";
import { editState } from "./support/fake-herdr-core";
import { runEffect } from "./support/effect";

test("a test's edit of the fake herdr's state waits out a call in flight and lands on its write", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const log = `${yield* fs.makeTempDirectoryScoped()}/herdr-calls.jsonl`;
      const state = `${log}.state.json`;
      const lock = `${log}.lock`;
      yield* fs.writeFileString(state, "gone\n");
      // A call in flight: it holds the lock, read the state, and will write it back with an agent it started.
      yield* fs.makeDirectory(lock);
      const waiting = yield* Deferred.make<void>();
      const watched: FileSystem.FileSystem = {
        ...fs,
        makeDirectory: (path, options) =>
          fs
            .makeDirectory(path, options)
            .pipe(
              Effect.ensuring(path === lock ? Deferred.succeed(waiting, undefined) : Effect.void),
            ),
      };
      const edited = yield* Deferred.make<void>();
      const editing = yield* Effect.forkChild(
        editState(log, (text) =>
          Deferred.succeed(edited, undefined).pipe(Effect.as(Str.replace("gone\n", "")(text))),
        ).pipe(Effect.provideService(FileSystem.FileSystem, watched)),
      );
      yield* Effect.raceFirst(Deferred.await(waiting), Deferred.await(edited));
      yield* fs.writeFileString(state, "gone\nstarted\n");
      yield* fs.remove(lock, { recursive: true });
      yield* Fiber.join(editing);
      expect(yield* fs.readFileString(state)).toBe("started\n");
    }).pipe(Effect.orDie),
  ));
