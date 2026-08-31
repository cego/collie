// The run dir is the channel between a detached run driver and the Control Plane.
// The driver has no terminal of its own: it writes what it is doing, and asks its
// questions, through files. Everything here is a plain file so both sides survive
// the other being closed, killed or resumed.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { breakStaleLock, holdsLock, processStartTime, releaseOwnLock, tryClaimLock } from "./lock";
import type { EnginePrompts } from "./engine";
import type { PickItem } from "./picker";

/** One line per thing the driver did, as the runner pane used to print it. */
export const PROGRESS = "progress.jsonl";
/** The same lines unstructured, plus anything that went wrong in detail. */
export const RUNNER_LOG = "runner.log";
/** Who is driving this run, so a resume does not start a second one. */
export const RUNNER_PID = "runner.pid";
/** The question a Choice step is waiting on, and the answer it is waiting for. */
export const CHOICE = "choice.json";
export const CHOICE_ANSWER = "choice-answer.json";

export interface ProgressLine {
  at: string;
  text: string;
}

export interface PendingChoice {
  /** Stamped by the driver so an answer cannot settle a question it was not asked. */
  id: string;
  kind: "menu" | "ask";
  /** The run this belongs to, so the board can name it without reading it twice. */
  run: string;
  step: string;
  header: string;
  footer: string;
  items: PickItem[];
}

export interface ChoiceAnswer {
  id: string;
  /** The chosen item's id, the typed text, or null for "the human backed out". */
  choice?: string | null;
  text?: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function read<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    // Half-written: the next poll will see it whole.
    return null;
  }
}

export function appendProgress(dir: string, text: string): void {
  mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString();
  appendFileSync(join(dir, PROGRESS), `${JSON.stringify({ at, text })}\n`);
  appendFileSync(join(dir, RUNNER_LOG), `${at} ${text}\n`);
}

/** Whatever the driver has said, oldest first; a broken line is skipped, not fatal. */
export function readProgress(dir: string, limit = 0): ProgressLine[] {
  const path = join(dir, PROGRESS);
  if (!existsSync(path)) return [];
  const lines: ProgressLine[] = [];
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    if (raw.trim() === "") continue;
    try {
      lines.push(JSON.parse(raw) as ProgressLine);
    } catch {
      /* a line torn by a concurrent write */
    }
  }
  return limit > 0 ? lines.slice(-limit) : lines;
}

/** The last thing the driver said, which is what a run's row shows. */
export function lastProgress(dir: string): string | null {
  return readProgress(dir, 1)[0]?.text ?? null;
}

export function writeChoice(dir: string, choice: PendingChoice): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, CHOICE), `${JSON.stringify(choice, null, 2)}\n`);
}

export function readChoice(dir: string): PendingChoice | null {
  return read<PendingChoice>(join(dir, CHOICE));
}

export function answerChoice(dir: string, answer: ChoiceAnswer): void {
  writeFileSync(join(dir, CHOICE_ANSWER), `${JSON.stringify(answer)}\n`);
}

export function clearChoice(dir: string): void {
  for (const name of [CHOICE, CHOICE_ANSWER]) rmSync(join(dir, name), { force: true });
}

/** The ownership claim in `runner.pid`: which process, and which incarnation of it. */
export interface OwnerRecord {
  pid: number;
  /** The process's start time, so a later process reusing the pid is not the driver. */
  start: string | null;
  at: string;
}

function readOwner(dir: string): OwnerRecord | null {
  const raw = read<OwnerRecord | number>(join(dir, RUNNER_PID));
  // A claim from before ownership records: a bare pid, identity unknowable.
  if (typeof raw === "number") {
    return Number.isInteger(raw) && raw > 0 ? { pid: raw, start: null, at: "" } : null;
  }
  if (!raw || !Number.isInteger(raw.pid) || raw.pid <= 0) return null;
  return raw;
}

/**
 * The live owner, or null. A dead pid, a malformed record, and a contradicted
 * identity all read as "no driver". A claim whose identity cannot be read — a
 * pre-upgrade bare pid — still counts as a driver while its pid is live, because
 * the harm on this path is starting a second driver; only stopDriver demands the
 * identity be positively verified.
 */
function liveOwner(dir: string): OwnerRecord | null {
  const owner = readOwner(dir);
  if (!owner) return null;
  try {
    process.kill(owner.pid, 0);
  } catch {
    return null;
  }
  if (owner.start !== null) {
    const start = processStartTime(owner.pid);
    if (start === null || start !== owner.start) return null;
  }
  return owner;
}

/**
 * Claims the run for this process. Atomic: of two concurrent claims exactly one
 * wins, and the loser gets false rather than a second driver. A stale claim — its
 * process dead, or its identity contradicted — is cleared and claimed over.
 */
export function acquireDriver(dir: string): boolean {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, RUNNER_PID);
  const claim: OwnerRecord = { pid: process.pid, start: processStartTime(process.pid), at: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, `${JSON.stringify(claim)}\n`, { flag: "wx" });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (!takeOverStale(dir, path)) return false;
    }
  }
  return false;
}

/**
 * Clears a stale claim so the caller may retry its own. False means this attempt
 * loses cleanly: the run is owned, or another contender holds the takeover lock.
 * Removal happens only under that lock, with liveness re-checked inside it, so a
 * fresh claim written by a contender that won in the meantime is never the one
 * removed — the race that would otherwise yield two drivers. The lock itself is
 * judged like the run lock: a dead contender's lock is broken at once, a live
 * one's is respected, and the holder re-checks it is still its own before
 * touching the claim, in case it was broken past while suspended.
 */
function takeOverStale(dir: string, path: string): boolean {
  if (liveOwner(dir)) return false;
  const lock = `${path}.takeover`;
  if (!tryClaimLock(lock)) {
    // Held: break it only when its holder is stale, then try exactly once more.
    if (!breakStaleLock(lock)) return false;
    if (!tryClaimLock(lock)) return false;
  }
  try {
    if (liveOwner(dir)) return false;
    if (midWriteClaim(dir, path)) return false;
    if (!holdsLock(lock)) return false;
    rmSync(path, { force: true });
    return true;
  } finally {
    releaseOwnLock(lock);
  }
}

/**
 * A claim that cannot be read yet may be a winner caught between its wx create
 * and its write — the two are not one filesystem operation — so an unreadable
 * young claim gets the same mtime grace an unreadable lock gets, rather than
 * being removed while its owner's write is still in flight.
 */
function midWriteClaim(dir: string, path: string): boolean {
  if (readOwner(dir) !== null) return false;
  try {
    return Date.now() - statSync(path).mtimeMs <= 10_000;
  } catch {
    // Already gone: nothing to grace.
    return false;
  }
}

/** Removes only this process's own claim; someone else's is never touched. */
export function releaseDriver(dir: string): void {
  const owner = readOwner(dir);
  if (owner && owner.pid === process.pid) rmSync(join(dir, RUNNER_PID), { force: true });
}

/** The driver's pid, if a verified live one owns this run. */
export function driverPid(dir: string): number | null {
  return liveOwner(dir)?.pid ?? null;
}

export function driverAlive(dir: string): boolean {
  return driverPid(dir) !== null;
}

/**
 * Stops a run. Closing a pane used to be how you did this; a detached driver has
 * no pane to close, so the board asks it to stop. The signal goes only to a
 * positively verified owner: an unrelated process behind a stale record — or a
 * pre-upgrade claim whose identity cannot be read — is never signalled. The
 * claim is left in place: while the driver is still dying it truthfully says the
 * run is owned, and once the process is gone it is a stale claim acquireDriver
 * recovers — deleting it here would hand the run to a resume while the old
 * driver still runs.
 */
export function stopDriver(dir: string): boolean {
  const owner = liveOwner(dir);
  if (!owner || owner.start === null) return false;
  try {
    process.kill(owner.pid, "SIGTERM");
  } catch {
    return false;
  }
  return true;
}

/**
 * A Choice step's menu, asked through the run dir instead of a terminal: the
 * question goes into `choice.json`, and the driver waits for `choice-answer.json`.
 * The Control Plane is what renders it, so a pending choice survives that pane
 * being closed and reopened — the file is still there to render.
 */
export function filePrompts(opts: {
  dir: string;
  run: string;
  step: () => string;
  /** How long the human has before the step is left unfinished. */
  timeoutMs: number;
  pollMs?: number;
}): EnginePrompts {
  let seq = 0;
  const wait = async (choice: PendingChoice): Promise<ChoiceAnswer | null> => {
    clearChoice(opts.dir);
    writeChoice(opts.dir, choice);
    const deadline = Date.now() + opts.timeoutMs;
    try {
      while (Date.now() < deadline) {
        const answer = read<ChoiceAnswer>(join(opts.dir, CHOICE_ANSWER));
        // An answer to an earlier question is not an answer to this one.
        if (answer && answer.id === choice.id) return answer;
        await sleep(opts.pollMs ?? 500);
      }
      return null;
    } finally {
      clearChoice(opts.dir);
    }
  };

  return {
    async menu(items, menuOpts) {
      const answer = await wait({
        id: `${opts.run}-${++seq}`,
        kind: "menu",
        run: opts.run,
        step: opts.step(),
        header: menuOpts.header,
        footer: menuOpts.footer ?? "",
        items,
      });
      if (!answer?.choice) return null;
      return items.find((i) => i.id === answer.choice) ?? null;
    },
    async ask(question) {
      const answer = await wait({
        id: `${opts.run}-${++seq}`,
        kind: "ask",
        run: opts.run,
        step: opts.step(),
        header: question,
        footer: "",
        items: [],
      });
      return answer?.text ?? null;
    },
  };
}
