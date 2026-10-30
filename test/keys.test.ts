// The raw keypress reader, which is now only the text board's: a pane whose renderer
// would not start still draws itself and still reads keys. OpenTUI owns raw mode
// everywhere else. Both behaviours here were `src/picker.ts`'s and outlived it.

import { expect, test } from "bun:test";
import { Effect, Queue } from "effect";
import { keyboard, tokenizeKeys } from "../src/keys";
import { runEffect } from "./support/effect";

class FakeInput {
  readonly rawModes: boolean[] = [];
  resumed = 0;
  paused = 0;
  listener: ((buffer: Buffer) => void) | null = null;

  setRawMode(enabled: boolean): void {
    this.rawModes.push(enabled);
  }

  resume(): void {
    this.resumed += 1;
  }

  pause(): void {
    this.paused += 1;
  }

  on(_event: "data", listener: (buffer: Buffer) => void): void {
    this.listener = listener;
  }

  off(_event: "data", listener: (buffer: Buffer) => void): void {
    if (this.listener === listener) this.listener = null;
  }

  send(key: string): void {
    this.listener?.(Buffer.from(key));
  }
}

test("a completed keyboard session releases its terminal reader", () =>
  runEffect(
    Effect.gen(function* () {
      const input = new FakeInput();

      const key = yield* Effect.scoped(
        Effect.gen(function* () {
          const keys = yield* keyboard(input);
          input.send("\x1b");
          return yield* Queue.take(keys);
        }),
      );

      expect(key).toBe("\x1b");
      expect(input.rawModes).toEqual([true, false]);
      expect(input.resumed).toBe(1);
      expect(input.paused).toBe(1);
      expect(input.listener).toBeNull();
    }),
  ));

test("a stdin chunk carrying several keypresses is split into keys", () => {
  expect(tokenizeKeys("\x7f\x7f\x7f")).toEqual(["\x7f", "\x7f", "\x7f"]);
  expect(tokenizeKeys("re\x1b[Bv\r")).toEqual(["r", "e", "\x1b[B", "v", "\r"]);
  expect(tokenizeKeys("\x1b")).toEqual(["\x1b"]);
});
