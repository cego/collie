import { Data, Schema, FileSystem, Clock, Effect, Option, Schedule, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { PlatformError } from "effect/PlatformError";

// Cooperative pid-lock files: `wx` creation is the claim; holder liveness, not age, decides staleness.

/** Brief contention gets one second to clear before the operation fails. */
const LOCK_CLAIM_RETRIES = 40;
const LOCK_CLAIM_RETRY_INTERVAL = "25 millis";
const LOCK_WRITE_GRACE_MS = 10_000;
const PROC_STAT_START_TIME_INDEX = 19;

class LockContended extends Data.TaggedError("LockContended") {}

export interface LockHolder {
  pid: number;
  /** The process's start time, so a reused pid is not mistaken for the holder. */
  start: string | null;
}

const LockHolderSchema = Schema.Struct({ pid: Schema.Int, start: Schema.NullOr(Schema.String) });
const LockHolderJson = Schema.fromJsonString(LockHolderSchema);
const decodeLockHolderJson = Schema.decodeUnknownSync(LockHolderJson);

export const currentPid = Effect.sync(() => globalThis.process.pid);
export const signalProcess = (id: number, signal: NodeJS.Signals | 0 = 0) =>
  Effect.sync(() => {
    try {
      globalThis.process.kill(id, signal);
      return true;
    } catch {
      return false;
    }
  });

/** One wx attempt. False means the lock is held; anything but contention throws. */
export const tryClaimLock = Effect.fn("tryClaimLock")(function* (lock: string) {
  const fs = yield* FileSystem.FileSystem;
  const me = yield* currentPid;
  const holder: LockHolder = { pid: me, start: yield* processStartTime(me) };
  const encoded = yield* Schema.encodeEffect(LockHolderJson)(holder);
  return yield* fs.writeFileString(lock, `${encoded}\n`, { flag: "wx" }).pipe(
    Effect.as(true),
    Effect.catchTag("PlatformError", (e) =>
      e.reason._tag === "AlreadyExists" ? Effect.succeed(false) : Effect.fail(e),
    ),
  );
});

/** Claims an available lock, breaking one stale holder before the final attempt. */
export const claimLock = Effect.fn("claimLock")(function* (lock: string) {
  if (yield* tryClaimLock(lock)) return true;
  return (yield* breakStaleLock(lock)) && (yield* tryClaimLock(lock));
});

/** The one acquisition policy: recover stale claims and wait out brief live contention. */
export const acquireLock = Effect.fn("acquireLock")((lock: string) =>
  claimLock(lock).pipe(
    Effect.flatMap((claimed) =>
      claimed ? Effect.succeed(true) : Effect.fail(new LockContended()),
    ),
    Effect.retry({
      times: LOCK_CLAIM_RETRIES,
      schedule: Schedule.spaced(LOCK_CLAIM_RETRY_INTERVAL),
      while: (error) => error instanceof LockContended,
    }),
    Effect.catchTag("LockContended", () => Effect.succeed(false)),
  ),
);

/** Breaks a lock that no longer protects anything. True means the caller may retry its claim. */
export const breakStaleLock = Effect.fn("breakStaleLock")(function* (lock: string) {
  const fs = yield* FileSystem.FileSystem;
  const now = yield* Clock.currentTimeMillis;
  const shouldBreak = yield* readHolder(lock).pipe(
    Effect.flatMap((holder) =>
      holder
        ? holderLives(holder).pipe(Effect.map((live) => !live))
        : lockWriteIsFresh(lock, now).pipe(Effect.map((fresh) => !fresh)),
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
  const me = yield* currentPid;
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
    Effect.map(
      (stat) =>
        stat.slice(stat.lastIndexOf(")") + 2).split(" ")[PROC_STAT_START_TIME_INDEX] || null,
    ),
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
    const holder = decodeLockHolder(raw);
    return holder && Number.isInteger(holder.pid) && holder.pid > 0 ? holder : null;
  });
}

/** A malformed claim gets this grace period to finish its atomic write. */
export const lockWriteIsFresh = Effect.fn("lockWriteIsFresh")(function* (
  lock: string,
  now?: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const at = now ?? (yield* Clock.currentTimeMillis);
  const stat = yield* fs.stat(lock);
  return at - (Option.isSome(stat.mtime) ? stat.mtime.value.getTime() : at) <= LOCK_WRITE_GRACE_MS;
});

const holderLives = Effect.fn("holderLives")(function* (holder: LockHolder) {
  if (!(yield* signalProcess(holder.pid))) return false;
  if (holder.start === null) return true;
  const start = yield* processStartTime(holder.pid);
  return start === null || start === holder.start;
});
