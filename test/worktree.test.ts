import { afterEach, beforeEach, expect, test } from "bun:test";
import { Clock, Effect, FileSystem, Option } from "effect";
import { runEffect } from "./support/effect";
import { Rig } from "./support/recorder";
import { FakeBin } from "./support/bin";
import { branchFor, checkoutFor, mutates, pruneWorktrees, worktreeFor } from "../src/worktree";
import { RunStore } from "../src/run";
import { Herdr } from "../src/herdr";

let rig: Rig;
let bin: FakeBin;

const join = (...parts: string[]) => parts.join("/").replace(/\/+/g, "/");

const readLines = Effect.fn("worktreeTest.readLines")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(file).pipe(Effect.catch(() => Effect.succeed("")));
  return text.split("\n").filter((line) => line !== "");
});

/** Every git command the fixture was asked, and the directory it was asked in. */
const askedIn = Effect.fn("worktreeTest.askedIn")(function* () {
  const lines = yield* readLines(gitLog());
  return lines.map((line) => {
    const [cwd = "", command = ""] = line.split("\t");
    return { cwd, command };
  });
});

const asked = Effect.fn("worktreeTest.asked")(function* () {
  return (yield* askedIn()).map((call) => call.command);
});

beforeEach(() =>
  runEffect(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      bin = yield* FakeBin.make(join(rig.root, "bin"));
    }),
  ),
);

afterEach(() =>
  runEffect(
    Effect.gen(function* () {
      yield* bin.restore();
      yield* rig.close();
    }),
  ),
);

const gitLog = () => join(rig.root, "git.log");

/**
 * A `git` that answers a table of `case "$*"` patterns, refuses another table with
 * that message and a non-zero exit, and fails anything else — logging every question
 * it was asked. Every git fixture here is one of these.
 */
const fakeGitAnswering = (
  answers: Record<string, string>,
  refusals: Record<string, string> = {},
) => {
  const branches = [
    // A refusal wins over an answer for the same question: `case` takes the first
    // pattern that matches, and a test naming both means it wants the refusal.
    ...Object.entries(answers)
      .filter(([match]) => !(match in refusals))
      .map(([match, out]) => `  "${match}"*) printf '%b' "${out}" ;;`),
    // On stderr, where git writes what it will not do, so the board's line has to
    // come from there rather than from stdout.
    ...Object.entries(refusals).map(
      ([match, why]) => `  "${match}"*) printf '%b' "${why}" >&2; exit 1 ;;`,
    ),
    "  *) exit 1 ;;",
  ].join("\n");
  // The directory as well as the question: a command about the repository has to run
  // somewhere that outlives the checkout being removed.
  return bin.add(
    "git",
    `printf '%s\\t%s\\n' "$PWD" "$*" >> "${gitLog()}"\ncase "$*" in\n${branches}\nesac`,
  );
};

/**
 * A git where only the default branch — and whatever else is named — exists on the
 * remote, so new work is cut from the default branch and a reviewed branch from its
 * own tip.
 */
const fakeGit = (branch = "add-picker", remoteBranches: string[] = []) =>
  fakeGitAnswering({
    // The project this checkout belongs to, which is what an `mr:` target is checked
    // against before anything works on its branch.
    "remote get-url origin": "git@gitlab.example.com:acme/app.git",
    "symbolic-ref --short refs/remotes/origin/HEAD": "origin/master",
    // Both shapes the module asks a ref about: what a new checkout is cut from, and
    // whether the ref is a branch at all.
    ...Object.fromEntries(
      ["master", ...remoteBranches].flatMap((ref) => [
        [`rev-parse --verify origin/${ref}`, "deadbeef"],
        [`rev-parse --verify --quiet refs/remotes/origin/${ref}`, "deadbeef"],
      ]),
    ),
    "rev-parse --abbrev-ref HEAD": branch,
  });

const plan = (inputs: Record<string, string>, explicit?: string) =>
  branchFor({ cwd: rig.projectDir, name: "Add a picker", inputs, explicit });

test("only the workflows that change the repository get a checkout of their own", () => {
  expect(mutates("implement")).toBe(true);
  expect(mutates("review")).toBe(false);
  expect(mutates("plan")).toBe(false);
});

test("a run described in words branches off the default branch, named from its slug", () =>
  runEffect(
    Effect.gen(function* () {
      yield* fakeGit();

      expect(yield* plan({ plan_kind: "text" })).toEqual({
        branch: "add-a-picker",
        base: "origin/master",
        refused: null,
      });
    }),
  ));

test("an explicit branch beats every inference", () =>
  runEffect(
    Effect.gen(function* () {
      yield* fakeGit();

      expect(yield* plan({ plan_kind: "text" }, "hand-picked")).toMatchObject({
        branch: "hand-picked",
      });
    }),
  ));

test("a review of a merge request takes that merge request's own branch", () =>
  runEffect(
    Effect.gen(function* () {
      yield* fakeGit("add-picker", ["fix-the-parser"]);
      yield* bin.add("glab", `echo '{"source_branch": "fix-the-parser"}'`);

      expect(
        yield* plan({
          plan_kind: "review",
          target: "mr:gitlab.example.com/acme/app!42",
          target_kind: "mr",
        }),
      ).toMatchObject({ branch: "fix-the-parser" });
    }),
  ));

test("a review of a branch diff takes its head, and a review of a tree the branch it is on", () =>
  runEffect(
    Effect.gen(function* () {
      yield* fakeGit("on-this-one", ["their-work"]);

      expect(
        yield* plan({
          plan_kind: "review",
          target: "branch:master...their-work",
          target_kind: "branch",
        }),
      ).toMatchObject({ branch: "their-work" });
      expect(
        yield* plan({ plan_kind: "review", target: "worktree", target_kind: "worktree" }),
      ).toMatchObject({ branch: "on-this-one" });
    }),
  ));

test("a branch with a worktree is opened, and one without gets a new one", () =>
  runEffect(
    Effect.gen(function* () {
      const herdr = new Herdr(rig.pluginEnv());
      const made = yield* worktreeFor(herdr, {
        cwd: rig.projectDir,
        branch: "add-picker",
        base: "origin/master",
        label: "⚙ implement · add-picker",
      });

      expect(made.worktree).toMatchObject({ branch: "add-picker", created_by_collie: true });
      expect(made.worktree.path).toEndWith("/worktrees/add-picker");

      const again = yield* worktreeFor(herdr, {
        cwd: rig.projectDir,
        branch: "add-picker",
        base: "origin/master",
      });
      expect(again.worktree).toMatchObject({
        path: made.worktree.path,
        created_by_collie: false,
      });
      expect(yield* rig.cmds()).toEqual([
        "worktree list",
        "worktree create",
        "worktree list",
        "worktree open",
      ]);
      // Never a label on `open`: that renames whatever workspace it opens.
      const opened = (yield* rig.calls()).find((call) => call.cmd === "worktree open");
      expect(opened?.argv).not.toContain("--label");
    }),
  ));

test("two unrelated runs never share a checkout", () =>
  runEffect(
    Effect.gen(function* () {
      const herdr = new Herdr(rig.pluginEnv());
      const one = yield* worktreeFor(herdr, { cwd: rig.projectDir, branch: "one" });
      const two = yield* worktreeFor(herdr, { cwd: rig.projectDir, branch: "two" });

      expect(one.worktree.path).not.toBe(two.worktree.path);
      expect(one.worktree.workspace_id).not.toBe(two.worktree.workspace_id);
    }),
  ));

/** A worktree Collie made, as its run record and herdr's list would show it. */
const collieWorktree = (branch: string, workspaceId = "w7") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const worktreePath = join(rig.root, "worktrees", branch);
    yield* rig.addWorktree(branch, worktreePath, workspaceId);
    // What the run recorded when it made this checkout, which is how pruning knows it
    // is still the same one.
    const madeAt = yield* fs.stat(`${worktreePath}/.git`);
    const run = yield* new RunStore(rig.stateDir).create({
      workflow: "implement",
      cwd: worktreePath,
      inputs: {},
      inputSources: {},
      stepIds: ["build"],
      maxIterations: 1,
      primaryInput: branch,
      worktree: {
        path: worktreePath,
        branch,
        created_by_collie: true,
        workspace_id: workspaceId,
        made_at: madeAt.mtime.pipe(Option.getOrNull)?.getTime() ?? null,
      },
    });
    run.record.status = "done";
    yield* run.save();
    return worktreePath;
  });

/**
 * A git that answers every question the settled rule asks. Each case can be
 * overridden to make exactly one condition fail.
 */
const settledGit = (
  overrides: Record<string, string> = {},
  refusals: Record<string, string> = {},
) =>
  fakeGitAnswering(
    {
      "status --porcelain": "",
      "rev-parse --abbrev-ref --symbolic-full-name @{u}": "origin/wt",
      "rev-list @{u}..HEAD": "",
      "ls-remote --heads origin": "",
      "branch -d": "Deleted branch.",
      ...overrides,
    },
    refusals,
  );

const mergedMr = () => bin.add("glab", `echo '{"state": "merged", "iid": 14}'`);

const prune = () =>
  pruneWorktrees({
    herdr: new Herdr(rig.pluginEnv()),
    stateDir: rig.stateDir,
    cwd: rig.projectDir,
  });

test("a settled worktree is removed, and the board says why", () =>
  runEffect(
    Effect.gen(function* () {
      yield* collieWorktree("wt");
      yield* settledGit();
      yield* mergedMr();

      expect(yield* prune()).toEqual(["♻ removed wt · merged in !14"]);
      // Through herdr, so the workspace goes with the checkout, and never forced.
      const calls = (yield* rig.calls()).filter((c) => c.cmd === "worktree remove");
      expect(calls.at(0)?.argv).toEqual(["worktree", "remove", "--workspace", "w7"]);
    }),
  ));

test("uncommitted work keeps a worktree, and so does anything unpushed", () =>
  runEffect(
    Effect.gen(function* () {
      yield* collieWorktree("wt");
      yield* mergedMr();
      yield* settledGit({ "status --porcelain": " M src/main.ts" });

      expect(yield* prune()).toEqual(["kept wt · uncommitted changes"]);
      expect((yield* rig.cmds()).includes("worktree remove")).toBe(false);
    }),
  ));

test("a branch with commits the remote has not seen keeps its worktree", () =>
  runEffect(
    Effect.gen(function* () {
      yield* collieWorktree("wt");
      yield* mergedMr();
      yield* settledGit({ "rev-list @{u}..HEAD": "a1\\nb2" });

      expect(yield* prune()).toEqual(["kept wt · 2 commit(s) unpushed"]);
    }),
  ));

test("with no upstream and no default branch to compare against, the checkout stays", () =>
  runEffect(
    Effect.gen(function* () {
      yield* collieWorktree("wt");
      yield* mergedMr();
      // No upstream, and this git cannot say what the default branch is either, so
      // there is nothing to establish that the commits here exist anywhere else.
      yield* settledGit({ "rev-parse --abbrev-ref --symbolic-full-name @{u}": "" });

      expect(yield* prune()).toEqual(["kept wt · no upstream to compare against"]);
    }),
  ));

test("a worktree an agent is working in keeps it", () =>
  runEffect(
    Effect.gen(function* () {
      const worktreePath = yield* collieWorktree("wt");
      yield* settledGit();
      yield* mergedMr();
      yield* rig.addPane("1-9", "1:9", worktreePath, "claude");

      expect(yield* prune()).toEqual(["kept wt · an agent is working in it"]);
    }),
  ));

test("an open merge request keeps the worktree it was built in", () =>
  runEffect(
    Effect.gen(function* () {
      yield* collieWorktree("wt");
      yield* settledGit();
      yield* bin.add("glab", `echo '{"state": "opened", "iid": 14}'`);

      expect(yield* prune()).toEqual(["kept wt · !14 is still open"]);
    }),
  ));

test("with no merge request, a branch still on the remote keeps its worktree", () =>
  runEffect(
    Effect.gen(function* () {
      yield* collieWorktree("wt");
      yield* bin.add("glab", `exit 1`);
      yield* settledGit({ "ls-remote --heads origin": "deadbeef refs/heads/wt" });

      expect(yield* prune()).toEqual(["kept wt · still on the remote"]);
    }),
  ));

test("a worktree Collie did not create is never touched, settled or not", () =>
  runEffect(
    Effect.gen(function* () {
      yield* rig.addWorktree("by-hand", join(rig.root, "elsewhere"), "w9");
      yield* settledGit();
      yield* mergedMr();

      expect(yield* prune()).toEqual([]);
      expect((yield* rig.cmds()).includes("worktree remove")).toBe(false);
    }),
  ));

test("a worktree is not re-checked on every refresh", () =>
  runEffect(
    Effect.gen(function* () {
      yield* collieWorktree("wt");
      yield* mergedMr();
      yield* settledGit({ "status --porcelain": " M src/main.ts" });

      expect(yield* prune()).toEqual(["kept wt · uncommitted changes"]);
      const before = (yield* asked()).length;
      expect(before).toBeGreaterThan(0);
      // The same answer, from what the last check recorded rather than from git again.
      expect(yield* prune()).toEqual(["kept wt · uncommitted changes"]);
      expect((yield* asked()).length).toBe(before);
    }),
  ));

test("a checkout herdr will not remove is kept, in the words it refused with", () =>
  runEffect(
    Effect.gen(function* () {
      const worktreePath = yield* collieWorktree("wt", "");
      yield* settledGit();
      yield* mergedMr();
      // No workspace open on it, so it is opened again to be removed — and herdr
      // refuses, passing on what git told it.
      const herdr = new Herdr(
        rig.pluginEnv({
          FAKE_HERDR_FAIL: `{"worktree remove":"fatal: ${worktreePath} contains modified files"}`,
        }),
      );

      expect(yield* pruneWorktrees({ herdr, stateDir: rig.stateDir, cwd: rig.projectDir })).toEqual(
        [
          `kept wt · herdr worktree remove failed (exit 1): fatal: ${worktreePath} contains modified files`,
        ],
      );
      // Never git behind herdr's back: herdr owns every worktree's whole life.
      expect(yield* asked()).not.toContain(`worktree remove ${worktreePath}`);
      // And the branch is only ever deleted once the checkout has actually gone.
      expect(yield* asked()).not.toContain("branch -d wt");
    }),
  ));

test("a checkout whose workspace was closed is opened again to be removed", () =>
  runEffect(
    Effect.gen(function* () {
      yield* collieWorktree("wt", "");
      yield* settledGit();
      yield* mergedMr();

      expect(yield* prune()).toEqual(["♻ removed wt · merged in !14"]);
      // Opened for the removal, then removed through herdr, never around it.
      expect((yield* rig.cmds()).filter((cmd) => cmd.startsWith("worktree"))).toEqual([
        "worktree list",
        "worktree open",
        "worktree remove",
      ]);
    }),
  ));

test("a run starting in a checkout keeps it; its own board may still remove it", () =>
  runEffect(
    Effect.gen(function* () {
      const worktreePath = yield* collieWorktree("wt");
      yield* settledGit();
      yield* mergedMr();
      const herdr = new Herdr(rig.pluginEnv());

      // A `run start` from inside that checkout is about to work there.
      expect(
        yield* pruneWorktrees({
          herdr,
          stateDir: rig.stateDir,
          cwd: worktreePath,
          keep: worktreePath,
        }),
      ).toEqual(["kept wt · a run is starting in it"]);
      expect((yield* rig.cmds()).includes("worktree remove")).toBe(false);

      // The Control Plane of that same workspace holds nothing: a merged branch's
      // checkout goes, and herdr closes the workspace showing it.
      expect(
        yield* pruneWorktrees({
          herdr,
          stateDir: rig.stateDir,
          cwd: worktreePath,
          now: (yield* Clock.currentTimeMillis) + 10 * 60_000,
        }),
      ).toEqual(["♻ removed wt · merged in !14"]);
    }),
  ));

test("a herdr that will not list panes judges nothing, and says so", () =>
  runEffect(
    Effect.gen(function* () {
      yield* collieWorktree("wt");
      yield* settledGit();
      yield* mergedMr();
      // A live agent's pane is the one condition nothing else can establish, so a
      // herdr that cannot be asked must not have its silence read as "none".
      const herdr = new Herdr(rig.pluginEnv({ FAKE_HERDR_FAIL: '{"pane list":"herdr is gone"}' }));

      expect(yield* pruneWorktrees({ herdr, stateDir: rig.stateDir, cwd: rig.projectDir })).toEqual(
        ["kept wt · could not ask herdr what is live"],
      );
      expect((yield* rig.cmds()).includes("worktree remove")).toBe(false);

      // Nothing was written down, so the next round asks again rather than standing on
      // a verdict it never reached.
      const herdrAgain = new Herdr(rig.pluginEnv());
      expect(
        yield* pruneWorktrees({ herdr: herdrAgain, stateDir: rig.stateDir, cwd: rig.projectDir }),
      ).toEqual(["♻ removed wt · merged in !14"]);
    }),
  ));

test("a run still marked running keeps its checkout, driver or no driver", () =>
  runEffect(
    Effect.gen(function* () {
      const worktreePath = yield* collieWorktree("wt");
      const store = new RunStore(rig.stateDir);
      const run = (yield* store.list())[0]!;
      // Nothing is driving it — no claim was ever written — and it is still running.
      run.record.status = "running";
      yield* run.save();
      yield* settledGit();
      yield* mergedMr();

      expect(
        yield* pruneWorktrees({
          herdr: new Herdr(rig.pluginEnv()),
          stateDir: rig.stateDir,
          cwd: rig.projectDir,
        }),
      ).toEqual(["kept wt · a run could still be resumed in it"]);
      expect(worktreePath).toContain("wt");
    }),
  ));

test("a review of a merge request whose branch is only on the remote is cut from it", () =>
  runEffect(
    Effect.gen(function* () {
      yield* fakeGit("somewhere-else", ["fix-the-parser"]);
      yield* bin.add("glab", `echo '{"source_branch": "fix-the-parser"}'`);

      // Not the default branch: a fix round has to continue the work it is fixing.
      expect(
        yield* plan({
          plan_kind: "review",
          target: "mr:gitlab.example.com/acme/app!42",
          target_kind: "mr",
        }),
      ).toEqual({ branch: "fix-the-parser", base: "origin/fix-the-parser", refused: null });
    }),
  ));

test("a checkout Collie cannot be given is a run that does not start", () =>
  runEffect(
    Effect.gen(function* () {
      yield* fakeGit();
      const herdr = new Herdr(
        rig.pluginEnv({ FAKE_HERDR_FAIL: '{"worktree list":"unknown command"}' }),
      );

      const checkout = yield* checkoutFor(herdr, {
        cwd: rig.projectDir,
        workflow: "implement",
        name: "Add a picker",
        inputs: { plan_kind: "text" },
        workspaceId: "wT",
      });

      // Never the caller's own checkout: sharing one is the bug this exists to stop.
      expect(checkout.refused).toContain("no worktree for add-a-picker");
      expect(checkout.worktree).toBe(null);
      expect(checkout.cwd).toBe(rig.projectDir);
    }),
  ));

test("a workflow that changes nothing works where it was started, and is not refused", () =>
  runEffect(
    Effect.gen(function* () {
      const checkout = yield* checkoutFor(new Herdr(rig.pluginEnv()), {
        cwd: rig.projectDir,
        workflow: "review",
        name: "!42",
        inputs: {},
        workspaceId: "wT",
        workspaceLabel: "Collie",
      });

      expect(checkout).toEqual({
        cwd: rig.projectDir,
        workspaceId: "wT",
        workspaceLabel: "Collie",
        worktree: null,
        note: "",
        refused: null,
      });
      expect(yield* rig.cmds()).toEqual([]);
    }),
  ));

test("a merge request Collie cannot read is a run that does not start", () =>
  runEffect(
    Effect.gen(function* () {
      yield* fakeGit("some-other-branch");
      yield* bin.add("glab", `exit 1`);

      // Never `slugify(name)`: the fixes belong on the branch that was reviewed, and a
      // new branch named after the run would leave the merge request untouched.
      expect(
        yield* plan({ plan_kind: "review", target: "mr:42", target_kind: "mr" }),
      ).toMatchObject({ refused: "glab could not read !42" });
    }),
  ));

test("a merge request in another project cannot be fixed from this checkout", () =>
  runEffect(
    Effect.gen(function* () {
      yield* fakeGitAnswering({
        "remote get-url origin": "git@gitlab.example.com:acme/app.git",
        "symbolic-ref --short refs/remotes/origin/HEAD": "origin/master",
      });
      // glab would answer, but a worktree of this repository is not a checkout of theirs.
      yield* bin.add("glab", `echo '{"source_branch": "theirs"}'`);

      expect(
        yield* plan({
          plan_kind: "review",
          target: "mr:gitlab.example.com/other/thing!7",
          target_kind: "mr",
        }),
      ).toMatchObject({
        refused:
          "!7 is in gitlab.example.com/other/thing, and this is a checkout of gitlab.example.com/acme/app",
      });
    }),
  ));

test("an agent working in a subdirectory of a checkout keeps it", () =>
  runEffect(
    Effect.gen(function* () {
      const worktreePath = yield* collieWorktree("wt");
      yield* settledGit();
      yield* mergedMr();
      // Not the checkout itself: agents work in the directories under it.
      yield* rig.addPane("1-9", "1:9", `${worktreePath}/src`, "claude");

      expect(yield* prune()).toEqual(["kept wt · an agent is working in it"]);
    }),
  ));

test("an agent in the checkout's own workspace keeps it, directory or no directory", () =>
  runEffect(
    Effect.gen(function* () {
      yield* collieWorktree("wt", "w7");
      yield* settledGit();
      yield* mergedMr();
      // herdr reports some panes without a cwd; the workspace it is in is the evidence.
      yield* rig.addPane("1-9", "1:9", "", "claude", "w7");

      expect(yield* prune()).toEqual(["kept wt · an agent is working in it"]);
    }),
  ));

test("a hand-made checkout at the path a Collie one used is not a candidate", () =>
  runEffect(
    Effect.gen(function* () {
      const worktreePath = yield* collieWorktree("wt");
      // The Collie worktree was removed by hand and the path reused for another branch.
      yield* rig.setWorktrees([{ branch: "by-hand", path: worktreePath, open_workspace_id: "w9" }]);
      yield* settledGit();
      yield* mergedMr();

      expect(yield* prune()).toEqual([]);
      expect((yield* rig.cmds()).includes("worktree remove")).toBe(false);
    }),
  ));

test("a merged branch whose remote-tracking ref was pruned away is settled", () =>
  runEffect(
    Effect.gen(function* () {
      yield* collieWorktree("wt");
      yield* mergedMr();
      // `git fetch --prune` took the upstream ref with the branch; everything this
      // checkout holds is in the default branch already.
      yield* settledGit({
        "rev-parse --abbrev-ref --symbolic-full-name @{u}": "",
        "symbolic-ref --short refs/remotes/origin/HEAD": "origin/master",
        "rev-list origin/master..HEAD": "",
      });

      expect(yield* prune()).toEqual(["♻ removed wt · merged in !14"]);
    }),
  ));

test("without an upstream, a commit that is on no other branch keeps the checkout", () =>
  runEffect(
    Effect.gen(function* () {
      yield* collieWorktree("wt");
      yield* mergedMr();
      yield* settledGit({
        "rev-parse --abbrev-ref --symbolic-full-name @{u}": "",
        "symbolic-ref --short refs/remotes/origin/HEAD": "origin/master",
        "rev-list origin/master..HEAD": "c1\\nc2",
      });

      expect(yield* prune()).toEqual(["kept wt · 2 commit(s) on no branch but this one"]);
    }),
  ));

test("the branch is deleted from the repository's own checkout, not the one that went", () =>
  runEffect(
    Effect.gen(function* () {
      const worktreePath = yield* collieWorktree("wt");
      yield* settledGit();
      yield* mergedMr();

      expect(yield* prune()).toEqual(["♻ removed wt · merged in !14"]);
      // The removed checkout no longer exists, so a command run there cannot work.
      const deleted = (yield* askedIn()).filter((call) => call.command === "branch -d wt");
      expect(deleted).toHaveLength(1);
      expect(deleted[0]?.cwd).not.toBe(worktreePath);
      expect(deleted[0]?.cwd).toBe(rig.projectDir);
    }),
  ));

test("a diff of two refs that are not branches has nothing to fix on", () =>
  runEffect(
    Effect.gen(function* () {
      yield* fakeGit("on-this-one");

      // `branch:main...HEAD` is a perfectly good thing to review, and `HEAD` is not
      // even a legal branch name — so there is nothing to commit fixes to.
      expect(
        yield* plan({ plan_kind: "review", target: "branch:main...HEAD", target_kind: "branch" }),
      ).toMatchObject({ refused: "HEAD is not a branch, so there is nothing to fix on it" });
      expect(
        yield* plan({
          plan_kind: "review",
          target: "branch:1a2b3c4...9f8e7d6",
          target_kind: "branch",
        }),
      ).toMatchObject({ refused: "9f8e7d6 is not a branch, so there is nothing to fix on it" });
    }),
  ));

test("a run left blocked keeps the checkout a resume would restart it in", () =>
  runEffect(
    Effect.gen(function* () {
      yield* collieWorktree("wt");
      const run = (yield* new RunStore(rig.stateDir).list())[0]!;
      // A Choice nobody answered, or an agent that stopped: `run resume` picks this up
      // again, in the directory it recorded.
      run.record.status = "blocked";
      run.step("build").status = "pending";
      yield* run.save();
      yield* settledGit();
      yield* mergedMr();

      expect(yield* prune()).toEqual(["kept wt · a run could still be resumed in it"]);
    }),
  ));

test("an agent that started elsewhere and moved into a checkout keeps it", () =>
  runEffect(
    Effect.gen(function* () {
      const worktreePath = yield* collieWorktree("wt");
      yield* settledGit();
      yield* mergedMr();
      // Started in the repository, `cd`-ed into the worktree: herdr reports both, and
      // the second one is where the work is.
      yield* rig.addPane("1-9", "1:9", rig.projectDir, "claude", "1", worktreePath);

      expect(yield* prune()).toEqual(["kept wt · an agent is working in it"]);
    }),
  ));

test("with no upstream, a branch the remote still has is kept", () =>
  runEffect(
    Effect.gen(function* () {
      yield* collieWorktree("wt");
      // No merge request to settle it, so the remote branch is the question — and a
      // checkout whose branch is still there is not settled, upstream ref or no.
      yield* bin.add("glab", `exit 1`);
      yield* settledGit({
        "rev-parse --abbrev-ref --symbolic-full-name @{u}": "",
        "symbolic-ref --short refs/remotes/origin/HEAD": "origin/master",
        "rev-list origin/master..HEAD": "",
        "ls-remote --heads origin": "deadbeef refs/heads/wt",
      });

      expect(yield* prune()).toEqual(["kept wt · still on the remote"]);
    }),
  ));

test("one repository's board neither forgets nor reports another's", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* collieWorktree("wt");
      yield* mergedMr();
      yield* settledGit({ "status --porcelain": " M src/main.ts" });

      // This repository is holding one checkout, and says so.
      expect(yield* prune()).toEqual(["kept wt · uncommitted changes"]);

      // Another repository's board, sweeping the same installation's state file: it
      // has nothing of its own to say, and it leaves the other's verdict alone.
      const elsewhere = join(rig.root, "another-repo");
      yield* fs.makeDirectory(elsewhere, { recursive: true });
      yield* rig.setWorktrees([]);
      expect(
        yield* pruneWorktrees({
          herdr: new Herdr(rig.pluginEnv()),
          stateDir: rig.stateDir,
          cwd: elsewhere,
        }),
      ).toEqual([]);

      const kept = yield* fs.readFileString(join(rig.stateDir, "worktrees.json"));
      expect(kept).toContain("kept wt · uncommitted changes");
      expect(kept).toContain(rig.projectDir);
    }),
  ));

test("a branch git will not delete is a removal that keeps saying so", () =>
  runEffect(
    Effect.gen(function* () {
      yield* collieWorktree("wt");
      yield* mergedMr();
      yield* settledGit({}, { "branch -d": "error: the branch 'wt' is not fully merged" });

      // The checkout went, so this is a removal — and what is left to look at is the
      // branch, in git's own words.
      expect(yield* prune()).toEqual([
        "♻ removed wt · branch wt kept: error: the branch 'wt' is not fully merged",
      ]);

      // The path is not listed any more, and it would be forgotten at once if this had
      // been recorded as a checkout still being held. It is news instead.
      expect(yield* prune()).toEqual([
        "♻ removed wt · branch wt kept: error: the branch 'wt' is not fully merged",
      ]);
    }),
  ));

test("a run chained from inside a worktree still opens the branch's checkout", () =>
  runEffect(
    Effect.gen(function* () {
      const herdr = new Herdr(rig.pluginEnv());
      // A fix round is started by a run whose own cwd is a worktree, and herdr refuses
      // `worktree open` and `create` from a linked one — so both have to be asked from
      // the repository's own checkout, which is what `worktree list` answers with.
      const first = yield* worktreeFor(herdr, { cwd: rig.projectDir, branch: "add-picker" });
      const chained = yield* worktreeFor(herdr, {
        cwd: first.worktree.path,
        branch: "add-picker",
      });

      expect(chained.worktree).toMatchObject({
        path: first.worktree.path,
        created_by_collie: false,
      });
      const opens = (yield* rig.calls()).filter((call) => call.cmd === "worktree open");
      expect(opens.at(0)?.argv).toEqual([
        "worktree",
        "open",
        "--cwd",
        rig.projectDir,
        "--path",
        first.worktree.path,
        "--no-focus",
      ]);
    }),
  ));

test("a reviewed branch that is not on the remote at all is refused", () =>
  runEffect(
    Effect.gen(function* () {
      yield* fakeGit();
      yield* bin.add("glab", `echo '{"source_branch": "long-gone"}'`);

      // Cutting it from the default branch would build something unrelated and then
      // fail to push it, or push it over the branch that was reviewed.
      expect(
        yield* plan({
          plan_kind: "review",
          target: "mr:gitlab.example.com/acme/app!42",
          target_kind: "mr",
        }),
      ).toMatchObject({
        refused: "long-gone is not on the remote, so there is no reviewed work to fix",
      });
      // A checkout that has simply never fetched the branch is the common case, so it
      // is asked for before anything is refused.
      expect(yield* asked()).toContain("fetch origin long-gone");
    }),
  ));

test("a checkout with no GitLab remote cannot be shown to be the reviewed project", () =>
  runEffect(
    Effect.gen(function* () {
      // A group folder, or a checkout with no remote: nothing here says the merge
      // request belongs to it, and a bare `mr:42` came from this remote in the first
      // place.
      yield* fakeGitAnswering({ "symbolic-ref --short refs/remotes/origin/HEAD": "origin/master" });
      yield* bin.add("glab", `echo '{"source_branch": "theirs"}'`);

      expect(
        yield* plan({
          plan_kind: "review",
          target: "mr:gitlab.example.com/acme/app!42",
          target_kind: "mr",
        }),
      ).toMatchObject({
        refused: `${rig.projectDir} has no GitLab remote, so !42 may not be its own`,
      });
    }),
  ));

test("a checkout made again by hand at the same path and branch is not a candidate", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const worktreePath = yield* collieWorktree("wt");
      yield* settledGit();
      yield* mergedMr();

      // Collie's checkout was removed by hand, and a human made their own at the same
      // path on the same branch. Path and branch match the old run record; the moment
      // git wrote the checkout does not.
      yield* Effect.promise(() => Bun.sleep(10));
      yield* fs.writeFileString(`${worktreePath}/.git`, `gitdir: ${worktreePath}/.gitdir\n`);

      expect(yield* prune()).toEqual([]);
      expect((yield* rig.cmds()).includes("worktree remove")).toBe(false);
    }),
  ));
