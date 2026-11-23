// WARNING: glab runs only in the GitLab adapter and gh only in the GitHub one.
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import type { Effect, FileSystem, Path } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { forgeOfRef, parseMrTarget } from "../board-model";
import type { MrForge, MrPanel, MrRef } from "../board-model";
import type { Ran, Runner } from "../mr";
import type { Posted } from "../sdk";
import { github } from "./github";
import { gitlab } from "./gitlab";
import type { Answered, ForgeHttp } from "./http";
import type { FiledIssue, IssueList } from "./issues";
import type { ForgeComment, MergeAnswer, ReviewRead } from "./review";
import type { FailedTest } from "../own-tests";

export interface Readiness {
  readonly ok: boolean;
  readonly cause?: "login-missing" | "forge-unavailable";
  readonly reason: string;
}

export type DeployTier = "production" | "staging";

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

export interface FromBranch {
  readonly iid: string;
  readonly url: string;
  readonly state: "open" | "merged" | "closed";
  readonly created: string;
  readonly ended: string | null;
}

export type FromBranchList =
  | { readonly ok: true; readonly mrs: ReadonlyArray<FromBranch> }
  | { readonly ok: false; readonly reason: string };

export type JobState =
  | "passed"
  | "pending"
  | "running"
  | "failed"
  | "skipped"
  | "cancelled"
  | "missing";

export type JobRead =
  | {
      readonly ok: true;
      readonly head: string;
      readonly state: JobState;
      readonly url: string | null;
      readonly id: string | null;
      readonly merge: string | null;
      readonly retryOf: ReadonlyArray<string>;
      readonly target: string | null;
    }
  | { readonly ok: false; readonly reason: string };

export interface FailedAttempt {
  readonly url: string | null;
  readonly tests: ReadonlyArray<FailedTest>;
  readonly jobs: ReadonlyArray<FailedJob> | null;
}

export interface FailedJob {
  readonly name: string;
  readonly tests: ReadonlyArray<FailedTest> | null;
}

export type PipelineJobState = JobState | "manual";

export type PipelineRead =
  | {
      readonly ok: true;
      readonly succeeded: boolean;
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

export type TagPipelineRead =
  | { readonly ok: true; readonly url: string | null }
  | { readonly ok: false; readonly reason: string };

export type DeployedRead =
  | { readonly ok: true; readonly sha: string | null }
  | { readonly ok: false; readonly reason: string };

export interface StagingEnvironment {
  readonly name: string;
  readonly live: string | null;
  readonly hasCommit: boolean;
}

export type StagingRead =
  | { readonly ok: true; readonly environments: ReadonlyArray<StagingEnvironment> }
  | { readonly ok: false; readonly reason: string };

export type PipelineStart =
  | { readonly _tag: "Has"; readonly url: string }
  | { readonly _tag: "Started"; readonly url: string }
  | { readonly _tag: "Unneeded"; readonly why: string }
  | { readonly _tag: "NoneByRules"; readonly message: string }
  | { readonly _tag: "Failed"; readonly reason: string };

export type BaseJobRead =
  | {
      readonly ok: true;
      readonly at: string;
      readonly state: JobState;
      readonly url: string | null;
      readonly id: string | null;
    }
  | { readonly ok: false; readonly reason: string };

export type TargetJobRead =
  | {
      readonly ok: true;
      readonly branch: string;
      readonly at: string | null;
      readonly state: JobState;
      readonly url: string | null;
      readonly id: string | null;
    }
  | { readonly ok: false; readonly reason: string };

export interface ReviewRequest {
  readonly url: string;
  readonly title: string;
  readonly author: string;
}

export interface ReviewCommands {
  readonly diff: string;
  readonly view: string;
  readonly checkout: string;
}

export interface Forge {
  readonly name: MrForge;
  readonly reviewChanges: <R>(
    ref: MrRef,
    previous: string,
    head: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<Answered<string>, never, R | ForgeHttp>;
  readonly create: <R>(
    options: {
      readonly project: string;
      readonly branch: string;
      readonly title: string;
      readonly body: string;
      readonly assignee: string;
      readonly onto?: string | undefined;
    },
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<
    { readonly ok: true; readonly url: string } | { readonly ok: false; readonly reason: string },
    never,
    R
  >;
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
  readonly ready: <R>(
    project: string | null,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<Readiness, never, R | ForgeHttp>;
  readonly login: <R>(
    cwd: string,
    run: Runner<R>,
    project?: string | null,
  ) => Effect.Effect<string | null, never, R | ForgeHttp>;
  readonly details: <R>(
    ref: MrRef,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<MrPanel, never, R | ForgeHttp>;
  readonly liveTier: <R>(
    ref: MrRef,
    mergedSha: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<DeployTier | null, never, R | ForgeHttp>;
  readonly deployed: <R>(
    ref: MrRef,
    tier: DeployTier,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<DeployedRead, never, R | ForgeHttp>;
  readonly stagingEnvironments: <R>(
    ref: MrRef,
    commit: string | null,
    cwd: string,
    run: Runner<R>,
    jobs?: ReadonlyArray<string>,
  ) => Effect.Effect<StagingRead, never, R | ForgeHttp>;
  readonly forBranch: <R>(
    project: string,
    branch: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<ForBranch, never, R | ForgeHttp>;
  readonly protects: <R>(
    project: string,
    branch: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<boolean | null, never, R | ForgeHttp>;
  readonly fromBranch: <R>(
    project: string,
    branch: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<FromBranchList, never, R | ForgeHttp>;
  readonly job: <R>(
    ref: MrRef,
    name: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<JobRead, never, R | ForgeHttp>;
  readonly baseJob: <R>(
    ref: MrRef,
    name: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<BaseJobRead, never, R | ForgeHttp>;
  readonly targetJob: <R>(
    ref: MrRef,
    name: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<TargetJobRead, never, R | ForgeHttp>;
  readonly failedAttempt: <R>(
    ref: MrRef,
    id: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<FailedAttempt, never, R | ForgeHttp>;
  readonly retryJob: <R>(
    ref: MrRef,
    id: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<Readiness, never, R | ForgeHttp>;
  readonly startPipeline: <R>(
    ref: MrRef,
    head: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<PipelineStart, never, R | ForgeHttp>;
  readonly jobLog: (ref: MrRef, id: string) => string;
  readonly template: (
    cwd: string,
  ) => Effect.Effect<string | null, PlatformError, FileSystem.FileSystem | Path.Path>;
  readonly runStatus: <R>(
    url: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<string | null, never, R | ForgeHttp>;
  readonly pipeline: <R>(
    url: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<PipelineRead, never, R | ForgeHttp>;
  readonly tagPipeline: <R>(
    ref: MrRef,
    tag: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<TagPipelineRead, never, R | ForgeHttp>;
  readonly clone: <R>(
    project: string,
    into: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<Readiness, never, R>;
  readonly credentials: <R>(
    project: string,
    into: string,
    run: Runner<R>,
  ) => Effect.Effect<Readiness, never, R>;
  readonly display: string;
  readonly cli: string;
  readonly noun: string;
  readonly webUrl: (project: string) => string;
  readonly post: <R>(
    ref: MrRef,
    body: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<Posted, never, R | ForgeHttp>;
  // WARNING: a retry reconciles an uncertain write with the forge before approving again.
  readonly approve: <R>(
    ref: MrRef,
    head: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<Posted & { readonly retryable?: boolean }, never, R | ForgeHttp>;
  readonly descends: <R>(
    ref: MrRef,
    previous: string,
    head: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<Answered<boolean>, never, R | ForgeHttp>;
  readonly approvedAt: <R>(
    ref: MrRef,
    login: string,
    head: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<Answered<boolean>, never, R | ForgeHttp>;
  readonly findNote: <R>(
    ref: MrRef,
    signature: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<Answered<boolean>, never, R | ForgeHttp>;
  readonly readReview: <R>(
    ref: MrRef,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<ReviewRead, never, R | ForgeHttp>;
  readonly reply: <R>(
    ref: MrRef,
    to: Pick<ForgeComment, "thread">,
    body: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<Readiness, never, R | ForgeHttp>;
  // WARNING: merges through the REST endpoint at head, never as admin or with auto-merge.
  readonly merge: <R>(
    ref: MrRef,
    head: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<MergeAnswer, never, R | ForgeHttp>;
  readonly reviewRequests: <R>(
    host: string,
    login: string,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<Answered<ReadonlyArray<ReviewRequest>>, never, R | ForgeHttp>;
  readonly mine: <R>(
    project: string | null,
    cwd: string,
    run: Runner<R>,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly iid: string; readonly title: string }>,
    never,
    R | ForgeHttp
  >;
  readonly open: <R>(ref: MrRef, cwd: string, run: Runner<R>) => Effect.Effect<Ran, never, R>;
  readonly review: (ref: MrRef) => ReviewCommands;
}

export const COLLIE_REPOSITORY = "github.com/cego/collie";

// WARNING: adapters import mr.ts, which imports this registry before they finish initializing.
export const FORGES: Readonly<Record<MrForge, Forge>> = {
  get gitlab() {
    return gitlab;
  },
  get github() {
    return github;
  },
};

export function forgeOfUrl(url: string) {
  return /^https?:\/\/github\.com\//i.test(Str.trim(url)) ? github : gitlab;
}

export function forgeOf(ref: MrRef) {
  return FORGES[forgeOfRef(ref)];
}

export function forgeOfHost(host: string, gitlabHost?: string) {
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

export function mrForgeFacts(target: string) {
  const ref = parseMrTarget(target);
  if (ref === null) return null;
  const forge = forgeOf(ref);
  return { forge: forge.display, noun: forge.noun, ...forge.review(ref) };
}
