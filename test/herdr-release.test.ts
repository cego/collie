// The three manifest shapes herdr publishes, from recordings rather than the network.
// The stable manifest keeps parallel `assets`/`sha256` maps and the preview manifest
// nests both per asset — a difference that is easy to get wrong and, got wrong, means a
// download verified against the wrong checksum or none at all.

import { expect, test } from "bun:test";
import { pinDisagreement, releaseFrom } from "../tools/herdr-release";

const SHA = "976150a14d490c94b243ea2e1a7eb2dfb67f12e36b182db90936f6728e6aecf4";
const OTHER = "61c1c9181c0cf62a00882f21f2c6e19ce8ee6360410736a4c6c5a1387a0fc388";

test("a pinned version composes its own release url and takes the pin's checksum", () => {
  expect(
    releaseFrom(
      { pinned: { version: "0.8.2", protocol: 20, sha256: { "linux-x86_64": SHA } } },
      "linux-x86_64",
    ),
  ).toEqual({
    label: "0.8.2",
    protocol: 20,
    url: "https://github.com/herdrdev/herdr/releases/download/v0.8.2/herdr-linux-x86_64",
    sha256: SHA,
  });
});

test("the stable manifest's url and checksum come from two parallel maps", () => {
  expect(
    releaseFrom(
      {
        stable: {
          version: "0.8.2",
          protocol: 20,
          assets: { "linux-x86_64": "https://example.invalid/herdr", "macos-arm64": "no" },
          sha256: { "linux-x86_64": SHA, "macos-arm64": OTHER },
        },
      },
      "linux-x86_64",
    ),
  ).toEqual({
    label: "0.8.2",
    protocol: 20,
    url: "https://example.invalid/herdr",
    sha256: SHA,
  });
});

test("the preview manifest's url and checksum are nested per asset", () => {
  expect(
    releaseFrom(
      {
        preview: {
          build_id: "2026-08-31-b1ff4582e968",
          protocol: 21,
          assets: { "linux-x86_64": { url: "https://example.invalid/preview", sha256: OTHER } },
        },
      },
      "linux-x86_64",
    ),
  ).toEqual({
    label: "preview 2026-08-31-b1ff4582e968",
    protocol: 21,
    url: "https://example.invalid/preview",
    sha256: OTHER,
  });
});

// Never fall back to downloading something unverified: a target the manifest does not
// carry has to stop the run.
test("a target with no recorded checksum fails rather than going unverified", () => {
  expect(() =>
    releaseFrom(
      { pinned: { version: "0.8.2", protocol: 20, sha256: { "linux-x86_64": SHA } } },
      "macos-aarch64",
    ),
  ).toThrow("herdr-pin.json records no macos-aarch64 asset");
  expect(() =>
    releaseFrom(
      { stable: { version: "0.8.2", protocol: 20, assets: {}, sha256: {} } },
      "linux-x86_64",
    ),
  ).toThrow("the stable manifest records no linux-x86_64 asset");
  expect(() =>
    releaseFrom({ preview: { build_id: "x", protocol: 21, assets: {} } }, "linux-x86_64"),
  ).toThrow("the preview manifest records no linux-x86_64 asset");
});

// The pin's committed checksum is what the download is verified against — a checksum
// fetched from the host that serves the binary cannot attest to it. Consulting the
// published one as a cross-check catches the likelier mistake: a wrong hash committed
// when bumping the pin.
test("the published checksum for the pinned version must agree with the pin", () => {
  const pin = { version: "0.8.2", protocol: 20, sha256: { "linux-x86_64": SHA } };
  const stable = (version: string, sha256: Record<string, string>) => ({
    version,
    protocol: 20,
    assets: {},
    sha256,
  });

  expect(pinDisagreement(pin, stable("0.8.2", { "linux-x86_64": SHA }), "linux-x86_64")).toBe(
    undefined,
  );
  expect(pinDisagreement(pin, stable("0.8.2", { "linux-x86_64": OTHER }), "linux-x86_64")).toBe(
    `herdr-pin.json has ${SHA} for linux-x86_64 at 0.8.2, but the stable manifest publishes ${OTHER}`,
  );
  expect(pinDisagreement(pin, stable("0.8.2", {}), "linux-x86_64")).toBe(
    "the stable manifest names 0.8.2 but records no linux-x86_64 checksum",
  );
  // Once herdr has released past the pin, the manifest no longer describes it.
  expect(pinDisagreement(pin, stable("0.9.0", { "linux-x86_64": OTHER }), "linux-x86_64")).toBe(
    undefined,
  );
});
