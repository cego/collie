// Release signatures: CI signs each runner binary with the release key, and every downloaded
// runner is checked against it before it is installed. The private key is only ever a CI secret.

import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import releaseKey from "../release.pub" with { type: "text" };

// `release.pub`, which `install.sh` also checks a downloaded runner with.
export const RELEASE_PUBLIC_KEY: string = releaseKey;

/** The suffix a release asset's signature is published under, beside the asset. */
export const SIGNATURE_SUFFIX = ".sig";

/**
 * The signature an update archive is applied under: `<name>.tar.sig` for `<name>.tar.zst`,
 * over its decompressed tar, which is what an installed update is made of.
 */
export const appliedSignatureOf = (archive: string): string | null =>
  archive.endsWith(".tar.zst") ? `${archive.slice(0, -".zst".length)}${SIGNATURE_SUFFIX}` : null;

export type Verified = { ok: true } | { ok: false; reason: string };

/** A detached ed25519 signature, base64, as published in `<asset>.sig`. */
export function signRelease(bytes: Uint8Array, privateKeyPem: string): string {
  return sign(null, bytes, createPrivateKey(privateKeyPem)).toString("base64");
}

/** `signature` is the `.sig` file's text, or null where the release has none. */
export function verifyRelease(
  bytes: Uint8Array,
  signature: string | null,
  publicKeyPem: string = RELEASE_PUBLIC_KEY,
): Verified {
  if (signature === null || signature.trim() === "") {
    return { ok: false, reason: "the download is unsigned, so it was refused" };
  }
  const decoded = Buffer.from(signature.trim(), "base64");
  const valid =
    decoded.length === 64 && verify(null, bytes, createPublicKey(publicKeyPem), decoded);
  return valid
    ? { ok: true }
    : {
        ok: false,
        reason:
          "the download does not match its signature from Collie's release key, so it was refused",
      };
}
