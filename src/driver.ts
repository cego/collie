// The run dir is the channel between a detached run driver and the Control Plane.
// The driver has no terminal of its own: it writes what it is doing, and asks its
// questions, through files. Everything here is a plain file so both sides survive
// the other being closed, killed or resumed.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

export function writePid(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, RUNNER_PID), `${process.pid}\n`);
}

export function clearPid(dir: string): void {
  rmSync(join(dir, RUNNER_PID), { force: true });
}

/** The driver's pid, if a live one is recorded for this run. */
export function driverPid(dir: string): number | null {
  const path = join(dir, RUNNER_PID);
  if (!existsSync(path)) return null;
  const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    // A pid file left behind by a killed driver is not a driver.
    return null;
  }
}

export function driverAlive(dir: string): boolean {
  return driverPid(dir) !== null;
}

/**
 * Stops a run. Closing a pane used to be how you did this; a detached driver has
 * no pane to close, so the board asks it to stop and the pid file goes with it.
 */
export function stopDriver(dir: string): boolean {
  const pid = driverPid(dir);
  if (pid === null) return false;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }
  clearPid(dir);
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
