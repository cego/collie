// Raw keypresses, for the one screen that still draws itself: the text board a pane
// falls back to when the renderer will not start. Everything else goes through OpenTUI,
// which owns raw mode for as long as its renderer is alive.

import { Effect } from "effect";

/** One chunk of stdin can carry several keypresses; split them apart. */
export function tokenizeKeys(chunk: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < chunk.length) {
    if (chunk[i] === "\x1b") {
      let end = i + 1;
      if (chunk[end] === "[") {
        end += 1;
        while (end < chunk.length) {
          const code = chunk.charCodeAt(end);
          end += 1;
          if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 126) break;
        }
      } else if (chunk[end] === "O" && end + 1 < chunk.length) {
        end += 2;
      }
      out.push(chunk.slice(i, end));
      i = end;
      continue;
    }
    out.push(chunk[i]!);
    i += 1;
  }
  return out;
}

// Raw terminal input, which Stdio does not model: it offers stdin as a byte stream and
// can say whether it is a terminal, but not raw mode, and a picker needs keypresses
// unbuffered and unechoed. The stream would also compete with this reader for the same
// fd. Output goes through Bun.write for the same reason — it is interleaved with the
// escape sequences this file writes to move the cursor.
//
// One reader for the whole process: iterating process.stdin more than once
// destroys the stream, and the picker asks for several things in a row.
interface KeyboardInput {
  readonly isTTY?: boolean;
  setRawMode?(enabled: boolean): void;
  resume(): void;
  pause(): void;
  on(event: "data", listener: (buffer: Buffer) => void): void;
  off(event: "data", listener: (buffer: Buffer) => void): void;
}

export class Keyboard {
  private queue: string[] = [];
  private started = false;

  constructor(private readonly input: KeyboardInput = process.stdin) {}

  private readonly onData = (buffer: Buffer): void => {
    for (const key of tokenizeKeys(buffer.toString("utf8"))) this.queue.push(key);
  };

  /** Raw mode and one data handler; everything else reads from the queue. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.input.setRawMode?.(true);
    this.input.resume();
    this.input.on("data", this.onData);
  }

  /** The next queued key, or null: for a loop that must also redraw on a timer. */
  take(): string | null {
    this.start();
    return this.queue.shift() ?? null;
  }

  release(): void {
    if (!this.started) return;
    this.started = false;
    this.input.off("data", this.onData);
    this.input.setRawMode?.(false);
    this.input.pause();
    this.queue = [];
  }

  run<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> {
    return effect.pipe(Effect.ensuring(Effect.sync(() => this.release())));
  }
}

const keyboard = new Keyboard();

export const startKeyboard = () => keyboard.start();
export const takeKey = () => keyboard.take();
export const releaseKeyboard = () => keyboard.release();
