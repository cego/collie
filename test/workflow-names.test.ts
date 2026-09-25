// No shipped workflow is privileged: the generic runtime and the board never decide what
// to do by a workflow's name. A module composes by id — plan starts `implement`, a review
// offers it — and that is ordinary; `src/` choosing a checkout, a card or a tab because a
// Run is called `plan` or `renovate` is what this refuses. The renamed baselines prove the
// behaviour; this reads the source, so a reintroduction fails before anything runs it.

import { Effect, FileSystem, Path } from "effect";
import { expect, test } from "bun:test";
import { runEffect } from "./support/effect";

const srcDir = new URL("../src/", import.meta.url).pathname;

const SHIPPED = "plan|implement|review|architecture|renovate";
/** `plan` and `review` are also outcome kinds and board tabs; these three are only ids. */
const ONLY_IDS = new Set(["implement", "architecture", "renovate"]);
/** An expression that names a workflow rather than an outcome, a tab or a need. */
const IDENTITY = /(workflow|definition|entry|module)\w*|\.(id|name)\b/i;

const withoutComments = (text: string) =>
  text.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/(^|[^:])\/\/.*$/gm, "$1");

/** Every place in one source file that decides by a shipped workflow's name. */
function nameDispatch(source: string): string[] {
  const text = withoutComments(source);
  const found: string[] = [];
  const compared = new RegExp(
    String.raw`([\w.?()\[\]]+)\s*[!=]==?\s*"(${SHIPPED})"|"(${SHIPPED})"\s*[!=]==?\s*([\w.?()\[\]]+)`,
    "g",
  );
  for (const match of text.matchAll(compared)) {
    if (IDENTITY.test(match[1] ?? match[4] ?? "")) found.push(match[0]);
  }
  for (const match of text.matchAll(
    new RegExp(String.raw`\.(startsWith|endsWith)\("(${SHIPPED})`, "g"),
  ))
    found.push(match[0]);
  const listed = new RegExp(
    String.raw`\[\s*"(?:${SHIPPED})"(?:\s*,\s*"(?:${SHIPPED})")*\s*,?\s*\]`,
    "g",
  );
  for (const match of text.matchAll(listed)) {
    if ([...match[0].matchAll(/"(\w+)"/g)].some((name) => ONLY_IDS.has(name[1]!)))
      found.push(match[0]);
  }
  for (const match of text.matchAll(/switch\s*\(([^)]*)\)\s*\{/g)) {
    if (!IDENTITY.test(match[1]!)) continue;
    let depth = 0;
    let end = match.index + match[0].length - 1;
    for (; end < text.length; end++) {
      if (text[end] === "{") depth += 1;
      if (text[end] === "}" && --depth === 0) break;
    }
    const body = text.slice(match.index, end);
    for (const one of body.matchAll(new RegExp(String.raw`case\s+"(${SHIPPED})"`, "g")))
      found.push(`switch (${match[1]}) ${one[0]}`);
  }
  return found;
}

const sources = Effect.fn("test.sources")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const found: Array<{ name: string; text: string }> = [];
  const stack = [srcDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const name of yield* fs.readDirectory(dir)) {
      const full = path.join(dir, name);
      if ((yield* fs.stat(full)).type === "Directory") {
        stack.push(full);
        continue;
      }
      if (!name.endsWith(".ts") && !name.endsWith(".tsx")) continue;
      found.push({ name: path.relative(srcDir, full), text: yield* fs.readFileString(full) });
    }
  }
  return found;
});

const read = (file: string) =>
  FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.readFileString(`${srcDir}${file}`)));

test("the generic runtime and the board decide nothing by a shipped workflow's name", () =>
  runEffect(
    Effect.gen(function* () {
      const found = (yield* sources()).flatMap((file) =>
        nameDispatch(file.text).map((hit) => `${file.name}: ${hit}`),
      );
      expect(found).toEqual([]);
    }),
  ));

test("the guard catches the name-based plan and renovate classification Collie used to have", () =>
  runEffect(
    Effect.gen(function* () {
      const board = yield* read("board.ts");
      const worktree = yield* read("worktree.ts");
      expect(nameDispatch(board)).toEqual([]);
      expect(nameDispatch(worktree)).toEqual([]);

      // Each of these once decided a card or a checkout, planted back into the file it lived in.
      const planted = [
        [board, `const planReady = status === "succeeded" && record.workflow === "plan";`],
        [board, `const PRODUCES_WORK: ReadonlySet<string> = new Set(["implement", "plan"]);`],
        [worktree, `const MUTATING = new Set(["implement", "renovate"]);`],
        [worktree, `const ROAMING = new Set(["renovate"]);`],
        [worktree, `if (run.workflow !== "renovate") return null;`],
        [
          board,
          `switch (view.workflow) {\n  case "plan":\n    return "Plan ready to implement.";\n}`,
        ],
        [board, `if (step.id.startsWith("review")) return "review";`],
      ] as const;
      for (const [file, line] of planted) {
        expect([line, nameDispatch(`${file}\n${line}\n`).length > 0]).toEqual([line, true]);
      }
    }),
  ));

test("composing by id, and deciding by an outcome, a need or a tab, is not dispatch", () => {
  expect(
    nameDispatch(`
      yield* children.start({ invocation: "implement", workflow: "implement", input });
      const offers = [{ id: "fix-open", workflow: "implement", needs: ["findings"] }];
      const metadata = { outcome: { fixed: "plan" } };
      if (kind !== "investigation" && kind !== "plan" && kind !== "review") return true;
      if (tab() === "review") return truncated(detail?.review);
      if (work?.kind === "review") return reviewed;
      switch (need) { case "plan": return facts.planIssues > 0; }
      // a comment that says workflow === "plan" is prose, not code
    `),
  ).toEqual([]);
});
