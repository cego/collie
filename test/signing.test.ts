// Release signatures, and the tool CI signs with.

import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { Effect, FileSystem } from "effect";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import { RELEASE_PUBLIC_KEY, signRelease, verifyRelease } from "../src/signing";

const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
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

const signTool = (file: string, key?: string) => {
  const path = { PATH: Bun.env.PATH ?? "" };
  const env = key === undefined ? path : { ...path, COLLIE_SIGNING_KEY: key };
  return exec(["bun", "run", `${import.meta.dir}/../tools/sign.ts`, file], { env }).pipe(
    Effect.map((done) => ({ code: done.exitCode, said: done.stderr + done.stdout })),
  );
};

test("the signing tool refuses to sign without a key, or with one Collie does not verify", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = `${yield* fs.makeTempDirectoryScoped()}/collie-linux-x64`;
      yield* fs.writeFile(file, binary);

      const unset = yield* signTool(file);
      expect(unset.code).not.toBe(0);
      expect(unset.said).toContain("never published unsigned");

      const wrong = yield* signTool(file, pair().privateKey);
      expect(wrong.code).not.toBe(0);
      expect(wrong.said).toContain("not the key Collie verifies");
      expect(yield* fs.exists(`${file}.sig`)).toBe(false);
    }).pipe(Effect.scoped),
  ));
