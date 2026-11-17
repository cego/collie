import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { releaseVersion } from "../src/release";
import { runEffect } from "./support/effect";

test.each([
  [undefined, ""],
  ['{"name":"collie","version":"1.2.3","dependencies":{"effect":"4"}}', "1.2.3"],
  ['{"name":"collie"}', ""],
  ['{"version":123}', ""],
  ["{broken", ""],
] as const)("release version reads package.json: %s", (contents, expected) =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "collie-version-" });
      yield* fs.writeFileString(`${root}/herdr-plugin.toml`, 'version = "9.9.9"\n');
      if (contents !== undefined) yield* fs.writeFileString(`${root}/package.json`, contents);
      expect(yield* releaseVersion(root)).toBe(expected);
    }),
  ),
);
