import { afterEach, beforeEach, expect, test } from "bun:test";
import * as Arr from "effect/Array";
import { Effect, FileSystem } from "effect";
import { readEnv } from "../src/env";
import { laneFor } from "../src/flow-read";
import { outputsIn } from "../src/drift";
import { operationsOf, recordLaunch } from "../src/launches";
import type { Launched } from "../src/launches";
import { RunRecords } from "../src/run-records";
import { acceptOutput } from "../src/step-output";
import { trialRecordsOf } from "../src/trial";
import { REVIEW_ROLE } from "../src/cards";
import { runEffect } from "./support/effect";
import { runFacts } from "./support/records";

let stateDir: string;
beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      stateDir = yield* (yield* FileSystem.FileSystem).makeTempDirectory({ prefix: "hw-readers-" });
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

const reviewOutput = () => `${stateDir}/agents/r1/review.json`;

const launched = (over: Partial<Launched> = {}): Launched => ({
  agent: "r1-review-r1",
  output: reviewOutput(),
  reused: false,
  runId: "r1",
  operation: "review",
  role: REVIEW_ROLE,
  workflow: "implement",
  harness: "claude",
  submitOnly: true,
  ...over,
});

const accepted = (output: string, text: string) =>
  RunRecords.use((records) => acceptOutput(records, { runId: "r1", output }, text));

test("a step whose Output was accepted, with no file, is done in the Run's steps and on its lane", () =>
  runEffect(
    Effect.gen(function* () {
      yield* recordLaunch(launched());
      expect(Arr.map(yield* operationsOf("r1"), (one) => one.done)).toEqual([false]);
      yield* accepted(reviewOutput(), `{"findings":[]}`);
      expect(Arr.map(yield* operationsOf("r1"), (one) => one.done)).toEqual([true]);
      const lane = yield* laneFor(
        readEnv({
          COLLIE_ROOT: stateDir,
          COLLIE_STATE_DIR: stateDir,
          COLLIE_USER_DIR: `${stateDir}/user`,
          COLLIE_CWD: stateDir,
        }),
        runFacts({ id: "r1", dir: `${stateDir}/runs/r1`, evidence: `${stateDir}/evidence/r1` }),
      );
      expect(Arr.map(lane.nodes, (one) => one.state)).toContain("done");
    }),
  ));

test("a reviewer's findings are read from its accepted Output, with no file", () =>
  runEffect(
    Effect.gen(function* () {
      yield* recordLaunch(launched());
      yield* accepted(
        reviewOutput(),
        `{"findings":[{"severity":"minor","title":"a name","body":"rename it","files":[]}]}`,
      );
      const records = yield* trialRecordsOf(stateDir, "r1");
      expect(records.reviews).toHaveLength(1);
      expect(Arr.map(records.reviews[0]!, (one) => one.title)).toEqual(["a name"]);
    }),
  ));

test("an accepted Output is among the Outputs drift and oversight are shown, with no file", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${stateDir}/agents/r1`, { recursive: true });
      yield* accepted(reviewOutput(), `{"summary":"from the fact"}`);
      const shown = yield* outputsIn(`${stateDir}/agents/r1`, "r1");
      expect(shown.outputs).toHaveLength(1);
      expect(shown.outputs[0]).toMatchObject({ operation: "review" });
      expect(shown.outputs[0]!.text).toContain("from the fact");
    }),
  ));

test("an older Run's steps still read as done from their files", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${stateDir}/agents/r1`, { recursive: true });
      yield* fs.writeFileString(reviewOutput(), `{"findings":[]}`);
      yield* recordLaunch(
        (({ submitOnly: _ignored, ...older }) => ({ ...older, outputSubmit: "file" }))(launched()),
      );
      expect(Arr.map(yield* operationsOf("r1"), (one) => one.done)).toEqual([true]);
      const shown = yield* outputsIn(`${stateDir}/agents/r1`, "r1");
      expect(shown.outputs[0]!.text).toContain("findings");
    }),
  ));

test("the accepted Output's name is the step's Output file", () =>
  runEffect(
    Effect.gen(function* () {
      yield* accepted(reviewOutput(), "kept");
      const records = yield* RunRecords;
      expect((yield* records.factsUnder("r1", "accepted/")).map((one) => one.name)).toEqual([
        "accepted/review.json",
      ]);
    }),
  ));

test("a file at a submit-only step's Output path, with no fact, is not shown to drift", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${stateDir}/agents/r1`, { recursive: true });
      yield* recordLaunch(launched());
      yield* fs.writeFileString(reviewOutput(), `{"summary":"written by the agent"}`);
      const shown = yield* outputsIn(`${stateDir}/agents/r1`, "r1");
      expect(shown.outputs).toEqual([]);
    }),
  ));

test("drift is shown no more than 20 Outputs, however many facts a Run has", () =>
  runEffect(
    Effect.gen(function* () {
      for (let step = 0; step < 21; step++) {
        yield* accepted(`${stateDir}/agents/r1/step-${step}.json`, `{"step":${step}}`);
      }
      const shown = yield* outputsIn(`${stateDir}/agents/r1`, "r1");
      expect(shown.outputs).toHaveLength(20);
      expect(shown.truncated).toBe(true);
    }),
  ));
