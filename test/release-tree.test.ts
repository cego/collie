import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { releaseFiles } from "../tools/release-tree";
import { runEffect } from "./support/effect";

test("the release carries nothing of Herdr 1", () =>
  runEffect(
    Effect.gen(function* () {
      const files = yield* releaseFiles(new URL("../", import.meta.url).pathname);
      expect(files).toContain("install.sh");
      expect(Arr.filter(files, (file) => /herdr/i.test(file))).toEqual([]);
    }),
  ));
