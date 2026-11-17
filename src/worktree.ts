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

import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import { Clock, Duration, Effect, FileSystem, Option, Path, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { isSettled, type Herdr, type AgentInfo } from "./herdr";
import type { CheckoutKind } from "./definitions";
import { diffTargetOf, planRunOf, repositoryOf, workSourceOf } from "./strategies";
import { runningChecks } from "./check-processes";
import { defaultBase, linearIssueOf } from "./inputs";
import {
  branchTargetHead,
  projectFromRemote,
  forgeHere,
  projectHere,
  shell,
  whatItSaid,
  type Runner,
} from "./mr";
import { mrWords, parseMrTarget, readMrRef, readMrUrl } from "./board-model";
import { FORGES, forgeOf, forgeOfHost } from "./forge/forge";
import { withLock } from "./lock";
import { worktreesDirectory } from "./config";
import { withoutCredentials } from "./automode";
import type { AgentEntry } from "./registry";
import type { WorktreeRecord } from "./run";
// Type-only: the host imports this module, and `runs.ts` reads through the host.
import type { RunFacts } from "./runs";
import { slugify } from "./template";
import { changeBranch } from "./plan";
import { unlistedServers, type CompactionPorts } from "./compaction";
import { COMPACTION_PORTS } from "./compactors";
import { endAgent, endedLine, runLog } from "./agent-end";
import { readLaunches } from "./launches";
import { installDependencies } from "./dependencies";

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
 * What a roaming Run's checkouts are called under the repository's worktrees directory, in
 * the order a start looks at them. The workflow that first needed one was `renovate`, and
 * naming the directory after it made every other roaming workflow look like that one.
 */
const ROAMING_DIRS = ["roaming", "roaming-2", "roaming-3"];

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

/** Whether a state-directory entry is one of `destinationLock`'s. */
export const isDestinationLock = (name: string) => /^worktree-[0-9a-f]+\.lock$/.test(name);

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
  /** The branch the Task whose plan this Run builds was placed on, which it continues. */
  taskBranch?: string | null | undefined;
  /** The Change this Run builds, whose name its branch carries; absent for a default Change. */
  change?: string | undefined;
  /** The Change of the same repository its branch is cut from: "" for the default one. */
  stackedOn?: string | undefined;
  /**
   * The GitLab login a generated branch is namespaced under, from the environment
   * (`PluginEnv.gitlabLogin`). Null or absent leaves it to glab.
   */
  login?: string | null | undefined;
  /** The same on GitHub (`PluginEnv.githubLogin`); null or absent leaves it to gh. */
  githubLogin?: string | null | undefined;
  /** The Flock's GitLab, which a checkout's or a repository URL's host is whatever its name. */
  gitlabHost?: string | undefined;
  /** False reads the base from the refs this checkout has, fetching none. */
  fetches?: boolean | undefined;
  run?: Runner<ChildProcessSpawner.ChildProcessSpawner>;
}

/**
 * What giving a Run its checkout needs to know: everything deciding its branch does,
 * and the Workflow and workspace only the checkout cares about. One declaration, so an
 * answer the branch resolver learns to take is not a second edit here.
 */
export interface CheckoutAsk extends BranchAsk {
  branchBase?: string | undefined;
  /** What this Run is called, for the tab a new checkout opens in. */
  workflow: string;
  /** What the Workflow declared it needs of the repository. */
  checkout: CheckoutKind;
  /** The workspace the Run lives in, which is its Task's. */
  workspaceId?: string | null;
  workspaceLabel?: string | null;
  stateDir: string;
  /** Which Run recorded the checkout at a path, where one did. */
  recordedBy?: RecordedBy;
  /** Records a roaming checkout as this Run's while its destination is still locked. */
  claimed?: (worktree: WorktreeRecord) => Effect.Effect<void>;
  /** The checkout of the Run that started this one, given only while that Run waits on a question. */
  starting?: { readonly run: string; readonly cwd: string };
}

/** The Run that recorded a checkout, and how a new Run takes the checkout from it. */
export interface Recorded {
  readonly run: string;
  /** The checkout as that Run recorded it. */
  readonly worktree: WorktreeRecord | null;
  /** Why a Run that recorded or works in it has not ended, or null once every one has. */
  readonly live: Effect.Effect<string | null>;
  /** Closes the agents of every Run that recorded it; null once done, or why it may not be taken. */
  readonly release: Effect.Effect<string | null>;
}

export type RecordedBy = (at: string) => Effect.Effect<Recorded | null>;

/** Where a branch came from, for the line that tells the operator what was decided. */
export type BranchSource =
  | "explicit"
  | "from target"
  | "from the reviewed branch"
  | "from the merge request"
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

/** How long the task half of a generated branch may be. */
const SLUG_MAX = 40;

/**
 * Which branch this Run builds, in this order:
 *
 * 1. `--input branch=<name>`, which beats everything below.
 * 2. The branch the reviewed work is already on, for a Run fixing a review.
 * 3. The source branch of the one open merge request of this project that work *someone
 *    said* names: its whole text as one reference, or the only merge request URL in it.
 * 4. The `<name>` of a `branch:<base>...<name>` target *a human gave*.
 * 5. `<login>/<task>`, from the `task` Input a handoff carried.
 * 6. The branch the Task of the Run whose plan this builds was placed on.
 * 7. `<login>/<plan directory's own name>`, never for a Run's own plan directory.
 * 8. `<login>/<slug of the work itself>` — the description, or the issue id.
 * 9. `<login>/<slug of the Run's own name>`.
 *
 * The first four and the sixth are branches that already exist, or that a human named,
 * and are taken verbatim. The rest name work that does not exist yet, and are namespaced under the
 * operator's GitLab login — which is what keeps two people's new work apart.
 *
 * One refusal rather than a guess. A review, or work naming a merge request of this
 * project, whose branch cannot be established gets no new one: the work exists to update
 * that merge request, and putting those commits on a fresh branch named after the Run
 * would leave it untouched and the fixes somewhere nobody is looking.
 */
export const branchFor = Effect.fn("worktree.branchFor")(function* (opts: BranchAsk) {
  const run = opts.run ?? shell;
  const refuse = (why: string) =>
    ({ branch: "", task: "", base: "", refused: why, source: null }) satisfies BranchPlan;
  const asked = yield* branchName(opts, run);
  if (asked.refused !== null) return refuse(asked.refused);
  let plan = asked.branch;
  if (asked.generated) {
    const identity = yield* whoami(opts, run);
    if (!identity.ok) return refuse(identity.reason);
    const { forge, who } = identity;
    if (who === null) {
      const variable = LOGIN_ENV[forge.name];
      return refuse(
        `no ${forge.display} login to name a branch under: ${variable} is unset and ${forge.cli} could not say who you are. Log in with \`${forge.cli} auth login\`, or set ${variable}.`,
      );
    }
    plan = `${who}/${asked.branch}`;
  }
  const branch = changeBranch(plan, opts.change);
  if (asked.generated) {
    // git's own rules, on the one name Collie made up rather than was given: an
    // illegal ref would otherwise fail at `worktree add`, after the Run had started.
    const legal = yield* run("git", ["check-ref-format", `refs/heads/${branch}`], opts.cwd);
    if (legal.code !== 0) return refuse(`${branch} is not a branch name git will accept`);
  }
  const fetches = opts.fetches !== false;
  const base =
    opts.stackedOn === undefined
      ? yield* baseFor(branch, opts.cwd, run, { reviewed: asked.reviewed, fetches })
      : yield* stackedBase(branch, changeBranch(plan, opts.stackedOn), opts.cwd, run, fetches);
  if (base.refused !== undefined) return refuse(base.refused);
  return {
    branch,
    task: changeBranch(asked.branch, opts.change),
    base: base.base,
    refused: null,
    source: asked.source,
  } satisfies BranchPlan;
});

/**
 * The login a generated branch is namespaced under, on the checkout's forge: the
 * environment's, else the authenticated user of whatever host this checkout pushes to. Never the local OS user
 * and never the merge request's assignee — a branch namespace says who is pushing, and
 * a wrong answer here is a branch under someone else's name.
 */
const whoami = Effect.fn("worktree.whoami")(function* (
  opts: BranchAsk,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
) {
  const here = yield* forgeHere(opts.cwd, run, opts.gitlabHost);
  if (!here.ok) return here;
  const { forge } = here;
  const named = Option.getOrUndefined(
    Option.map(
      Option.fromNullishOr(forge.name === "github" ? opts.githubLogin : opts.login),
      (present_) => Str.trim(present_),
    ),
  );
  return { ...here, who: named ? named : yield* forge.login(opts.cwd, run, here.project) };
});

/** Named in the refusal, so an operator with no login is told what to set (ADR-0050 D5). */
const LOGIN_ENV = { gitlab: "GITLAB_USER_LOGIN", github: "GITHUB_ACTOR" } as const;

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
  const explicit = Option.getOrUndefined(
    Option.map(Option.fromNullishOr(opts.explicit), (present__) => Str.trim(present__)),
  );
  if (explicit) return verbatim(explicit, "explicit");
  // `reviewed` is what `baseFor` needs from here: a branch that already holds the work
  // has to be cut from that work, and a name for work that does not exist yet cannot be.
  // A review-source Run reads the target itself, and refuses a head that is not a
  // branch — so the target rule after this one is for Runs starting fresh work.
  const work = workSourceOf(opts);
  if (work?.kind === "review") {
    const reviewed = yield* reviewedBranch(opts.cwd, diffTargetOf(opts)?.value ?? "", run);
    // Nothing the caller could say settles a review with no branch to fix: the work
    // being fixed is on a branch or it is not.
    if (reviewed.refused !== undefined) return refusedName(reviewed.refused);
    return verbatim(reviewed.branch, "from the reviewed branch", reviewed.reviewed);
  }
  const mr =
    work !== null && said(opts, work.name) ? yield* mrNamedBy(work.value, opts.cwd, run) : null;
  if (mr) {
    const named = yield* reviewedBranch(opts.cwd, mrWords(mr).target, run);
    if (!named.context) {
      if (named.refused !== undefined) return refusedName(named.refused);
      return verbatim(named.branch, "from the merge request", true);
    }
  }
  const target = diffTargetOf(opts);
  const fromTarget = target && said(opts, target.name) ? targetBranch(target.value) : null;
  if (fromTarget) return verbatim(fromTarget, "from target");
  const task = Option.getOrUndefined(
    Option.map(Option.fromNullishOr(opts.inputs[TASK_INPUT]), (present___) => Str.trim(present___)),
  );
  if (task) return generated(task, "from the task");
  const taskBranch = Option.getOrUndefined(
    Option.map(Option.fromNullishOr(opts.taskBranch), (present____) => Str.trim(present____)),
  );
  if (taskBranch) return verbatim(taskBranch, "from the task", true);
  // The plan directory's own name, not the path to it: every plan under one `tasks/`
  // directory slugs the same way. Only one the operator named, and never a Run's own
  // `<run.dir>/plan` — chained, offered by the picker or typed — which is always `plan`.
  const ownPlan = work !== null && planRunOf(work.value) !== null;
  if (work?.kind === "plan-dir" && !ownPlan && said(opts, work.name)) {
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
  const described = work !== null && !ownPlan && said(opts, work.name);
  // An issue's URL names the same work as its id, and slugging the URL names a branch after linear.app.
  const issue = work?.kind === "linear" ? linearIssueOf(work.value) : null;
  if (described) return generated(issue ?? work.value, "from the work");
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
  return `${derived}-${pipe_(Bun.hash(distinctBy).toString(36), Str.slice(0, 6))}`;
}

/** Case, spacing and punctuation are not distinctions: the same words are the same task. */
function letters(text: string): string {
  return pipe_(Str.toLowerCase(text), Str.replace(/[^\p{L}\p{N}]+/gu, ""));
}

/**
 * What a checkout of this branch is cut from. The branch's own tip on the remote where
 * it has one: a fix round continues the work that was reviewed, and cutting it from the
 * default branch instead would build something unrelated and then be unable to push it.
 * A reviewed branch this checkout has never fetched is fetched once for that reason —
 * and if it is neither there nor a local branch, the Run is refused rather than started
 * on the wrong history.
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
  opts: { reviewed: boolean; fetches: boolean },
) {
  const exists = (ref: string) => run("git", ["rev-parse", "--verify", ref], cwd);
  if ((yield* exists(`origin/${branch}`)).code === 0) return { base: `origin/${branch}` };
  if (opts.reviewed) {
    // A local branch is checked out as it is, so the base goes unused.
    if ((yield* exists(`refs/heads/${branch}`)).code === 0) return { base: branch };
    // Otherwise it holds the work that was reviewed, so it is on the remote whether or
    // not this checkout has heard of it yet.
    if (opts.fetches) yield* run("git", ["fetch", "origin", branch], cwd);
    if ((yield* exists(`origin/${branch}`)).code === 0) return { base: `origin/${branch}` };
    return { refused: `${branch} is not on the remote, so there is no reviewed work to fix` };
  }
  return { base: yield* defaultStart(cwd, run) };
});

const stackedBase = Effect.fn("worktree.stackedBase")(function* (
  branch: string,
  blocker: string,
  cwd: string,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
  fetches: boolean,
) {
  const exists = (ref: string) => run("git", ["rev-parse", "--verify", ref], cwd);
  if ((yield* exists(`origin/${branch}`)).code === 0) return { base: `origin/${branch}` };
  if (fetches) yield* run("git", ["fetch", "origin", blocker], cwd);
  if ((yield* exists(`origin/${blocker}`)).code === 0) return { base: `origin/${blocker}` };
  if ((yield* exists(`refs/heads/${blocker}`)).code === 0) return { base: blocker };
  return { refused: `${blocker}, the branch ${branch} is stacked on, is neither pushed nor here` };
});

/** Where new work starts, as `baseFor` says. */
export const defaultStart = Effect.fn("worktree.defaultStart")(function* (
  cwd: string,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
) {
  const head = (yield* defaultBase(run, cwd)) ?? "master";
  const tracked = (yield* run("git", ["rev-parse", "--verify", `origin/${head}`], cwd)).code === 0;
  return tracked ? `origin/${head}` : head;
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

/** No URL holds these unescaped, so no URL spans one. */
const OUTSIDE_URL = /[\s<>"{}|\\^`[\]]+/;
const PROSE_EDGES = /^[('"]+|[)'".,;:!?]+$/g;

/** Each word of prose that is a whole merge request URL; a word holding several URLs counts twice. */
const mrUrlsIn = (text: string) =>
  Arr.flatMap(Str.split(text, OUTSIDE_URL), (word) => {
    const said = pipe_(word, Str.replace(PROSE_EDGES, ""));
    const ref = readMrUrl(said);
    if (Str.split(said, "://").length > 2) return [ref, ref];
    return ref === null ? [] : [ref];
  });

/**
 * The one merge request work names: the only merge or pull request URL in it, else its
 * whole text as one reference, read in this checkout's project. A bare `!42` inside prose
 * is not read: `#1` and issue numbers make it a guess.
 */
const mrNamedBy = Effect.fn("worktree.mrNamedBy")(function* (
  text: string,
  cwd: string,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
) {
  const urls = mrUrlsIn(text);
  if (urls.length > 0) return urls.length === 1 ? urls[0]! : null;
  const whole = /\s/.test(Str.trim(text)) ? null : readMrRef(text, { project: null });
  if (whole?.project === null) return { ...whole, project: yield* projectHere(cwd, run) };
  return whole;
});

/**
 * The branch the reviewed target lives on. Anything this cannot establish is a
 * refusal, not a guess: `glab` that would not answer, a merge request with no source
 * branch, a diff of two shas, a detached HEAD. `context` marks a merge request work only
 * mentions rather than is about: one of another project, or merged or closed.
 */
const reviewedBranch = Effect.fn("worktree.reviewedBranch")(function* (
  cwd: string,
  target: string,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
) {
  const mr = parseMrTarget(target);
  if (mr) {
    // A merge request in another project cannot be fixed from this checkout at all:
    // `herdr worktree` only ever makes a checkout of the repository it is asked in, so
    // the alternative to refusing is a worktree of the wrong repository. A checkout
    // whose own project cannot be read is refused for the same reason: nothing here
    // says it is the project the merge request is in, and a bare `mr:42` came from
    // this directory's remote in the first place.
    const words = mrWords(mr);
    const named = mr.project === null ? `${words.sign}${mr.iid}` : words.label;
    if (mr.project) {
      const here = yield* projectHere(cwd, run);
      if (here === null) {
        return { refused: `${cwd} has no remote, so ${named} may not be its own`, context: true };
      }
      if (mr.project !== here) {
        return {
          refused: `${named} is in ${mr.project}, and this is a checkout of ${here}`,
          context: true,
        };
      }
    }
    const panel = yield* forgeOf(mr).details(mr, cwd, run);
    if (panel._tag !== "Details") return { refused: panel.reason };
    const context = panel.state === "merged" || panel.state === "closed";
    if (panel.fork === true)
      return {
        refused: `${named} comes from a fork, so its branch is not in this checkout`,
        context,
      };
    const source = Str.trim(panel.sourceBranch);
    return source
      ? { branch: source, reviewed: true, context }
      : { refused: `${named} names no source branch`, context };
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
  // Only the working tree is the caller's own branch; any other shape is refused, not guessed.
  if (target === "") return { refused: "the review names no target, so no branch holds its work" };
  if (Str.trim(target) !== "worktree") {
    return { refused: `${target} is not a target Collie can find a branch for` };
  }
  const at = yield* run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const branch = Str.trim(at.stdout);
  if (at.code !== 0 || branch === "" || branch === "HEAD") {
    return { refused: `${cwd} is not on a branch to fix` };
  }
  // The caller's own branch: it is checked out here, so it needs no fetching and may
  // legitimately have nothing on the remote yet.
  return { branch, reviewed: false };
});

/**
 * The piece of work a Run is about: its repository and branch. That is the branch it was
 * placed on or its diff target names — never the caller's HEAD, which says where it was
 * typed, not what it is about. Null on the default branch, which names no one piece of
 * work, and wherever git or glab will not say.
 */
export const workOf = Effect.fn("worktree.workOf")(function* (
  opts: BranchAsk & { readonly branch: string | null },
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
) {
  const listing = yield* gitWorktrees(run, opts.cwd);
  if (listing === null) return null;
  const reviewed =
    opts.branch === null && diffTargetOf(opts) != null
      ? yield* reviewedBranch(opts.cwd, diffTargetOf(opts)?.value ?? "", run)
      : null;
  if (reviewed !== null && !("branch" in reviewed)) return null;
  const branch = opts.branch ?? reviewed?.branch ?? null;
  if (branch === null || branch === "" || branch === "HEAD") return null;
  const origin = yield* run("git", ["rev-parse", "--abbrev-ref", "origin/HEAD"], opts.cwd);
  const base =
    origin.code === 0 ? pipe_(Str.trim(origin.stdout), Str.replace(/^origin\//, "")) : "";
  if (base === "" ? branch === "main" || branch === "master" : branch === base) return null;
  return `${listing.repo}#${branch}`;
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
const branchPath = (branch: string) => Str.split(branch, "/");

interface Listed {
  path: string;
  /** Null where the checkout is detached. */
  branch: string | null;
}

/**
 * Every checkout git itself knows about, and which of them the repository is: git's own
 * list answers both questions at once and lists a checkout however it was made.
 */

const gitWorktrees = Effect.fn("worktree.gitWorktrees")(function* (
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
  cwd: string,
) {
  const listed = yield* run("git", ["worktree", "list", "--porcelain"], cwd);
  if (listed.code !== 0) return null;
  const checkouts: Listed[] = [];
  for (const block of Str.split(listed.stdout, /\n\s*\n/)) {
    const at = Option.getOrUndefined(
      Option.flatMap(Option.fromNullishOr(/^worktree (.+)$/m.exec(block)), (present_____) =>
        Option.map(Option.fromNullishOr(present_____[1]), (present______) =>
          Str.trim(present______),
        ),
      ),
    );
    if (at === undefined) continue;
    // A detached checkout has no `branch` line at all, which is what null means here.
    const ref = Option.getOrUndefined(
      Option.flatMap(Option.fromNullishOr(/^branch (.+)$/m.exec(block)), (present_______) =>
        Option.map(Option.fromNullishOr(present_______[1]), (present________) =>
          Str.trim(present________),
        ),
      ),
    );
    checkouts.push({
      path: at,
      branch:
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(ref), (present_________) =>
            pipe_(present_________, Str.replace(/^refs\/heads\//, "")),
          ),
        ) ?? null,
    });
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
 * land where the reviewed work already is — and otherwise a new one at the first free
 * slot under the worktrees directory. Anything else at a slot, such as another
 * clone's checkout of the same name, is left as it is and passed over
 * (ADR-draft-an-occupied-branch-checkout-path-is-passed-over).
 */
const gitCheckout = Effect.fn("worktree.gitCheckout")(function* (opts: {
  cwd: string;
  branch: string;
  base?: string | undefined;
  /** Where a new checkout goes. */
  worktrees: string;
  stateDir: string;
  recordedBy?: RecordedBy | undefined;
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>;
}) {
  const path = yield* Path.Path;
  const { run, branch } = opts;
  const listing = yield* gitWorktrees(run, opts.cwd);
  if (!listing) return { refused: `${opts.cwd} is not a git checkout` };
  // Even a listed checkout waits for the lock: git lists one before it has filled it.
  const first = path.join(opts.worktrees, path.basename(listing.repo), ...branchPath(branch));
  return yield* withLock(
    destinationLock(opts.stateDir, first),
    Effect.succeed({ refused: `${first} is being checked out by another Run starting now` }),
    cutBranchCheckout({ ...opts, repo: listing.repo, first }),
    Duration.minutes(2),
  );
});

/** The first of `first`'s three slots nothing holds, or why there is none, naming each. */
const freeSlot = Effect.fn("worktree.freeSlot")(function* (opts: {
  repo: string;
  first: string;
  listing: { readonly checkouts: ReadonlyArray<{ readonly path: string }> };
  recordedBy?: RecordedBy | undefined;
}) {
  const passed: string[] = [];
  for (const slot of [opts.first, `${opts.first}-2`, `${opts.first}-3`]) {
    // git lists a checkout whose directory has gone, and will not add another there.
    const taken =
      (yield* occupant(slot)) ??
      (Arr.some(opts.listing.checkouts, (checkout) => checkout.path === slot)
        ? { owner: opts.repo }
        : null);
    if (taken === null) return { at: slot, passed };
    const recorded = opts.recordedBy === undefined ? null : yield* opts.recordedBy(slot);
    passed.push(`${slot} is ${occupiedAs(taken.owner, recorded)}`);
  }
  return { at: null, refused: `${Arr.join(passed, "; ")}; free one of them and retry` };
});

/** The look and the cut, which run only while this process holds the first slot's lock. */
const cutBranchCheckout = Effect.fn("worktree.cutBranchCheckout")(function* (opts: {
  repo: string;
  first: string;
  branch: string;
  base?: string | undefined;
  recordedBy?: RecordedBy | undefined;
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>;
}) {
  const { run, branch } = opts;
  // Again, under the lock: a Run that waited here reuses what the one before it cut.
  const listing = yield* gitWorktrees(run, opts.repo);
  if (!listing) return { refused: `${opts.repo} is not a git checkout` };
  const existing = Option.getOrUndefined(
    Arr.findFirst(listing.checkouts, (checkout) => checkout.branch === branch),
  );
  if (existing) return { path: existing.path, created: false, passed: [] };

  const slot = yield* freeSlot({ ...opts, listing });
  if (slot.at === null) return { refused: slot.refused };
  const { at, passed } = slot;

  // A branch this checkout already has is what a fix round works on.
  const known =
    (yield* run("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], opts.repo))
      .code === 0;
  let start = "";
  if (!known) {
    const base = opts.base || "HEAD";
    const resolved = yield* run(
      "git",
      ["rev-parse", "--verify", "--quiet", `${base}^{commit}`],
      opts.repo,
    );
    if (resolved.code !== 0) return { refused: `${base} is not a commit` };
    start = Str.trim(resolved.stdout);
    // Made here rather than by `worktree add -b`, which fails the same way whether or not
    // it made the branch: `git branch` refuses one somebody else made since the look.
    const made = yield* run("git", ["branch", branch, start], opts.repo);
    if (made.code !== 0) return { refused: whatItSaid(made) || `git would not make ${branch}` };
    // What `-b` would have tracked.
    const remoteBase = opts.base;
    if (remoteBase !== undefined && pipe_(remoteBase, Str.startsWith("origin/")))
      yield* run("git", ["branch", "--set-upstream-to", remoteBase, branch], opts.repo);
  }
  const added = yield* run("git", ["worktree", "add", at, branch], opts.repo);
  if (added.code !== 0) {
    // Deleted only while still where it was made, so nobody else's branch goes with it.
    if (!known) yield* run("git", ["update-ref", "-d", `refs/heads/${branch}`, start], opts.repo);
    return { refused: whatItSaid(added) || `git would not add a worktree at ${at}` };
  }
  return { path: at, created: true, passed };
});

/**
 * The origin, credentials removed, where `branch` is neither local nor on it, so a checkout
 * made now creates it; null where it exists or that is unsure.
 */
const newOnOrigin = Effect.fn("worktree.newOnOrigin")(function* (branch: string, cwd: string) {
  const local = yield* shell(
    "git",
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    cwd,
  );
  if (local.code === 0) return null;
  // 2 is ls-remote's own "no such ref"; a remote it cannot reach says nothing.
  const remote = yield* shell(
    "git",
    ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`],
    cwd,
  );
  if (remote.code !== 2) return null;
  const url = yield* shell("git", ["remote", "get-url", "origin"], cwd);
  return url.code === 0 && Str.trim(url.stdout) !== ""
    ? withoutCredentials(Str.trim(url.stdout))
    : null;
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
  // A symlink holds the path even where its target has gone, and `exists` follows it.
  const there =
    Option.isSome(yield* fs.readLink(at).pipe(Effect.option)) ||
    (yield* fs.exists(at).pipe(Effect.orElseSucceed(() => true)));
  if (!there) return null;
  const marker = yield* fs.readFileString(`${at}/.git`).pipe(Effect.orElseSucceed(() => ""));
  return { owner: /gitdir:\s*(.+?)\/\.git\/worktrees\//.exec(marker)?.[1] ?? null };
});

/**
 * What is known about an occupied destination: which repository git says owns it, and
 * which Run — if any — recorded it. Neither is guessed.
 */
const occupiedAs = (owner: string | null, recorded: Recorded | null) =>
  `${
    owner === null
      ? "a checkout that does not say which repository it belongs to"
      : `a checkout of ${owner}`
  }${recorded === null ? "" : `, recorded by Run ${recorded.run}`}`;

/** Whether the checkout at `at` is the one Collie made and recorded, not one made there since. */
export const isTheOneMade = Effect.fn("worktree.isTheOneMade")(function* (
  at: string,
  record: WorktreeRecord | null,
) {
  if (record === null || !record.created_by_collie || record.made_at === null) return false;
  return (yield* madeAt(at)) === record.made_at;
});

/**
 * What moving a roaming checkout to the default branch would lose, why git could not
 * say, or null for nothing.
 */
const wouldLose = Effect.fn("worktree.wouldLose")(function* (
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
  at: string,
) {
  const dirty = yield* run("git", ["status", "--porcelain"], at);
  if (dirty.code !== 0) return { unread: "could not read the working tree" };
  if (Str.trim(dirty.stdout) !== "") return { lost: "uncommitted changes" };
  // Only commits no branch or remote has: moving HEAD is what would leave them behind.
  const only = yield* run("git", ["rev-list", "HEAD", "--not", "--branches", "--remotes"], at);
  if (only.code !== 0) return { unread: "could not read what is unpushed" };
  const count = commits(only);
  return count === 0
    ? null
    : { lost: `${count} commit${count === 1 ? "" : "s"} on no branch or remote` };
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
 * A checkout an ended Run left work in is passed over for the next of `ROAMING_DIRS`.
 */
const roamingCheckout = Effect.fn("worktree.roamingCheckout")(function* (opts: {
  cwd: string;
  worktrees: string;
  stateDir: string;
  recordedBy?: RecordedBy | undefined;
  claimed?: ((worktree: WorktreeRecord) => Effect.Effect<void>) | undefined;
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>;
}) {
  const path = yield* Path.Path;
  const { run } = opts;
  const listing = yield* gitWorktrees(run, opts.cwd);
  if (!listing) return { refused: `${opts.cwd} is not a git checkout` };

  const slots = Arr.map(ROAMING_DIRS, (dir) =>
    path.join(opts.worktrees, path.basename(listing.repo), dir),
  );
  const at = slots[0]!;
  // Looking and creating are one claim over every slot, under a lock keyed by the first:
  // two Runs starting at once — on this repository or on another of the same name — would
  // otherwise both look, both find one free, and one would be handed the other's tree.
  // The claim is recorded before the lock goes, so the next Run to look finds it taken.
  return yield* withLock(
    destinationLock(opts.stateDir, at),
    Effect.succeed({ refused: `${at} is being claimed by another Run starting now` }),
    Effect.gen(function* () {
      const made = yield* claimRoaming({
        ...opts,
        slots,
        repo: listing.repo,
      });
      if (made.refused !== undefined) return made;
      const worktree = {
        path: made.path,
        // No branch: this checkout roams across the Renovate branches it merges, and a
        // branch in the record is one git would bind to this worktree alone.
        branch: "",
        managed_by: "git",
        workspace_id: null,
        created_by_collie: true,
        created_branch: false,
        created_on: null,
        made_at: yield* madeAt(made.path),
        root_tab_id: null,
        root_pane_id: null,
      } satisfies WorktreeRecord;
      if (opts.claimed !== undefined) yield* opts.claimed(worktree);
      return { ...made, worktree };
    }),
  );
});

/** The claim itself, which runs only while this process holds the destination's lock. */
const claimRoaming = Effect.fn("worktree.claimRoaming")(function* (opts: {
  slots: ReadonlyArray<string>;
  repo: string;
  recordedBy?: RecordedBy | undefined;
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>;
}) {
  const { run } = opts;
  // Listed under the lock: a slot another start has just added is one git lists now.
  const listing = yield* gitWorktrees(run, opts.repo);
  if (listing === null) return { refused: `could not list the worktrees of ${opts.repo}` };
  const listed = new Set(Arr.map(listing.checkouts, (checkout) => checkout.path));
  const seen: Array<{
    at: string;
    taken: { owner: string | null } | null;
    recorded: Recorded | null;
  }> = [];
  for (const at of opts.slots) {
    const taken = yield* occupant(at);
    const recorded =
      taken === null || opts.recordedBy === undefined ? null : yield* opts.recordedBy(at);
    // Never two roaming Runs on one repository: one that has not ended refuses the start.
    if (taken !== null && recorded !== null && taken.owner === opts.repo && listed.has(at)) {
      const live = yield* recorded.live;
      if (live !== null)
        return { refused: `${at} is ${occupiedAs(taken.owner, recorded)}: ${live}` };
    }
    seen.push({ at, taken, recorded });
  }

  // "As the remote has it" is a fetch, not this checkout's memory of the last one: a
  // repository nobody has fetched for a week would otherwise start the Run on a stale
  // base and merge the month's updates onto it.
  const fetched = yield* run("git", ["fetch", "--quiet", "origin"], opts.repo);
  if (
    fetched.code !== 0 &&
    (yield* run("git", ["remote", "get-url", "origin"], opts.repo)).code === 0
  ) {
    return { refused: `could not fetch origin: ${whatItSaid(fetched) || "git fetch failed"}` };
  }
  const base = yield* defaultStart(opts.repo, run);

  // Each slot left as it is, and why: Collie never stashes, commits, resets or deletes one.
  const passed: Array<{ at: string; kept: string }> = [];
  for (const { at, taken, recorded } of seen) {
    if (taken === null) {
      const added = yield* run("git", ["worktree", "add", "--detach", at, base], opts.repo);
      if (added.code !== 0) {
        return { refused: whatItSaid(added) || `git would not add a worktree at ${at}` };
      }
      return { path: at, base, passed };
    }
    const held = occupiedAs(taken.owner, recorded);
    const pass = (why: string) => passed.push({ at, kept: `${held}, kept: ${why}` });
    if (taken.owner !== null && taken.owner !== opts.repo) pass("another clone's");
    else if (recorded === null) pass("recorded by no Run");
    else if (taken.owner === null || !listed.has(at)) pass("not one git lists");
    else if (!(yield* isTheOneMade(at, recorded.worktree))) pass("not the checkout that Run made");
    else {
      // After the fetch, which can prune or rewrite the only ref a commit was on.
      const before = yield* wouldLose(run, at);
      if (before !== null && "unread" in before)
        return { refused: `${at} is ${held}: ${before.unread}` };
      if (before !== null) {
        pass(before.lost);
        continue;
      }
      const released = yield* recorded.release;
      if (released !== null) return { refused: `${at} is ${held}: ${released}` };
      // Again, now its agents are closed: one could have written to it until then. Past
      // release a slot is refused, never passed over.
      const after = yield* wouldLose(run, at);
      if (after !== null) {
        return {
          refused: `${at} is ${held}${"lost" in after ? `, kept: ${after.lost}` : `: ${after.unread}`}`,
        };
      }
      const moved = yield* run(
        "git",
        ["checkout", "--quiet", "--no-overwrite-ignore", "--detach", base],
        at,
      );
      if (moved.code !== 0) {
        return {
          refused: `${at} is ${held}: ${whatItSaid(moved) || `git would not move it to ${base}`}`,
        };
      }
      return { path: at, base, from: recorded.run, passed };
    }
  }
  return {
    refused: Arr.join(
      Arr.map(passed, (one) => `${one.at} is ${one.kept}`),
      "; ",
    ),
  };
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
 * Why a Run may not work in another's checkout `cwd` instead of cutting one of `branch`
 * at `base`, or null.
 */
const whyNotWorkIn = Effect.fn("worktree.whyNotWorkIn")(function* (
  herdr: Herdr,
  cwd: string,
  branch: string,
  base: { readonly ref: string; readonly in: string },
) {
  const status = yield* shell("git", ["status", "--porcelain"], cwd);
  if (status.code !== 0) return "git could not read it";
  if (Str.trim(status.stdout) !== "") return "it has uncommitted changes";
  const head = yield* shell("git", ["rev-parse", "HEAD"], cwd);
  if (head.code !== 0) return "git could not read it";
  const hasOrigin = (yield* shell("git", ["remote", "get-url", "origin"], base.in)).code === 0;
  // The remote's head now, whatever this repository last fetched or holds locally.
  const remote = hasOrigin
    ? yield* shell("git", ["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`], base.in)
    : null;
  // Exit 2 is a remote without the branch: then, as with no remote, the work is only `base`.
  if (remote !== null && remote.code !== 0 && remote.code !== 2)
    return `origin would not say where ${branch} is`;
  const wanted =
    remote?.code === 0
      ? { at: Str.split(remote.stdout, "\t")[0], name: `${branch}'s head on origin` }
      : {
          at: Str.trim(
            (yield* shell("git", ["rev-parse", `${base.ref}^{commit}`], base.in)).stdout,
          ),
          name: base.ref,
        };
  if (Str.trim(head.stdout) !== wanted.at) return `it is not at ${wanted.name}`;
  const agents = yield* Effect.result(herdr.agentList());
  if (agents._tag === "Failure") return "core would not say which agents work in it";
  for (const agent of agents.success) {
    if (isSettled(agent.status)) continue;
    if (worksIn(agent, cwd)) return `agent ${agent.name} is ${agent.status} in it`;
  }
  return null;
});

const withDependencies = Effect.fn("worktree.withDependencies")(function* (checkout: Checkout) {
  const installed = yield* installDependencies(shell, checkout.cwd);
  if (installed.refused !== undefined) return { ...checkout, refused: installed.refused };
  if (installed.ran === null) return checkout;
  return {
    ...checkout,
    note: Arr.join(
      [checkout.note, `brought its dependencies to its head with ${installed.ran}`],
      "; ",
    ),
  };
});

/**
 * Where this Run works. A Workflow that changes the repository owns its branch's
 * checkout; every other Workflow works in the directory it was started from.
 *
 * The Run stays in its Task's workspace, and only its cwd moves: the work surrounding a
 * task is encapsulated in its workspace, and a checkout of its own is about not sharing
 * an index, not about being somewhere else in the sidebar.
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
    const repository = repositoryOf(opts)?.value ?? "";
    let from = repository || opts.cwd;
    const project = remoteRepository(repository)
      ? (Option.getOrUndefined(
          Option.map(
            Option.fromNullishOr(projectFromRemote(repository)),
            (present___________) => Str.split(present___________, "/-/")[0],
          ),
        ) ?? null)
      : null;
    if (project !== null) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      from = path.join(opts.stateDir, "renovate-repositories", Bun.hash(repository).toString(16));
      const host = Str.split(project, "/")[0]!;
      const forge = forgeOfHost(host, opts.gitlabHost);
      if (forge === null) return { ...here, refused: `${host} is neither GitHub nor GitLab` };
      if (!(yield* fs.exists(path.join(from, ".git")))) {
        yield* fs.makeDirectory(path.dirname(from), { recursive: true });
        const cloned = yield* FORGES[forge].clone(project, from, opts.stateDir, shell);
        if (!cloned.ok) {
          return { ...here, refused: `could not clone ${repository}: ${cloned.reason}` };
        }
      }
      // Every use, so a clone made before the helper existed gets it too.
      const kept = yield* FORGES[forge].credentials(project, from, shell);
      if (!kept.ok)
        return { ...here, refused: `could not keep credentials for ${repository}: ${kept.reason}` };
    }
    const made = yield* roamingCheckout({
      cwd: from,
      worktrees: yield* worktreesDirectory(herdr.env),
      stateDir: opts.stateDir,
      recordedBy: opts.recordedBy,
      claimed: opts.claimed,
      run: shell,
    });
    if (made.refused !== undefined) {
      return { ...here, refused: `no worktree for ${from}: ${made.refused}` };
    }
    const { worktree } = made;
    return yield* withDependencies({
      ...here,
      cwd: worktree.path,
      worktree,
      note: Arr.join(
        [
          ...Arr.map(made.passed, (one) => `passed over ${one.at}: ${one.kept}`),
          made.from === undefined
            ? `created worktree ${worktree.path} detached at ${made.base}`
            : `took worktree ${worktree.path} over from Run ${made.from}, detached at ${made.base}`,
        ],
        "; ",
      ),
    });
  }

  const plan = yield* branchFor(opts);
  if (plan.refused) return { ...here, refused: plan.refused } satisfies Checkout;
  if (opts.branchBase !== undefined) {
    const local = yield* shell(
      "git",
      ["rev-parse", "--verify", "--quiet", `refs/heads/${plan.branch}`],
      opts.cwd,
    );
    if (local.code === 0 && Str.trim(local.stdout) !== opts.branchBase)
      return {
        ...here,
        refused: `Local branch ${plan.branch} differs from the fetched revision; preserve or move it before starting remotely.`,
      };
    const trees = yield* gitWorktrees(shell, opts.cwd);
    const existing = Option.getOrUndefined(
      Option.map(Option.fromNullishOr(trees), (present) =>
        Option.getOrUndefined(
          Arr.findFirst(present.checkouts, (one) => one.branch === plan.branch),
        ),
      ),
    );
    if (existing !== undefined) {
      const dirty = yield* shell("git", ["status", "--porcelain"], existing.path);
      if (dirty.code !== 0 || Str.trim(dirty.stdout) !== "")
        return {
          ...here,
          refused: `The checkout of ${plan.branch} has local changes; preserve them before starting remotely.`,
        };
    }
    plan.base = opts.branchBase;
  }
  here.branch = plan.branch;
  here.task = plan.task;
  here.branchSource = plan.source;

  let notTaken = "";
  if (opts.starting !== undefined) {
    const { run, cwd } = opts.starting;
    const why = yield* whyNotWorkIn(herdr, cwd, plan.branch, { ref: plan.base, in: opts.cwd });
    const whose = `${cwd}, Run ${run}'s checkout`;
    if (why === null)
      return yield* withDependencies({
        ...here,
        cwd,
        note: `working in ${whose}: it is clean, at ${plan.branch}'s head, and no agent is working in it`,
      });
    notTaken = `not working in ${whose}: ${why}; `;
  }

  // Whichever manager was asked, a Run with nowhere of its own to work says so the
  // same way, naming the branch it could not be given a checkout for.
  const refuse = (why: string) =>
    ({ ...here, refused: `no worktree for ${plan.branch}: ${why}` }) satisfies Checkout;

  const newOn = yield* newOnOrigin(plan.branch, opts.cwd);
  const made = yield* gitCheckout({
    cwd: opts.cwd,
    branch: plan.branch,
    base: plan.base,
    worktrees: yield* worktreesDirectory(herdr.env),
    stateDir: opts.stateDir,
    recordedBy: opts.recordedBy,
    run: shell,
  });
  if (made.refused !== undefined) return refuse(made.refused);
  const worktree = {
    path: made.path,
    branch: plan.branch,
    managed_by: "git",
    workspace_id: null,
    created_by_collie: made.created,
    created_branch: made.created && newOn !== null,
    created_on: made.created ? newOn : null,
    made_at: yield* madeAt(made.path),
    // A git checkout opens no workspace, so there is no shell tab of its own to take
    // over — the Run stays where it was started and uses that tab as it always did.
    root_tab_id: null,
    root_pane_id: null,
  } satisfies WorktreeRecord;
  return yield* withDependencies({
    ...here,
    cwd: worktree.path,
    worktree,
    note: `${notTaken}${made.created ? "created" : "reused"} worktree ${worktree.path} on ${plan.branch}${
      made.passed.length === 0 ? "" : `, passing over ${Arr.join(made.passed, "; ")}`
    }`,
  });
});

/**
 * Why `checkoutFor` would refuse a git branch checkout for `opts` now, in the same words,
 * or null where it would not; cuts and records nothing.
 */
export const checkoutRefusal = Effect.fn("worktree.checkoutRefusal")(function* (
  herdr: Herdr,
  opts: BranchAsk & Pick<CheckoutAsk, "recordedBy" | "starting">,
) {
  const path = yield* Path.Path;
  const plan = yield* branchFor(opts);
  if (plan.refused) return plan.refused;
  if (
    opts.starting !== undefined &&
    (yield* whyNotWorkIn(herdr, opts.starting.cwd, plan.branch, {
      ref: plan.base,
      in: opts.cwd,
    })) === null
  )
    return null;
  const listing = yield* gitWorktrees(shell, opts.cwd);
  if (!listing) return `no worktree for ${plan.branch}: ${opts.cwd} is not a git checkout`;
  if (Arr.some(listing.checkouts, (checkout) => checkout.branch === plan.branch)) return null;
  const first = path.join(
    yield* worktreesDirectory(herdr.env),
    path.basename(listing.repo),
    ...branchPath(plan.branch),
  );
  const slot = yield* freeSlot({ ...opts, repo: listing.repo, first, listing });
  return slot.at === null ? `no worktree for ${plan.branch}: ${slot.refused}` : null;
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
export const PRUNE_FILE = "worktrees.json";

const PruneEntry = Schema.Struct({
  checked_at: Schema.Finite,
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

/** Why a checkout's work has landed, and the heads its merge requests were merged at. */
export interface Landed {
  readonly why: string;
  readonly heads: ReadonlyArray<string>;
}

/**
 * What the settled rule reads that is not the checkout itself, gathered by the host's sweep:
 * the merge watch's answers and the Dispositions, by checkout and by branch, and whether
 * the Task a checkout belongs to still has its workspace open.
 */
export interface Settling {
  readonly owedAt: ReadonlySet<string>;
  readonly owedOn: ReadonlySet<string>;
  readonly landedAt: ReadonlyMap<string, Landed>;
  /** By `onBranch`: a branch name means nothing outside its repository. */
  readonly landedOn: ReadonlyMap<string, Landed>;
  /** By `onBranch`, a branch whose merge request the merge watch last read as open. */
  readonly openOn: ReadonlyMap<string, string>;
  /** Why a checkout's Task still holds it: it is open, or still owes work. */
  readonly taskHolds: ReadonlyMap<string, string>;
  /** Checkouts never to remove: the plugin root and any a running host serves from. */
  readonly protect: ReadonlySet<string>;
}

/** A branch of the project a Run was started for, as `Settling` keys one. */
export const onBranch = (project: string, branch: string) => `${project}\n${branch}`;

export const NOTHING_SETTLING: Settling = {
  owedAt: new Set(),
  owedOn: new Set(),
  landedAt: new Map(),
  landedOn: new Map(),
  openOn: new Map(),
  taskHolds: new Map(),
  protect: new Set(),
};

/** Everything holding a checkout right now, and the agents core has, which a removal ends. */
interface InUse {
  paths: ReadonlyMap<string, string>;
  agents: ReadonlyArray<AgentInfo>;
}

/** Whether this agent was started in `dir` or has moved into it since. */
const worksIn = (agent: AgentInfo, dir: string) =>
  inside(dir, agent.cwd) || inside(dir, agent.foregroundCwd);

/**
 * Everything holding a checkout right now: the Runs and agents core knows about, and the
 * checkout a Run is starting in. Null where core would not say.
 */
const inUse = Effect.fn("worktree.inUse")(function* (
  herdr: Herdr,
  opts: {
    /** Where agents' control records are, whose servers may outlive their terminals. */
    stateDir: string;
    paths: ReadonlyMap<string, string>;
    keep?: string | undefined;
    /** The terminals finished Runs' agents were left in, which hold nothing unless still working. */
    leftovers: ReadonlySet<string>;
  },
) {
  const agents = yield* Effect.result(herdr.agentList());
  if (agents._tag === "Failure") return null;
  const paths = new Map(opts.paths);
  for (const agent of agents.success) {
    // A Run's own agent, idle where it was left, is what the removal ends — counting it
    // as work in progress kept every finished Run's checkout forever.
    if (opts.leftovers.has(agent.paneId) && agent.status !== "working") continue;
    // Both directories: an agent started in the repository and `cd`-ed into a checkout
    // is working in the checkout.
    for (const dir of [agent.cwd, agent.foregroundCwd]) {
      if (dir) paths.set(dir, "an agent is working in it");
    }
  }
  const servers = yield* unlistedServers(opts.stateDir, [herdr]);
  if (servers === null) return null;
  for (const record of servers)
    paths.set(record.cwd, `${record.agent}'s server may still be writing in it`);
  if (opts.keep && !paths.has(opts.keep)) paths.set(opts.keep, "a run is starting in it");
  return { paths, agents: agents.success } satisfies InUse;
});

/** Whether this directory is the checkout at `at`, or somewhere inside it. */
const inside = (at: string, dir: string | null | undefined) =>
  dir !== null && dir !== undefined && (dir === at || pipe_(dir, Str.startsWith(`${at}/`)));

/**
 * Ends the agents a removed checkout's finished Runs left in it, which nothing else would
 * ever end. Only an agent still registered to that Run, and still in the checkout.
 *
 * Answers with how many would not end. This is the only chance: the checkout is no longer
 * listed, so no later sweep will come back to retry.
 */
const endLeftovers = Effect.fn("worktree.endLeftovers")(function* (
  herdr: Herdr,
  opts: {
    at: string;
    leftovers: ReadonlySet<string>;
    agents: ReadonlyArray<AgentInfo>;
    stateDir: string;
    ports: CompactionPorts;
    registered: ReadonlyArray<AgentEntry>;
  },
) {
  const why = `its checkout ${opts.at} was removed`;
  let left = 0;
  for (const agent of opts.agents) {
    if (!opts.leftovers.has(agent.paneId) || !worksIn(agent, opts.at)) continue;
    const entry = Option.getOrUndefined(
      Arr.findFirst(
        opts.registered,
        (one) => one.paneId === agent.paneId && one.agent === agent.name,
      ),
    );
    if (entry === undefined) continue;
    const launched = Option.getOrUndefined(
      Arr.findLast(yield* readLaunches(entry.runId), (one) => one.agent === entry.agent),
    );
    const ended = yield* endAgent(
      {
        herdr,
        ports: opts.ports,
        stateDir: opts.stateDir,
        log: runLog(opts.stateDir, entry.runId),
      },
      launched ?? { agent: entry.agent },
      why,
      "caller",
      opts.agents,
    ).pipe(Effect.orElseSucceed(() => null));
    // Proved this Run's incarnation and quiet, but "caller" leaves its terminal to this.
    const killed =
      ended?._tag === "Closed" &&
      (yield* herdr.terminalKill(agent.paneId).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ));
    if (!killed) left += 1;
    else yield* runLog(opts.stateDir, entry.runId)(endedLine(entry.agent, why)).pipe(Effect.ignore);
  }
  return left;
});

/** Why this checkout is in use, or null when nothing holds it. */
function heldBy(use: InUse, worktree: { path: string }): string | null {
  for (const [dir, why] of use.paths) {
    if (inside(worktree.path, dir)) return why;
  }
  return null;
}

/** What to do about a checkout: keep it for this reason, or remove it for that one. */
type Verdict = { keep: string; why?: undefined } | { keep?: undefined; why: string };

const keepIt = (keep: string): Verdict => ({ keep });
const settledBecause = (why: string): Verdict => ({ why });

const settled = Effect.fn("worktree.settled")(function* (
  worktree: Listed & { branch: string },
  opts: {
    /** The repository's own checkout, which outlives the removal of any other. */
    repo: string;
    use: InUse;
    run: Runner<ChildProcessSpawner.ChildProcessSpawner>;
    settling: Settling;
    /** The project the Run that made this checkout was started for. */
    project: string;
  },
) {
  const { run, settling } = opts;
  if (
    settling.owedAt.has(worktree.path) ||
    settling.owedOn.has(onBranch(opts.project, worktree.branch))
  )
    return keepIt("its Task still owes work");
  const dirty = yield* run("git", ["status", "--porcelain"], worktree.path);
  if (dirty.code !== 0) return keepIt("could not read the working tree");
  if (Str.trim(dirty.stdout) !== "") return keepIt("uncommitted changes");

  const landed =
    settling.landedAt.get(worktree.path) ??
    settling.landedOn.get(onBranch(opts.project, worktree.branch));
  const upstream = yield* upstreamRemote(worktree, run);
  const unpushed = yield* unpushedWork(worktree, run, upstream, landed?.heads ?? []);
  if (unpushed) return unpushed;

  const held = heldBy(opts.use, worktree);
  if (held) return keepIt(held);

  // A roaming checkout has no branch to ask a merge request or the remote about: it
  // holds nothing of its own once it is clean and nothing is working in it, because
  // everything it did was pushed to the Renovate branches it moved across.
  const settledBy = worktree.branch === "" ? null : yield* landedBy(worktree, landed, opts);
  if (settledBy !== null && settledBy.keep !== undefined) return settledBy;
  // Last: a checkout is never removed from under its open Task.
  const task = settling.taskHolds.get(worktree.path);
  if (task !== undefined) return keepIt(task);
  return settledBy ?? settledBecause("its Run is over and it holds nothing");
});

/**
 * Whether a branch's work has landed: the merge watch read its merge request as merged or
 * closed, on GitHub or GitLab, or a Disposition says so. With neither, the remote branch is
 * the question: gone means whatever it held is merged or abandoned on purpose.
 */
const landedBy = Effect.fn("worktree.landedBy")(function* (
  worktree: { path: string; branch: string },
  landed: Landed | undefined,
  opts: {
    repo: string;
    run: Runner<ChildProcessSpawner.ChildProcessSpawner>;
    settling: Settling;
    project: string;
  },
) {
  if (opts.settling.owedOn.has(onBranch(opts.project, worktree.branch)))
    return keepIt("its Task still owes work");
  if (landed !== undefined) return settledBecause(landed.why);
  const open = opts.settling.openOn.get(onBranch(opts.project, worktree.branch));
  if (open !== undefined) return keepIt(`${open} is still open`);
  const upstream = yield* upstreamRemote(worktree, opts.run);
  const remotes =
    upstream !== null
      ? [upstream]
      : Arr.filter(
          Arr.map(Str.split((yield* opts.run("git", ["remote"], opts.repo)).stdout, "\n"), (line) =>
            Str.trim(line),
          ),
          (line) => line !== "",
        );
  if (remotes.length === 0) return keepIt("no remote to compare against");
  for (const remote of remotes) {
    const heads = yield* opts.run(
      "git",
      ["ls-remote", "--heads", remote, worktree.branch],
      opts.repo,
    );
    if (heads.code !== 0) return keepIt("could not reach the remote");
    if (Str.trim(heads.stdout) !== "") return keepIt("still on the remote");
  }
  return settledBecause("its remote branch is gone");
});

/** The remote this checkout's branch tracks, or null where it tracks none. */
const upstreamRemote = Effect.fn("worktree.upstreamRemote")(function* (
  worktree: { path: string },
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
) {
  const upstream = yield* run(
    "git",
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
    worktree.path,
  );
  const name = upstream.code === 0 ? Str.trim(upstream.stdout) : "";
  return name === "" ? null : (Str.split(name, "/")[0] ?? null);
});

/** How many lines a `rev-list` answered with; each one is a commit. */
function commits(result: { stdout: string }): number {
  return Arr.filter(Str.split(result.stdout, "\n"), (line) => Str.trim(line) !== "").length;
}

/**
 * Why this checkout may not go for the commits it holds, or null when it holds none of its
 * own: every commit is in a remote-tracking ref — of its upstream's remote, or of any remote
 * where it tracks none — or HEAD is the head its merged merge request was merged at, which
 * is all a squash merge leaves to go by. A branch merged and deleted keeps its commits in the
 * default branch's ref after `git fetch --prune` takes its own.
 */
const unpushedWork = Effect.fn("worktree.unpushedWork")(function* (
  worktree: { path: string },
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
  upstream: string | null,
  mergedHeads: ReadonlyArray<string>,
) {
  const remotes = upstream === null ? "--remotes" : `--remotes=${upstream}`;
  const unique = yield* run("git", ["rev-list", "HEAD", "--not", remotes], worktree.path);
  if (unique.code !== 0) return keepIt("could not read what is unpushed");
  const count = commits(unique);
  if (count === 0) return null;
  if (mergedHeads.length > 0) {
    const head = yield* run("git", ["rev-parse", "HEAD"], worktree.path);
    if (head.code === 0 && mergedHeads.includes(Str.trim(head.stdout))) return null;
  }
  return keepIt(`${count} commit(s) on no remote`);
});

const REVIEWING = "reviewing-";

/** Where a review pins a merge request's head: detached, Collie's, and re-pinned each round. */
export const reviewingDir = (runId: string) => `${REVIEWING}${runId}`;

/**
 * What the Runs say about the worktrees of this machine: the ones Collie made, by path,
 * and the ones a Run is still working in. A checkout a human made appears in no Run, so
 * it is never a candidate for removal.
 */
function fromRuns(
  runs: ReadonlyArray<RunFacts>,
  registered: ReadonlyArray<AgentEntry>,
  settling: Settling,
  /** Runs a check is still running for, whatever their state. */
  checking: ReadonlySet<string>,
) {
  const mine = new Map<string, WorktreeRecord>();
  /** The project each checkout's Run was started for. */
  const projects = new Map<string, string>();
  const paths = new Map<string, string>();
  /** The panes each checkout's finished Runs left their agents in. */
  const panes = new Map<string, Set<string>>();
  // The next roaming start takes a failed Run's roaming checkout over, so the sweep may too.
  const roaming = Arr.flatMap(runs, ({ worktree }) =>
    worktree?.created_by_collie && worktree.branch === "" ? [worktree.path] : [],
  );
  for (const run of runs) {
    const going = run.state === "running" || run.state === "waiting";
    const worktree = run.worktree?.created_by_collie ? run.worktree : null;
    const at =
      worktree?.path ??
      Option.getOrUndefined(Arr.findFirst(roaming, (path) => inside(path, run.cwd)));
    // A stopped or failed Run can be resumed in its checkout, until its work lands anyway.
    const landed =
      (run.worktree !== null && settling.landedAt.has(run.worktree.path)) ||
      settling.landedOn.has(onBranch(run.project, run.branch ?? run.worktree?.branch ?? ""));
    const resumable =
      (run.state === "stopped" || (run.state === "failed" && !roaming.includes(at ?? ""))) &&
      !landed;
    if (going) paths.set(run.cwd, "a run is still working in it");
    else if (checking.has(run.id)) paths.set(run.cwd, "its check is still running in it");
    else if (resumable) paths.set(run.cwd, `a ${run.state} run can resume in it`);
    if (worktree !== null) {
      mine.set(worktree.path, worktree);
      projects.set(worktree.path, run.project);
    }
    // A Run that may still go keeps its checkout anyway, so its agents are nobody's leftovers.
    if (at === undefined || going || resumable || checking.has(run.id)) continue;
    const left = panes.get(at) ?? new Set<string>();
    for (const entry of registered) if (entry.runId === run.id) left.add(entry.paneId);
    panes.set(at, left);
  }
  return { mine, paths, panes, projects };
}

/**
 * Removes the worktrees this repository has that are settled, and reports what it did
 * and what it is holding — one line each, so nothing is silent. The host's sweep runs
 * it, with each worktree's verdict standing for a few minutes so a sweep does not shell
 * out to git and glab for every checkout every time.
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
  /** Judge only this checkout, now, whatever its last verdict said. */
  only?: string;
  /** Judge without removing; what is kept is still written down for the board. */
  dryRun?: boolean;
  settling?: Settling;
  ports?: CompactionPorts;
}

/** One checkout's verdict: kept for `keep`, settled because of `why`, and whether it went. */
export interface Judged {
  path: string;
  keep?: string;
  why?: string;
  removed: boolean;
}

/** One repository's round: what herdr lists for it, against what the Runs recorded. */
const prune = Effect.fn("worktree.prune")(function* (
  opts: PruneOptions & {
    recorded: ReturnType<typeof fromRuns>;
    listing: { worktrees: ReadonlyArray<Listed>; source: string } | null;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const run = opts.run ?? shell;
  const now = opts.now ?? (yield* Clock.currentTimeMillis);
  const statePath = path.join(opts.stateDir, PRUNE_FILE);
  // What a board line calls a checkout: the branch it is for. Not the last part of its
  // path — a branch with a `/` in it nests, so `feature/foo` would read as "foo". A
  // roaming checkout has no branch, so its own directory is the only name it has.
  const nameOf = (worktree: { path: string; branch: string }) =>
    worktree.branch || path.basename(worktree.path);
  const state = yield* fs.readFileString(statePath).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(PruneStateJson)),
    Effect.orElseSucceed((): PruneState => ({})),
  );
  const before = `${yield* Schema.encodeEffect(PruneStateJson)(state).pipe(Effect.orDie)}\n`;

  const { mine, paths, panes, projects } = opts.recorded;
  const settling = opts.settling ?? NOTHING_SETTLING;
  const listing = opts.listing;
  // Path, branch and the moment git wrote the checkout, all from the record that made
  // it: a Collie worktree removed by hand and a human's worktree later made at the
  // same path on the same branch would otherwise be the same candidate, and a
  // hand-made checkout is never touched.
  const candidates: Array<Listed & { branch: string }> = [];
  for (const worktree of listing?.worktrees ?? []) {
    if (opts.only !== undefined && worktree.path !== opts.only) continue;
    // A detached checkout has no branch, which git reports as null; the record of a
    // roaming Run's checkout is empty for the same reason. Matching them
    // is what lets a Renovate Run's checkout be pruned like any other.
    const branch = worktree.branch ?? "";
    const record = mine.get(worktree.path);
    // Its branch may have been switched since: still Collie's checkout, judged as it is now.
    if (!record || record.made_at === null) continue;
    if (settling.protect.has(worktree.path)) continue;
    // A repository's main checkout is never one Collie made, whatever a record says.
    const git = yield* fs.stat(path.join(worktree.path, ".git")).pipe(Effect.option);
    if (Option.isSome(git) && git.value.type === "Directory") continue;
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
  for (const [known, entry] of Rec.toEntries(state)) {
    if (entry.repo !== repo || opts.only !== undefined) continue;
    if (Arr.some(candidates, (worktree) => worktree.path === known)) continue;
    if (!entry.removed || now - entry.checked_at > REPORT_MS) delete state[known];
  }

  const fresh = opts.dryRun === true || opts.only !== undefined;
  const due = Arr.filter(candidates, (worktree) => {
    const entry = state[worktree.path];
    return fresh || !entry || entry.removed || now - entry.checked_at >= RECHECK_MS;
  });
  const judged: Judged[] = [];
  if (due.length === 0) return { lines: yield* conclude(round), judged };

  // A core that will not answer is not proof that nothing is live in these checkouts,
  // and that is the one condition nothing else can establish — so nothing is judged
  // this round rather than judged on an empty list. The board still hears about every
  // candidate being held, and nothing is written down: an unverified round is not a
  // verdict, so the next refresh asks again rather than waiting out the debounce.
  const leftovers = new Set(Arr.flatMap([...panes.values()], (left) => [...left]));
  const use = yield* inUse(opts.herdr, {
    stateDir: opts.stateDir,
    paths,
    keep: opts.keep,
    leftovers,
  });
  if (!use) {
    const standing = yield* conclude(round);
    const unknown = "could not ask core what is live";
    return {
      lines: [...standing, ...Arr.map(due, (worktree) => `kept ${nameOf(worktree)} · ${unknown}`)],
      judged: Arr.map(due, (worktree) => ({ path: worktree.path, keep: unknown, removed: false })),
    };
  }

  for (const worktree of due) {
    const name = nameOf(worktree);
    const verdict = yield* settled(worktree, {
      repo,
      use,
      run,
      settling,
      project: projects.get(worktree.path) ?? "",
    });
    if (opts.dryRun === true && verdict.keep === undefined) {
      judged.push({ path: worktree.path, why: verdict.why, removed: false });
      continue;
    }
    // Whoever made the checkout takes it away again. Then the branch itself, with
    // `-d`: git refuses an unmerged one, which is the guard.
    const outcome =
      verdict.keep === undefined
        ? yield* removeWorktree(opts.herdr, worktree, {
            name,
            why: verdict.why,
            repo,
            run,
            leftovers: panes.get(worktree.path) ?? new Set(),
            agents: use.agents,
            stateDir: opts.stateDir,
            ports: opts.ports ?? COMPACTION_PORTS,
            registered: opts.registered,
          })
        : { line: `kept ${name} · ${verdict.keep}`, removed: false };
    state[worktree.path] = { checked_at: now, repo, ...outcome };
    judged.push({
      path: worktree.path,
      removed: outcome.removed,
      ...(verdict.keep !== undefined
        ? { keep: verdict.keep }
        : outcome.removed
          ? { why: verdict.why }
          : { keep: pipe_(outcome.line, Str.replace(/^kept [^·]* · /, "")) }),
    });
  }

  return { lines: yield* conclude(round), judged };
});

/**
 * How every round ends, whether it judged anything or not: what moved is written down,
 * and what the board should say is answered. Only when something actually moved:
 * rewriting the same bytes every sweep is a disk write nobody asked for.
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
  const encoded = `${yield* Schema.encodeEffect(PruneStateJson)(opts.state).pipe(Effect.orDie)}\n`;
  if (encoded !== opts.before) {
    yield* (yield* FileSystem.FileSystem).writeFileString(opts.statePath, encoded);
  }
  return reported(opts.state, opts.now, opts.repo);
});

/**
 * What is worth putting on a board: everything held, and a removal while it is still
 * news. Only `repo`'s, where one is named.
 */
function reported(state: PruneState, now: number, repo?: string): string[] {
  return Arr.map(
    Arr.filter(
      Rec.values(state),
      (entry) =>
        (repo === undefined || entry.repo === repo) &&
        (!entry.removed || now - entry.checked_at <= REPORT_MS),
    ),
    (entry) => entry.line,
  );
}

/** One line about a removal, and whether the checkout actually went. */
interface Removal {
  line: string;
  removed: boolean;
}

/** Removes one checkout and its branch, and says what happened to each. */
const removeWorktree = Effect.fn("worktree.removeWorktree")(function* (
  herdr: Herdr,
  worktree: Listed & { branch: string },
  opts: {
    name: string;
    /** Why it was settled, which is what the removal line says. */
    why: string;
    /** The repository's own checkout: this one is about to stop existing. */
    repo: string;
    run: Runner<ChildProcessSpawner.ChildProcessSpawner>;
    /** The terminals its finished Runs' agents were left in, ended with the checkout. */
    leftovers: ReadonlySet<string>;
    agents: ReadonlyArray<AgentInfo>;
    stateDir: string;
    ports: CompactionPorts;
    registered: ReadonlyArray<AgentEntry>;
  },
) {
  const kept = (why: string): Removal => ({ line: `kept ${opts.name} · ${why}`, removed: false });
  // Never `--force`: git's own refusal is the guard. A checkout herdr made once is a git
  // worktree like any other.
  const dropped = yield* opts.run("git", ["worktree", "remove", worktree.path], opts.repo);
  if (dropped.code !== 0) return kept(whatItSaid(dropped) || "git would not remove it");

  const running = yield* endLeftovers(herdr, {
    at: worktree.path,
    leftovers: opts.leftovers,
    agents: opts.agents,
    stateDir: opts.stateDir,
    ports: opts.ports,
    registered: opts.registered,
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
      : `branch ${worktree.branch} kept: ${whatItSaid(deleted) || "git would not delete it"}`;
  // Said on the same line, for the same reason the kept branch is: this checkout will
  // not be a candidate again, so anything that did not go with it is reported here or
  // it is never reported.
  const agents = running === 0 ? "" : ` · ${running} agent(s) left running`;
  return { line: `♻ removed ${opts.name} · ${why}${agents}`, removed: true } satisfies Removal;
});

/**
 * Removes what is settled and answers with what it did — never with a failure: the host's
 * sweep has no use for a state file that would not read, and would not stop for one.
 *
 * One pruner at a time, under the same pid lock the run records use. Two pruners
 * at once would otherwise read the same verdicts, decide separately and write over
 * each other, and could ask git to remove one checkout twice. A contended lock means
 * somebody else is already doing this, so there is nothing to say and nothing to wait
 * for.
 */
export const pruneWorktrees = (opts: PruneOptions) =>
  judgeWorktrees(opts).pipe(Effect.map((round) => round.lines));

/**
 * Every checkout's verdict, with what was removed: `dryRun` removes nothing, and `only`
 * judges and removes that one checkout. Null when another pruner holds the lock.
 */
export const judgeWorktrees = (opts: PruneOptions) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const lock = path.join(opts.stateDir, `${PRUNE_FILE}.lock`);
    return yield* withLock(lock, Effect.succeed(null), sweep(opts));
  }).pipe(
    Effect.orElseSucceed(() => null),
    Effect.map((round) => round ?? { lines: [], judged: [], busy: true }),
  );

/** What the host's sweeps last said, for a board to show without sweeping itself. */
export const reportedWorktrees = Effect.fn("worktree.reportedWorktrees")(function* (
  stateDir: string,
) {
  const path = yield* Path.Path;
  const state = yield* (yield* FileSystem.FileSystem)
    .readFileString(path.join(stateDir, PRUNE_FILE))
    .pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(PruneStateJson)),
      Effect.orElseSucceed((): PruneState => ({})),
    );
  return reported(state, yield* Clock.currentTimeMillis);
});

/**
 * Every repository the recorded checkouts belong to, each asked from one of its own
 * checkouts. The board's cwd alone was not enough: the Home is no repository, so its
 * sweep listed nothing, and a Renovate checkout under a repository nobody has a
 * workspace in was never anyone's candidate.
 */
const sweep = Effect.fn("worktree.sweep")(function* (opts: PruneOptions) {
  const fs = yield* FileSystem.FileSystem;
  const checking = new Set(Arr.map(yield* runningChecks, (record) => record.run));
  const recorded = fromRuns(
    opts.runs,
    opts.registered,
    opts.settling ?? NOTHING_SETTLING,
    checking,
  );
  const lines: string[] = [];
  const judged: Judged[] = [];
  const listed = new Set<string>();
  // One `git worktree list` per live checkout, every sweep. Cheap while checkouts are few.
  for (const cwd of new Set([opts.cwd, ...recorded.mine.keys()])) {
    const own = cwd === opts.cwd;
    // A checkout an earlier listing named is in a repository already swept.
    if (!own && (listed.has(cwd) || !(yield* fs.exists(cwd)))) continue;
    const found = yield* gitWorktrees(opts.run ?? shell, cwd).pipe(
      Effect.orElseSucceed(() => null),
    );
    const listing = found === null ? null : { worktrees: found.checkouts, source: found.repo };
    if (!own && (listing === null || Arr.every(listing.worktrees, (w) => listed.has(w.path))))
      continue;
    for (const worktree of listing?.worktrees ?? []) listed.add(worktree.path);
    const round = yield* prune({ ...opts, cwd, recorded, listing });
    lines.push(...round.lines);
    judged.push(...round.judged);
  }
  return { lines, judged, busy: false };
});

/**
 * A Run's own checkout of a merge request's `head`: detached, Collie's, and forced there each
 * round, from the ref the forge keeps for the merge request rather than a bare sha, which a
 * fork's merge request does not have on origin. `moved` is the head that ref has instead.
 */
export const pinnedCheckout = Effect.fn("worktree.pinnedCheckout")(function* (opts: {
  readonly repo: string;
  readonly worktrees: string;
  readonly runId: string;
  readonly forge: "gitlab" | "github";
  readonly project: string | null;
  readonly iid: string;
  readonly head: string;
  readonly run: Runner<ChildProcessSpawner.ChildProcessSpawner>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { run } = opts;
  const listing = yield* gitWorktrees(run, opts.repo);
  if (!listing) return { refused: `${opts.repo} is not a git checkout` };
  const kept =
    opts.forge === "gitlab" ? `merge-requests/${opts.iid}/head` : `pull/${opts.iid}/head`;
  let remote = "origin";
  for (const candidate of ["origin", "upstream"]) {
    const urls = yield* Effect.all([
      run("git", ["remote", "get-url", candidate], listing.repo),
      run("git", ["config", "--get", `remote.${candidate}.url`], listing.repo),
    ]);
    if (
      opts.project !== null &&
      Arr.some(urls, (url) => url.code === 0 && projectFromRemote(url.stdout) === opts.project)
    ) {
      remote = candidate;
      break;
    }
  }
  const tracking = `refs/remotes/${remote}/${kept}`;
  const fetched = yield* run(
    "git",
    ["fetch", "--quiet", remote, `+refs/${kept}:${tracking}`],
    listing.repo,
  );
  if (fetched.code !== 0)
    return { refused: `could not fetch ${kept} from ${remote}: ${whatItSaid(fetched)}` };
  const at = yield* run("git", ["rev-parse", tracking], listing.repo);
  const now = Str.trim(at.stdout);
  if (at.code !== 0 || now === "") return { refused: `could not read ${tracking}` };
  if (now !== opts.head) return { moved: now };
  const where = path.join(opts.worktrees, path.basename(listing.repo), reviewingDir(opts.runId));
  const there = yield* fs.exists(where).pipe(Effect.orElseSucceed(() => false));
  const steps: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = there
    ? [
        [where, ["checkout", "--quiet", "--detach", "--force", opts.head]],
        [where, ["clean", "-fdq"]],
      ]
    : [[listing.repo, ["worktree", "add", "--quiet", "--detach", where, opts.head]]];
  for (const [cwd, args] of steps) {
    const done = yield* run("git", [...args], cwd);
    if (done.code !== 0)
      return { refused: `could not check ${opts.head} out in ${where}: ${whatItSaid(done)}` };
  }
  const worktree = {
    path: where,
    branch: "",
    managed_by: "git",
    workspace_id: null,
    created_by_collie: true,
    created_branch: false,
    created_on: null,
    made_at: yield* madeAt(where),
    root_tab_id: null,
    root_pane_id: null,
  } satisfies WorktreeRecord;
  return { cwd: where, worktree };
});
