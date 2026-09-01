import { Data, Schema, FileSystem, Clock, Effect, Option, Schedule, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { PlatformError } from "effect/PlatformError";

// Cooperative pid-lock files: `wx` creation is the claim; holder liveness, not age, decides
// staleness. `withLock` is the way in: claiming, breaking and giving back stay in here.

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
const tryClaimLock = Effect.fn("tryClaimLock")(function* (lock: string) {
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
const claimLock = Effect.fn("claimLock")(function* (lock: string) {
  if (yield* tryClaimLock(lock)) return true;
  return (yield* breakStaleLock(lock)) && (yield* tryClaimLock(lock));
});

/** The one acquisition policy: recover stale claims and wait out brief live contention. */
const acquireLock = Effect.fn("acquireLock")((lock: string) =>
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

/**
 * Runs `effect` while this process holds `lock`, and hands the lock back whichever way it
 * leaves. `Effect.ensuring`, not try/finally: a typed failure unwinds past a generator's
 * finally without entering it, and the lock would outlive the caller. `contended` is what
 * the caller gets instead when the lock is somebody else's.
 */
export const withLock = <A, E, R, A2, E2, R2>(
  lock: string,
  contended: Effect.Effect<A2, E2, R2>,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    if (!(yield* acquireLock(lock))) return yield* contended;
    return yield* effect.pipe(Effect.ensuring(releaseOwnLock(lock).pipe(Effect.ignore)));
  });

/**
 * Breaks a lock that no longer protects anything. True means the caller may retry its claim.
 * Inspection and removal happen under a break guard, so a contender that read the stale
 * claim cannot come back later and delete the fresh claim of whoever broke it first.
 */
export const breakStaleLock = Effect.fn("breakStaleLock")(function* (lock: string) {
  const fs = yield* FileSystem.FileSystem;
  const guard = `${lock}.break`;
  if (!(yield* claimBreakGuard(guard))) return false;
  return yield* inspectAndBreak(lock).pipe(
    Effect.ensuring(fs.remove(guard, { force: true }).pipe(Effect.ignore)),
  );
});

/** The guard is held for a few syscalls, so age is what tells a crashed breaker from a live one. */
const claimBreakGuard = Effect.fn("claimBreakGuard")(function* (guard: string) {
  const fs = yield* FileSystem.FileSystem;
  if (yield* tryClaimLock(guard)) return true;
  const fresh = yield* lockWriteIsFresh(guard).pipe(Effect.catch(() => Effect.succeed(false)));
  if (fresh) return false;
  yield* fs.remove(guard, { force: true });
  return yield* tryClaimLock(guard);
});

const inspectAndBreak = Effect.fn("inspectAndBreak")(function* (lock: string) {
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
const releaseOwnLock = Effect.fn("releaseOwnLock")(function* (lock: string) {
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
