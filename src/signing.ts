// Release signatures: CI signs each runner binary with the release key, and every downloaded
// runner is checked here before it is used. The private key is only ever a CI secret.

import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

export const RELEASE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAlSUFdwz8026yxgOEch+qYQSblnjqUa3wMU2Yk0edBRY=
-----END PUBLIC KEY-----
`;

/** The suffix a release asset's signature is published under, beside the asset. */
export const SIGNATURE_SUFFIX = ".sig";

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
