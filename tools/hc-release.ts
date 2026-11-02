// The hc a release carries: the archive `hc-pin.json` names for the runner's target, checked
// against the pin's SHA-256 before it is bundled. A target the pin has no hc for fails.

import * as Str from "effect/String";
import { Data, Effect, FileSystem, Option, Path } from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import { sha256Hex } from "../src/attachments";
import { BUNDLED_HC } from "../src/hc-install";

export interface HcPin {
  readonly version: string;
  readonly sha256: Readonly<Record<string, string>>;
}

export class HcRefused extends Data.TaggedError("HcRefused")<{ readonly message: string }> {}

/** hc's name for a Bun compile target: `bun-darwin-arm64` is `macos-aarch64`. */
export const hcTarget = (target: string) => {
  const [, platform = "", arch = ""] = Str.split(target, "-");
  return `${platform === "darwin" ? "macos" : platform}-${arch === "x64" ? "x86_64" : "aarch64"}`;
};

/**
 * Writes the pinned hc archive for `target` into `tree`, from `cache` where a copy there still
 * hashes to the pin, else from `releases`. Returns the bytes it bundled.
 */
export const bundleHc = Effect.fn("HcRelease.bundle")(function* (
  pin: HcPin,
  target: string,
  tree: string,
  from: { readonly releases: string; readonly cache: string },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const on = hcTarget(target);
  const want = pin.sha256[on];
  if (want === undefined)
    return yield* new HcRefused({ message: `hc-pin.json pins no hc for ${on}` });
  const name = `herdr-core-${on}.tar.gz`;
  const kept = path.join(from.cache, pin.version, name);
  const cached = yield* fs.readFile(kept).pipe(Effect.option);
  let bytes: Uint8Array;
  if (Option.isSome(cached) && sha256Hex(cached.value) === want) bytes = cached.value;
  else {
    const url = `${from.releases}/core/${pin.version}/${name}`;
    const response = yield* HttpClient.get(url).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.mapError((cause) => new HcRefused({ message: `${url}: ${cause.message}` })),
    );
    if (response.status !== 200)
      return yield* new HcRefused({ message: `${url} answered ${response.status}` });
    bytes = new Uint8Array(
      yield* response.arrayBuffer.pipe(
        Effect.mapError((cause) => new HcRefused({ message: `${url}: ${cause.message}` })),
      ),
    );
    const got = sha256Hex(bytes);
    if (got !== want)
      return yield* new HcRefused({
        message: `${url} hashed ${got}, but hc-pin.json says ${want} for ${on}`,
      });
    yield* fs.makeDirectory(path.dirname(kept), { recursive: true });
    yield* fs.writeFile(kept, bytes);
  }
  yield* fs.makeDirectory(path.dirname(path.join(tree, BUNDLED_HC)), { recursive: true });
  yield* fs.writeFile(path.join(tree, BUNDLED_HC), bytes);
  return bytes;
});
