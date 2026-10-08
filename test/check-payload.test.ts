// The release build's check on Desktop's installer: Electrobun's self-extractor cannot read
// a GNU long-name tar entry, so a payload with any path over 100 characters never ships.

import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";

/** Owner and group zeroed, in each tar's flags: a large UID does not fit a USTAR header. */
const flavour = async (format: string) => {
  const bsd = (await Bun.$`tar --version`.text()).includes("bsdtar");
  return bsd
    ? [`--format=${format === "gnu" ? "gnutar" : format}`, "--uid", "0", "--gid", "0"]
    : [`--format=${format}`, "--owner=0", "--group=0"];
};

/** An installer as Electrobun lays one out: the extractor, its marker, then the zstd tar. */
const installerWith = (dir: string, paths: ReadonlyArray<string>, format = "gnu") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const tree = `${dir}/tree`;
    for (const path of paths) {
      yield* fs.makeDirectory(`${tree}/${path}`.replace(/\/[^/]*$/, ""), { recursive: true });
      yield* fs.writeFileString(`${tree}/${path}`, "x");
    }
    const flags = yield* Effect.promise(() => flavour(format));
    const made = yield* exec(["tar", ...flags, "-cf", `${dir}/payload.tar`, "-C", tree, "."]);
    expect(made.exitCode).toBe(0);
    const tar = yield* fs.readFile(`${dir}/payload.tar`);
    const installer = `${dir}/installer`;
    yield* fs.writeFile(
      installer,
      new Uint8Array([
        ...new TextEncoder().encode("#!extractor ELECTROBUN_ARCHIVE_V1 in its own code\n"),
        ...new TextEncoder().encode("ELECTROBUN_ARCHIVE_V1"),
        ...Bun.zstdCompressSync(tar),
      ]),
    );
    return installer;
  });

const check = (installer: string) =>
  exec(["bun", "run", `${import.meta.dir}/../tools/check-payload.ts`, installer]).pipe(
    Effect.map((done) => ({ code: done.exitCode, said: done.stdout + done.stderr })),
  );

test("an installer whose every path fits in a tar header passes", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const installer = yield* installerWith(dir, [
        "Resources/app/views/index.html",
        "bin/launcher",
      ]);
      const done = yield* check(installer);
      expect(done.code).toBe(0);
    }).pipe(Effect.scoped),
  ));

test("an installer with a path over 100 characters is refused, naming the path", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const long = `Resources/app/views/_nuxt/${"a".repeat(90)}.js`;
      const installer = yield* installerWith(dir, ["bin/launcher", long]);
      const done = yield* check(installer);
      expect(done.code).not.toBe(0);
      expect(done.said).toContain(long);
    }).pipe(Effect.scoped),
  ));

test("an installer whose tar carries pax headers is refused", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const installer = yield* installerWith(dir, [`bin/${"b".repeat(120)}`], "pax");
      const done = yield* check(installer);
      expect(done.code).not.toBe(0);
      expect(done.said).toContain("a pax header");
    }).pipe(Effect.scoped),
  ));

test("a macOS update archive is checked as the tar it is, with no installer around it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const long = `collie-desktop.app/Contents/Resources/${"a".repeat(90)}.js`;
      yield* installerWith(dir, ["collie-desktop.app/Contents/MacOS/launcher", long], "ustar");
      const archive = `${dir}/stable-macos-arm64-collie-desktop.app.tar.zst`;
      yield* fs.writeFile(archive, Bun.zstdCompressSync(yield* fs.readFile(`${dir}/payload.tar`)));
      const done = yield* check(archive);
      expect(done.code).not.toBe(0);
      expect(done.said).toContain(long);
    }).pipe(Effect.scoped),
  ));
