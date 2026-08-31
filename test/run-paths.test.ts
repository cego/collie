// Defence in depth: even a name that slipped past definition validation cannot
// make a Run path land outside the Run directory.

import { Clock, DateTime, Effect, FileSystem, Path, Schema } from "effect";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { breakStaleLock, processStartTime } from "../src/lock";
import { RunStore, type Run } from "../src/run";
import { runEffect } from "./support/effect";

let stateDir: string;
let run: Run;
const JsonString = Schema.fromJsonString(Schema.Unknown);
const SummaryJson = Schema.fromJsonString(Schema.Struct({ summary: Schema.String }));
const encodeJson = Schema.encodeSync(JsonString);
const decodeSummary = Schema.decodeUnknownSync(SummaryJson);

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      stateDir = yield* fs.makeTempDirectory({ prefix: "hw-run-paths-" });
      run = yield* new RunStore(stateDir).create({
        workflow: "w",
        cwd: "/repo",
        inputs: {},
        inputSources: {},
        stepIds: ["build"],
        maxIterations: 1,
        primaryInput: "x",
      });
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(stateDir, { recursive: true, force: true });
    }),
  ),
);

test("safe components produce paths inside the run", () =>
  runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(yield* run.stepDir("build", null)).toBe(path.join(run.dir, "steps", "build"));
      expect(yield* run.stepDir("build.tickets", "pi-openai-codex-gpt-5.6-sol")).toBe(
        path.join(run.dir, "steps", "build.tickets", "pi-openai-codex-gpt-5.6-sol"),
      );
      expect(yield* run.outputPath("build", null, "build.json")).toBe(
        path.join(run.dir, "steps", "build", "build.json"),
      );
      expect(yield* run.personaPath("implementer", "claude")).toBe(
        path.join(run.dir, "personas", "implementer.claude.md"),
      );
    }),
  ));

test("a persona name cannot name a file outside the run", () =>
  expect(runEffect(run.personaPath("../../escape", "claude"))).rejects.toThrow(run.id));

test("an unsafe component refuses to produce a path at all", () =>
  runEffect(
    Effect.gen(function* () {
      for (const bad of ["", ".", "..", "../sibling", "a/b", "/etc", "a\\b"]) {
        expect((yield* Effect.exit(run.stepDir(bad, null)))._tag).toBe("Failure");
        if (bad !== "")
          expect((yield* Effect.exit(run.stepDir("build", bad)))._tag).toBe("Failure");
        expect((yield* Effect.exit(run.outputPath("build", null, bad)))._tag).toBe("Failure");
      }
      expect((yield* Effect.exit(run.outputPath("..", null, "run.json")))._tag).toBe("Failure");
    }),
  ));

test("a workflow name cannot place the Run directory outside the runs root", () =>
  expect(
    runEffect(
      new RunStore(stateDir).create({
        workflow: "../../escaped",
        cwd: "/repo",
        inputs: {},
        inputSources: {},
        stepIds: ["s"],
        maxIterations: 1,
        primaryInput: "x",
      }),
    ),
  ).rejects.toThrow("Run directory"));

test("a crashed holder's run lock is broken at once; the save neither waits nor spins", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const lock = path.join(run.dir, "run.json.lock");
      yield* fs.writeFileString(lock, `${encodeJson({ pid: 999999, start: "1" })}\n`);

      const started = yield* Clock.currentTimeMillis;
      run.record.summary = "saved past a dead holder";
      yield* run.save();

      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(500);
      expect(yield* fs.exists(lock)).toBe(false);
      const saved = decodeSummary(yield* fs.readFileString(path.join(run.dir, "run.json")));
      expect(saved.summary).toBe("saved past a dead holder");
    }),
  ));

test("lock staleness follows the holder: dead breaks now, live and mid-claim are respected", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const lock = path.join(run.dir, "run.json.lock");

      yield* fs.writeFileString(lock, "");
      expect(yield* breakStaleLock(lock)).toBe(false);
      expect(yield* fs.exists(lock)).toBe(true);

      yield* fs.writeFileString(
        lock,
        `${encodeJson({ pid: globalThis.process.pid, start: yield* processStartTime(globalThis.process.pid) })}\n`,
      );
      const old = DateTime.toDateUtc(
        DateTime.makeUnsafe((yield* Clock.currentTimeMillis) - 60_000),
      );
      yield* fs.utimes(lock, old, old);
      expect(yield* breakStaleLock(lock)).toBe(false);
      expect(yield* fs.exists(lock)).toBe(true);

      yield* fs.writeFileString(
        lock,
        `${encodeJson({ pid: globalThis.process.pid, start: "not-its-start" })}\n`,
      );
      expect(yield* breakStaleLock(lock)).toBe(true);
      expect(yield* fs.exists(lock)).toBe(false);

      yield* fs.writeFileString(lock, "");
      yield* fs.utimes(lock, old, old);
      const started = yield* Clock.currentTimeMillis;
      yield* run.save();
      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(500);
      expect(yield* fs.exists(lock)).toBe(false);

      yield* fs.writeFileString(lock, `${encodeJson({ pid: 999999, start: "1" })}\n`);
      expect(yield* breakStaleLock(lock)).toBe(true);
      expect(yield* fs.exists(lock)).toBe(false);
    }),
  ));
