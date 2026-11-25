import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import * as Str from "effect/String";
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
import { recordLaunch } from "../src/launches";
import { recordOutput } from "../src/step-output";

const played = (runId: string, output: string) => ({
  agent: "r1-build",
  output,
  reused: false,
  runId,
  operation: "build",
  role: "implementer",
  workflow: "agent-work",
  harness: "claude",
  at: 1000,
});

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
      const run = runOfDir(where);
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
      const handIn = (key: string, output: string) => (text: string) =>
        Effect.gen(function* () {
          yield* recordLaunch({
            ...played(run, output),
            step: { step: Str.startsWith("build")(key) ? "build" : "looped", place: null, key },
          });
          yield* RunRecords.use((records) => recordOutput(records, { runId: run, output }, text));
        });
      expect((yield* stepTarget(where, "build")).step).toMatchObject({ id: "build" });
      yield* handIn("build#1", `${where}/build.json`)(`{"summary":"built"}`);
      expect(yield* stepTarget(where, "build")).toMatchObject({
        refused: "Step build has handed in its Output and will not run again",
      });
      expect((yield* stepTarget(where, "looped")).step).toMatchObject({ id: "looped" });
    }),
  ));

test("a note reaches the Step that is running, not one an earlier ticket handed in", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const where = yield* fs.makeTempDirectoryScoped({ prefix: "collie-step-target-" });
      const run = runOfDir(where);
      const meta = {
        id: "build",
        title: "build",
        description: "",
        kind: "agent" as const,
        role: null,
        produces: null,
      };
      yield* appendStepLine(where, { kind: "forecast", at: "2026-11-25T00:00:00Z", steps: [meta] });
      const items = ["01-first.md", "02-second.md"];
      for (const item of items) {
        yield* appendStepLine(where, {
          kind: "enter",
          at: "2026-11-25T00:00:01Z",
          key: `build@${item}`,
          step: meta,
          place: { item, items },
        });
      }
      const first = `${where}/agents/r1/build-01.json`;
      yield* recordLaunch({
        ...played(run, first),
        step: { step: "build", place: { item: items[0]!, items }, key: "build@01-first.md" },
      });
      yield* RunRecords.use((records) =>
        recordOutput(records, { runId: run, output: first }, "one"),
      );
      expect((yield* stepTarget(where, "build")).step).toMatchObject({ id: "build" });
    }),
  ));
