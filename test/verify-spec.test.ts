// Which commands Collie may run itself is a permission, so where it comes from and what
// happens to a Run when that file changes are the whole of what matters here.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem, Path } from "effect";
import { runEffect } from "./support/effect";
import { approvedFor, approvedFrom, renderApproved, PROJECT_FILE } from "../src/verify-spec";
import { DEFAULT_AUTHORITY, seedIntent } from "../src/intent";
import { VerifySpecSchema, type VerifySpec } from "../src/verify-spec";
import { RunStore } from "../src/run";
import { Schema } from "effect";

const RecordJson = Schema.fromJsonString(Schema.Unknown);
const decodeRecord = Schema.decodeUnknownSync(RecordJson);
const encodeRecord = Schema.encodeSync(RecordJson);
const encodeSpecs = Schema.encodeSync(Schema.fromJsonString(Schema.Array(VerifySpecSchema)));

let cwd: string;
let configDir: string;

const TESTS: VerifySpec = { name: "tests", executable: "bun", argv: ["test"], cwd: "." };
const LINT: VerifySpec = { name: "lint", executable: "bun", argv: ["run", "lint"], cwd: "." };

const writeText = (file: string, text: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, text);
  });

const write = (file: string, specs: ReadonlyArray<VerifySpec>) =>
  writeText(file, encodeSpecs(specs));

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      cwd = yield* fs.makeTempDirectory({ prefix: "hw-approved-cwd-" });
      configDir = yield* fs.makeTempDirectory({ prefix: "hw-approved-config-" });
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(cwd, { recursive: true, force: true });
      yield* fs.remove(configDir, { recursive: true, force: true });
    }),
  ),
);

test("no file anywhere approves nothing, which is not an error", () =>
  runEffect(
    Effect.gen(function* () {
      expect(yield* approvedFrom({ cwd, configDir })).toEqual([]);
    }),
  ));

test("the user's file is used when the project has none", () =>
  runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      yield* write(path.join(configDir, "verify.json"), [LINT]);
      expect(yield* approvedFrom({ cwd, configDir })).toEqual([LINT]);
    }),
  ));

test("the project's file wins whole, and the user's is not merged into it", () =>
  runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      yield* write(path.join(configDir, "verify.json"), [LINT]);
      yield* write(path.join(cwd, PROJECT_FILE), [TESTS]);
      // Not [TESTS, LINT]: the project said what this repository's verifications are,
      // and adding the user's global ones would run a command neither file names here.
      expect(yield* approvedFrom({ cwd, configDir })).toEqual([TESTS]);
    }),
  ));

test("a file that does not decode names itself, and never reads as approving nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const file = path.join(cwd, PROJECT_FILE);
      yield* writeText(file, `[{"name":"tests","executable":"bun"}]`);
      const result = yield* approvedFrom({ cwd, configDir }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(String(result.failure)).toContain(file);
    }),
  ));

test("an Intent's authority is the set; the seed is only for a Run with no Intent", () => {
  const intent = (specs: VerifySpec[]) => ({
    authority: { ...DEFAULT_AUTHORITY, run_verification: specs },
  });
  expect(approvedFor([TESTS], null)).toEqual([TESTS]);
  expect(approvedFor([TESTS], intent([LINT]))).toEqual([LINT]);
  // An Intent that grants nothing is a Run that may run nothing: the last entry was
  // removed by a human, and the seed does not put it back behind their back.
  expect(approvedFor([TESTS], intent([]))).toEqual([]);
  // Which is why the seed goes into the Intent at version 1, and is the set from there.
  const seeded = seedIntent("r1", { runVerification: [TESTS] });
  expect(seeded.authority.run_verification).toEqual([TESTS]);
  expect(approvedFor([LINT], seeded)).toEqual([TESTS]);
  expect(seedIntent("r1", {}).authority.run_verification).toEqual([]);
});

test("the approved set renders as the commands a human would recognise", () => {
  expect(renderApproved([])).toContain("none approved");
  const rendered = renderApproved([TESTS, LINT]);
  expect(rendered).toContain("tests: bun test");
  expect(rendered).toContain("lint: bun run lint");
});

test("a Run keeps the set it started with, whatever the file says later", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectory({ prefix: "hw-approved-state-" });
      yield* write(path.join(cwd, PROJECT_FILE), [TESTS]);

      const run = yield* new RunStore(stateDir).create({
        workflow: "implement",
        cwd,
        inputs: {},
        inputSources: {},
        approvedVerifications: yield* approvedFrom({ cwd, configDir }),
        stepIds: ["build"],
        maxIterations: 1,
        namedAfter: "x",
      });
      expect(run.record.approved_verifications).toEqual([TESTS]);

      // Someone edits the project's file after the Run is going. A permission that moved
      // under a Run is not a permission, so the Run is unchanged.
      yield* write(path.join(cwd, PROJECT_FILE), [LINT]);
      const loaded = yield* new RunStore(stateDir).load(run.id);
      expect(loaded.record.approved_verifications).toEqual([TESTS]);
      expect(yield* approvedFrom({ cwd, configDir })).toEqual([LINT]);
    }),
  ));

test("a Run recorded before approved sets existed decodes as approving nothing", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stateDir = yield* fs.makeTempDirectory({ prefix: "hw-approved-legacy-" });
      const run = yield* new RunStore(stateDir).create({
        workflow: "implement",
        cwd,
        inputs: {},
        inputSources: {},
        stepIds: ["build"],
        maxIterations: 1,
        namedAfter: "x",
      });
      const file = path.join(run.dir, "run.json");
      // SAFETY: RunStore wrote this file a moment ago, so it is a record with this key.
      const raw = decodeRecord(yield* fs.readFileString(file)) as {
        approved_verifications?: ReadonlyArray<VerifySpec>;
      };
      delete raw.approved_verifications;
      yield* fs.writeFileString(file, encodeRecord(raw));

      const loaded = yield* new RunStore(stateDir).load(run.id);
      expect(loaded.record.approved_verifications).toEqual([]);
    }),
  ));
