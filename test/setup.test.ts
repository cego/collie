// `setup.sh`, the one line that installs Collie: it runs the release's runner only once the
// download verifies against Collie's release key, and that runner places the release.

import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { Effect, FileSystem } from "effect";
import { signReleaseP256 } from "../src/signing";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import { root } from "./support/host";

const SCRIPT = `${root}setup.sh`;
const KEY_BLOCK = /-----BEGIN PUBLIC KEY-----\n[^-]*-----END PUBLIC KEY-----/;
const ASSET = "collie-linux-x64";

const pair = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
};

test("the installer checks with the key release-p256.pub holds", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const script = yield* fs.readFileString(SCRIPT);
      const key = yield* fs.readFileString(`${root}release-p256.pub`);
      expect(KEY_BLOCK.exec(script)?.[0]).toBe(Str.trim(key));
    }),
  ));

/** A Machine with herdr, and `runner` published under `dir/releases/<at>`, signed by `sign` or not. */
const machine = (
  dir: string,
  runner: Uint8Array,
  sign: ((bytes: Uint8Array) => string) | null,
  at = "latest/download",
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const published = `${dir}/releases/${at}`;
    yield* fs.makeDirectory(published, { recursive: true });
    yield* fs.writeFile(`${published}/${ASSET}`, runner);
    if (sign) yield* fs.writeFileString(`${published}/${ASSET}.p256.sig`, `${sign(runner)}\n`);
    const stubs = `${dir}/stubs`;
    yield* fs.makeDirectory(stubs, { recursive: true });
    const stub = (name: string, body: string) =>
      fs.writeFileString(`${stubs}/${name}`, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    yield* stub("uname", `case "$1" in -s) echo Linux ;; -m) echo x86_64 ;; esac`);
    yield* stub("herdr", `echo "$*" >> "${dir}/herdr-calls"`);
    // The verified runner is `env`, a real program, so `upgrade` below is what it runs: the
    // placing, as the real runner's own upgrade does it.
    yield* stub(
      "upgrade",
      `echo "$HERDR_PLUGIN_ROOT upgrade\${*:+ $*}" >> "${dir}/placed"
mkdir -p "$COLLIE_DIR/release/bin"
printf '#!/bin/sh\\necho "$*" >> "${dir}/collie-calls"\\n' > "$COLLIE_DIR/release/bin/collie"
chmod +x "$COLLIE_DIR/release/bin/collie"`,
    );
  });

/** The script run on its own, as `curl … | sh` runs it, checking with `publicKey`. */
const install = (dir: string, publicKey: string, extra: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const script = pipe_(
      yield* fs.readFileString(SCRIPT),
      Str.replace(KEY_BLOCK, Str.trim(publicKey)),
    );
    const home = `${dir}/home`;
    yield* fs.makeDirectory(home, { recursive: true });
    yield* fs.writeFileString(`${dir}/setup.sh`, script);
    const done = yield* exec(["sh", `${dir}/setup.sh`], {
      cwd: home,
      env: {
        PATH: `${dir}/stubs:/usr/bin:/bin`,
        HOME: home,
        COLLIE_RELEASES: `file://${dir}/releases`,
        COLLIE_OPENSSL: Bun.env.COLLIE_OPENSSL ?? "openssl",
        ...extra,
      },
    });
    const read = (file: string) => fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
    return {
      code: done.exitCode,
      said: done.stdout + done.stderr,
      placed: yield* read(`${dir}/placed`),
      calls: yield* read(`${dir}/collie-calls`),
      config: yield* read(`${home}/.config/herdr/config.toml`),
      collieDir: `${home}/.collie`,
    };
  });

// Where coreutils is one multi-call binary, `env` runs as whatever it is named; `gnuenv` does not.
const ENV = (await Bun.file("/usr/bin/gnuenv").exists()) ? "/usr/bin/gnuenv" : "/usr/bin/env";
const env = () => Effect.promise(() => Bun.file(ENV).bytes());

test("a signed runner places the release, and setup ends in doctor", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const key = pair();
      yield* machine(dir, yield* env(), (bytes) => signReleaseP256(bytes, key.privateKey));

      yield* install(dir, key.publicKey);
      const again = yield* install(dir, key.publicKey);

      expect(again.code).toBe(0);
      expect(again.placed).toBe(
        `${again.collieDir}/release upgrade\n${again.collieDir}/release upgrade\n`,
      );
      expect(Str.split(again.config, "cego.collie.pick").length - 1).toBe(1);
      expect(again.said).toContain("Keybinding for pick already present");
      expect(again.calls).toContain("chat status-line --install");
      expect(Str.split(Str.trim(again.calls), "\n").at(-1)).toBe("doctor");
    }).pipe(Effect.scoped),
  ));

test("COLLIE_VERSION installs exactly that release", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const key = pair();
      yield* machine(
        dir,
        yield* env(),
        (bytes) => signReleaseP256(bytes, key.privateKey),
        "download/0.40.0",
      );

      const done = yield* install(dir, key.publicKey, { COLLIE_VERSION: "0.40.0" });

      expect(done.code).toBe(0);
      expect(done.placed).toBe(`${done.collieDir}/release upgrade --to 0.40.0\n`);
    }).pipe(Effect.scoped),
  ));

test("a clone in the Collie directory is handed to upgrade to migrate", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const key = pair();
      yield* machine(dir, yield* env(), (bytes) => signReleaseP256(bytes, key.privateKey));
      yield* fs.makeDirectory(`${dir}/home/.collie/.git`, { recursive: true });

      const done = yield* install(dir, key.publicKey);

      expect(done.placed).toBe(`${done.collieDir} upgrade\n`);
    }).pipe(Effect.scoped),
  ));

test("a tampered, unsigned or non-program runner is refused before it runs", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const key = pair();
      const cases = [
        {
          runner: yield* env(),
          sign: (bytes: Uint8Array) => signReleaseP256(bytes, pair().privateKey),
          says: "does not match its signature",
        },
        { runner: yield* env(), sign: null, says: "could not fetch" },
        {
          runner: new TextEncoder().encode("#!/bin/sh\necho hi\n"),
          sign: (bytes: Uint8Array) => signReleaseP256(bytes, key.privateKey),
          says: "is not a program",
        },
      ];
      for (const { runner, sign, says } of cases) {
        const dir = yield* fs.makeTempDirectoryScoped();
        yield* machine(dir, runner, sign);

        const refused = yield* install(dir, key.publicKey);

        expect(refused.code).not.toBe(0);
        expect(refused.said).toContain(says);
        expect(refused.placed).toBe("");
        expect(yield* fs.exists(refused.collieDir)).toBe(false);
        expect(refused.config).toBe("");
      }
    }).pipe(Effect.scoped),
  ));
