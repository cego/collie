import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { RunRecords, runOfDir } from "../src/run-records";
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

const unchanged = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const records = yield* RunRecords;
    return yield* effect.pipe(
      Effect.provideService(RunRecords, {
        ...records,
        update: (run, name, change) =>
          records.update(run, name, (was) =>
            change(was).pipe(
              Effect.tap((now) =>
                now === was ? Effect.void : Effect.die(`${name} was rewritten`),
              ),
            ),
          ),
      }),
    );
  });

test("unchanged Step steering does not rewrite its state", () =>
  runEffect(
    unchanged(
      Effect.gen(function* () {
        yield* RunRecords.use((records) =>
          records.put(
            runOfDir("/run"),
            "step-steering.json",
            JSON.stringify({
              pauses: [],
              reached: null,
              notes: [
                {
                  id: "note-1",
                  step: "build",
                  by: "mk",
                  at: "2026-11-16T00:00:00Z",
                  text: "Keep the order",
                  read: "2026-11-16T00:01:00Z",
                  prompt: "prompt-1",
                },
              ],
            }),
          ),
        );
        expect(yield* reachPause("/run", "build")).toBeNull();
        yield* clearReachedPause("/run");
        expect(yield* takeStepNotes("/run", "build", "prompt-1")).toBe("Keep the order");
      }),
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
      yield* unchanged(
        Effect.gen(function* () {
          expect(yield* takeStepNotes(dir, "build", "prompt-1")).toBe("Keep the order");
          expect(yield* withdrawStepNote(dir, "note-1")).toBe(false);
        }),
      );
    }),
  ));
