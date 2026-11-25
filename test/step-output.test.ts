import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { acceptOutput, acceptedName, outputOf } from "../src/step-output";
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

test("accepted is final: the same text is accepted again, a different one is refused, and the fact stands", () =>
  runEffect(
    withRecords(
      Effect.gen(function* () {
        const records = yield* RunRecords;
        const step = { runId: "r1", output: fileAt(), submitOnly: true };
        expect(yield* acceptOutput(records, step, "first")).toBe("first");
        const at = (yield* outputOf(records, step))?.at;
        expect(yield* acceptOutput(records, step, "first")).toBe("first");
        expect(yield* acceptOutput(records, step, "second")).toBe("first");
        const after = yield* outputOf(records, step);
        expect(after?.text).toBe("first");
        expect(after?.at).toBe(at);
        expect(yield* records.fact("r1", acceptedName(fileAt()))).not.toBeNull();
      }),
    ),
  ));

test("a fact written before the step was collected is what the step collects, with no agent asked again", () =>
  runEffect(
    withRecords(
      Effect.gen(function* () {
        const records = yield* RunRecords;
        const step = { runId: "r1", output: fileAt(), submitOnly: true };
        yield* acceptOutput(records, step, "submitted before the restart");
        expect(yield* outputOf(records, step)).toMatchObject({
          text: "submitted before the restart",
          file: false,
        });
        expect((yield* records.factsUnder("r1", "accepted/")).map((one) => one.name)).toEqual([
          acceptedName(fileAt()),
        ]);
      }),
    ),
  ));
