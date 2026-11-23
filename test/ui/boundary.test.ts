import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { runEffect } from "../support/effect";

const uiFiles = Effect.fn("boundary.uiFiles")(function* (predicate: (name: string) => boolean) {
  const fs = yield* FileSystem.FileSystem;
  const names = Arr.filter(yield* fs.readDirectory("src/ui"), predicate);
  return yield* Effect.forEach(names, (name) =>
    Effect.map(fs.readFileString(`src/ui/${name}`), (source) => ({ name, source })),
  );
});

function code(source: string) {
  return Arr.join(
    Arr.filter(
      Str.split(pipe(source, Str.replaceAll(/\/\*[\s\S]*?\*\//g, "")), "\n"),
      (line) => !pipe(Str.trimStart(line), Str.startsWith("//")),
    ),
    "\n",
  );
}

const scanner = new Bun.Transpiler({ loader: "tsx" });
const PURE_EFFECT_HELPERS = new Set([
  "effect/Array",
  "effect/String",
  "effect/Function",
  "effect/Option",
]);

function effectRuntimeImports(source: string) {
  return Arr.filter(
    Arr.map(scanner.scanImports(source), ({ path }) => path),
    (path) =>
      (path === "effect" ||
        pipe(path, Str.startsWith("effect/")) ||
        pipe(path, Str.startsWith("@effect/"))) &&
      !PURE_EFFECT_HELPERS.has(path),
  );
}

test("a wrapped value import counts as one", () => {
  const wrapped = `import {
  Effect,
  Queue,
} from "effect";\n`;
  expect(effectRuntimeImports(wrapped)).toEqual(["effect"]);
  expect(effectRuntimeImports(`import { Effect } from "effect";\n`)).toEqual(["effect"]);
  expect(effectRuntimeImports(`import type {\n  Effect,\n} from "effect";\n`)).toEqual([]);
  expect(effectRuntimeImports(`import { type Effect } from "effect";\n`)).toEqual([]);
  expect(effectRuntimeImports(`import { Effect } from "./effect-helpers";\n`)).toEqual([]);
});

test("views may import pure Effect helpers directly", () => {
  for (const path of PURE_EFFECT_HELPERS)
    expect(effectRuntimeImports(`import * as Helpers from "${path}";`)).toEqual([]);
  // WARNING: a barrel import loads the runtime even when the named export is a pure helper.
  expect(effectRuntimeImports('import { Array } from "effect";')).toEqual(["effect"]);
});

test("runtime imports stay forbidden under aliases, deep paths and dynamic loading", () => {
  for (const path of [
    "effect",
    "effect/Effect",
    "effect/Queue",
    "effect/ManagedRuntime",
    "effect/internal/effect",
    "@effect/platform-bun/BunRuntime",
  ]) {
    expect(effectRuntimeImports(`import * as Runtime from "${path}";`)).toEqual([path]);
    expect(effectRuntimeImports(`import "${path}";`)).toEqual([path]);
    expect(effectRuntimeImports(`const Runtime = import("${path}");`)).toEqual([path]);
  }
});

// WARNING: a component reaching for the Effect runtime puts a second runtime inside the render tree.
test("components import only pure Effect helpers", () =>
  runEffect(
    Effect.gen(function* () {
      const components = yield* uiFiles((n) => pipe(n, Str.endsWith(".tsx")) && n !== "bridge.tsx");
      expect(Arr.map(components, (c) => c.name)).toContain("App.tsx");

      for (const { name, source } of components) {
        expect([name, effectRuntimeImports(source)]).toEqual([name, []]);
      }
    }),
  ));

// WARNING: judged on code only; a comment naming Effect must not fail this check.
test("the state layer holds no Effect", () =>
  runEffect(
    Effect.gen(function* () {
      const [state] = yield* uiFiles((n) => n === "state.ts");
      const source = code(state!.source);
      expect(effectRuntimeImports(state!.source)).toEqual([]);
      expect(source).not.toContain("Effect.");
    }),
  ));
