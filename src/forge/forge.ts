// How Collie reaches a forge: one interface, a GitLab adapter and a GitHub adapter, and
// the choice between them. `glab` is run only by the GitLab adapter (`gitlab.ts` and its
// doctor checks) and `gh` only by the GitHub one (ADR-0050 D1); a caller asks the forge of
// the reference or checkout in front of it.

import type { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { forgeOfRef, parseMrTarget, type MrForge, type MrPanel, type MrRef } from "../board-model";
import type { Ran, Runner } from "../mr";
import type { Posted } from "../sdk";
import { github } from "./github";
import { gitlab } from "./gitlab";
import type { FiledIssue, IssueList } from "./issues";

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
  readonly issues: <R>(
    project: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<IssueList, never, R>;
  readonly fileIssue: <R>(
    project: string,
    title: string,
    body: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<FiledIssue, never, R>;
  readonly commentIssue: <R>(
    project: string,
    number: number,
    body: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<Readiness, never, R>;
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
  ) => Effect.Effect<string | null, never, R>;
  /** One merge request as the panel shows it. */
  readonly details: <R>(
    ref: MrRef,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<MrPanel, never, R>;
  /** How far a merged commit has been deployed, or null where the forge does not say. */
  readonly liveTier: <R>(
    ref: MrRef,
    mergedSha: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<DeployTier | null, never, R>;
  /** The open merge request whose source branch is `branch`, if any. */
  readonly forBranch: <R>(
    project: string,
    branch: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<ForBranch, never, R>;
  /** Every merge request whose source branch is `branch`, whatever its state. */
  readonly fromBranch: <R>(
    project: string,
    branch: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<FromBranchList, never, R>;
  /** The job named `name` in the pipeline on the merge request's head commit. */
  readonly job: <R>(
    ref: MrRef,
    name: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<JobRead, never, R>;
  /**
   * The job named `name` at the merge-base of the merge request's head and its target
   * branch, or on the target branch's latest pipeline where that commit has none.
   */
  readonly baseJob: <R>(
    ref: MrRef,
    name: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<BaseJobRead, never, R>;
  /** Runs the job `id` again: GitLab's retry, GitHub's rerun. */
  readonly retryJob: <R>(
    ref: MrRef,
    id: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<Readiness, never, R>;
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
  ) => Effect.Effect<string | null, never, R>;
  /** Clones `project` (`host/path`) into `into`, or says why it could not. */
  readonly clone: <R>(
    project: string,
    into: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<Readiness, never, R>;
  /** "GitLab" or "GitHub". */
  readonly display: string;
  /** The CLI it is reached through, as a human is told to log in with it. */
  readonly cli: string;
  /** "merge request" or "pull request". */
  readonly noun: string;
  /** One note on the merge request, and its approval where `approve` asks for it. */
  readonly post: <R>(
    ref: MrRef,
    body: string,
    approve: boolean,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<Posted, never, R>;
  /** My open merge requests in `project`, as assignee or author, for a menu. */
  readonly mine: <R>(
    project: string | null,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<ReadonlyArray<{ readonly iid: string; readonly title: string }>, never, R>;
  /** Opens the merge request in a browser. */
  readonly open: <R>(ref: MrRef, cwd: string, run: Runner<R>) => Effect.Effect<Ran, never, R>;
  /** What a reviewer runs to read the change and its description, and to check it out. */
  readonly review: (ref: MrRef) => ReviewCommands;
}

export const FORGES: Readonly<Record<MrForge, Forge>> = { gitlab, github };

/** The forge a pipeline or Actions run's URL is on: GitHub on github.com, GitLab elsewhere. */
export function forgeOfUrl(url: string): Forge {
  return /^https?:\/\/github\.com\//i.test(url.trim()) ? github : gitlab;
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
  const name = host.toLowerCase();
  if (name === "github.com") return "github";
  if (name === gitlabHost?.toLowerCase() || name.includes("gitlab")) return "gitlab";
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
