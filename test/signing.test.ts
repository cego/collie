// Release signatures, and the tool CI signs with.

import { expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { Effect, FileSystem } from "effect";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import {
  RELEASE_P256_PUBLIC_KEY,
  RELEASE_PUBLIC_KEY,
  signRelease,
  signReleaseP256,
  verifyRelease,
} from "../src/signing";

const pair = (kind: "ed25519" | "p256" = "ed25519") => {
  const { publicKey, privateKey } =
    kind === "ed25519"
      ? generateKeyPairSync("ed25519")
      : generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
};

const binary = new TextEncoder().encode("#!collie runner 0.27.0");

test("a binary signed by the release key is accepted", () => {
  const key = pair();
  const signature = signRelease(binary, key.privateKey);

  expect(verifyRelease(binary, signature, key.publicKey)).toEqual({ ok: true });
});

test("an altered binary is refused", () => {
  const key = pair();
  const signature = signRelease(binary, key.privateKey);
  const altered = binary.slice();
  altered[0] = altered[0]! ^ 1;

  const refused = verifyRelease(altered, signature, key.publicKey);

  expect(refused).toMatchObject({ ok: false });
  expect(!refused.ok && refused.reason).toContain("does not match");
});

test("a binary signed by any other key is refused", () => {
  const signature = signRelease(binary, pair().privateKey);

  expect(verifyRelease(binary, signature, pair().publicKey)).toMatchObject({ ok: false });
});

test("an unsigned binary is refused, and said to be unsigned", () => {
  const refused = verifyRelease(binary, null);

  expect(refused).toMatchObject({ ok: false });
  expect(!refused.ok && refused.reason).toContain("unsigned");
});

test("a signature that is not one is refused rather than thrown", () => {
  const refused = verifyRelease(binary, "not base64 at all!", pair().publicKey);

  expect(refused).toMatchObject({ ok: false });
});

test("the built-in release key parses, and refuses what another key signed", () => {
  expect(RELEASE_PUBLIC_KEY).toContain("BEGIN PUBLIC KEY");
  expect(verifyRelease(binary, signRelease(binary, pair().privateKey))).toMatchObject({
    ok: false,
  });
});

test("a P-256 signature is one any openssl checks with dgst", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const key = pair("p256");
      yield* fs.writeFile(`${dir}/asset`, binary);
      yield* fs.writeFileString(`${dir}/key.pub`, key.publicKey);
      yield* fs.writeFile(
        `${dir}/asset.sig.bin`,
        Buffer.from(signReleaseP256(binary, key.privateKey), "base64"),
      );

      const done = yield* exec([
        "openssl",
        "dgst",
        "-sha256",
        "-verify",
        `${dir}/key.pub`,
        "-signature",
        `${dir}/asset.sig.bin`,
        `${dir}/asset`,
      ]);
      expect(done.stdout).toContain("Verified OK");
      expect(done.exitCode).toBe(0);
    }).pipe(Effect.scoped),
  ));

test("the built-in P-256 release key is a P-256 public key", () => {
  expect(createPublicKey(RELEASE_P256_PUBLIC_KEY).asymmetricKeyDetails).toEqual({
    namedCurve: "prime256v1",
  });
});

const signTool = (file: string, keys: { ed25519?: string; p256?: string }) => {
  const env = {
    PATH: Bun.env.PATH ?? "",
    ...(keys.ed25519 !== undefined && { COLLIE_SIGNING_KEY: keys.ed25519 }),
    ...(keys.p256 !== undefined && { COLLIE_SIGNING_KEY_P256: keys.p256 }),
  };
  return exec(["bun", "run", `${import.meta.dir}/../tools/sign.ts`, file], { env }).pipe(
    Effect.map((done) => ({ code: done.exitCode, said: done.stderr + done.stdout })),
  );
};

test("the signing tool refuses to sign without both keys, or with ones Collie does not verify", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = `${yield* fs.makeTempDirectoryScoped()}/collie-linux-x64`;
      yield* fs.writeFile(file, binary);

      const unset = yield* signTool(file, {});
      expect(unset.code).not.toBe(0);
      expect(unset.said).toContain("COLLIE_SIGNING_KEY is not set");
      expect(unset.said).toContain("COLLIE_SIGNING_KEY_P256 is not set");

      const noP256 = yield* signTool(file, { ed25519: pair().privateKey });
      expect(noP256.code).not.toBe(0);
      expect(noP256.said).toContain("COLLIE_SIGNING_KEY_P256 is not set");

      const wrong = yield* signTool(file, {
        ed25519: pair().privateKey,
        p256: pair("p256").privateKey,
      });
      expect(wrong.code).not.toBe(0);
      expect(wrong.said).toContain("COLLIE_SIGNING_KEY is not the key Collie verifies with");
      expect(wrong.said).toContain("COLLIE_SIGNING_KEY_P256 is not the key Collie verifies with");
      expect(yield* fs.exists(`${file}.sig`)).toBe(false);
      expect(yield* fs.exists(`${file}.p256.sig`)).toBe(false);
    }).pipe(Effect.scoped),
  ));
