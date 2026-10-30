// `tools/adr-number.ts`: a branch's new ADR is a draft named by its slug, and it takes a
// number only when the branch lands, so parallel branches stop renumbering each other's.
// References are built here rather than written out, so the docs-links check never reads
// this file's fixtures as the repository's own.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as Rec from "effect/Record";
import { pipe as pipe_ } from "effect/Function";
import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";

const adr = (id: string) => Arr.join(["ADR", id], "-");
const draft = (slug: string) => adr(`draft-${slug}`);

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  exec(["git", ...args], { cwd }).pipe(
    Effect.tap((done) =>
      done.exitCode === 0 ? Effect.void : Effect.die(`git ${Arr.join(args, " ")}: ${done.stderr}`),
    ),
    Effect.map((done) => Str.trim(done.stdout)),
  );

const status = (root: string) =>
  Effect.map(git(root, "status", "--porcelain"), (out) =>
    Arr.map(Str.split(out, "\n"), (line) => Str.trim(line)).sort(),
  );

const write = (root: string, files: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    for (const [path, body] of Rec.toEntries(files)) {
      yield* fs.makeDirectory(pipe_(`${root}/${path}`, Str.replace(/\/[^/]*$/, "")), {
        recursive: true,
      });
      yield* fs.writeFileString(`${root}/${path}`, body);
    }
  });

const commit = (root: string, files: Record<string, string>, message: string) =>
  Effect.gen(function* () {
    yield* write(root, files);
    yield* git(root, "add", "-A");
    yield* git(root, "commit", "-q", "-m", message);
  });

/** A repository on `master` with two ADRs, and `feature` branched from it. */
const repository = (onMaster: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    yield* git(root, "init", "-q", "-b", "master");
    yield* git(root, "config", "user.email", "test@example.com");
    yield* git(root, "config", "user.name", "Test");
    yield* commit(
      root,
      {
        "docs/adr/0001-first.md": "# First\n",
        "docs/adr/0002-second.md": "# Second\n",
        "README.md": "Nothing about drafts.\n",
        ...onMaster,
      },
      "start",
    );
    yield* git(root, "checkout", "-q", "-b", "feature");
    return root;
  });

const number = (root: string, ...args: ReadonlyArray<string>) =>
  exec(["bun", "run", `${import.meta.dir}/../tools/adr-number.ts`, "--base", "master", ...args], {
    cwd: root,
  }).pipe(Effect.map((done) => ({ code: done.exitCode, said: done.stdout + done.stderr })));

const read = (root: string, path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(`${root}/${path}`);
  });

test("a draft takes the number after one that landed meanwhile, and every reference follows it", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* repository();
      yield* commit(
        root,
        {
          "docs/adr/draft-new-thing.md": `# A new thing\n\nSee ${adr("0002")}.\n`,
          "docs/using.md": `Read [${draft("new-thing")}](adr/draft-new-thing.md).\n`,
          "src/thing.ts": `// The rule is ${draft("new-thing")}'s.\nexport const thing = 1;\n`,
          "test/thing.test.ts": `// docs/adr/draft-new-thing.md, D2\n`,
        },
        "draft",
      );
      yield* git(root, "checkout", "-q", "master");
      yield* commit(root, { "docs/adr/0003-landed.md": "# Landed\n" }, "landed");
      yield* git(root, "checkout", "-q", "feature");
      const commits = yield* git(root, "rev-list", "--count", "HEAD");

      const done = yield* number(root);
      expect(done.code).toBe(0);
      expect(yield* fs.exists(`${root}/docs/adr/draft-new-thing.md`)).toBe(false);
      expect(yield* read(root, "docs/adr/0004-new-thing.md")).toBe(
        `# A new thing\n\nSee ${adr("0002")}.\n`,
      );
      expect(yield* read(root, "docs/using.md")).toBe(
        `Read [${adr("0004")}](adr/0004-new-thing.md).\n`,
      );
      expect(yield* read(root, "src/thing.ts")).toContain(`The rule is ${adr("0004")}'s.`);
      expect(yield* read(root, "test/thing.test.ts")).toBe(`// docs/adr/0004-new-thing.md, D2\n`);
      const left = yield* exec(["git", "grep", "-n", "draft-new-thing"], { cwd: root });
      expect(left.stdout).toBe("");
      expect(yield* git(root, "rev-list", "--count", "HEAD")).toBe(commits);
      const changed = yield* status(root);
      expect(changed).toEqual([
        "?? docs/adr/0004-new-thing.md",
        "D docs/adr/draft-new-thing.md",
        "M docs/using.md",
        "M src/thing.ts",
        "M test/thing.test.ts",
      ]);

      const again = yield* number(root);
      expect(again.code).toBe(0);
      expect(yield* status(root)).toEqual(changed);
    }).pipe(Effect.scoped),
  ));

test("drafts are numbered in slug order above the branch's own numbered ADRs", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* repository();
      yield* commit(
        root,
        {
          "docs/adr/0003-branch-numbered.md": "# Numbered on the branch\n",
          "docs/adr/draft-zebra.md": `# Zebra, after ${draft("apple")}\n`,
          "docs/adr/draft-apple.md": "# Apple\n",
          "docs/adr/draft-apple-pie.md": "# Apple pie\n",
        },
        "drafts",
      );
      expect((yield* number(root)).code).toBe(0);
      expect(yield* fs.exists(`${root}/docs/adr/0004-apple.md`)).toBe(true);
      expect(yield* fs.exists(`${root}/docs/adr/0005-apple-pie.md`)).toBe(true);
      expect(yield* read(root, "docs/adr/0006-zebra.md")).toBe(`# Zebra, after ${adr("0004")}\n`);
    }).pipe(Effect.scoped),
  ));

test("a number the default branch already has twice is reported and left alone", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* repository({ "docs/adr/0002-also-second.md": "# Also second\n" });
      yield* commit(root, { "docs/adr/draft-next.md": "# Next\n" }, "draft");
      const done = yield* number(root);
      expect(done.code).toBe(0);
      expect(done.said).toContain("0002");
      expect(done.said).toContain("0002-also-second.md");
      expect(yield* fs.exists(`${root}/docs/adr/0002-second.md`)).toBe(true);
      expect(yield* fs.exists(`${root}/docs/adr/0002-also-second.md`)).toBe(true);
      expect(yield* fs.exists(`${root}/docs/adr/0003-next.md`)).toBe(true);
    }).pipe(Effect.scoped),
  ));
