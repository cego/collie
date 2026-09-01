import { Schema, FileSystem, Clock, Effect, Option, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { PlatformError } from "effect/PlatformError";

// Cooperative pid-lock files: `wx` creation is the claim; holder liveness, not age, decides staleness.

/** Brief contention gets one second to clear before the operation fails. */
export const LOCK_CLAIM_RETRIES = 40;
export const LOCK_CLAIM_RETRY_INTERVAL = "25 millis";

export interface LockHolder {
  pid: number;
  /** The process's start time, so a reused pid is not mistaken for the holder. */
  start: string | null;
}

const LockHolderSchema = Schema.Struct({ pid: Schema.Int, start: Schema.NullOr(Schema.String) });
const LockHolderJson = Schema.fromJsonString(LockHolderSchema);
const decodeLockHolderJson = Schema.decodeUnknownSync(LockHolderJson);

const pid = Effect.sync(() => globalThis.process.pid);
const alive = (id: number, signal?: NodeJS.Signals) =>
  Effect.sync(() => {
    try {
      globalThis.process.kill(id, signal ?? 0);
      return true;
    } catch {
      return false;
    }
  });

/** One wx attempt. False means the lock is held; anything but contention throws. */
export const tryClaimLock = Effect.fn("tryClaimLock")(function* (lock: string) {
  const fs = yield* FileSystem.FileSystem;
  const me = yield* pid;
  const holder: LockHolder = { pid: me, start: yield* processStartTime(me) };
  const encoded = yield* Schema.encodeEffect(LockHolderJson)(holder);
  return yield* fs.writeFileString(lock, `${encoded}\n`, { flag: "wx" }).pipe(
    Effect.as(true),
    Effect.catchTag("PlatformError", (e) =>
      e.reason._tag === "AlreadyExists" ? Effect.succeed(false) : Effect.fail(e),
    ),
  );
});

/** Breaks a lock that no longer protects anything. True means the caller may retry its claim. */
export const breakStaleLock = Effect.fn("breakStaleLock")(function* (lock: string) {
  const fs = yield* FileSystem.FileSystem;
  const now = yield* Clock.currentTimeMillis;
  const shouldBreak = yield* readHolder(lock).pipe(
    Effect.flatMap((holder) =>
      holder
        ? holderLives(holder).pipe(Effect.map((live) => !live))
        : fs
            .stat(lock)
            .pipe(
              Effect.map(
                (s) => now - (Option.isSome(s.mtime) ? s.mtime.value.getTime() : now) > 10_000,
              ),
            ),
    ),
    Effect.catchTag("PlatformError", (error) => Effect.succeed(error.reason._tag === "NotFound")),
  );
  if (!shouldBreak) return false;
  yield* fs.remove(lock, { force: true });
  return true;
});

/** Whether the lock still carries this process's own claim. */
export const holdsLock = Effect.fn("holdsLock")(function* (lock: string) {
  const fs = yield* FileSystem.FileSystem;
  const me = yield* pid;
  return yield* fs.readFileString(lock).pipe(
    Effect.map((raw) => decodeLockHolder(raw)?.pid === me),
    Effect.catch(() => Effect.succeed(false)),
  );
});

/** Removes the lock only while it is still this process's own. */
export const releaseOwnLock = Effect.fn("releaseOwnLock")(function* (lock: string) {
  const fs = yield* FileSystem.FileSystem;
  if (yield* holdsLock(lock)) yield* fs.remove(lock, { force: true });
});

/** When this pid's process started, as an opaque token. Null means the identity cannot be read. */
export const processStartTime = Effect.fn("processStartTime")(function* (id: number) {
  const fs = yield* FileSystem.FileSystem;
  const proc = yield* fs.readFileString(`/proc/${id}/stat`).pipe(
    Effect.map((stat) => stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] || null),
    Effect.catchTag("PlatformError", () => Effect.succeed(null)),
  );
  if (proc) return proc;
  // No /proc, so macOS: ask ps. Through the Effect spawner, so the one command this
  // module runs goes through the same boundary as every other.
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* Effect.gen(function* () {
    const handle = yield* spawner.spawn(
      ChildProcess.make("ps", ["-o", "lstart=", "-p", String(id)], {
        stdout: "pipe",
        stderr: "ignore",
      }),
    );
    const out = yield* handle.stdout.pipe(
      Stream.decodeText(),
      Stream.runFold(
        (): string => "",
        (all, chunk) => all + chunk,
      ),
    );
    return out.trim() || null;
  }).pipe(
    Effect.scoped,
    Effect.catch(() => Effect.succeed(null)),
  );
});

function decodeLockHolder(raw: string): LockHolder | null {
  try {
    return decodeLockHolderJson(raw);
  } catch {
    return null;
  }
}

function readHolder(
  lock: string,
): Effect.Effect<LockHolder | null, PlatformError, FileSystem.FileSystem> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(lock);
    try {
      const holder = decodeLockHolder(raw);
      return holder && Number.isInteger(holder.pid) && holder.pid > 0 ? holder : null;
    } catch {
      return null;
    }
  });
}

const holderLives = Effect.fn("holderLives")(function* (holder: LockHolder) {
  if (!(yield* alive(holder.pid))) return false;
  if (holder.start === null) return true;
  const start = yield* processStartTime(holder.pid);
  return start === null || start === holder.start;
});
