// The lock every writer of a Run's directory takes: a crashed holder's claim is broken
// at once, a live one is respected, and a claim that moved is never the one removed.

import { Clock, DateTime, Effect, FileSystem, Path, Schema } from "effect";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { breakStaleLock, processStartTime, withDirLock } from "../src/lock";
import { runEffect } from "./support/effect";

let stateDir: string;
let dir: string;
const JsonString = Schema.fromJsonString(Schema.Unknown);
const encodeJson = Schema.encodeSync(JsonString);

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      stateDir = yield* fs.makeTempDirectory({ prefix: "hw-run-paths-" });
      dir = `${stateDir}/runs/r1`;
      yield* fs.makeDirectory(dir, { recursive: true });
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
test("a crashed holder's run lock is broken at once; the save neither waits nor spins", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const lock = path.join(dir, "run.json.lock");
      yield* fs.writeFileString(lock, `${encodeJson({ pid: 999999, start: "1" })}\n`);

      const started = yield* Clock.currentTimeMillis;
      const file = path.join(dir, "intent.json");
      yield* withDirLock(dir, fs.writeFileString(file, "saved past a dead holder"));

      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(500);
      expect(yield* fs.exists(lock)).toBe(false);
      expect(yield* fs.readFileString(file)).toBe("saved past a dead holder");
    }),
  ));

test("lock staleness follows the holder: dead breaks now, live and mid-claim are respected", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const lock = path.join(dir, "run.json.lock");

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
      yield* withDirLock(dir, Effect.void);
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
      expect(yield* breakStaleLock(path.join(dir, "vanished.lock"))).toBe(true);
    }),
  ));

test("a break already in progress leaves the stale lock for its breaker", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const lock = path.join(dir, "guarded.lock");

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
      const lock = path.join(dir, "crashed.lock");
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
      const lock = path.join(dir, "takeover.lock");
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
      expect((yield* fs.readDirectory(dir)).some((e) => e.endsWith(".tmp"))).toBe(false);
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

      const changed = path.join(dir, "changed.lock");
      Bun.spawnSync(["mkfifo", changed]);
      const child = breakInChild(changed, path.join(dir, "changed.ready"));
      yield* awaitMarker(path.join(dir, "changed.ready"));
      // The inspection sees a dead holder; the check before the removal sees a live claim
      // that arrived since, so the lock is left to its new owner.
      yield* feed(changed, stale);
      yield* feed(changed, live);

      expect(yield* Effect.promise(() => new Response(child.stdout).text())).toContain(
        "broke=false",
      );
      expect(yield* fs.exists(changed)).toBe(true);

      // An ordinary file for this half, not a fifo: what is being tested is that a claim
      // which has *not* changed between the two reads is broken, and a file gives both
      // reads the same bytes by construction. Feeding a fifo twice does not — the two
      // writes can be taken as one read, leaving the second read with nothing and the
      // test failing for a reason that has nothing to do with the lock.
      const unchanged = path.join(dir, "unchanged.lock");
      yield* fs.writeFileString(unchanged, stale);
      const second = breakInChild(unchanged, path.join(dir, "unchanged.ready"));

      expect(yield* Effect.promise(() => new Response(second.stdout).text())).toContain(
        "broke=true",
      );
      expect(yield* fs.exists(unchanged)).toBe(false);
    }),
  ));
