// Prints a herdr release's bundled socket-API schema, which `test/herdr-contract.test.ts`
// checks Collie's boundary structs against. One script for all three channels so the
// scheduled drift check and the pinned check cannot download or verify differently:
//
//   bun run tools/herdr-schema.ts pinned  --check          # snapshot still matches the pin
//   bun run tools/herdr-schema.ts pinned  --write          # regenerate the snapshot
//   bun run tools/herdr-schema.ts stable  --out /tmp/s.json
//   bun run tools/herdr-schema.ts preview --out /tmp/s.json
//
// A plain Bun script, like tools/build.ts: it downloads, hashes and executes a binary
// before any Effect program exists to do it in.
//
// This is the one place outside src/herdr.ts that runs a herdr binary, and the invariant
// that says otherwise names it (AGENTS.md, docs/internals.md). It is not talking to the
// session: no HERDR_BIN_PATH, no socket, no state, and a downloaded artifact in a temp
// directory rather than the herdr the user is running — which is the whole point, since
// the question is what some other version's schema says.

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pin, Release } from "./herdr-release";
import { MANIFEST_URLS, pinDisagreement, releaseFrom } from "./herdr-release";

const ROOT = new URL("..", import.meta.url).pathname;
const PIN = join(ROOT, "herdr-pin.json");
const SNAPSHOT = join(ROOT, "herdr-api-schema.json");
const REGENERATE = "bun run contract:regen";

/** herdr names its assets by kernel and machine, not by Bun's target strings. */
function assetTarget(): string {
  const os = process.platform === "darwin" ? "macos" : "linux";
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  return `${os}-${arch}`;
}

async function manifest(url: string): Promise<any> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

/**
 * Cross-checks the pin against the published stable manifest, where the pinned version
 * is still the current stable and herdr.dev is reachable. A disagreement is fatal; an
 * unreachable manifest is not, because the pin's committed checksum is what actually
 * gates the download and regenerating the snapshot has to work offline.
 */
async function failOnPinDrift(pin: Pin, target: string): Promise<void> {
  const stable = await manifest(MANIFEST_URLS.stable).catch((cause: unknown) => {
    console.error(`could not reach the stable manifest to cross-check the pin: ${cause}`);
    return undefined;
  });
  if (!stable) return;
  const disagreement = pinDisagreement(pin, stable, target);
  if (disagreement) throw new Error(disagreement);
}

/** Reads the channel's release facts; `releaseFrom` decides what they mean. */
async function release(channel: string, target: string): Promise<Release> {
  if (channel === "pinned") {
    const pin = JSON.parse(readFileSync(PIN, "utf8"));
    await failOnPinDrift(pin, target);
    return releaseFrom({ pinned: pin }, target);
  }
  if (channel === "stable") {
    return releaseFrom({ stable: await manifest(MANIFEST_URLS.stable) }, target);
  }
  if (channel === "preview") {
    return releaseFrom({ preview: await manifest(MANIFEST_URLS.preview) }, target);
  }
  throw new Error(`unknown channel ${channel}; expected pinned, stable or preview`);
}

/** Downloads, verifies and runs the release, and returns the schema it prints. */
async function schemaOf(spec: Release): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "herdr-schema-"));
  const binary = join(dir, "herdr");
  try {
    const response = await fetch(spec.url);
    if (!response.ok) throw new Error(`${spec.url} answered ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    if (digest !== spec.sha256) {
      throw new Error(`${spec.url} hashed ${digest}, expected ${spec.sha256}`);
    }
    writeFileSync(binary, bytes);
    chmodSync(binary, 0o755);
    const printed = Bun.spawnSync([binary, "api", "schema", "--json"]);
    if (printed.exitCode !== 0) {
      throw new Error(`herdr api schema exited ${printed.exitCode}: ${printed.stderr.toString()}`);
    }
    // Reprinted rather than passed through, so the committed snapshot is diffable and
    // a whitespace change in herdr's printer is not a contract change.
    return `${JSON.stringify(JSON.parse(printed.stdout.toString()), null, 2)}\n`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const [channel = "pinned", ...flags] = process.argv.slice(2);
const outIndex = flags.indexOf("--out");
const target = assetTarget();
const spec = await release(channel, target);
const schema = await schemaOf(spec);

console.error(`herdr ${spec.label} (${target}), protocol ${spec.protocol}`);

if (flags.includes("--check")) {
  if (schema !== readFileSync(SNAPSHOT, "utf8")) {
    console.error(
      `herdr-api-schema.json is not what herdr ${spec.label} prints. Run \`${REGENERATE}\` and commit the result.`,
    );
    process.exit(1);
  }
  console.error("herdr-api-schema.json matches the pin.");
} else if (flags.includes("--write")) {
  writeFileSync(SNAPSHOT, schema);
  console.error(`wrote ${SNAPSHOT}`);
} else if (outIndex >= 0) {
  const out = flags[outIndex + 1];
  if (!out) throw new Error("--out needs a path");
  writeFileSync(out, schema);
  console.error(`wrote ${out}`);
} else {
  process.stdout.write(schema);
}
