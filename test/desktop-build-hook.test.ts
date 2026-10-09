// Electrobun's build hook names the Linux launcher entry and macOS bundle Collie.

import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import { root } from "./support/host";

const hook = (os: string, entry: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-hook-" });
    yield* fs.makeDirectory(`${dir}/collie-desktop`);
    if (entry) {
      if (os === "macos") {
        yield* fs.makeDirectory(`${dir}/collie-desktop.app/Contents`, { recursive: true });
        yield* fs.writeFileString(
          `${dir}/collie-desktop.app/Contents/Info.plist`,
          "<plist><dict><key>CFBundleName</key><string>collie-desktop</string></dict></plist>",
        );
      } else {
        yield* fs.writeFileString(
          `${dir}/collie-desktop/collie-desktop.desktop`,
          "[Desktop Entry]\nName=collie-desktop\n",
        );
      }
    }
    const ran = yield* exec([process.execPath, `${root}desktop/scripts/name-desktop-entry.ts`], {
      env: {
        PATH: Bun.env.PATH ?? "/usr/bin:/bin",
        ELECTROBUN_BUILD_DIR: dir,
        ELECTROBUN_APP_NAME: "collie-desktop",
        ELECTROBUN_OS: os,
      },
    });
    return ran.exitCode;
  }).pipe(Effect.scoped);

test("a Linux build that lost its desktop entry fails", () =>
  runEffect(Effect.map(hook("linux", false), (code) => expect(code).not.toBe(0))));

test("a Linux build with its entry passes", () =>
  runEffect(Effect.map(hook("linux", true), (code) => expect(code).toBe(0))));

test("a macOS build that lost its app bundle fails", () =>
  runEffect(Effect.map(hook("macos", false), (code) => expect(code).not.toBe(0))));

test("a macOS build with its app bundle passes", () =>
  runEffect(Effect.map(hook("macos", true), (code) => expect(code).toBe(0))));
