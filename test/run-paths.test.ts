// Defence in depth: even a name that slipped past definition validation cannot
// make a Run path land outside the Run directory.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { breakStaleLock, processStartTime } from "../src/lock";
import { RunStore, type Run } from "../src/run";

let stateDir: string;
let run: Run;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "hw-run-paths-"));
  run = new RunStore(stateDir).create({
    workflow: "w",
    cwd: "/repo",
    inputs: {},
    inputSources: {},
    stepIds: ["build"],
    maxIterations: 1,
    primaryInput: "x",
  });
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

test("safe components produce paths inside the run", () => {
  expect(run.stepDir("build", null)).toBe(join(run.dir, "steps", "build"));
  expect(run.stepDir("build.tickets", "pi-openai-codex-gpt-5.6-sol")).toBe(
    join(run.dir, "steps", "build.tickets", "pi-openai-codex-gpt-5.6-sol"),
  );
  expect(run.outputPath("build", null, "build.json")).toBe(join(run.dir, "steps", "build", "build.json"));
  expect(run.personaPath("implementer", "claude")).toBe(join(run.dir, "personas", "implementer.claude.md"));
});

test("a persona name cannot name a file outside the run", () => {
  expect(() => run.personaPath("../../escape", "claude")).toThrow(run.id);
});

test("an unsafe component refuses to produce a path at all", () => {
  for (const bad of ["", ".", "..", "../sibling", "a/b", "/etc", "a\\b"]) {
    expect(() => run.stepDir(bad, null), `step id ${JSON.stringify(bad)}`).toThrow(run.id);
    // An empty variant key is the "no variant" spelling, not an escape.
    if (bad !== "") expect(() => run.stepDir("build", bad), `variant ${JSON.stringify(bad)}`).toThrow(run.id);
    expect(() => run.outputPath("build", null, bad), `output ${JSON.stringify(bad)}`).toThrow(run.id);
  }
  // Nothing was created outside the run on the way to the error.
  expect(() => run.outputPath("..", null, "run.json")).toThrow();
});

test("a workflow name cannot place the Run directory outside the runs root", () => {
  const store = new RunStore(stateDir);
  expect(() =>
    store.create({
      workflow: "../../escaped",
      cwd: "/repo",
      inputs: {},
      inputSources: {},
      stepIds: ["s"],
      maxIterations: 1,
      primaryInput: "x",
    }),
  ).toThrow("Run directory");
});

test("a crashed holder's run lock is broken at once; the save neither waits nor spins", () => {
  const lock = join(run.dir, "run.json.lock");
  writeFileSync(lock, `${JSON.stringify({ pid: 999999, start: "1" })}\n`);

  const started = Date.now();
  run.record.summary = "saved past a dead holder";
  run.save();

  expect(Date.now() - started).toBeLessThan(500);
  // The dead holder's lock went with the save, and the save itself landed.
  expect(existsSync(lock)).toBe(false);
  expect(JSON.parse(readFileSync(join(run.dir, "run.json"), "utf8")).summary).toBe("saved past a dead holder");
});

test("lock staleness follows the holder: dead breaks now, live and mid-claim are respected", () => {
  const lock = join(run.dir, "run.json.lock");

  // wx is a create then a write; a reader between them sees an empty lock. That
  // is a holder mid-claim, not staleness — respected until the age backstop.
  writeFileSync(lock, "");
  expect(breakStaleLock(lock)).toBe(false);
  expect(existsSync(lock)).toBe(true);

  // A live holder's lock is respected — even one old enough that age alone
  // would once have broken it: a suspension is not staleness.
  writeFileSync(lock, `${JSON.stringify({ pid: process.pid, start: processStartTime(process.pid) })}\n`);
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  expect(breakStaleLock(lock)).toBe(false);
  expect(existsSync(lock)).toBe(true);

  // A pid that now belongs to a different process is not the holder.
  writeFileSync(lock, `${JSON.stringify({ pid: process.pid, start: "not-its-start" })}\n`);
  expect(breakStaleLock(lock)).toBe(true);
  expect(existsSync(lock)).toBe(false);

  // Past the grace, an unreadable lock is leftovers — and the save proceeds.
  writeFileSync(lock, "");
  utimesSync(lock, old, old);
  const started = Date.now();
  run.save();
  expect(Date.now() - started).toBeLessThan(500);
  expect(existsSync(lock)).toBe(false);

  // A dead holder's lock is broken at once, with no ageing.
  writeFileSync(lock, `${JSON.stringify({ pid: 999999, start: "1" })}\n`);
  expect(breakStaleLock(lock)).toBe(true);
  expect(existsSync(lock)).toBe(false);
});
