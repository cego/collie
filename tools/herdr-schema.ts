// Prints a herdr release's bundled socket-API schema, which `test/herdr-contract.test.ts`
// checks Collie's boundary structs against. One script for all three channels so the
// scheduled drift check and the pinned check cannot download or verify differently:
//
//   bun run tools/herdr-schema.ts pinned  --check          # snapshot still matches the pin
//   bun run tools/herdr-schema.ts pinned  --write          # regenerate the snapshot
//   bun run tools/herdr-schema.ts stable  --out /tmp/s.json
//   bun run tools/herdr-schema.ts preview --out /tmp/s.json
//
// This is the one place outside src/herdr.ts that runs a herdr binary, and the invariant
// that says otherwise names it (AGENTS.md, docs/internals.md). It is not talking to the
// session: no HERDR_BIN_PATH, no socket, no state, and a downloaded artifact in a temp
// directory rather than the herdr the user is running — which is the whole point, since
// the question is what some other version's schema says.

import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import {
  Array as Arr,
  Cause,
  Console,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Runtime,
  Schema,
  Stdio,
  Stream,
} from "effect";
import * as Digest from "effect/crypto/Digest";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { Pin, Release } from "./herdr-release";
import { MANIFEST_URLS, pinDisagreement, releaseFrom } from "./herdr-release";

const ROOT = new URL("..", import.meta.url).pathname;
const PIN = `${ROOT}herdr-pin.json`;
const SNAPSHOT = `${ROOT}herdr-api-schema.json`;
const REGENERATE = "bun run contract:regen";

const ChecksumMap = Schema.Record(Schema.String, Schema.String);
const PinSchema = Schema.Struct({
  version: Schema.String,
  protocol: Schema.Finite,
  sha256: ChecksumMap,
});
const StableSchema = Schema.Struct({ ...PinSchema.fields, assets: ChecksumMap });
const PreviewSchema = Schema.Struct({
  build_id: Schema.String,
  protocol: Schema.Finite,
  assets: Schema.Record(
    Schema.String,
    Schema.Struct({ url: Schema.String, sha256: Schema.String }),
  ),
});
const JsonText = Schema.fromJsonString(Schema.Json, { space: 2 });

/** herdr names its assets by kernel and machine, not by Bun's target strings. */
function assetTarget(): string {
  const os = process.platform === "darwin" ? "macos" : "linux";
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  return `${os}-${arch}`;
}

const get = Effect.fn("HerdrSchema.get")(function* (url: string) {
  const response = yield* HttpClient.get(url);
  if (response.status < 200 || response.status >= 300)
    return yield* new Cause.UnknownError(response.status, `${url} answered ${response.status}`);
  return response;
});

const manifest = Effect.fn("HerdrSchema.manifest")(function* <S extends Schema.Constraint>(
  url: string,
  schema: S,
) {
  return yield* HttpClientResponse.schemaBodyJson(schema)(yield* get(url));
});

/**
 * Cross-checks the pin against the published stable manifest, where the pinned version
 * is still the current stable and herdr.dev is reachable. A disagreement is fatal; an
 * unreachable manifest is not, because the pin's committed checksum is what actually
 * gates the download and regenerating the snapshot has to work offline.
 */
const failOnPinDrift = Effect.fn("HerdrSchema.failOnPinDrift")(function* (
  pin: Pin,
  target: string,
) {
  const stable = yield* manifest(MANIFEST_URLS.stable, StableSchema).pipe(
    Effect.catch((cause) =>
      Console.error(
        `could not reach the stable manifest to cross-check the pin: ${String(cause)}`,
      ).pipe(Effect.as(undefined)),
    ),
  );
  if (stable === undefined) return;
  const disagreement = pinDisagreement(pin, stable, target);
  if (disagreement !== undefined) return yield* new Cause.UnknownError(disagreement, disagreement);
});

/** Reads the channel's release facts; `releaseFrom` decides what they mean. */
const release = Effect.fn("HerdrSchema.release")(function* (channel: string, target: string) {
  if (channel === "pinned") {
    const fs = yield* FileSystem.FileSystem;
    const pin = yield* Schema.decodeEffect(Schema.fromJsonString(PinSchema))(
      yield* fs.readFileString(PIN),
    );
    yield* failOnPinDrift(pin, target);
    return releaseFrom({ pinned: pin }, target);
  }
  if (channel === "stable") {
    return releaseFrom({ stable: yield* manifest(MANIFEST_URLS.stable, StableSchema) }, target);
  }
  if (channel === "preview") {
    return releaseFrom({ preview: yield* manifest(MANIFEST_URLS.preview, PreviewSchema) }, target);
  }
  return yield* new Cause.IllegalArgumentError(
    `unknown channel ${channel}; expected pinned, stable or preview`,
  );
});

/** Downloads, verifies and runs the release, and returns the schema it prints. */
const schemaOf = Effect.fn("HerdrSchema.schemaOf")(function* (spec: Release) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const digest = yield* Digest.Digest;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const binary = paths.join(
    yield* fs.makeTempDirectoryScoped({ prefix: "herdr-schema-" }),
    "herdr",
  );
  const response = yield* get(spec.url);
  const bytes = new Uint8Array(yield* response.arrayBuffer);
  const hashed = yield* digest.digestHex(Digest.sha256, bytes);
  if (hashed !== spec.sha256)
    return yield* new Cause.UnknownError(
      hashed,
      `${spec.url} hashed ${hashed}, expected ${spec.sha256}`,
    );
  yield* fs.writeFile(binary, bytes);
  yield* fs.chmod(binary, 0o755);
  const child = yield* spawner.spawn(
    ChildProcess.make(binary, ["api", "schema", "--json"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      child.stdout.pipe(Stream.decodeText(), Stream.mkString),
      child.stderr.pipe(Stream.decodeText(), Stream.mkString),
      child.exitCode,
    ],
    { concurrency: "unbounded" },
  );
  if (exitCode !== 0)
    return yield* new Cause.UnknownError(
      exitCode,
      `herdr api schema exited ${exitCode}: ${stderr}`,
    );
  // Canonical printing keeps a whitespace-only upstream change out of the contract snapshot.
  const schema = yield* Schema.decodeEffect(JsonText)(stdout);
  return `${yield* Schema.encodeEffect(JsonText)(schema)}\n`;
});

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const stdio = yield* Stdio.Stdio;
  const [channel = "pinned", ...flags] = yield* stdio.args;
  const outIndex = Option.getOrElse(
    Arr.findFirstIndex(flags, (flag) => flag === "--out"),
    () => -1,
  );
  const target = assetTarget();
  const spec = yield* release(channel, target);
  const schema = yield* schemaOf(spec);

  yield* Console.error(`herdr ${spec.label} (${target}), protocol ${spec.protocol}`);

  if (Arr.contains(flags, "--check")) {
    if (schema !== (yield* fs.readFileString(SNAPSHOT))) {
      yield* Console.error(
        `herdr-api-schema.json is not what herdr ${spec.label} prints. Run \`${REGENERATE}\` and commit the result.`,
      );
      return 1;
    }
    yield* Console.error("herdr-api-schema.json matches the pin.");
  } else if (Arr.contains(flags, "--write")) {
    yield* fs.writeFileString(SNAPSHOT, schema);
    yield* Console.error(`wrote ${SNAPSHOT}`);
  } else if (outIndex >= 0) {
    const out = flags[outIndex + 1];
    if (out === undefined || out === "")
      return yield* new Cause.IllegalArgumentError("--out needs a path");
    yield* fs.writeFileString(out, schema);
    yield* Console.error(`wrote ${out}`);
  } else {
    yield* Stream.succeed(schema).pipe(Stream.run(stdio.stdout()));
  }
  return 0;
});

BunRuntime.runMain(
  program.pipe(
    Effect.scoped,
    Effect.tapCause((cause) => Console.error(Cause.pretty(cause))),
    Effect.provide(Layer.mergeAll(BunServices.layer, Digest.layerWebCrypto, FetchHttpClient.layer)),
  ),
  {
    disableErrorReporting: true,
    teardown: (exit, onExit) =>
      Exit.isSuccess(exit)
        ? onExit(exit.value === 1 ? 1 : 0)
        : Runtime.defaultTeardown(exit, onExit),
  },
);
