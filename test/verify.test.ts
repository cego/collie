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
  UNMEASURED,
  appendVerification,
  collect,
  fingerprint,
  insideRun,
  readVerifications,
  resolveExecutable,
  resultOf,
  recordFor,
  recordedFor,
  reliedFor,
  runApproved,
  sameTree,
  staleAgainst,
} from "../src/verify";
import type { VerifySpec } from "../src/intent";
import { isolatedHint } from "../src/verify-model";
import type { Verification } from "../src/verify-model";
import { fileTime } from "../src/time";
import { noteVerification, readMetrics } from "../src/metrics";
import { FakeBin, loggedGit } from "./support/bin";
import { exec } from "./support/command";
import { runEffect } from "./support/effect";
import { until } from "./support/host";

let repo: string;

const git = (args: Array<string>, cwd = repo) =>
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

test("a fingerprint reads HEAD from its status, in four git starts and three once its checkout is known", () =>
  inRepository(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(`${repo}/tracked.txt`, "two\n");
      yield* fs.writeFileString(`${repo}/scratch.txt`, "a\n");
      const aside = yield* fs.makeTempDirectoryScoped({ prefix: "hw-verify-git-" });
      const starts = yield* loggedGit(`${aside}/bin`, `${aside}/git.log`);
      const verbs = (after: number) =>
        Effect.map(starts, (lines) =>
          Arr.map(Arr.drop(lines, after), (line) => Str.split(line, " ")[0]).sort(),
        );
      const tree = yield* fingerprint(repo);
      expect(tree.head_sha).toHaveLength(40);
      expect(yield* verbs(0)).toEqual(["add", "rev-parse", "status", "write-tree"]);
      expect(yield* fingerprint(repo)).toEqual(tree);
      expect(yield* verbs(4)).toEqual(["add", "status", "write-tree"]);
    }),
  ));

test("untracked content still changes a fingerprint when status hides untracked files", () =>
  inRepository(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* git(["config", "status.showUntrackedFiles", "no"]);
      const clean = yield* fingerprint(repo);
      yield* fs.writeFileString(`${repo}/scratch.txt`, "one\n");
      const untracked = yield* fingerprint(repo);
      expect(untracked.fingerprint).not.toBe(clean.fingerprint);
      yield* fs.writeFileString(`${repo}/scratch.txt`, "two\n");
      expect((yield* fingerprint(repo)).fingerprint).not.toBe(untracked.fingerprint);
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

      yield* fs.writeFileString(path.join(repo, "tracked.txt"), "two\n");
      const unstaged = yield* fingerprint(repo);
      expect(unstaged.fingerprint).not.toBe(clean.fingerprint);

      yield* git(["add", "-A"]);
      expect((yield* fingerprint(repo)).fingerprint).toBe(unstaged.fingerprint);

      // WARNING: untracked content counts; a test that passed on an uncommitted file passed on a tree nobody else gets.
      yield* git(["checkout", "-q", "--", "."]);
      yield* git(["reset", "-q"]);
      const back = yield* fingerprint(repo);
      yield* fs.writeFileString(path.join(repo, "scratch.txt"), "a\n");
      const withUntracked = yield* fingerprint(repo);
      expect(withUntracked.fingerprint).not.toBe(back.fingerprint);
      yield* fs.writeFileString(path.join(repo, "scratch.txt"), "b\n");
      const changed = yield* fingerprint(repo);
      expect(changed.fingerprint).not.toBe(withUntracked.fingerprint);

      // WARNING: ignored files are not part of what a command sees under version control.
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

const GIT_REFUSED = "fatal: Unable to create index.lock: File exists.";

const addRefusedWhileMarked = (once: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const aside = yield* fs.makeTempDirectoryScoped({ prefix: "hw-verify-git-" });
    const marker = `${aside}/refuse-add`;
    const bin = yield* Effect.acquireRelease(FakeBin.make(`${aside}/bin`), (made) =>
      made.restore(),
    );
    yield* bin.add(
      "git",
      `if [ "$1" = add ] && [ -e "${marker}" ]; then
  echo "${GIT_REFUSED}" >&2
  ${once ? `rm "${marker}"` : ":"}
  exit 128
fi
exec "${Bun.which("git")}" "$@"`,
    );
    return marker;
  });

const touching = (marker: string) => ({
  run: "r1",
  name: "touch",
  executable: "touch",
  argv: [marker],
  cwd: repo,
  by: "agent" as const,
});

test("a tree git fails to stage once is measured on its second try, so the pass stands", () =>
  inRepository(
    Effect.gen(function* () {
      const marker = yield* addRefusedWhileMarked(true);
      const got = yield* collect(`${repo}/.run`, touching(marker));
      expect(got.result).toBe("pass");
      expect(got.end.unmeasured).toBeUndefined();
    }),
  ));

test("a tree git keeps failing to stage is unmeasured, and its snapshot keeps git's reason", () =>
  inRepository(
    Effect.gen(function* () {
      const marker = yield* addRefusedWhileMarked(false);
      const got = yield* collect(`${repo}/.run`, touching(marker));
      expect(got.result).toBe("unstable");
      expect(got.end.fingerprint).toBe(UNMEASURED);
      expect(got.end.unmeasured).toContain(GIT_REFUSED);
    }),
  ));

test("the argument list is the command; nothing is handed to a shell", () =>
  inRepository(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const runDir = path.join(repo, ".run");
      // WARNING: a shell would read this as two commands; a spawn passes it as one argument.
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
      // WARNING: a sibling whose path merely starts with the Run's is not inside it.
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

      // WARNING: the wrapper is part of what was approved; one extra word is a different command.
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

      // WARNING: a reproduction passes on its non-zero exit.
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

      // WARNING: the same command succeeding is the reproduction failing, not a fix.
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

      // WARNING: unstable beats the expectation both ways; an expected failure on a moving tree is not a reproduction.
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

const movedBy = (name: string, script: string) =>
  collect(`${repo}/.git/run-moved`, {
    run: "r1",
    name,
    executable: "sh",
    argv: ["-c", script],
    cwd: repo,
    by: "agent",
  });

test("a file created while the command runs makes it unstable, and its record names it added and untracked", () =>
  inRepository(
    Effect.gen(function* () {
      const record = yield* movedBy("creates", "echo x > created.txt");
      expect(record.result).toBe("unstable");
      expect(record.moved).toEqual([{ path: "created.txt", change: "added", class: "untracked" }]);
      const kept = yield* readVerifications(`${repo}/.git/run-moved`);
      expect(kept.at(-1)?.moved).toEqual(record.moved);
    }),
  ));

test("a tracked file edited while the command runs is named modified and tracked", () =>
  inRepository(
    Effect.gen(function* () {
      const record = yield* movedBy("edits", "echo two > tracked.txt");
      expect(record.result).toBe("unstable");
      expect(record.moved).toEqual([{ path: "tracked.txt", change: "modified", class: "tracked" }]);
    }),
  ));

test("a dependency lockfile changed while the command runs is classed as the lockfile", () =>
  inRepository(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${repo}/web`);
      yield* fs.writeFileString(`${repo}/web/package-lock.json`, "{}\n");
      yield* git(["add", "-A"]);
      yield* git(["commit", "-qm", "lock"]);
      const record = yield* movedBy(
        "installs",
        "echo '{ }' > web/package-lock.json; echo y > bun.lock",
      );
      expect(record.result).toBe("unstable");
      expect(record.moved).toEqual([
        { path: "bun.lock", change: "added", class: "lockfile" },
        { path: "web/package-lock.json", change: "modified", class: "lockfile" },
      ]);
    }),
  ));

test("an unstable verification's metric counts what moved by class", () =>
  inRepository(
    Effect.gen(function* () {
      const record = yield* movedBy(
        "everything",
        "echo two > tracked.txt; echo new > made.txt; echo y > yarn.lock",
      );
      yield* noteVerification(`${repo}/.git/run-moved`, record);
      const metric = (yield* readMetrics(`${repo}/.git/run-moved`)).at(-1);
      expect(metric).toMatchObject({
        kind: "verification",
        note: "unstable",
        moved: { tracked: 1, untracked: 1, lockfile: 1 },
      });
    }),
  ));

test("a command that moves nothing records no moved paths", () =>
  inRepository(
    Effect.gen(function* () {
      const record = yield* movedBy("still", "true");
      expect(record.result).toBe("pass");
      expect(record.moved).toBeUndefined();
    }),
  ));

test("a command killed mid-run records no pass", () =>
  inRepository(
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const runDir = path.join(repo, ".run-killed");
      const killed = yield* collect(runDir, {
        run: "r1",
        name: "killed",
        executable: "sh",
        argv: ["-c", "kill -KILL $$; sleep 5"],
        cwd: repo,
        by: "agent",
      }).pipe(Effect.result);
      if (killed._tag === "Success") {
        expect(killed.success.result).not.toBe("pass");
      }
      const recorded = yield* readVerifications(runDir).pipe(Effect.orElseSucceed(() => []));
      expect(Arr.some(recorded, (one) => one.result === "pass")).toBe(false);
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
  // WARNING: the default is what every record written before --expect meant.
  expect(resultOf(same, same, 0)).toBe("pass");
});

test("a verification is stale the moment the tree it ran on moves", () =>
  inRepository(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // WARNING: outside the repository; a journal written inside the tree would move the fingerprint of the tree it records.
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

      // WARNING: a tree nobody could measure is never one a result still speaks for.
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
      const out = (args: Array<string>) =>
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

test("a fingerprint writes nothing to the checkout's index, so it holds no lock a commit beside it would meet", () =>
  inRepository(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // WARNING: a status of git's own would write the new time to the index, so this file is touched and not edited.
      const touched = fileTime("2026-01-01T00:00:00Z");
      yield* fs.utimes(path.join(repo, "tracked.txt"), touched, touched);
      const index = path.join(repo, ".git", "index");
      const before = yield* fs.readFile(index);
      yield* fingerprint(repo);
      expect(yield* fs.readFile(index)).toEqual(before);
    }),
  ));

test("an edit of the same size, in the second its file was staged, moves the tree", () =>
  inRepository(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const file = path.join(repo, "tracked.txt");
      const index = path.join(repo, ".git", "index");
      // WARNING: a file's change time cannot be set, so the repository is one that does not read it.
      const second = fileTime("2026-01-01T00:00:00Z");
      yield* git(["config", "core.trustctime", "false"]);
      yield* fs.utimes(file, second, second);
      yield* git(["add", "-A"]);
      const before = yield* fingerprint(repo);
      yield* fs.utimes(index, second, second);
      yield* fs.writeFileString(file, "two\n");
      yield* fs.utimes(file, second, second);
      expect(sameTree(before, yield* fingerprint(repo))).toBe(false);
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

test("from a subdirectory, an edit too large anywhere in the checkout is no tree", () =>
  inRepository(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sub = path.join(repo, "sub");
      yield* fs.makeDirectory(sub);
      yield* fs.writeFileString(path.join(sub, "kept.txt"), "kept\n");
      yield* git(["add", "-A"]);
      yield* git(["commit", "-qm", "sub"]);
      expect((yield* fingerprint(sub)).fingerprint).not.toBe(TOO_LARGE);
      yield* fs.writeFileString(
        path.join(repo, "tracked.txt"),
        Str.repeat(FINGERPRINT_MAX_BYTES + 1)("a"),
      );
      expect((yield* fingerprint(sub)).fingerprint).toBe(TOO_LARGE);
    }),
  ));

test("a subdirectory that becomes a repository of its own is fingerprinted by its own index", () =>
  inRepository(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const nested = path.join(repo, "nested");
      yield* fs.makeDirectory(nested);
      yield* fingerprint(nested);
      yield* git(["init", "-q"], nested);
      yield* git(["config", "user.email", "t@example.com"], nested);
      yield* git(["config", "user.name", "t"], nested);
      yield* fs.writeFileString(path.join(nested, ".gitignore"), "forced.txt\n");
      yield* fs.writeFileString(path.join(nested, "forced.txt"), "one\n");
      yield* git(["add", "-f", ".gitignore", "forced.txt"], nested);
      yield* git(["commit", "-qm", "nested"], nested);
      const before = yield* fingerprint(nested);
      yield* fs.writeFileString(path.join(nested, "forced.txt"), "two\n");
      expect(sameTree(before, yield* fingerprint(nested))).toBe(false);
    }),
  ));

test("a worktree root replaced by a repository of its own is fingerprinted by the new index", () =>
  inRepository(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const aside = yield* fs.makeTempDirectoryScoped({ prefix: "hw-verify-moved-" });
      const live = path.join(aside, "live");
      yield* git(["worktree", "add", "-q", live]);
      yield* fingerprint(live);
      yield* git(["worktree", "move", live, path.join(aside, "moved")]);
      yield* fs.makeDirectory(live);
      yield* git(["init", "-q"], live);
      yield* git(["config", "user.email", "t@example.com"], live);
      yield* git(["config", "user.name", "t"], live);
      yield* fs.writeFileString(path.join(live, ".gitignore"), "forced.txt\n");
      yield* fs.writeFileString(path.join(live, "forced.txt"), "one\n");
      yield* git(["add", "-f", ".gitignore", "forced.txt"], live);
      yield* git(["commit", "-qm", "replacement"], live);
      const before = yield* fingerprint(live);
      yield* fs.writeFileString(path.join(live, "forced.txt"), "two\n");
      expect(sameTree(before, yield* fingerprint(live))).toBe(false);
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
      ]) {
        yield* git(args, inner);
      }
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

function nodeOptions(value: string) {
  const before = Bun.env.NODE_OPTIONS;
  Bun.env.NODE_OPTIONS = value;
  return () => {
    if (before === undefined) {
      delete Bun.env.NODE_OPTIONS;
    } else {
      Bun.env.NODE_OPTIONS = before;
    }
  };
}

const recordOf = <E, R>(found: Effect.Effect<{ readonly record: Verification | null }, E, R>) =>
  Effect.map(found, (one) => one.record);

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
      const relied = () => recordOf(reliedFor(runDir, run, spec, since));

      expect(yield* relied()).toBeNull();
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

      expect(
        yield* recordOf(reliedFor(runDir, run, { ...spec, argv: ["--bail"] }, since)),
      ).toBeNull();

      yield* fs.writeFileString(path.join(repo, "tracked.txt"), "two\n");
      expect(yield* relied()).toBeNull();
      yield* git(["checkout", "-q", "--", "."]);
      expect((yield* relied())?.id).toBe(collies.id);

      yield* fs.writeFileString(path.join(repo, "tracked.txt"), "two\n");
      const dirty = yield* runApproved(runDir, run, [spec], spec);
      yield* git(["commit", "-qam", "the verified bytes"]);
      expect((yield* relied())?.id).toBe(dirty.id);

      yield* tool(runDir, "exit 0 # upgraded");
      expect(yield* relied()).toBeNull();
    }),
  ));

test("an install into an ignored node_modules makes a record stale, and a cache written there does not", () =>
  inRepository(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runDir = yield* fs.makeTempDirectoryScoped({ prefix: "hw-verify-run-" });
      yield* fs.writeFileString(`${repo}/.gitignore`, "node_modules/\n");
      yield* fs.writeFileString(`${repo}/package.json`, "{}\n");
      yield* git(["add", "-A"]);
      yield* git(["commit", "-qm", "a package"]);
      const executable = yield* tool(runDir, `[ -d ${repo}/node_modules/left-pad ]`);
      const spec: VerifySpec = { name: "unit", executable, argv: [], cwd: "." };
      const run = { id: "r1", cwd: repo, worktree: null };
      const since = "2000-01-01T00:00:00.000Z";
      const recorded = () => recordOf(recordFor(runDir, run, spec, since));

      const failed = yield* runApproved(runDir, run, [spec], spec);
      expect(failed.result).toBe("fail");
      expect((yield* recorded())?.id).toBe(failed.id);

      const before = yield* fingerprint(repo);
      yield* fs.makeDirectory(`${repo}/node_modules/left-pad`, { recursive: true });
      yield* fs.writeFileString(`${repo}/node_modules/left-pad/package.json`, "{}\n");
      expect(yield* fingerprint(repo)).toEqual(before);
      expect(yield* recorded()).toBeNull();

      const installed = yield* runApproved(runDir, run, [spec], spec);
      expect(installed.result).toBe("pass");
      yield* fs.makeDirectory(`${repo}/node_modules/.cache`);
      yield* fs.writeFileString(`${repo}/node_modules/.cache/results.json`, "{}\n");
      expect((yield* recorded())?.id).toBe(installed.id);
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
      expect(yield* recordOf(reliedFor(runDir, run, spec, since))).toBeNull();

      yield* collect(runDir, {
        run: "r1",
        name: "t",
        executable,
        argv: [],
        cwd: repo,
        by: "agent",
        expect: "fail",
      });
      expect(yield* recordOf(reliedFor(runDir, run, spec, since))).toBeNull();

      yield* appendVerification(runDir, { ...passed, id: "again" });
      expect((yield* recordOf(reliedFor(runDir, run, spec, since)))?.id).toBe("again");
      // WARNING: the record was collected before this host started.
      expect(yield* recordOf(reliedFor(runDir, run, spec, "2999-01-01T00:00:00.000Z"))).toBeNull();

      const { environment: _, ...older } = passed;
      yield* appendVerification(runDir, { ...older, id: "older" });
      expect(yield* recordOf(reliedFor(runDir, run, spec, since))).toBeNull();
    }),
  ));

const passedOnce = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const runDir = yield* fs.makeTempDirectoryScoped({ prefix: "hw-verify-run-" });
  const executable = yield* tool(runDir, "exit 0");
  const spec: VerifySpec = { name: "unit", executable, argv: [], cwd: "." };
  const run = { id: "r1", cwd: repo, worktree: null };
  const since = "2000-01-01T00:00:00.000Z";
  const lookup = (asked = spec, from = since) => recordFor(runDir, run, asked, from);
  return { runDir, spec, run, lookup, ran: runApproved(runDir, run, [spec], spec) };
});

test("a check with no record on the Run is not reused because there is none", () =>
  inRepository(
    Effect.gen(function* () {
      const { lookup } = yield* passedOnce;
      expect(yield* lookup()).toEqual({ record: null, miss: { reason: "none" } });
    }),
  ));

test("a check whose command changed is not reused because the command differs, naming its last record", () =>
  inRepository(
    Effect.gen(function* () {
      const { lookup, spec, ran } = yield* passedOnce;
      const passed = yield* ran;
      expect(yield* lookup({ ...spec, argv: ["--bail"] })).toEqual({
        record: null,
        miss: { reason: "command", record: passed.id },
      });
    }),
  ));

test("a check whose tree moved is not reused because the tree differs, naming its last record", () =>
  inRepository(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { lookup, ran } = yield* passedOnce;
      const passed = yield* ran;
      yield* fs.writeFileString(`${repo}/tracked.txt`, "two\n");
      expect(yield* lookup()).toEqual({
        record: null,
        miss: { reason: "tree", record: passed.id },
      });
    }),
  ));

test("a check recorded in another environment is not reused because the environment differs", () =>
  inRepository(
    Effect.gen(function* () {
      const { lookup, runDir, ran } = yield* passedOnce;
      const passed = yield* ran;
      yield* appendVerification(runDir, { ...passed, id: "elsewhere", environment: "other" });
      expect(yield* lookup()).toEqual({
        record: null,
        miss: { reason: "environment", record: "elsewhere" },
      });
    }),
  ));

test("a check whose latest record on the tree is unstable is not reused because it is unstable", () =>
  inRepository(
    Effect.gen(function* () {
      const { lookup, runDir, ran } = yield* passedOnce;
      const passed = yield* ran;
      yield* appendVerification(runDir, { ...passed, id: "moved", result: "unstable" });
      expect(yield* lookup()).toEqual({
        record: null,
        miss: { reason: "unstable", record: "moved" },
      });
    }),
  ));

test("a check collected before this host started is not reused, and says so", () =>
  inRepository(
    Effect.gen(function* () {
      const { lookup, spec, ran } = yield* passedOnce;
      const passed = yield* ran;
      expect(yield* lookup(spec, "2999-01-01T00:00:00.000Z")).toEqual({
        record: null,
        miss: { reason: "before-host", record: passed.id },
      });
    }),
  ));

test("a command whose latest record on the tree expected red is not reused because of it, naming that record", () =>
  inRepository(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const runDir = yield* fs.makeTempDirectoryScoped({ prefix: "hw-verify-run-" });
      const executable = yield* tool(runDir, "exit 1");
      const command = { name: "unit", executable, argv: [], cwd: repo };
      const red = yield* collect(runDir, { ...command, run: "r1", by: "agent", expect: "fail" });
      expect(
        yield* recordedFor(runDir, { ...command, expect: "pass" }, "2000-01-01T00:00:00.000Z"),
      ).toEqual({ record: null, miss: { reason: "unstable", record: red.id } });
    }),
  ));

const isolation = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const notes = yield* fs.makeTempDirectoryScoped({ prefix: "hw-verify-notes-" });
  const checkouts = yield* fs.makeTempDirectoryScoped({ prefix: "hw-verify-checkouts-" });
  const ran = (
    script: string,
    isolated: {
      readonly prepare?: { executable: string; argv: ReadonlyArray<string> };
    } | null = {},
    expect: "pass" | "fail" = "pass",
  ) =>
    collect(`${notes}/run`, {
      run: "r1",
      name: "isolated",
      executable: "sh",
      argv: ["-c", script],
      cwd: repo,
      by: "agent",
      expect,
      ...(isolated !== null && { isolated: { checkouts, ...isolated } }),
    });
  return { notes, checkouts, ran };
});

test("a command held while a tracked file is edited passes isolated, bound to its start tree, and is unstable in the Worktree", () =>
  inRepository(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { notes, ran } = yield* isolation;
      const editedWhileHeld = (isolated: boolean) =>
        Effect.gen(function* () {
          yield* fs.remove(`${notes}/started`, { force: true });
          yield* fs.remove(`${notes}/go`, { force: true });
          yield* fs.writeFileString(`${repo}/tracked.txt`, "one\n");
          const start = yield* fingerprint(repo);
          const running = yield* Effect.forkScoped(
            ran(
              `touch ${notes}/started; while [ ! -f ${notes}/go ]; do sleep 0.02; done`,
              isolated ? {} : null,
            ),
          );
          yield* until(() => fs.exists(`${notes}/started`), Boolean);
          yield* fs.writeFileString(`${repo}/tracked.txt`, "edited\n");
          yield* fs.writeFileString(`${notes}/go`, "");
          return { start, record: yield* Fiber.join(running) };
        });

      const inWorktree = yield* editedWhileHeld(false);
      expect(inWorktree.record.result).toBe("unstable");

      const isolated = yield* editedWhileHeld(true);
      expect(isolated.record.result).toBe("pass");
      expect(isolated.record.start).toEqual(isolated.start);
      expect(isolated.record.end.fingerprint).toBe(isolated.start.fingerprint);
      expect(isolated.record.cwd).toBe(repo);
    }),
  ));

test("an isolated checkout has the Worktree's untracked files and none of its ignored ones", () =>
  inRepository(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { notes, checkouts, ran } = yield* isolation;
      yield* fs.writeFileString(`${repo}/untracked.txt`, "new\n");
      yield* fs.makeDirectory(`${repo}/ignored`);
      yield* fs.writeFileString(`${repo}/ignored/dep.txt`, "installed\n");
      const record = yield* ran(
        `pwd > ${notes}/where; test -f untracked.txt && test ! -e ignored/dep.txt`,
      );
      expect(record.result).toBe("pass");
      const where = Str.trim(yield* fs.readFileString(`${notes}/where`));
      expect(pipe_(where, Str.startsWith(`${checkouts}/`))).toBe(true);
    }),
  ));

test("an isolated check's prepare runs first in its checkout and is recorded with it", () =>
  inRepository(
    Effect.gen(function* () {
      const { ran } = yield* isolation;
      const prepare = { executable: "sh", argv: ["-c", "mkdir -p ignored && touch ignored/dep"] };
      const record = yield* ran("test -f ignored/dep", { prepare });
      expect(record.result).toBe("pass");
      expect(record.isolated?.prepare).toMatchObject({ ...prepare, exit: 0 });
      expect(record.stage).toBeUndefined();
    }),
  ));

test("a failing prepare records the check failed at stage prepare, without running it, even where a failure was expected", () =>
  inRepository(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { notes, ran } = yield* isolation;
      const prepare = { executable: "sh", argv: ["-c", "exit 3"] };
      for (const expect_ of ["pass", "fail"] as const) {
        const record = yield* ran(`touch ${notes}/ran`, { prepare }, expect_);
        expect(record.result).toBe("fail");
        expect(record.stage).toBe("prepare");
        expect(record.exit).toBe(3);
        expect(record.isolated?.prepare?.exit).toBe(3);
      }
      expect(yield* fs.exists(`${notes}/ran`)).toBe(false);
    }),
  ));

for (const script of ["check.sh", "..check.sh"]) {
  test(`an isolated checkout-local executable ${script} runs from its checkout, recorded by its Worktree path`, () =>
    inRepository(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { notes, checkouts } = yield* isolation;
        yield* fs.writeFileString(`${repo}/${script}`, "#!/bin/sh\nexit 7\n");
        yield* fs.chmod(`${repo}/${script}`, 0o755);
        // WARNING: rewrites the Worktree's script after the checkout was made from it.
        const prepare = {
          executable: "sh",
          argv: ["-c", `printf '#!/bin/sh\\nexit 0\\n' > ${repo}/${script}`],
        };
        const record = yield* collect(`${notes}/run`, {
          run: "r1",
          name: "local",
          executable: `./${script}`,
          argv: [],
          cwd: repo,
          by: "agent",
          isolated: { checkouts, prepare },
        });
        expect(record.exit).toBe(7);
        expect(record.result).toBe("fail");
        expect(record.executable).toBe(`${repo}/${script}`);
      }),
    ));
}

test("two different isolated commands under one name, run at once, do not share a checkout", () =>
  inRepository(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { notes, ran } = yield* isolation;
      const held = yield* Effect.forkScoped(
        ran(`touch ${notes}/started; while [ ! -f ${notes}/go ]; do sleep 0.02; done`),
      );
      yield* until(() => fs.exists(`${notes}/started`), Boolean);
      expect((yield* ran("echo x > made.txt")).result).toBe("unstable");
      yield* fs.writeFileString(`${notes}/go`, "");
      expect((yield* Fiber.join(held)).result).toBe("pass");
    }),
  ));

test("one isolated command run at once from the repository and a directory in it does not share a checkout", () =>
  inRepository(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { notes, checkouts } = yield* isolation;
      yield* fs.makeDirectory(`${repo}/sub`);
      yield* fs.writeFileString(`${repo}/sub/here`, "");
      const ran = (cwd: string) =>
        collect(`${notes}/run`, {
          run: "r1",
          name: "isolated",
          executable: "sh",
          argv: [
            "-c",
            `if [ -f here ]; then echo x > made.txt; else touch ${notes}/started; while [ ! -f ${notes}/go ]; do sleep 0.02; done; fi`,
          ],
          cwd,
          by: "agent",
          isolated: { checkouts },
        });
      const held = yield* Effect.forkScoped(ran(repo));
      yield* until(() => fs.exists(`${notes}/started`), Boolean);
      expect((yield* ran(`${repo}/sub`)).result).toBe("unstable");
      yield* fs.writeFileString(`${notes}/go`, "");
      expect((yield* Fiber.join(held)).result).toBe("pass");
    }),
  ));

test("an isolated command that writes an untracked file into its own checkout is unstable", () =>
  inRepository(
    Effect.gen(function* () {
      const { ran } = yield* isolation;
      const record = yield* ran("echo x > made.txt");
      expect(record.result).toBe("unstable");
      expect(record.moved).toEqual([{ path: "made.txt", change: "added", class: "untracked" }]);
    }),
  ));

test("an unstable result under a source edit names --isolated in its answer, and one under a lockfile does not", () =>
  inRepository(
    Effect.gen(function* () {
      const edited = yield* movedBy("edits", "echo two > tracked.txt");
      expect(isolatedHint(edited)).toContain("--isolated");
      const installed = yield* movedBy("installs", "echo y > bun.lock");
      expect(installed.result).toBe("unstable");
      expect(isolatedHint(installed)).not.toContain("--isolated");
    }),
  ));
