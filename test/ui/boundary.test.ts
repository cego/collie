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

/** The code, without the prose: a comment naming `Effect` is not a use of it. */
function code(source: string): string {
  return Arr.join(
    Arr.filter(
      Str.split(pipe(source, Str.replace(/\/\*[\s\S]*?\*\//g, "")), "\n"),
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

/** Pure helpers belong in views; runtime modules stay at the bridge. Type imports erase. */
function effectRuntimeImports(source: string): string[] {
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
  // Types are erased, so they are not the concern.
  expect(effectRuntimeImports(`import type {\n  Effect,\n} from "effect";\n`)).toEqual([]);
  expect(effectRuntimeImports(`import { type Effect } from "effect";\n`)).toEqual([]);
  expect(effectRuntimeImports(`import { Effect } from "./effect-helpers";\n`)).toEqual([]);
});

test("views may import pure Effect helpers directly", () => {
  for (const path of PURE_EFFECT_HELPERS)
    expect(effectRuntimeImports(`import * as Helpers from "${path}";`)).toEqual([]);
  // A barrel import also loads the runtime, even when the named export is a pure helper.
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

/**
 * The rule that keeps the app testable: a component reaching for the Effect runtime is
 * the first step back to a screen nobody can test, and it is what puts a second runtime
 * inside the render tree. Pure helpers manipulate the data the view already has.
 */
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

/**
 * The state layer is plain data too — the whole point of it — so the only thing it may
 * take from the rest of the program is types and constants, never a service. Judged on
 * the code rather than the whole file: this used to grep the prose too, and a comment
 * explaining the rule was enough to fail it.
 */
test("the state layer holds no Effect", () =>
  runEffect(
    Effect.gen(function* () {
      const [state] = yield* uiFiles((n) => n === "state.ts");
      const source = code(state!.source);
      expect(effectRuntimeImports(state!.source)).toEqual([]);
      expect(source).not.toContain("Effect.");
    }),
  ));
