// A test against an installed harness runs only through `bun run test:live`, so a file of
// them the script does not name would never run anywhere.

import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Schema } from "effect";
import { runEffect } from "./support/effect";

const Scripts = Schema.fromJsonString(
  Schema.Struct({ scripts: Schema.Struct({ "test:live": Schema.String }) }),
);

test("test:live runs every file that holds a test against an installed harness", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = `${import.meta.dir}/..`;
      const script = (yield* Schema.decodeEffect(Scripts)(
        yield* fs.readFileString(`${root}/package.json`),
      )).scripts["test:live"];
      const holding: string[] = [];
      for (const name of yield* fs.readDirectory(`${root}/test`)) {
        if (!pipe(name, Str.endsWith(".test.ts"))) continue;
        const text = yield* fs.readFileString(`${root}/test/${name}`);
        if (/import \{[^}]*\bonMachineWith\b[^}]*\} from "\.\/support\/live"/.test(text))
          holding.push(`test/${name}`);
      }
      expect(holding.length).toBeGreaterThan(0);
      expect(Arr.filter(holding, (file) => !Str.split(script, " ").includes(file))).toEqual([]);
    }),
  ));
