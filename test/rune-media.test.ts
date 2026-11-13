import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import {
  bundleLinuxMedia,
  MEDIA_PLUGINS,
  mediaDependencies,
} from "../desktop-rune/scripts/linux-media";
import { shell } from "../src/mr";
import { runEffect } from "./support/effect";
import * as Arr from "effect/Array";
import * as Str from "effect/String";

test.skipIf(process.platform !== "linux")(
  "the Linux media bundle contains its private plugins, dependency closure, scanner and notices",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-media-" });
        yield* fs.makeDirectory(`${dir}/bin`);
        yield* fs.copyFile("/usr/bin/true", `${dir}/bin/launcher`);
        const libdir = yield* shell("pkg-config", ["--variable=libdir", "gstreamer-1.0"], dir);
        const scanner = yield* shell(
          "pkg-config",
          ["--variable=pluginscannerdir", "gstreamer-1.0"],
          dir,
        );
        expect(libdir.code).toBe(0);
        yield* bundleLinuxMedia(
          dir,
          Str.trim(libdir.stdout),
          `${Str.trim(scanner.stdout)}/gst-plugin-scanner`,
        );
        expect((yield* fs.readDirectory(`${dir}/lib/gstreamer-1.0`)).sort()).toEqual(
          Arr.map(MEDIA_PLUGINS, (name) => `libgst${name}.so`).sort(),
        );
        expect(yield* fs.exists(`${dir}/lib/libgstreamer-1.0.so.0`)).toBe(true);
        expect(yield* fs.exists(`${dir}/libexec/gst-plugin-scanner`)).toBe(true);
        const scanned = yield* shell(`${dir}/libexec/gst-plugin-scanner`, [], dir, {
          LD_DEBUG: "libs",
        });
        expect(scanned.stderr).toContain(`calling init: ${dir}/lib/libgstreamer-1.0.so.0`);
        expect((yield* fs.readDirectory(`${dir}/Resources/media-licenses`)).length).toBeGreaterThan(
          3,
        );
      }),
    ),
  120_000,
);

test("dependency resolution refuses missing libraries and leaves libc to the target system", () => {
  expect(
    mediaDependencies(
      "libcodec.so.1 => /lib/libcodec.so.1 (0x123)\nlibc.so.6 => /lib/libc.so.6 (0x12)\n/lib64/ld-linux-x86-64.so.2 (0x12)\n",
    ),
  ).toEqual(["/lib/libcodec.so.1"]);
  expect(() => mediaDependencies("libcodec.so.1 => not found\n")).toThrow("unresolved");
});
