import { Data, Schema, FileSystem, Clock, Effect, Option, Path, Schedule, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

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

/** This process's claim, as it is written into a lock file. */
const ownClaim = Effect.fn("ownClaim")(function* () {
  const me = yield* currentPid;
  const holder: LockHolder = { pid: me, start: yield* processStartTime(me) };
  return `${yield* Schema.encodeEffect(LockHolderJson)(holder)}\n`;
});

/** One wx attempt. False means the lock is held; anything but contention throws. */
const tryClaimLock = Effect.fn("tryClaimLock")(function* (lock: string) {
  const fs = yield* FileSystem.FileSystem;
  const encoded = yield* ownClaim();
  return yield* fs.writeFileString(lock, encoded, { flag: "wx" }).pipe(
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
const acquireLock = Effect.fn("acquireLock")((lock: string, claims: number) =>
  claimLock(lock).pipe(
    Effect.flatMap((claimed) =>
      claimed ? Effect.succeed(true) : Effect.fail(new LockContended()),
    ),
    Effect.retry({
      times: claims,
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
  /** How many claims to make first, for a caller that can wait longer than a second. */
  claims: number = LOCK_CLAIM_RETRIES,
) =>
  Effect.gen(function* () {
    if (!(yield* acquireLock(lock, claims))) return yield* contended;
    return yield* effect.pipe(Effect.ensuring(releaseOwnLock(lock).pipe(Effect.ignore)));
  });

/**
 * The directory a lock is about to be written into. The lock is usually the first thing in
 * it, so without this the first claim fails on a directory nothing has created yet.
 */
export const ensureLockDir = Effect.fn("ensureLockDir")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
});

/**
 * Breaks a lock that no longer protects anything. True means the caller may retry its claim.
 * Inspection and removal happen under a break guard, so a contender that read the stale
 * claim cannot come back later and delete the fresh claim of whoever broke it first.
 */
export const breakStaleLock = Effect.fn("breakStaleLock")(function* (lock: string) {
  const guard = `${lock}.break`;
  if (!(yield* claimBreakGuard(guard))) return false;
  return yield* inspectAndBreak(lock).pipe(
    Effect.ensuring(releaseOwnLock(guard).pipe(Effect.ignore)),
  );
});

/**
 * The guard is held for a few syscalls, so age is what tells a crashed breaker from a live
 * one. A guard that old is taken over by renaming this process's claim over it, never by
 * removing it first: two contenders that both find it stale would then each delete the
 * claim the other had just made, and both would go on to break the lock. Renaming leaves
 * exactly one claim in the file, and whoever's claim that is holds the guard.
 */
const claimBreakGuard = Effect.fn("claimBreakGuard")(function* (guard: string) {
  const fs = yield* FileSystem.FileSystem;
  if (yield* tryClaimLock(guard)) return true;
  const fresh = yield* lockWriteIsFresh(guard).pipe(Effect.catch(() => Effect.succeed(false)));
  if (fresh) return false;
  const tmp = `${guard}.${yield* currentPid}.tmp`;
  yield* fs.writeFileString(tmp, yield* ownClaim());
  yield* fs.rename(tmp, guard);
  return yield* holdsLock(guard);
});

/**
 * Under the guard: decide on the claim that is in the lock, and remove only that claim.
 * A lock that is not there needs no removing — removing on that path would delete a claim
 * that arrived between the two, and its owner would never learn it had lost the lock — and
 * a claim whose bytes changed since the inspection is no longer the one judged stale.
 */
const inspectAndBreak = Effect.fn("inspectAndBreak")((lock: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const claim = yield* readClaim(lock);
    if (claim === null) return true;
    const holder = validHolder(claim);
    const stale = holder ? !(yield* holderLives(holder)) : !(yield* lockWriteIsFresh(lock));
    if (!stale) return false;
    if ((yield* readClaim(lock)) !== claim) return false;
    yield* fs.remove(lock, { force: true });
    return true;
  }).pipe(
    // A lock that cannot be read is one that must not be broken; one that has gone in the
    // meantime leaves the caller free to claim, which `wx` decides on its own.
    Effect.catchTag("PlatformError", (error) => Effect.succeed(error.reason._tag === "NotFound")),
  ),
);

/** Who holds this lock, as the claim records it, or null when nobody does. */
export const lockHolder: (
  lock: string,
) => Effect.Effect<LockHolder | null, never, FileSystem.FileSystem> = Effect.fn("lockHolder")(
  function* (lock: string) {
    const claim = yield* readClaim(lock).pipe(Effect.orElseSucceed(() => null));
    return claim === null ? null : validHolder(claim);
  },
);

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

/** The claim in the lock, as written, or null when the lock is not there. */
const readClaim = Effect.fn("readClaim")(function* (lock: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs
    .readFileString(lock)
    .pipe(
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
      ),
    );
});

/** A claim only names a holder when it decodes to a pid that could be one. */
function validHolder(claim: string): LockHolder | null {
  const holder = decodeLockHolder(claim);
  return holder && Number.isInteger(holder.pid) && holder.pid > 0 ? holder : null;
}

/** A malformed claim gets this grace period to finish its atomic write. */
export const lockWriteIsFresh = Effect.fn("lockWriteIsFresh")(function* (lock: string) {
  const fs = yield* FileSystem.FileSystem;
  const at = yield* Clock.currentTimeMillis;
  const stat = yield* fs.stat(lock);
  return at - (Option.isSome(stat.mtime) ? stat.mtime.value.getTime() : at) <= LOCK_WRITE_GRACE_MS;
});

const holderLives = Effect.fn("holderLives")(function* (holder: LockHolder) {
  if (!(yield* signalProcess(holder.pid))) return false;
  if (holder.start === null) return true;
  const start = yield* processStartTime(holder.pid);
  return start === null || start === holder.start;
});
