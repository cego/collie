import { expect, test } from "bun:test";
import { Effect, FileSystem, Path } from "effect";
import { runEffect } from "./support/effect";
import { forgesImportsIn } from "./support/forges-imports";

// ADR-0050 D1: `glab` is run only by the GitLab adapter and `gh` only by the GitHub one,
// and no workflow's content names either.

const ADAPTER = new Map([
  ["src/forge/gitlab.ts", "glab"],
  ["src/forge/github.ts", "gh"],
  ["src/forge/gitlab-checks.ts", "glab"],
  ["src/forge/github-checks.ts", "gh"],
]);

/** Files outside the adapters that reach a forge's CLI themselves, and why. */
const ALLOWED = new Map([
  // Permanent (ADR-0050 D1): onboarding's GitLab login and SSH key.
  ["src/onboard.ts", "permanent"],
]);

/** A command a TypeScript file runs: the CLI as an argument, or a command line in a string. */
const INVOKES =
  /(["'])(glab|gh)\1|["'`](glab|gh) (?:mr|pr|api|auth|repo|issue|ci|release|run|workflow)\b/g;
/** Workflow content that names a CLI at all. */
const NAMES = /\b(glab|gh)\b/g;

const matcherOf = (file: string) =>
  /^(src|workflows)\/.*\.tsx?$/.test(file)
    ? INVOKES
    : /^workflows\/.*\.md$/.test(file)
      ? NAMES
      : null;

/** A content file written for one forge (ADR-0050 D1): `<name>.gitlab.md` or `<name>.github.md`. */
const CONTENT_FOR = /\.(gitlab|github)\.md$/;
const CLI_OF = new Map([
  ["gitlab", "glab"],
  ["github", "gh"],
]);

/** The CLI a file may run or name: its adapter's, or its content's forge's. */
const allowedIn = (file: string) => {
  const forge = CONTENT_FOR.exec(file)?.[1];
  return ADAPTER.get(file) ?? (forge === undefined ? undefined : CLI_OF.get(forge));
};

/** Each file under `src/` and `workflows/` that runs or names a forge CLI, and which. */
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
      const clis = new Set([...text.matchAll(matcher)].map((m) => m[2] ?? m[3] ?? m[1] ?? ""));
      if (clis.size > 0) found.set(file, clis);
    }
  }
  return found;
});

/** Each CLI a file runs or names that neither its adapter, its forge nor the allowlist lets it. */
const straysIn = (found: ReadonlyMap<string, ReadonlySet<string>>) =>
  [...found].flatMap(([file, clis]) =>
    [...clis]
      .filter((cli) => allowedIn(file) !== cli && !ALLOWED.has(file))
      .map((cli) => `${file} runs ${cli}`),
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
      expect([...ALLOWED.keys()].filter((file) => !found.has(file))).toEqual([]);
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
