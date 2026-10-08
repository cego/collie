// `bun run tools/sign.ts <file>...`: writes `<file>.sig` (Ed25519, with COLLIE_SIGNING_KEY)
// and `<file>.p256.sig` (P-256, with COLLIE_SIGNING_KEY_P256) beside each release asset. It
// refuses a key that is not the one Collie checks with, so a release signed by any other key
// fails here rather than at every install. Desktop's update archive is also signed as the tar
// it is applied as, which is what Desktop verifies.

import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Data, Effect, FileSystem } from "effect";
import {
  appliedSignatureOf,
  P256_SIGNATURE_SUFFIX,
  publicKeyOf,
  RELEASE_P256_PUBLIC_KEY,
  RELEASE_PUBLIC_KEY,
  SIGNATURE_SUFFIX,
  signRelease,
  signReleaseP256,
} from "../src/signing";

class SigningRefused extends Data.TaggedError("SigningRefused")<{ readonly message: string }> {}

const KEYS = [
  {
    variable: "COLLIE_SIGNING_KEY",
    publicKey: RELEASE_PUBLIC_KEY,
    sign: signRelease,
    suffix: SIGNATURE_SUFFIX,
  },
  {
    variable: "COLLIE_SIGNING_KEY_P256",
    publicKey: RELEASE_P256_PUBLIC_KEY,
    sign: signReleaseP256,
    suffix: P256_SIGNATURE_SUFFIX,
  },
] as const;

const refusalOf = (variable: string, privateKey: string, publicKey: string): string | null => {
  if (privateKey === "") return `${variable} is not set; a release is never published unsigned`;
  try {
    return publicKeyOf(privateKey).trim() === publicKey.trim()
      ? null
      : `${variable} is not the key Collie verifies with`;
  } catch {
    return `${variable} is not a private key`;
  }
};

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const keys = [];
  const refusals = [];
  for (const key of KEYS) {
    const privateKey = yield* Config.String(key.variable).pipe(Config.withDefault(""));
    const refusal = refusalOf(key.variable, privateKey, key.publicKey);
    if (refusal === null) keys.push({ ...key, privateKey });
    else refusals.push(refusal);
  }
  if (refusals.length > 0) return yield* new SigningRefused({ message: refusals.join("; ") });
  const [ed25519] = keys;
  for (const file of process.argv.slice(2)) {
    const bytes = yield* fs.readFile(file);
    for (const key of keys) {
      yield* fs.writeFileString(`${file}${key.suffix}`, `${key.sign(bytes, key.privateKey)}\n`);
    }
    const applied = appliedSignatureOf(file);
    if (applied !== null && ed25519 !== undefined) {
      const tar = Bun.zstdDecompressSync(bytes);
      yield* fs.writeFileString(applied, `${signRelease(tar, ed25519.privateKey)}\n`);
    }
    yield* Effect.log(`signed ${file}`);
  }
});

BunRuntime.runMain(program.pipe(Effect.provide(BunServices.layer)));
