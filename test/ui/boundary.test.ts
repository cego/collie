import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { runEffect } from "../support/effect";

const uiFiles = Effect.fn("boundary.uiFiles")(function* (predicate: (name: string) => boolean) {
  const fs = yield* FileSystem.FileSystem;
  const names = (yield* fs.readDirectory("src/ui")).filter(predicate);
  return yield* Effect.forEach(names, (name) =>
    Effect.map(fs.readFileString(`src/ui/${name}`), (source) => ({ name, source })),
  );
});

/** The code, without the prose: a comment naming `Effect` is not a use of it. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

/**
 * Every value import of `effect` in a file, by whole statement rather than by line: the
 * formatter wraps a long import over several lines, and a per-line grep called such a
 * file compliant while the component had acquired a direct Effect dependency.
 */
function effectValueImports(source: string): string[] {
  return [...code(source).matchAll(/^import\b[\s\S]*?from\s*"[^"]*";/gm)]
    .map((match) => match[0])
    .filter((statement) => /from\s*"effect/.test(statement))
    .filter((statement) => !/^import\s+type\b/.test(statement));
}

test("a wrapped value import counts as one", () => {
  const wrapped = `import {
  Effect,
  Queue,
} from "effect";\n`;
  expect(effectValueImports(wrapped)).toHaveLength(1);
  expect(effectValueImports(`import { Effect } from "effect";\n`)).toHaveLength(1);
  // Types are erased, so they are not the concern.
  expect(effectValueImports(`import type {\n  Effect,\n} from "effect";\n`)).toEqual([]);
  expect(effectValueImports(`import { Effect } from "./effect-helpers";\n`)).toEqual([]);
});

/**
 * The rule that keeps the app testable: a component reaching for the Effect runtime is
 * the first step back to a screen nobody can test, and it is what puts a second runtime
 * inside the render tree. Type-only imports are erased, so they are not the concern —
 * a value import is.
 */
test("no component imports effect", () =>
  runEffect(
    Effect.gen(function* () {
      const components = yield* uiFiles((n) => n.endsWith(".tsx") && n !== "bridge.tsx");
      expect(components.map((c) => c.name)).toContain("App.tsx");

      for (const { name, source } of components) {
        expect([name, effectValueImports(source)]).toEqual([name, []]);
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
      expect(source).not.toContain('from "effect"');
      expect(source).not.toContain("Effect.");
    }),
  ));
