// Release signatures: CI signs each runner binary with the release key, and every downloaded
// runner is checked against it before it is installed. The private key is only ever a CI secret.

import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import releaseKey from "../release.pub" with { type: "text" };
import releaseP256Key from "../release-p256.pub" with { type: "text" };

export const RELEASE_PUBLIC_KEY: string = releaseKey;

/** What `install.sh` and `install-desktop.sh` check a download with, since any openssl can. */
export const RELEASE_P256_PUBLIC_KEY: string = releaseP256Key;

/** The suffix a release asset's signature is published under, beside the asset. */
export const SIGNATURE_SUFFIX = ".sig";

/** The suffix of the P-256 signature, beside the Ed25519 one. */
export const P256_SIGNATURE_SUFFIX = ".p256.sig";

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

/** The public half of a PKCS#8 private key, as SPKI PEM. Throws where it is not one. */
export const publicKeyOf = (privateKeyPem: string): string =>
  createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" }).toString();

/** ECDSA P-256 over SHA-256, DER, base64, as published in `<asset>.p256.sig`. */
export function signReleaseP256(bytes: Uint8Array, privateKeyPem: string): string {
  return sign("sha256", bytes, createPrivateKey(privateKeyPem)).toString("base64");
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
