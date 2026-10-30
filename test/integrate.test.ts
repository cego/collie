// `integrateDefault`: the default branch merged into a Run's branch where it has moved, over
// real repositories — a remote, a clone that moves master, and the Run's own clone.

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

/** A remote on master, a clone that moves it, and the Run's clone on `feature`. */
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
  return { run, moveMaster };
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
      // Integrated once, the same default branch is unchanged from then on.
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
      // Unfinished, the merge is still the builder's, and is handed back as it stands.
      expect(yield* integrateDefault(shell, run)).toMatchObject({
        status: "conflicted",
        sha: moved,
        files: ["shared.txt"],
      });
      // Resolved but not committed, it waits for the builder's commit.
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
      // A new file not yet added is uncommitted too.
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
