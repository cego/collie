import { afterEach, expect, test } from "bun:test";
import { DateTime } from "effect";
import { whenOf } from "../desktop/src/shared/flow";
import { epochMs } from "../src/time";

const now = epochMs("2026-11-04T10:00:00Z");

test("an instant reads as its time today, its day this year, or its date before", () => {
  expect(whenOf("2026-11-04T08:05:00Z", now, "UTC")).toBe("08:05");
  expect(whenOf("2026-10-24T11:22:00Z", now, "UTC")).toBe("24 Oct, 11:22");
  expect(whenOf("2025-10-24T11:22:00Z", now, "UTC")).toBe("24 Oct 2025, 11:22");
  expect(whenOf("2026-11-04T23:30:00Z", now, "Europe/Copenhagen")).toBe("5 Nov, 00:30");
  expect(whenOf("not a time", now, "UTC")).toBe("not a time");
});

const Native = Intl.DateTimeFormat;
afterEach(() => {
  Intl.DateTimeFormat = Native;
});

test("a record's many instants share one formatter per time zone", () => {
  let built = 0;
  class Counted extends Native {
    constructor(...args: ConstructorParameters<typeof Native>) {
      super(...args);
      built++;
    }
  }
  // SAFETY: whenOf only constructs it.
  Intl.DateTimeFormat = Counted as typeof Native;
  for (let minute = 0; minute < 200; minute++)
    whenOf(
      DateTime.formatIso(DateTime.makeUnsafe(now - minute * 60_000)),
      now,
      "Europe/Copenhagen",
    );
  whenOf("2026-11-04T08:05:00Z", now, "UTC");
  expect(built).toBeLessThanOrEqual(2);
});
