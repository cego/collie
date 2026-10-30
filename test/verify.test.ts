// A verification is only worth something because of what it refuses to say. These are
// the refusals: a tree that moved under the command, a tree too big to have been looked
// at, a directory that is not the Run's, and a command that is not the approved one.

import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { pipe as pipe_ } from "effect/Function";
import * as Option from "effect/Option";
import { Effect, Fiber, FileSystem, Path } from "effect";
import { expect, test } from "bun:test";
import { checkProof } from "../src/check-proof";
import {
  FINGERPRINT_MAX_BYTES,
  LOG_BYTES,
  TOO_LARGE,
  appendVerification,
  collect,
  fingerprint,
  insideRun,
  readVerifications,
  resolveExecutable,
  resultOf,
  reliedFor,
  runApproved,
  sameTree,
  staleAgainst,
} from "../src/verify";
import type { VerifySpec } from "../src/intent";
import { loggedGit } from "./support/bin";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import { until } from "./support/host";

let repo: string;

const git = (args: string[], cwd = repo) =>
  exec(["git", ...args], { cwd }).pipe(Effect.map((done) => done.exitCode));

const inRepository: typeof runEffect = (effect) =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      repo = yield* fs.makeTempDirectoryScoped({ prefix: "hw-verify-" });
      yield* git(["init", "-q"]);
      yield* git(["config", "user.email", "t@example.com"]);
      yield* git(["config", "user.name", "t"]);
      yield* fs.writeFileString(path.join(repo, ".gitignore"), "ignored/\n");
      yield* fs.writeFileString(path.join(repo, "tracked.txt"), "one\n");
      yield* git(["add", "-A"]);
      yield* git(["commit", "-qm", "first"]);
      return yield* effect;
    }),
  );

test("a fingerprint reads HEAD from its status, in five git starts", () =>
  inRepository(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${repo}/tracked.txt`, "two\n");
      yield* fs.writeFileString(`${repo}/scratch.txt`, "a\n");
      const aside = yield* fs.makeTempDirectoryScoped({ prefix: "hw-verify-git-" });
      const starts = yield* loggedGit(`${aside}/bin`, `${aside}/git.log`);
      const tree = yield* fingerprint(repo);
      expect(tree.head_sha).toHaveLength(40);
      expect(Arr.map(yield* starts, (line) => Str.split(line, " ")[0]).sort()).toEqual([
        "add",
        "ls-files",
        "rev-parse",
        "status",
        "write-tree",
      ]);
    }),
  ));

test("the fingerprint moves for anything that changes what a command would see", () =>
  inRepository(
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

      yield* git(["add", "-A"]);
      expect((yield* fingerprint(repo)).fingerprint).toBe(unstaged.fingerprint);

      // Untracked content counts: a test that passed because of an uncommitted file
      // passed on a tree nobody else will get.
      yield* git(["checkout", "-q", "--", "."]);
      yield* git(["reset", "-q"]);
      const back = yield* fingerprint(repo);
      yield* fs.writeFileString(path.join(repo, "scratch.txt"), "a\n");
      const withUntracked = yield* fingerprint(repo);
      expect(withUntracked.fingerprint).not.toBe(back.fingerprint);
      yield* fs.writeFileString(path.join(repo, "scratch.txt"), "b\n");
      const changed = yield* fingerprint(repo);
      expect(changed.fingerprint).not.toBe(withUntracked.fingerprint);

      // Ignored files are not part of what a command sees under version control.
      yield* fs.makeDirectory(path.join(repo, "ignored"), { recursive: true });
      yield* fs.writeFileString(path.join(repo, "ignored", "big"), "noise\n");
      expect((yield* fingerprint(repo)).fingerprint).toBe(changed.fingerprint);
    }),
  ));

test("two trees nobody measured are not the same tree", () => {
  const sentinel = { head_sha: "abc", fingerprint: TOO_LARGE };
  expect(resultOf(sentinel, sentinel, 0)).toBe("unstable");
  expect(resultOf({ head_sha: "abc", fingerprint: "x" }, sentinel, 0)).toBe("unstable");
  expect(
    resultOf({ head_sha: "abc", fingerprint: "x" }, { head_sha: "def", fingerprint: "x" }, 0),
  ).toBe("pass");
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
  inRepository(
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
      expect(pipe_(passed.executable, Str.startsWith("/"))).toBe(true);

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
      expect(Arr.map(journal, (entry) => `${entry.name}:${entry.result}`)).toEqual([
        "true:pass",
        "false:fail",
        "dirty:unstable",
      ]);
      expect(Arr.every(journal, (entry) => entry.by === "agent")).toBe(true);
    }),
  ));

test("the argument list is the command; nothing is handed to a shell", () =>
  inRepository(
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
      expect(Str.trim(record.tail.stdout)).toBe("hello; touch injected.txt");
      expect(yield* fs.exists(path.join(repo, "injected.txt"))).toBe(false);
      expect(record.result).toBe("pass");
    }),
  ));

test("a directory outside the Run is refused, and one inside it is not", () =>
  inRepository(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const run = { cwd: repo, worktree: null };
      expect(yield* insideRun(repo, run)).toBe(true);
      yield* fs.makeDirectory(path.join(repo, "src"), { recursive: true });
      expect(yield* insideRun(path.join(repo, "src"), run)).toBe(true);
      const elsewhere = yield* fs.makeTempDirectoryScoped({ prefix: "hw-verify-other-" });
      expect(yield* insideRun(elsewhere, run)).toBe(false);
      // A sibling whose path merely starts with the Run's is not inside it.
      expect(yield* insideRun(`${repo}-next-door`, run)).toBe(false);
    }),
  ));

test("Collie runs only the command the human approved, argument for argument", () =>
  inRepository(
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
      expect(renamed.why).toContain("not among this Run's checks");
    }),
  ));

test("a check granted with a cwd relative to a Run at the Projects root runs in that repository", () =>
  inRepository(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "hw-verify-root-" });
      const app = path.join(root, "app");
      yield* fs.makeDirectory(app);
      yield* git(["init", "-q"], app);
      yield* git(["config", "user.email", "t@example.com"], app);
      yield* git(["config", "user.name", "t"], app);
      yield* fs.writeFileString(path.join(app, "app.txt"), "app\n");
      yield* git(["add", "-A"], app);
      yield* git(["commit", "-qm", "app"], app);
      const run = { id: "r1", cwd: root, worktree: null };
      const spec: VerifySpec = { name: "tests", executable: "true", argv: [], cwd: "app" };

      const ran = yield* runApproved(path.join(root, ".run"), run, [spec], spec);

      expect(ran.cwd).toBe(app);
      expect(ran.end).toEqual(yield* fingerprint(app));
    }),
  ));

test("a verification keeps the executable as it was asked beside the path it resolved to", () =>
  inRepository(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const runDir = path.join(repo, ".run");
      const ran = yield* collect(runDir, {
        run: "r1",
        name: "version",
        executable: "bun",
        argv: ["--version"],
        cwd: repo,
        by: "agent",
      });
      const kept = Option.getOrUndefined(
        Arr.findFirst(yield* readVerifications(runDir), (one) => one.id === ran.id),
      );
      expect(kept?.asked).toBe("bun");
      expect(kept?.executable).toBe(Bun.which("bun") ?? "");
    }),
  ));

test("an executable nothing on PATH provides is refused before anything runs", () =>
  inRepository(
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

test("an expected failure passes when it fails, and fails when it does not", () =>
  inRepository(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const runDir = path.join(repo, ".run-expect");

      // A reproduction: the point of it is the non-zero exit, so that is its pass.
      const reproduced = yield* collect(runDir, {
        run: "r1",
        name: "regression",
        executable: "false",
        argv: [],
        cwd: repo,
        by: "agent",
        expect: "fail",
      });
      expect(reproduced.result).toBe("pass");
      expect(reproduced.exit).toBe(1);
      expect(reproduced.expect).toBe("fail");

      // The same command succeeding is the bug not reproducing, which is a failure of
      // the reproduction — not evidence that anything was fixed.
      const didNot = yield* collect(runDir, {
        run: "r1",
        name: "regression",
        executable: "true",
        argv: [],
        cwd: repo,
        by: "agent",
        expect: "fail",
      });
      expect(didNot.result).toBe("fail");
      expect(didNot.exit).toBe(0);

      // Unstable beats the expectation both ways: a tree that moved says nothing about
      // either, and an expected failure on a moving tree is not a reproduction.
      const moved = yield* collect(runDir, {
        run: "r1",
        name: "regression",
        executable: "sh",
        argv: ["-c", "touch moved-under-it.txt; exit 1"],
        cwd: repo,
        by: "agent",
        expect: "fail",
      });
      expect(moved.result).toBe("unstable");
    }),
  ));

test("expectation is applied only after the stability rules", () => {
  const same = { head_sha: "a", fingerprint: "f" };
  const other = { head_sha: "a", fingerprint: "g" };
  expect(resultOf(same, same, 1, "fail")).toBe("pass");
  expect(resultOf(same, same, 0, "fail")).toBe("fail");
  expect(resultOf(same, same, 0, "pass")).toBe("pass");
  expect(resultOf(same, other, 1, "fail")).toBe("unstable");
  expect(resultOf({ head_sha: "a", fingerprint: TOO_LARGE }, same, 1, "fail")).toBe("unstable");
  // The default is what every record written before `--expect` existed meant.
  expect(resultOf(same, same, 0)).toBe("pass");
});

test("a verification is stale the moment the tree it ran on moves", () =>
  inRepository(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Outside the repository, as a real run directory is: a journal written inside the
      // tree would move the fingerprint of the very tree it is recording.
      const runDir = yield* fs.makeTempDirectoryScoped({ prefix: "hw-verify-run-" });
      const record = yield* collect(runDir, {
        run: "r1",
        name: "tests",
        executable: "true",
        argv: [],
        cwd: repo,
        by: "agent",
      });
      expect(record.result).toBe("pass");
      expect(staleAgainst(record, yield* fingerprint(repo))).toBe(false);

      yield* fs.writeFileString(path.join(repo, "tracked.txt"), "two\n");
      expect(staleAgainst(record, yield* fingerprint(repo))).toBe(true);

      // A tree nobody could measure is never a tree a result still speaks for.
      expect(staleAgainst(record, { head_sha: record.end.head_sha, fingerprint: TOO_LARGE })).toBe(
        true,
      );
    }),
  ));

test("a check that passed on a dirty tree still passes once those bytes are committed", () =>
  inRepository(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runDir = yield* fs.makeTempDirectoryScoped({ prefix: "hw-verify-run-" });
      yield* fs.writeFileString(path.join(repo, "tracked.txt"), "two\n");
      yield* fs.writeFileString(path.join(repo, "new.txt"), "new\n");
      yield* collect(runDir, {
        run: "r1",
        name: "tests",
        executable: "true",
        argv: [],
        cwd: repo,
        by: "agent",
      });
      yield* git(["add", "-A"]);
      yield* git(["commit", "-qm", "the verified bytes"]);
      const proof = () =>
        Effect.gen(function* () {
          const final = yield* fingerprint(repo);
          return checkProof({ verifications: yield* readVerifications(runDir), final }, "tests")
            .state;
        });
      expect(yield* proof()).toBe("passed");

      yield* fs.makeDirectory(path.join(repo, "ignored"), { recursive: true });
      yield* fs.writeFileString(path.join(repo, "ignored", "noise"), "noise\n");
      expect(yield* proof()).toBe("passed");

      yield* fs.writeFileString(path.join(repo, "tracked.txt"), "twO\n");
      expect(yield* proof()).toBe("earlier");
      yield* git(["checkout", "-q", "--", "."]);
      expect(yield* proof()).toBe("passed");

      yield* fs.writeFileString(path.join(repo, "another.txt"), "x\n");
      expect(yield* proof()).toBe("earlier");
      yield* fs.remove(path.join(repo, "another.txt"));
      expect(yield* proof()).toBe("passed");

      yield* fs.remove(path.join(repo, "new.txt"));
      expect(yield* proof()).toBe("earlier");
    }),
  ));

test("a check that commits the dirty tracked bytes it ran on passed on one tree", () =>
  inRepository(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runDir = yield* fs.makeTempDirectoryScoped({ prefix: "hw-verify-run-" });
      yield* fs.writeFileString(path.join(repo, "tracked.txt"), "two\n");
      const committed = yield* collect(runDir, {
        run: "r1",
        name: "commit",
        executable: "git",
        argv: ["commit", "-qam", "from the check"],
        cwd: repo,
        by: "agent",
      });
      expect(committed.exit).toBe(0);
      expect(committed.result).toBe("pass");
    }),
  ));

test("a fingerprint leaves the index and the working tree as they were", () =>
  inRepository(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(repo, "second.txt"), "a\n");
      yield* git(["add", "-A"]);
      yield* git(["commit", "-qm", "second"]);
      yield* fs.writeFileString(path.join(repo, "tracked.txt"), "staged\n");
      yield* git(["add", "tracked.txt"]);
      yield* fs.writeFileString(path.join(repo, "tracked.txt"), "staged then edited\n");
      yield* fs.writeFileString(path.join(repo, "second.txt"), "unstaged\n");
      yield* fs.writeFileString(path.join(repo, "untracked.txt"), "u\n");
      const out = (args: string[]) =>
        exec(["git", ...args], { cwd: repo }).pipe(Effect.map((done) => done.stdout));
      const state = () =>
        Effect.all([
          out(["diff", "--cached", "--name-only"]),
          out(["diff", "--name-only"]),
          out(["ls-files", "--others"]),
        ]);
      const before = yield* state();
      expect(before).toEqual(["tracked.txt\n", "second.txt\ntracked.txt\n", "untracked.txt\n"]);
      yield* fingerprint(repo);
      expect(yield* state()).toEqual(before);
    }),
  ));

test("a clean tree is its commit's tree, and a tree too large is no tree", () =>
  inRepository(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const head = yield* exec(["git", "rev-parse", "HEAD^{tree}"], { cwd: repo });
      expect((yield* fingerprint(repo)).fingerprint).toBe(Str.trim(head.stdout));

      yield* fs.writeFileString(
        path.join(repo, "huge.bin"),
        Str.repeat(FINGERPRINT_MAX_BYTES + 1)("a"),
      );
      const huge = yield* fingerprint(repo);
      expect(huge.fingerprint).toBe(TOO_LARGE);
      expect(sameTree(huge, huge)).toBe(false);
    }),
  ));

test("a tree git cannot stage is no tree, so an edit it hides moves nothing into a pass", () =>
  inRepository(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(path.join(repo, ".gitattributes"), "*.txt filter=broken\n");
      yield* git(["add", "-A"]);
      yield* git(["commit", "-qm", "attributes"]);
      yield* git(["config", "filter.broken.clean", "false"]);
      yield* git(["config", "filter.broken.required", "true"]);
      const before = yield* fingerprint(repo);
      yield* fs.writeFileString(path.join(repo, "tracked.txt"), "two\n");
      const after = yield* fingerprint(repo);
      expect(sameTree(before, after)).toBe(false);
      expect(sameTree(after, after)).toBe(false);
    }),
  ));

test("an edit inside a submodule moves the tree, measured from any directory of it, and undoing it moves it back", () =>
  inRepository(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const inner = yield* fs.makeTempDirectoryScoped({ prefix: "hw-verify-sub-" });
      for (const args of [
        ["init", "-q"],
        ["config", "user.email", "t@example.com"],
        ["config", "user.name", "t"],
      ])
        yield* git(args, inner);
      yield* fs.writeFileString(path.join(inner, "lib.txt"), "one\n");
      yield* git(["add", "-A"], inner);
      yield* git(["commit", "-qm", "lib"], inner);
      expect(
        yield* git(["-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "mod"]),
      ).toBe(0);
      yield* fs.makeDirectory(path.join(repo, "pkg"));
      yield* fs.writeFileString(path.join(repo, "pkg", "a.txt"), "a\n");
      yield* git(["add", "-A"]);
      yield* git(["commit", "-qm", "submodule"]);
      const clean = yield* fingerprint(repo);

      yield* fs.writeFileString(path.join(repo, "mod", "lib.txt"), "two\n");
      const edited = yield* fingerprint(repo);
      expect(sameTree(edited, clean)).toBe(false);
      expect(sameTree(yield* fingerprint(path.join(repo, "pkg")), edited)).toBe(true);
      yield* fs.writeFileString(path.join(repo, "mod", "new.txt"), "n\n");
      expect(sameTree(yield* fingerprint(repo), edited)).toBe(false);

      yield* fs.remove(path.join(repo, "mod", "new.txt"));
      yield* fs.writeFileString(path.join(repo, "mod", "lib.txt"), "one\n");
      expect(sameTree(yield* fingerprint(repo), clean)).toBe(true);
    }),
  ));

test("Collie's own run carries the expectation it was approved with", () =>
  inRepository(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const runDir = path.join(repo, ".run-approved");
      const spec: VerifySpec = { name: "regression", executable: "false", argv: [], cwd: "." };
      const run = { id: "r1", cwd: repo, worktree: null };
      const record = yield* runApproved(runDir, run, [spec], spec, "fail");
      expect(record.result).toBe("pass");
      expect(record.by).toBe("collie");
      expect(record.expect).toBe("fail");
    }),
  ));

test("both streams go to the log as they arrive, readable while the command runs", () =>
  inRepository(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "hw-verify-log-" });
      const runDir = path.join(tmp, ".run");
      const log = path.join(tmp, "checks", "unit.log");
      const running = yield* Effect.forkChild(
        collect(runDir, {
          run: "r1",
          name: "unit",
          executable: "sh",
          argv: ["-c", "echo one; sleep 0.2; echo two >&2; sleep 0.2; echo three; sleep 1"],
          cwd: repo,
          by: "collie",
          log,
        }),
      );
      // Before it ends: what it has said so far, in the order it said it.
      const early = yield* until(
        () => fs.readFileString(log).pipe(Effect.orElseSucceed(() => "")),
        (text) => pipe_(text, Str.includes("three")),
      );
      expect(early).toBe("one\ntwo\nthree\n");
      const record = yield* Fiber.join(running);
      expect(record.log).toBe(log);
      expect(yield* fs.readFileString(log)).toBe("one\ntwo\nthree\n");
    }),
  ));

test("a log past its bound is cut, and says it was", () =>
  inRepository(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "hw-verify-log-" });
      const log = path.join(tmp, "checks", "loud.log");
      yield* collect(path.join(tmp, ".run"), {
        run: "r1",
        name: "loud",
        executable: "sh",
        argv: ["-c", `head -c ${LOG_BYTES + 4096} /dev/zero | tr '\\0' a`],
        cwd: repo,
        by: "collie",
        log,
      });
      const text = yield* fs.readFileString(log);
      expect(
        pipe_(
          text,
          Str.endsWith(
            `[collie: the output was cut at ${LOG_BYTES} bytes; the rest was not kept]\n`,
          ),
        ),
      ).toBe(true);
      expect(pipe_(text, Str.startsWith(Str.repeat(LOG_BYTES)("a")))).toBe(true);
      expect(text.length).toBeLessThan(LOG_BYTES + 200);
    }),
  ));

/** Sets NODE_OPTIONS for this process, and returns what puts it back. */
function nodeOptions(value: string): () => void {
  const before = Bun.env.NODE_OPTIONS;
  Bun.env.NODE_OPTIONS = value;
  return () => {
    if (before === undefined) delete Bun.env.NODE_OPTIONS;
    else Bun.env.NODE_OPTIONS = before;
  };
}

/** A tool of the test's own, outside the tree, whose content is what it is. */
const tool = (dir: string, body: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const at = `${dir}/tool`;
    yield* fs.writeFileString(at, `#!/bin/sh\n${body}\n`);
    yield* fs.chmod(at, 0o755);
    return at;
  });

test("every record carries the environment it ran in, which moves with the tool and the toolchain", () =>
  inRepository(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runDir = yield* fs.makeTempDirectoryScoped({ prefix: "hw-verify-run-" });
      const executable = yield* tool(runDir, "exit 0");
      const ran = () =>
        collect(runDir, { run: "r1", name: "t", executable, argv: [], cwd: repo, by: "collie" });
      const first = (yield* ran()).environment;
      expect(first).toBeString();
      expect((yield* ran()).environment).toBe(first);

      const restore = nodeOptions("--max-old-space-size=64");
      const optioned = yield* ran().pipe(Effect.ensuring(Effect.sync(restore)));
      expect(optioned.environment).not.toBe(first);

      yield* tool(runDir, "exit 0 # upgraded");
      expect((yield* ran()).environment).not.toBe(first);
    }),
  ));

test("a pass is relied on only while its tree, its command and its environment are unchanged, whoever asked", () =>
  inRepository(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const runDir = yield* fs.makeTempDirectoryScoped({ prefix: "hw-verify-run-" });
      const executable = yield* tool(runDir, "exit 0");
      const spec: VerifySpec = { name: "unit", executable, argv: [], cwd: "." };
      const run = { id: "r1", cwd: repo, worktree: null };
      const since = "2000-01-01T00:00:00.000Z";
      const relied = () => reliedFor(runDir, run, spec, since);

      expect(yield* relied()).toBeNull();
      // An agent's pass of exactly the check's command, under a name of its own.
      const agents = yield* collect(runDir, {
        run: "r1",
        name: "test",
        executable,
        argv: [],
        cwd: repo,
        by: "agent",
      });
      expect((yield* relied())?.id).toBe(agents.id);
      const collies = yield* runApproved(runDir, run, [spec], spec);
      expect((yield* relied())?.id).toBe(collies.id);

      // Another command under the same name.
      expect(yield* reliedFor(runDir, run, { ...spec, argv: ["--bail"] }, since)).toBeNull();

      // The tree moved.
      yield* fs.writeFileString(path.join(repo, "tracked.txt"), "two\n");
      expect(yield* relied()).toBeNull();
      yield* git(["checkout", "-q", "--", "."]);
      expect((yield* relied())?.id).toBe(collies.id);

      yield* fs.writeFileString(path.join(repo, "tracked.txt"), "two\n");
      const dirty = yield* runApproved(runDir, run, [spec], spec);
      yield* git(["commit", "-qam", "the verified bytes"]);
      expect((yield* relied())?.id).toBe(dirty.id);

      // The tool changed.
      yield* tool(runDir, "exit 0 # upgraded");
      expect(yield* relied()).toBeNull();
    }),
  ));

test("the latest record of that command on the tree decides, whoever asked", () =>
  inRepository(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runDir = yield* fs.makeTempDirectoryScoped({ prefix: "hw-verify-run-" });
      const flag = `${runDir}/red`;
      const executable = yield* tool(runDir, `[ ! -f ${flag} ]`);
      const spec: VerifySpec = { name: "unit", executable, argv: [], cwd: "." };
      const run = { id: "r1", cwd: repo, worktree: null };
      const since = "2000-01-01T00:00:00.000Z";
      const passed = yield* runApproved(runDir, run, [spec], spec);

      // An agent's later failure of the same command on this tree.
      yield* fs.writeFileString(flag, "");
      yield* collect(runDir, {
        run: "r1",
        name: "t",
        executable,
        argv: [],
        cwd: repo,
        by: "agent",
      });
      yield* fs.remove(flag);
      expect(yield* reliedFor(runDir, run, spec, since)).toBeNull();

      // Expecting a failure is never a pass of the check.
      yield* collect(runDir, {
        run: "r1",
        name: "t",
        executable,
        argv: [],
        cwd: repo,
        by: "agent",
        expect: "fail",
      });
      expect(yield* reliedFor(runDir, run, spec, since)).toBeNull();

      yield* appendVerification(runDir, { ...passed, id: "again" });
      expect((yield* reliedFor(runDir, run, spec, since))?.id).toBe("again");
      // Collected before this host started.
      expect(yield* reliedFor(runDir, run, spec, "2999-01-01T00:00:00.000Z")).toBeNull();

      const { environment: _, ...older } = passed;
      yield* appendVerification(runDir, { ...older, id: "older" });
      expect(yield* reliedFor(runDir, run, spec, since)).toBeNull();
    }),
  ));
