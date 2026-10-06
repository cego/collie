// `bun run tools/check-payload.ts <installer>...`: fails when an Electrobun installer's
// payload has an entry its self-extractor cannot read: a GNU long-name or pax header, or any
// path over the 100 characters a tar header holds. Checked before a release publishes one.

import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Data, Effect, FileSystem } from "effect";

class PayloadRefused extends Data.TaggedError("PayloadRefused")<{ readonly message: string }> {}

/** What the installer's own code ends at; the zstd payload follows the last one. */
const MARKER = new TextEncoder().encode("ELECTROBUN_ARCHIVE_V1");
const BLOCK = 512;
const LONGEST = 100;

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes).replace(/\0.*$/s, "");

/** Every path in a tar whose header the extractor could not read, with why. */
const unreadable = (tar: Uint8Array) => {
  const found: string[] = [];
  for (let at = 0; at + BLOCK <= tar.length;) {
    const header = tar.subarray(at, at + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const name = text(header.subarray(0, 100));
    const ustar = text(header.subarray(257, 262)) === "ustar";
    const prefix = ustar ? text(header.subarray(345, 500)) : "";
    const path = prefix === "" ? name : `${prefix}/${name}`;
    const type = String.fromCharCode(header[156] || 48);
    const size = Number.parseInt(text(header.subarray(124, 136)).trim() || "0", 8);
    if (type === "L" || type === "K") {
      const long = text(tar.subarray(at + BLOCK, at + BLOCK + size));
      found.push(`${long} (a GNU long-name entry)`);
    } else if (type === "x" || type === "g") found.push(`${path} (a pax header)`);
    else if (path.length > LONGEST) found.push(`${path} (${path.length} characters)`);
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return found;
};

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  for (const installer of process.argv.slice(2)) {
    const bytes = yield* fs.readFile(installer);
    const marker = Buffer.from(bytes).lastIndexOf(MARKER);
    if (marker === -1) {
      return yield* new PayloadRefused({ message: `${installer} has no Electrobun payload` });
    }
    const tar = Bun.zstdDecompressSync(bytes.subarray(marker + MARKER.length));
    const found = unreadable(tar);
    if (found.length > 0) {
      return yield* new PayloadRefused({
        message: [
          `${installer}: its self-extractor cannot read these paths, so it is not published:`,
          ...found.map((path) => `  ${path}`),
        ].join("\n"),
      });
    }
    yield* Effect.log(`${installer}: every path fits in ${LONGEST} characters`);
  }
});

BunRuntime.runMain(program.pipe(Effect.provide(BunServices.layer)));
