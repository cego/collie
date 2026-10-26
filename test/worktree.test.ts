import { afterEach, beforeEach, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { Clock, DateTime, Effect, FileSystem, Layer, Option, Schema } from "effect";
import { forgeHttpOnPath, forgeOnPath, runOnPath } from "./support/forge";
import { Rig, TEST_LOGIN as LOGIN } from "./support/recorder";
import { FakeBin } from "./support/bin";
import {
  branchFor,
  branchListed,
  checkoutFor,
  destinationLock,
  mutates,
  pruneWorktrees,
  repositoryName,
  roams,
  worktreeFor,
  type BranchAsk,
} from "../src/worktree";
import type { AgentEntry } from "../src/registry";
import type { RunFacts } from "../src/runs";
import { runFacts } from "./support/records";
import { renovateClonesSweeper, settlingOf, sweep, worktreesSweeper } from "../src/cleanup";
import { NOTHING_SETTLING, onBranch, type Settling } from "../src/worktree";
import { shell } from "../src/mr";
import { Herdr } from "../src/herdr";
import { processOf } from "../src/processes";
import type { CompactionPorts, Stopped } from "../src/compaction";

const asJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

let rig: Rig;
let bin: FakeBin;
/** The Runs and registered agents this test has, which is what pruning is given. */
let recorded: RunFacts[];
let registered: AgentEntry[];
/** What a Run that recorded a checkout answers when asked to give it up, and how often it was. */
let releasedAs: string | null;
let releases: number;
/** Each roaming checkout recorded as a Run's, and whether its destination was locked then. */
let claims: Array<{ path: string; locked: boolean }>;
/** What the merge watch and the Tasks say, beside the checkouts themselves. */
let settling: Settling;

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
  runOnPath(
    Effect.gen(function* () {
      rig = yield* Rig.make();
      bin = yield* FakeBin.make(join(rig.root, "bin"));
      recorded = [];
      registered = [];
      releasedAs = null;
      releases = 0;
      claims = [];
      settling = NOTHING_SETTLING;
    }),
  ),
);

afterEach(() =>
  runOnPath(
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
  /** Patterns that need to do something rather than say something, as raw shell. */
  scripts: Record<string, string> = {},
  /** Written to stderr before every answer, as a git with something to warn about does. */
  warning = "",
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
    ...Object.entries(scripts).map(([match, body]) => `  "${match}"*) ${body} ;;`),
    "  *) exit 1 ;;",
  ].join("\n");
  // The directory as well as the question: a command about the repository has to run
  // somewhere that outlives the checkout being removed.
  return bin.add(
    "git",
    `printf '%s\\t%s\\n' "$PWD" "$*" >> "${gitLog()}"\n${warning && `echo "${warning}" >&2\n`}case "$*" in\n${branches}\nesac`,
  );
};

/**
 * What a git where only the default branch — and whatever else is named — exists on
 * the remote answers, so new work is cut from the default branch and a reviewed branch
 * from its own tip.
 */
const gitAnswers = (branch = "add-picker", remoteBranches: string[] = []) => ({
  // The project this checkout belongs to, which is what an `mr:` target is checked
  // against before anything works on its branch.
  "remote get-url origin": "git@gitlab.example.com:acme/app.git",
  fetch: "",
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
  // Every generated name is put to git before it is used as one.
  "check-ref-format": "",
});

const fakeGit = (branch = "add-picker", remoteBranches: string[] = []) =>
  fakeGitAnswering(gitAnswers(branch, remoteBranches));

/** `git worktree list --porcelain`, as git writes it. */
const porcelain = (checkouts: ReadonlyArray<{ path: string; branch: string }>) =>
  checkouts.map((c) => `worktree ${c.path}\nbranch refs/heads/${c.branch}\n`).join("\n");

/**
 * A git that lists the repository's own checkouts and really makes a directory when it
 * is asked to add one — the `.git` file included, because that is what says a checkout
 * is still the one a run recorded.
 */
const fakeGitWithCheckouts = (
  checkouts: ReadonlyArray<{ path: string; branch: string }>,
  opts: {
    branch?: string;
    remoteBranches?: string[];
    refusals?: Record<string, string>;
    scripts?: Record<string, string>;
  } = {},
) =>
  fakeGitAnswering(
    {
      ...gitAnswers(opts.branch ?? "add-picker", opts.remoteBranches ?? []),
      "worktree list --porcelain": porcelain(checkouts),
    },
    opts.refusals ?? {},
    {
      // The path is the first absolute argument, which is what makes this answer both
      // `worktree add <at> -b <branch>` and `worktree add --detach <at> <ref>`.
      "worktree add":
        'for a in "$@"; do case "$a" in /*) mkdir -p "$a" && printf "gitdir: $a/.gitdir\\n" > "$a/.git"; break ;; esac; done',
      "worktree remove": 'rm -rf "$3"',
      ...opts.scripts,
    },
  );

/**
 * What the shipped workflows declare, which is what these cases are written in. The
 * strategy is what everything downstream reads; `test/strategies.test.ts` is where the
 * same values under other names are proved to behave the same.
 */
const SHIPPED_STRATEGIES = {
  plan: "work-source",
  target: "diff-target",
  repository: "gitlab-repository",
};

const plan = (inputs: Record<string, string>, explicit?: string, extra: Partial<BranchAsk> = {}) =>
  branchFor({
    cwd: rig.projectDir,
    name: "Add a picker",
    inputs,
    strategies: SHIPPED_STRATEGIES,
    // The resolver only names a branch after an Input a human gave, so the default
    // here is what `--input` records — the cases about what Collie itself worked out
    // override it.
    sources: Object.fromEntries(Object.keys(inputs).map((key) => [key, "explicit"])),
    explicit,
    // What the environment told the front door; the cases about glab pass null.
    login: LOGIN,
    ...extra,
  });

test("only the workflows that declare a checkout get one of their own", () => {
  expect(mutates("branch")).toBe(true);
  expect(mutates("roaming")).toBe(true);
  // What a workflow that declares nothing resolves to, and what `review` and `plan` are.
  expect(mutates("none")).toBe(false);
});

test("a roaming workflow owns a checkout but no branch, so none is asked for", () => {
  expect(roams("roaming")).toBe(true);
  expect(roams("branch")).toBe(false);
  expect(roams("none")).toBe(false);

  expect(Object.keys(branchListed("branch", { plan: "work-source" }))).toEqual(["plan", "branch"]);
  // Nothing to ask: a Renovate Run moves across every branch it merges and owns none.
  expect(Object.keys(branchListed("roaming", { repository: "optional" }))).toEqual(["repository"]);
});

test("a run described in words branches off the default branch, under the operator's login", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGit();

      expect(yield* plan({ plan_kind: "text" })).toEqual({
        branch: `${LOGIN}/add-a-picker`,
        // The Run is named after the task alone: the namespace is the same on every
        // branch this operator generates.
        task: "add-a-picker",
        base: "origin/master",
        refused: null,
        source: "from the run name",
      });
    }),
  ));

test("a generated branch refuses a checkout on neither forge", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGitAnswering({
        ...gitAnswers(),
        "remote get-url origin": "git@bitbucket.org:acme/app.git",
      });
      expect((yield* plan({ plan_kind: "text" })).refused).toBe(
        "bitbucket.org is neither GitHub nor GitLab",
      );
    }),
  ));

test("the login comes from glab where the environment does not name one", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGit();
      yield* bin.add("glab", `echo '{"username": "kronborg"}'`);

      expect(yield* plan({ plan_kind: "text" }, undefined, { login: null })).toMatchObject({
        branch: "kronborg/add-a-picker",
      });
    }),
  ));

test("a login nobody can establish is an authentication error, not a branch question", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGit();
      yield* bin.add("glab", "exit 1");

      const refused = yield* plan({ plan_kind: "text" }, undefined, { login: null });
      expect(refused.branch).toBe("");
      // Nothing the caller could type settles this: they have to log in.
      expect(refused.refused).toContain("glab");
    }),
  ));

const onGithub = () =>
  fakeGitAnswering({ ...gitAnswers(), "remote get-url origin": "git@github.com:acme/app.git" });

test("on a GitHub checkout the branch is named under GITHUB_ACTOR, else gh's login, never glab's", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* onGithub();
      const glabAsked = `${rig.root}/glab-asked`;
      yield* bin.add("glab", `touch "${glabAsked}"; echo '{"username": "gitlab-me"}'`);
      yield* bin.add("gh", `echo '{"login": "madskronborg"}'`);

      expect(
        yield* plan({ plan_kind: "text" }, undefined, { login: "mk", githubLogin: "actor" }),
      ).toMatchObject({ branch: "actor/add-a-picker" });
      // GITLAB_USER_LOGIN names nothing on GitHub.
      expect(yield* plan({ plan_kind: "text" }, undefined, { login: "mk" })).toMatchObject({
        branch: "madskronborg/add-a-picker",
      });
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(glabAsked)).toBe(false);
    }),
  ));

test("a GitHub checkout with no login says to log in to gh or set GITHUB_ACTOR", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* onGithub();
      yield* bin.add("gh", "exit 1");
      expect((yield* plan({ plan_kind: "text" }, undefined, { login: null })).refused).toBe(
        "no GitHub login to name a branch under: GITHUB_ACTOR is unset and gh could not say who you are. Log in with `gh auth login`, or set GITHUB_ACTOR.",
      );
    }),
  ));

test("a generated name git will not have is refused rather than used", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGitAnswering(gitAnswers(), { "check-ref-format": "bad ref" });

      const refused = yield* plan({ plan_kind: "text" });
      expect(refused.branch).toBe("");
      expect(refused.refused).toContain(`${LOGIN}/add-a-picker`);
    }),
  ));

test("an explicit branch beats every inference", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGit();

      // Verbatim: an explicit branch is a branch, not a task to be named after.
      expect(yield* plan({ plan_kind: "text" }, "hand-picked")).toMatchObject({
        branch: "hand-picked",
      });
    }),
  ));

test("a review of a branch diff takes its head, and a review of a tree the branch it is on", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGit("on-this-one", ["their-work"]);

      expect(
        yield* plan({
          plan: "/runs/review-1",
          plan_kind: "review",
          target: "branch:master...their-work",
          target_kind: "branch",
        }),
      ).toMatchObject({ branch: "their-work" });
      expect(
        yield* plan({
          plan: "/runs/review-1",
          plan_kind: "review",
          target: "worktree",
          target_kind: "worktree",
        }),
      ).toMatchObject({ branch: "on-this-one" });
    }),
  ));

test("a diff target names the branch the run works on", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGit();

      // The target says which branch is being built, so the checkout and the review
      // target agree without a second flag.
      expect(
        yield* plan({ plan_kind: "text", target: "branch:master...wide-scope" }),
      ).toMatchObject({ branch: "wide-scope", source: "from target" });
      // A bare `branch:<name>` has no base to strip, and names itself.
      expect(yield* plan({ plan_kind: "text", target: "branch:wide-scope" })).toMatchObject({
        branch: "wide-scope",
        source: "from target",
      });
    }),
  ));

test("a target whose head is not a branch name leaves the branch to be worked out", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGit();

      // `branch:main...HEAD` is a diff anyone may review; HEAD is not a branch to build.
      expect(yield* plan({ plan_kind: "text", target: "branch:main...HEAD" })).toMatchObject({
        branch: `${LOGIN}/add-a-picker`,
        source: "from the run name",
      });
      expect(yield* plan({ plan_kind: "text", target: "worktree" })).toMatchObject({
        branch: `${LOGIN}/add-a-picker`,
        source: "from the run name",
      });
    }),
  ));

test("a plan directory names the branch after itself, not after its path", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGit();

      expect(
        yield* plan(
          { plan_kind: "plan-dir", plan: "/home/mk/work/gitlab.example.com/tasks/global-board" },
          undefined,
          { name: "home-mk-work-gitlab-example-com-tasks-global-board" },
        ),
      ).toMatchObject({ branch: `${LOGIN}/global-board`, source: "from plan" });
    }),
  ));

test("the target beats the plan directory, and an explicit branch beats both", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGit();

      const inputs = {
        plan_kind: "plan-dir",
        plan: "/tmp/tasks/global-board",
        target: "branch:master...wide-scope",
      };
      expect(yield* plan(inputs)).toMatchObject({ branch: "wide-scope", source: "from target" });
      expect(yield* plan(inputs, "hand-picked")).toMatchObject({
        branch: "hand-picked",
        source: "explicit",
      });
    }),
  ));

test("a name too long to slug is bounded and made distinct, never asked for", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGit();

      // Every plan under `tasks/` slugs to the same clipped branch, and the branch is
      // the key to the worktree — so a clipped name carries what the cap dropped.
      const at = (name: string) => plan({ plan_kind: "text" }, undefined, { name });
      const one = yield* at("/home/mk/work/gitte2/gitlab.cego.dk/tasks/collie-global-board");
      const two = yield* at("/home/mk/work/gitte2/gitlab.cego.dk/tasks/collie-run-board");
      expect(one.refused).toBeNull();
      expect(one.branch.startsWith(`${LOGIN}/`)).toBe(true);
      expect(one.branch.length).toBeLessThanOrEqual(64);
      expect(one.branch).not.toBe(two.branch);
      // Stable: the same work asked for twice is one branch, so a retry reuses it.
      expect(
        (yield* at("/home/mk/work/gitte2/gitlab.cego.dk/tasks/collie-global-board")).branch,
      ).toBe(one.branch);
    }),
  ));

test("a name with nothing sluggable in it still becomes a legal, distinct branch", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGit();

      const unicode = yield* plan({ plan_kind: "text" }, undefined, { name: "Ærø — 日本語" });
      const nothing = yield* plan({ plan_kind: "text" }, undefined, { name: "???" });
      for (const asked of [unicode, nothing]) {
        expect(asked.refused).toBeNull();
        expect(asked.branch).toMatch(new RegExp(`^${LOGIN}/[a-z0-9][a-z0-9-]*$`));
      }
      expect(unicode.branch).not.toBe(nothing.branch);
    }),
  ));

test("work whose names differ only in letters a slug cannot spell stays two branches", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGit();

      // Slugging drops what it cannot spell, so two different tasks read the same
      // afterwards — and the branch is what keys the worktree.
      const named = (name: string) => plan({ plan_kind: "text" }, undefined, { name });
      const accented = yield* named("café");
      const plainly = yield* named("caf");
      expect(accented.refused).toBeNull();
      expect(accented.branch).not.toBe(plainly.branch);
      // Punctuation and case are not distinctions: the same words are the same work.
      expect((yield* named("Caf")).branch).toBe(plainly.branch);
    }),
  ));

test("the task a plan agreed on names the branch, not the path Collie chained", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGit();

      // plan chains implement with `<run.dir>/plan` and the parent's whole prose name.
      // Neither names the work; the slug the planner and the human agreed on does.
      expect(
        yield* plan(
          {
            plan_kind: "plan-dir",
            plan: `${rig.root}/state/runs/plan-x/plan`,
            task: "global-board",
          },
          undefined,
          {
            name: "Stop asking humans for branch names and audit the rest of the setup",
            sources: { plan: "chained from plan-x", task: "chained from plan-x" },
          },
        ),
      ).toMatchObject({ branch: `${LOGIN}/global-board`, source: "from the task" });
    }),
  ));

test("a target Collie guessed names no branch; only one a human gave does", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGit();

      // Inference offers `branch:<default>...<current branch>` whenever the cwd is on a
      // branch. Taking that as the branch to build would put the run in the checkout
      // that branch is already in — the operator's own tree, index and stash stack.
      const inputs = { plan_kind: "text", target: "branch:master...foo" };
      expect(
        yield* plan(inputs, undefined, { sources: { target: "current branch" } }),
      ).toMatchObject({ branch: `${LOGIN}/add-a-picker`, source: "from the run name" });
      // The picker's "Type it…" and `run answer` are the human saying it, same as `--input`.
      for (const said of ["explicit", "typed", "asked"]) {
        expect(yield* plan(inputs, undefined, { sources: { target: said } })).toMatchObject({
          branch: "foo",
          source: "from target",
        });
      }
    }),
  ));

test("two descriptions that start alike are two branches", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGit();

      // The run name is a label the picker truncated to 24 characters, so slugging it
      // could never hit the 40-character cap: two descriptions that agree for six words
      // used to land on one branch, and so in one checkout.
      const first = "Fix the parser so a diff of two refs with no branch works";
      const second = "Fix the parser so a diff of two refs with a different outcome";
      const branches = new Set<string>();
      for (const text of [first, second]) {
        // The name the picker and the CLI both arrive with: `textLabel` cut to 24.
        const asked = yield* plan({ plan_kind: "text", plan: text }, undefined, {
          name: "fix-the-parser-so-a-diff",
        });
        expect(asked.refused).toBeNull();
        branches.add(asked.branch);
      }
      expect(branches.size).toBe(2);
      // A description short enough to be a branch still is one, and the line says the
      // work is what named it rather than crediting the Run's own name.
      expect(
        yield* plan({ plan_kind: "text", plan: "Add a picker" }, undefined, {
          name: "add-a-picker",
        }),
      ).toMatchObject({ branch: `${LOGIN}/add-a-picker`, source: "from the work" });
      // A Linear issue names itself.
      expect(
        yield* plan({ plan_kind: "linear", plan: "ENG-123" }, undefined, { name: "ENG-123" }),
      ).toMatchObject({ branch: `${LOGIN}/eng-123` });
      // So does its URL, which is how an issue is usually pasted.
      expect(
        yield* plan(
          { plan_kind: "linear", plan: "https://linear.app/acme/issue/ENG-123/add-a-picker" },
          undefined,
          { name: "ENG-123" },
        ),
      ).toMatchObject({ branch: `${LOGIN}/eng-123` });
      // A chained Run is named after its parent, and its work source is a path the
      // parent wrote rather than anything a human said — that name is already whole,
      // and slugging the path would refuse every chained run.
      expect(
        yield* plan(
          { plan_kind: "text", plan: `${rig.root}/state/runs/architecture-x/plan` },
          undefined,
          {
            sources: { plan: "chained from architecture-x" },
          },
        ),
      ).toMatchObject({ branch: `${LOGIN}/add-a-picker` });
    }),
  ));

test("a plan directory Collie itself pointed at names no branch; the run's own name does", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGit();

      // `plan` and `architecture` chain into `implement` with `{{run.dir}}/plan`, and
      // the picker offers a finished plan run's `<run.dir>/plan` the same way. Every
      // one of those basenames is the literal `plan`, so taking it would put every
      // chained run on one branch, in one checkout, under one row on the board.
      const dir = `${rig.root}/state/runs/plan-add-a-version-flag-20260904/plan`;
      for (const source of ["chained from plan-add-a-version-flag-20260904", "plan run pr-1"]) {
        expect(
          yield* plan({ plan_kind: "plan-dir", plan: dir }, undefined, {
            name: "add-a-version-flag",
            sources: { plan: source },
          }),
        ).toMatchObject({ branch: `${LOGIN}/add-a-version-flag`, source: "from the run name" });
      }

      // A plan directory the operator named is still what the branch is named after.
      expect(
        yield* plan({ plan_kind: "plan-dir", plan: "/home/mk/tasks/global-board" }),
      ).toMatchObject({ branch: `${LOGIN}/global-board`, source: "from plan" });
    }),
  ));

test("a branch with a worktree is opened, and one without gets a new one", () =>
  runOnPath(
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
      // The workspace herdr just made has one shell tab, and the record carries it so
      // the run can put its first agent there instead of beside it.
      expect(made.worktree.root_tab_id).toBe("1:1");
      expect(made.worktree.root_pane_id).toBe("1-1");

      const again = yield* worktreeFor(herdr, {
        cwd: rig.projectDir,
        branch: "add-picker",
        base: "origin/master",
      });
      expect(again.worktree).toMatchObject({
        path: made.worktree.path,
        created_by_collie: false,
        // An existing checkout's workspace is not fresh; nothing in it is the run's
        // to take over.
        root_tab_id: null,
        root_pane_id: null,
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
  runOnPath(
    Effect.gen(function* () {
      const herdr = new Herdr(rig.pluginEnv());
      const one = yield* worktreeFor(herdr, { cwd: rig.projectDir, branch: "one" });
      const two = yield* worktreeFor(herdr, { cwd: rig.projectDir, branch: "two" });

      expect(one.worktree.path).not.toBe(two.worktree.path);
      expect(one.worktree.workspace_id).not.toBe(two.worktree.workspace_id);
    }),
  ));

/** An agent a Run was given, registered in the pane herdr opened for it. */
const agentIn = (runId: string, paneId: string): AgentEntry => ({
  role: "implementer",
  agent: `impl-${paneId}`,
  paneId,
  workspaceId: "w1",
  runId,
  workflow: "implement",
  at: "2026-09-14T10:00:00Z",
});

/** A worktree Collie made, as its run record and herdr's list would show it. */
const collieWorktree = (
  branch: string,
  opts: {
    workspaceId?: string | null;
    managedBy?: "git" | "herdr";
    /** The panes the run's agents were left in, whose tabs a removal is what closes. */
    panes?: ReadonlyArray<string>;
    /** The workflow that made it; a roaming one records no branch. */
    workflow?: string;
    /** Where it sits, for a checkout whose path is not named after a branch. */
    at?: string;
    state?: RunFacts["state"];
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // Not `??`: null is an answer here — a checkout herdr has no workspace open on.
    const workspaceId = opts.workspaceId === undefined ? "w7" : opts.workspaceId;
    const worktreePath = opts.at ?? join(rig.root, "worktrees", branch);
    yield* rig.addWorktree(branch, worktreePath, workspaceId);
    // What the run recorded when it made this checkout, which is how pruning knows it
    // is still the same one.
    const madeAt = yield* fs.stat(`${worktreePath}/.git`);
    const run = runFacts({
      id: `run-${branch}`,
      workflow: opts.workflow ?? "implement",
      project: rig.projectDir,
      cwd: worktreePath,
      state: opts.state ?? "succeeded",
      worktree: {
        path: worktreePath,
        branch,
        created_by_collie: true,
        created_branch: false,
        created_on: null,
        managed_by: opts.managedBy ?? "herdr",
        workspace_id: workspaceId,
        made_at: madeAt.mtime.pipe(Option.getOrNull)?.getTime() ?? null,
        root_tab_id: null,
        root_pane_id: null,
      },
    });
    recorded.push(run);
    registered.push(...(opts.panes ?? []).map((pane) => agentIn(run.id, pane)));
    return worktreePath;
  });

/**
 * A git that answers every question the settled rule asks. Each case can be
 * overridden to make exactly one condition fail.
 */
const settledGit = (
  overrides: Record<string, string> = {},
  refusals: Record<string, string> = {},
  warning = "",
) =>
  fakeGitAnswering(
    {
      "status --porcelain": "",
      "rev-parse --abbrev-ref --symbolic-full-name @{u}": "origin/wt",
      "rev-list HEAD --not": "",
      remote: "origin",
      "ls-remote --heads origin": "",
      "worktree remove": "",
      "branch -d": "Deleted branch.",
      ...overrides,
    },
    refusals,
    {},
    warning,
  );

/** The merge watch read the branch's merge request as merged. */
const mergedMr = (head?: string) =>
  Effect.sync(() => {
    const landed = { why: "merged in !14", heads: head === undefined ? [] : [head] };
    settling = {
      ...settling,
      landedOn: new Map(
        recorded.map((run) => [onBranch(run.project, run.worktree?.branch ?? ""), landed]),
      ),
    };
  });

const prune = () =>
  pruneWorktrees({
    herdr: new Herdr(rig.pluginEnv()),
    stateDir: rig.stateDir,
    runs: recorded,
    registered,
    cwd: rig.projectDir,
    settling,
  });

test("a settled worktree is removed, and the board says why", () =>
  runOnPath(
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

test("a settled worktree whose git warns on stderr is still removed", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* collieWorktree("wt");
      yield* settledGit({}, {}, "warning: something git wants said");
      yield* mergedMr();

      expect(yield* prune()).toEqual(["♻ removed wt · merged in !14"]);
    }),
  ));

test("a Renovate Run's detached checkout is pruned by the same sweep, with no branch to delete", () =>
  runOnPath(
    Effect.gen(function* () {
      const at = join(rig.root, "worktrees", "project", "roaming");
      // No branch, in the record and in herdr's listing alike: that is what a detached
      // checkout is, and it must still be a candidate.
      yield* collieWorktree("", { workflow: "renovate", at, managedBy: "git", workspaceId: null });
      // A detached checkout has no upstream, so what settles it is holding no commits
      // the default branch does not already have.
      yield* settledGit({
        "rev-parse --abbrev-ref --symbolic-full-name @{u}": "",
        "rev-list HEAD --not": "",
      });

      expect(yield* prune()).toEqual(["♻ removed roaming · its Run is over and it holds nothing"]);
      expect(yield* asked()).toContain(`worktree remove ${at}`);
      // Nothing was ever bound to it, so nothing is deleted with it.
      expect((yield* asked()).some((command) => command.startsWith("branch -d"))).toBe(false);
    }),
  ));

test("a failed Run's clean roaming checkout is pruned, failed Runs inside it or not", () =>
  runOnPath(
    Effect.gen(function* () {
      const at = join(rig.root, "worktrees", "project", "roaming");
      yield* collieWorktree("", {
        workflow: "self-improve",
        at,
        managedBy: "git",
        workspaceId: null,
        state: "failed",
        panes: ["1-5"],
      });
      recorded.push(
        runFacts({ id: "run-improvement", workflow: "plan", cwd: at, state: "failed" }),
      );
      registered.push(agentIn("run-improvement", "1-6"));
      // Both Runs' agents, idle where they were left.
      yield* rig.addPane("1-5", "1:5", at, "claude");
      yield* rig.addPane("1-6", "1:6", at, "claude");
      yield* settledGit({ "rev-parse --abbrev-ref --symbolic-full-name @{u}": "" });

      expect(yield* prune()).toEqual(["♻ removed roaming · its Run is over and it holds nothing"]);
    }),
  ));

test("a failed Run's roaming checkout is kept while one of its agents still works", () =>
  runOnPath(
    Effect.gen(function* () {
      const at = join(rig.root, "worktrees", "project", "roaming");
      yield* collieWorktree("", {
        workflow: "self-improve",
        at,
        managedBy: "git",
        workspaceId: null,
        state: "failed",
        panes: ["1-5"],
      });
      yield* rig.addPane("1-5", "1:5", at, "claude", null, null, "working");
      yield* settledGit({ "rev-parse --abbrev-ref --symbolic-full-name @{u}": "" });

      expect(yield* prune()).toEqual(["kept roaming · an agent is working in it"]);
    }),
  ));

test("a failed Run's roaming checkout is kept while a Run still works in it", () =>
  runOnPath(
    Effect.gen(function* () {
      const at = join(rig.root, "worktrees", "project", "roaming");
      yield* collieWorktree("", {
        workflow: "self-improve",
        at,
        managedBy: "git",
        workspaceId: null,
        state: "failed",
      });
      recorded.push(
        runFacts({ id: "run-improvement", workflow: "plan", cwd: at, state: "running" }),
      );
      yield* settledGit({ "rev-parse --abbrev-ref --symbolic-full-name @{u}": "" });

      expect(yield* prune()).toEqual(["kept roaming · a run is still working in it"]);
    }),
  ));

test("a Renovate checkout with work still in it is kept, like any other", () =>
  runOnPath(
    Effect.gen(function* () {
      const at = join(rig.root, "worktrees", "project", "roaming");
      yield* collieWorktree("", { workflow: "renovate", at, managedBy: "git", workspaceId: null });
      yield* settledGit({ "status --porcelain": " M package.json" });

      expect(yield* prune()).toEqual(["kept roaming · uncommitted changes"]);
      expect((yield* asked()).some((command) => command.startsWith("worktree remove"))).toBe(false);
    }),
  ));

test("uncommitted work keeps a worktree, and so does anything unpushed", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* collieWorktree("wt");
      yield* mergedMr();
      yield* settledGit({ "status --porcelain": " M src/main.ts" });

      expect(yield* prune()).toEqual(["kept wt · uncommitted changes"]);
      expect((yield* rig.cmds()).includes("worktree remove")).toBe(false);
    }),
  ));

test("a branch with commits the remote has not seen keeps its worktree", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* collieWorktree("wt");
      yield* mergedMr();
      yield* settledGit({ "rev-list HEAD --not": "a1\\nb2" });

      expect(yield* prune()).toEqual(["kept wt · 2 commit(s) on no remote"]);
    }),
  ));

test("with no upstream, commits no remote has keep the checkout", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* collieWorktree("wt");
      yield* mergedMr();
      yield* settledGit({
        "rev-parse --abbrev-ref --symbolic-full-name @{u}": "",
        "rev-list HEAD --not": "a1",
      });

      expect(yield* prune()).toEqual(["kept wt · 1 commit(s) on no remote"]);
      expect((yield* askedIn()).map((asked) => asked.command)).toContain(
        "rev-list HEAD --not --remotes",
      );
    }),
  ));

test("a worktree an agent is working in keeps it", () =>
  runOnPath(
    Effect.gen(function* () {
      const worktreePath = yield* collieWorktree("wt");
      yield* settledGit();
      yield* mergedMr();
      yield* rig.addPane("1-9", "1:9", worktreePath, "claude");

      expect(yield* prune()).toEqual(["kept wt · an agent is working in it"]);
    }),
  ));

test("a worktree a server of an agent herdr no longer lists may write in keeps it", () =>
  runOnPath(
    Effect.gen(function* () {
      const worktreePath = yield* collieWorktree("wt");
      yield* settledGit();
      yield* mergedMr();
      const fs = yield* FileSystem.FileSystem;
      const dir = `${rig.stateDir}/compaction/r1-implementer`;
      yield* fs.makeDirectory(dir, { recursive: true });
      const record = {
        agent: "r1-implementer",
        harness: "codex",
        cwd: worktreePath,
        dir,
        endpoint: "ws://127.0.0.1:1",
        pid: process.pid,
        command: null,
        started: null,
        attempt: null,
        stop: null,
      };
      yield* fs.writeFileString(`${dir}/control.json`, asJson(record));

      expect(yield* prune()).toEqual([
        "kept wt · r1-implementer's server may still be writing in it",
      ]);
    }),
  ));

test("a worktree a failed stop left a process of its agent's server in keeps it, its server gone", () =>
  runOnPath(
    Effect.gen(function* () {
      const worktreePath = yield* collieWorktree("wt");
      yield* settledGit();
      yield* mergedMr();
      const fs = yield* FileSystem.FileSystem;
      const dir = `${rig.stateDir}/compaction/r1-implementer`;
      yield* fs.makeDirectory(dir, { recursive: true });
      const survivor = (yield* processOf(process.pid))!;
      yield* fs.writeFileString(
        `${dir}/control.json`,
        asJson({
          agent: "r1-implementer",
          harness: "codex",
          cwd: worktreePath,
          dir,
          endpoint: "ws://127.0.0.1:1",
          // Its server has exited; the stop left one process of its session running.
          pid: 4_194_303,
          command: "codex app-server",
          started: "0",
          attempt: null,
          stop: {
            state: "acknowledged",
            at: 0,
            turns: [],
            reason: "its server exited, but a process of its session is still running",
            left: [{ pid: survivor.pid, started: survivor.started }],
          },
        }),
      );

      expect(yield* prune()).toEqual([
        "kept wt · r1-implementer's server may still be writing in it",
      ]);
    }),
  ));

test("an open merge request keeps the worktree it was built in", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* collieWorktree("wt");
      yield* settledGit();
      settling = { ...settling, openOn: new Map([[onBranch(rig.projectDir, "wt"), "!14"]]) };

      expect(yield* prune()).toEqual(["kept wt · !14 is still open"]);
    }),
  ));

test("with no merge request, a branch still on the remote keeps its worktree", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* collieWorktree("wt");
      yield* bin.add("glab", `exit 1`);
      yield* settledGit({ "ls-remote --heads origin": "deadbeef refs/heads/wt" });

      expect(yield* prune()).toEqual(["kept wt · still on the remote"]);
    }),
  ));

test("a worktree Collie did not create is never touched, settled or not", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* rig.addWorktree("by-hand", join(rig.root, "elsewhere"), "w9");
      yield* settledGit();
      yield* mergedMr();

      expect(yield* prune()).toEqual([]);
      expect((yield* rig.cmds()).includes("worktree remove")).toBe(false);
    }),
  ));

test("a worktree is not re-checked on every refresh", () =>
  runOnPath(
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

test("a settled git-managed checkout is removed with git, and its dead tabs go with it", () =>
  runOnPath(
    Effect.gen(function* () {
      const worktreePath = yield* collieWorktree("wt", {
        managedBy: "git",
        workspaceId: null,
        panes: ["1-5", "1-6"],
      });
      // The run's own shell, still sitting in a directory that is about to go, and a
      // tab a human has since reused for something outside it.
      yield* rig.addPane("1-5", "1:5", `${worktreePath}/src`);
      yield* rig.addPane("1-6", "1:6", rig.projectDir);
      yield* settledGit();
      yield* mergedMr();

      expect(yield* prune()).toEqual(["♻ removed wt · merged in !14"]);
      // git, from the repository's own checkout, and never forced.
      expect(yield* askedIn()).toContainEqual({
        cwd: rig.projectDir,
        command: `worktree remove ${worktreePath}`,
      });
      expect(yield* asked()).toContain("branch -d wt");
      // herdr is asked for nothing but the list and the tab it has left holding a
      // shell in a directory that is gone.
      const cmds = yield* rig.cmds();
      expect(cmds).not.toContain("worktree remove");
      expect(cmds).not.toContain("worktree open");
      const closed = (yield* rig.calls()).filter((call) => call.cmd === "tab close");
      expect(closed.map((call) => call.argv?.at(2))).toEqual(["1:5"]);
    }),
  ));

test("a dead tab herdr would not close is reported, because nothing comes back for it", () =>
  runOnPath(
    Effect.gen(function* () {
      const worktreePath = yield* collieWorktree("wt", {
        managedBy: "git",
        workspaceId: null,
        panes: ["1-5"],
      });
      yield* rig.addPane("1-5", "1:5", worktreePath);
      yield* settledGit();
      yield* mergedMr();
      // The checkout goes, and herdr hiccups on the tab left standing in it. The path
      // is gone from the listing now, so no later sweep has a candidate to retry with:
      // said here or never said.
      const herdr = new Herdr(rig.pluginEnv({ FAKE_HERDR_FAIL: '{"tab close":"pane is busy"}' }));

      expect(
        yield* pruneWorktrees({
          herdr,
          stateDir: rig.stateDir,
          runs: recorded,
          registered,
          cwd: rig.projectDir,
          settling,
        }),
      ).toEqual(["♻ removed wt · merged in !14 · 1 tab(s) left open"]);
      // The checkout itself still went: a tab that will not close is not a reason to
      // keep a settled checkout, only a reason to say so.
      expect(yield* asked()).toContain(`worktree remove ${worktreePath}`);
      expect(yield* asked()).toContain("branch -d wt");
    }),
  ));

test("git's refusal to remove a checkout keeps it, in git's own words", () =>
  runOnPath(
    Effect.gen(function* () {
      const worktreePath = yield* collieWorktree("wt", {
        managedBy: "git",
        workspaceId: null,
        panes: ["1-5"],
      });
      yield* rig.addPane("1-5", "1:5", worktreePath);
      yield* settledGit(
        {},
        { "worktree remove": `fatal: ${worktreePath} contains modified files` },
      );
      yield* mergedMr();

      expect(yield* prune()).toEqual([`kept wt · fatal: ${worktreePath} contains modified files`]);
      // The checkout is still there, so neither its branch nor its tabs are touched.
      expect(yield* asked()).not.toContain("branch -d wt");
      expect(yield* rig.cmds()).not.toContain("tab close");
    }),
  ));

test("a git-managed checkout herdr has a workspace on is still removed through herdr", () =>
  runOnPath(
    Effect.gen(function* () {
      const worktreePath = yield* collieWorktree("wt", {
        managedBy: "git",
        workspaceId: "w7",
        panes: ["1-5"],
      });
      // The run's own tab, which is in the workspace the run was activated from — not
      // in the workspace herdr opened on the checkout, so herdr's removal cannot know
      // about it.
      yield* rig.addPane("1-5", "1:5", worktreePath);
      yield* settledGit();
      yield* mergedMr();

      expect(yield* prune()).toEqual(["♻ removed wt · merged in !14"]);
      // herdr owns every worktree it has open, whoever made the checkout: removing one
      // behind its back would leave it listing a checkout that is not there.
      const calls = (yield* rig.calls()).filter((call) => call.cmd === "worktree remove");
      expect(calls.at(0)?.argv).toEqual(["worktree", "remove", "--workspace", "w7"]);
      expect(yield* asked()).not.toContain(`worktree remove ${worktreePath}`);
      // The dead tab still goes, whichever manager removed the checkout under it.
      const closed = (yield* rig.calls()).filter((call) => call.cmd === "tab close");
      expect(closed.map((call) => call.argv?.at(2))).toEqual(["1:5"]);
    }),
  ));

test("a checkout herdr will not remove is kept, in the words it refused with", () =>
  runOnPath(
    Effect.gen(function* () {
      const worktreePath = yield* collieWorktree("wt", { workspaceId: "" });
      yield* settledGit();
      yield* mergedMr();
      // No workspace open on it, so it is opened again to be removed — and herdr
      // refuses, passing on what git told it.
      const herdr = new Herdr(
        rig.pluginEnv({
          FAKE_HERDR_FAIL: `{"worktree remove":"fatal: ${worktreePath} contains modified files"}`,
        }),
      );

      expect(
        yield* pruneWorktrees({
          herdr,
          stateDir: rig.stateDir,
          runs: recorded,
          registered,
          cwd: rig.projectDir,
          settling,
        }),
      ).toEqual([
        `kept wt · herdr worktree remove failed (exit 1): fatal: ${worktreePath} contains modified files`,
      ]);
      // Never git behind herdr's back: herdr owns every worktree's whole life.
      expect(yield* asked()).not.toContain(`worktree remove ${worktreePath}`);
      // And the branch is only ever deleted once the checkout has actually gone.
      expect(yield* asked()).not.toContain("branch -d wt");
    }),
  ));

test("a checkout whose workspace was closed is opened again to be removed", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* collieWorktree("wt", { workspaceId: "" });
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
  runOnPath(
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
          runs: recorded,
          registered,
          cwd: worktreePath,
          keep: worktreePath,
          settling,
        }),
      ).toEqual(["kept wt · a run is starting in it"]);
      expect((yield* rig.cmds()).includes("worktree remove")).toBe(false);

      // The Control Plane of that same workspace holds nothing: a merged branch's
      // checkout goes, and herdr closes the workspace showing it.
      expect(
        yield* pruneWorktrees({
          herdr,
          stateDir: rig.stateDir,
          runs: recorded,
          registered,
          cwd: worktreePath,
          now: (yield* Clock.currentTimeMillis) + 10 * 60_000,
          settling,
        }),
      ).toEqual(["♻ removed wt · merged in !14"]);
    }),
  ));

test("a checkout an agent in another herdr session works in is kept", () =>
  runOnPath(
    Effect.gen(function* () {
      const worktreePath = yield* collieWorktree("wt");
      yield* settledGit();
      yield* mergedMr();
      class OtherSession extends Herdr {
        override paneList() {
          return Effect.succeed([
            {
              paneId: "9-1",
              tabId: "9:1",
              label: null,
              agent: "claude",
              agentStatus: "working",
              workspaceId: "w-other",
              cwd: worktreePath,
              foregroundCwd: null,
              tokens: {},
              terminalId: null,
              agentSession: null,
            },
          ]);
        }
      }

      const said = yield* pruneWorktrees({
        herdr: new Herdr(rig.pluginEnv()),
        sessions: [new OtherSession(rig.pluginEnv())],
        stateDir: rig.stateDir,
        runs: recorded,
        registered,
        cwd: rig.projectDir,
        settling,
      });

      expect(said).toEqual(["kept wt · an agent is working in it"]);
      expect((yield* rig.cmds()).includes("worktree remove")).toBe(false);
    }),
  ));

test("a herdr that will not list panes judges nothing, and says so", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* collieWorktree("wt");
      yield* settledGit();
      yield* mergedMr();
      // A live agent's pane is the one condition nothing else can establish, so a
      // herdr that cannot be asked must not have its silence read as "none".
      const herdr = new Herdr(rig.pluginEnv({ FAKE_HERDR_FAIL: '{"pane list":"herdr is gone"}' }));

      expect(
        yield* pruneWorktrees({
          herdr,
          stateDir: rig.stateDir,
          runs: recorded,
          registered,
          cwd: rig.projectDir,
          settling,
        }),
      ).toEqual(["kept wt · could not ask herdr what is live"]);
      expect((yield* rig.cmds()).includes("worktree remove")).toBe(false);

      // Nothing was written down, so the next round asks again rather than standing on
      // a verdict it never reached.
      const herdrAgain = new Herdr(rig.pluginEnv());
      expect(
        yield* pruneWorktrees({
          herdr: herdrAgain,
          stateDir: rig.stateDir,
          runs: recorded,
          registered,
          cwd: rig.projectDir,
          settling,
        }),
      ).toEqual(["♻ removed wt · merged in !14"]);
    }),
  ));

test("a run still going keeps its checkout, whether or not an agent is in it", () =>
  runOnPath(
    Effect.gen(function* () {
      const worktreePath = yield* collieWorktree("wt");
      // Nothing is working in it that herdr can see, and the Run is still going.
      recorded = recorded.map((run) => ({ ...run, state: "running" as const }));
      yield* settledGit();
      yield* mergedMr();

      expect(
        yield* pruneWorktrees({
          herdr: new Herdr(rig.pluginEnv()),
          stateDir: rig.stateDir,
          runs: recorded,
          registered,
          cwd: rig.projectDir,
          settling,
        }),
      ).toEqual(["kept wt · a run is still working in it"]);
    }),
  ));

test("a review of a merge request whose branch is only on the remote is cut from it", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGit("somewhere-else", ["fix-the-parser"]);
      yield* bin.add("glab", `echo '{"source_branch": "fix-the-parser"}'`);

      // Not the default branch: a fix round has to continue the work it is fixing.
      expect(
        yield* plan({
          plan: "/runs/review-1",
          plan_kind: "review",
          target: "mr:gitlab.example.com/acme/app!42",
          target_kind: "mr",
        }),
      ).toEqual({
        branch: "fix-the-parser",
        task: "fix-the-parser",
        base: "origin/fix-the-parser",
        refused: null,
        source: "from the reviewed branch",
      });
    }),
  ));

test("a review of a pull request is fixed on its head branch, read through gh", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGitAnswering({
        ...gitAnswers("somewhere-else", ["fix-the-parser"]),
        "remote get-url origin": "git@github.com:acme/app.git",
      });
      yield* forgeOnPath(bin, "github", {
        installed: true,
        loggedIn: ["github.com"],
        login: "tester",
        mrs: [
          {
            project: "github.com/acme/app",
            iid: "30",
            state: "open",
            sourceBranch: "fix-the-parser",
          },
        ],
      });
      expect(
        yield* plan({
          plan: "/runs/review-1",
          plan_kind: "review",
          target: "mr:github.com/acme/app#30",
          target_kind: "mr",
        }),
      ).toMatchObject({ branch: "fix-the-parser", source: "from the reviewed branch" });
      // A pull request of another repository is refused in its own words.
      expect(
        (yield* plan({
          plan: "/runs/review-1",
          plan_kind: "review",
          target: "mr:github.com/cego/collie#30",
          target_kind: "mr",
        })).refused,
      ).toBe(
        "cego/collie#30 is in github.com/cego/collie, and this is a checkout of github.com/acme/app",
      );
    }),
  ));

test("a review whose target nobody normalised is refused, not fixed on the caller's branch", () =>
  runOnPath(
    Effect.gen(function* () {
      // The caller stands on another merge request's branch, which is what a guess took.
      yield* fakeGit("someone-elses-branch", []);
      yield* bin.add("glab", `echo '{"source_branch": "fix-the-parser"}'`);

      const raw = yield* plan({
        plan: "/runs/review-1",
        plan_kind: "review",
        target: "https://gitlab.example.com/acme/app/-/merge_requests/42",
      });
      expect(raw.branch).toBe("");
      expect(raw.refused).toContain("not a target Collie can find a branch for");

      const none = yield* plan({ plan: "/runs/review-1", plan_kind: "review" });
      expect(none.branch).toBe("");
      expect(none.refused).toContain("names no target");
    }),
  ));

test("a mutating run makes its checkout with git and stays in the workspace it started in", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGitWithCheckouts([{ path: rig.projectDir, branch: "master" }]);

      const checkout = yield* checkoutFor(new Herdr(rig.pluginEnv()), {
        stateDir: rig.stateDir,
        cwd: rig.projectDir,
        workflow: "implement",
        checkout: "branch",
        name: "Add a picker",
        login: LOGIN,
        inputs: { plan_kind: "text" },
        // A workspace that is about the task, not about a checkout of the repository.
        workspaceId: "wTasks",
        workspaceLabel: "Tasks",
      });

      const at = join(rig.root, ".herdr", "worktrees", "project", LOGIN, "add-a-picker");
      expect(checkout).toMatchObject({
        cwd: at,
        workspaceId: "wTasks",
        workspaceLabel: "Tasks",
        refused: null,
      });
      expect(checkout.worktree).toEqual({
        path: at,
        branch: `${LOGIN}/add-a-picker`,
        managed_by: "git",
        workspace_id: null,
        created_by_collie: true,
        created_branch: false,
        created_on: null,
        made_at: expect.any(Number),
        // No workspace, so no shell tab of its own to take over.
        root_tab_id: null,
        root_pane_id: null,
      });
      // git itself, from the repository's own checkout, and no herdr workspace at all.
      expect(yield* askedIn()).toContainEqual({
        cwd: rig.projectDir,
        command: `worktree add ${at} -b ${LOGIN}/add-a-picker origin/master`,
      });
      expect(yield* rig.cmds()).toEqual([]);
    }),
  ));

test("a workspace whose own directory is not a checkout still gets its run a worktree", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGitWithCheckouts([{ path: rig.projectDir, branch: "master" }]);
      // A workspace that is about a task rather than about a repo directory: nothing
      // here says its own directory is a checkout, and nothing needs to — `COLLIE_CWD`
      // is what names the repository, and it beats the workspace's inferred directory.
      const env = rig.pluginEnv({ COLLIE_CWD: rig.projectDir, HERDR_WORKSPACE_ID: "wTasks" });
      expect(env.cwd).toBe(rig.projectDir);

      const checkout = yield* checkoutFor(new Herdr(env), {
        stateDir: rig.stateDir,
        cwd: env.cwd,
        workflow: "implement",
        checkout: "branch",
        name: "Add a picker",
        login: LOGIN,
        inputs: { plan_kind: "text" },
        workspaceId: env.workspaceId,
        workspaceLabel: "Tasks",
      });

      expect(checkout).toMatchObject({
        cwd: join(rig.root, ".herdr", "worktrees", "project", LOGIN, "add-a-picker"),
        // The workspace it was activated from, which is not a checkout of anything.
        workspaceId: "wTasks",
        refused: null,
      });
    }),
  ));

test("a branch with a slash in it nests, and never collides with the dashed name", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGitWithCheckouts([{ path: rig.projectDir, branch: "master" }]);
      const ask = (branch: string) =>
        checkoutFor(new Herdr(rig.pluginEnv()), {
          stateDir: rig.stateDir,
          cwd: rig.projectDir,
          workflow: "implement",
          checkout: "branch",
          name: "Add a picker",
          login: LOGIN,
          inputs: { plan_kind: "text" },
          explicit: branch,
        });

      const nested = yield* ask("feature/foo");
      const dashed = yield* ask("feature-foo");

      const worktrees = join(rig.root, ".herdr", "worktrees", "project");
      expect(nested.cwd).toBe(join(worktrees, "feature", "foo"));
      expect(dashed.cwd).toBe(join(worktrees, "feature-foo"));
      // Two branches are two checkouts: sharing a destination is one step from
      // sharing an index.
      expect(nested.cwd).not.toBe(dashed.cwd);
    }),
  ));

test("the checkout goes where herdr's own config says worktrees go", () =>
  runOnPath(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fakeGitWithCheckouts([{ path: rig.projectDir, branch: "master" }]);
      yield* fs.makeDirectory(join(rig.root, ".config", "herdr"), { recursive: true });
      yield* fs.writeFileString(
        join(rig.root, ".config", "herdr", "config.toml"),
        `[worktrees]\ndirectory = "${join(rig.root, "elsewhere")}"\n`,
      );

      const checkout = yield* checkoutFor(new Herdr(rig.pluginEnv()), {
        stateDir: rig.stateDir,
        cwd: rig.projectDir,
        workflow: "implement",
        checkout: "branch",
        name: "Add a picker",
        login: LOGIN,
        inputs: { plan_kind: "text" },
      });

      expect(checkout.cwd).toBe(join(rig.root, "elsewhere", "project", LOGIN, "add-a-picker"));
    }),
  ));

test("the checkout a branch already has is reused, never added twice", () =>
  runOnPath(
    Effect.gen(function* () {
      const existing = join(rig.root, "somewhere", "add-a-picker");
      yield* fakeGitWithCheckouts([
        { path: rig.projectDir, branch: "master" },
        { path: existing, branch: `${LOGIN}/add-a-picker` },
      ]);

      const checkout = yield* checkoutFor(new Herdr(rig.pluginEnv()), {
        stateDir: rig.stateDir,
        cwd: rig.projectDir,
        workflow: "implement",
        checkout: "branch",
        name: "Add a picker",
        login: LOGIN,
        inputs: { plan_kind: "text" },
        workspaceId: "wTasks",
      });

      expect(checkout.cwd).toBe(existing);
      expect(checkout.worktree).toMatchObject({
        created_by_collie: false,
        created_branch: false,
        managed_by: "git",
      });
      expect(yield* asked()).not.toContain(`worktree add ${existing}`);
    }),
  ));

test("a Run that asks for its own workspace has herdr make the checkout, and takes that workspace", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGit();

      const checkout = yield* checkoutFor(new Herdr(rig.pluginEnv()), {
        stateDir: rig.stateDir,
        cwd: rig.projectDir,
        workflow: "implement",
        checkout: "branch",
        name: "Add a picker",
        login: LOGIN,
        inputs: { plan_kind: "text" },
        separate: true,
        workspaceId: "wTasks",
      });

      expect(checkout.worktree).toMatchObject({
        branch: `${LOGIN}/add-a-picker`,
        managed_by: "herdr",
        workspace_id: "w1",
      });
      expect(checkout.workspaceId).toBe("w1");
      expect(yield* rig.cmds()).toEqual(["worktree list", "worktree create"]);
      // git is asked only about the branch, never to make the checkout.
      expect(yield* asked()).not.toContain("worktree list --porcelain");
    }),
  ));

test("a branch neither local nor on origin is one the Run created, and one origin has is not", () =>
  runOnPath(
    Effect.gen(function* () {
      const branch = `${LOGIN}/add-a-picker`;
      const place = (remote: string) =>
        Effect.gen(function* () {
          yield* fakeGitWithCheckouts([{ path: rig.projectDir, branch: "master" }], {
            scripts: { [`ls-remote --exit-code --heads origin refs/heads/${branch}`]: remote },
          });
          return yield* checkoutFor(new Herdr(rig.pluginEnv()), {
            stateDir: rig.stateDir,
            cwd: rig.projectDir,
            workflow: "implement",
            checkout: "branch",
            name: "Add a picker",
            login: LOGIN,
            inputs: { plan_kind: "text" },
            workspaceId: "wTasks",
          });
        });

      expect((yield* place("exit 2")).worktree).toMatchObject({
        created_branch: true,
        created_on: "git@gitlab.example.com:acme/app.git",
      });
      expect((yield* place(`printf 'deadbeef\\trefs/heads/${branch}\\n'`)).worktree).toMatchObject({
        created_branch: false,
        created_on: null,
      });
    }),
  ));

test("a checkout git will not add is a run that does not start", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGitWithCheckouts([{ path: rig.projectDir, branch: "master" }], {
        refusals: { "worktree add": "fatal: could not create leading directories" },
      });

      const checkout = yield* checkoutFor(new Herdr(rig.pluginEnv()), {
        stateDir: rig.stateDir,
        cwd: rig.projectDir,
        workflow: "implement",
        checkout: "branch",
        name: "Add a picker",
        login: LOGIN,
        inputs: { plan_kind: "text" },
        workspaceId: "wTasks",
      });

      // Never the caller's own checkout: sharing one is the bug this exists to stop.
      expect(checkout.refused).toBe(
        `no worktree for ${LOGIN}/add-a-picker: fatal: could not create leading directories`,
      );
      expect(checkout.worktree).toBe(null);
      expect(checkout.cwd).toBe(rig.projectDir);
    }),
  ));

test("a checkout Collie cannot be given is a run that does not start", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGit();
      const herdr = new Herdr(
        rig.pluginEnv({ FAKE_HERDR_FAIL: '{"worktree list":"unknown command"}' }),
      );

      const checkout = yield* checkoutFor(herdr, {
        stateDir: rig.stateDir,
        cwd: rig.projectDir,
        workflow: "implement",
        checkout: "branch",
        name: "Add a picker",
        login: LOGIN,
        inputs: { plan_kind: "text" },
        separate: true,
        workspaceId: "wT",
      });

      // Never the caller's own checkout: sharing one is the bug this exists to stop.
      expect(checkout.refused).toContain(`no worktree for ${LOGIN}/add-a-picker`);
      expect(checkout.worktree).toBe(null);
      expect(checkout.cwd).toBe(rig.projectDir);
    }),
  ));

const renovateCheckout = (inputs: Record<string, string> = {}, cwd = rig.projectDir) =>
  checkoutFor(new Herdr(rig.pluginEnv()), {
    cwd,
    stateDir: rig.stateDir,
    workflow: "renovate",
    checkout: "roaming",
    name: "Renovate spilnu",
    inputs,
    strategies: SHIPPED_STRATEGIES,
    workspaceId: "wTasks",
    workspaceLabel: "Tasks",
    recordedBy: (at) =>
      Effect.sync(() => {
        const run = recorded.find((one) => one.worktree?.path === at);
        if (run === undefined) return null;
        const release = Effect.sync(() => {
          releases += 1;
          return releasedAs;
        });
        return { run: run.id, worktree: run.worktree, release };
      }),
    claimed: (worktree) =>
      FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.exists(destinationLock(rig.stateDir, worktree.path))),
        Effect.orElseSucceed(() => false),
        Effect.map((locked) => {
          claims.push({ path: worktree.path, locked });
        }),
        Effect.provide(BunServices.layer),
      ),
  });

test("a roaming Run's repository is cloned through its URL's forge, and one on neither is refused", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGitAnswering(
        { ...gitAnswers(), "worktree list --porcelain": porcelain([]), config: "" },
        {},
        { clone: 'mkdir -p "$4/.git"' },
      );
      const forge = (name: "gitlab" | "github") =>
        forgeOnPath(bin, name, {
          installed: true,
          loggedIn: [name === "gitlab" ? "gitlab.example.com" : "github.com"],
          login: "tester",
          mrs: [],
        });
      const github = yield* forge("github");
      yield* forge("gitlab");

      const fromGithub = yield* renovateCheckout({ repository: "https://github.com/acme/app" });
      expect(fromGithub.refused ?? "").not.toContain("could not clone");
      expect((yield* github.model()).cloned).toEqual([
        expect.stringMatching(/^github\.com\/acme\/app \/.*renovate-repositories\//),
      ]);

      const fromGitlab = yield* renovateCheckout({
        repository: "https://gitlab.example.com/acme/app",
      });
      expect(fromGitlab.refused ?? "").not.toContain("could not clone");
      expect(
        (yield* asked()).some((c) =>
          c.startsWith("clone --quiet https://gitlab.example.com/acme/app.git"),
        ),
      ).toBe(true);

      expect(
        (yield* renovateCheckout({ repository: "https://bitbucket.org/acme/app" })).refused,
      ).toBe("bitbucket.org is neither GitHub nor GitLab");
    }),
  ));

test("a clone made before Collie kept its credentials gets the helper on its next use", () =>
  runOnPath(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const url = "https://gitlab.example.com/acme/old";
      const source = join(rig.stateDir, "renovate-repositories", Bun.hash(url).toString(16));
      yield* fs.makeDirectory(join(source, ".git"), { recursive: true });
      yield* fakeGitAnswering(
        {
          ...gitAnswers(),
          "worktree list --porcelain": porcelain([{ path: source, branch: "master" }]),
          config: "",
        },
        {},
        {
          "worktree add":
            'for a in "$@"; do case "$a" in /*) mkdir -p "$a" && printf "gitdir: $a/.gitdir\\n" > "$a/.git"; break ;; esac; done',
        },
      );

      const checkout = yield* renovateCheckout({ repository: url });

      expect(checkout.refused).toBeNull();
      const configured = (yield* askedIn()).filter(
        (call) => call.cwd === source && call.command.startsWith("config --local"),
      );
      expect(configured.map((call) => call.command)).toEqual([
        "config --local --unset-all credential.https://gitlab.example.com.helper",
        "config --local --add credential.https://gitlab.example.com.helper ",
        expect.stringMatching(
          /^config --local --add credential\.https:\/\/gitlab\.example\.com\.helper !.*glab config get token --host 'gitlab\.example\.com'/,
        ),
      ]);
      expect((yield* asked()).some((command) => command.startsWith("clone"))).toBe(false);
    }),
  ));

test("a Renovate Run gets a detached checkout at the default branch, bound to no branch", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGitWithCheckouts([{ path: rig.projectDir, branch: "master" }]);

      const checkout = yield* renovateCheckout();

      const at = join(rig.root, ".herdr", "worktrees", "project", "roaming");
      expect(checkout).toMatchObject({
        cwd: at,
        workspaceId: "wTasks",
        refused: null,
        // No branch of its own, so nothing to name or to have come from.
        branch: null,
        branchSource: null,
      });
      expect(checkout.worktree).toEqual({
        path: at,
        branch: "",
        managed_by: "git",
        workspace_id: null,
        created_by_collie: true,
        created_branch: false,
        created_on: null,
        made_at: expect.any(Number),
        root_tab_id: null,
        root_pane_id: null,
      });
      // Detached at the default branch as the remote has it, from the repository's own
      // checkout, and no branch is ever created or claimed for the Run.
      expect(yield* askedIn()).toContainEqual({
        cwd: rig.projectDir,
        command: `worktree add --detach ${at} origin/master`,
      });
      const commands = yield* asked();
      expect(commands.some((c) => c.startsWith("worktree add") && !c.includes("--detach"))).toBe(
        false,
      );
      expect(commands.some((c) => /^(checkout|switch|stash|commit)\b/.test(c))).toBe(false);
    }),
  ));

test("the repository input says which local checkout the Renovate worktree is cut from", () =>
  runOnPath(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const elsewhere = join(rig.root, "work", "spilnu");
      yield* fs.makeDirectory(elsewhere, { recursive: true });
      yield* fakeGitWithCheckouts([{ path: elsewhere, branch: "master" }]);

      // Started in one directory, pointed at another: the input wins, and the worktree
      // is cut from the repository it names.
      const checkout = yield* renovateCheckout({ repository: elsewhere });

      expect(checkout.cwd).toBe(join(rig.root, ".herdr", "worktrees", "spilnu", "roaming"));
      expect(yield* askedIn()).toContainEqual({
        cwd: elsewhere,
        command: `worktree add --detach ${checkout.cwd} origin/master`,
      });
    }),
  ));

test("a GitLab URL is cloned before the Renovate worktree is cut", () =>
  runOnPath(
    Effect.gen(function* () {
      const url = "https://gitlab.example.com/acme/spilnu/-/merge_requests";
      const source = join(rig.stateDir, "renovate-repositories", Bun.hash(url).toString(16));
      yield* fakeGitAnswering(
        {
          ...gitAnswers(),
          "worktree list --porcelain": porcelain([{ path: source, branch: "master" }]),
          config: "",
        },
        {},
        {
          clone: 'mkdir -p "$4" && printf "gitdir: $4/.gitdir\\n" > "$4/.git"',
          "worktree add":
            'for a in "$@"; do case "$a" in /*) mkdir -p "$a" && printf "gitdir: $a/.gitdir\\n" > "$a/.git"; break ;; esac; done',
        },
      );
      yield* bin.add("glab", 'case "$1 $2" in "config get") printf token ;; *) exit 1 ;; esac');

      const checkout = yield* renovateCheckout({ repository: url });

      expect(yield* askedIn()).toContainEqual({
        cwd: rig.stateDir,
        command: `clone --quiet https://gitlab.example.com/acme/spilnu.git ${source}`,
      });
      expect(yield* askedIn()).toContainEqual({
        cwd: source,
        command: `worktree add --detach ${checkout.cwd} origin/master`,
      });
      expect(checkout.refused).toBeNull();
    }),
  ));

test("two Renovate Runs on different repositories do not collide on a checkout path", () =>
  runOnPath(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const other = join(rig.root, "work", "happytiger");
      yield* fs.makeDirectory(other, { recursive: true });
      // Each repository lists only itself, which is what a real `worktree list`
      // answers in either of them.
      yield* fakeGitWithCheckouts([{ path: rig.projectDir, branch: "master" }]);
      const here = yield* renovateCheckout();

      yield* fakeGitWithCheckouts([{ path: other, branch: "master" }]);
      const there = yield* renovateCheckout({ repository: other });

      expect(here.cwd).toBe(join(rig.root, ".herdr", "worktrees", "project", "roaming"));
      expect(there.cwd).toBe(join(rig.root, ".herdr", "worktrees", "happytiger", "roaming"));
      expect(here.cwd).not.toBe(there.cwd);
    }),
  ));

test("the repository a checkout belongs to is git's, never the directory's own name", () =>
  runOnPath(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // The two cases whose basename lies: a Renovate Run's checkout, always called
      // `renovate`, and a branch-owning one, called after its branch.
      const roaming = join(rig.root, ".herdr", "worktrees", "project", "roaming");
      const owned = join(rig.root, ".herdr", "worktrees", "project", "add-picker");
      for (const at of [roaming, owned]) yield* fs.makeDirectory(at, { recursive: true });
      yield* fakeGitWithCheckouts([
        { path: rig.projectDir, branch: "master" },
        { path: owned, branch: "add-picker" },
      ]);

      expect(yield* repositoryName(shell, roaming)).toBe("project");
      expect(yield* repositoryName(shell, owned)).toBe("project");
    }),
  ));

test("a linked worktree of a repository picks the same destination the repository does", () =>
  runOnPath(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // A checkout of the same repository, one branch along. `worktree list` answers
      // the same in either of them, and git lists the repository itself first.
      const linked = join(rig.root, "worktrees", "some-feature");
      yield* fs.makeDirectory(linked, { recursive: true });
      yield* fakeGitWithCheckouts([
        { path: rig.projectDir, branch: "master" },
        { path: linked, branch: "some-feature" },
      ]);

      // Pointed at the linked worktree, not the repository: the destination is still
      // the repository's, or one repository would get two Renovate checkouts.
      const checkout = yield* renovateCheckout({ repository: linked });

      expect(checkout.cwd).toBe(join(rig.root, ".herdr", "worktrees", "project", "roaming"));
      expect(checkout.cwd).not.toContain("some-feature");
    }),
  ));

test("the roaming checkout fetches first, and falls back to a local default branch", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGitWithCheckouts([{ path: rig.projectDir, branch: "master" }]);

      yield* renovateCheckout();

      // "As the remote has it" means asking the remote, not this checkout's memory.
      const commands = yield* asked();
      expect(commands.some((c) => c.startsWith("fetch"))).toBe(true);
      expect(commands.indexOf(commands.find((c) => c.startsWith("fetch"))!)).toBeLessThan(
        commands.indexOf(commands.find((c) => c.startsWith("worktree add"))!),
      );
    }),
  ));

test("a roaming checkout whose origin will not fetch is refused rather than cut from a stale base", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGitWithCheckouts([{ path: rig.projectDir, branch: "master" }], {
        refusals: { fetch: "fatal: Could not read from remote repository." },
      });

      const checkout = yield* renovateCheckout();

      expect(checkout.refused).toContain("could not fetch origin");
      expect(checkout.refused).toContain("Could not read from remote repository");
      expect((yield* asked()).some((command) => command.startsWith("worktree add"))).toBe(false);
    }),
  ));

test("a repository with no remote-tracking default branch is detached at the local one", () =>
  runOnPath(
    Effect.gen(function* () {
      // No `origin/master` to verify: the same case `implement` already handles by
      // taking the local branch rather than refusing.
      yield* fakeGitAnswering(
        {
          "remote get-url origin": "git@gitlab.example.com:acme/app.git",
          fetch: "",
          "rev-parse --abbrev-ref HEAD": "master",
          "worktree list --porcelain": porcelain([{ path: rig.projectDir, branch: "master" }]),
        },
        {},
        {
          "worktree add":
            'for a in "$@"; do case "$a" in /*) mkdir -p "$a" && printf "gitdir: $a/.gitdir\n" > "$a/.git"; break ;; esac; done',
        },
      );

      const checkout = yield* renovateCheckout();

      expect(checkout.refused).toBe(null);
      const at = join(rig.root, ".herdr", "worktrees", "project", "roaming");
      expect(yield* asked()).toContainEqual(`worktree add --detach ${at} master`);
    }),
  ));

/** A linked worktree at `at`, as git leaves one: the `.git` file naming its owner. */
const worktreeOwnedBy = Effect.fn("worktreeTest.worktreeOwnedBy")(function* (
  at: string,
  repo: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(at, { recursive: true });
  yield* fs.writeFileString(`${at}/.git`, `gitdir: ${repo}/.git/worktrees/renovate\n`);
});

/** A Renovate Run that recorded this checkout, as one that is still running would. */
const renovateRunAt = (at: string) =>
  Effect.gen(function* () {
    const made = yield* (yield* FileSystem.FileSystem).stat(`${at}/.git`);
    const run = runFacts({
      id: "renovate-project",
      workflow: "renovate",
      cwd: at,
      worktree: {
        path: at,
        branch: "",
        created_by_collie: true,
        created_branch: false,
        created_on: null,
        managed_by: "git",
        workspace_id: null,
        made_at: Option.getOrThrow(made.mtime).getTime(),
        root_tab_id: null,
        root_pane_id: null,
      },
    });
    recorded.push(run);
    return run.id;
  });

/** A git listing this repository's roaming checkout, in whatever state `answers` says it is. */
const fakeGitWithRoaming = (taken: string, answers: Record<string, string>) =>
  fakeGitAnswering({
    ...gitAnswers(),
    "worktree list --porcelain": porcelain([
      { path: rig.projectDir, branch: "master" },
      { path: taken, branch: "master" },
    ]),
    "status --porcelain": "",
    "rev-list HEAD --not --branches --remotes": "",
    "checkout --quiet --no-overwrite-ignore --detach": "",
    ...answers,
  });

test("a second Renovate Run on one repository is refused while the first may go on, never handed its tree", () =>
  runOnPath(
    Effect.gen(function* () {
      const taken = join(rig.root, ".herdr", "worktrees", "project", "roaming");
      yield* worktreeOwnedBy(taken, rig.projectDir);
      // The earlier Run's own record, which is the only proof that this checkout is a
      // Renovate Run's rather than something that merely looks like one.
      const runId = yield* renovateRunAt(taken);
      releasedAs = `${runId} has not ended and may still go on in it`;
      yield* fakeGitWithRoaming(taken, {});

      const checkout = yield* renovateCheckout();

      expect(checkout.refused).toBe(
        `no worktree for ${rig.projectDir}: ${taken} is a checkout of ${rig.projectDir}, recorded by Run ${runId}: ${runId} has not ended and may still go on in it`,
      );
      expect(checkout.worktree).toBe(null);
      // Never the caller's own checkout: sharing one is the bug this exists to stop.
      expect(checkout.cwd).toBe(rig.projectDir);
      expect(yield* asked()).not.toContain(`worktree add --detach ${taken} origin/master`);
      // Neither checkout nor repository is touched: no add, no remove, nothing moved.
      const commands = yield* asked();
      expect(commands.some((c) => c.startsWith("worktree add"))).toBe(false);
      expect(commands.some((c) => c.startsWith("worktree remove"))).toBe(false);
      expect(commands.some((c) => c.startsWith("checkout"))).toBe(false);
      expect(yield* (yield* FileSystem.FileSystem).readFileString(`${taken}/.git`)).toContain(
        `gitdir: ${rig.projectDir}/.git/worktrees/renovate`,
      );
    }),
  ));

test("a Renovate Run takes over the checkout an ended Run of the repository left, at the default branch", () =>
  runOnPath(
    Effect.gen(function* () {
      const taken = join(rig.root, ".herdr", "worktrees", "project", "roaming");
      yield* worktreeOwnedBy(taken, rig.projectDir);
      const runId = yield* renovateRunAt(taken);
      yield* fakeGitWithRoaming(taken, {});

      const checkout = yield* renovateCheckout();

      expect(checkout.refused).toBe(null);
      expect(checkout.cwd).toBe(taken);
      expect(checkout.worktree).toMatchObject({ path: taken, branch: "", managed_by: "git" });
      expect(checkout.note).toBe(
        `took worktree ${taken} over from Run ${runId}, detached at origin/master`,
      );
      expect(releases).toBe(1);
      expect(yield* askedIn()).toContainEqual({
        cwd: taken,
        command: "checkout --quiet --no-overwrite-ignore --detach origin/master",
      });
      const commands = yield* asked();
      expect(commands.some((c) => c.startsWith("worktree add"))).toBe(false);
      expect(commands.some((c) => c.startsWith("worktree remove"))).toBe(false);
      // A fetch can prune the only ref a commit was on, so what would be lost is read after it.
      const fetched = commands.indexOf("fetch --quiet origin");
      expect(fetched).toBeGreaterThanOrEqual(0);
      expect(commands.indexOf("rev-list HEAD --not --branches --remotes")).toBeGreaterThan(fetched);
      // Recorded as the new Run's before the lock goes, so the next start finds it taken.
      expect(claims).toEqual([{ path: taken, locked: true }]);
    }),
  ));

test("a checkout made at a recorded path since the Run recorded it is never taken over", () =>
  runOnPath(
    Effect.gen(function* () {
      const taken = join(rig.root, ".herdr", "worktrees", "project", "roaming");
      yield* worktreeOwnedBy(taken, rig.projectDir);
      const runId = yield* renovateRunAt(taken);
      yield* (yield* FileSystem.FileSystem).utimes(`${taken}/.git`, 0, 1_000);
      yield* fakeGitWithRoaming(taken, {});

      const checkout = yield* renovateCheckout();

      expect(checkout.refused).toBe(
        `no worktree for ${rig.projectDir}: ${taken} is a checkout of ${rig.projectDir}, recorded by Run ${runId}, but not the checkout that Run made`,
      );
      expect(releases).toBe(0);
      expect(claims).toEqual([]);
      expect((yield* asked()).some((c) => c.startsWith("checkout"))).toBe(false);
    }),
  ));

test("an ended Run's checkout that holds work is kept for it, and its agents are left alone", () =>
  runOnPath(
    Effect.gen(function* () {
      const taken = join(rig.root, ".herdr", "worktrees", "project", "roaming");
      yield* worktreeOwnedBy(taken, rig.projectDir);
      const runId = yield* renovateRunAt(taken);
      const held = `${taken} is a checkout of ${rig.projectDir}, recorded by Run ${runId}, kept:`;

      yield* fakeGitWithRoaming(taken, { "status --porcelain": " M package.json\n" });
      const dirty = yield* renovateCheckout();
      // Commits only its detached HEAD reaches, which moving it would leave behind.
      yield* fakeGitWithRoaming(taken, {
        "rev-list HEAD --not --branches --remotes": "a1\\nb2\\n",
      });
      const unpushed = yield* renovateCheckout();

      expect(dirty.refused).toBe(`no worktree for ${rig.projectDir}: ${held} uncommitted changes`);
      expect(unpushed.refused).toBe(
        `no worktree for ${rig.projectDir}: ${held} 2 commit(s) on no branch or remote`,
      );
      expect(releases).toBe(0);
      expect((yield* asked()).some((c) => c.startsWith("checkout"))).toBe(false);
    }),
  ));

test("two repositories of the same name never share one Renovate checkout", () =>
  runOnPath(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      // Two `project`s in two directories want the same path under the worktrees
      // directory, because the path is named after the repository, not its location.
      const other = join(rig.root, "elsewhere", "project");
      yield* fs.makeDirectory(other, { recursive: true });
      const taken = join(rig.root, ".herdr", "worktrees", "project", "roaming");
      yield* worktreeOwnedBy(taken, rig.projectDir);
      yield* fakeGitWithCheckouts([{ path: other, branch: "master" }]);

      const checkout = yield* renovateCheckout({ repository: other });

      // Named, so the operator knows which repository is holding it.
      expect(checkout.refused).toBe(
        `no worktree for ${other}: ${taken} is a checkout of ${rig.projectDir}`,
      );
      expect(checkout.worktree).toBe(null);
      // Refused, so the Run stays where it was started rather than in either repository.
      expect(checkout.cwd).toBe(rig.projectDir);
    }),
  ));

test("a path in the way that will not say whose it is refuses, rather than being built over", () =>
  runOnPath(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const at = join(rig.root, ".herdr", "worktrees", "project", "roaming");
      // Something is there and nothing says what: the answer is a refusal naming it,
      // never a worktree added on top of whatever it is.
      yield* fs.makeDirectory(at, { recursive: true });
      yield* fakeGitWithCheckouts([{ path: rig.projectDir, branch: "master" }]);

      const checkout = yield* renovateCheckout();

      expect(checkout.refused).toBe(
        `no worktree for ${rig.projectDir}: ${at} is a checkout that does not say which repository it belongs to`,
      );
      expect(checkout.worktree).toBe(null);
      expect((yield* asked()).some((command) => command.startsWith("worktree add"))).toBe(false);
    }),
  ));

test("a destination another Run is claiming right now is refused, not looked at twice", () =>
  runOnPath(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fakeGitWithCheckouts([{ path: rig.projectDir, branch: "master" }]);
      const at = join(rig.root, ".herdr", "worktrees", "project", "roaming");
      // A live claim on the destination, as a Run starting at the same moment holds it.
      // Looking and creating happen under it, so the loser never finds the path free.
      yield* fs.writeFileString(
        destinationLock(rig.stateDir, at),
        `{"pid":${process.pid},"start":null}\n`,
      );

      const checkout = yield* renovateCheckout();

      expect(checkout.refused).toBe(
        `no worktree for ${rig.projectDir}: ${at} is being claimed by another Run starting now`,
      );
      expect(checkout.worktree).toBe(null);
      expect((yield* asked()).some((command) => command.startsWith("worktree add"))).toBe(false);
    }),
  ));

test("a repository git will not add a detached worktree in is a Run that does not start", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGitWithCheckouts([{ path: rig.projectDir, branch: "master" }], {
        refusals: { "worktree add": "fatal: could not create leading directories" },
      });

      const checkout = yield* renovateCheckout();

      expect(checkout.refused).toBe(
        `no worktree for ${rig.projectDir}: fatal: could not create leading directories`,
      );
      expect(checkout.worktree).toBe(null);
      expect(checkout.cwd).toBe(rig.projectDir);
    }),
  ));

test("a workflow that changes nothing works where it was started, and is not refused", () =>
  runOnPath(
    Effect.gen(function* () {
      const checkout = yield* checkoutFor(new Herdr(rig.pluginEnv()), {
        stateDir: rig.stateDir,
        cwd: rig.projectDir,
        workflow: "review",
        checkout: "none",
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
        // A workflow that changes nothing has no branch of its own to name.
        branch: null,
        task: null,
        branchSource: null,
      });
      expect(yield* rig.cmds()).toEqual([]);
    }),
  ));

test("a merge request Collie cannot read is a run that does not start", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGit("some-other-branch");
      // Logged in, but the merge request will not be read.
      yield* bin.add(
        "glab",
        `case "$1 $2 $3" in "config get token") echo glpat-test ;; "api "*) exit 1 ;; esac; exit 0`,
      );

      // Never `slugify(name)`: the fixes belong on the branch that was reviewed, and a
      // new branch named after the run would leave the merge request untouched.
      expect(
        yield* plan({
          plan: "/runs/review-1",
          plan_kind: "review",
          target: "mr:42",
          target_kind: "mr",
        }),
      ).toMatchObject({ refused: "could not read !42: GitLab answered 404: 404" });
      yield* bin.add("glab", `exit 1`);
      // A host that has not yet read glab's token, as a fresh one has not.
      expect(
        yield* plan({
          plan: "/runs/review-1",
          plan_kind: "review",
          target: "mr:42",
          target_kind: "mr",
        }).pipe(Effect.provide(Layer.fresh(forgeHttpOnPath))),
      ).toMatchObject({
        refused: "could not read !42: glab is not logged in to gitlab.example.com",
      });
    }),
  ));

test("a merge request in another project cannot be fixed from this checkout", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGitAnswering({
        "remote get-url origin": "git@gitlab.example.com:acme/app.git",
        "symbolic-ref --short refs/remotes/origin/HEAD": "origin/master",
      });
      // glab would answer, but a worktree of this repository is not a checkout of theirs.
      yield* bin.add("glab", `echo '{"source_branch": "theirs"}'`);

      expect(
        yield* plan({
          plan: "/runs/review-1",
          plan_kind: "review",
          target: "mr:gitlab.example.com/other/thing!7",
          target_kind: "mr",
        }),
      ).toMatchObject({
        refused:
          "other/thing!7 is in gitlab.example.com/other/thing, and this is a checkout of gitlab.example.com/acme/app",
      });
    }),
  ));

test("an agent working in a subdirectory of a checkout keeps it", () =>
  runOnPath(
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
  runOnPath(
    Effect.gen(function* () {
      yield* collieWorktree("wt", { workspaceId: "w7" });
      yield* settledGit();
      yield* mergedMr();
      // herdr reports some panes without a cwd; the workspace it is in is the evidence.
      yield* rig.addPane("1-9", "1:9", "", "claude", "w7");

      expect(yield* prune()).toEqual(["kept wt · an agent is working in it"]);
    }),
  ));

test("a finished Run's own agent, idle in the tab it left behind, does not keep its checkout", () =>
  runOnPath(
    Effect.gen(function* () {
      const worktreePath = yield* collieWorktree("wt", { panes: ["1-5"] });
      yield* settledGit();
      yield* mergedMr();
      // The Run is done and its agent is still sitting there, idle — that is the leftover
      // the removal closes, not work in progress.
      yield* rig.addPane("1-5", "1:5", worktreePath, "claude");

      expect(yield* prune()).toEqual(["♻ removed wt · merged in !14"]);
      const closed = (yield* rig.calls()).filter((call) => call.cmd === "tab close");
      expect(closed.map((call) => call.argv?.at(2))).toEqual(["1:5"]);
    }),
  ));

test("a finished Run's own agent still working in its tab keeps the checkout", () =>
  runOnPath(
    Effect.gen(function* () {
      const worktreePath = yield* collieWorktree("wt", { panes: ["1-5"] });
      yield* settledGit();
      yield* mergedMr();
      yield* rig.addPane("1-5", "1:5", worktreePath, "claude", null, null, "working");

      expect(yield* prune()).toEqual(["kept wt · an agent is working in it"]);
    }),
  ));

test("a board outside any repository still sweeps the checkouts the Runs recorded", () =>
  runOnPath(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const worktreePath = yield* collieWorktree("wt", { managedBy: "git", workspaceId: null });
      yield* settledGit();
      yield* mergedMr();
      // The Home: herdr refuses to list worktrees from it, and the sweep asks the
      // recorded checkout instead.
      const home = join(rig.root, "home");
      yield* fs.makeDirectory(home, { recursive: true });
      const herdr = new Herdr(
        rig.pluginEnv({
          FAKE_HERDR_FAIL: '{"worktree list":"not a git worktree"}',
          FAKE_HERDR_FAIL_TIMES: "1",
        }),
      );

      expect(
        yield* pruneWorktrees({
          herdr,
          stateDir: rig.stateDir,
          runs: recorded,
          registered,
          cwd: home,
          settling,
        }),
      ).toEqual(["♻ removed wt · merged in !14"]);
      expect(yield* asked()).toContain(`worktree remove ${worktreePath}`);
    }),
  ));

test("a hand-made checkout at the path a Collie one used is not a candidate", () =>
  runOnPath(
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
  runOnPath(
    Effect.gen(function* () {
      yield* collieWorktree("wt");
      yield* mergedMr();
      // `git fetch --prune` took the upstream ref with the branch; everything this
      // checkout holds is in the default branch already.
      yield* settledGit({
        "rev-parse --abbrev-ref --symbolic-full-name @{u}": "",
        "symbolic-ref --short refs/remotes/origin/HEAD": "origin/master",
        "rev-list HEAD --not": "",
      });

      expect(yield* prune()).toEqual(["♻ removed wt · merged in !14"]);
    }),
  ));

test("without an upstream, a commit that is on no other branch keeps the checkout", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* collieWorktree("wt");
      yield* mergedMr();
      yield* settledGit({
        "rev-parse --abbrev-ref --symbolic-full-name @{u}": "",
        "symbolic-ref --short refs/remotes/origin/HEAD": "origin/master",
        "rev-list HEAD --not": "c1\\nc2",
      });

      expect(yield* prune()).toEqual(["kept wt · 2 commit(s) on no remote"]);
    }),
  ));

test("the branch is deleted from the repository's own checkout, not the one that went", () =>
  runOnPath(
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
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGit("on-this-one");

      // `branch:main...HEAD` is a perfectly good thing to review, and `HEAD` is not
      // even a legal branch name — so there is nothing to commit fixes to.
      expect(
        yield* plan({
          plan: "/runs/review-1",
          plan_kind: "review",
          target: "branch:main...HEAD",
          target_kind: "branch",
        }),
      ).toMatchObject({
        refused: "HEAD is not a branch, so there is nothing to fix on it",
      });
      expect(
        yield* plan({
          plan: "/runs/review-1",
          plan_kind: "review",
          target: "branch:1a2b3c4...9f8e7d6",
          target_kind: "branch",
        }),
      ).toMatchObject({
        refused: "9f8e7d6 is not a branch, so there is nothing to fix on it",
      });
    }),
  ));

test("a run parked for a human keeps the checkout it will carry on in", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* collieWorktree("wt");
      // A question nobody answered, or a pane that would not take a prompt: the Run picks
      // up again in the directory it works in.
      recorded = recorded.map((run) => ({ ...run, state: "waiting" as const }));
      yield* settledGit();
      yield* mergedMr();

      expect(yield* prune()).toEqual(["kept wt · a run is still working in it"]);
    }),
  ));

test("a stopped run keeps the checkout a resume carries on in, until its work lands", () =>
  runOnPath(
    Effect.gen(function* () {
      const at = yield* collieWorktree("wt");
      recorded = recorded.map((run) => ({ ...run, state: "stopped" as const }));
      yield* settledGit();
      settling = { ...settling, openOn: new Map([[onBranch(rig.projectDir, "wt"), "!14"]]) };
      expect(yield* prune()).toEqual(["kept wt · a stopped run can resume in it"]);

      yield* mergedMr();
      // Judged afresh, past the verdict the last round left standing.
      expect((yield* sweeper().judge).remove.map((item) => item.target)).toEqual([at]);
    }),
  ));

test("an agent that started elsewhere and moved into a checkout keeps it", () =>
  runOnPath(
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
  runOnPath(
    Effect.gen(function* () {
      yield* collieWorktree("wt");
      // No merge request to settle it, so the remote branch is the question — and a
      // checkout whose branch is still there is not settled, upstream ref or no.
      yield* bin.add("glab", `exit 1`);
      yield* settledGit({
        "rev-parse --abbrev-ref --symbolic-full-name @{u}": "",
        "symbolic-ref --short refs/remotes/origin/HEAD": "origin/master",
        "rev-list HEAD --not": "",
        "ls-remote --heads origin": "deadbeef refs/heads/wt",
      });

      expect(yield* prune()).toEqual(["kept wt · still on the remote"]);
    }),
  ));

test("one repository's board neither forgets nor reports another's", () =>
  runOnPath(
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
          runs: recorded,
          registered,
          cwd: elsewhere,
          settling,
        }),
      ).toEqual([]);

      const kept = yield* fs.readFileString(join(rig.stateDir, "worktrees.json"));
      expect(kept).toContain("kept wt · uncommitted changes");
      expect(kept).toContain(rig.projectDir);
    }),
  ));

test("a branch git will not delete is a removal that keeps saying so", () =>
  runOnPath(
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
  runOnPath(
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
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGit();
      yield* bin.add("glab", `echo '{"source_branch": "long-gone"}'`);

      // Cutting it from the default branch would build something unrelated and then
      // fail to push it, or push it over the branch that was reviewed.
      expect(
        yield* plan({
          plan: "/runs/review-1",
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

test("a reviewed branch that exists only here is checked out as it is", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGitAnswering(
        {
          ...gitAnswers(),
          "worktree list --porcelain": porcelain([{ path: rig.projectDir, branch: "master" }]),
          "rev-parse --verify refs/heads/unpushed": "deadbeef",
          "rev-parse --verify --quiet refs/heads/unpushed": "deadbeef",
        },
        { "fetch origin": "fatal: unable to access 'https://gitlab.example.com/'" },
        {
          "worktree add":
            'for a in "$@"; do case "$a" in /*) mkdir -p "$a" && printf "gitdir: $a/.gitdir\\n" > "$a/.git"; break ;; esac; done',
        },
      );

      const checkout = yield* checkoutFor(new Herdr(rig.pluginEnv()), {
        stateDir: rig.stateDir,
        cwd: rig.projectDir,
        workflow: "review",
        checkout: "branch",
        name: "r-review",
        inputs: { plan: "/runs/review-1", plan_kind: "review", target: "branch:master...unpushed" },
        strategies: SHIPPED_STRATEGIES,
      });

      const at = join(rig.root, ".herdr", "worktrees", "project", "unpushed");
      expect(checkout).toMatchObject({ cwd: at, branch: "unpushed", refused: null });
      expect(checkout.worktree).toMatchObject({ path: at, created_by_collie: true });
      expect(yield* askedIn()).toContainEqual({
        cwd: rig.projectDir,
        command: `worktree add ${at} unpushed`,
      });
    }),
  ));

test("a merge request from a fork is refused even where its branch name is local here", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* fakeGitAnswering({
        ...gitAnswers(),
        "rev-parse --verify refs/heads/fix-the-parser": "deadbeef",
        "rev-parse --verify --quiet refs/heads/fix-the-parser": "deadbeef",
      });
      yield* bin.add(
        "glab",
        `echo '{"source_branch": "fix-the-parser", "source_project_id": 7, "target_project_id": 3}'`,
      );

      expect(
        yield* plan({
          plan: "/runs/review-1",
          plan_kind: "review",
          target: "mr:gitlab.example.com/acme/app!42",
          target_kind: "mr",
        }),
      ).toMatchObject({
        refused: "acme/app!42 comes from a fork, so its branch is not in this checkout",
      });
    }),
  ));

test("a checkout with no GitLab remote cannot be shown to be the reviewed project", () =>
  runOnPath(
    Effect.gen(function* () {
      // A group folder, or a checkout with no remote: nothing here says the merge
      // request belongs to it, and a bare `mr:42` came from this remote in the first
      // place.
      yield* fakeGitAnswering({ "symbolic-ref --short refs/remotes/origin/HEAD": "origin/master" });
      yield* bin.add("glab", `echo '{"source_branch": "theirs"}'`);

      expect(
        yield* plan({
          plan: "/runs/review-1",
          plan_kind: "review",
          target: "mr:gitlab.example.com/acme/app!42",
          target_kind: "mr",
        }),
      ).toMatchObject({
        refused: `${rig.projectDir} has no remote, so acme/app!42 may not be its own`,
      });
    }),
  ));

test("a checkout made again by hand at the same path and branch is not a candidate", () =>
  runOnPath(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const worktreePath = yield* collieWorktree("wt");
      yield* settledGit();
      yield* mergedMr();

      // Collie's checkout was removed by hand, and a human made their own at the same
      // path on the same branch. Path and branch match the old run record; the moment
      // git wrote the checkout does not.
      yield* Effect.sleep("10 millis");
      yield* fs.writeFileString(`${worktreePath}/.git`, `gitdir: ${worktreePath}/.gitdir\n`);

      expect(yield* prune()).toEqual([]);
      expect((yield* rig.cmds()).includes("worktree remove")).toBe(false);
    }),
  ));

/** The cleanup sweep's worktree kind, over what this test recorded. */
const sweeper = (herdr = new Herdr(rig.pluginEnv())) =>
  worktreesSweeper({
    herdr,
    sessions: [],
    stateDir: rig.stateDir,
    runs: recorded,
    registered,
    cwd: rig.projectDir,
    settling: Effect.sync(() => settling),
  });

test("cleanup lists a settled worktree as removable, and sweeping removes it", () =>
  runOnPath(
    Effect.gen(function* () {
      const at = yield* collieWorktree("wt");
      yield* settledGit();
      yield* mergedMr();

      const judged = yield* sweeper().judge;
      expect(judged.remove).toEqual([
        { kind: "worktree", target: at, bytes: expect.any(Number), reason: "merged in !14" },
      ]);
      // Judging removes nothing.
      expect((yield* rig.cmds()).includes("worktree remove")).toBe(false);

      const report = yield* sweep([sweeper()], rig.stateDir, "host");
      expect(report.remove.map((item) => item.target)).toEqual([at]);
      expect((yield* rig.cmds()).includes("worktree remove")).toBe(true);
    }),
  ));

test("cleanup keeps an unsettled worktree, naming the first condition it fails", () =>
  runOnPath(
    Effect.gen(function* () {
      const at = yield* collieWorktree("wt");
      yield* settledGit({ "status --porcelain": " M src/a.ts" });
      yield* mergedMr();

      const judged = yield* sweeper().judge;
      expect(judged.remove).toEqual([]);
      expect(judged.keep).toEqual([
        { kind: "worktree", target: at, reason: "uncommitted changes" },
      ]);
    }),
  ));

test("cleanup keeps every worktree when herdr will not list panes, and says why", () =>
  runOnPath(
    Effect.gen(function* () {
      const at = yield* collieWorktree("wt");
      yield* settledGit();
      yield* mergedMr();
      const herdr = new Herdr(rig.pluginEnv({ FAKE_HERDR_FAIL: '{"pane list":"herdr is gone"}' }));

      const report = yield* sweep([sweeper(herdr)], rig.stateDir, "host");
      expect(report.remove).toEqual([]);
      expect(report.keep).toEqual([
        { kind: "worktree", target: at, reason: "could not ask herdr what is live" },
      ]);
      expect((yield* rig.cmds()).includes("worktree remove")).toBe(false);
    }),
  ));

test("a merge the merge watch recorded on GitHub settles a branch still on the remote", () =>
  runOnPath(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const at = yield* collieWorktree("wt");
      recorded = recorded.map((run) => ({ ...run, mr: "https://github.com/o/r/pull/5" }));
      yield* settledGit({ "ls-remote --heads origin": "deadbeef refs/heads/wt" });
      yield* fs.makeDirectory(`${rig.stateDir}/board`, { recursive: true });
      yield* fs.writeFileString(
        `${rig.stateDir}/board/mr-states.json`,
        '{"o/r#5":{"state":"merged","checks":{"state":"passed"},"head":"abc"}}',
      );
      settling = yield* settlingOf({
        stateDir: rig.stateDir,
        runs: recorded,
        tasks: [],
        sessions: [new Herdr(rig.pluginEnv())],
        protect: [],
      });

      expect(yield* prune()).toEqual(["♻ removed wt · merged in o/r#5"]);
      expect(yield* asked()).not.toContain(`ls-remote --heads origin wt`);
      expect(
        (yield* askedIn()).some((one) => one.cwd === at && one.command === "status --porcelain"),
      ).toBe(true);
    }),
  ));

test("a squash-merged branch goes when its head is the head that merged", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* collieWorktree("wt");
      yield* mergedMr("abc123");
      yield* settledGit({
        "rev-parse --abbrev-ref --symbolic-full-name @{u}": "",
        "rev-list HEAD --not": "c1\\nc2",
        "rev-parse HEAD": "abc123",
      });

      expect(yield* prune()).toEqual(["♻ removed wt · merged in !14"]);
    }),
  ));

test("a squash-merged branch whose head moved on since keeps its checkout", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* collieWorktree("wt");
      yield* mergedMr("abc123");
      yield* settledGit({
        "rev-parse --abbrev-ref --symbolic-full-name @{u}": "",
        "rev-list HEAD --not": "c3",
        "rev-parse HEAD": "fff999",
      });

      expect(yield* prune()).toEqual(["kept wt · 1 commit(s) on no remote"]);
    }),
  ));

test("a checkout whose Task's workspace is still open is kept, as the last condition", () =>
  runOnPath(
    Effect.gen(function* () {
      const at = yield* collieWorktree("wt");
      yield* settledGit();
      yield* mergedMr();
      settling = {
        ...settling,
        workspaceHolds: new Map([[at, "its Task's workspace is still open"]]),
      };

      expect(yield* prune()).toEqual(["kept wt · its Task's workspace is still open"]);
    }),
  ));

test("the plugin root is never removed, even where a Run recorded it", () =>
  runOnPath(
    Effect.gen(function* () {
      const at = yield* collieWorktree("wt");
      yield* settledGit();
      yield* mergedMr();
      settling = { ...settling, protect: new Set([at]) };

      expect(yield* prune()).toEqual([]);
      expect((yield* rig.cmds()).includes("worktree remove")).toBe(false);
    }),
  ));

test("a Collie checkout whose branch was switched is judged, and removed, as it is now", () =>
  runOnPath(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const at = yield* collieWorktree("wt");
      const made = recorded[0]!.worktree!.made_at!;
      yield* rig.setWorktrees([{ branch: "other", path: at, open_workspace_id: "w7" }]);
      // The same checkout git wrote: only the branch in it changed.
      const when = DateTime.toDateUtc(DateTime.makeUnsafe(made));
      yield* fs.utimes(`${at}/.git`, when, when);
      yield* settledGit();
      settling = {
        ...settling,
        landedOn: new Map([
          [onBranch(rig.projectDir, "other"), { why: "merged in !15", heads: [] }],
        ]),
      };

      expect(yield* prune()).toEqual(["♻ removed other · merged in !15"]);
      expect(yield* asked()).toContain("branch -d other");
    }),
  ));

test("a remote named other than origin settles a branch it no longer has", () =>
  runOnPath(
    Effect.gen(function* () {
      yield* collieWorktree("wt");
      yield* settledGit({
        "rev-parse --abbrev-ref --symbolic-full-name @{u}": "",
        remote: "gitlab",
        "ls-remote --heads gitlab": "",
      });

      expect(yield* prune()).toEqual(["♻ removed wt · its remote branch is gone"]);
      expect(yield* asked()).toContain("ls-remote --heads gitlab wt");
    }),
  ));

test("a Renovate clone no Run uses and no checkout is left of goes; one a Run used stays", () =>
  runOnPath(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = `${rig.stateDir}/renovate-repositories`;
      const repository = "gitlab.example/group/kept";
      const used = `${root}/${Bun.hash(repository).toString(16)}`;
      const unused = `${root}/abc`;
      for (const clone of [used, unused]) yield* fs.makeDirectory(clone, { recursive: true });
      yield* fakeGitAnswering({ "worktree list --porcelain": "worktree $PWD\\n" });
      const runs = [
        runFacts({
          id: "r-renovate",
          settled: {
            inputs: { repository },
            strategies: { repository: "gitlab-repository" },
          },
        }),
      ];

      const report = yield* sweep(
        [renovateClonesSweeper(rig.stateDir, runs)],
        rig.stateDir,
        "host",
      );
      expect(report.remove.map((item) => item.target)).toEqual([unused]);
      expect(report.keep).toEqual([
        { kind: "renovate-clone", target: used, reason: "a Run with a row cut a checkout from it" },
      ]);
      expect(yield* fs.exists(unused)).toBe(false);
    }),
  ));

const asRecord = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** The Run's agent idle in pane 1-5, launched and served where its work runs; `state` is what a stop reaches. */
const servedLeftover = (worktreePath: string, state: Stopped["state"]) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* rig.addPane("1-5", "1:5", worktreePath, "codex");
    yield* rig.addAgent("impl-1-5", "1-5", "t-1-5");
    const agents = `${rig.stateDir}/agents/run-wt`;
    yield* fs.makeDirectory(agents, { recursive: true });
    yield* fs.writeFileString(
      `${agents}/implement.launch.json`,
      asRecord({
        agent: "impl-1-5",
        output: `${agents}/implement.json`,
        reused: false,
        runId: "run-wt",
        operation: "implement",
        role: "implementer",
        workflow: "implement",
        harness: "served",
        terminalId: "t-1-5",
      }),
    );
    const control = `${rig.stateDir}/compaction/impl-1-5`;
    yield* fs.makeDirectory(control, { recursive: true });
    yield* fs.writeFileString(
      `${control}/control.json`,
      asRecord({
        agent: "impl-1-5",
        harness: "served",
        cwd: worktreePath,
        dir: control,
        endpoint: "ws://127.0.0.1:1",
        pid: process.pid,
        command: "bun",
        started: null,
        attempt: null,
      }),
    );
    /** Each stop, with whether the agent's tab had closed by then. */
    const stops: Array<{ agent: string; tabClosed: boolean }> = [];
    const ports: CompactionPorts = {
      served: {
        gate: () => Effect.void,
        install: () => Effect.succeed({ args: [] }),
        request: () => Effect.die("unused"),
        poll: () => Effect.die("unused"),
        usage: () => Effect.die("unused"),
        stop: (target) =>
          Effect.gen(function* () {
            const cmds = yield* rig
              .cmds()
              .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
            stops.push({ agent: target.agent, tabClosed: cmds.includes("tab close") });
            return {
              state,
              turns: [{ thread: "th-1", turn: "tu-1", transcript: null }],
              reason: state === "quiet" ? null : "turn tu-1 still running after 30s",
              signalled: [],
              left: [],
              noted: [],
            } satisfies Stopped;
          }),
      },
    };
    return { stops, ports };
  });

const pruneWith = (ports: CompactionPorts) =>
  pruneWorktrees({
    herdr: new Herdr(rig.pluginEnv()),
    stateDir: rig.stateDir,
    runs: recorded,
    registered,
    cwd: rig.projectDir,
    settling,
    ports,
  });

test("the worktree sweep stops a finished Run's Quiet agent before it closes the agent's tab", () =>
  runOnPath(
    Effect.gen(function* () {
      const worktreePath = yield* collieWorktree("wt", { panes: ["1-5"] });
      const { stops, ports } = yield* servedLeftover(worktreePath, "quiet");
      yield* settledGit();
      yield* mergedMr();

      expect(yield* pruneWith(ports)).toEqual(["♻ removed wt · merged in !14"]);
      expect(stops).toEqual([{ agent: "impl-1-5", tabClosed: false }]);
      const closed = (yield* rig.calls()).filter((call) => call.cmd === "tab close");
      expect(closed.map((call) => call.argv?.at(2))).toEqual(["1:5"]);
      const log = yield* (yield* FileSystem.FileSystem).readFileString(
        `${rig.stateDir}/agents/run-wt/agents.log`,
      );
      expect(log).toContain(`impl-1-5 ended: its checkout ${worktreePath} was removed`);
    }),
  ));

test("the worktree sweep keeps the tab of an agent started again under a finished Run's agent's name", () =>
  runOnPath(
    Effect.gen(function* () {
      const worktreePath = yield* collieWorktree("wt", { panes: ["1-5"] });
      const { ports } = yield* servedLeftover(worktreePath, "quiet");
      yield* rig.reincarnate("impl-1-5");
      yield* settledGit();
      yield* mergedMr();

      expect(yield* pruneWith(ports)).toEqual([
        "♻ removed wt · merged in !14 · 1 tab(s) left open",
      ]);
      expect(yield* rig.cmds()).not.toContain("tab close");
    }),
  ));

test("the worktree sweep keeps the tab of a finished Run's agent's pane another named agent has taken", () =>
  runOnPath(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const worktreePath = yield* collieWorktree("wt", { panes: ["1-5"] });
      yield* rig.addPane("1-5", "1:5", worktreePath, "claude");
      yield* rig.addAgent("other-1", "1-5", "t-other");
      const agents = `${rig.stateDir}/agents/run-wt`;
      yield* fs.makeDirectory(agents, { recursive: true });
      yield* fs.writeFileString(
        `${agents}/implement.launch.json`,
        asRecord({
          agent: "impl-1-5",
          output: `${agents}/implement.json`,
          reused: false,
          runId: "run-wt",
          operation: "implement",
          role: "implementer",
          workflow: "implement",
          harness: "claude",
          terminalId: "t-1-5",
        }),
      );
      yield* settledGit();
      yield* mergedMr();

      expect(yield* pruneWith({})).toEqual(["♻ removed wt · merged in !14 · 1 tab(s) left open"]);
      expect(yield* rig.cmds()).not.toContain("tab close");
    }),
  ));

test("the worktree sweep keeps the tab of a finished Run's agent that is not Quiet", () =>
  runOnPath(
    Effect.gen(function* () {
      const worktreePath = yield* collieWorktree("wt", { panes: ["1-5"] });
      const { stops, ports } = yield* servedLeftover(worktreePath, "acknowledged");
      yield* settledGit();
      yield* mergedMr();

      expect(yield* pruneWith(ports)).toEqual([
        "♻ removed wt · merged in !14 · 1 tab(s) left open",
      ]);
      expect(stops.map((one) => one.agent)).toEqual(["impl-1-5"]);
      expect(yield* rig.cmds()).not.toContain("tab close");
    }),
  ));
