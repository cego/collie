// `install-desktop.sh`, the one line that installs Collie Desktop: it runs Electrobun's
// installer only once the download verifies against Collie's release key.

import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { Effect, FileSystem } from "effect";
import { signReleaseP256 } from "../src/signing";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import { root } from "./support/host";

const SCRIPT = `${root}install-desktop.sh`;
const KEY_BLOCK = /-----BEGIN PUBLIC KEY-----\n[^-]*-----END PUBLIC KEY-----/;

test("the install script checks with the key release-p256.pub holds", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const script = yield* fs.readFileString(SCRIPT);
      const key = yield* fs.readFileString(`${root}release-p256.pub`);
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
    if (signature !== null) yield* fs.writeFileString(`${asset}.p256.sig`, `${signature}\n`);
    return asset;
  });

interface System {
  readonly os: string;
  readonly arch: string;
}
const LINUX: System = { os: "Linux", arch: "x86_64" };
const APPLE_SILICON: System = { os: "Darwin", arch: "arm64" };

/** The script run on its own, against `dir`'s release, checking with `publicKey`. */
const install = (dir: string, publicKey: string, system: System = LINUX) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const script = (yield* fs.readFileString(SCRIPT)).replace(KEY_BLOCK, publicKey.trim());
    const home = `${dir}/home`;
    yield* fs.makeDirectory(home, { recursive: true });
    // The system the script is told it runs on, whatever runs the test.
    yield* fs.writeFileString(
      `${dir}/uname`,
      `#!/bin/sh\ncase "$1" in -s) echo ${system.os} ;; -m) echo ${system.arch} ;; esac\n`,
      { mode: 0o755 },
    );
    // Away from the checkout, as `curl … | sh` runs it: nothing beside it to lean on.
    yield* fs.writeFileString(`${dir}/install-desktop.sh`, script);
    const done = yield* exec(["sh", `${dir}/install-desktop.sh`], {
      cwd: home,
      env: {
        PATH: `${dir}:${Bun.env.PATH ?? "/usr/bin:/bin"}`,
        HOME: home,
        COLLIE_DESKTOP_BASE: `file://${dir}/release`,
        COLLIE_OPENSSL: Bun.env.COLLIE_OPENSSL ?? "openssl",
      },
    });
    const ran = yield* fs.exists(`${home}/installed`);
    return { code: done.exitCode, said: done.stdout + done.stderr, ran };
  });

const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
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
      yield* release(dir, (bytes) => signReleaseP256(bytes, key.privateKey));
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
      yield* release(tampered, (bytes) => signReleaseP256(bytes, pair().privateKey));
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

/**
 * A macOS release: a DMG holding Collie Desktop's app, signed by `sign` or not at all. The DMG
 * is a tar the fake `hdiutil` beside the script unpacks at the mount point it is given, noting
 * each attach and detach in `hdiutil.log`.
 */
const macRelease = (dir: string, sign: (bytes: Uint8Array) => string | null) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const volume = `${dir}/volume`;
    yield* fs.makeDirectory(`${volume}/collie-desktop.app/Contents`, { recursive: true });
    yield* fs.writeFileString(`${volume}/collie-desktop.app/Contents/version`, "new\n");
    yield* fs.makeDirectory(`${dir}/release`, { recursive: true });
    const asset = `${dir}/release/macos-arm64-collie-desktop.dmg`;
    yield* exec(["tar", "-cf", asset, "-C", volume, "."]);
    const signature = sign(yield* fs.readFile(asset));
    if (signature !== null) yield* fs.writeFileString(`${asset}.p256.sig`, `${signature}\n`);
    yield* fs.writeFileString(
      `${dir}/hdiutil`,
      `#!/bin/sh
log='${dir}/hdiutil.log'
case "$1" in
  attach)
    echo "attach $*" >> "$log"
    while [ "$1" != -mountpoint ]; do shift; done
    mount=$2
    for dmg; do :; done
    mkdir -p "$mount" && tar -xf "$dmg" -C "$mount" ;;
  detach) echo detach >> "$log"; rm -rf "$2" ;;
esac
`,
      { mode: 0o755 },
    );
  });

const hdiutilLog = (dir: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(`${dir}/hdiutil.log`)),
    Effect.map((text) =>
      text
        .trim()
        .split("\n")
        .map((line) => line.split(" ")[0]),
    ),
    Effect.orElseSucceed((): string[] => []),
  );

test("on Apple silicon a signed DMG's app is copied into ~/Applications, replacing an older one", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const key = pair();
      yield* macRelease(dir, (bytes) => signReleaseP256(bytes, key.privateKey));
      const old = `${dir}/home/Applications/collie-desktop.app/Contents`;
      yield* fs.makeDirectory(old, { recursive: true });
      yield* fs.writeFileString(`${old}/version`, "old\n");
      yield* fs.writeFileString(`${old}/left-over`, "x");

      const done = yield* install(dir, key.publicKey, APPLE_SILICON);

      expect(done.code).toBe(0);
      expect(done.said).toContain("open -a");
      expect(yield* fs.readFileString(`${old}/version`)).toBe("new\n");
      expect(yield* fs.exists(`${old}/left-over`)).toBe(false);
      expect(yield* hdiutilLog(dir)).toEqual(["attach", "detach"]);
    }).pipe(Effect.scoped),
  ));

test("~/Applications is made where there is none", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const key = pair();
      yield* macRelease(dir, (bytes) => signReleaseP256(bytes, key.privateKey));

      const done = yield* install(dir, key.publicKey, APPLE_SILICON);

      expect(done.code).toBe(0);
      expect(yield* fs.exists(`${dir}/home/Applications/collie-desktop.app/Contents/version`)).toBe(
        true,
      );
    }).pipe(Effect.scoped),
  ));

test("a mismatched or unsigned DMG installs nothing and is never attached", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const key = pair();
      for (const sign of [
        (bytes: Uint8Array) => signReleaseP256(bytes, pair().privateKey),
        () => null,
      ]) {
        const dir = yield* fs.makeTempDirectoryScoped();
        yield* macRelease(dir, sign);

        const done = yield* install(dir, key.publicKey, APPLE_SILICON);

        expect(done.code).not.toBe(0);
        expect(yield* fs.exists(`${dir}/home/Applications`)).toBe(false);
        expect(yield* hdiutilLog(dir)).toEqual([]);
      }
    }).pipe(Effect.scoped),
  ));

test("a copy that fails keeps the installed app, leaves nothing half-copied and still detaches", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const key = pair();
      yield* macRelease(dir, (bytes) => signReleaseP256(bytes, key.privateKey));
      const apps = `${dir}/home/Applications`;
      yield* fs.makeDirectory(`${apps}/collie-desktop.app/Contents`, { recursive: true });
      yield* fs.writeFileString(`${apps}/collie-desktop.app/Contents/version`, "old\n");
      // A disk that fills up part way through the copy.
      yield* fs.writeFileString(
        `${dir}/cp`,
        '#!/bin/sh\nfor to; do :; done\nmkdir -p "$to"\nexit 1\n',
        { mode: 0o755 },
      );

      const done = yield* install(dir, key.publicKey, APPLE_SILICON);

      expect(done.code).not.toBe(0);
      expect(yield* fs.readFileString(`${apps}/collie-desktop.app/Contents/version`)).toBe("old\n");
      expect(yield* fs.readDirectory(apps)).toEqual(["collie-desktop.app"]);
      expect(yield* hdiutilLog(dir)).toEqual(["attach", "detach"]);
    }).pipe(Effect.scoped),
  ));

test("an Intel Mac is refused, and told the TUI plugin works there", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const done = yield* install(dir, pair().publicKey, { os: "Darwin", arch: "x86_64" });
      expect(done.code).not.toBe(0);
      expect(done.said).toContain(
        "Collie Desktop is released for Apple silicon only; the TUI plugin (setup.sh) works on this Mac.",
      );
    }).pipe(Effect.scoped),
  ));

test("any other system is refused by name", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const done = yield* install(dir, pair().publicKey, { os: "FreeBSD", arch: "amd64" });
      expect(done.code).not.toBe(0);
      expect(done.said).toContain("FreeBSD amd64");
    }).pipe(Effect.scoped),
  ));
