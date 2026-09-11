// A verification is only worth something because of what it refuses to say. These are
// the refusals: a tree that moved under the command, a tree too big to have been looked
// at, a directory that is not the Run's, and a command that is not the approved one.

import { Effect, FileSystem, Path } from "effect";
import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  TOO_LARGE,
  collect,
  fingerprint,
  insideRun,
  readVerifications,
  resolveExecutable,
  resultOf,
  runApproved,
} from "../src/verify";
import type { VerifySpec } from "../src/intent";
import { runEffect } from "./support/effect";

let repo: string;

const git = Effect.fn("test.git")(function* (args: string[], cwd = repo) {
  const done = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  yield* Effect.void;
  return done.exitCode;
});

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      repo = yield* fs.makeTempDirectory({ prefix: "hw-verify-" });
      yield* git(["init", "-q"]);
      yield* git(["config", "user.email", "t@example.com"]);
      yield* git(["config", "user.name", "t"]);
      yield* fs.writeFileString(path.join(repo, ".gitignore"), "ignored/\n");
      yield* fs.writeFileString(path.join(repo, "tracked.txt"), "one\n");
      yield* git(["add", "-A"]);
      yield* git(["commit", "-qm", "first"]);
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(repo, { recursive: true, force: true });
    }),
  ),
);

test("the fingerprint moves for anything that changes what a command would see", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const clean = yield* fingerprint(repo);
      expect(clean.head_sha).toHaveLength(40);
      expect(clean.fingerprint).not.toBe(TOO_LARGE);
      expect((yield* fingerprint(repo)).fingerprint).toBe(clean.fingerprint);

      // Unstaged.
      yield* fs.writeFileString(path.join(repo, "tracked.txt"), "two\n");
      const unstaged = yield* fingerprint(repo);
      expect(unstaged.fingerprint).not.toBe(clean.fingerprint);

      // Staged is a different state again.
      yield* git(["add", "-A"]);
      expect((yield* fingerprint(repo)).fingerprint).not.toBe(unstaged.fingerprint);

      // Untracked content counts: a test that passed because of an uncommitted file
      // passed on a tree nobody else will get.
      yield* git(["checkout", "-q", "--", "."]);
      yield* git(["reset", "-q"]);
      const back = yield* fingerprint(repo);
      yield* fs.writeFileString(path.join(repo, "scratch.txt"), "a\n");
      const withUntracked = yield* fingerprint(repo);
      expect(withUntracked.fingerprint).not.toBe(back.fingerprint);
      yield* fs.writeFileString(path.join(repo, "scratch.txt"), "b\n");
      expect((yield* fingerprint(repo)).fingerprint).not.toBe(withUntracked.fingerprint);

      // Ignored files are not part of what a command sees under version control.
      yield* fs.makeDirectory(path.join(repo, "ignored"), { recursive: true });
      yield* fs.writeFileString(path.join(repo, "ignored", "big"), "noise\n");
      expect((yield* fingerprint(repo)).fingerprint).toBe((yield* fingerprint(repo)).fingerprint);
    }),
  ));

test("two trees nobody measured are not the same tree", () => {
  const sentinel = { head_sha: "abc", fingerprint: TOO_LARGE };
  expect(resultOf(sentinel, sentinel, 0)).toBe("unstable");
  expect(resultOf({ head_sha: "abc", fingerprint: "x" }, sentinel, 0)).toBe("unstable");
  // A tree that moved says nothing about either end, whatever the exit was.
  expect(
    resultOf({ head_sha: "abc", fingerprint: "x" }, { head_sha: "def", fingerprint: "x" }, 0),
  ).toBe("unstable");
  expect(
    resultOf({ head_sha: "abc", fingerprint: "x" }, { head_sha: "abc", fingerprint: "y" }, 0),
  ).toBe("unstable");
  expect(
    resultOf({ head_sha: "abc", fingerprint: "x" }, { head_sha: "abc", fingerprint: "x" }, 0),
  ).toBe("pass");
  expect(
    resultOf({ head_sha: "abc", fingerprint: "x" }, { head_sha: "abc", fingerprint: "x" }, 1),
  ).toBe("fail");
});

test("a command that leaves the tree alone passes; one that changes it is unstable", () =>
  runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const runDir = path.join(repo, ".run");

      const passed = yield* collect(runDir, {
        run: "r1",
        name: "true",
        executable: "true",
        argv: [],
        cwd: repo,
        by: "agent",
      });
      expect(passed.result).toBe("pass");
      expect(passed.exit).toBe(0);
      expect(passed.executable.startsWith("/")).toBe(true);

      const failed = yield* collect(runDir, {
        run: "r1",
        name: "false",
        executable: "false",
        argv: [],
        cwd: repo,
        by: "agent",
      });
      expect(failed.result).toBe("fail");

      // Writes a file while it runs, which is exactly the case a snapshot pair catches.
      const changed = yield* collect(runDir, {
        run: "r1",
        name: "dirty",
        executable: "touch",
        argv: ["written-while-running.txt"],
        cwd: repo,
        by: "agent",
      });
      expect(changed.result).toBe("unstable");
      expect(changed.exit).toBe(0);

      const journal = yield* readVerifications(runDir);
      expect(journal.map((entry) => `${entry.name}:${entry.result}`)).toEqual([
        "true:pass",
        "false:fail",
        "dirty:unstable",
      ]);
      expect(journal.every((entry) => entry.by === "agent")).toBe(true);
    }),
  ));

test("the argument list is the command; nothing is handed to a shell", () =>
  runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const runDir = path.join(repo, ".run");
      // A shell would treat this as two commands; a spawn treats it as one argument.
      const record = yield* collect(runDir, {
        run: "r1",
        name: "echo",
        executable: "echo",
        argv: ["hello; touch injected.txt"],
        cwd: repo,
        by: "agent",
      });
      const fs = yield* FileSystem.FileSystem;
      expect(record.tail.stdout.trim()).toBe("hello; touch injected.txt");
      expect(yield* fs.exists(path.join(repo, "injected.txt"))).toBe(false);
      expect(record.result).toBe("pass");
    }),
  ));

test("a directory outside the Run is refused, and one inside it is not", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const run = { cwd: repo, worktree: null };
      expect(yield* insideRun(repo, run)).toBe(true);
      yield* fs.makeDirectory(path.join(repo, "src"), { recursive: true });
      expect(yield* insideRun(path.join(repo, "src"), run)).toBe(true);
      const elsewhere = yield* fs.makeTempDirectory({ prefix: "hw-verify-other-" });
      expect(yield* insideRun(elsewhere, run)).toBe(false);
      // A sibling whose path merely starts with the Run's is not inside it.
      expect(yield* insideRun(`${repo}-next-door`, run)).toBe(false);
      yield* fs.remove(elsewhere, { recursive: true, force: true });
    }),
  ));

test("Collie runs only the command the human approved, argument for argument", () =>
  runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const runDir = path.join(repo, ".run");
      const run = { id: "r1", cwd: repo, worktree: null };
      const approved: VerifySpec = {
        name: "tests",
        executable: "true",
        argv: ["--bail"],
        cwd: "worktree",
      };

      const ran = yield* runApproved(runDir, run, [approved], approved);
      expect(ran.result).toBe("pass");
      expect(ran.by).toBe("collie");

      // The wrapper is part of what was approved: one extra word is a different command.
      const near = yield* runApproved(runDir, run, [approved], {
        ...approved,
        argv: ["--bail", "--watch"],
      }).pipe(Effect.flip);
      expect(near.why).toContain("argument for argument");

      const renamed = yield* runApproved(runDir, run, [approved], {
        ...approved,
        executable: "false",
      }).pipe(Effect.flip);
      expect(renamed.why).toContain("approved verifications");
    }),
  ));

test("an executable nothing on PATH provides is refused before anything runs", () =>
  runEffect(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      expect(yield* resolveExecutable("definitely-not-a-real-binary-xyz", repo)).toBeNull();
      const refused = yield* collect(path.join(repo, ".run"), {
        run: "r1",
        name: "nope",
        executable: "definitely-not-a-real-binary-xyz",
        argv: [],
        cwd: repo,
        by: "agent",
      }).pipe(Effect.flip);
      expect(refused.why).toContain("nothing on PATH");
    }),
  ));
