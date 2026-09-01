import { expect, test } from "bun:test";
import { Effect } from "effect";
import { Keyboard } from "../src/picker";
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
      const keyboard = new Keyboard(input);

      const key = yield* keyboard.run(
        Effect.sync(() => {
          keyboard.start();
          input.send("\x1b");
          return keyboard.take();
        }),
      );

      expect(key).toBe("\x1b");
      expect(input.rawModes).toEqual([true, false]);
      expect(input.resumed).toBe(1);
      expect(input.paused).toBe(1);
      expect(input.listener).toBeNull();
    }),
  ));
