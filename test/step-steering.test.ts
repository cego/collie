import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { RunRecords, runOfDir } from "../src/run-records";
import { appendStepLine } from "../src/steps";
import {
  clearReachedPause,
  leaveStepNote,
  pauseBefore,
  readStepSteering,
  reachPause,
  stepTarget,
  takeStepNotes,
  withdrawStepNote,
} from "../src/step-steering";
import { runEffect } from "./support/effect";
import { stringifyJson } from "../src/json";

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
            stringifyJson({
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

test("a step that has handed in takes no note when it will not run again", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const where = yield* fs.makeTempDirectoryScoped({ prefix: "collie-step-target-" });
      const meta = (id: string) => ({
        id,
        title: id,
        description: "",
        kind: "agent" as const,
        role: null,
        produces: null,
      });
      yield* appendStepLine(where, {
        kind: "forecast",
        at: "2026-11-25T00:00:00Z",
        steps: [meta("build"), meta("looped")],
      });
      yield* appendStepLine(where, {
        kind: "enter",
        at: "2026-11-25T00:00:01Z",
        key: "build#1",
        step: meta("build"),
        place: { round: 1, of: 1 },
      });
      yield* appendStepLine(where, {
        kind: "enter",
        at: "2026-11-25T00:00:02Z",
        key: "looped#1",
        step: meta("looped"),
        place: { round: 1, of: 2 },
      });
      expect((yield* stepTarget(where, "build")).step).toMatchObject({ id: "build" });
      expect(yield* stepTarget(where, "build", true)).toMatchObject({
        refused: "Step build has handed in its Output and will not run again",
      });
      expect((yield* stepTarget(where, "looped", true)).step).toMatchObject({ id: "looped" });
    }),
  ));
