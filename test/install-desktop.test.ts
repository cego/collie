// `install-desktop.sh`, the one line that installs Collie Desktop: it runs Electrobun's
// installer, or on macOS puts its app in ~/Applications, only once the download verifies
// against Collie's release key.

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

type Os = "linux" | "macos";

/** Each platform's `uname -s` and `uname -m`, the asset it downloads, and what it installs. */
const PLATFORMS = {
  linux: { uname: ["Linux", "x86_64"], asset: "linux-x64-collie-desktop-Setup.tar.gz" },
  macos: { uname: ["Darwin", "arm64"], asset: "macos-arm64-collie-desktop.dmg" },
} as const;
const APP = "Applications/collie-desktop.app/Contents/MacOS/launcher";

/**
 * A release for `os` signed by `sign` or not at all: Linux's installer records it ran, and
 * macOS's image, a tar the fake `hdiutil` mounts, holds the app.
 */
const release = (dir: string, sign: (bytes: Uint8Array) => string | null, os: Os = "linux") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const setup = `${dir}/setup`;
    yield* fs.makeDirectory(`${dir}/release`, { recursive: true });
    const asset = `${dir}/release/${PLATFORMS[os].asset}`;
    if (os === "linux") {
      yield* fs.makeDirectory(setup, { recursive: true });
      yield* fs.writeFileString(`${setup}/installer`, '#!/bin/sh\necho ran > "$HOME/installed"\n');
      yield* fs.chmod(`${setup}/installer`, 0o755);
      yield* exec(["tar", "-czf", asset, "-C", setup, "./installer"]);
    } else {
      yield* fs.makeDirectory(`${setup}/collie-desktop.app/Contents/MacOS`, { recursive: true });
      yield* fs.writeFileString(`${setup}/collie-desktop.app/Contents/MacOS/launcher`, "new\n");
      yield* exec(["tar", "-cf", asset, "-C", setup, "collie-desktop.app"]);
    }
    const signature = sign(yield* fs.readFile(asset));
    if (signature !== null) yield* fs.writeFileString(`${asset}.sig`, `${signature}\n`);
    return asset;
  });

/** `uname` saying `os`, and for macOS an `hdiutil` and `ditto` that work anywhere. */
const fakes = (bin: string, os: Os, machine: string = PLATFORMS[os].uname[1]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(bin, { recursive: true });
    const tools = {
      uname: `case "$1" in -s) echo ${PLATFORMS[os].uname[0]} ;; -m) echo ${machine} ;; esac`,
      // As the script calls it: attach -quiet -nobrowse -readonly -mountpoint <dir> <image>,
      // and detach -quiet <dir>, which fails where nothing is mounted.
      hdiutil: `case "$1" in
  attach) mkdir -p "$6" && tar -xf "$7" -C "$6" ;;
  detach) [ -d "$3" ] && rm -rf "$3" ;;
esac`,
      ditto: `[ -e "$HOME/ditto-fails" ] && { mkdir -p "$2"; exit 1; }; cp -R "$1" "$2"`,
    };
    for (const [name, body] of Object.entries(tools)) {
      yield* fs.writeFileString(`${bin}/${name}`, `#!/bin/sh\n${body}\n`);
      yield* fs.chmod(`${bin}/${name}`, 0o755);
    }
  });

/** The script run on its own as `os`, against `dir`'s release, checking with `publicKey`. */
const install = (dir: string, publicKey: string, os: Os = "linux", machine?: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const script = (yield* fs.readFileString(SCRIPT)).replace(KEY_BLOCK, publicKey.trim());
    const home = `${dir}/home`;
    yield* fs.makeDirectory(home, { recursive: true });
    yield* fakes(`${dir}/bin`, os, machine);
    // Away from the checkout, as `curl … | sh` runs it: nothing beside it to lean on.
    yield* fs.writeFileString(`${dir}/install-desktop.sh`, script);
    const done = yield* exec(["sh", `${dir}/install-desktop.sh`], {
      cwd: home,
      env: {
        PATH: `${dir}/bin:${Bun.env.PATH ?? "/usr/bin:/bin"}`,
        HOME: home,
        COLLIE_DESKTOP_BASE: `file://${dir}/release`,
      },
    });
    const ran = yield* fs.exists(os === "linux" ? `${home}/installed` : `${home}/${APP}`);
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

test("on macOS a signed app is put in ~/Applications, over the one there before", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const key = pair();
      yield* fs.makeDirectory(`${dir}/home/Applications/collie-desktop.app/Contents/MacOS`, {
        recursive: true,
      });
      yield* fs.writeFileString(`${dir}/home/${APP}`, "old\n");
      yield* release(dir, (bytes) => signRelease(bytes, key.privateKey), "macos");
      const done = yield* install(dir, key.publicKey, "macos");
      expect(done.said).toContain("installed Collie Desktop in ~/Applications");
      expect(done.code).toBe(0);
      expect(yield* fs.readFileString(`${dir}/home/${APP}`)).toBe("new\n");
    }).pipe(Effect.scoped),
  ));

test("on macOS a failed copy keeps the app that was there", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const key = pair();
      yield* fs.makeDirectory(`${dir}/home/Applications/collie-desktop.app/Contents/MacOS`, {
        recursive: true,
      });
      yield* fs.writeFileString(`${dir}/home/${APP}`, "old\n");
      yield* fs.writeFileString(`${dir}/home/ditto-fails`, "");
      yield* release(dir, (bytes) => signRelease(bytes, key.privateKey), "macos");
      const done = yield* install(dir, key.publicKey, "macos");
      expect(done.code).not.toBe(0);
      expect(done.said).toContain("left as it was");
      expect(yield* fs.readFileString(`${dir}/home/${APP}`)).toBe("old\n");
      expect(yield* fs.exists(`${dir}/home/Applications/collie-desktop.app.new`)).toBe(false);
    }).pipe(Effect.scoped),
  ));

test("a tampered or unsigned installer is refused and never run, on Linux and macOS alike", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const key = pair();
      for (const os of ["linux", "macos"] as const) {
        const tampered = yield* fs.makeTempDirectoryScoped();
        yield* release(tampered, (bytes) => signRelease(bytes, pair().privateKey), os);
        const mismatched = yield* install(tampered, key.publicKey, os);
        expect(mismatched.code).not.toBe(0);
        expect(mismatched.said).toContain("does not match its signature");
        expect(mismatched.ran).toBe(false);

        const bare = yield* fs.makeTempDirectoryScoped();
        yield* release(bare, () => null, os);
        const unsigned = yield* install(bare, key.publicKey, os);
        expect(unsigned.code).not.toBe(0);
        expect(unsigned.said).toContain("could not fetch");
        expect(unsigned.ran).toBe(false);
      }
    }).pipe(Effect.scoped),
  ));

test("an Intel Mac is told Desktop is released for Apple silicon, and nothing is downloaded", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const done = yield* install(dir, pair().publicKey, "macos", "x86_64");
      expect(done.code).not.toBe(0);
      expect(done.said).toContain("Apple silicon only");
      expect(done.said).toContain("TUI plugin");
    }).pipe(Effect.scoped),
  ));
