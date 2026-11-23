import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import { integrateDefault } from "../src/integrate";
import { shell } from "../src/mr";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  exec(["git", ...args], { cwd }).pipe(
    Effect.tap((done) =>
      done.exitCode === 0 ? Effect.void : Effect.die(`git ${Arr.join(args, " ")}: ${done.stderr}`),
    ),
    Effect.map((done) => Str.trim(done.stdout)),
  );

const commit = (root: string, file: string, body: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.writeFileString(`${root}/${file}`, body);
    yield* git(root, "add", "-A");
    yield* git(root, "commit", "-q", "-m", `change ${file}`);
  });

const identify = (root: string) =>
  Effect.gen(function* () {
    yield* git(root, "config", "user.email", "test@example.com");
    yield* git(root, "config", "user.name", "Test");
  });

const repositories = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped();
  const remote = `${root}/remote.git`;
  yield* git(root, "init", "-q", "--bare", "-b", "master", remote);
  const upstream = `${root}/upstream`;
  yield* git(root, "clone", "-q", remote, upstream);
  yield* identify(upstream);
  yield* git(upstream, "checkout", "-q", "-b", "master");
  yield* commit(upstream, "shared.txt", "one\n");
  yield* git(upstream, "push", "-q", "origin", "master");
  const run = `${root}/run`;
  yield* git(root, "clone", "-q", remote, run);
  yield* identify(run);
  yield* git(run, "checkout", "-q", "-b", "feature");
  yield* commit(run, "feature.txt", "built\n");
  const moveMaster = (file: string, body: string) =>
    Effect.gen(function* () {
      yield* commit(upstream, file, body);
      yield* git(upstream, "push", "-q", "origin", "master");
      return yield* git(upstream, "rev-parse", "HEAD");
    });
  return { run, upstream, moveMaster };
});

const masterInstalling = (install: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { run, upstream, moveMaster } = yield* repositories;
    yield* fs.makeDirectory(`${upstream}/.collie`);
    yield* fs.writeFileString(
      `${upstream}/.collie/dependencies.json`,
      '{ "executable": "sh", "argv": ["install.sh"] }',
    );
    yield* fs.writeFileString(`${upstream}/.gitignore`, "node_modules/\n");
    yield* moveMaster("install.sh", install);
    return run;
  });

const parents = (cwd: string) =>
  Effect.map(git(cwd, "rev-list", "--parents", "-n", "1", "HEAD"), (line) =>
    Str.split(line, " ").slice(1),
  );

test("an unchanged default branch is skipped, and nothing is committed", () =>
  runEffect(
    Effect.gen(function* () {
      const { run } = yield* repositories;
      const before = yield* git(run, "rev-parse", "HEAD");
      const done = yield* integrateDefault(shell, run);
      expect(done.status).toBe("unchanged");
      expect(done.branch).toBe("master");
      expect(yield* git(run, "rev-parse", "HEAD")).toBe(before);
    }),
  ));

test("a moved default branch is merged with a merge commit, never a rebase", () =>
  runEffect(
    Effect.gen(function* () {
      const { run, moveMaster } = yield* repositories;
      const built = yield* git(run, "rev-parse", "HEAD");
      const moved = yield* moveMaster("upstream.txt", "new\n");
      const done = yield* integrateDefault(shell, run);
      expect(done).toEqual({
        status: "merged",
        branch: "master",
        ref: "origin/master",
        sha: moved,
        files: [],
        reason: "",
      });
      expect(yield* parents(run)).toEqual([built, moved]);
      expect(yield* git(run, "merge-base", "HEAD", "origin/master")).toBe(moved);
      expect((yield* integrateDefault(shell, run)).status).toBe("unchanged");
    }),
  ));

test("a conflict is left for the builder to finish, naming the conflicted files", () =>
  runEffect(
    Effect.gen(function* () {
      const { run, moveMaster } = yield* repositories;
      yield* commit(run, "shared.txt", "ours\n");
      const moved = yield* moveMaster("shared.txt", "theirs\n");
      const done = yield* integrateDefault(shell, run);
      expect(done.status).toBe("conflicted");
      expect(done.sha).toBe(moved);
      expect(done.files).toEqual(["shared.txt"]);
      expect(yield* git(run, "rev-parse", "-q", "--verify", "MERGE_HEAD")).toBe(moved);
      expect(yield* integrateDefault(shell, run)).toMatchObject({
        status: "conflicted",
        sha: moved,
        files: ["shared.txt"],
      });
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${run}/shared.txt`, "both\n");
      yield* git(run, "add", "shared.txt");
      expect((yield* integrateDefault(shell, run)).status).toBe("waiting");
    }),
  ));

test("a checkout with uncommitted changes waits for the builder's commit", () =>
  runEffect(
    Effect.gen(function* () {
      const { run, moveMaster } = yield* repositories;
      const fs = yield* FileSystem.FileSystem;
      yield* moveMaster("upstream.txt", "new\n");
      yield* fs.writeFileString(`${run}/feature.txt`, "half done\n");
      const before = yield* git(run, "rev-parse", "HEAD");
      const done = yield* integrateDefault(shell, run);
      expect(done.status).toBe("waiting");
      expect(done.reason).toContain("uncommitted");
      expect(yield* git(run, "rev-parse", "HEAD")).toBe(before);
      expect(yield* fs.readFileString(`${run}/feature.txt`)).toBe("half done\n");
      yield* git(run, "checkout", "-q", "--", "feature.txt");
      yield* fs.writeFileString(`${run}/new.txt`, "not added\n");
      expect((yield* integrateDefault(shell, run)).status).toBe("waiting");
    }),
  ));

test("a fetch that fails integrates nothing: the default branch as last fetched may be stale", () =>
  runEffect(
    Effect.gen(function* () {
      const { run } = yield* repositories;
      yield* git(run, "remote", "set-url", "origin", `${run}/gone.git`);
      const done = yield* integrateDefault(shell, run);
      expect(done).toMatchObject({ status: "unavailable", branch: "master", sha: "" });
      expect(done.reason).toContain("could not fetch master from origin");
    }),
  ));

test("a repository with no remote integrates its local default branch", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped();
      yield* git(root, "init", "-q", "-b", "master");
      yield* identify(root);
      yield* commit(root, "shared.txt", "one\n");
      yield* git(root, "checkout", "-q", "-b", "feature");
      yield* commit(root, "feature.txt", "built\n");
      yield* git(root, "checkout", "-q", "master");
      yield* commit(root, "upstream.txt", "new\n");
      const moved = yield* git(root, "rev-parse", "HEAD");
      yield* git(root, "checkout", "-q", "feature");
      const done = yield* integrateDefault(shell, root);
      expect(done).toMatchObject({ status: "merged", ref: "master", sha: moved });
    }),
  ));

test("a merged default branch leaves the checkout with the merged head's dependencies installed", () =>
  runEffect(
    Effect.gen(function* () {
      const run = yield* masterInstalling(
        String.raw`mkdir -p node_modules/.bin && printf "#!/bin/sh\nexit 0\n" > node_modules/.bin/tool && chmod +x node_modules/.bin/tool`,
      );
      expect((yield* integrateDefault(shell, run)).status).toBe("merged");
      expect((yield* shell("sh", ["-c", "node_modules/.bin/tool"], run)).code).toBe(0);
    }),
  ));

test("a merge whose declared dependencies command fails is unavailable, with what the command said", () =>
  runEffect(
    Effect.gen(function* () {
      const run = yield* masterInstalling('echo "lockfile had changes but is frozen" >&2; exit 1');
      const done = yield* integrateDefault(shell, run);
      expect(done.status).toBe("unavailable");
      expect(done.reason).toContain("lockfile had changes but is frozen");
    }),
  ));

test("an integration resumed after its install failed installs again, never calling the merged head ready", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const run = yield* masterInstalling(
        String.raw`test -f ../registry-up || { echo "registry unreachable" >&2; exit 1; }; mkdir -p node_modules/.bin && printf "#!/bin/sh\nexit 0\n" > node_modules/.bin/tool && chmod +x node_modules/.bin/tool`,
      );
      expect((yield* integrateDefault(shell, run)).status).toBe("unavailable");
      yield* fs.writeFileString(`${run}/../registry-up`, "");
      expect((yield* integrateDefault(shell, run)).status).toBe("merged");
      expect((yield* shell("sh", ["-c", "node_modules/.bin/tool"], run)).code).toBe(0);
    }),
  ));

test("an integration resumed after its install left the index locked installs again", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const run = yield* masterInstalling(
        String.raw`test -f ../registry-up || { touch .git/index.lock; echo "registry unreachable" >&2; exit 1; }; mkdir -p node_modules/.bin && printf "#!/bin/sh\nexit 0\n" > node_modules/.bin/tool && chmod +x node_modules/.bin/tool`,
      );
      expect((yield* integrateDefault(shell, run)).status).toBe("unavailable");
      yield* fs.remove(`${run}/.git/index.lock`);
      yield* fs.writeFileString(`${run}/../registry-up`, "");
      expect((yield* integrateDefault(shell, run)).status).toBe("merged");
      expect((yield* shell("sh", ["-c", "node_modules/.bin/tool"], run)).code).toBe(0);
    }),
  ));
