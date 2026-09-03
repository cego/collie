// The checkout a mutating Run owns. Git allows exactly one worktree per checked-out
// branch, so the branch is the key: two Runs building the same branch share one
// checkout, two Runs building different branches cannot collide, and nothing has to
// invent an identity for a directory.
//
// By default Collie makes the checkout with git and the Run stays in the workspace it
// was activated from, because a Run belongs where it was started and herdr groups a
// workspace by Git provenance alone (ADR-0006). `--input workspace=new` asks herdr for
// the checkout instead, which gives the Run a workspace of its own. A record says which
// it was, because that is who takes the checkout away again.

import { Clock, Effect, FileSystem, Option, Path, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import {
  herdrFailureReason,
  type Herdr,
  type PaneInfo,
  type WorktreeInfo,
  type WorktreeListing,
} from "./herdr";
import { defaultBase } from "./inputs";
import { disambiguate, GLYPH, tabLabel } from "./naming";
import { parseMrTarget, projectHere, repoArgs, shell, type Runner } from "./mr";
import { withLock } from "./lock";
import { resumable, RunStore, type WorktreeRecord } from "./run";
import { slugify } from "./template";

/**
 * The workflows that change the repository, and so need a checkout of their own.
 * `plan` and `architecture` get one where they chain into `implement` — the chained
 * Run resolves it — and `review` reads a diff or the caller's own tree.
 */
const MUTATING = new Set(["implement"]);

export function mutates(workflow: string): boolean {
  return MUTATING.has(workflow);
}

const MrViewJson = Schema.fromJsonString(
  Schema.Struct({ source_branch: Schema.optionalKey(Schema.String) }),
);

/** What deciding a Run's branch needs to know. */
export interface BranchAsk {
  cwd: string;
  /** What this Run is called, which is what a new branch is named after. */
  name: string;
  inputs: Record<string, string>;
  explicit?: string | null | undefined;
  run?: Runner<ChildProcessSpawner.ChildProcessSpawner>;
}

export interface BranchPlan {
  branch: string;
  /** What a branch that does not exist yet is based on. */
  base: string;
  /** Why this Run cannot be given a branch, and null when it can. */
  refused: string | null;
}

/**
 * Which branch this Run builds. A Run given work in words, a plan or a Linear issue
 * gets a new branch named after itself; a Run fixing a review works on the branch the
 * reviewed target already lives on, because that is where the change is. An explicit
 * `--input branch=<name>` wins over both.
 *
 * A review whose branch cannot be established is refused rather than given a new one:
 * a fix round exists to update what was reviewed, and putting those commits on a fresh
 * branch named after the run would leave the merge request untouched and the fixes
 * somewhere nobody is looking.
 */
export const branchFor = Effect.fn("worktree.branchFor")(function* (opts: BranchAsk) {
  const run = opts.run ?? shell;
  const asked = yield* branchName(opts, run);
  if (asked.refused !== undefined) {
    return { branch: "", base: "", refused: asked.refused } satisfies BranchPlan;
  }
  const branch = asked.branch;
  const base = yield* baseFor(branch, opts.cwd, run, { reviewed: asked.reviewed === true });
  if (base.refused !== undefined) {
    return { branch: "", base: "", refused: base.refused } satisfies BranchPlan;
  }
  return { branch, base: base.base, refused: null } satisfies BranchPlan;
});

const branchName = Effect.fn("worktree.branchName")(function* (
  opts: BranchAsk,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
) {
  const explicit = opts.explicit?.trim();
  if (explicit) return { branch: explicit, reviewed: false };
  // `reviewed` is what makes the difference below: a branch that already holds the work
  // has to be cut from that work, and a name for work that does not exist yet cannot be.
  if (opts.inputs.plan_kind === "review") return yield* reviewedBranch(opts.cwd, opts.inputs, run);
  return { branch: slugify(opts.name), reviewed: false };
});

/**
 * What a checkout of this branch is cut from. The branch's own tip on the remote where
 * it has one: a fix round continues the work that was reviewed, and cutting it from the
 * default branch instead would build something unrelated and then be unable to push it.
 * A reviewed branch this checkout has never fetched is fetched once for that reason —
 * and if it still is not there, the Run is refused rather than started on the wrong
 * history.
 *
 * Otherwise the repository's default branch, which is where new work starts — as
 * `origin/master` rather than `master`, because a fresh worktree takes what the remote
 * has, not whatever this checkout's local branch is sitting on. Where there is no
 * remote-tracking ref there is no remote, and the local branch is all there is.
 */
const baseFor = Effect.fn("worktree.baseFor")(function* (
  branch: string,
  cwd: string,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
  opts: { reviewed: boolean },
) {
  const exists = (ref: string) => run("git", ["rev-parse", "--verify", ref], cwd);
  if ((yield* exists(`origin/${branch}`)).code === 0) return { base: `origin/${branch}` };
  if (opts.reviewed) {
    // The branch holds the work that was reviewed, so it is on the remote whether or
    // not this checkout has heard of it yet.
    yield* run("git", ["fetch", "origin", branch], cwd);
    if ((yield* exists(`origin/${branch}`)).code === 0) return { base: `origin/${branch}` };
    return { refused: `${branch} is not on the remote, so there is no reviewed work to fix` };
  }
  const head = (yield* defaultBase(run, cwd)) ?? "master";
  const tracked = (yield* exists(`origin/${head}`)).code === 0;
  return { base: tracked ? `origin/${head}` : head };
});

/**
 * The branch the reviewed target lives on. Anything this cannot establish is a
 * refusal, not a guess: `glab` that would not answer, a merge request with no source
 * branch, a diff of two shas, a detached HEAD.
 */
const reviewedBranch = Effect.fn("worktree.reviewedBranch")(function* (
  cwd: string,
  inputs: Record<string, string>,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
) {
  const target = inputs.target ?? "";
  const mr = parseMrTarget(target);
  if (mr) {
    // A merge request in another project cannot be fixed from this checkout at all:
    // `herdr worktree` only ever makes a checkout of the repository it is asked in, so
    // the alternative to refusing is a worktree of the wrong repository. A checkout
    // whose own project cannot be read is refused for the same reason: nothing here
    // says it is the project the merge request is in, and a bare `mr:42` came from
    // this directory's remote in the first place.
    if (mr.project) {
      const here = yield* projectHere(cwd, run);
      if (here === null) {
        return { refused: `${cwd} has no GitLab remote, so !${mr.iid} may not be its own` };
      }
      if (mr.project !== here) {
        return { refused: `!${mr.iid} is in ${mr.project}, and this is a checkout of ${here}` };
      }
    }
    const view = yield* run(
      "glab",
      ["mr", "view", mr.iid, ...repoArgs(mr.project), "--output", "json"],
      cwd,
    );
    if (view.code !== 0) return { refused: `glab could not read !${mr.iid}` };
    const seen = Schema.decodeUnknownOption(MrViewJson)(view.stdout).pipe(Option.getOrUndefined);
    const source = seen?.source_branch?.trim();
    return source
      ? { branch: source, reviewed: true }
      : { refused: `!${mr.iid} names no source branch` };
  }
  if (target.startsWith("branch:")) {
    const head = target.slice("branch:".length).split("...").at(-1)?.trim() ?? "";
    if (head === "") return { refused: `${target} names no branch to work on` };
    // A diff target's head is a ref, not necessarily a branch: `branch:main...HEAD` and
    // `branch:<sha>...<sha>` are both things a human may review. Neither is a branch to
    // commit fixes to, and `HEAD` is not even a legal branch name.
    return (yield* isBranch(head, cwd, run))
      ? { branch: head, reviewed: true }
      : { refused: `${head} is not a branch, so there is nothing to fix on it` };
  }
  // `worktree`, or a target this build does not know: the caller's own branch is what
  // the reviewed work is sitting on.
  const at = yield* run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const branch = at.stdout.trim();
  if (at.code !== 0 || branch === "" || branch === "HEAD") {
    return { refused: `${cwd} is not on a branch to fix` };
  }
  // The caller's own branch: it is checked out here, so it needs no fetching and may
  // legitimately have nothing on the remote yet.
  return { branch, reviewed: false };
});

/** Whether this ref is a branch — here or on the remote — rather than a sha or HEAD. */
const isBranch = Effect.fn("worktree.isBranch")(function* (
  ref: string,
  cwd: string,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
) {
  for (const full of [`refs/heads/${ref}`, `refs/remotes/origin/${ref}`]) {
    if ((yield* run("git", ["rev-parse", "--verify", "--quiet", full], cwd)).code === 0)
      return true;
  }
  return false;
});

/** `--input workspace=new`: today's separate herdr worktree workspace, asked for. */
const SEPARATE_WORKSPACE = "new";

/**
 * A branch as a path under the worktrees directory. Its own segments, so `feature/foo`
 * nests rather than being flattened: flattening it to `feature-foo` would collide with
 * the branch actually called `feature-foo`, and two branches that share a destination
 * are two Runs one checkout apart from sharing an index. Nothing is truncated for the
 * same reason. Git's own ref rules — no `..`, no leading `.`, no control characters —
 * are what keep every segment a legal directory name.
 */
const branchPath = (branch: string) => branch.split("/");

/**
 * Every checkout git itself knows about, and which of them the repository is. git's own
 * list rather than herdr's: it answers both questions at once, needs no herdr to be
 * running, and lists a checkout however it was made.
 */
const gitWorktrees = Effect.fn("worktree.gitWorktrees")(function* (
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
  cwd: string,
) {
  const listed = yield* run("git", ["worktree", "list", "--porcelain"], cwd);
  if (listed.code !== 0) return null;
  const checkouts: Array<{ path: string; branch: string | null }> = [];
  for (const block of listed.stdout.split(/\n\s*\n/)) {
    const at = /^worktree (.+)$/m.exec(block)?.[1]?.trim();
    if (at === undefined) continue;
    // A detached checkout has no `branch` line at all, which is what null means here.
    const ref = /^branch (.+)$/m.exec(block)?.[1]?.trim();
    checkouts.push({ path: at, branch: ref?.replace(/^refs\/heads\//, "") ?? null });
  }
  // git lists the main worktree first, and that is the one place a command about the
  // repository can be run and still be there once another checkout has been removed.
  const repo = checkouts[0]?.path;
  return repo === undefined ? null : { repo, checkouts };
});

/**
 * The checkout for a branch, made with git. The one the branch already has where it has
 * one — git allows no second worktree on a checked-out branch, and a fix round has to
 * land where the reviewed work already is — and otherwise a new one at the path herdr
 * would have chosen.
 */
const gitCheckout = Effect.fn("worktree.gitCheckout")(function* (opts: {
  cwd: string;
  branch: string;
  base?: string | undefined;
  /** Where a new checkout goes, which is where herdr would have put it. */
  worktrees: string;
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>;
}) {
  const path = yield* Path.Path;
  const { run, branch } = opts;
  const listing = yield* gitWorktrees(run, opts.cwd);
  if (!listing) return { refused: `${opts.cwd} is not a git checkout` };
  const existing = listing.checkouts.find((checkout) => checkout.branch === branch);
  if (existing) return { path: existing.path, created: false };

  const at = path.join(opts.worktrees, path.basename(listing.repo), ...branchPath(branch));
  // `-b` only for a branch that does not exist yet: git refuses to create one twice,
  // and a branch this checkout already has is what a fix round works on.
  const known =
    (yield* run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], listing.repo))
      .code === 0;
  const args = known
    ? ["worktree", "add", at, branch]
    : ["worktree", "add", at, "-b", branch, ...(opts.base ? [opts.base] : [])];
  const added = yield* run("git", args, listing.repo);
  if (added.code !== 0) {
    return { refused: added.stdout.trim() || `git would not add a worktree at ${at}` };
  }
  return { path: at, created: true };
});

/**
 * The checkout for a branch: the one it already has, or a new one. `herdr worktree
 * open` is what gives an existing checkout its workspace back, so a Run handed to a
 * live implementer and a Run started fresh on the same branch both land in one place.
 */
export const worktreeFor = Effect.fn("worktree.worktreeFor")(function* (
  herdr: Herdr,
  opts: { cwd: string; branch: string; base?: string; label?: string },
) {
  const listing = yield* herdr.worktreeList(opts.cwd);
  const existing = listing.worktrees.find((worktree) => worktree.branch === opts.branch);
  // Every open and create is asked from the repository's own checkout, which is what
  // `worktree list` answers with. herdr refuses both from a linked worktree —
  // `linked_worktree_source`, "New and open worktree actions start from the repo
  // parent workspace" — and a Run chained from one is exactly the case that matters:
  // a fix round starts in the checkout the reviewed branch already has.
  const repo = listing.source ?? opts.cwd;
  // No label on `open`: it renames the workspace it opens, which would overwrite the
  // name a human gave theirs and leave every Run that recorded the old one homeless.
  const opened = existing
    ? yield* herdr.worktreeOpen({ cwd: repo, path: existing.path })
    : yield* herdr.worktreeCreate({
        cwd: repo,
        branch: opts.branch,
        base: opts.base,
        label: opts.label,
      });
  return {
    workspaceLabel: opened.label,
    worktree: {
      path: opened.path,
      branch: opts.branch,
      managed_by: "herdr",
      workspace_id: opened.workspaceId,
      created_by_collie: !existing,
      made_at: yield* madeAt(opened.path),
    } satisfies WorktreeRecord,
  };
});

/**
 * When git wrote this checkout's `.git` file — the one thing that tells the checkout
 * Collie made from another one later made at the same path on the same branch. git
 * writes it once, at `worktree add`, and does not touch it again. Null where it cannot
 * be read, which is a checkout pruning will then leave alone.
 */
const madeAt = Effect.fn("worktree.madeAt")(function* (worktreePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stat = yield* Effect.result(fs.stat(path.join(worktreePath, ".git")));
  if (stat._tag === "Failure") return null;
  const mtime = stat.success.mtime;
  return Option.isSome(mtime) ? mtime.value.getTime() : null;
});

/** Where a Run works, and what it records and logs about how it got there. */
export interface Checkout {
  /** Its own checkout, or the directory it was started from. */
  cwd: string;
  workspaceId: string | null;
  /** The label of the workspace it is in, which is how a board recognises the Run. */
  workspaceLabel: string | null;
  /** What the Run records, and null for a Run with no checkout of its own. */
  worktree: WorktreeRecord | null;
  /** One line for the Run's log, empty where there was nothing to say. */
  note: string;
  /** Why this Run must not start, and null when it may. */
  refused: string | null;
}

/**
 * Where this Run works. A Workflow that changes the repository owns its branch's
 * checkout; every other Workflow works in the directory it was started from.
 *
 * The Run stays in the workspace it was activated from, and only its cwd moves: the
 * work surrounding a task is encapsulated in its workspace, and a checkout of its own
 * is about not sharing an index, not about being somewhere else in the sidebar.
 * `workspace=new` asks herdr for the checkout instead and takes the workspace herdr
 * opens on it.
 *
 * A mutating Workflow that cannot be given a worktree does not start. Falling back to
 * the directory it was launched from is what this whole mechanism exists to prevent:
 * two Runs in one checkout share an index and a stash stack, and that swapped one
 * Run's uncommitted work for another's. A Run that will not start says why; a Run that
 * quietly shares a checkout corrupts a Run nobody was watching.
 */
export const checkoutFor = Effect.fn("worktree.checkoutFor")(function* (
  herdr: Herdr,
  opts: {
    /** Where the Run was started, which is the repository the worktree is cut from. */
    cwd: string;
    workflow: string;
    name: string;
    inputs: Record<string, string>;
    /** The workspace the Run was activated from, and stays in. */
    workspaceId?: string | null;
    workspaceLabel?: string | null;
    explicit?: string | null | undefined;
  },
) {
  const here = {
    cwd: opts.cwd,
    workspaceId: opts.workspaceId ?? null,
    workspaceLabel: opts.workspaceLabel ?? null,
    worktree: null,
    note: "",
    refused: null,
  } satisfies Checkout;
  if (!mutates(opts.workflow)) return here;

  const plan = yield* branchFor(opts);
  if (plan.refused) return { ...here, refused: plan.refused } satisfies Checkout;

  // Whichever manager was asked, a Run with nowhere of its own to work says so the
  // same way, naming the branch it could not be given a checkout for.
  const refuse = (why: string) =>
    ({ ...here, refused: `no worktree for ${plan.branch}: ${why}` }) satisfies Checkout;

  // The Workflow's own `workspace` Input, so both front doors and a chained Run reach
  // it the same way: `startRun` settles it from `--input`, and the Choice that chains
  // `implement` forwards the parent's answer.
  if (opts.inputs.workspace?.trim() === SEPARATE_WORKSPACE) {
    const label = tabLabel(GLYPH.running, disambiguate(opts.workflow, plan.branch));
    const found = yield* Effect.result(
      worktreeFor(herdr, { cwd: opts.cwd, branch: plan.branch, base: plan.base, label }),
    );
    if (found._tag === "Failure") return refuse(herdrFailureReason(found.failure));
    const { worktree, workspaceLabel } = found.success;
    return {
      ...here,
      cwd: worktree.path,
      // The workspace herdr just opened on the checkout, which is the whole point of
      // asking it: this is the one path where the Run does not stay where it started.
      workspaceId: worktree.workspace_id,
      workspaceLabel: workspaceLabel ?? opts.workspaceLabel ?? null,
      worktree,
      note: `${worktree.created_by_collie ? "created" : "opened"} worktree ${worktree.path} on ${plan.branch}`,
    } satisfies Checkout;
  }

  const made = yield* gitCheckout({
    cwd: opts.cwd,
    branch: plan.branch,
    base: plan.base,
    worktrees: yield* herdr.worktreesDirectory(),
    // `say`, so git's own reason for refusing a worktree is what the Run is told.
    run: (cmd, args, cwd) => shell(cmd, args, cwd, "say"),
  });
  if (made.refused !== undefined) return refuse(made.refused);
  const worktree = {
    path: made.path,
    branch: plan.branch,
    managed_by: "git",
    workspace_id: null,
    created_by_collie: made.created,
    made_at: yield* madeAt(made.path),
  } satisfies WorktreeRecord;
  return {
    ...here,
    cwd: worktree.path,
    worktree,
    note: `${made.created ? "created" : "reused"} worktree ${worktree.path} on ${plan.branch}`,
  } satisfies Checkout;
});

// ---------------------------------------------------------------------------
// Pruning
//
// A Collie-created worktree is removed only when it is *settled*: it holds
// nothing that exists nowhere else. Every check is a reason to keep it, and the
// first one that fails is what the board says. Removal never passes a force
// flag — git's own refusal to drop a dirty or unmerged checkout is the last
// guard, so a wrong judgement here can only fail to clean, never delete work.

/** How long a worktree's verdict stands before it is worked out again. */
const RECHECK_MS = 3 * 60_000;
/** How long a removal stays on the board after it happened. */
const REPORT_MS = 60 * 60_000;
const PRUNE_FILE = "worktrees.json";

const PruneEntry = Schema.Struct({
  checked_at: Schema.Number,
  line: Schema.String,
  removed: Schema.Boolean,
  // Which repository this verdict is about. The file is one per installation, and a
  // sweep only ever knows about the repository it was asked in, so without this one
  // board would forget another's verdicts and report another's removals as its own.
  repo: Schema.String,
});
// Mutable, because pruning edits its own record of what it last decided.
const PruneStateJson = Schema.fromJsonString(
  Schema.Record(Schema.String, PruneEntry.pipe(Schema.mutableKey)),
);
type PruneState = Schema.Schema.Type<typeof PruneStateJson>;

const MrStateJson = Schema.fromJsonString(
  Schema.Struct({
    state: Schema.optionalKey(Schema.String),
    iid: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
  }),
);

/**
 * What is in use, and why. A directory holds a checkout it is inside — an agent
 * working in `<worktree>/src` is working in that worktree — and a workspace holds
 * the checkout herdr opened it on, which is the only evidence there is about a pane
 * herdr reports without a directory of its own.
 */
interface InUse {
  paths: ReadonlyMap<string, string>;
  workspaces: ReadonlyMap<string, string>;
  /** Every pane herdr has, so a removal can tell which tabs went with the checkout. */
  panes: ReadonlyArray<PaneInfo>;
}

/**
 * Everything holding a checkout right now: the Runs and agents herdr knows about, the
 * checkout a Run is starting in, and nothing else — the Control Plane names none, so
 * removing the worktree its own board is showing is exactly what a merged branch does,
 * and herdr closes that workspace with it. Null where herdr would not say.
 */
const inUse = Effect.fn("worktree.inUse")(function* (
  herdr: Herdr,
  opts: { paths: ReadonlyMap<string, string>; keep?: string | undefined },
) {
  const panes = yield* Effect.result(herdr.paneList());
  if (panes._tag === "Failure") return null;
  const paths = new Map(opts.paths);
  const workspaces = new Map<string, string>();
  for (const pane of panes.success) {
    if (!pane.agent) continue;
    // Both directories: an agent started in the repository and `cd`-ed into a checkout
    // is working in the checkout, whatever the pane was opened on.
    for (const dir of [pane.cwd, pane.foregroundCwd]) {
      if (dir) paths.set(dir, "an agent is working in it");
    }
    // A pane herdr reports without a directory still says which workspace it is in,
    // and a worktree's workspace is its own.
    if (pane.workspaceId) workspaces.set(pane.workspaceId, "an agent is working in it");
  }
  if (opts.keep && !paths.has(opts.keep)) paths.set(opts.keep, "a run is starting in it");
  return { paths, workspaces, panes: panes.success } satisfies InUse;
});

/** Whether this directory is the checkout at `at`, or somewhere inside it. */
const inside = (at: string, dir: string | null | undefined) =>
  dir !== null && dir !== undefined && (dir === at || dir.startsWith(`${at}/`));

/**
 * Closes the tabs a removed checkout leaves behind: shells still sitting in a
 * directory that is gone, which nothing else would ever close. Only the tabs the
 * finished Runs of that checkout recorded, and only while every pane in one is inside
 * it — a tab a human has since split or reused is theirs, not the Run's leftovers.
 *
 * Answers with how many would not close. This is the only chance: the checkout is
 * already gone from herdr's listing, so it is no longer a candidate and no later sweep
 * will come back to retry. A herdr that hiccuped here has to be reported now or the
 * dead tab is never mentioned at all.
 */
const closeDeadTabs = Effect.fn("worktree.closeDeadTabs")(function* (
  herdr: Herdr,
  opts: { at: string; tabs: ReadonlySet<string>; panes: ReadonlyArray<PaneInfo> },
) {
  // Where a pane was started and where it has moved to: a shell the agent `cd`-ed is
  // in the checkout whatever its tab was opened on.
  const isInside = (pane: PaneInfo) =>
    inside(opts.at, pane.cwd) || inside(opts.at, pane.foregroundCwd);
  let left = 0;
  for (const tabId of opts.tabs) {
    const panes = opts.panes.filter((pane) => pane.tabId === tabId);
    // A tab herdr no longer has is nothing to close; one with a pane outside the
    // checkout is a tab somebody has taken over.
    const isDead = panes.length > 0 && panes.every(isInside);
    if (!isDead) continue;
    const closed = yield* Effect.result(herdr.tabClose(tabId));
    if (closed._tag === "Failure") left += 1;
  }
  return left;
});

/** Why this checkout is in use, or null when nothing holds it. */
function heldBy(use: InUse, worktree: { path: string; workspaceId: string | null }): string | null {
  for (const [dir, why] of use.paths) {
    if (inside(worktree.path, dir)) return why;
  }
  return (worktree.workspaceId && use.workspaces.get(worktree.workspaceId)) || null;
}

/** What to do about a checkout: keep it for this reason, or remove it for that one. */
type Verdict = { keep: string; why?: undefined } | { keep?: undefined; why: string };

const keepIt = (keep: string): Verdict => ({ keep });
const settledBecause = (why: string): Verdict => ({ why });

const settled = Effect.fn("worktree.settled")(function* (
  worktree: WorktreeInfo & { branch: string },
  opts: {
    /** The repository's own checkout, which outlives the removal of any other. */
    repo: string;
    use: InUse;
    run: Runner<ChildProcessSpawner.ChildProcessSpawner>;
  },
) {
  const { run, repo } = opts;
  const dirty = yield* run("git", ["status", "--porcelain"], worktree.path);
  if (dirty.code !== 0) return keepIt("could not read the working tree");
  if (dirty.stdout.trim() !== "") return keepIt("uncommitted changes");

  const unpushed = yield* unpushedWork(worktree, run);
  if (unpushed) return unpushed;

  const held = heldBy(opts.use, worktree);
  if (held) return keepIt(held);

  // Its merge request settles it where there is one: merged or closed means the work
  // has landed somewhere that is not this checkout.
  const view = yield* run("glab", ["mr", "view", worktree.branch, "--output", "json"], repo);
  const mr =
    view.code === 0
      ? Schema.decodeUnknownOption(MrStateJson)(view.stdout).pipe(Option.getOrUndefined)
      : undefined;
  const state = mr?.state?.toLowerCase();
  if (state === "merged" || state === "closed")
    return settledBecause(`${state} in !${mr?.iid ?? "?"}`);
  if (state !== undefined && mr?.iid !== undefined) return keepIt(`!${mr.iid} is still open`);

  // No merge request to go by, so the remote branch is the question: gone means
  // whatever this branch held is either merged or abandoned on purpose.
  const remote = yield* run("git", ["ls-remote", "--heads", "origin", worktree.branch], repo);
  if (remote.code !== 0) return keepIt("could not reach the remote");
  if (remote.stdout.trim() !== "") return keepIt("still on the remote");
  return settledBecause("its remote branch is gone");
});

/** How many lines a `rev-list` answered with; each one is a commit. */
function commits(result: { stdout: string }): number {
  return result.stdout.split("\n").filter((line) => line.trim() !== "").length;
}

/**
 * Why this checkout may not go for the commits it holds, or null when it holds none
 * of its own. Its upstream is the question where it has one. Where it does not, that is
 * either a branch never pushed or one whose remote-tracking ref went with a
 * `git fetch --prune` after the branch was merged and deleted — the spec's own settled
 * case — so what matters instead is whether anything here is missing from the default
 * branch.
 */
const unpushedWork = Effect.fn("worktree.unpushedWork")(function* (
  worktree: { path: string },
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
) {
  const upstream = yield* run(
    "git",
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    worktree.path,
  );
  if (upstream.code === 0 && upstream.stdout.trim() !== "") {
    const ahead = yield* run("git", ["rev-list", "@{u}..HEAD"], worktree.path);
    if (ahead.code !== 0) return keepIt("could not read what is unpushed");
    const count = commits(ahead);
    return count > 0 ? keepIt(`${count} commit(s) unpushed`) : null;
  }
  const head = (yield* defaultBase(run, worktree.path)) ?? "master";
  const unique = yield* run("git", ["rev-list", `origin/${head}..HEAD`], worktree.path);
  if (unique.code !== 0) return keepIt("no upstream to compare against");
  const count = commits(unique);
  return count > 0 ? keepIt(`${count} commit(s) on no branch but this one`) : null;
});

/**
 * What the run records say about the worktrees of this machine: the ones Collie made,
 * by path, and the ones a Run is still driving. A checkout a human made appears in no
 * record, so it is never a candidate for removal.
 */
const fromRuns = Effect.fn("worktree.fromRuns")(function* (stateDir: string) {
  const mine = new Map<string, WorktreeRecord>();
  const paths = new Map<string, string>();
  /** The tabs each checkout's finished Runs opened, which are the ones left in it. */
  const tabs = new Map<string, Set<string>>();
  for (const run of yield* new RunStore(stateDir).list()) {
    // Anything a `resume` could pick up again, by the same rule `run resume` lists
    // them: a Run left `blocked` at a Choice, or by an agent that stopped, restarts in
    // the directory it recorded. And whatever its Driver is doing, since a crashed or
    // restarting Driver is not evidence that the Run is over.
    const resumeCould = resumable(run);
    if (resumeCould) paths.set(run.record.cwd, "a run could still be resumed in it");

    const worktree = run.record.worktree;
    if (!worktree?.created_by_collie) continue;
    mine.set(worktree.path, worktree);
    // A Run that could still be resumed keeps its checkout anyway, so its tabs are
    // nobody's leftovers yet.
    if (resumeCould) continue;
    const opened = tabs.get(worktree.path) ?? new Set<string>();
    for (const step of run.record.steps) {
      for (const variant of step.variants) {
        if (variant.tabId) opened.add(variant.tabId);
      }
    }
    tabs.set(worktree.path, opened);
  }
  return { mine, paths, tabs };
});

/**
 * Removes the worktrees this repository has that are settled, and reports what it did
 * and what it is holding — one line each, so nothing is silent. Runs where Collie
 * already wakes up: at every `run start` and every Control Plane refresh, with each
 * worktree's verdict standing for a few minutes so a 1.5-second refresh does not
 * shell out to git and glab over and over.
 */
const prune = Effect.fn("worktree.prune")(function* (opts: {
  herdr: Herdr;
  stateDir: string;
  cwd: string;
  /** A checkout the caller is about to work in, which is therefore in use. */
  keep?: string;
  now?: number;
  run?: Runner<ChildProcessSpawner.ChildProcessSpawner>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // `say`: git writes why it will not drop a checkout, or delete a branch, to stderr,
  // and the whole point of the board's line is to pass that on. Every check here reads
  // the exit code first, so folding stderr into the output changes no decision.
  const run = opts.run ?? ((cmd, args, cwd) => shell(cmd, args, cwd, "say"));
  const now = opts.now ?? (yield* Clock.currentTimeMillis);
  const statePath = path.join(opts.stateDir, PRUNE_FILE);
  // What a board line calls a checkout: the branch it is for. Not the last part of its
  // path — a branch with a `/` in it nests, so `feature/foo` would read as "foo".
  const nameOf = (worktree: { branch: string }) => worktree.branch;
  const state = yield* fs.readFileString(statePath).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(PruneStateJson)),
    Effect.catch(() => Effect.succeed<PruneState>({})),
  );
  const before = `${Schema.encodeSync(PruneStateJson)(state)}\n`;

  const { mine, paths, tabs } = yield* fromRuns(opts.stateDir);
  const listing =
    mine.size === 0
      ? null
      : yield* opts.herdr
          .worktreeList(opts.cwd)
          .pipe(Effect.catch(() => Effect.succeed<WorktreeListing | null>(null)));
  // Path, branch and the moment git wrote the checkout, all from the record that made
  // it: a Collie worktree removed by hand and a human's worktree later made at the
  // same path on the same branch would otherwise be the same candidate, and a
  // hand-made checkout is never touched. A candidate therefore always has a branch,
  // which is what everything below it is allowed to assume.
  const candidates: Array<WorktreeInfo & { branch: string }> = [];
  for (const worktree of listing?.worktrees ?? []) {
    const branch = worktree.branch;
    const record = branch === null ? undefined : mine.get(worktree.path);
    if (branch === null || !record || record.branch !== branch || record.made_at === null) continue;
    if ((yield* madeAt(worktree.path)) !== record.made_at) continue;
    candidates.push({ ...worktree, branch });
  }

  // Every command about the repository runs in the repository's own checkout, never in
  // one that is a candidate: `git branch -d` after a removal used to run in a
  // directory that removal had just deleted.
  const repo = listing?.source ?? opts.cwd;
  // What every exit from here needs, so no exit has to remember the list. `state` is
  // edited in place below, and this holds the same one.
  const round = { state, statePath, before, now, repo };

  // A worktree of this repository that is no longer listed has nothing left to decide:
  // only a removal is still worth saying, and only while it is news. Another
  // repository's entries are none of this sweep's business.
  for (const [known, entry] of Object.entries(state)) {
    if (entry.repo !== repo) continue;
    if (candidates.some((worktree) => worktree.path === known)) continue;
    if (!entry.removed || now - entry.checked_at > REPORT_MS) delete state[known];
  }

  const due = candidates.filter((worktree) => {
    const entry = state[worktree.path];
    return !entry || entry.removed || now - entry.checked_at >= RECHECK_MS;
  });
  if (due.length === 0) return yield* conclude(round);

  // A herdr that will not answer is not proof that nothing is live in these checkouts,
  // and that is the one condition nothing else can establish — so nothing is judged
  // this round rather than judged on an empty list. The board still hears about every
  // candidate being held, and nothing is written down: an unverified round is not a
  // verdict, so the next refresh asks again rather than waiting out the debounce.
  const use = yield* inUse(opts.herdr, { paths, keep: opts.keep });
  if (!use) {
    const standing = yield* conclude(round);
    return [
      ...standing,
      ...due.map((worktree) => `kept ${nameOf(worktree)} · could not ask herdr what is live`),
    ];
  }

  for (const worktree of due) {
    const name = nameOf(worktree);
    const verdict = yield* settled(worktree, { repo, use, run });
    // Whoever made the checkout takes it away again. Then the branch itself, with
    // `-d`: git refuses an unmerged one, which is the guard.
    const outcome =
      verdict.keep === undefined
        ? yield* removeWorktree(opts.herdr, worktree, {
            name,
            why: verdict.why,
            repo,
            run,
            managedBy: mine.get(worktree.path)?.managed_by ?? "herdr",
            tabs: tabs.get(worktree.path) ?? new Set<string>(),
            panes: use.panes,
          })
        : { line: `kept ${name} · ${verdict.keep}`, removed: false };
    state[worktree.path] = { checked_at: now, repo, ...outcome };
  }

  return yield* conclude(round);
});

/**
 * How every round ends, whether it judged anything or not: what moved is written down,
 * and what the board should say is answered. Only when something actually moved —
 * this runs on a board refresh, and rewriting the same bytes on every one of those is
 * a disk write nobody asked for.
 */
const conclude = Effect.fn("worktree.conclude")(function* (opts: {
  state: PruneState;
  statePath: string;
  /** The bytes this round started from, so an unchanged round writes nothing. */
  before: string;
  now: number;
  /** Whose board this is: only this repository's lines belong on it. */
  repo: string;
}) {
  const encoded = `${Schema.encodeSync(PruneStateJson)(opts.state)}\n`;
  if (encoded !== opts.before) {
    yield* (yield* FileSystem.FileSystem).writeFileString(opts.statePath, encoded);
  }
  return reported(opts.state, opts.now, opts.repo);
});

/**
 * What is worth putting on this repository's board: everything it is holding, and a
 * removal while it is still news. Another repository's verdicts are on its own board.
 */
function reported(state: PruneState, now: number, repo: string): string[] {
  return Object.values(state)
    .filter(
      (entry) => entry.repo === repo && (!entry.removed || now - entry.checked_at <= REPORT_MS),
    )
    .map((entry) => entry.line);
}

/** One line about a removal, and whether the checkout actually went. */
interface Removal {
  line: string;
  removed: boolean;
}

/** Removes one checkout and its branch, and says what happened to each. */
const removeWorktree = Effect.fn("worktree.removeWorktree")(function* (
  herdr: Herdr,
  worktree: WorktreeInfo & { branch: string },
  opts: {
    name: string;
    /** Why it was settled, which is what the removal line says. */
    why: string;
    /** The repository's own checkout: this one is about to stop existing. */
    repo: string;
    run: Runner<ChildProcessSpawner.ChildProcessSpawner>;
    /** Who made this checkout, which is who is allowed to take it away. */
    managedBy: "git" | "herdr";
    /** The tabs its finished Runs opened, closed with the checkout they sit in. */
    tabs: ReadonlySet<string>;
    panes: ReadonlyArray<PaneInfo>;
  },
) {
  const kept = (why: string): Removal => ({ line: `kept ${opts.name} · ${why}`, removed: false });
  // herdr removes a worktree by the workspace it has open on it, so a checkout herdr
  // has open goes through herdr whoever made it: removing one behind its back would
  // leave it listing a checkout that is not there. Never forced either way, and never
  // `--force`: git's own refusal is the guard.
  // Truthiness, not `!== null`: herdr reports a checkout it has nothing open on as an
  // empty id as well as a missing one, and both mean the same thing here.
  const throughHerdr = Boolean(worktree.workspaceId) || opts.managedBy === "herdr";
  if (throughHerdr) {
    // A checkout herdr made but whose workspace a human has since closed is opened
    // again to be removed, because the workspace is how herdr names it.
    let workspaceId = worktree.workspaceId;
    if (!workspaceId) {
      const opened = yield* Effect.result(
        herdr.worktreeOpen({ cwd: opts.repo, path: worktree.path }),
      );
      if (opened._tag === "Failure") return kept(herdrFailureReason(opened.failure));
      workspaceId = opened.success.workspaceId;
    }
    const refused = yield* herdr.worktreeRemove(workspaceId).pipe(
      Effect.as(null),
      Effect.catch((cause) => Effect.succeed(herdrFailureReason(cause))),
    );
    if (refused !== null) return kept(refused);
  } else {
    const dropped = yield* opts.run("git", ["worktree", "remove", worktree.path], opts.repo);
    if (dropped.code !== 0) return kept(dropped.stdout.trim() || "git would not remove it");
  }

  // The Run's leftover shells, now that the directory they sit in has gone — whichever
  // manager removed it. herdr closes the workspace it had open on the checkout, but a
  // Run's tabs are in the workspace it was activated from, which that closing knows
  // nothing about. The pane list this reads was taken before the removal, which is why
  // it still says where each of them was.
  const openTabs = yield* closeDeadTabs(herdr, {
    at: worktree.path,
    tabs: opts.tabs,
    panes: opts.panes,
  });

  // The checkout has gone, so this is a removal whatever happens to the branch — a
  // branch git will not delete is what is left to look at, and an entry that says it
  // was kept would be forgotten on the next sweep, when the path is no longer listed.
  const deleted = yield* opts.run("git", ["branch", "-d", worktree.branch], opts.repo);
  const why =
    deleted.code === 0
      ? opts.why
      : `branch ${worktree.branch} kept: ${deleted.stdout.trim() || "git would not delete it"}`;
  // Said on the same line, for the same reason the kept branch is: this checkout will
  // not be a candidate again, so anything that did not go with it is reported here or
  // it is never reported.
  const tabs = openTabs === 0 ? "" : ` · ${openTabs} tab(s) left open`;
  return { line: `♻ removed ${opts.name} · ${why}${tabs}`, removed: true } satisfies Removal;
});

/**
 * Removes what is settled and answers with what it did — never with a failure. Both
 * moments Collie prunes at are doing something else at the time: a Run start and a
 * board refresh have no use for a state file that would not read, and neither would
 * stop for one.
 *
 * One pruner at a time, under the same pid lock the run records use. Two run starts
 * at once would otherwise read the same verdicts, decide separately and write over
 * each other, and could ask git to remove one checkout twice. A contended lock means
 * somebody else is already doing this, so there is nothing to say and nothing to wait
 * for.
 */
export const pruneWorktrees = (opts: Parameters<typeof prune>[0]) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const lock = path.join(opts.stateDir, `${PRUNE_FILE}.lock`);
    return yield* withLock(lock, Effect.succeed<string[]>([]), prune(opts));
  }).pipe(Effect.catch(() => Effect.succeed<string[]>([])));
