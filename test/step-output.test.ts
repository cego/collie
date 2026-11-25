import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { acceptOutput, carriedFor, outputOf, recordCarried } from "../src/step-output";
import { awaitOutput, submitOutput, takeOutput } from "../src/output-submit";
import { RunRecords } from "../src/run-records";
import { runEffect } from "./support/effect";
import { recordsAt } from "./support/records";

let stateDir: string;
beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      stateDir = yield* (yield* FileSystem.FileSystem).makeTempDirectory({
        prefix: "hw-step-output-",
      });
    }),
  ),
);
afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      yield* (yield* FileSystem.FileSystem).remove(stateDir, { recursive: true, force: true });
    }),
  ),
);

const fileAt = () => `${stateDir}/agents/r1/review.json`;
const withRecords = <A, E>(effect: Effect.Effect<A, E, RunRecords | FileSystem.FileSystem>) =>
  Effect.provide(effect, recordsAt(stateDir));
const writeFile = (text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(`${stateDir}/agents/r1`, { recursive: true });
    yield* fs.writeFileString(fileAt(), text);
  });

test("a step this build dispatched reads only the fact, and a file its agent wrote is not its Output", () =>
  runEffect(
    withRecords(
      Effect.gen(function* () {
        const records = yield* RunRecords;
        yield* writeFile(`{"verdict":"clean","note":"from the file"}`);
        expect(
          yield* outputOf(records, { runId: "r1", output: fileAt(), submitOnly: true }),
        ).toBeNull();
        yield* acceptOutput(
          records,
          { runId: "r1", output: fileAt(), submitOnly: true },
          "submitted",
        );
        expect(
          yield* outputOf(records, { runId: "r1", output: fileAt(), submitOnly: true }),
        ).toMatchObject({
          text: "submitted",
          file: false,
        });
      }),
    ),
  ));

test("a step an older build dispatched reads the file its agent wrote, and keeps it behind a fact", () =>
  runEffect(
    withRecords(
      Effect.gen(function* () {
        const records = yield* RunRecords;
        expect(yield* outputOf(records, { runId: "r1", output: fileAt() })).toBeNull();
        yield* writeFile(`{"verdict":"clean","note":"from the file"}`);
        const before = yield* outputOf(records, { runId: "r1", output: fileAt() });
        expect(before?.file).toBe(true);
        expect(before?.text).toContain("from the file");
        yield* acceptOutput(records, { runId: "r1", output: fileAt() }, "submitted");
        expect(yield* outputOf(records, { runId: "r1", output: fileAt() })).toMatchObject({
          text: "submitted",
          file: false,
        });
      }),
    ),
  ));

test("a step registered again after a restart accepts the same Output, refuses a different one, and keeps the fact", () =>
  runEffect(
    withRecords(
      Effect.gen(function* () {
        const records = yield* RunRecords;
        const step = { runId: "r1", output: fileAt(), submitOnly: true };
        yield* awaitOutput("r1", "a", fileAt(), () => null);
        expect(yield* submitOutput("r1", "a", "first")).toBe("accepted");
        const accepted = yield* outputOf(records, step);
        yield* awaitOutput("r1", "a", fileAt(), () => null);
        expect(yield* submitOutput("r1", "a", "first")).toBe("accepted");
        expect(yield* submitOutput("r1", "a", "second")).toContain("differs from it");
        expect(yield* outputOf(records, step)).toEqual(accepted);
        expect(yield* records.fact("r1", "accepted/review.json")).not.toBeNull();
      }),
    ),
  ));

test("a differing submit after the step took its Output writes nothing", () =>
  runEffect(
    withRecords(
      Effect.gen(function* () {
        const step = { runId: "r1", output: fileAt() };
        yield* awaitOutput("r1", "a", fileAt(), () => null);
        expect(yield* submitOutput("r1", "a", { summary: "kept" })).toBe("accepted");
        yield* takeOutput(yield* RunRecords, step, "kept");
        expect(yield* submitOutput("r1", "a", { summary: "later" })).toContain("No step of r1");
        expect((yield* outputOf(yield* RunRecords, step))?.text).toContain("kept");
      }),
    ),
  ));

test("the same Output submitted again is accepted without moving its time", () =>
  runEffect(
    withRecords(
      Effect.gen(function* () {
        const step = { runId: "r1", output: fileAt() };
        const records = yield* RunRecords;
        yield* awaitOutput("r1", "a", fileAt(), () => null);
        yield* submitOutput("r1", "a", { summary: "kept" });
        const first = (yield* outputOf(records, step))!.at;
        expect(yield* submitOutput("r1", "a", { summary: "kept" })).toBe("accepted");
        expect((yield* outputOf(records, step))!.at).toBe(first);
      }),
    ),
  ));

test("a replay of the dispatch whose Output was collected cannot replace it", () =>
  runEffect(
    withRecords(
      Effect.gen(function* () {
        const records = yield* RunRecords;
        const step = { runId: "r1", output: fileAt(), submitOnly: true };
        yield* awaitOutput("r1", "a", fileAt(), () => null, "review@1");
        expect(yield* submitOutput("r1", "a", "first")).toBe("accepted");
        yield* takeOutput(records, step, "first");
        yield* awaitOutput("r1", "a", fileAt(), () => null, "review@1");
        expect(yield* submitOutput("r1", "a", "second")).toContain("differs from it");
        expect((yield* outputOf(records, step))?.text).toBe("first");
      }),
    ),
  ));

test("a step dispatched again in a new round takes its new Output", () =>
  runEffect(
    withRecords(
      Effect.gen(function* () {
        const records = yield* RunRecords;
        const step = { runId: "r1", output: fileAt(), submitOnly: true };
        yield* awaitOutput("r1", "a", fileAt(), () => null, "review@1");
        yield* submitOutput("r1", "a", "first");
        yield* takeOutput(records, step, "first");
        yield* awaitOutput("r1", "a", fileAt(), () => null, "review@2");
        expect(yield* submitOutput("r1", "a", "second")).toBe("accepted");
        expect((yield* outputOf(records, step))?.text).toBe("second");
      }),
    ),
  ));

test("a new round refuses a differing submit once it has accepted one of its own", () =>
  runEffect(
    withRecords(
      Effect.gen(function* () {
        const records = yield* RunRecords;
        const step = { runId: "r1", output: fileAt(), submitOnly: true };
        yield* awaitOutput("r1", "a", fileAt(), () => null, "review@1");
        yield* submitOutput("r1", "a", "first");
        yield* takeOutput(records, step, "first");
        yield* awaitOutput("r1", "a", fileAt(), () => null, "review@2");
        expect(yield* submitOutput("r1", "a", "second")).toBe("accepted");
        expect(yield* submitOutput("r1", "a", "different")).toContain("differs from it");
        expect((yield* outputOf(records, step))?.text).toBe("second");
      }),
    ),
  ));

test("a reader at a new dispatch does not read the round before it", () =>
  runEffect(
    withRecords(
      Effect.gen(function* () {
        const records = yield* RunRecords;
        const step = { runId: "r1", output: fileAt(), submitOnly: true };
        yield* awaitOutput("r1", "a", fileAt(), () => null, "review@1");
        yield* submitOutput("r1", "a", "first");
        yield* takeOutput(records, step, "first");
        const next = { ...step, dispatch: "review@2" };
        expect(yield* outputOf(records, next)).toBeNull();
      }),
    ),
  ));

test("a step's time is when its Output was accepted, not when a file beside it was written", () =>
  runEffect(
    withRecords(
      Effect.gen(function* () {
        const records = yield* RunRecords;
        yield* writeFile(`{"verdict":"clean","note":"from the file"}`);
        const file = (yield* outputOf(records, { runId: "r1", output: fileAt() }))!;
        yield* acceptOutput(records, { runId: "r1", output: fileAt() }, "submitted");
        const accepted = (yield* outputOf(records, { runId: "r1", output: fileAt() }))!;
        expect(accepted.text).toBe("submitted");
        expect(accepted.file).toBe(false);
        expect(accepted.at).toBeGreaterThanOrEqual(file.at);
      }),
    ),
  ));

test("a carried Output is a copy, kept apart from what the step accepted", () =>
  runEffect(
    withRecords(
      Effect.gen(function* () {
        const records = yield* RunRecords;
        const step = { runId: "r1", output: fileAt(), submitOnly: true };
        yield* recordCarried(records, step, "the parent's words", "the-parent");
        expect(yield* outputOf(records, step)).toBeNull();
        expect(yield* carriedFor(records, step)).toMatchObject({
          text: "the parent's words",
          from: "the-parent",
        });
      }),
    ),
  ));
