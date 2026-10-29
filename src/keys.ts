// Raw keypresses, for the one screen that still draws itself: the text board a pane
// falls back to when the renderer will not start. Everything else goes through OpenTUI,
// which owns raw mode for as long as its renderer is alive.

import { Effect, Queue } from "effect";

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
interface KeyboardInput {
  readonly isTTY?: boolean;
  setRawMode?(enabled: boolean): void;
  resume(): void;
  pause(): void;
  on(event: "data", listener: (buffer: Buffer) => void): void;
  off(event: "data", listener: (buffer: Buffer) => void): void;
}

/**
 * The keys pressed while the scope is open, with raw mode on until it closes, however it
 * closes. `process.stdin` is read only when a key is first wanted: reading it sets the
 * stream up, and most commands never take a key.
 */
export const keyboard = (input: KeyboardInput = process.stdin) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const keys = yield* Queue.unbounded<string>();
      const onData = (buffer: Buffer): void => {
        for (const key of tokenizeKeys(buffer.toString("utf8"))) Queue.offerUnsafe(keys, key);
      };
      input.setRawMode?.(true);
      input.resume();
      input.on("data", onData);
      return { keys, onData };
    }),
    ({ onData }) =>
      Effect.sync(() => {
        input.off("data", onData);
        input.setRawMode?.(false);
        input.pause();
      }),
  ).pipe(Effect.map(({ keys }): Queue.Dequeue<string> => keys));
