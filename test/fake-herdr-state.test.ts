import * as Str from "effect/String";
import { Effect, Fiber, FileSystem } from "effect";
import { expect, test } from "bun:test";
import { editState } from "./support/fake-herdr-core";
import { runEffect } from "./support/effect";

test("a test's edit of the fake herdr's state waits out a call in flight and lands on its write", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const log = `${yield* fs.makeTempDirectoryScoped()}/herdr-calls.jsonl`;
      const state = `${log}.state.json`;
      yield* fs.writeFileString(state, "gone\n");
      // A call in flight: it holds the lock, read the state, and will write it back with an agent it started.
      yield* fs.makeDirectory(`${log}.lock`);
      const editing = yield* Effect.forkChild(
        editState(log, (text) => Effect.succeed(Str.replace("gone\n", "")(text))),
      );
      yield* Effect.sleep("200 millis");
      yield* fs.writeFileString(state, "gone\nstarted\n");
      yield* fs.remove(`${log}.lock`, { recursive: true });
      yield* Fiber.join(editing);
      expect(yield* fs.readFileString(state)).toBe("started\n");
    }).pipe(Effect.orDie),
  ));
