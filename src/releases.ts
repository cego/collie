// Collie's published releases: the newest, and a release's runner verified against the release key.

import * as Str from "effect/String";
import { Data, Duration, Effect, FileSystem, Option } from "effect";
import * as Digest from "effect/crypto/Digest";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import { RELEASE_TAG } from "./release";
import { RELEASE_PUBLIC_KEY, SIGNATURE_SUFFIX, verifyRelease } from "./signing";

/** Where releases are published; `COLLIE_RELEASES` names another, as a test's fake does. */
export const RELEASES = "https://github.com/cego/collie/releases";

export const releasesOf = (raw: Readonly<Record<string, string>>) =>
  raw.COLLIE_RELEASES ?? RELEASES;

/** The release asset's platform for this process, as `install.sh` names it. */
export const ownPlatform = () =>
  `${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;

/**
 * The newest release's version, from where `<source>/latest` redirects, or null where that
 * cannot be read. Never waits longer than a few seconds.
 */
export const newestRelease = (source: string) =>
  HttpClient.get(`${source}/latest`).pipe(
    Effect.map((response) => {
      const tag = Str.split(response.headers.location ?? "", "/").at(-1) ?? "";
      return RELEASE_TAG.test(tag) ? tag : null;
    }),
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.timeoutOption(Duration.seconds(10)),
    Effect.map(Option.getOrNull),
    Effect.orElseSucceed(() => null),
  );

const READ_EVERY_MS = 5 * 60_000;
const newest = new Map<string, { readAt: number; version: string | null }>();

/**
 * A release newer than `version`, or null. Reads what was last learned and starts a read
 * behind it at most every few minutes, so a caller that redraws never waits on the network.
 */
export const newerRelease = Effect.fn("Releases.newerRelease")(function* (
  source: string,
  version: string,
  now: number,
) {
  const seen = newest.get(source) ?? { readAt: 0, version: null };
  if (now - seen.readAt >= READ_EVERY_MS) {
    newest.set(source, { ...seen, readAt: now });
    yield* Effect.forkDetach(
      newestRelease(source).pipe(
        Effect.tap((read) => Effect.sync(() => newest.set(source, { readAt: now, version: read }))),
      ),
    );
  }
  return isNewer(seen.version, version) ? seen.version : null;
});

export const isNewer = (candidate: string | null, version: string): candidate is string =>
  candidate !== null && Bun.semver.order(candidate, version) > 0;

/** A runner that was not used, and whether the release simply has none. */
export class RunnerRefused extends Data.TaggedError("RunnerRefused")<{
  readonly reason: string;
  readonly missing: boolean;
}> {}

const fetched = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap((response) =>
      response.status === 200
        ? Effect.map(response.arrayBuffer, (body) => new Uint8Array(body))
        : Effect.succeed(null),
    ),
    Effect.mapError(
      (error) =>
        new RunnerRefused({
          reason: `could not download ${url}: ${error.message}`,
          missing: false,
        }),
    ),
    Effect.provide(FetchHttpClient.layer),
  );

/**
 * The runner of `version` for `platform`, downloaded into `dir` once and verified against
 * the release key every time it is used, so a kept copy changed since is refused too.
 */
export const verifiedRunner = Effect.fn("Releases.verifiedRunner")(function* (
  releases: string,
  version: string,
  platform: string,
  dir: string,
  key: string = RELEASE_PUBLIC_KEY,
) {
  const fs = yield* FileSystem.FileSystem;
  const asset = `collie-${platform}`;
  const file = `${dir}/${version}/${asset}`;
  const kept = yield* Effect.all([
    fs.readFile(file),
    fs.readFileString(`${file}${SIGNATURE_SUFFIX}`),
  ]).pipe(Effect.option);
  let bytes: Uint8Array;
  let signature: string | null;
  if (Option.isSome(kept)) [bytes, signature] = kept.value;
  else {
    const url = `${releases}/${version}/${asset}`;
    const got = yield* fetched(url);
    if (got === null) {
      return yield* new RunnerRefused({
        reason: `Collie ${version} has no ${asset}`,
        missing: true,
      });
    }
    const signed = yield* fetched(`${url}${SIGNATURE_SUFFIX}`);
    bytes = got;
    signature = signed === null ? null : new TextDecoder().decode(signed);
  }
  const verified = verifyRelease(bytes, signature, key);
  if (!verified.ok) {
    if (Option.isSome(kept)) yield* fs.remove(file, { force: true }).pipe(Effect.ignore);
    return yield* new RunnerRefused({
      reason: `${asset} ${version}: ${verified.reason}`,
      missing: false,
    });
  }
  if (Option.isNone(kept)) {
    yield* Effect.all([
      fs.makeDirectory(`${dir}/${version}`, { recursive: true }),
      fs.writeFile(file, bytes),
      fs.writeFileString(`${file}${SIGNATURE_SUFFIX}`, signature ?? ""),
    ]).pipe(
      Effect.mapError(
        (error) =>
          new RunnerRefused({
            reason: `could not keep ${asset}: ${error.message}`,
            missing: false,
          }),
      ),
    );
  }
  const sha256 = yield* (yield* Digest.Digest).digestHex(Digest.sha256, bytes);
  return { asset, file, bytes, sha256 };
});
