import { test } from "bun:test";
import { Effect } from "effect";

test("a test longer than Bun's own five seconds is not a timeout under bun test", () =>
  Effect.runPromise(Effect.sleep("5500 millis")));
