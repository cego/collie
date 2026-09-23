// The checkout a mutating Run owns. Git allows exactly one worktree per checked-out
// branch, so the branch is the key: two Runs building the same branch share one
// checkout, two Runs building different branches cannot collide, and nothing has to
// invent an identity for a directory.
//
// By default Collie makes the checkout with git and the Run stays in its Task's
// workspace, because a Run belongs where its Task is and herdr groups a workspace by Git
// provenance alone (ADR-0006). A Run that asks for a workspace of its own has herdr make
// the checkout instead. A record says which it was, because that is who takes the
// checkout away again.

import { Clock, Effect, FileSystem, Option, Path, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/unstable/process";
import {
  herdrFailureReason,
  type Herdr,
  type PaneInfo,
  type WorktreeInfo,
  type WorktreeListing,
} from "./herdr";
import type { CheckoutKind } from "./definitions";
import { diffTargetOf, gitlabRepositoryOf, workSourceOf } from "./strategies";
import { defaultBase } from "./inputs";
import { disambiguate, GLYPH, tabLabel } from "./naming";
import {
  branchTargetHead,
  glabLogin,
  hostOf,
  parseMrTarget,
  projectFromRemote,
  projectHere,
  repoArgs,
  shell,
  type Runner,
} from "./mr";
import { withLock } from "./lock";
import type { AgentEntry } from "./registry";
import type { WorktreeRecord } from "./run";
// Type-only: the host imports this module, and `runs.ts` reads through the host.
import type { RunFacts } from "./runs";
import { slugify } from "./template";

/**
 * Whether a Workflow changes the repository, and so needs a checkout of its own. It
 * is the Workflow's own `checkout:` and never its name: a fork is as much a Renovate
 * Run as what it extends, and keying this on names gave every fork the directory it
 * was launched from — which is the sharing this whole mechanism exists to prevent.
 *
 * `plan` and `architecture` declare none: they get a checkout where they chain into
 * `implement`, and the chained Run resolves it.
 */
export function mutates(checkout: CheckoutKind): boolean {
  return checkout !== "none";
}

/**
 * Whether the checkout roams rather than owning one branch. A Renovate Run moves
 * across every Renovate Bot branch it merges, so its checkout is detached at the
 * repository's default branch and no branch is bound to its record: a branch bound to
 * the Run's worktree is a branch no other checkout may have, and these are branches
 * the operator's own checkouts are entitled to.
 */
export function roams(checkout: CheckoutKind): boolean {
  return checkout === "roaming";
}

/**
 * What a roaming Run's checkout is called under the repository's worktrees directory. The
 * workflow that first needed one was `renovate`, and naming the directory after it made
 * every other roaming workflow look like that one.
 */
const ROAMING_DIR = "roaming";

const remoteRepository = (value: string) =>
  /^(?:https?:\/\/|ssh:\/\/|[^@\s]+@)/.test(value) && projectFromRemote(value) !== null;

/**
 * The lock two Runs racing for one destination contend on. Keyed by the destination
 * rather than by the repository, because two repositories of the same name want the
 * same directory and must contend with each other too. Hashed, not slugged: a path is
 * not a filename, and a slug of one is clipped — two destinations that clip to the
 * same name would share a lock, which is the collision this is here to prevent.
 */
export const destinationLock = (stateDir: string, at: string) =>
  `${stateDir}/worktree-${Bun.hash(at).toString(16)}.lock`;

const MrViewJson = Schema.fromJsonString(
  Schema.Struct({ source_branch: Schema.optionalKey(Schema.String) }),
);

/** What deciding a Run's branch needs to know. */
export interface BranchAsk {
  /** Where the Run was started, which is the repository the worktree is cut from. */
  cwd: string;
  /** What this Run is called, which is what a new branch is named after. */
  name: string;
  inputs: Record<string, string>;
  /** Which strategy settled each Input, which is how the work source and target are found. */
  strategies?: Record<string, string> | undefined;
  /**
   * Where each Input's value came from, which for a diff target is the whole question: a
   * target Collie inferred names the branch the caller is *standing on*, and building
   * that branch would hand the Run the checkout that branch already has — the
   * operator's own tree. Only a target a human gave names a branch to build.
   */
  sources?: Record<string, string> | undefined;
  explicit?: string | null | undefined;
  /**
   * The GitLab login a generated branch is namespaced under, from the environment
   * (`PluginEnv.gitlabLogin`). Null or absent leaves it to glab.
   */
  login?: string | null | undefined;
  run?: Runner<ChildProcessSpawner.ChildProcessSpawner>;
}

/**
 * What giving a Run its checkout needs to know: everything deciding its branch does,
 * and the Workflow and workspace only the checkout cares about. One declaration, so an
 * answer the branch resolver learns to take is not a second edit here.
 */
export interface CheckoutAsk extends BranchAsk {
  /** What this Run is called, for the tab a new checkout opens in. */
  workflow: string;
  /** What the Workflow declared it needs of the repository. */
  checkout: CheckoutKind;
  /** Whether the Run asked for a herdr worktree workspace of its own. */
  separate?: boolean;
  /** The workspace the Run lives in, which is its Task's. */
  workspaceId?: string | null;
  workspaceLabel?: string | null;
  /** What to call a workspace herdr opens for this checkout, where it opens one. */
  openLabel?: string | null;
  stateDir: string;
  /** Which Run recorded the checkout at a path, where one did. */
  recordedBy?: RecordedBy;
}

export type RecordedBy = (at: string) => Effect.Effect<string | null>;

/** Where a branch came from, for the line that tells the operator what was decided. */
export type BranchSource =
  | "explicit"
  | "from target"
  | "from the reviewed branch"
  | "from the task"
  | "from plan"
  | "from the work"
  | "from the run name";

export interface BranchPlan {
  branch: string;
  /**
   * The branch without the login it is namespaced under, which is the part that names
   * the work. It is what the Run is called: every branch one operator generates shares
   * the same namespace, so keeping it would spend the slug's length on nothing.
   */
  task: string;
  /** What a branch that does not exist yet is based on. */
  base: string;
  /**
   * Why this Run cannot be given a branch, and null when it can. Never a question:
   * every branch a Run needs is now generated, so a refusal here is a checkout git or
   * herdr would not make, or a GitLab identity nothing establishes — none of which a
   * caller settles by naming a branch.
   */
  refused: string | null;
  source: BranchSource | null;
}

/** The one Input no Workflow declares: which branch a mutating Run works on. */
export const BRANCH_INPUT = "branch";

/**
 * A Workflow's Inputs as a caller has to supply them, which for a mutating Workflow
 * includes the `branch` it does not declare. Listed everywhere the Inputs are, because
 * an operator — or an agent driving Collie — cannot pass an Input nothing names.
 *
 * `optional` and not a strategy of its own: every value in this map is one of the
 * declared strategies (`docs/authoring.md`), and an agent reading a strategy no
 * `InputStrategy` has would be reading something it cannot act on. `optional` is also
 * true of it — inference never supplies it, and a Run without it still starts.
 */
export function branchListed(
  checkout: CheckoutKind,
  inputs: Record<string, string>,
): Record<string, string> {
  // Not for a roaming Workflow: it has no branch of its own to be given one.
  return mutates(checkout) && !roams(checkout) ? { ...inputs, [BRANCH_INPUT]: "optional" } : inputs;
}

/**
 * The Input carrying a task's agreed short name across a handoff, so a branch is named
 * after the work rather than after the path Collie chained into or the whole prose the
 * Run happens to be called.
 */
export const TASK_INPUT = "task";

/** Named in the refusal, so an operator with no login is told what to set. */
const LOGIN_ENV = "GITLAB_USER_LOGIN";

/** How long the task half of a generated branch may be. */
const SLUG_MAX = 40;

/**
 * Which branch this Run builds, in this order:
 *
 * 1. `--input branch=<name>`, which beats everything below.
 * 2. The branch the reviewed work is already on, for a Run fixing a review.
 * 3. The `<name>` of a `branch:<base>...<name>` target *a human gave*.
 * 4. `<login>/<task>`, from the `task` Input a handoff carried.
 * 5. `<login>/<plan directory's own name>`.
 * 6. `<login>/<slug of the work itself>` — the description, or the issue id.
 * 7. `<login>/<slug of the Run's own name>`.
 *
 * The first three are branches that already exist, or that a human named, and are taken
 * verbatim. The rest name work that does not exist yet, and are namespaced under the
 * operator's GitLab login — which is what keeps two people's new work apart.
 *
 * One refusal rather than a guess. A review whose branch cannot be established gets no
 * new one: a fix round exists to update what was reviewed, and putting those commits on
 * a fresh branch named after the Run would leave the merge request untouched and the
 * fixes somewhere nobody is looking.
 */
export const branchFor = Effect.fn("worktree.branchFor")(function* (opts: BranchAsk) {
  const run = opts.run ?? shell;
  const refuse = (why: string) =>
    ({ branch: "", task: "", base: "", refused: why, source: null }) satisfies BranchPlan;
  const asked = yield* branchName(opts, run);
  if (asked.refused !== null) return refuse(asked.refused);
  let branch = asked.branch;
  if (asked.generated) {
    const who = yield* whoami(opts, run);
    if (who === null) {
      return refuse(
        `no GitLab login to name a branch under: ${LOGIN_ENV} is unset and glab could not say who you are. Log in with \`glab auth login\`, or set ${LOGIN_ENV}.`,
      );
    }
    branch = `${who}/${asked.branch}`;
    // git's own rules, on the one name Collie made up rather than was given: an
    // illegal ref would otherwise fail at `worktree add`, after the Run had started.
    const legal = yield* run("git", ["check-ref-format", `refs/heads/${branch}`], opts.cwd);
    if (legal.code !== 0) return refuse(`${branch} is not a branch name git will accept`);
  }
  const base = yield* baseFor(branch, opts.cwd, run, { reviewed: asked.reviewed });
  if (base.refused !== undefined) return refuse(base.refused);
  return {
    branch,
    task: asked.branch,
    base: base.base,
    refused: null,
    source: asked.source,
  } satisfies BranchPlan;
});

/**
 * The GitLab login a generated branch is namespaced under: the environment's, else the
 * authenticated user of whatever host this checkout pushes to. Never the local OS user
 * and never the merge request's assignee — a branch namespace says who is pushing, and
 * a wrong answer here is a branch under someone else's name.
 */
const whoami = Effect.fn("worktree.whoami")(function* (
  opts: BranchAsk,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
) {
  const named = opts.login?.trim();
  if (named) return named;
  return yield* glabLogin(opts.cwd, run);
});

/** What `branchName` answers with: a name and how to treat it, or why there is none. */
interface Named {
  refused: string | null;
  branch: string;
  /** Whether the branch already holds the work, which is what `baseFor` cuts from. */
  reviewed: boolean;
  /** Whether Collie made this name up, and so has to namespace and validate it. */
  generated: boolean;
  source: BranchSource | null;
}

const refusedName = (why: string): Named => ({
  refused: why,
  branch: "",
  reviewed: false,
  generated: false,
  source: null,
});

/** A branch that already exists, or that a human named: taken exactly as it came. */
const verbatim = (branch: string, source: BranchSource, reviewed = false): Named => ({
  refused: null,
  branch,
  reviewed,
  generated: false,
  source,
});

const branchName = Effect.fn("worktree.branchName")(function* (
  opts: BranchAsk,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
) {
  const path = yield* Path.Path;
  const explicit = opts.explicit?.trim();
  if (explicit) return verbatim(explicit, "explicit");
  // `reviewed` is what `baseFor` needs from here: a branch that already holds the work
  // has to be cut from that work, and a name for work that does not exist yet cannot be.
  // A review-source Run reads the target itself, and refuses a head that is not a
  // branch — so the target rule after this one is for Runs starting fresh work.
  const work = workSourceOf(opts);
  if (work?.kind === "review") {
    const reviewed = yield* reviewedBranch(opts.cwd, opts, run);
    // Nothing the caller could say settles a review with no branch to fix: the work
    // being fixed is on a branch or it is not.
    if (reviewed.refused !== undefined) return refusedName(reviewed.refused);
    return verbatim(reviewed.branch, "from the reviewed branch", reviewed.reviewed);
  }
  const target = diffTargetOf(opts);
  const fromTarget = target && said(opts, target.name) ? targetBranch(target.value) : null;
  if (fromTarget) return verbatim(fromTarget, "from target");
  const task = opts.inputs[TASK_INPUT]?.trim();
  if (task) return generated(task, "from the task");
  // The plan directory's own name, not the path to it: every plan under one `tasks/`
  // directory slugs the same way. Only one the operator named, though — a plan
  // directory Collie itself pointed at is `<run.dir>/plan`, from a chained Run or from
  // the picker's offer of a finished plan, and every one of those is called `plan`.
  if (work?.kind === "plan-dir" && said(opts, work.name)) {
    return generated(path.basename(work.value), "from plan", work.value);
  }
  // The work itself where the operator described it — the whole of what they said, not
  // the Run's name for it, because that name is a label `textLabel` already cut to 24
  // characters, under the cap `taskSlug` applies, and a truncated name must never
  // become a branch. Otherwise the Run's name, which is whole: a chained Run is named
  // after its parent, and a plan offered from an earlier Run after that Run.
  // Two sources, because they are two answers: a description the operator typed is the
  // work itself, and the confirm line saying "from the run name" for it would name the
  // wrong thing as what decided.
  const described = work !== null && said(opts, work.name);
  if (described) return generated(work.value, "from the work");
  // The Run's own name, told apart by the work behind it: a Workflow that declares no
  // Input naming the work — `architecture` — is called nothing at all, and two of those
  // sharing a name would share a branch, a checkout, an index and a stash stack. The
  // plan directory it was pointed at is its parent Run's own, so no two agree.
  return generated(opts.name, "from the run name", `${opts.name}\n${work?.value ?? ""}`);
});

/**
 * A name for work that does not exist yet, to be namespaced under the login. `from` is
 * what it reads as; `distinctBy` is what tells it apart from another whose readable half
 * came out the same — the whole of the path a basename was taken from, the description
 * behind a Run's clipped name.
 */
function generated(from: string, source: BranchSource, distinctBy = from): Named {
  return {
    refused: null,
    branch: taskSlug(from, distinctBy),
    reviewed: false,
    generated: true,
    source,
  };
}

/**
 * The task half of a generated branch: bounded, legal, and never standing for two
 * different pieces of work. A slug that does not spell every letter and digit of the
 * text carries a digest of the whole — the length cap, the `run` fallback and a letter
 * no slug can hold all lose something, and the branch is what keys the worktree.
 *
 * A digest and not a counter, so the answer is stable: the same work asked for twice is
 * one branch and one checkout, rather than a second merge request on every retry.
 * `Bun.hash` for the reason `registry.ts` gives.
 */
function taskSlug(from: string, distinctBy: string): string {
  const derived = slugify(from, SLUG_MAX);
  if (letters(from) === letters(derived)) return derived;
  return `${derived}-${Bun.hash(distinctBy).toString(36).slice(0, 6)}`;
}

/** Case, spacing and punctuation are not distinctions: the same words are the same task. */
function letters(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

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
 * The provenances that mean a human said this value, rather than Collie working it out:
 * `--input`, the picker's own "Type it…", and an answer to a question. Everything else
 * — inference, a candidate offered from an earlier Run, a value a parent Run forwarded
 * — is Collie describing the caller's surroundings, and never an instruction about what
 * the work is called or where it should go.
 */
const SAID = new Set(["explicit", "typed", "asked"]);

function said(opts: BranchAsk, name: string): boolean {
  return SAID.has(opts.sources?.[name] ?? "");
}

/**
 * The branch a `branch:<base>...<name>` target names, and null for a target that names
 * no branch to build. A diff's head is a ref, not necessarily a branch — `HEAD` and a
 * sha are both things a human may review — and only a name a branch could have is one.
 */
function targetBranch(target: string): string | null {
  const head = branchTargetHead(target) ?? "";
  if (head === "" || head === "HEAD" || /^[0-9a-f]{7,40}$/.test(head)) return null;
  return head;
}

/**
 * The branch the reviewed target lives on. Anything this cannot establish is a
 * refusal, not a guess: `glab` that would not answer, a merge request with no source
 * branch, a diff of two shas, a detached HEAD.
 */
const reviewedBranch = Effect.fn("worktree.reviewedBranch")(function* (
  cwd: string,
  opts: BranchAsk,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
) {
  const target = diffTargetOf(opts)?.value ?? "";
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
  const head = branchTargetHead(target);
  if (head !== null) {
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
 * The repository a checkout belongs to, by name — git's own main worktree, not the
 * directory the Run happens to be standing in. A mutating Run's cwd is named after its
 * branch, and a roaming one's after nothing at all, so neither basename is the
 * repository's. Null where git will not say.
 */
export const repositoryName = Effect.fn("worktree.repositoryName")(function* (
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
  cwd: string,
) {
  const path = yield* Path.Path;
  const listing = yield* gitWorktrees(run, cwd);
  return listing === null ? null : path.basename(listing.repo);
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
      root_tab_id: opened.rootTab?.tabId ?? null,
      root_pane_id: opened.rootTab?.paneId ?? null,
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

/**
 * Whether anything is at this path, and which repository git says owns it. The path is
 * named after the repository's directory, so two repositories of the same name — two
 * `api`s in two places — want the same one, and a Run has to be told which is holding
 * it rather than handed another repository's working tree. git writes the owner into a
 * linked worktree's `.git` file as `gitdir: <repo>/.git/worktrees/<name>`.
 *
 * Fails closed and never guesses: a path that exists is occupied, and an owner it does
 * not name is `null` rather than assumed, because "we cannot tell" and "nobody" must
 * not come out the same way when the answer decides whether to build over it.
 */
const occupant = Effect.fn("worktree.occupant")(function* (at: string) {
  const fs = yield* FileSystem.FileSystem;
  const there = yield* fs.exists(at).pipe(Effect.catch(() => Effect.succeed(true)));
  if (!there) return null;
  const marker = yield* fs
    .readFileString(`${at}/.git`)
    .pipe(Effect.catch(() => Effect.succeed("")));
  return { owner: /gitdir:\s*(.+?)\/\.git\/worktrees\//.exec(marker)?.[1] ?? null };
});

/**
 * Why this destination cannot be used, from what is actually known about it: which
 * repository git says owns it, and which Run — if any — recorded it. Neither is
 * guessed, and a checkout nothing accounts for is still a refusal.
 */
const occupiedBy = Effect.fn("worktree.occupiedBy")(function* (opts: {
  at: string;
  recordedBy?: RecordedBy | undefined;
}) {
  const taken = yield* occupant(opts.at);
  if (!taken) return null;
  const owner =
    taken.owner === null
      ? "a checkout that does not say which repository it belongs to"
      : `a checkout of ${taken.owner}`;
  const run = opts.recordedBy === undefined ? null : yield* opts.recordedBy(opts.at);
  return `${opts.at} is ${owner}${run === null ? "" : `, recorded by Run ${run}`}`;
});

/**
 * The checkout a roaming Run works in: detached at the repository's default branch as
 * the remote has it, so the Run owns a working tree without owning a branch. Every
 * Renovate branch is then fetched and checked out inside this one and pushed with an
 * explicit refspec, which is what keeps the operator's own checkouts untouched.
 *
 * Its path is the repository's, not a branch's, so two Runs on two repositories never
 * collide. Two Runs on one repository would, and that is a refusal rather than a
 * shared checkout: two Runs in one working tree share an index and a stash stack.
 */
const roamingCheckout = Effect.fn("worktree.roamingCheckout")(function* (opts: {
  cwd: string;
  worktrees: string;
  stateDir: string;
  recordedBy?: RecordedBy | undefined;
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>;
}) {
  const path = yield* Path.Path;
  const { run } = opts;
  const listing = yield* gitWorktrees(run, opts.cwd);
  if (!listing) return { refused: `${opts.cwd} is not a git checkout` };

  const at = path.join(opts.worktrees, path.basename(listing.repo), ROAMING_DIR);
  // Looking and creating are one claim, under a lock keyed by the destination: two Runs
  // starting at once — on this repository or on another of the same name — would
  // otherwise both look, both find it free, and one would be handed the other's tree.
  return yield* withLock(
    destinationLock(opts.stateDir, at),
    Effect.succeed({ refused: `${at} is being claimed by another Run starting now` }),
    claimRoaming({ ...opts, at, repo: listing.repo }),
  );
});

/** The claim itself, which runs only while this process holds the destination's lock. */
const claimRoaming = Effect.fn("worktree.claimRoaming")(function* (opts: {
  at: string;
  repo: string;
  recordedBy?: RecordedBy | undefined;
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>;
}) {
  const { at, run } = opts;
  // Never a shared working tree, and never a takeover: whatever is there — this
  // repository's earlier Run, another repository of the same name, or something that
  // will not say — is a refusal that reports what is known about it.
  const occupied = yield* occupiedBy({ at, recordedBy: opts.recordedBy });
  if (occupied !== null) return { refused: occupied };

  // "As the remote has it" is a fetch, not this checkout's memory of the last one: a
  // repository nobody has fetched for a week would otherwise start the Run on a stale
  // base and merge the month's updates onto it.
  yield* run("git", ["fetch", "--quiet", "origin"], opts.repo);
  const head = (yield* defaultBase(run, opts.repo)) ?? "master";
  // Where there is no remote-tracking ref there is no remote, and the local branch is
  // all there is — the same guard `baseFor` makes for a branch-owning checkout.
  const tracked =
    (yield* run("git", ["rev-parse", "--verify", `origin/${head}`], opts.repo)).code === 0;
  const base = tracked ? `origin/${head}` : head;
  const added = yield* run("git", ["worktree", "add", "--detach", at, base], opts.repo);
  if (added.code !== 0) {
    return { refused: added.stdout.trim() || `git would not add a worktree at ${at}` };
  }
  return { path: at, base };
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
  /** The branch this Run works on and where it came from, for the line that says so. */
  branch: string | null;
  /** The branch without the login namespace, which is what the Run is named after. */
  task: string | null;
  branchSource: BranchSource | null;
}

/**
 * What a Run created for this Checkout is called: the whole of what it is named after,
 * and the shorter form its slug is cut from.
 *
 * The branch already resolves what the Run is about, so it names the Run — but only its
 * task half reaches the slug: the login is the same on every branch one operator
 * generates, and spending the slug's length cap on it makes two Runs one row.
 *
 * `otherwise` is for a Run with no checkout of its own: what it was pointed at, and the
 * short label beside it, exactly as `primaryName` answers with them.
 */
export function runNames(checkout: Checkout, otherwise: { value: string; short: string }) {
  return {
    namedAfter: checkout.branch ?? otherwise.value,
    slugFrom: checkout.task ?? otherwise.short,
  };
}

/**
 * Where this Run works. A Workflow that changes the repository owns its branch's
 * checkout; every other Workflow works in the directory it was started from.
 *
 * The Run stays in its Task's workspace, and only its cwd moves: the work surrounding a
 * task is encapsulated in its workspace, and a checkout of its own is about not sharing
 * an index, not about being somewhere else in the sidebar. `separate` asks herdr for the
 * checkout instead and takes the workspace herdr opens on it.
 *
 * A mutating Workflow that cannot be given a worktree does not start. Falling back to
 * the directory it was launched from is what this whole mechanism exists to prevent:
 * two Runs in one checkout share an index and a stash stack, and that swapped one
 * Run's uncommitted work for another's. A Run that will not start says why; a Run that
 * quietly shares a checkout corrupts a Run nobody was watching.
 */
export const checkoutFor = Effect.fn("worktree.checkoutFor")(function* (
  herdr: Herdr,
  opts: CheckoutAsk,
) {
  const here: Checkout = {
    cwd: opts.cwd,
    workspaceId: opts.workspaceId ?? null,
    workspaceLabel: opts.workspaceLabel ?? null,
    worktree: null,
    note: "",
    refused: null,
    branch: null,
    task: null,
    branchSource: null,
  };
  if (!mutates(opts.checkout)) return here;

  if (roams(opts.checkout)) {
    const repository = gitlabRepositoryOf(opts)?.value ?? "";
    let from = repository || opts.cwd;
    const project = remoteRepository(repository)
      ? (projectFromRemote(repository)?.split("/-/")[0] ?? null)
      : null;
    if (project !== null) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      from = path.join(opts.stateDir, "renovate-repositories", Bun.hash(repository).toString(16));
      if (!(yield* fs.exists(path.join(from, ".git")))) {
        yield* fs.makeDirectory(path.dirname(from), { recursive: true });
        const host = hostOf(project)!;
        const token = (yield* shell(
          "glab",
          ["config", "get", "token", "--host", host],
          opts.stateDir,
          "say",
        )).stdout.trim();
        if (token === "") {
          return { ...here, refused: `could not authenticate to ${host}` };
        }
        const credentials = Buffer.from(`oauth2:${token}`).toString("base64");
        const cloned = yield* shell(
          "env",
          [
            "GIT_CONFIG_COUNT=1",
            "GIT_CONFIG_KEY_0=http.extraHeader",
            `GIT_CONFIG_VALUE_0=Authorization: Basic ${credentials}`,
            "git",
            "clone",
            "--quiet",
            `https://${project}.git`,
            from,
          ],
          opts.stateDir,
          "say",
        );
        if (cloned.code !== 0) {
          return {
            ...here,
            refused: `could not clone ${repository}: ${cloned.stdout.trim() || "git clone failed"}`,
          };
        }
      }
    }
    const made = yield* roamingCheckout({
      cwd: from,
      worktrees: yield* herdr.worktreesDirectory(),
      stateDir: opts.stateDir,
      recordedBy: opts.recordedBy,
      run: (cmd, args, cwd) => shell(cmd, args, cwd, "say"),
    });
    if (made.refused !== undefined) {
      return { ...here, refused: `no worktree for ${from}: ${made.refused}` };
    }
    const worktree = {
      path: made.path,
      // No branch: this checkout roams across the Renovate branches it merges, and a
      // branch in the record is one git would bind to this worktree alone.
      branch: "",
      managed_by: "git",
      workspace_id: null,
      created_by_collie: true,
      made_at: yield* madeAt(made.path),
      root_tab_id: null,
      root_pane_id: null,
    } satisfies WorktreeRecord;
    return {
      ...here,
      cwd: worktree.path,
      worktree,
      note: `created worktree ${worktree.path} detached at ${made.base}`,
    } satisfies Checkout;
  }

  const plan = yield* branchFor(opts);
  if (plan.refused) return { ...here, refused: plan.refused } satisfies Checkout;
  here.branch = plan.branch;
  here.task = plan.task;
  here.branchSource = plan.source;

  // Whichever manager was asked, a Run with nowhere of its own to work says so the
  // same way, naming the branch it could not be given a checkout for.
  const refuse = (why: string) =>
    ({ ...here, refused: `no worktree for ${plan.branch}: ${why}` }) satisfies Checkout;

  if (opts.separate === true) {
    // The Task's own name where the caller worked one out, so the workspace herdr opens
    // reads like every other task workspace rather than like the branch under it.
    const label =
      opts.openLabel ?? tabLabel(GLYPH.running, disambiguate(opts.workflow, plan.branch));
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
      // Its own name or none: the workspace the Run was launched from is a different
      // row, and naming this one after it points at a label it does not have.
      workspaceLabel: workspaceLabel ?? opts.openLabel ?? null,
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
    // A git checkout opens no workspace, so there is no shell tab of its own to take
    // over — the Run stays where it was started and uses that tab as it always did.
    root_tab_id: null,
    root_pane_id: null,
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
  opts: {
    paths: ReadonlyMap<string, string>;
    keep?: string | undefined;
    /** The panes finished Runs' agents were left in, which hold nothing unless still working. */
    leftovers: ReadonlySet<string>;
  },
) {
  const panes = yield* Effect.result(herdr.paneList());
  if (panes._tag === "Failure") return null;
  const paths = new Map(opts.paths);
  const workspaces = new Map<string, string>();
  for (const pane of panes.success) {
    if (!pane.agent) continue;
    // A Run's own agent, idle in the tab it left behind, is what the removal closes —
    // counting it as work in progress kept every finished Run's checkout forever.
    if (opts.leftovers.has(pane.paneId) && pane.agentStatus !== "working") continue;
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
 * finished Runs of that checkout left their agents in, and only while every pane in one
 * is inside it — a tab a human has since split or reused is theirs, not a leftover.
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

  // A roaming checkout has no branch to ask a merge request or the remote about: it
  // holds nothing of its own once it is clean and nothing is working in it, because
  // everything it did was pushed to the Renovate branches it moved across.
  if (worktree.branch === "") return settledBecause("its Run is over and it holds nothing");

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
 * What the Runs say about the worktrees of this machine: the ones Collie made, by path,
 * and the ones a Run is still working in. A checkout a human made appears in no Run, so
 * it is never a candidate for removal.
 */
function fromRuns(runs: ReadonlyArray<RunFacts>, registered: ReadonlyArray<AgentEntry>) {
  const mine = new Map<string, WorktreeRecord>();
  const paths = new Map<string, string>();
  /** The panes each checkout's finished Runs left their agents in. */
  const panes = new Map<string, Set<string>>();
  for (const run of runs) {
    const going = run.state === "running" || run.state === "waiting";
    if (going) paths.set(run.cwd, "a run is still working in it");
    const worktree = run.worktree;
    if (!worktree?.created_by_collie) continue;
    mine.set(worktree.path, worktree);
    // A Run still going keeps its checkout anyway, so its agents are nobody's leftovers.
    if (going) continue;
    const left = panes.get(worktree.path) ?? new Set<string>();
    for (const entry of registered) if (entry.runId === run.id) left.add(entry.paneId);
    panes.set(worktree.path, left);
  }
  return { mine, paths, panes };
}

/**
 * Removes the worktrees this repository has that are settled, and reports what it did
 * and what it is holding — one line each, so nothing is silent. Runs where Collie
 * already wakes up: at every `run start` and every Control Plane refresh, with each
 * worktree's verdict standing for a few minutes so a 1.5-second refresh does not
 * shell out to git and glab over and over.
 */
interface PruneOptions {
  herdr: Herdr;
  stateDir: string;
  /** Every Run there is, which says which checkouts Collie made and which are in use. */
  runs: ReadonlyArray<RunFacts>;
  /** Every agent registered, which says which panes a finished Run left behind. */
  registered: ReadonlyArray<AgentEntry>;
  cwd: string;
  /** A checkout the caller is about to work in, which is therefore in use. */
  keep?: string;
  now?: number;
  run?: Runner<ChildProcessSpawner.ChildProcessSpawner>;
}

/** One repository's round: what herdr lists for it, against what the Runs recorded. */
const prune = Effect.fn("worktree.prune")(function* (
  opts: PruneOptions & {
    recorded: ReturnType<typeof fromRuns>;
    listing: WorktreeListing | null;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // `say`: git writes why it will not drop a checkout, or delete a branch, to stderr,
  // and the whole point of the board's line is to pass that on. Every check here reads
  // the exit code first, so folding stderr into the output changes no decision.
  const run = opts.run ?? ((cmd, args, cwd) => shell(cmd, args, cwd, "say"));
  const now = opts.now ?? (yield* Clock.currentTimeMillis);
  const statePath = path.join(opts.stateDir, PRUNE_FILE);
  // What a board line calls a checkout: the branch it is for. Not the last part of its
  // path — a branch with a `/` in it nests, so `feature/foo` would read as "foo". A
  // roaming checkout has no branch, so its own directory is the only name it has.
  const nameOf = (worktree: { path: string; branch: string }) =>
    worktree.branch || path.basename(worktree.path);
  const state = yield* fs.readFileString(statePath).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(PruneStateJson)),
    Effect.catch(() => Effect.succeed<PruneState>({})),
  );
  const before = `${Schema.encodeSync(PruneStateJson)(state)}\n`;

  const { mine, paths, panes } = opts.recorded;
  const listing = opts.listing;
  // Path, branch and the moment git wrote the checkout, all from the record that made
  // it: a Collie worktree removed by hand and a human's worktree later made at the
  // same path on the same branch would otherwise be the same candidate, and a
  // hand-made checkout is never touched.
  const candidates: Array<WorktreeInfo & { branch: string }> = [];
  for (const worktree of listing?.worktrees ?? []) {
    // A detached checkout has no branch, which herdr reports as null or as empty; the
    // record of a roaming Run's checkout is empty for the same reason. Matching them
    // is what lets a Renovate Run's checkout be pruned like any other.
    const branch = worktree.branch ?? "";
    const record = mine.get(worktree.path);
    if (!record || record.branch !== branch || record.made_at === null) continue;
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
  const leftovers = new Set([...panes.values()].flatMap((left) => [...left]));
  const use = yield* inUse(opts.herdr, { paths, keep: opts.keep, leftovers });
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
            tabs: new Set(
              use.panes
                .filter((pane) => panes.get(worktree.path)?.has(pane.paneId) ?? false)
                .map((pane) => pane.tabId),
            ),
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
    /** The tabs its finished Runs' agents were left in, closed with the checkout. */
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
  // A roaming checkout owned no branch, so there is none to delete.
  const deleted =
    worktree.branch === ""
      ? { code: 0, stdout: "" }
      : yield* opts.run("git", ["branch", "-d", worktree.branch], opts.repo);
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
export const pruneWorktrees = (opts: PruneOptions) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const lock = path.join(opts.stateDir, `${PRUNE_FILE}.lock`);
    return yield* withLock(lock, Effect.succeed<string[]>([]), sweep(opts));
  }).pipe(Effect.catch(() => Effect.succeed<string[]>([])));

/**
 * Every repository the recorded checkouts belong to, each asked from one of its own
 * checkouts. The board's cwd alone was not enough: the Home is no repository, so its
 * sweep listed nothing, and a Renovate checkout under a repository nobody has a
 * workspace in was never anyone's candidate.
 */
const sweep = Effect.fn("worktree.sweep")(function* (opts: PruneOptions) {
  const fs = yield* FileSystem.FileSystem;
  const recorded = fromRuns(opts.runs, opts.registered);
  const lines: string[] = [];
  const listed = new Set<string>();
  // One `herdr worktree list` per live checkout, every sweep. Cheap while checkouts are few.
  for (const cwd of new Set([opts.cwd, ...recorded.mine.keys()])) {
    const own = cwd === opts.cwd;
    // A checkout an earlier listing named is in a repository already swept.
    if (!own && (listed.has(cwd) || !(yield* fs.exists(cwd)))) continue;
    const listing = yield* opts.herdr
      .worktreeList(cwd)
      .pipe(Effect.catch(() => Effect.succeed<WorktreeListing | null>(null)));
    if (!own && (listing === null || listing.worktrees.every((w) => listed.has(w.path)))) continue;
    for (const worktree of listing?.worktrees ?? []) listed.add(worktree.path);
    lines.push(...(yield* prune({ ...opts, cwd, recorded, listing })));
  }
  return lines;
});
