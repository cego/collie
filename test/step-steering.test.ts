import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import {
  clearReachedPause,
  leaveStepNote,
  pauseBefore,
  readStepSteering,
  reachPause,
  takeStepNotes,
  withdrawStepNote,
} from "../src/step-steering";
import { runEffect } from "./support/effect";

test("unchanged Step steering does not rewrite its state", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* reachPause("/run", "build")).toBeNull();
      yield* clearReachedPause("/run");
      expect(yield* takeStepNotes("/run", "build", "prompt-1")).toBe("");
    }).pipe(
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readFileString: () => Effect.succeed('{"pauses":[],"reached":null,"notes":[]}'),
          writeFileString: () => Effect.die("unchanged Step steering was rewritten"),
        }),
      ),
    ),
  ));

test("pause transitions and note consumption persist while a prompt retry returns the same note", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-step-state-" });
      yield* pauseBefore(dir, "build", "mk", true);
      expect((yield* readStepSteering(dir)).pauses).toMatchObject([{ step: "build", by: "mk" }]);
      expect(yield* reachPause(dir, "build")).toMatchObject({ step: "build", by: "mk" });
      expect((yield* readStepSteering(dir)).reached).toMatchObject({ step: "build", by: "mk" });
      yield* clearReachedPause(dir);
      expect((yield* readStepSteering(dir)).reached).toBeNull();
      yield* leaveStepNote(dir, { id: "note-1", step: "build", by: "mk", text: "Keep the order" });
      expect(yield* takeStepNotes(dir, "build", "prompt-1")).toBe("Keep the order");
      expect((yield* readStepSteering(dir)).notes[0]).toMatchObject({
        id: "note-1",
        read: expect.any(String),
        prompt: "prompt-1",
      });
      yield* Effect.gen(function* () {
        expect(yield* takeStepNotes(dir, "build", "prompt-1")).toBe("Keep the order");
        expect(yield* withdrawStepNote(dir, "note-1")).toBe(false);
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          writeFileString: () => Effect.die("a consumed note was rewritten"),
        }),
      );
    }),
  ));
