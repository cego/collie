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

test("a lock that vanished before stale-lock inspection permits another claim", () =>
  runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(yield* breakStaleLock(path.join(run.dir, "vanished.lock"))).toBe(true);
    }),
  ));

test("a break already in progress leaves the stale lock for its breaker", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const lock = path.join(run.dir, "guarded.lock");

      yield* fs.writeFileString(lock, `${encodeJson({ pid: 999999, start: "1" })}\n`);
      yield* fs.writeFileString(`${lock}.break`, "");

      expect(yield* breakStaleLock(lock)).toBe(false);
      expect(yield* fs.exists(lock)).toBe(true);
    }),
  ));

test("a break guard left by a crashed breaker is recovered", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const lock = path.join(run.dir, "crashed.lock");
      const guard = `${lock}.break`;

      yield* fs.writeFileString(lock, `${encodeJson({ pid: 999999, start: "1" })}\n`);
      yield* fs.writeFileString(guard, "");
      const old = DateTime.toDateUtc(
        DateTime.makeUnsafe((yield* Clock.currentTimeMillis) - 60_000),
      );
      yield* fs.utimes(guard, old, old);

      expect(yield* breakStaleLock(lock)).toBe(true);
      expect(yield* fs.exists(lock)).toBe(false);
      expect(yield* fs.exists(guard)).toBe(false);
    }),
  ));

test("taking over a crashed breaker's guard leaves this process's own claim", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const lock = path.join(run.dir, "takeover.lock");
      const guard = `${lock}.break`;

      // A live holder, so the break stops after the guard and the guard stays claimed.
      yield* fs.writeFileString(
        lock,
        `${encodeJson({ pid: globalThis.process.pid, start: yield* processStartTime(globalThis.process.pid) })}\n`,
      );
      yield* fs.writeFileString(guard, `${encodeJson({ pid: 999999, start: "1" })}\n`);
      const old = DateTime.toDateUtc(
        DateTime.makeUnsafe((yield* Clock.currentTimeMillis) - 60_000),
      );
      yield* fs.utimes(guard, old, old);

      expect(yield* breakStaleLock(lock)).toBe(false);
      // Released because the claim in it was this process's own, never removed blind.
      expect(yield* fs.exists(guard)).toBe(false);
      expect((yield* fs.readDirectory(run.dir)).some((e) => e.endsWith(".tmp"))).toBe(false);
    }),
  ));

/**
 * A fifo at the lock path makes each read block until this test writes it, which puts the
 * inspection and the check before the removal under the test's control.
 */
const breakInChild = (lock: string, marker: string) => {
  const lockModule = new URL("../src/lock.ts", import.meta.url).pathname.replaceAll("'", "\\'");
  return Bun.spawn(
    [
      "bun",
      "-e",
      `import { BunServices } from "@effect/platform-bun"; import { ManagedRuntime } from "effect"; import { breakStaleLock } from '${lockModule}'; const runtime = ManagedRuntime.make(BunServices.layer); await Bun.write(process.argv[2], ""); console.log("broke=" + (await runtime.runPromise(breakStaleLock(process.argv[1]))))`,
      lock,
      marker,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
};

/** Opening a fifo for writing fails until its reader is there, so keep offering. */
const feed = Effect.fn("test.feed")(function* (fifo: string, text: string) {
  const deadline = (yield* Clock.currentTimeMillis) + 30_000;
  for (;;) {
    const written = yield* Effect.promise(() =>
      Bun.write(fifo, text).then(
        () => true,
        () => false,
      ),
    );
    if (written) return;
    expect(yield* Clock.currentTimeMillis).toBeLessThan(deadline);
    yield* Effect.promise(() => Bun.sleep(10));
  }
});

const awaitMarker = Effect.fn("test.awaitMarker")(function* (marker: string) {
  const fs = yield* FileSystem.FileSystem;
  const deadline = (yield* Clock.currentTimeMillis) + 30_000;
  while (!(yield* fs.exists(marker)) && (yield* Clock.currentTimeMillis) < deadline) {
    yield* Effect.promise(() => Bun.sleep(10));
  }
  expect(yield* fs.exists(marker)).toBe(true);
});

test("a claim that changed since it was inspected is never the one removed", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const stale = `${encodeJson({ pid: 999999, start: "1" })}\n`;
      const live = `${encodeJson({ pid: globalThis.process.pid, start: null })}\n`;

      const changed = path.join(run.dir, "changed.lock");
      Bun.spawnSync(["mkfifo", changed]);
      const child = breakInChild(changed, path.join(run.dir, "changed.ready"));
      yield* awaitMarker(path.join(run.dir, "changed.ready"));
      // The inspection sees a dead holder; the check before the removal sees a live claim
      // that arrived since, so the lock is left to its new owner.
      yield* feed(changed, stale);
      yield* feed(changed, live);

      expect(yield* Effect.promise(() => new Response(child.stdout).text())).toContain(
        "broke=false",
      );
      expect(yield* fs.exists(changed)).toBe(true);

      const unchanged = path.join(run.dir, "unchanged.lock");
      Bun.spawnSync(["mkfifo", unchanged]);
      const second = breakInChild(unchanged, path.join(run.dir, "unchanged.ready"));
      yield* awaitMarker(path.join(run.dir, "unchanged.ready"));
      yield* feed(unchanged, stale);
      yield* feed(unchanged, stale);

      expect(yield* Effect.promise(() => new Response(second.stdout).text())).toContain(
        "broke=true",
      );
      expect(yield* fs.exists(unchanged)).toBe(false);
    }),
  ));
