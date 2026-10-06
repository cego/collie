// `install-desktop.sh`, the one line that installs Collie Desktop: it runs Electrobun's
// installer only once the download verifies against Collie's release key.

import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { Effect, FileSystem } from "effect";
import { signRelease } from "../src/signing";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import { root } from "./support/host";

const SCRIPT = `${root}install-desktop.sh`;
const KEY_BLOCK = /-----BEGIN PUBLIC KEY-----\n[^-]*-----END PUBLIC KEY-----/;

test("the install script checks with the key release.pub holds", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const script = yield* fs.readFileString(SCRIPT);
      const key = yield* fs.readFileString(`${root}release.pub`);
      expect(KEY_BLOCK.exec(script)?.[0]).toBe(key.trim());
    }),
  ));

/** A release with an installer that records it ran, signed by `sign` or not at all. */
const release = (dir: string, sign: (bytes: Uint8Array) => string | null) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const setup = `${dir}/setup`;
    yield* fs.makeDirectory(setup, { recursive: true });
    yield* fs.writeFileString(`${setup}/installer`, '#!/bin/sh\necho ran > "$HOME/installed"\n');
    yield* fs.chmod(`${setup}/installer`, 0o755);
    yield* fs.makeDirectory(`${dir}/release`, { recursive: true });
    const asset = `${dir}/release/linux-x64-collie-desktop-Setup.tar.gz`;
    yield* exec(["tar", "-czf", asset, "-C", setup, "./installer"]);
    const signature = sign(yield* fs.readFile(asset));
    if (signature !== null) yield* fs.writeFileString(`${asset}.sig`, `${signature}\n`);
    return asset;
  });

/** The script run on its own, against `dir`'s release, checking with `publicKey`. */
const install = (dir: string, publicKey: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const script = (yield* fs.readFileString(SCRIPT)).replace(KEY_BLOCK, publicKey.trim());
    const home = `${dir}/home`;
    yield* fs.makeDirectory(home, { recursive: true });
    // Away from the checkout, as `curl … | sh` runs it: nothing beside it to lean on.
    yield* fs.writeFileString(`${dir}/install-desktop.sh`, script);
    const done = yield* exec(["sh", `${dir}/install-desktop.sh`], {
      cwd: home,
      env: {
        PATH: Bun.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        COLLIE_DESKTOP_BASE: `file://${dir}/release`,
      },
    });
    const ran = yield* fs.exists(`${home}/installed`);
    return { code: done.exitCode, said: done.stdout + done.stderr, ran };
  });

const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
};

test("a signed installer is downloaded and run for this user", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const key = pair();
      yield* release(dir, (bytes) => signRelease(bytes, key.privateKey));
      const done = yield* install(dir, key.publicKey);
      expect(done.said).toContain("installed Collie Desktop");
      expect(done.code).toBe(0);
      expect(done.ran).toBe(true);
    }).pipe(Effect.scoped),
  ));

test("a tampered or unsigned installer is refused and never run", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const key = pair();

      const tampered = yield* fs.makeTempDirectoryScoped();
      yield* release(tampered, (bytes) => signRelease(bytes, pair().privateKey));
      const mismatched = yield* install(tampered, key.publicKey);
      expect(mismatched.code).not.toBe(0);
      expect(mismatched.said).toContain("does not match its signature");
      expect(mismatched.ran).toBe(false);

      const bare = yield* fs.makeTempDirectoryScoped();
      yield* release(bare, () => null);
      const unsigned = yield* install(bare, key.publicKey);
      expect(unsigned.code).not.toBe(0);
      expect(unsigned.said).toContain("could not fetch");
      expect(unsigned.ran).toBe(false);
    }).pipe(Effect.scoped),
  ));
