// Cooperative pid-lock files, shared by the Run's persistence lock and the
// Driver's takeover lock: `wx` creation is the claim, the holder's identity is
// the content, and staleness is judged by that holder's fate — never by age
// alone, because a suspended holder is still a holder.

import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

interface LockHolder {
  pid: number;
  /** The process's start time, so a reused pid is not mistaken for the holder. */
  start: string | null;
}

/** One wx attempt. False means the lock is held; anything but contention throws. */
export function tryClaimLock(lock: string): boolean {
  try {
    const holder: LockHolder = { pid: process.pid, start: processStartTime(process.pid) };
    writeFileSync(lock, `${JSON.stringify(holder)}\n`, { flag: "wx" });
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    return false;
  }
}

/**
 * Breaks a lock that no longer protects anything: its holder is dead, or its pid
 * now belongs to a different process. A verified-live holder's lock is never
 * broken, however old — a suspension is not staleness — and unreadable contents
 * (a holder caught between its create and its write) get an mtime grace before
 * being treated as leftovers. True means the caller may retry its claim.
 */
export function breakStaleLock(lock: string): boolean {
  try {
    const holder = readHolder(lock);
    if (holder) {
      if (holderLives(holder)) return false;
    } else if (Date.now() - statSync(lock).mtimeMs <= 10_000) {
      return false;
    }
  } catch {
    // The lock vanished between the claim and this read: retry the claim.
    return true;
  }
  rmSync(lock, { force: true });
  return true;
}

/** Whether the lock still carries this process's own claim. */
export function holdsLock(lock: string): boolean {
  try {
    return (JSON.parse(readFileSync(lock, "utf8")) as LockHolder)?.pid === process.pid;
  } catch {
    return false;
  }
}

/** Removes the lock only while it is still this process's own: a holder whose
 * lock was taken over must not delete its successor's lock on the way out. */
export function releaseOwnLock(lock: string): void {
  if (holdsLock(lock)) rmSync(lock, { force: true });
}

/**
 * When this pid's process started, as an opaque token: /proc on Linux, `ps`
 * where there is no /proc. Null means the identity cannot be read.
 */
export function processStartTime(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // Fields after the parenthesised comm; starttime is field 22 overall.
    const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    if (start) return start;
  } catch {
    /* no /proc, or the process is gone */
  }
  try {
    const out = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)]).stdout.toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Unparseable contents read as "no holder yet"; a missing file throws to the caller. */
function readHolder(lock: string): LockHolder | null {
  const raw = readFileSync(lock, "utf8");
  try {
    const holder = JSON.parse(raw) as LockHolder;
    return Number.isInteger(holder?.pid) && holder.pid > 0 ? holder : null;
  } catch {
    return null;
  }
}

function holderLives(holder: LockHolder): boolean {
  if (!pidAlive(holder.pid)) return false;
  // Identity unknowable — at claim time, or right now — reads as "still the
  // holder": breaking a possibly-live lock is worse than waiting for one.
  if (holder.start === null) return true;
  const start = processStartTime(holder.pid);
  return start === null || start === holder.start;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
