// How Collie reaches a forge: one interface, a GitLab adapter and a GitHub adapter, and
// the choice between them. `glab` is run only by the GitLab adapter (`gitlab.ts` and its
// doctor checks) and `gh` only by the GitHub one (ADR-0050 D1); a caller asks the forge of
// the reference or checkout in front of it.

import * as Option from "effect/Option";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import type { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { forgeOfRef, parseMrTarget, type MrForge, type MrPanel, type MrRef } from "../board-model";
import type { Ran, Runner } from "../mr";
import type { Posted } from "../sdk";
import { github } from "./github";
import { gitlab } from "./gitlab";
import type { ForgeHttp } from "./http";
import type { FiledIssue, IssueList } from "./issues";
import type { ForgeComment, MergeAnswer, ReviewRead } from "./review";

export interface Readiness {
  readonly ok: boolean;
  /** Why not, phrased for the runner's skip note. */
  readonly reason: string;
}

export type DeployTier = "production" | "staging";

/** A branch's open merge request, preferring auto-merge, none, or why the forge could not say. */
export type ForBranch =
  | {
      readonly ok: true;
      readonly open: {
        readonly iid: string;
        readonly url: string;
        readonly autoMerge: boolean;
      } | null;
    }
  | { readonly ok: false; readonly reason: string };

/** A merge request from a branch, in any state, with when it opened and merged or closed. */
export interface FromBranch {
  readonly iid: string;
  readonly url: string;
  readonly state: "open" | "merged" | "closed";
  readonly created: string;
  readonly ended: string | null;
}

/** A branch's merge requests in every state, or why the forge could not say. */
export type FromBranchList =
  | { readonly ok: true; readonly mrs: ReadonlyArray<FromBranch> }
  | { readonly ok: false; readonly reason: string };

/** A pipeline job's state, as a check left to CI reads it; `missing` is a pipeline without it. */
export type JobState =
  | "passed"
  | "pending"
  | "running"
  | "failed"
  | "skipped"
  | "cancelled"
  | "missing";

/** A named job on a merge request's head commit, or why the forge could not say. */
export type JobRead =
  | {
      readonly ok: true;
      readonly head: string;
      readonly state: JobState;
      readonly url: string | null;
      /** What `retryJob` and `jobLog` take; null where there is no such job. */
      readonly id: string | null;
      /** The merge commit a merged-results pipeline of `head` ran on, else null. */
      readonly merge: string | null;
    }
  | { readonly ok: false; readonly reason: string };

/** A job of a pipeline read whole; `manual` waits for somebody to start it by hand. */
export type PipelineJobState = JobState | "manual";

/** A pipeline or Actions run and its jobs, or why the forge could not say. */
export type PipelineRead =
  | {
      readonly ok: true;
      /** It finished, and the forge says it succeeded. */
      readonly succeeded: boolean;
      /** The project it ran in, as `host/path`, the branch or tag it ran for, and its commit. */
      readonly project: string;
      readonly ref: string;
      readonly sha: string;
      readonly jobs: ReadonlyArray<{
        readonly name: string;
        readonly state: PipelineJobState;
        readonly url: string | null;
      }>;
    }
  | { readonly ok: false; readonly reason: string };

/** The newest pipeline or Actions run a tag started, null where none, or why not. */
export type TagPipelineRead =
  | { readonly ok: true; readonly url: string | null }
  | { readonly ok: false; readonly reason: string };

/** The commit a tier's newest successful deployment has, null where none, or why not. */
export type DeployedRead =
  | { readonly ok: true; readonly sha: string | null }
  | { readonly ok: false; readonly reason: string };

/** A staging environment's live commit, and whether the requested commit was deployed by the selected jobs, or by any job where none were selected. */
export interface StagingEnvironment {
  readonly name: string;
  readonly live: string | null;
  readonly hasCommit: boolean;
}

/** Each staging environment, or why the forge could not say. */
export type StagingRead =
  | { readonly ok: true; readonly environments: ReadonlyArray<StagingEnvironment> }
  | { readonly ok: false; readonly reason: string };

/** The same job where the branch leaves its target, or on the target's latest pipeline. */
export type BaseJobRead =
  | {
      readonly ok: true;
      /** The commit its pipeline ran on. */
      readonly at: string;
      readonly state: JobState;
      readonly url: string | null;
    }
  | { readonly ok: false; readonly reason: string };

export interface ReviewCommands {
  readonly diff: string;
  readonly view: string;
  readonly checkout: string;
}

/** The command lines an agent is told to run, written for the forge they run on. */
export interface Commands {
  /**
   * Opens one, with `<title>` and `<file>` (the description) left for the agent, and on
   * GitLab `<iid>`, the number the first line printed. No line substitutes a command.
   */
  readonly create: string;
  /** Posts `<file>` as a note on the existing one; empty where there is none. */
  readonly comment: string;
}

/** What Collie asks a forge. Every answer is a value: a forge that cannot be asked says why. */
export interface Forge {
  readonly name: MrForge;
  /** The open issues, or with `numbers` those issues read one by one: a listing can lag a filing. */
  readonly issues: <R>(
    project: string,
    cwd: string,
    run: Runner<R>,
    numbers?: ReadonlyArray<number>,
  ) => Effect.Effect<IssueList, never, R | ForgeHttp>;
  readonly fileIssue: <R>(
    project: string,
    title: string,
    body: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<FiledIssue, never, R | ForgeHttp>;
  readonly commentIssue: <R>(
    project: string,
    number: number,
    body: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<Readiness, never, R | ForgeHttp>;
  /** The CLI is installed and logged in to `project`'s host; a null project asks the checkout at `cwd`. */
  readonly ready: <R>(
    project: string | null,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<Readiness, never, R>;
  /** Who the CLI is logged in as, or null where it will not say. */
  readonly login: <R>(
    cwd: string,
    run: Runner<R>,
    project?: string | null,
  ) => Effect.Effect<string | null, never, R | ForgeHttp>;
  /** One merge request as the panel shows it. */
  readonly details: <R>(
    ref: MrRef,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<MrPanel, never, R | ForgeHttp>;
  /** How far a merged commit has been deployed, or null where the forge does not say. */
  readonly liveTier: <R>(
    ref: MrRef,
    mergedSha: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<DeployTier | null, never, R | ForgeHttp>;
  /** The commit `tier`'s newest successful deployment has, in `ref`'s project (ADR-0050 D7). */
  readonly deployed: <R>(
    ref: MrRef,
    tier: DeployTier,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<DeployedRead, never, R | ForgeHttp>;
  /** `ref`'s project's staging environments, one by one; a null `commit` asks for none. */
  readonly stagingEnvironments: <R>(
    ref: MrRef,
    commit: string | null,
    cwd: string,
    run: Runner<R>,
    jobs?: ReadonlyArray<string>,
  ) => Effect.Effect<StagingRead, never, R | ForgeHttp>;
  /** The open merge request whose source branch is `branch`, if any. */
  readonly forBranch: <R>(
    project: string,
    branch: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<ForBranch, never, R | ForgeHttp>;
  /**
   * Whether `branch`, pushed or not, is the default branch or matches any protection rule
   * or ruleset, whatever the rule allows; null where the forge cannot say.
   */
  readonly protects: <R>(
    project: string,
    branch: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<boolean | null, never, R | ForgeHttp>;
  /** Every merge request whose source branch is `branch`, whatever its state. */
  readonly fromBranch: <R>(
    project: string,
    branch: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<FromBranchList, never, R | ForgeHttp>;
  /** The job named `name` in the pipeline on the merge request's head commit. */
  readonly job: <R>(
    ref: MrRef,
    name: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<JobRead, never, R | ForgeHttp>;
  /**
   * The job named `name` at the merge-base of the merge request's head and its target
   * branch, or on the target branch's latest pipeline where that commit has none.
   */
  readonly baseJob: <R>(
    ref: MrRef,
    name: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<BaseJobRead, never, R | ForgeHttp>;
  /** Runs the job `id` again: GitLab's retry, GitHub's rerun. */
  readonly retryJob: <R>(
    ref: MrRef,
    id: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<Readiness, never, R | ForgeHttp>;
  /** The command line that prints job `id`'s log, for an agent to run. */
  readonly jobLog: (ref: MrRef, id: string) => string;
  /** The repository's merge request template, relative to the checkout, or null. */
  readonly template: (
    cwd: string,
  ) => Effect.Effect<string | null, PlatformError, FileSystem.FileSystem | Path.Path>;
  /** What an agent runs to open one, or to note on `existing`. */
  readonly commands: (options: {
    readonly project: string;
    readonly branch: string;
    readonly assignee: string;
    readonly existing: string | null;
  }) => Commands;
  /** How a pipeline or Actions run at `url` went, or null where the forge does not say. */
  readonly runStatus: <R>(
    url: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<string | null, never, R | ForgeHttp>;
  /** The pipeline or Actions run at `url`, with its jobs; another forge's is refused. */
  readonly pipeline: <R>(
    url: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<PipelineRead, never, R | ForgeHttp>;
  /** The newest pipeline or Actions run `tag` started in `ref`'s project. */
  readonly tagPipeline: <R>(
    ref: MrRef,
    tag: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<TagPipelineRead, never, R | ForgeHttp>;
  /** Clones `project` (`host/path`) into `into`, or says why it could not. */
  readonly clone: <R>(
    project: string,
    into: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<Readiness, never, R>;
  /**
   * Gives the checkout at `into` a credential helper for `project`'s host that asks the
   * CLI for its token at each use, so no token is stored.
   */
  readonly credentials: <R>(
    project: string,
    into: string,
    run: Runner<R>,
  ) => Effect.Effect<Readiness, never, R>;
  /** "GitLab" or "GitHub". */
  readonly display: string;
  /** The CLI it is reached through, as a human is told to log in with it. */
  readonly cli: string;
  /** "merge request" or "pull request". */
  readonly noun: string;
  /** The repository's web address, from its `host/path`. */
  readonly webUrl: (project: string) => string;
  /** One note on the merge request, and its approval where `approve` asks for it. */
  readonly post: <R>(
    ref: MrRef,
    body: string,
    approve: boolean,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<Posted, never, R | ForgeHttp>;
  /** The merge request's review: its state, approval, mergeability, pipeline and comments. */
  readonly readReview: <R>(
    ref: MrRef,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<ReviewRead, never, R | ForgeHttp>;
  /** Posts `body` as it is, in the comment's thread where it has one; never resolves it. */
  readonly reply: <R>(
    ref: MrRef,
    to: Pick<ForgeComment, "thread">,
    body: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<Readiness, never, R | ForgeHttp>;
  /** Merges through the forge's REST merge at `head`: never admin, never auto-merge. */
  readonly merge: <R>(
    ref: MrRef,
    head: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<MergeAnswer, never, R | ForgeHttp>;
  /** My open merge requests in `project`, as assignee or author, for a menu. */
  readonly mine: <R>(
    project: string | null,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly iid: string; readonly title: string }>,
    never,
    R | ForgeHttp
  >;
  /** Opens the merge request in a browser. */
  readonly open: <R>(ref: MrRef, cwd: string, run: Runner<R>) => Effect.Effect<Ran, never, R>;
  /** What a reviewer runs to read the change and its description, and to check it out. */
  readonly review: (ref: MrRef) => ReviewCommands;
}

// The adapters import mr.ts, which imports this registry before they finish initializing.
export const FORGES: Readonly<Record<MrForge, Forge>> = {
  get gitlab() {
    return gitlab;
  },
  get github() {
    return github;
  },
};

/** The forge a pipeline or Actions run's URL is on: GitHub on github.com, GitLab elsewhere. */
export function forgeOfUrl(url: string): Forge {
  return /^https?:\/\/github\.com\//i.test(Str.trim(url)) ? github : gitlab;
}

/** The forge a merge request is on. */
export function forgeOf(ref: MrRef): Forge {
  return FORGES[forgeOfRef(ref)];
}

/**
 * The forge a host is on (ADR-0050 D2): GitHub on `github.com`, GitLab on the Flock's
 * GitLab host or any host whose name says `gitlab`, and none anywhere else.
 */
export function forgeOfHost(host: string, gitlabHost?: string): MrForge | null {
  const name = Str.toLowerCase(host);
  if (name === "github.com") return "github";
  if (
    name ===
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(gitlabHost), (present) => Str.toLowerCase(present)),
      ) ||
    pipe(name, Str.includes("gitlab"))
  )
    return "gitlab";
  return null;
}

/**
 * What a prompt says of an `mr:` target's forge: its name and noun, and the commands that
 * read the change, its description, and check it out. Null for any other target.
 */
export function mrForgeFacts(target: string) {
  const ref = parseMrTarget(target);
  if (ref === null) return null;
  const forge = forgeOf(ref);
  return { forge: forge.display, noun: forge.noun, ...forge.review(ref) };
}
