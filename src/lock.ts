import * as Cause from "effect/Cause";
import {
  Data,
  Duration,
  Schema,
  FileSystem,
  Clock,
  Effect,
  Option,
  Path,
  Random,
  Schedule,
  flow,
  Result,
} from "effect";
import { startedOf } from "./processes";

const LOCK_CLAIM_RETRIES = 40;
export const LOCK_CLAIM_SPACING_MS = 25;
const LOCK_WRITE_GRACE_MS = 10_000;

class LockContended extends Data.TaggedError("LockContended") {}

export interface LockHolder {
  pid: number;
  // WARNING: The start time tells a reused pid from the holder.
  start: string | null;
}

const LockHolderSchema = Schema.Struct({ pid: Schema.Int, start: Schema.NullOr(Schema.String) });
const LockHolderJson = Schema.fromJsonString(LockHolderSchema);
const decodeLockHolderJson = flow(Schema.decodeUnknownResult(LockHolderJson), Result.getOrThrow);

export const hostLockOf = (stateDir: string) => `${stateDir}/host.lock`;

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

const ownClaim = Effect.fn("ownClaim")(function* () {
  const me = yield* currentPid;
  const holder: LockHolder = { pid: me, start: yield* processStartTime(me) };
  return `${yield* Schema.encodeEffect(LockHolderJson)(holder)}\n`;
});

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

const claimLock = Effect.fn("claimLock")(function* (lock: string) {
  if (yield* tryClaimLock(lock)) return true;
  return (yield* breakStaleLock(lock)) && (yield* tryClaimLock(lock));
});

const acquireLock = Effect.fn("acquireLock")(function* (
  claim: ReturnType<typeof claimLock>,
  claims: number | Duration.Duration,
) {
  const until = Duration.isDuration(claims)
    ? (yield* Clock.currentTimeMillis) + Duration.toMillis(claims)
    : Infinity;
  const nextClaimInTime = Clock.currentTimeMillis.pipe(
    Effect.map((now) => now + LOCK_CLAIM_SPACING_MS < until),
  );
  return yield* claim.pipe(
    Effect.flatMap((claimed) =>
      claimed ? Effect.succeed(true) : Effect.fail(new LockContended()),
    ),
    Effect.retry({
      times: Duration.isDuration(claims) ? undefined : claims,
      schedule: Schedule.spaced(LOCK_CLAIM_SPACING_MS),
      while: (error) => (error instanceof LockContended ? nextClaimInTime : false),
    }),
    Effect.catchTag("LockContended", () => Effect.succeed(false)),
  );
});

// WARNING: The release is attached before the first claim, or an interrupt between them strands the lock.
export const withLock = <A, E, R, A2, E2, R2>(
  lock: string,
  contended: Effect.Effect<A2, E2, R2>,
  effect: Effect.Effect<A, E, R>,
  claims: number | Duration.Duration = LOCK_CLAIM_RETRIES,
) =>
  Effect.suspend(() => {
    let held = false;
    const claim = claimLock(lock).pipe(
      Effect.tap((claimed) =>
        Effect.sync(() => {
          held = claimed;
        }),
      ),
      Effect.uninterruptible,
    );
    const proceed: (claimed: boolean) => Effect.Effect<A | A2, E | E2, R | R2> = (claimed) =>
      claimed ? effect : contended;
    return acquireLock(claim, claims).pipe(
      Effect.flatMap(proceed),
      Effect.ensuring(
        Effect.suspend(() => (held ? releaseOwnLock(lock).pipe(Effect.ignore) : Effect.void)),
      ),
    );
  });

// WARNING: The first claim fails on a directory nothing has created yet.
export const ensureLockDir = Effect.fn("ensureLockDir")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
});

// WARNING: Break under the guard: a contender that read a stale claim must not delete a fresh one.
export const breakStaleLock = Effect.fn("breakStaleLock")(function* (lock: string) {
  const guard = `${lock}.break`;
  if (!(yield* claimBreakGuard(guard))) return false;
  return yield* inspectAndBreak(lock).pipe(
    Effect.ensuring(releaseOwnLock(guard).pipe(Effect.ignore)),
  );
});

// WARNING: Take over a stale guard by renaming over it, never remove then create: two breakers would each delete the other's claim.
const claimBreakGuard = Effect.fn("claimBreakGuard")(function* (guard: string) {
  const fs = yield* FileSystem.FileSystem;
  if (yield* tryClaimLock(guard)) return true;
  const fresh = yield* lockWriteIsFresh(guard).pipe(
    Effect.catchTag("PlatformError", (error) => Effect.succeed(error.reason._tag === "NotFound")),
  );
  if (fresh) return false;
  // WARNING: Per claim, not per process: fibers of one process share a guard too.
  const tmp = `${guard}.${yield* currentPid}.${yield* Random.nextInt}.tmp`;
  yield* fs.writeFileString(tmp, yield* ownClaim());
  yield* fs.rename(tmp, guard);
  return yield* holdsLock(guard);
});

// WARNING: No lock means no removal: a claim that arrived in between would be deleted.
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
    // WARNING: An unreadable lock must not be broken.
    Effect.catchTag("PlatformError", (error) => Effect.succeed(error.reason._tag === "NotFound")),
  ),
);

export const lockHolder: (
  lock: string,
) => Effect.Effect<LockHolder | null, never, FileSystem.FileSystem> = Effect.fn("lockHolder")(
  function* (lock: string) {
    const claim = yield* readClaim(lock).pipe(Effect.orElseSucceed(() => null));
    return claim === null ? null : validHolder(claim);
  },
);

export const holdsLock = Effect.fn("holdsLock")(function* (lock: string) {
  const fs = yield* FileSystem.FileSystem;
  const me = yield* currentPid;
  return yield* fs.readFileString(lock).pipe(
    Effect.map((raw) => decodeLockHolder(raw)?.pid === me),
    Effect.orElseSucceed(() => false),
  );
});

export const releaseOwnLock = Effect.fn("releaseOwnLock")(function* (lock: string) {
  const fs = yield* FileSystem.FileSystem;
  if (yield* holdsLock(lock)) yield* fs.remove(lock, { force: true });
});

// WARNING: A loser waits out the winner, then reads what it wrote, rather than failing as busy.
export const READ_WRITE_LOCK_BUDGET = Duration.seconds(30);

// WARNING: Every writer of a Run's files takes it, so two amendments cannot both write.
export function withDirLock<A, E, R>(
  dir: string,
  effect: Effect.Effect<A, E, R>,
  budget: Duration.Duration = READ_WRITE_LOCK_BUDGET,
) {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const lock = path.join(dir, "run.json.lock");
    return yield* withLock(
      lock,
      Effect.fail(new Cause.TimeoutError(`${lock} could not be acquired; not writing unlocked`)),
      effect,
      budget,
    );
  });
}

export const processStartTime = startedOf;

function decodeLockHolder(raw: string) {
  try {
    return decodeLockHolderJson(raw);
  } catch {
    return null;
  }
}

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

function validHolder(claim: string) {
  const holder = decodeLockHolder(claim);
  return holder && Number.isInteger(holder.pid) && holder.pid > 0 ? holder : null;
}

// WARNING: A malformed claim gets a grace period to finish its atomic write.
export const lockWriteIsFresh = Effect.fn("lockWriteIsFresh")(function* (lock: string) {
  const fs = yield* FileSystem.FileSystem;
  const at = yield* Clock.currentTimeMillis;
  const stat = yield* fs.stat(lock);
  return at - (Option.isSome(stat.mtime) ? stat.mtime.value.getTime() : at) <= LOCK_WRITE_GRACE_MS;
});

export const holderLives = Effect.fn("holderLives")(function* (holder: LockHolder) {
  if (!(yield* signalProcess(holder.pid))) return false;
  if (holder.start === null) return true;
  const start = yield* processStartTime(holder.pid);
  return start === null || start === holder.start;
});
