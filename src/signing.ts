import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import releaseKey from "../release.pub" with { type: "text" };
import releaseP256Key from "../release-p256.pub" with { type: "text" };

export const RELEASE_PUBLIC_KEY: string = releaseKey;

export const RELEASE_P256_PUBLIC_KEY: string = releaseP256Key;

export const SIGNATURE_SUFFIX = ".sig";

export const P256_SIGNATURE_SUFFIX = ".p256.sig";

// WARNING: an update's signature covers its decompressed tar, which is what an installed update is made of.
export const appliedSignatureOf = (archive: string) =>
  pipe(archive, Str.endsWith(".tar.zst"))
    ? `${pipe(archive, Str.slice(0, -".zst".length))}${SIGNATURE_SUFFIX}`
    : null;

export type Verified = { ok: true } | { ok: false; reason: string };

export function signRelease(bytes: Uint8Array, privateKeyPem: string) {
  return sign(null, bytes, createPrivateKey(privateKeyPem)).toString("base64");
}

export const publicKeyOf = (privateKeyPem: string) =>
  createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }).toString();

export function signReleaseP256(bytes: Uint8Array, privateKeyPem: string) {
  return sign("sha256", bytes, createPrivateKey(privateKeyPem)).toString("base64");
}

export function verifyRelease(
  bytes: Uint8Array,
  signature: string | null,
  publicKeyPem: string = RELEASE_PUBLIC_KEY,
) {
  if (signature === null || Str.trim(signature) === "") {
    const returned: Verified = {
      ok: false,
      reason: "the download is unsigned, so it was refused",
    };
    return returned;
  }
  const decoded = Buffer.from(Str.trim(signature), "base64");
  const valid =
    decoded.length === 64 && verify(null, bytes, createPublicKey(publicKeyPem), decoded);
  const returned: Verified = valid
    ? { ok: true }
    : {
        ok: false,
        reason:
          "the download does not match its signature from Collie's release key, so it was refused",
      };
  return returned;
}
