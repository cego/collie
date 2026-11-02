// The hc a release carries: the archive `hc-pin.json` names for the runner's target, from a
// served fake release rather than the network, bundled only once it hashes to the pin.

import * as Arr from "effect/Array";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { runEffect } from "./support/effect";
import { bundleHc, hcTarget } from "../tools/hc-release";
import { BUNDLED_HC } from "../src/hc-install";
import { sha256Hex } from "../src/attachments";
import pin from "../hc-pin.json";

const ARCHIVE = new TextEncoder().encode("the hc archive for linux-x86_64");
const OTHER = new TextEncoder().encode("something else entirely");

let served: ReturnType<typeof Bun.serve>;
let fetched: string[];

beforeEach(() => {
  fetched = [];
  served = Bun.serve({
    port: 0,
    fetch: (request) => {
      const path = new URL(request.url).pathname;
      fetched.push(path);
      return path === "/core/0.1.14/herdr-core-linux-x86_64.tar.gz"
        ? new Response(ARCHIVE)
        : new Response("no", { status: 404 });
    },
  });
});
afterEach(() => served.stop(true));

const releases = () => `http://127.0.0.1:${served.port}`;

/** `bundleHc` into a fresh release tree and cache, with what it left or why it refused. */
const bundle = (sha256: Record<string, string>, target = "bun-linux-x64", cache?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-hc-release-" });
    const tree = `${dir}/release`;
    const result = yield* Effect.result(
      bundleHc({ version: "0.1.14", sha256 }, target, tree, {
        releases: releases(),
        cache: cache ?? `${dir}/cache`,
      }),
    );
    const bundled = yield* fs.readFile(`${tree}/${BUNDLED_HC}`).pipe(Effect.option);
    return { result, bundled };
  });

test("the release tree carries the pinned hc archive, hashing to the pin", () =>
  runEffect(
    Effect.gen(function* () {
      const { result, bundled } = yield* bundle({ "linux-x86_64": sha256Hex(ARCHIVE) });

      expect(result._tag).toBe("Success");
      expect(bundled._tag).toBe("Some");
      if (bundled._tag === "Some") expect(sha256Hex(bundled.value)).toBe(sha256Hex(ARCHIVE));
    }),
  ));

test("an archive that does not hash to the pin is refused, and nothing is bundled", () =>
  runEffect(
    Effect.gen(function* () {
      const { result, bundled } = yield* bundle({ "linux-x86_64": sha256Hex(OTHER) });

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") expect(result.failure.message).toContain(sha256Hex(OTHER));
      expect(bundled._tag).toBe("None");
    }),
  ));

test("a target the pin has no hc for fails the build", () =>
  runEffect(
    Effect.gen(function* () {
      const { result, bundled } = yield* bundle(
        { "linux-x86_64": sha256Hex(ARCHIVE) },
        "bun-darwin-arm64",
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.message).toBe("hc-pin.json pins no hc for macos-aarch64");
      expect(bundled._tag).toBe("None");
      expect(fetched).toEqual([]);
    }),
  ));

test("a kept archive is bundled without a download, and one changed since is fetched again", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cache = yield* fs.makeTempDirectoryScoped({ prefix: "collie-hc-cache-" });
      const pinned = { "linux-x86_64": sha256Hex(ARCHIVE) };
      yield* bundle(pinned, "bun-linux-x64", cache);
      expect(fetched.length).toBe(1);

      yield* bundle(pinned, "bun-linux-x64", cache);
      expect(fetched.length).toBe(1);

      yield* fs.writeFile(`${cache}/0.1.14/herdr-core-linux-x86_64.tar.gz`, OTHER);
      const { bundled } = yield* bundle(pinned, "bun-linux-x64", cache);
      expect(fetched.length).toBe(2);
      if (bundled._tag === "Some") expect(sha256Hex(bundled.value)).toBe(sha256Hex(ARCHIVE));
    }),
  ));

test("each of the four runners Collie ships has an hc in the committed pin", () => {
  const targets = ["bun-linux-x64", "bun-linux-arm64", "bun-darwin-x64", "bun-darwin-arm64"];
  expect(Arr.map(targets, hcTarget)).toEqual([
    "linux-x86_64",
    "linux-aarch64",
    "macos-x86_64",
    "macos-aarch64",
  ]);
  for (const target of targets) expect(pin.sha256).toHaveProperty(hcTarget(target));
  expect(hcTarget("bun-linux-x64-modern-musl")).toBe("linux-x86_64");
});
