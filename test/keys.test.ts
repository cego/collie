import { expect, test } from "bun:test";
import { Effect, Queue } from "effect";
import { keyboard, tokenizeKeys } from "../src/keys";
import { runEffect } from "./support/effect";

class FakeInput {
  readonly rawModes: Array<boolean> = [];
  resumed = 0;
  paused = 0;
  listener: ((buffer: Buffer) => void) | null = null;

  setRawMode(enabled: boolean) {
    this.rawModes.push(enabled);
  }

  resume() {
    this.resumed += 1;
  }

  pause() {
    this.paused += 1;
  }

  on(_event: "data", listener: (buffer: Buffer) => void) {
    this.listener = listener;
  }

  off(_event: "data", listener: (buffer: Buffer) => void) {
    if (this.listener === listener) {
      this.listener = null;
    }
  }

  send(key: string) {
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
          input.send("\u001b");
          return yield* Queue.take(keys);
        }),
      );

      expect(key).toBe("\u001b");
      expect(input.rawModes).toEqual([true, false]);
      expect(input.resumed).toBe(1);
      expect(input.paused).toBe(1);
      expect(input.listener).toBeNull();
    }),
  ));

test("a stdin chunk carrying several keypresses is split into keys", () => {
  expect(tokenizeKeys("\u007f\u007f\u007f")).toEqual(["\u007f", "\u007f", "\u007f"]);
  expect(tokenizeKeys("re\u001b[Bv\r")).toEqual(["r", "e", "\u001b[B", "v", "\r"]);
  expect(tokenizeKeys("\u001b")).toEqual(["\u001b"]);
});
