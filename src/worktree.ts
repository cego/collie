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
import type { RunFacts } from "./runs";
import { slugify } from "./template";
import { changeBranch } from "./plan";
import { unlistedServers, type CompactionPorts } from "./compaction";
import { COMPACTION_PORTS } from "./compactors";
import { endAgent, endedLine, runLog } from "./agent-end";
import { readLaunches } from "./launches";
import { installDependencies } from "./dependencies";

export function mutates(checkout: CheckoutKind) {
  return checkout !== "none";
}

export function roams(checkout: CheckoutKind) {
  return checkout === "roaming";
}

const ROAMING_DIRS = ["roaming", "roaming-2", "roaming-3"];

const remoteRepository = (value: string) =>
  /^(?:https?:\/\/|ssh:\/\/|[^@\s]+@)/.test(value) && projectFromRemote(value) !== null;

export const destinationLock = (stateDir: string, at: string) =>
  `${stateDir}/worktree-${Bun.hash(at).toString(16)}.lock`;

export const isDestinationLock = (name: string) => /^worktree-[0-9a-f]+\.lock$/.test(name);

export interface BranchAsk {
  cwd: string;
  name: string;
  inputs: Record<string, string>;
  strategies?: Record<string, string> | undefined;
  sources?: Record<string, string> | undefined;
  explicit?: string | null | undefined;
  taskBranch?: string | null | undefined;
  change?: string | undefined;
  stackedOn?: string | undefined;
  login?: string | null | undefined;
  githubLogin?: string | null | undefined;
  gitlabHost?: string | undefined;
  fetches?: boolean | undefined;
  run?: Runner<ChildProcessSpawner.ChildProcessSpawner>;
}

export interface CheckoutAsk extends BranchAsk {
  branchBase?: string | undefined;
  workflow: string;
  checkout: CheckoutKind;
  workspaceId?: string | null;
  workspaceLabel?: string | null;
  stateDir: string;
  recordedBy?: RecordedBy;
  claimed?: (worktree: WorktreeRecord) => Effect.Effect<void>;
  starting?: { readonly run: string; readonly cwd: string };
}

export interface Recorded {
  readonly run: string;
  readonly worktree: WorktreeRecord | null;
  readonly live: Effect.Effect<string | null>;
  readonly release: Effect.Effect<string | null>;
}

export type RecordedBy = (at: string) => Effect.Effect<Recorded | null>;

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
  task: string;
  base: string;
  refused: string | null;
  source: BranchSource | null;
}

export const BRANCH_INPUT = "branch";

export function branchListed(checkout: CheckoutKind, inputs: Record<string, string>) {
  const returned: Record<string, string> =
    mutates(checkout) && !roams(checkout) ? { ...inputs, [BRANCH_INPUT]: "optional" } : inputs;
  return returned;
}

export const TASK_INPUT = "task";

const SLUG_MAX = 40;

export const branchFor = Effect.fn("worktree.branchFor")(function* (opts: BranchAsk) {
  const run = opts.run ?? shell;
  const refuse: (why: string) => BranchPlan = (why) => ({
    branch: "",
    task: "",
    base: "",
    refused: why,
    source: null,
  });
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

const LOGIN_ENV = { gitlab: "GITLAB_USER_LOGIN", github: "GITHUB_ACTOR" } as const;

interface Named {
  refused: string | null;
  branch: string;
  reviewed: boolean;
  generated: boolean;
  source: BranchSource | null;
}

const refusedName: (why: string) => Named = (why) => ({
  refused: why,
  branch: "",
  reviewed: false,
  generated: false,
  source: null,
});

const verbatim: (branch: string, source: BranchSource, reviewed?: boolean) => Named = (
  branch: string,
  source: BranchSource,
  reviewed = false,
) => ({
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
  const work = workSourceOf(opts);
  if (work?.kind === "review") {
    const reviewed = yield* reviewedBranch(opts.cwd, diffTargetOf(opts)?.value ?? "", run);
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
  const ownPlan = work !== null && planRunOf(work.value) !== null;
  if (work?.kind === "plan-dir" && !ownPlan && said(opts, work.name)) {
    return generated(path.basename(work.value), "from plan", work.value);
  }
  const described = work !== null && !ownPlan && said(opts, work.name);
  const issue = work?.kind === "linear" ? linearIssueOf(work.value) : null;
  if (described) return generated(issue ?? work.value, "from the work");
  return generated(opts.name, "from the run name", `${opts.name}\n${work?.value ?? ""}`);
});

function generated(from: string, source: BranchSource, distinctBy = from) {
  const returned: Named = {
    refused: null,
    branch: taskSlug(from, distinctBy),
    reviewed: false,
    generated: true,
    source,
  };
  return returned;
}

function taskSlug(from: string, distinctBy: string) {
  const derived = slugify(from, SLUG_MAX);
  if (letters(from) === letters(derived)) {
    return derived;
  }
  return `${derived}-${pipe_(Bun.hash(distinctBy).toString(36), Str.slice(0, 6))}`;
}

function letters(text: string) {
  return pipe_(Str.toLowerCase(text), Str.replace(/[^\p{L}\p{N}]+/gu, ""));
}

const baseFor = Effect.fn("worktree.baseFor")(function* (
  branch: string,
  cwd: string,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
  opts: { reviewed: boolean; fetches: boolean },
) {
  const exists = (ref: string) => run("git", ["rev-parse", "--verify", ref], cwd);
  if ((yield* exists(`origin/${branch}`)).code === 0) return { base: `origin/${branch}` };
  if (opts.reviewed) {
    if ((yield* exists(`refs/heads/${branch}`)).code === 0) return { base: branch };
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

export const defaultStart = Effect.fn("worktree.defaultStart")(function* (
  cwd: string,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
) {
  const head = (yield* defaultBase(run, cwd)) ?? "master";
  const tracked = (yield* run("git", ["rev-parse", "--verify", `origin/${head}`], cwd)).code === 0;
  return tracked ? `origin/${head}` : head;
});

const SAID = new Set(["explicit", "typed", "asked"]);

function said(opts: BranchAsk, name: string) {
  return SAID.has(opts.sources?.[name] ?? "");
}

function targetBranch(target: string) {
  const head = branchTargetHead(target) ?? "";
  if (head === "" || head === "HEAD" || /^[0-9a-f]{7,40}$/.test(head)) {
    const returned: string | null = null;
    return returned;
  }
  const returned: string | null = head;
  return returned;
}

const OUTSIDE_URL = /[\s<>"{}|\\^`[\]]+/;
const PROSE_EDGES = /^[('"]+|[)'".,;:!?]+$/g;

const mrUrlsIn = (text: string) =>
  Arr.flatMap(Str.split(text, OUTSIDE_URL), (word) => {
    const said = pipe_(word, Str.replace(PROSE_EDGES, ""));
    const ref = readMrUrl(said);
    if (Str.split(said, "://").length > 2) return [ref, ref];
    return ref === null ? [] : [ref];
  });

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

const reviewedBranch = Effect.fn("worktree.reviewedBranch")(function* (
  cwd: string,
  target: string,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
) {
  const mr = parseMrTarget(target);
  if (mr) {
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
    return (yield* isBranch(head, cwd, run))
      ? { branch: head, reviewed: true }
      : { refused: `${head} is not a branch, so there is nothing to fix on it` };
  }
  if (target === "") return { refused: "the review names no target, so no branch holds its work" };
  if (Str.trim(target) !== "worktree") {
    return { refused: `${target} is not a target Collie can find a branch for` };
  }
  const at = yield* run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  const branch = Str.trim(at.stdout);
  if (at.code !== 0 || branch === "" || branch === "HEAD") {
    return { refused: `${cwd} is not on a branch to fix` };
  }
  return { branch, reviewed: false };
});

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

const branchPath = (branch: string) => Str.split(branch, "/");

interface Listed {
  path: string;
  branch: string | null;
}

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
  const repo = checkouts[0]?.path;
  return repo === undefined ? null : { repo, checkouts };
});

export const repositoryName = Effect.fn("worktree.repositoryName")(function* (
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
  cwd: string,
) {
  const path = yield* Path.Path;
  const listing = yield* gitWorktrees(run, cwd);
  return listing === null ? null : path.basename(listing.repo);
});

const gitCheckout = Effect.fn("worktree.gitCheckout")(function* (opts: {
  cwd: string;
  branch: string;
  base?: string | undefined;
  worktrees: string;
  stateDir: string;
  recordedBy?: RecordedBy | undefined;
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>;
}) {
  const path = yield* Path.Path;
  const { run, branch } = opts;
  const listing = yield* gitWorktrees(run, opts.cwd);
  if (!listing) return { refused: `${opts.cwd} is not a git checkout` };
  const first = path.join(opts.worktrees, path.basename(listing.repo), ...branchPath(branch));
  return yield* withLock(
    destinationLock(opts.stateDir, first),
    Effect.succeed({ refused: `${first} is being checked out by another Run starting now` }),
    cutBranchCheckout({ ...opts, repo: listing.repo, first }),
    Duration.minutes(2),
  );
});

const freeSlot = Effect.fn("worktree.freeSlot")(function* (opts: {
  repo: string;
  first: string;
  listing: { readonly checkouts: ReadonlyArray<{ readonly path: string }> };
  recordedBy?: RecordedBy | undefined;
}) {
  const passed: string[] = [];
  for (const slot of [opts.first, `${opts.first}-2`, `${opts.first}-3`]) {
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

const cutBranchCheckout = Effect.fn("worktree.cutBranchCheckout")(function* (opts: {
  repo: string;
  first: string;
  branch: string;
  base?: string | undefined;
  recordedBy?: RecordedBy | undefined;
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>;
}) {
  const { run, branch } = opts;
  const listing = yield* gitWorktrees(run, opts.repo);
  if (!listing) return { refused: `${opts.repo} is not a git checkout` };
  const existing = Option.getOrUndefined(
    Arr.findFirst(listing.checkouts, (checkout) => checkout.branch === branch),
  );
  if (existing) return { path: existing.path, created: false, passed: [] };

  const slot = yield* freeSlot({ ...opts, listing });
  if (slot.at === null) return { refused: slot.refused };
  const { at, passed } = slot;

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
    const made = yield* run("git", ["branch", branch, start], opts.repo);
    if (made.code !== 0) return { refused: whatItSaid(made) || `git would not make ${branch}` };
    const remoteBase = opts.base;
    if (remoteBase !== undefined && pipe_(remoteBase, Str.startsWith("origin/")))
      yield* run("git", ["branch", "--set-upstream-to", remoteBase, branch], opts.repo);
  }
  const added = yield* run("git", ["worktree", "add", at, branch], opts.repo);
  if (added.code !== 0) {
    if (!known) yield* run("git", ["update-ref", "-d", `refs/heads/${branch}`, start], opts.repo);
    return { refused: whatItSaid(added) || `git would not add a worktree at ${at}` };
  }
  return { path: at, created: true, passed };
});

const newOnOrigin = Effect.fn("worktree.newOnOrigin")(function* (branch: string, cwd: string) {
  const local = yield* shell(
    "git",
    ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
    cwd,
  );
  if (local.code === 0) return null;
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

const madeAt = Effect.fn("worktree.madeAt")(function* (worktreePath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stat = yield* Effect.result(fs.stat(path.join(worktreePath, ".git")));
  if (stat._tag === "Failure") return null;
  const mtime = stat.success.mtime;
  return Option.isSome(mtime) ? mtime.value.getTime() : null;
});

const occupant = Effect.fn("worktree.occupant")(function* (at: string) {
  const fs = yield* FileSystem.FileSystem;
  const there =
    Option.isSome(yield* fs.readLink(at).pipe(Effect.option)) ||
    (yield* fs.exists(at).pipe(Effect.orElseSucceed(() => true)));
  if (!there) return null;
  const marker = yield* fs.readFileString(`${at}/.git`).pipe(Effect.orElseSucceed(() => ""));
  return { owner: /gitdir:\s*(.+?)\/\.git\/worktrees\//.exec(marker)?.[1] ?? null };
});

const occupiedAs = (owner: string | null, recorded: Recorded | null) =>
  `${
    owner === null
      ? "a checkout that does not say which repository it belongs to"
      : `a checkout of ${owner}`
  }${recorded === null ? "" : `, recorded by Run ${recorded.run}`}`;

export const isTheOneMade = Effect.fn("worktree.isTheOneMade")(function* (
  at: string,
  record: WorktreeRecord | null,
) {
  if (record === null || !record.created_by_collie || record.made_at === null) return false;
  return (yield* madeAt(at)) === record.made_at;
});

const wouldLose = Effect.fn("worktree.wouldLose")(function* (
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>,
  at: string,
) {
  const dirty = yield* run("git", ["status", "--porcelain"], at);
  if (dirty.code !== 0) return { unread: "could not read the working tree" };
  if (Str.trim(dirty.stdout) !== "") return { lost: "uncommitted changes" };
  const only = yield* run("git", ["rev-list", "HEAD", "--not", "--branches", "--remotes"], at);
  if (only.code !== 0) return { unread: "could not read what is unpushed" };
  const count = commits(only);
  return count === 0
    ? null
    : { lost: `${count} commit${count === 1 ? "" : "s"} on no branch or remote` };
});

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

const claimRoaming = Effect.fn("worktree.claimRoaming")(function* (opts: {
  slots: ReadonlyArray<string>;
  repo: string;
  recordedBy?: RecordedBy | undefined;
  run: Runner<ChildProcessSpawner.ChildProcessSpawner>;
}) {
  const { run } = opts;
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
    if (taken !== null && recorded !== null && taken.owner === opts.repo && listed.has(at)) {
      const live = yield* recorded.live;
      if (live !== null)
        return { refused: `${at} is ${occupiedAs(taken.owner, recorded)}: ${live}` };
    }
    seen.push({ at, taken, recorded });
  }

  const fetched = yield* run("git", ["fetch", "--quiet", "origin"], opts.repo);
  if (
    fetched.code !== 0 &&
    (yield* run("git", ["remote", "get-url", "origin"], opts.repo)).code === 0
  ) {
    return { refused: `could not fetch origin: ${whatItSaid(fetched) || "git fetch failed"}` };
  }
  const base = yield* defaultStart(opts.repo, run);

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
      const before = yield* wouldLose(run, at);
      if (before !== null && "unread" in before)
        return { refused: `${at} is ${held}: ${before.unread}` };
      if (before !== null) {
        pass(before.lost);
        continue;
      }
      const released = yield* recorded.release;
      if (released !== null) return { refused: `${at} is ${held}: ${released}` };
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

export interface Checkout {
  cwd: string;
  workspaceId: string | null;
  workspaceLabel: string | null;
  worktree: WorktreeRecord | null;
  note: string;
  refused: string | null;
  branch: string | null;
  task: string | null;
  branchSource: BranchSource | null;
}

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
  const remote = hasOrigin
    ? yield* shell("git", ["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`], base.in)
    : null;
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

  const refuse: (why: string) => Checkout = (why) => ({
    ...here,
    refused: `no worktree for ${plan.branch}: ${why}`,
  });

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

const RECHECK_MS = 3 * 60_000;
const REPORT_MS = 60 * 60_000;
export const PRUNE_FILE = "worktrees.json";

const PruneEntry = Schema.Struct({
  checked_at: Schema.Finite,
  line: Schema.String,
  removed: Schema.Boolean,
  repo: Schema.String,
});
const PruneStateJson = Schema.fromJsonString(
  Schema.Record(Schema.String, PruneEntry.pipe(Schema.mutableKey)),
);
type PruneState = Schema.Schema.Type<typeof PruneStateJson>;

export interface Landed {
  readonly why: string;
  readonly heads: ReadonlyArray<string>;
}

export interface Settling {
  readonly owedAt: ReadonlySet<string>;
  readonly owedOn: ReadonlySet<string>;
  readonly landedAt: ReadonlyMap<string, Landed>;
  readonly landedOn: ReadonlyMap<string, Landed>;
  readonly openOn: ReadonlyMap<string, string>;
  readonly taskHolds: ReadonlyMap<string, string>;
  readonly protect: ReadonlySet<string>;
}

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

interface InUse {
  paths: ReadonlyMap<string, string>;
  agents: ReadonlyArray<AgentInfo>;
}

const worksIn = (agent: AgentInfo, dir: string) =>
  inside(dir, agent.cwd) || inside(dir, agent.foregroundCwd);

const inUse = Effect.fn("worktree.inUse")(function* (
  herdr: Herdr,
  opts: {
    stateDir: string;
    paths: ReadonlyMap<string, string>;
    keep?: string | undefined;
    leftovers: ReadonlySet<string>;
  },
) {
  const agents = yield* Effect.result(herdr.agentList());
  if (agents._tag === "Failure") return null;
  const paths = new Map(opts.paths);
  for (const agent of agents.success) {
    if (opts.leftovers.has(agent.paneId) && agent.status !== "working") continue;
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

const inside = (at: string, dir: string | null | undefined) =>
  dir !== null && dir !== undefined && (dir === at || pipe_(dir, Str.startsWith(`${at}/`)));

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

function heldBy(use: InUse, worktree: { path: string }) {
  for (const [dir, why] of use.paths) {
    if (inside(worktree.path, dir)) {
      const returned: string | null = why;
      return returned;
    }
  }
  const returned: string | null = null;
  return returned;
}

type Verdict = { keep: string; why?: undefined } | { keep?: undefined; why: string };

const keepIt: (keep: string) => Verdict = (keep) => ({ keep });
const settledBecause: (why: string) => Verdict = (why) => ({ why });

const settled = Effect.fn("worktree.settled")(function* (
  worktree: Listed & { branch: string },
  opts: {
    repo: string;
    use: InUse;
    run: Runner<ChildProcessSpawner.ChildProcessSpawner>;
    settling: Settling;
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

  const settledBy = worktree.branch === "" ? null : yield* landedBy(worktree, landed, opts);
  if (settledBy !== null && settledBy.keep !== undefined) return settledBy;
  const task = settling.taskHolds.get(worktree.path);
  if (task !== undefined) return keepIt(task);
  return settledBy ?? settledBecause("its Run is over and it holds nothing");
});

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

function commits(result: { stdout: string }) {
  return Arr.filter(Str.split(result.stdout, "\n"), (line) => Str.trim(line) !== "").length;
}

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

export const reviewingDir = (runId: string) => `${REVIEWING}${runId}`;

function fromRuns(
  runs: ReadonlyArray<RunFacts>,
  registered: ReadonlyArray<AgentEntry>,
  settling: Settling,
  checking: ReadonlySet<string>,
) {
  const mine = new Map<string, WorktreeRecord>();
  const projects = new Map<string, string>();
  const paths = new Map<string, string>();
  const panes = new Map<string, Set<string>>();
  const roaming = Arr.flatMap(runs, ({ worktree }) =>
    worktree?.created_by_collie && worktree.branch === "" ? [worktree.path] : [],
  );
  for (const run of runs) {
    const going = run.state === "running" || run.state === "waiting";
    const worktree = run.worktree?.created_by_collie ? run.worktree : null;
    const at =
      worktree?.path ??
      Option.getOrUndefined(Arr.findFirst(roaming, (path) => inside(path, run.cwd)));
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
    if (at === undefined || going || resumable || checking.has(run.id)) continue;
    const left = panes.get(at) ?? new Set<string>();
    for (const entry of registered) if (entry.runId === run.id) left.add(entry.paneId);
    panes.set(at, left);
  }
  return { mine, paths, panes, projects };
}

interface PruneOptions {
  herdr: Herdr;
  stateDir: string;
  runs: ReadonlyArray<RunFacts>;
  registered: ReadonlyArray<AgentEntry>;
  cwd: string;
  keep?: string;
  now?: number;
  run?: Runner<ChildProcessSpawner.ChildProcessSpawner>;
  only?: string;
  dryRun?: boolean;
  settling?: Settling;
  ports?: CompactionPorts;
}

export interface Judged {
  path: string;
  keep?: string;
  why?: string;
  removed: boolean;
}

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
  const nameOf = (worktree: { path: string; branch: string }) =>
    worktree.branch || path.basename(worktree.path);
  const state = yield* fs.readFileString(statePath).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(PruneStateJson)),
    Effect.orElseSucceed(() => {
      const returned: PruneState = {};
      return returned;
    }),
  );
  const before = `${yield* Schema.encodeEffect(PruneStateJson)(state).pipe(Effect.orDie)}\n`;

  const { mine, paths, panes, projects } = opts.recorded;
  const settling = opts.settling ?? NOTHING_SETTLING;
  const listing = opts.listing;
  const candidates: Array<Listed & { branch: string }> = [];
  for (const worktree of listing?.worktrees ?? []) {
    if (opts.only !== undefined && worktree.path !== opts.only) continue;
    const branch = worktree.branch ?? "";
    const record = mine.get(worktree.path);
    if (!record || record.made_at === null) continue;
    if (settling.protect.has(worktree.path)) continue;
    const git = yield* fs.stat(path.join(worktree.path, ".git")).pipe(Effect.option);
    if (Option.isSome(git) && git.value.type === "Directory") continue;
    if ((yield* madeAt(worktree.path)) !== record.made_at) continue;
    candidates.push({ ...worktree, branch });
  }

  const repo = listing?.source ?? opts.cwd;
  const round = { state, statePath, before, now, repo };

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

const conclude = Effect.fn("worktree.conclude")(function* (opts: {
  state: PruneState;
  statePath: string;
  before: string;
  now: number;
  repo: string;
}) {
  const encoded = `${yield* Schema.encodeEffect(PruneStateJson)(opts.state).pipe(Effect.orDie)}\n`;
  if (encoded !== opts.before) {
    yield* (yield* FileSystem.FileSystem).writeFileString(opts.statePath, encoded);
  }
  return reported(opts.state, opts.now, opts.repo);
});

function reported(state: PruneState, now: number, repo?: string) {
  const returned: string[] = Arr.map(
    Arr.filter(
      Rec.values(state),
      (entry) =>
        (repo === undefined || entry.repo === repo) &&
        (!entry.removed || now - entry.checked_at <= REPORT_MS),
    ),
    (entry) => entry.line,
  );
  return returned;
}

interface Removal {
  line: string;
  removed: boolean;
}

const removeWorktree = Effect.fn("worktree.removeWorktree")(function* (
  herdr: Herdr,
  worktree: Listed & { branch: string },
  opts: {
    name: string;
    why: string;
    repo: string;
    run: Runner<ChildProcessSpawner.ChildProcessSpawner>;
    leftovers: ReadonlySet<string>;
    agents: ReadonlyArray<AgentInfo>;
    stateDir: string;
    ports: CompactionPorts;
    registered: ReadonlyArray<AgentEntry>;
  },
) {
  const kept: (why: string) => Removal = (why) => ({
    line: `kept ${opts.name} · ${why}`,
    removed: false,
  });
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

  const deleted =
    worktree.branch === ""
      ? { code: 0, stdout: "" }
      : yield* opts.run("git", ["branch", "-d", worktree.branch], opts.repo);
  const why =
    deleted.code === 0
      ? opts.why
      : `branch ${worktree.branch} kept: ${whatItSaid(deleted) || "git would not delete it"}`;
  const agents = running === 0 ? "" : ` · ${running} agent(s) left running`;
  return { line: `♻ removed ${opts.name} · ${why}${agents}`, removed: true } satisfies Removal;
});

export const pruneWorktrees = (opts: PruneOptions) =>
  judgeWorktrees(opts).pipe(Effect.map((round) => round.lines));

export const judgeWorktrees = (opts: PruneOptions) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const lock = path.join(opts.stateDir, `${PRUNE_FILE}.lock`);
    return yield* withLock(lock, Effect.succeed(null), sweep(opts));
  }).pipe(
    Effect.orElseSucceed(() => null),
    Effect.map((round) => round ?? { lines: [], judged: [], busy: true }),
  );

export const reportedWorktrees = Effect.fn("worktree.reportedWorktrees")(function* (
  stateDir: string,
) {
  const path = yield* Path.Path;
  const state = yield* (yield* FileSystem.FileSystem)
    .readFileString(path.join(stateDir, PRUNE_FILE))
    .pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(PruneStateJson)),
      Effect.orElseSucceed(() => {
        const returned: PruneState = {};
        return returned;
      }),
    );
  return reported(state, yield* Clock.currentTimeMillis);
});

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
  for (const cwd of new Set([opts.cwd, ...recorded.mine.keys()])) {
    const own = cwd === opts.cwd;
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
