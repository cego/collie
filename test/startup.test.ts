// What a start loads before its first line runs. Every `collie`, hook and board start pays
// for it, and the compaction helper starts on every status line and every prompt a Claude
// agent submits.

import { expect, test } from "bun:test";
import { Effect, FileSystem, Path } from "effect";
import { runEffect } from "./support/effect";

const src = new URL("../src/", import.meta.url).pathname;
const scanners = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
};

/** Everything loading `entry` loads first: its static imports, all the way down. */
const loads = (entry: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const loaded = new Set<string>();
    const pending = [`${src}${entry}`];
    while (pending.length > 0) {
      const file = pending.pop()!;
      if (loaded.has(file)) continue;
      loaded.add(file);
      const scanner = file.endsWith(".tsx") ? scanners.tsx : scanners.ts;
      for (const { kind, path: spec } of scanner.scanImports(yield* fs.readFileString(file))) {
        if (kind !== "import-statement") continue;
        if (spec.startsWith(".")) pending.push(Bun.resolveSync(spec, path.dirname(file)));
        else loaded.add(spec);
      }
    }
    return [...loaded].map((one) => one.replace(src, "src/"));
  });

test("the entry point loads none of Collie's modules before it knows which front door runs", () =>
  runEffect(
    Effect.gen(function* () {
      const own = (yield* loads("main.ts")).filter((one) => one.startsWith("src/"));
      expect(own).toEqual(["src/main.ts"]);
    }),
  ));

test("the compaction helper loads neither the engine nor the board", () =>
  runEffect(
    Effect.gen(function* () {
      const heavy = (yield* loads("compactors.ts")).filter((one) =>
        /^src\/(engine\.ts|ui\/)|^effect\/unstable\/(cluster|sql|workflow)|^@opentui\//.test(one),
      );
      expect(heavy).toEqual([]);
    }),
  ));
