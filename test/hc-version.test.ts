// hc-pin.json's version is the oldest hc Collie works with: what `herdr-core --version` says
// meets it at or above it by semver precedence.

import { expect, test } from "bun:test";
import { hcMeets } from "../src/hc-install";

test.each([
  ["hc 0.1.14", true],
  ["hc 0.1.15", true],
  ["hc 0.2.0", true],
  ["hc 1.0.0", true],
  ["hc 0.1.13", false],
  ["hc 0.0.99", false],
])("%s against a minimum of 0.1.14: %p", (said, meets) => {
  expect(hcMeets(said, "0.1.14")).toBe(meets);
});

test("versions order by number, not as text", () => {
  expect(hcMeets("hc 0.1.10", "0.1.9")).toBe(true);
  expect(hcMeets("hc 0.1.9", "0.1.10")).toBe(false);
  expect(hcMeets("hc 0.10.0", "0.9.9")).toBe(true);
});

test("a prerelease is older than its release, and newer than the release before it", () => {
  expect(hcMeets("hc 0.1.14-rc.1", "0.1.14")).toBe(false);
  expect(hcMeets("hc 0.1.15-rc.1", "0.1.14")).toBe(true);
});

test("build metadata is ignored", () => {
  expect(hcMeets("hc 0.1.14+abc123", "0.1.14")).toBe(true);
});

test.each([
  "",
  "hc",
  "hc unknown",
  "hc 1.2",
  "hc v",
  "hc 0.1.x",
  "hc 0.1.15-rc..1",
  "hc 0.1.15-01",
  "hc 01.2.3",
  "hc 0.1.15.4",
  "hc 9999999999999999999999999.0.0",
])("output naming no version (%p) does not meet the minimum", (said) => {
  expect(hcMeets(said, "0.1.14")).toBe(false);
});
