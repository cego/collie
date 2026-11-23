import * as Str from "effect/String";
import * as Option from "effect/Option";
import { pipe as pipe_ } from "effect/Function";
import { Effect, Queue } from "effect";

export function tokenizeKeys(chunk: string) {
  const out: Array<string> = [];
  let i = 0;
  while (i < chunk.length) {
    if (chunk[i] === "\u001b") {
      let end = i + 1;
      if (chunk[end] === "[") {
        end += 1;
        while (end < chunk.length) {
          const code = Option.getOrElse(Str.charCodeAt(chunk, end), () => Number.NaN);
          end += 1;
          if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 126) break;
        }
      } else if (chunk[end] === "O" && end + 1 < chunk.length) {
        end += 2;
      }
      out.push(pipe_(chunk, Str.slice(i, end)));
      i = end;
      continue;
    }
    out.push(chunk[i]!);
    i += 1;
  }
  return out;
}

// WARNING: Stdio cannot set raw mode and would race this reader on stdin; output goes through Bun.write for ordering.
interface KeyboardInput {
  readonly isTTY?: boolean;
  setRawMode?(enabled: boolean): void;
  resume(): void;
  pause(): void;
  on(event: "data", listener: (buffer: Buffer) => void): void;
  off(event: "data", listener: (buffer: Buffer) => void): void;
}

// WARNING: process.stdin is read only when a key is first wanted: reading it sets the stream up.
export const keyboard = (input: KeyboardInput = process.stdin) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const keys = yield* Queue.unbounded<string>();
      const onData = (buffer: Buffer) => {
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
  ).pipe(Effect.map(({ keys }) => keys));
