import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Path } from "effect";
import { runEffect } from "./support/effect";
import { forgesImportsIn } from "./support/forges-imports";

const ADAPTER = new Map([
  ["src/forge/gitlab.ts", "glab"],
  ["src/forge/github.ts", "gh"],
  ["src/forge/gitlab-checks.ts", "glab"],
  ["src/forge/github-checks.ts", "gh"],
]);

const ALLOWED = new Map([["src/onboard.ts", "permanent"]]);

const INVOKES =
  /(["'])(glab|gh)\1|["'`](glab|gh) (?:mr|pr|api|auth|repo|issue|ci|release|run|workflow)\b/g;
const NAMES = /\b(glab|gh)\b/g;

const matcherOf = (file: string) =>
  /^(src|workflows)\/.*\.tsx?$/.test(file)
    ? INVOKES
    : /^workflows\/.*\.md$/.test(file)
      ? NAMES
      : null;

const CONTENT_FOR = /\.(gitlab|github)\.md$/;
const CLI_OF = new Map([
  ["gitlab", "glab"],
  ["github", "gh"],
]);

const allowedIn = (file: string) => {
  const forge = CONTENT_FOR.exec(file)?.[1];
  return ADAPTER.get(file) ?? (forge === undefined ? undefined : CLI_OF.get(forge));
};

const scan = Effect.fn("boundary.scan")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.dirname(yield* path.fromFileUrl(new URL("./", import.meta.url)));
  const found = new Map<string, Set<string>>();
  for (const dir of ["src", "workflows"]) {
    for (const entry of yield* fs.readDirectory(path.join(root, dir), { recursive: true })) {
      const file = `${dir}/${entry}`;
      const matcher = matcherOf(file);
      if (matcher === null) continue;
      const text = yield* fs.readFileString(path.join(root, file));
      const clis = new Set(
        Arr.map([...pipe(text, Str.matchAll(matcher))], (m) => m[2] ?? m[3] ?? m[1] ?? ""),
      );
      if (clis.size > 0) found.set(file, clis);
    }
  }
  return found;
});

const straysIn = (found: ReadonlyMap<string, ReadonlySet<string>>) =>
  Arr.flatMap([...found], ([file, clis]) =>
    Arr.map(
      Arr.filter([...clis], (cli) => allowedIn(file) !== cli && !ALLOWED.has(file)),
      (cli) => `${file} runs ${cli}`,
    ),
  );

test("glab and gh are run only by their adapters, and only the allowlist still runs either", () =>
  runEffect(
    Effect.gen(function* () {
      expect(straysIn(yield* scan())).toEqual([]);
    }),
  ));

test("a content file for one forge that names the other forge's CLI is a stray", () => {
  expect(
    straysIn(
      new Map([
        ["workflows/renovate.github.md", new Set(["gh", "glab"])],
        ["workflows/renovate.gitlab.md", new Set(["glab", "gh"])],
        ["workflows/implement.md", new Set(["gh"])],
      ]),
    ),
  ).toEqual([
    "workflows/renovate.github.md runs glab",
    "workflows/renovate.gitlab.md runs gh",
    "workflows/implement.md runs gh",
  ]);
});

test("every allowlisted file still runs a forge CLI, so a moved one leaves the list", () =>
  runEffect(
    Effect.gen(function* () {
      const found = yield* scan();
      expect(Arr.filter([...ALLOWED.keys()], (file) => !found.has(file))).toEqual([]);
    }),
  ));

test("only the forge directory imports forges", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = path.dirname(yield* path.fromFileUrl(new URL("./", import.meta.url)));
      const files = new Map<string, string>();
      for (const dir of ["src", "workflows"])
        for (const entry of yield* fs.readDirectory(path.join(root, dir), { recursive: true }))
          if (/\.tsx?$/.test(entry))
            files.set(`${dir}/${entry}`, yield* fs.readFileString(path.join(root, dir, entry)));
      expect(forgesImportsIn(files)).toEqual([]);
    }),
  ));

test("a forges import outside the forge directory is a stray, however it is written", () => {
  expect(
    forgesImportsIn(
      new Map([
        ["src/forge/http.ts", 'import type { ForgeProvider } from "forges";'],
        ["src/ci-job.ts", 'import { github } from "forges/github";'],
        ["src/mr.ts", "const lib = await import('forges');"],
        ["src/outside.ts", 'import "forges";'],
        ["src/another.ts", "import 'forges/github';"],
        ["src/forge/side-effect.ts", 'import "forges";'],
        ["workflows/release.workflow.ts", 'import type { FetchLike } from "forges";'],
        ["src/other.ts", 'import { forgesFromThere } from "./forges-helper";'],
      ]),
    ),
  ).toEqual([
    "src/ci-job.ts imports forges",
    "src/mr.ts imports forges",
    "src/outside.ts imports forges",
    "src/another.ts imports forges",
    "workflows/release.workflow.ts imports forges",
  ]);
});
