// The Rune spike's bundle (desktop-rune/scripts/bundle.ts): the main process compiled so the
// bundle needs no Bun, each OS's layout and update files, and how macOS signs it.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { describe, expect, test } from "bun:test";
import { Effect, FileSystem, Option, Schema, Stream } from "effect";
import {
  assemble,
  compileCore,
  macSignings,
  notarizeArgs,
  type Os,
} from "../desktop-rune/scripts/bundle";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";

const VERSION = "0.130.0";
const BASE_URL = "https://github.com/cego/collie/releases/latest/download";

const Frame = Schema.fromJsonString(
  Schema.Struct({ _tag: Schema.String, requestId: Schema.optional(Schema.String) }),
);

describe.skipIf(process.platform !== "linux")("the compiled main process", () => {
  test(
    "answers the shell over stdio after its Hello, with a fake bridge for collie",
    () =>
      runEffect(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-core-" });
          yield* compileCore(`${dir}/collie-core`);
          // `collie bridge` as Desktop starts it: it never answers, so no Machine is reached.
          yield* fs.writeFileString(`${dir}/fake-bridge`, "#!/bin/sh\nexec cat >/dev/null\n");
          yield* fs.chmod(`${dir}/fake-bridge`, 0o755);
          const core = yield* Effect.acquireRelease(
            Effect.sync(() =>
              Bun.spawn([`${dir}/collie-core`], {
                env: {
                  PATH: "/usr/bin:/bin",
                  HOME: dir,
                  SHELL: "/bin/sh",
                  XDG_STATE_HOME: `${dir}/state`,
                  COLLIE_RUNE_USER_DATA: `${dir}/data`,
                  COLLIE_DESKTOP_COLLIE: `["${dir}/fake-bridge"]`,
                },
                stdin: "pipe",
                stdout: "pipe",
                stderr: "ignore",
              }),
            ),
            (child) => Effect.sync(() => child.kill("SIGKILL")),
          );
          void core.stdin.write('{"_tag":"Hello"}\n');
          void core.stdin.write(
            '{"_tag":"Request","id":"0","tag":"syncNow","payload":{"profile":"nobody"},"headers":[]}\n',
          );
          void core.stdin.flush();
          const answer = yield* Stream.fromReadableStream({
            evaluate: () => core.stdout,
            onError: String,
          }).pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.mapEffect((line) => Schema.decodeEffect(Frame)(line)),
            Stream.filter((frame) => frame._tag === "Exit"),
            Stream.runHead,
            Effect.timeout("60 seconds"),
          );
          expect(Option.getOrUndefined(answer)).toEqual({ _tag: "Exit", requestId: "0" });
        }),
      ),
    120_000,
  );
});

/** Every file under `dir`, relative to it, sorted. */
const filesUnder = (dir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const entries = yield* fs.readDirectory(dir, { recursive: true });
    const files = yield* Effect.filter(entries, (entry) =>
      Effect.map(fs.stat(`${dir}/${entry}`), (info) => info.type === "File"),
    );
    return Arr.sort(files, Str.Order);
  });

const built = (os: Os, arch: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-bundle-" });
    yield* fs.writeFileString(`${dir}/shell`, "the Rust shell");
    yield* fs.writeFileString(`${dir}/core`, "the compiled main process");
    yield* fs.writeFileString(`${dir}/icon`, "an icon");
    yield* fs.writeFileString(`${dir}/manager`, "the legacy install manager");
    const out = `${dir}/dist`;
    yield* assemble({
      out,
      os,
      arch,
      shell: `${dir}/shell`,
      core: `${dir}/core`,
      icon: `${dir}/icon`,
      manager: `${dir}/manager`,
      version: VERSION,
      baseUrl: BASE_URL,
    });
    return out;
  });

const tarList = (archive: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-tar-" });
    yield* fs.writeFile(`${dir}/payload.tar`, Bun.zstdDecompressSync(yield* fs.readFile(archive)));
    const listed = yield* exec(["tar", "-tf", `${dir}/payload.tar`]);
    return pipe(listed.stdout, Str.trim, Str.split("\n"));
  });

const Manifest = Schema.fromJsonString(
  Schema.Struct({
    schemaVersion: Schema.Literal(1),
    identifier: Schema.String,
    channel: Schema.String,
    platform: Schema.String,
    arch: Schema.String,
    version: Schema.String,
    hash: Schema.String,
    artifact: Schema.Struct({ file: Schema.String }),
  }),
);
const VersionJson = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    displayName: Schema.String,
    version: Schema.String,
    channel: Schema.String,
    identifier: Schema.String,
    baseUrl: Schema.String,
    hash: Schema.String,
  }),
);

test("stable updates retain the old app identity, metadata and launcher paths", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const os of ["linux", "macos"] as const) {
        const arch = os === "linux" ? "x64" : "arm64";
        const out = yield* built(os, arch);
        const manifest = yield* fs.readFileString(
          `${out}/artifacts/stable-${os}-${arch}-update.json`,
        );
        expect(yield* Schema.decodeEffect(Manifest)(manifest)).toMatchObject({
          schemaVersion: 1,
          identifier: "dk.cego.collie.desktop",
          channel: "stable",
          platform: os,
          arch,
        });
        const bundle = `${out}/build/${os}-${arch}/collie-desktop${os === "macos" ? ".app" : ""}`;
        const resources = os === "macos" ? "Contents/Resources" : "Resources";
        const executable = os === "macos" ? "Contents/MacOS/launcher" : "bin/launcher";
        expect(yield* fs.readFileString(`${bundle}/${executable}`)).toBe("the Rust shell");
        expect(
          yield* Schema.decodeEffect(VersionJson)(
            yield* fs.readFileString(`${bundle}/${resources}/version.json`),
          ),
        ).toMatchObject({
          name: "collie-desktop",
          displayName: "Collie",
          identifier: "dk.cego.collie.desktop",
          version: VERSION,
        });
      }
    }),
  ));

test("a Linux bundle is the shell, the compiled main process, its icon, launcher entry and version, beside its update files", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const out = yield* built("linux", "x64");
      expect(yield* filesUnder(out)).toEqual(
        Arr.sort(
          [
            "artifacts/stable-linux-x64-collie-desktop.tar.zst",
            "artifacts/stable-linux-x64-update.json",
            "build/linux-x64/collie-desktop/bin/collie-core",
            "build/linux-x64/collie-desktop/bin/launcher",
            "build/linux-x64/collie-desktop/collie-desktop.desktop",
            "build/linux-x64/collie-desktop/Resources/appIcon.png",
            "build/linux-x64/collie-desktop/Resources/uninstall",
            "build/linux-x64/collie-desktop/Resources/version.json",
          ],
          Str.Order,
        ),
      );
      const bundle = `${out}/build/linux-x64/collie-desktop`;
      for (const binary of ["bin/launcher", "bin/collie-core"])
        expect(((yield* fs.stat(`${bundle}/${binary}`)).mode & 0o111) !== 0).toBe(true);
      const entry = yield* fs.readFileString(`${bundle}/collie-desktop.desktop`);
      expect(entry).toContain("Name=Collie\n");
      expect(entry).toContain("Exec=collie-desktop\n");
      const version = yield* Schema.decodeEffect(VersionJson)(
        yield* fs.readFileString(`${bundle}/Resources/version.json`),
      );
      expect(version).toMatchObject({ version: VERSION, channel: "stable", baseUrl: BASE_URL });
      const manifest = yield* Schema.decodeEffect(Manifest)(
        yield* fs.readFileString(`${out}/artifacts/stable-linux-x64-update.json`),
      );
      expect(manifest).toEqual({
        schemaVersion: 1,
        identifier: version.identifier,
        channel: "stable",
        platform: "linux",
        arch: "x64",
        version: VERSION,
        hash: version.hash,
        artifact: { file: "stable-linux-x64-collie-desktop.tar.zst" },
      });
      expect(version.hash).toMatch(/^[a-z0-9]{1,13}$/);
      const tarred = yield* tarList(`${out}/artifacts/stable-linux-x64-collie-desktop.tar.zst`);
      expect(Arr.every(tarred, Str.startsWith("collie-desktop/"))).toBe(true);
      expect(tarred).toContain("collie-desktop/bin/launcher");
    }),
  ));

test("a macOS bundle is collie-desktop.app with both executables, its icon, version and Info.plist, beside its update files", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const out = yield* built("macos", "arm64");
      expect(yield* filesUnder(out)).toEqual(
        Arr.sort(
          [
            "artifacts/stable-macos-arm64-collie-desktop.app.tar.zst",
            "artifacts/stable-macos-arm64-update.json",
            "build/macos-arm64/collie-desktop.app/Contents/Info.plist",
            "build/macos-arm64/collie-desktop.app/Contents/MacOS/collie-core",
            "build/macos-arm64/collie-desktop.app/Contents/MacOS/launcher",
            "build/macos-arm64/collie-desktop.app/Contents/Resources/Collie.icns",
            "build/macos-arm64/collie-desktop.app/Contents/Resources/uninstall",
            "build/macos-arm64/collie-desktop.app/Contents/Resources/version.json",
          ],
          Str.Order,
        ),
      );
      const plist = yield* fs.readFileString(
        `${out}/build/macos-arm64/collie-desktop.app/Contents/Info.plist`,
      );
      for (const [key, value] of [
        ["CFBundleName", "Collie"],
        ["CFBundleExecutable", "launcher"],
        ["CFBundleIconFile", "Collie"],
        ["CFBundleShortVersionString", VERSION],
      ])
        expect(plist).toContain(`<key>${key}</key><string>${value}</string>`);
      const tarred = yield* tarList(
        `${out}/artifacts/stable-macos-arm64-collie-desktop.app.tar.zst`,
      );
      expect(Arr.every(tarred, Str.startsWith("collie-desktop.app/"))).toBe(true);
      expect(tarred).toContain("collie-desktop.app/Contents/MacOS/launcher");
    }),
  ));

const ENTITLEMENTS = "/tmp/entitlements.plist";
const APP = "/dist/build/macos-arm64/collie-desktop.app";

test("macOS signs each executable, then the app, with the Developer ID, the hardened runtime, a timestamp and Desktop's entitlements", () => {
  const identity = "Developer ID Application: Cego A/S (TEAM123456)";
  const signed = (path: string) => [
    "--force",
    "--timestamp",
    "--options",
    "runtime",
    "--entitlements",
    ENTITLEMENTS,
    "--sign",
    identity,
    path,
  ];
  expect(macSignings({ ELECTROBUN_DEVELOPER_ID: identity }, ENTITLEMENTS, APP)).toEqual([
    signed(`${APP}/Contents/MacOS/collie-core`),
    signed(`${APP}/Contents/MacOS/launcher`),
    signed(APP),
  ]);
});

test("macOS signs ad hoc where no identity is set, still with the hardened runtime and entitlements", () => {
  const adHoc = (path: string) => [
    "--force",
    "--options",
    "runtime",
    "--entitlements",
    ENTITLEMENTS,
    "--sign",
    "-",
    path,
  ];
  const expected = [
    adHoc(`${APP}/Contents/MacOS/collie-core`),
    adHoc(`${APP}/Contents/MacOS/launcher`),
    adHoc(APP),
  ];
  expect(macSignings({}, ENTITLEMENTS, APP)).toEqual(expected);
  expect(macSignings({ ELECTROBUN_DEVELOPER_ID: "-" }, ENTITLEMENTS, APP)).toEqual(expected);
});

test("macOS notarises with the release's Apple ID or API key secrets, and not ad hoc", () => {
  const id = "Developer ID Application: Cego A/S (TEAM123456)";
  expect(
    notarizeArgs(
      {
        ELECTROBUN_DEVELOPER_ID: id,
        ELECTROBUN_APPLEID: "ci@cego.dk",
        ELECTROBUN_APPLEIDPASS: "app-password",
        ELECTROBUN_TEAMID: "TEAM123456",
      },
      "/dist/Collie.zip",
    ),
  ).toEqual([
    "notarytool",
    "submit",
    "/dist/Collie.zip",
    "--wait",
    "--apple-id",
    "ci@cego.dk",
    "--password",
    "app-password",
    "--team-id",
    "TEAM123456",
  ]);
  expect(
    notarizeArgs(
      {
        ELECTROBUN_DEVELOPER_ID: id,
        ELECTROBUN_APPLEAPIKEY: "KEY123",
        ELECTROBUN_APPLEAPIISSUER: "issuer-uuid",
        ELECTROBUN_APPLEAPIKEYPATH: "/tmp/AuthKey.p8",
      },
      "/dist/Collie.zip",
    ),
  ).toEqual([
    "notarytool",
    "submit",
    "/dist/Collie.zip",
    "--wait",
    "--key",
    "/tmp/AuthKey.p8",
    "--key-id",
    "KEY123",
    "--issuer",
    "issuer-uuid",
  ]);
  expect(notarizeArgs({ ELECTROBUN_DEVELOPER_ID: "-" }, "/dist/Collie.zip")).toBeNull();
  expect(notarizeArgs({ ELECTROBUN_DEVELOPER_ID: id }, "/dist/Collie.zip")).toBeNull();
});
