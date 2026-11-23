import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import { stripVTControlCharacters } from "node:util";
import {
  DateTime,
  Effect,
  FileSystem,
  Option,
  Order,
  Path,
  Redacted,
  Result,
  Schema,
} from "effect";
import { CommandLine } from "effect/process";
import { mrWords } from "../board-model";
import type {
  ForgeChecks,
  Mergeability,
  MrDetails,
  MrPanel,
  MrRef,
  MrUnavailable,
} from "../board-model";
import { epochMs } from "../time";
import { failedTestsIn } from "../own-tests";
import { keepCredentialHelper, projectHere, whatItSaid } from "../mr";
import type { Runner } from "../mr";
import type {
  DeployTier,
  DeployedRead,
  StagingEnvironment,
  StagingRead,
  Forge,
  ForBranch,
  FromBranchList,
  BaseJobRead,
  TargetJobRead,
  FailedAttempt,
  JobRead,
  JobState,
  PipelineRead,
  PipelineStart,
  TagPipelineRead,
  ReviewRequest,
} from "./forge";
import type { ForgeHttp } from "./http";
import { loginReadiness, pagesAs, request, requestAs, requestText } from "./http";
import type { Answered, ForgeLogin } from "./http";
import {
  listIssues,
  listRequests,
  createIssue,
  commentIssue,
  postReview,
  approveReview,
  descendsFrom,
  approvedAt,
  findReviewNote,
  reviewChanges,
  viewerLogin,
  myMergeRequests,
} from "./threads";
import { judgeComments } from "./review";
import type { ForgeComment, MergeAnswer, ReviewRead } from "./review";

export const MR_TEMPLATE = ".gitlab/merge_request_templates/default.md";
export const GLAB_RELOGIN = "glab auth login";

export function repoArgs(project: string | null) {
  return project ? ["--repo", project] : [];
}

const whereOf = (ref: MrRef) => (ref.project ? `${ref.project}!${ref.iid}` : `!${ref.iid}`);

export function hostOf(project: string | null) {
  const host = Option.getOrUndefined(
    Option.map(Option.fromNullishOr(project), (present) => Str.split(present, "/")[0]),
  );
  return host && pipe(host, Str.includes(".")) ? host : null;
}

// WARNING: GitLab sends null for an absent value, so every field it may omit is also nullable.
const optionalText = Schema.optionalKey(Schema.NullOr(Schema.String));
const optionalFlag = Schema.optionalKey(Schema.NullOr(Schema.Boolean));
const optionalCount = Schema.optionalKey(Schema.NullOr(Schema.Finite));
const optionalStatus = Schema.optionalKey(
  Schema.NullOr(Schema.Struct({ status: optionalText, sha: optionalText, web_url: optionalText })),
);

const MrFields = Schema.Struct({
  iid: Schema.optionalKey(Schema.NullOr(Schema.Union([Schema.String, Schema.Finite]))),
  title: optionalText,
  state: optionalText,
  draft: optionalFlag,
  work_in_progress: optionalFlag,
  author: Schema.optionalKey(Schema.NullOr(Schema.Struct({ username: optionalText }))),
  assignees: Schema.optionalKey(
    Schema.NullOr(Schema.Array(Schema.Struct({ username: optionalText }))),
  ),
  source_branch: optionalText,
  source_project_id: optionalCount,
  target_project_id: optionalCount,
  target_branch: optionalText,
  sha: optionalText,
  merge_commit_sha: optionalText,
  squash_commit_sha: optionalText,
  merged_at: optionalText,
  updated_at: optionalText,
  web_url: optionalText,
  head_pipeline: optionalStatus,
  pipeline: optionalStatus,
  blocking_discussions_resolved: optionalFlag,
  merge_when_pipeline_succeeds: optionalFlag,
  user_notes_count: optionalCount,
  approvals_required: optionalCount,
  approvals_left: optionalCount,
  detailed_merge_status: optionalText,
  merge_status: optionalText,
});

const Approvals = Schema.Struct({
  approvals_required: optionalCount,
  approvals_left: optionalCount,
  approved_by: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Struct({})))),
});
const Discussion = Schema.Struct({
  notes: Schema.Array(
    Schema.Struct({
      id: Schema.optionalKey(Schema.Finite),
      body: Schema.optionalKey(Schema.String),
      system: optionalFlag,
      resolvable: optionalFlag,
      resolved: optionalFlag,
    }),
  ),
});

const SETTLING_MERGE = new Set([
  "checking",
  "unchecked",
  "preparing",
  "approvals_syncing",
  "cannot_be_merged_recheck",
]);

function mergeabilityOf(detailed: string | null | undefined, legacy: string | null | undefined) {
  const said = detailed ?? (legacy === "can_be_merged" ? "mergeable" : legacy);
  if (said === undefined || said === null || said === "") {
    const returned: Mergeability | undefined = undefined;
    return returned;
  }
  const words = pipe(said, Str.replaceAll("_", " "));
  if (said === "mergeable") {
    const returned: Mergeability | undefined = { state: "mergeable", said: words };
    return returned;
  }
  const returned: Mergeability | undefined = {
    state: SETTLING_MERGE.has(said) ? "unknown" : "blocked",
    said: words,
  };
  return returned;
}

// WARNING: never called from a render path or for a list; fetched once per Selection and cached per ref.
export function mrDetails<R>(ref: MrRef, cwd: string, run: Runner<R>) {
  const returned: Effect.Effect<MrPanel, never, R | ForgeHttp> = Effect.gen(function* () {
    const where = whereOf(ref);
    const named = ref.project ?? (yield* projectHere(cwd, run));
    const reached = projectRest({ ...ref, project: named }, cwd);
    if (!reached.ok) {
      return { _tag: "Unavailable", reason: reached.reason } satisfies MrUnavailable;
    }
    const { rest, login, project } = reached;
    const route = `${project}/merge_requests/${ref.iid}`;
    const [read, approvals, discussions] = yield* Effect.all(
      [
        rest(MrFields, `merge_requests/${ref.iid}`),
        rest(Approvals, `merge_requests/${ref.iid}/approvals`),
        pagesAs(Discussion, login, cwd, `${route}/discussions?`),
      ],
      { concurrency: "unbounded" },
    );
    if (!read.ok) {
      return {
        _tag: "Unavailable",
        reason: `could not read ${where}: ${read.reason}`,
        transient: read.transient,
      } satisfies MrUnavailable;
    }
    for (const part of [approvals, discussions]) {
      if (!part.ok && part.transient) {
        return {
          _tag: "Unavailable",
          reason: part.reason,
          transient: true,
        } satisfies MrUnavailable;
      }
    }
    const mr = read.value;
    const draft = mr.draft === true || mr.work_in_progress === true;
    const pipeline = mr.head_pipeline?.status ?? mr.pipeline?.status ?? "";
    const updated = mr.updated_at ? epochMs(mr.updated_at) : Number.NaN;
    const mergeable = mergeabilityOf(mr.detailed_merge_status, mr.merge_status);
    const details = {
      _tag: "Details",
      iid: mr.iid === undefined || mr.iid === null ? ref.iid : String(mr.iid),
      project: ref.project,
      title: mr.title ?? "",
      state: draft && mr.state === "opened" ? "draft" : (mr.state ?? ""),
      author: mr.author?.username ?? "",
      assignees: Arr.filter(
        Arr.map(mr.assignees ?? [], (one) => one.username ?? ""),
        (name) => name !== "",
      ),
      sourceBranch: mr.source_branch ?? "",
      fork: mr.source_project_id !== mr.target_project_id,
      targetBranch: mr.target_branch ?? "",
      pipeline,
      checks: headChecks(mr.head_pipeline ?? mr.pipeline ?? null, mr.sha ?? ""),
      approvals: approvals.ok
        ? approvalsOf(approvals.value)
        : approvalsLine(mr.approvals_required, mr.approvals_left),
      unresolved: discussions.ok
        ? Arr.some(discussions.value, (one) =>
            Arr.some(one.notes, (note) => note.resolvable === true && note.resolved !== true),
          )
        : mr.blocking_discussions_resolved === false,
      notes: mr.user_notes_count ?? 0,
      ...(discussions.ok && {
        comments: Arr.flatMap(discussions.value, (one) =>
          Arr.flatMap(one.notes, (note) =>
            note.system === true || note.id === undefined
              ? []
              : [{ id: String(note.id), body: note.body ?? "" }],
          ),
        ),
      }),
      headSha: pipe(mr.sha ?? "", Str.slice(0, 7)),
      head: mr.sha ?? "",
      mergedSha:
        mr.state === "merged" ? (mr.merge_commit_sha ?? mr.squash_commit_sha ?? mr.sha ?? "") : "",
      updatedAt: Number.isFinite(updated) ? updated : 0,
      url: mr.web_url ?? "",
      autoMerge: mr.merge_when_pipeline_succeeds === true,
    } satisfies MrDetails;
    const merged = mr.merged_at ? { ...details, mergedAt: mr.merged_at } : details;
    return mergeable === undefined ? merged : { ...merged, mergeable };
  });
  return returned;
}

const approvalsOf = (approvals: typeof Approvals.Type) =>
  approvals.approvals_required === 0 && (approvals.approved_by ?? []).length === 0
    ? ""
    : approvalsLine(approvals.approvals_required, approvals.approvals_left);

// WARNING: where neither approval field answers, say nothing rather than guess zero.
function approvalsLine(
  requiredOrNull: number | null | undefined,
  leftOrNull: number | null | undefined,
) {
  const required = requiredOrNull ?? undefined;
  const left = leftOrNull ?? undefined;
  if (required === undefined && left === undefined) {
    return "";
  }
  if (left === 0) {
    return "approved";
  }
  if (required === undefined) {
    return `${left} still needed`;
  }
  if (left === undefined) {
    return `${required} approval(s) required`;
  }
  return `${left} of ${required} still needed`;
}

function headChecks(
  pipeline: {
    readonly status?: string | null;
    readonly sha?: string | null;
    readonly web_url?: string | null;
  } | null,
  head: string,
) {
  if (pipeline === null) {
    const returned: ForgeChecks = { state: "none" };
    return returned;
  }
  const checks: ForgeChecks =
    pipeline.sha && head !== "" && pipeline.sha !== head
      ? { state: "unknown" }
      : pipelineChecks(pipeline.status ?? "");
  const returned: ForgeChecks = pipeline.web_url ? { ...checks, url: pipeline.web_url } : checks;
  return returned;
}

export function pipelineChecks(status: string) {
  if (status === "") {
    const returned: ForgeChecks = { state: "none" };
    return returned;
  }
  if (status === "success" || status === "passed") {
    const returned: ForgeChecks = { state: "passed" };
    return returned;
  }
  if (status === "failed") {
    const returned: ForgeChecks = { state: "failed", name: "pipeline" };
    return returned;
  }
  if (
    ["running", "pending", "created", "preparing", "waiting_for_resource", "scheduled"].includes(
      status,
    )
  ) {
    const returned: ForgeChecks = { state: "running" };
    return returned;
  }
  const returned: ForgeChecks = { state: "unknown" };
  return returned;
}

export function gitlabForProject<R>(project: string | null, cwd: string, run: Runner<R>) {
  return Effect.gen(function* () {
    const glab = yield* run("glab", ["--version"], cwd);
    if (glab.code !== 0) {
      return { ok: false, reason: "glab is not installed" };
    }

    const host = hostOf(project);
    if (!host) {
      return { ok: true, reason: "" };
    }
    return yield* loginReadiness(glabLoginTo(host), cwd, run);
  });
}

// WARNING: the authenticated user, not the assignee: a branch belongs to whoever pushes it.
export function glabLogin<R>(cwd: string, run: Runner<R>, project: string | null = null) {
  return Effect.gen(function* () {
    const named = project ?? (yield* projectHere(cwd, run));
    return yield* viewerLogin(glabLoginTo(hostOf(named) ?? "gitlab.com"), cwd);
  });
}

const ReviewRequested = Schema.Struct({
  web_url: Schema.String,
  title: Schema.String,
  author: Schema.Struct({ username: Schema.String }),
});

const reviewRequests = (host: string, login: string, cwd: string) =>
  Effect.map(
    pagesAs(
      ReviewRequested,
      glabLoginTo(host),
      cwd,
      `merge_requests?scope=all&state=opened&reviewer_username=${encodeURIComponent(login)}`,
    ),
    (listed) => {
      const returned: Answered<ReadonlyArray<ReviewRequest>> = listed.ok
        ? {
            ok: true,
            value: Arr.map(listed.value, (one) => ({
              url: one.web_url,
              title: one.title,
              author: one.author.username,
            })),
          }
        : listed;
      return returned;
    },
  );

const Environments = Schema.Array(Schema.Struct({ name: Schema.String, tier: optionalText }));
const Deployments = Schema.Array(
  Schema.Struct({ sha: Schema.String, environment: Schema.Struct({ name: Schema.String }) }),
);
const MergeBase = Schema.Struct({ id: optionalText });

export function liveTier(ref: MrRef, mergedSha: string, cwd: string) {
  return Effect.gen(function* () {
    if (mergedSha === "") {
      return null;
    }
    const api = projectRest(ref, cwd);
    if (!api.ok) {
      return null;
    }
    const environments = yield* api.rest(Environments, "environments");
    if (!environments.ok) {
      return null;
    }
    const tiers = new Map<string, DeployTier>();
    for (const env of environments.value) {
      if (env.tier === "production" || env.tier === "staging") {
        tiers.set(env.name, env.tier);
      }
    }
    if (tiers.size === 0) {
      return null;
    }
    const deployments = yield* api.rest(
      Deployments,
      "deployments?status=success&order_by=created_at&sort=desc&per_page=50",
    );
    if (!deployments.ok) {
      return null;
    }
    const live = new Map<string, string>();
    for (const deployment of deployments.value) {
      if (tiers.has(deployment.environment.name) && !live.has(deployment.environment.name)) {
        live.set(deployment.environment.name, deployment.sha);
      }
    }
    const carries = (sha: string) =>
      Effect.gen(function* () {
        if (sha === mergedSha) {
          return true;
        }
        const base = yield* api.rest(
          MergeBase,
          `repository/merge_base?refs[]=${mergedSha}&refs[]=${sha}`,
        );
        return base.ok && base.value.id === mergedSha;
      });
    for (const tier of ["production", "staging"] as const) {
      for (const [name, sha] of live) {
        if (tiers.get(name) === tier && (yield* carries(sha))) {
          return tier;
        }
      }
    }
    return null;
  });
}

function deployed(ref: MrRef, tier: DeployTier, cwd: string) {
  const returned: Effect.Effect<DeployedRead, never, ForgeHttp> = Effect.gen(function* () {
    const reached = projectRest(ref, cwd);
    if (!reached.ok) {
      return reached;
    }
    const { rest } = reached;
    const names = new Set<string>();
    for (let page = 1; ; page++) {
      const listed = yield* rest(Environments, `environments?per_page=100&page=${page}`);
      if (!listed.ok) {
        return listed;
      }
      for (const env of listed.value) {
        if (env.tier === tier) {
          names.add(env.name);
        }
      }
      if (listed.value.length < 100) {
        break;
      }
    }
    if (names.size === 0) {
      return { ok: true, sha: null };
    }
    for (let page = 1; ; page++) {
      const newest = yield* rest(
        Deployments,
        `deployments?status=success&order_by=created_at&sort=desc&per_page=100&page=${page}`,
      );
      if (!newest.ok) {
        return newest;
      }
      const found = Option.getOrUndefined(
        Arr.findFirst(newest.value, (one) => names.has(one.environment.name)),
      );
      if (found !== undefined) {
        return { ok: true, sha: found.sha };
      }
      if (newest.value.length < 100) {
        return { ok: true, sha: null };
      }
    }
  });
  return returned;
}

const EnvironmentDeployment = Schema.Struct({
  sha: Schema.String,
  status: Schema.String,
  deployable: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        name: Schema.String,
        pipeline: Schema.optionalKey(
          Schema.NullOr(Schema.Struct({ ref: Schema.String, sha: Schema.String })),
        ),
      }),
    ),
  ),
});

function stagingEnvironments<R>(
  ref: MrRef,
  commit: string | null,
  cwd: string,
  _run: Runner<R>,
  jobs?: ReadonlyArray<string>,
) {
  const returned: Effect.Effect<StagingRead, never, ForgeHttp> = Effect.gen(function* () {
    const api = projectRest(ref, cwd);
    if (!api.ok) {
      return api;
    }
    const unread = (reason: string) => ({
      ok: false as const,
      reason: `GitLab could not read ${ref.project}'s stage environments: ${reason}`,
    });
    const names: Array<string> = [];
    for (let page = 1; ; page++) {
      const listed = yield* api.rest(Environments, `environments?per_page=100&page=${page}`);
      if (!listed.ok) {
        return unread(listed.reason);
      }
      for (const env of listed.value) {
        if (env.tier === "staging") {
          names.push(env.name);
        }
      }
      if (listed.value.length < 100) {
        break;
      }
    }
    const environments: Array<StagingEnvironment> = [];
    const builtFrom = new Map<string, boolean>();
    for (const name of names) {
      let live: string | null = null;
      let hasCommit = false;
      for (let page = 1; live === null || (commit !== null && !hasCommit); page++) {
        const newest = yield* api.rest(
          Schema.Array(EnvironmentDeployment),
          `deployments?environment=${encodeURIComponent(name)}&order_by=created_at&sort=desc&per_page=100&page=${page}`,
        );
        if (!newest.ok) {
          return unread(newest.reason);
        }
        for (const one of newest.value) {
          if (live === null && one.status === "success") {
            live = one.sha;
          }
          if (hasCommit || commit === null) {
            continue;
          }
          if (jobs !== undefined && !jobs.includes(one.deployable?.name ?? "")) {
            continue;
          }
          if (one.sha === commit) {
            hasCommit = true;
          } else if (
            jobs !== undefined &&
            one.deployable?.pipeline?.ref === `refs/merge-requests/${ref.iid}/merge` &&
            one.deployable.pipeline.sha === one.sha
          ) {
            let matches = builtFrom.get(one.sha);
            if (matches === undefined) {
              const parents = yield* api.rest(Commit, `repository/commits/${one.sha}`);
              if (!parents.ok) {
                return unread(parents.reason);
              }
              matches = parents.value.parent_ids.includes(commit);
              builtFrom.set(one.sha, matches);
            }
            hasCommit = matches;
          }
        }
        if (newest.value.length < 100) {
          break;
        }
      }
      environments.push({ name, live, hasCommit });
    }
    return { ok: true, environments };
  });
  return returned;
}

const BranchMr = Schema.Struct({
  iid: Schema.Union([Schema.String, Schema.Finite]),
  web_url: optionalText,
  merge_when_pipeline_succeeds: optionalFlag,
  state: Schema.String,
  created_at: Schema.String,
  merged_at: optionalText,
  closed_at: optionalText,
});

const mrsFrom: (
  project: string,
  branch: string,
  state: "opened" | "all",
  cwd: string,
) => Effect.Effect<Answered<Array<typeof BranchMr.Type>>, never, ForgeHttp> = (
  project,
  branch,
  state,
  cwd,
) => {
  const reached = projectRest({ project, iid: "" }, cwd);
  if (!reached.ok) {
    return Effect.succeed({ ok: false, reason: reached.reason });
  }
  const query = `source_branch=${encodeURIComponent(branch)}&state=${state}`;
  return Effect.map(
    pagesAs(BranchMr, reached.login, cwd, `${reached.project}/merge_requests?${query}`),
    (listed) =>
      listed.ok
        ? listed
        : ({
            ok: false,
            reason: `could not list ${project}'s merge requests from ${branch}: ${listed.reason}`,
          } as const),
  );
};

function forBranch(project: string, branch: string, cwd: string) {
  const returned: Effect.Effect<ForBranch, never, ForgeHttp> = Effect.map(
    mrsFrom(project, branch, "opened", cwd),
    (listed) => {
      if (!listed.ok) {
        return listed;
      }
      const mr =
        Option.getOrUndefined(
          Arr.findFirst(listed.value, (one) => one.merge_when_pipeline_succeeds === true),
        ) ?? listed.value[0];
      if (mr === undefined) {
        return { ok: true, open: null };
      }
      const iid = String(mr.iid);
      return {
        ok: true,
        open: {
          iid,
          url: mr.web_url ?? `https://${project}/-/merge_requests/${iid}`,
          autoMerge: mr.merge_when_pipeline_succeeds === true,
        },
      };
    },
  );
  return returned;
}

const DefaultBranch = Schema.Struct({ default_branch: Schema.String });
const ProtectedBranch = Schema.Struct({ name: Schema.String });
const PAGE = 100;

// WARNING: GitLab's * matches across / too, unlike a glob.
const wildcard = (pattern: string) =>
  new RegExp(
    `^${pipe(pattern, Str.replaceAll(/[.+?^${}()|[\]\\]/g, String.raw`\$&`), Str.replaceAll("*", ".*"))}$`,
  );

function protects(project: string, branch: string, cwd: string) {
  return Effect.gen(function* () {
    const host = hostOf(project);
    if (host === null) {
      return null;
    }
    const route = `projects/${encodeURIComponent(pipe(project, Str.slice(host.length + 1)))}`;
    const login = glabLoginTo(host);
    const repo = yield* requestAs(DefaultBranch, login, cwd, route);
    if (!repo.ok) {
      return null;
    }
    if (repo.value.default_branch === branch) {
      return true;
    }
    const rules = yield* pagesAs(ProtectedBranch, login, cwd, `${route}/protected_branches`);
    if (!rules.ok) {
      return null;
    }
    return Arr.some(rules.value, (rule) => wildcard(rule.name).test(branch));
  });
}

function fromBranch(project: string, branch: string, cwd: string) {
  const returned: Effect.Effect<FromBranchList, never, ForgeHttp> = Effect.map(
    mrsFrom(project, branch, "all", cwd),
    (listed) => {
      if (!listed.ok) {
        return listed;
      }
      return {
        ok: true,
        mrs: Arr.map(listed.value, (mr) => {
          const iid = String(mr.iid);
          return {
            iid,
            url: mr.web_url ?? `https://${project}/-/merge_requests/${iid}`,
            state: mr.state === "merged" ? "merged" : mr.state === "opened" ? "open" : "closed",
            created: mr.created_at,
            ended: mr.merged_at ?? mr.closed_at ?? null,
          };
        }),
      };
    },
  );
  return returned;
}

const MrHead = Schema.Struct({
  sha: optionalText,
  target_branch: optionalText,
  head_pipeline: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ id: Schema.Finite, sha: optionalText })),
  ),
});
const Commit = Schema.Struct({ parent_ids: Schema.Array(Schema.String) });
const Job = Schema.Struct({
  id: Schema.Finite,
  name: Schema.String,
  status: Schema.String,
  web_url: optionalText,
  finished_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const Jobs = Schema.Array(Job);
const AttemptJob = Schema.Struct({
  web_url: optionalText,
  pipeline: Schema.Struct({ id: Schema.Finite }),
});
const Pipelines = Schema.Array(Schema.Struct({ id: Schema.Finite, sha: Schema.String }));
const MrBase = Schema.Struct({
  target_branch: optionalText,
  diff_refs: Schema.optionalKey(Schema.NullOr(Schema.Struct({ base_sha: optionalText }))),
});

const JOB_STATES = new Map<string, JobState>([
  ["success", "passed"],
  ["failed", "failed"],
  ["canceled", "cancelled"],
  ["canceling", "cancelled"],
  ["skipped", "skipped"],
  ["manual", "skipped"],
  ["running", "running"],
]);

// WARNING: a merged-results pipeline counts for the head only where its merge commit's parent is the head.
function job(ref: MrRef, name: string, cwd: string) {
  const returned: Effect.Effect<JobRead, never, ForgeHttp> = Effect.gen(function* () {
    const where = whereOf(ref);
    const reached = projectRest(ref, cwd);
    if (!reached.ok) {
      return reached;
    }
    const { rest } = reached;
    const mr = yield* rest(MrHead, `merge_requests/${ref.iid}`);
    if (!mr.ok) {
      return { ok: false, reason: `could not read ${where}: ${mr.reason}` };
    }
    const head = mr.value.sha ?? "";
    const target = mr.value.target_branch ?? null;
    const pipeline = mr.value.head_pipeline ?? null;
    const waiting = {
      ok: true,
      head,
      state: "pending",
      url: null,
      id: null,
      merge: null,
      retryOf: [],
      target,
    } as const;
    if (pipeline === null) {
      return waiting;
    }
    let merge: string | null = null;
    if (pipeline.sha && pipeline.sha !== head) {
      const commit = yield* rest(Commit, `repository/commits/${pipeline.sha}`);
      if (!commit.ok) {
        return {
          ok: false,
          reason: `GitLab would not say which head ${where}'s pipeline ${pipeline.id} at ${pipeline.sha} was built from: ${commit.reason}`,
        };
      }
      if (!commit.value.parent_ids.includes(head)) {
        return waiting;
      }
      merge = pipeline.sha;
    }
    const found = yield* jobIn(reached, cwd, pipeline.id, name);
    if (!found.ok) {
      return {
        ok: false,
        reason: `could not list the jobs of ${where}'s pipeline ${pipeline.id}: ${found.reason}`,
      };
    }
    return { ok: true, head, ...found.value, merge, target };
  });
  return returned;
}

// WARNING: glab answers an env token for any host, so only a stored login is the host's own.
export function glabLoginTo(host: string, stored = false) {
  const glab = <R>(args: ReadonlyArray<string>, run: Runner<R>, cwd: string) =>
    stored
      ? run(
          "env",
          ["-u", "GITLAB_TOKEN", "-u", "GITLAB_ACCESS_TOKEN", "-u", "OAUTH_TOKEN", "glab", ...args],
          cwd,
        )
      : run("glab", [...args], cwd);
  const value = <R>(key: string, run: Runner<R>, cwd: string) =>
    Effect.map(glab(["config", "get", key, "--host", host], run, cwd), (ran) =>
      ran.code === 0 ? Str.trim(ran.stdout) : "",
    );
  const returned: ForgeLogin = {
    forge: "gitlab",
    host,
    key: stored ? `${host} stored` : host,
    display: "GitLab",
    cli: "glab",
    notReady: `glab is not logged in to ${host}`,
    relogin: `${GLAB_RELOGIN} --hostname ${host}`,
    expiry: (run, cwd) =>
      Effect.map(value("oauth2_expiry_date", run, cwd), (said) =>
        said === "" ? null : glabExpiry(said),
      ),
    token: (run, cwd) =>
      Effect.map(value("token", run, cwd), (said) => (said === "" ? null : said)),
    // WARNING: glab refreshes an expired OAuth token only when it builds an API client.
    refresh: (run, cwd) =>
      Effect.map(run("glab", ["auth", "status", "--hostname", host], cwd), (ran) => ran.code === 0),
  };
  return returned;
}

export const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// WARNING: glab writes expiry in Go's RFC 822 layout, in the Machine's own zone.
export function glabExpiry(said: string) {
  const m = /^(\d{2}) (\w{3}) (\d{2}) (\d{2}):(\d{2}) (\S+)$/.exec(Str.trim(said));
  if (m === null) {
    return null;
  }
  const [, day, month, year, hour, minute, zone = ""] = m;
  const offset = /^([+-])(\d{2})(\d{2})$/.exec(zone);
  const timeZone =
    zone === "UTC" || zone === "GMT"
      ? 0
      : offset === null
        ? DateTime.zoneMakeLocal()
        : (offset[1] === "-" ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3])) * 60_000;
  const at = DateTime.makeZoned(
    {
      year: 2000 + Number(year),
      month: MONTHS.indexOf(month!) + 1,
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
    },
    { timeZone, adjustForTimeZone: true },
  );
  return MONTHS.includes(month!) ? Option.getOrNull(Option.map(at, DateTime.toEpochMillis)) : null;
}

type Rest = <S extends Schema.Decoder<unknown>>(
  schema: S,
  route: string,
) => Effect.Effect<Answered<S["Type"]>, never, ForgeHttp>;

const projectRest = (ref: MrRef, cwd: string) => {
  const host = hostOf(ref.project);
  if (host === null || ref.project === null) {
    return { ok: false, reason: `${whereOf(ref)} names no GitLab project` } as const;
  }
  const login = glabLoginTo(host);
  const project = `projects/${encodeURIComponent(pipe(ref.project, Str.slice(host.length + 1)))}`;
  const rest: Rest = (schema, route) => requestAs(schema, login, cwd, `${project}/${route}`);
  return { ok: true, login, project, rest } as const;
};

type Reached = Extract<ReturnType<typeof projectRest>, { ok: true }>;

const pipelineJobs = (reached: Reached, cwd: string, id: number) =>
  pagesAs(Job, reached.login, cwd, `${reached.project}/pipelines/${id}/jobs?include_retried=true`);

const jobIn = (reached: Reached, cwd: string, id: number, name: string) =>
  Effect.map(pipelineJobs(reached, cwd, id), (listed) => {
    if (!listed.ok) {
      return listed;
    }
    const [found, ...before] = Arr.filter(listed.value, (one) => one.name === name);
    const failed = Arr.filter(before, (one) => one.status === "failed");
    return {
      ok: true,
      value: {
        state: found === undefined ? "missing" : (JOB_STATES.get(found.status) ?? "pending"),
        url: found?.web_url ?? null,
        id: found === undefined ? null : String(found.id),
        retryOf: Arr.map(failed, (one) => String(one.id)),
      },
    } as const;
  });

const plainTrace = (trace: string) =>
  pipe(
    stripVTControlCharacters(
      pipe(trace, Str.replaceAll(/section_(?:start|end):\d+:[^\r\n]*\r/g, "")),
    ),
    Str.replaceAll("\r", ""),
  );

function failedAttempt(ref: MrRef, id: string, cwd: string) {
  return Effect.gen(function* () {
    const unread: FailedAttempt = { url: null, tests: [], jobs: null };
    const reached = projectRest(ref, cwd);
    if (!reached.ok) {
      return unread;
    }
    const attempt = yield* reached.rest(AttemptJob, `jobs/${id}`);
    if (!attempt.ok) {
      return unread;
    }
    const url = attempt.value.web_url ?? null;
    const jobs = yield* pipelineJobs(reached, cwd, attempt.value.pipeline.id);
    if (!jobs.ok) {
      return { url, tests: [], jobs: null };
    }
    const self = Option.getOrUndefined(Arr.findFirst(jobs.value, (one) => String(one.id) === id));
    const ended = (one: typeof Job.Type) => epochMs(one.finished_at ?? "");
    const selfAttempts = pipe(
      jobs.value,
      Arr.filter(
        (one) => one.name === self?.name && one.status === "failed" && !Number.isNaN(ended(one)),
      ),
      Arr.sortWith(ended, Order.Number),
    );
    const attemptOf = (one: typeof Job.Type) =>
      pipe(
        Arr.findFirst(selfAttempts, (attempt) => ended(attempt) >= ended(one)),
        Option.orElse(() => Arr.last(selfAttempts)),
        Option.getOrUndefined,
      );
    const failed = Arr.filter(jobs.value, (one) => {
      if (one.status !== "failed") {
        return false;
      }
      if (self === undefined) {
        return true;
      }
      if (one.name === self.name) {
        return one === self;
      }
      if (Number.isNaN(ended(one)) || Number.isNaN(ended(self))) {
        return true;
      }
      return attemptOf(one) === self;
    });
    const traces = yield* Effect.forEach(failed, (one) =>
      requestText(reached.login, cwd, `${reached.project}/jobs/${one.id}/trace`),
    );
    const named = Arr.map(traces, (trace) =>
      trace.ok ? failedTestsIn(plainTrace(trace.value)) : null,
    );
    const tests = Arr.flatMap(named, (one) => one ?? []);
    const newest = pipe(
      jobs.value,
      Arr.sortWith((one) => -one.id, Order.Number),
      Arr.dedupeWith((a, b) => a.name === b.name),
    );
    return {
      url,
      tests: Arr.dedupeWith(tests, (a, b) => a.name === b.name && a.file === b.file),
      jobs: Arr.flatMap(newest, (one) => {
        const at = failed.indexOf(one);
        return at === -1 ? [] : [{ name: one.name, tests: named[at]! }];
      }),
    };
  });
}

function baseJob(ref: MrRef, name: string, cwd: string) {
  const returned: Effect.Effect<BaseJobRead, never, ForgeHttp> = Effect.gen(function* () {
    const where = whereOf(ref);
    const reached = projectRest(ref, cwd);
    if (!reached.ok) {
      return reached;
    }
    const { rest } = reached;
    const mr = yield* rest(MrBase, `merge_requests/${ref.iid}`);
    if (!mr.ok) {
      return { ok: false, reason: `could not read ${where}: ${mr.reason}` };
    }
    const base = mr.value.diff_refs?.base_sha;
    const target = mr.value.target_branch;
    if (!base || !target) {
      return {
        ok: false,
        reason: `GitLab would not say where ${where} leaves its target branch`,
      };
    }
    const latest = (query: string) =>
      Effect.map(rest(Pipelines, `pipelines?${query}&per_page=1`), (listed) =>
        listed.ok ? ({ ok: true, value: listed.value[0] } as const) : listed,
      );
    const at = yield* latest(`sha=${base}`);
    if (!at.ok) {
      return {
        ok: false,
        reason: `could not list the pipelines of ${where}'s target: ${at.reason}`,
      };
    }
    const tip = at.value === undefined ? yield* latest(`ref=${encodeURIComponent(target)}`) : at;
    if (!tip.ok) {
      return {
        ok: false,
        reason: `could not list the pipelines of ${where}'s target: ${tip.reason}`,
      };
    }
    const pipeline = tip.value;
    if (pipeline === undefined) {
      return {
        ok: false,
        reason: `no pipeline at ${pipe(base, Str.slice(0, 12))} or on ${target}`,
      };
    }
    const found = yield* jobIn(reached, cwd, pipeline.id, name);
    if (!found.ok) {
      return {
        ok: false,
        reason: `could not list the jobs of pipeline ${pipeline.id}: ${found.reason}`,
      };
    }
    return {
      ok: true,
      at: pipeline.sha,
      state: found.value.state,
      url: found.value.url,
      id: found.value.id,
    };
  });
  return returned;
}

function targetJob(ref: MrRef, name: string, cwd: string) {
  const returned: Effect.Effect<TargetJobRead, never, ForgeHttp> = Effect.gen(function* () {
    const where = whereOf(ref);
    const reached = projectRest(ref, cwd);
    if (!reached.ok) {
      return reached;
    }
    const mr = yield* reached.rest(MrBase, `merge_requests/${ref.iid}`);
    if (!mr.ok) {
      return { ok: false, reason: `could not read ${where}: ${mr.reason}` };
    }
    const branch = mr.value.target_branch;
    if (!branch) {
      return { ok: false, reason: `GitLab would not say what ${where} targets` };
    }
    const listed = yield* reached.rest(
      Pipelines,
      `pipelines?ref=${encodeURIComponent(branch)}&per_page=1`,
    );
    if (!listed.ok) {
      return { ok: false, reason: `could not list the pipelines on ${branch}: ${listed.reason}` };
    }
    const pipeline = listed.value[0];
    if (pipeline === undefined) {
      return { ok: true, branch, at: null, state: "missing", url: null, id: null };
    }
    const found = yield* jobIn(reached, cwd, pipeline.id, name);
    if (!found.ok) {
      return {
        ok: false,
        reason: `could not list the jobs of pipeline ${pipeline.id}: ${found.reason}`,
      };
    }
    const { state, url, id } = found.value;
    return { ok: true, branch, at: pipeline.sha, state, url, id };
  });
  return returned;
}

const Username = Schema.Struct({ username: Schema.String });
const ReviewMr = Schema.Struct({
  state: Schema.String,
  sha: optionalText,
  merge_commit_sha: optionalText,
  squash_commit_sha: optionalText,
  merged_at: optionalText,
  merge_user: Schema.optionalKey(Schema.NullOr(Username)),
  merged_by: Schema.optionalKey(Schema.NullOr(Username)),
  head_pipeline: optionalStatus,
  pipeline: optionalStatus,
  detailed_merge_status: optionalText,
  merge_status: optionalText,
  web_url: optionalText,
});
const ApprovalState = Schema.Struct({
  rules: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      approvals_required: Schema.Finite,
      approved_by: Schema.optionalKey(Schema.NullOr(Schema.Array(Username))),
    }),
  ),
});
const ReviewApprovals = Schema.Struct({
  approvals_required: optionalCount,
  approved_by: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Struct({ user: Username })))),
});
const Discussions = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    individual_note: Schema.Boolean,
    notes: Schema.Array(
      Schema.Struct({
        id: Schema.Finite,
        body: Schema.String,
        author: Schema.Struct({ username: Schema.String, bot: optionalFlag }),
        created_at: Schema.String,
        system: Schema.Boolean,
        resolvable: optionalFlag,
        resolved: optionalFlag,
        position: Schema.optionalKey(
          Schema.NullOr(
            Schema.Struct({
              new_path: optionalText,
              old_path: optionalText,
              new_line: optionalCount,
              old_line: optionalCount,
            }),
          ),
        ),
      }),
    ),
  }),
);

const TOKEN_BOT = /^(project|group)_\d+_bot(_\w+)?$/;

function approvalOf(
  rules: ReadonlyArray<{
    readonly name: string;
    readonly required: number;
    readonly by: ReadonlyArray<string>;
  }>,
  login: string,
  changesRequested: boolean,
) {
  const requiring = Arr.filter(rules, (rule) => rule.required > 0);
  if (requiring.length === 0) {
    return changesRequested ? "changes were requested" : "";
  }
  return Arr.join(
    Arr.flatMap(requiring, (rule) => {
      const others = Arr.filter(rule.by, (who) => who !== login).length;
      return others >= rule.required
        ? []
        : [
            `${rule.name} needs ${rule.required} approval(s) and has ${others} besides ${login}'s own`,
          ];
    }),
    "; ",
  );
}

function readReview(ref: MrRef, cwd: string) {
  const returned: Effect.Effect<ReviewRead, never, ForgeHttp> = Effect.gen(function* () {
    const where = whereOf(ref);
    const reached = projectRest(ref, cwd);
    if (!reached.ok) {
      return reached;
    }
    const { rest } = reached;
    const login = yield* viewerLogin(reached.login, cwd);
    if (login === null) {
      return { ok: false, reason: "glab will not say who it is logged in as" };
    }
    const route = `merge_requests/${ref.iid}`;
    const mr = yield* rest(ReviewMr, route);
    if (!mr.ok) {
      return mr;
    }
    const approved = yield* rest(ReviewApprovals, `${route}/approvals`);
    if (!approved.ok) {
      return approved;
    }
    const listed = Arr.map(approved.value.approved_by ?? [], (one) => one.user.username);
    // WARNING: approval state is a Premium or Ultimate feature; elsewhere approvals read as one rule.
    const state = yield* rest(ApprovalState, `${route}/approval_state`);
    const rules = !state.ok
      ? [
          {
            name: "the merge request",
            required: approved.value.approvals_required ?? 0,
            by: listed,
          },
        ]
      : Arr.map(state.value.rules, (rule) => ({
          name: `rule "${rule.name}"`,
          required: rule.approvals_required,
          by: Arr.map(rule.approved_by ?? [], (one) => one.username),
        }));
    // WARNING: names bound to a release come from the same snapshot as its required approvals.
    const approvers =
      state.ok && rules.length > 0 ? Arr.dedupe(Arr.flatMap(rules, (rule) => rule.by)) : listed;
    const comments: Array<ForgeComment> = [];
    const resolved = new Set<string>();
    const web = mr.value.web_url ?? mrWords(ref).url ?? "";
    for (let page = 1; ; page++) {
      const discussions = yield* rest(
        Discussions,
        `${route}/discussions?per_page=${PAGE}&page=${page}`,
      );
      if (!discussions.ok) {
        return {
          ok: false,
          reason: `could not read ${where}'s discussions: ${discussions.reason}`,
        };
      }
      for (const discussion of discussions.value) {
        const thread = discussion.individual_note ? null : discussion.id;
        const resolvable = Arr.filter(discussion.notes, (note) => note.resolvable === true);
        if (
          thread !== null &&
          resolvable.length > 0 &&
          Arr.every(resolvable, (note) => Boolean(note.resolved))
        ) {
          resolved.add(thread);
        }
        for (const note of discussion.notes) {
          comments.push({
            id: String(note.id),
            url: `${web}#note_${note.id}`,
            thread,
            author: note.author.username,
            kind: note.system
              ? "system"
              : note.author.bot === true || TOKEN_BOT.test(note.author.username)
                ? "bot"
                : "person",
            at: note.created_at,
            body: note.body,
            file: note.position?.new_path ?? note.position?.old_path ?? null,
            line: note.position?.new_line ?? note.position?.old_line ?? null,
          });
        }
      }
      if (discussions.value.length < PAGE) {
        break;
      }
    }
    const said = mr.value;
    const changesRequested = said.detailed_merge_status === "requested_changes";
    const unapproved = approvalOf(rules, login, changesRequested);
    const head = said.sha ?? "";
    return {
      ok: true,
      login,
      state: said.state === "merged" ? "merged" : said.state === "opened" ? "open" : "closed",
      head,
      merged:
        said.state === "merged"
          ? {
              sha: said.merge_commit_sha ?? said.squash_commit_sha ?? head,
              by: said.merge_user?.username ?? said.merged_by?.username ?? "",
              at: said.merged_at ?? "",
            }
          : null,
      approved: unapproved === "",
      unapproved,
      approvers: Arr.filter(approvers, (who) => who !== login),
      changesRequested,
      mergeable: mergeabilityOf(said.detailed_merge_status, said.merge_status) ?? null,
      pipeline: headChecks(said.head_pipeline ?? said.pipeline ?? null, head),
      comments: judgeComments(comments, login, resolved),
    };
  });
  return returned;
}

function reply(ref: MrRef, to: Pick<ForgeComment, "thread">, body: string, cwd: string) {
  return Effect.gen(function* () {
    const reached = projectRest(ref, cwd);
    if (!reached.ok) {
      return reached;
    }
    const route =
      to.thread === null
        ? `merge_requests/${ref.iid}/notes`
        : `merge_requests/${ref.iid}/discussions/${encodeURIComponent(to.thread)}/notes`;
    const posted = yield* request(reached.login, cwd, "POST", `${reached.project}/${route}`, {
      body,
    });
    return posted.ok
      ? { ok: true, reason: "" }
      : {
          ok: false,
          reason: `could not reply on ${whereOf(ref)}: ${posted.reason}; inspect the thread before retrying, since the reply may have landed`,
        };
  });
}

// WARNING: a merge at the same head may or may not clear this failure.
const unmerged: (
  failed: Extract<Answered<unknown>, { ok: false }>,
  reason: string,
) => MergeAnswer = (failed, reason) => ({
  _tag:
    failed.transient === true ||
    (failed.status === 422 && Str.includes("Branch cannot be merged")(failed.reason))
      ? "Transient"
      : "Refused",
  reason,
});

// WARNING: never `glab mr merge`, whose --auto-merge defaults on.
function merge(ref: MrRef, head: string, cwd: string) {
  const returned: Effect.Effect<MergeAnswer, never, ForgeHttp> = Effect.gen(function* () {
    const where = whereOf(ref);
    const reached = projectRest(ref, cwd);
    if (!reached.ok) {
      return { _tag: "Refused", reason: reached.reason };
    }
    const route = `merge_requests/${ref.iid}`;
    const merging = yield* request(reached.login, cwd, "PUT", `${reached.project}/${route}/merge`, {
      sha: head,
    });
    const after = yield* reached.rest(ReviewMr, route);
    const mr = after.ok ? after.value : null;
    const mergedSha = (said: typeof ReviewMr.Type) =>
      said.merge_commit_sha ?? said.squash_commit_sha ?? said.sha ?? "";
    if (merging.ok) {
      const merged = mr ?? Option.getOrNull(Schema.decodeUnknownOption(ReviewMr)(merging.value));
      return { _tag: "Merged", merged: merged === null ? "" : mergedSha(merged) };
    }
    const refusal = unmerged(merging, `GitLab refused to merge ${where}: ${merging.reason}`);
    if (mr === null) {
      return refusal;
    }
    if (mr.state === "merged") {
      return {
        _tag: "AlreadyMerged",
        merged: mergedSha(mr),
        head: mr.sha ?? "",
        by: mr.merge_user?.username ?? mr.merged_by?.username ?? "",
        at: mr.merged_at ?? "",
      };
    }
    if ((mr.sha ?? "") !== head) {
      return { _tag: "HeadMoved", head: mr.sha ?? "" };
    }
    return refusal;
  });
  return returned;
}

function retryJob(ref: MrRef, id: string, cwd: string) {
  return Effect.gen(function* () {
    const reached = projectRest(ref, cwd);
    if (!reached.ok) {
      return reached;
    }
    const ran = yield* request(reached.login, cwd, "POST", `${reached.project}/jobs/${id}/retry`);
    return ran.ok
      ? { ok: true, reason: "" }
      : { ok: false, reason: `could not retry job ${id} of ${whereOf(ref)}: ${ran.reason}` };
  });
}

const ShaPipelines = Schema.Array(Schema.Struct({ status: Schema.String, web_url: optionalText }));
const SourceBranch = Schema.Struct({ source_branch: optionalText });
const StartedPipeline = Schema.Struct({
  web_url: optionalText,
  sha: optionalText,
  ref: optionalText,
});

function startPipeline(ref: MrRef, head: string, cwd: string) {
  const returned: Effect.Effect<PipelineStart, never, ForgeHttp> = Effect.gen(function* () {
    const where = whereOf(ref);
    const reached = projectRest(ref, cwd);
    if (!reached.ok) {
      return { _tag: "Failed", reason: reached.reason };
    }
    const { rest, login, project } = reached;
    const on = yield* rest(ShaPipelines, `pipelines?sha=${head}`);
    if (!on.ok) {
      return { _tag: "Failed", reason: `could not list the pipelines on ${head}: ${on.reason}` };
    }
    const running = Arr.findFirst(on.value, (one) => one.status !== "skipped");
    if (Option.isSome(running)) {
      return { _tag: "Has", url: running.value.web_url ?? "" };
    }
    const started = (answer: Answered<unknown>) =>
      Effect.gen(function* () {
        if (!answer.ok) {
          return {
            _tag: "Failed",
            reason: `could not start a pipeline for ${where}: ${answer.reason}`,
          } as const;
        }
        const pipeline = Option.getOrUndefined(
          Schema.decodeUnknownOption(StartedPipeline)(answer.value),
        );
        const url = pipeline?.web_url ?? "";
        const sha = pipeline?.sha ?? "";
        if (sha === head) {
          return { _tag: "Started", url } as const;
        }
        const merged =
          pipeline?.ref === `refs/merge-requests/${ref.iid}/merge`
            ? yield* rest(Commit, `repository/commits/${sha}`)
            : null;
        if (merged?.ok === true && merged.value.parent_ids[1] === head) {
          return { _tag: "Started", url } as const;
        }
        return {
          _tag: "Failed",
          reason: `GitLab started ${url || "a pipeline"} for ${where} on ${sha === "" ? "a revision it did not name" : pipe(sha, Str.slice(0, 12))}, not on ${pipe(head, Str.slice(0, 12))}`,
        } as const;
      });
    const asMr = yield* request(
      login,
      cwd,
      "POST",
      `${project}/merge_requests/${ref.iid}/pipelines`,
    );
    if (asMr.ok || asMr.status !== 400) {
      return yield* started(asMr);
    }
    const mr = yield* rest(SourceBranch, `merge_requests/${ref.iid}`);
    if (!mr.ok || !mr.value.source_branch) {
      return {
        _tag: "Failed",
        reason: `could not read ${where}'s source branch: ${mr.ok ? "GitLab named none" : mr.reason}`,
      };
    }
    const asBranch = yield* request(
      login,
      cwd,
      "POST",
      `${project}/pipeline?ref=${encodeURIComponent(mr.value.source_branch)}`,
    );
    if (!asBranch.ok && asBranch.status === 400) {
      return { _tag: "NoneByRules", message: asBranch.reason };
    }
    return yield* started(asBranch);
  });
  return returned;
}

const jobLog = (ref: MrRef, id: string) =>
  Result.getOrThrow(CommandLine.join(["glab", "ci", "trace", id, ...repoArgs(ref.project)]));

function template(cwd: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return (yield* fs.exists(path.join(cwd, MR_TEMPLATE))) ? MR_TEMPLATE : null;
  });
}

const PipelineState = Schema.Struct({ status: Schema.String });

function pipelineStatus(url: string, cwd: string) {
  return Effect.gen(function* () {
    const m = /^https?:\/\/([^/\s]+)\/(.+?)\/-\/pipelines\/(\d+)(?:[/?#]\S*)?$/.exec(Str.trim(url));
    if (!m) {
      return null;
    }
    const [, host, project, id] = m;
    // WARNING: the address is agent text; only a host the human logged glab in to is asked.
    const said = yield* requestAs(
      PipelineState,
      glabLoginTo(host!, true),
      cwd,
      `projects/${encodeURIComponent(project!)}/pipelines/${id}`,
    );
    return said.ok ? said.value.status : null;
  });
}

const PipelineIdentity = Schema.Struct({
  status: Schema.String,
  ref: Schema.String,
  sha: Schema.String,
});

function tagPipeline(ref: MrRef, tag: string, cwd: string) {
  const returned: Effect.Effect<TagPipelineRead, never, ForgeHttp> = Effect.gen(function* () {
    const reached = projectRest(ref, cwd);
    if (!reached.ok) {
      return reached;
    }
    const pipelines = yield* reached.rest(
      Pipelines,
      `pipelines?ref=${encodeURIComponent(tag)}&order_by=id&sort=desc&per_page=1`,
    );
    if (!pipelines.ok) {
      return pipelines;
    }
    const newest = pipelines.value[0];
    return {
      ok: true,
      url: newest === undefined ? null : `https://${ref.project}/-/pipelines/${newest.id}`,
    };
  });
  return returned;
}

function pipeline(url: string, cwd: string) {
  const returned: Effect.Effect<PipelineRead, never, ForgeHttp> = Effect.gen(function* () {
    const m = /^https?:\/\/([^/\s]+)\/(.+?)\/-\/pipelines\/(\d+)(?:[/?#]\S*)?$/.exec(Str.trim(url));
    if (!m) {
      return { ok: false, reason: `${url} is not a GitLab pipeline` };
    }
    const [, host, project, id] = m;
    const login = glabLoginTo(host!, true);
    const route = `projects/${encodeURIComponent(project!)}/pipelines/${id}`;
    const status = yield* requestAs(PipelineIdentity, login, cwd, route);
    if (!status.ok) {
      return status;
    }
    const jobs: Array<(typeof Jobs.Type)[number]> = [];
    for (let page = 1; ; page++) {
      const some = yield* requestAs(Jobs, login, cwd, `${route}/jobs?per_page=100&page=${page}`);
      if (!some.ok) {
        return some;
      }
      jobs.push(...some.value);
      if (some.value.length < 100) {
        break;
      }
    }
    return {
      ok: true,
      succeeded: status.value.status === "success",
      project: `${host}/${project}`,
      ref: status.value.ref,
      sha: status.value.sha,
      jobs: Arr.map(jobs, (one) => ({
        name: one.name,
        state: one.status === "manual" ? "manual" : (JOB_STATES.get(one.status) ?? "pending"),
        url: one.web_url ?? null,
      })),
    };
  });
  return returned;
}

function clone<R>(project: string, into: string, cwd: string, run: Runner<R>) {
  return Effect.gen(function* () {
    const host = hostOf(project) ?? Str.split(project, "/")[0];
    const token = Str.trim(
      (yield* run("glab", ["config", "get", "token", "--host", host], cwd)).stdout,
    );
    if (token === "") {
      return { ok: false, reason: `could not authenticate to ${host}` };
    }
    const credentials = Buffer.from(`oauth2:${token}`).toString("base64");
    const cloned = yield* run("git", ["clone", "--quiet", `https://${project}.git`, into], cwd, {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.extraHeader",
      GIT_CONFIG_VALUE_0: Redacted.make(`Authorization: Basic ${credentials}`),
    });
    return cloned.code === 0
      ? { ok: true, reason: "" }
      : { ok: false, reason: whatItSaid(cloned) || "git clone failed" };
  });
}

export const gitlab: Forge = {
  name: "gitlab",
  reviewChanges: (ref, previous, head, cwd, run) =>
    Effect.gen(function* () {
      const project = ref.project ?? (yield* projectHere(cwd, run));
      if (project === null) {
        return { ok: false, reason: `${whereOf(ref)} names no GitLab project` };
      }
      return yield* reviewChanges(
        glabLoginTo(hostOf(project) ?? "gitlab.com"),
        project,
        ref,
        previous,
        head,
        cwd,
      );
    }),
  issues: (project, cwd, _run, which) =>
    listIssues(glabLoginTo(hostOf(project) ?? "gitlab.com"), project, cwd, which),
  requests: (project, cwd) =>
    listRequests(glabLoginTo(hostOf(project) ?? "gitlab.com"), project, cwd),
  fileIssue: (project, title, body, cwd) =>
    createIssue(glabLoginTo(hostOf(project) ?? "gitlab.com"), project, title, body, cwd),
  commentIssue: (project, number, body, cwd) =>
    commentIssue(glabLoginTo(hostOf(project) ?? "gitlab.com"), project, number, body, cwd),
  tagPipeline,
  clone,
  credentials: (project, into, run) => {
    const host = hostOf(project) ?? Str.split(project, "/")[0];
    return keepCredentialHelper(
      into,
      host,
      `!f() { test "$1" = get || exit 0; echo username=oauth2; echo "password=$(glab config get token --host ${Result.getOrThrow(CommandLine.quote(host))})"; }; f`,
      run,
    );
  },
  display: "GitLab",
  cli: "glab",
  runStatus: pipelineStatus,
  pipeline,
  noun: "merge request",
  webUrl: (project) => `https://${project}`,
  forBranch,
  fromBranch,
  protects,
  job,
  baseJob,
  targetJob,
  retryJob,
  failedAttempt,
  startPipeline,
  jobLog,
  template,
  create: (options, cwd, run) =>
    Effect.gen(function* () {
      const made = yield* run(
        "glab",
        [
          "mr",
          "create",
          "--repo",
          options.project,
          "--source-branch",
          options.branch,
          "--assignee",
          options.assignee,
          ...(options.onto ? ["--target-branch", options.onto] : []),
          "--title",
          options.title,
          "--description",
          options.body,
          "--yes",
        ],
        cwd,
      );
      const url = /https?:\/\/[^\s]+\/-\/merge_requests\/\d+/.exec(made.stdout)?.[0];
      return made.code === 0 && url !== undefined
        ? { ok: true as const, url }
        : {
            ok: false as const,
            reason: whatItSaid(made) || "glab did not return a merge request URL",
          };
    }),
  ready: gitlabForProject,
  login: glabLogin,
  details: mrDetails,
  liveTier,
  deployed,
  stagingEnvironments,
  readReview,
  reply,
  merge,
  approve: (ref, head, cwd, run) =>
    Effect.gen(function* () {
      const project = ref.project ?? (yield* projectHere(cwd, run));
      if (project === null) {
        return { ok: false, message: `${whereOf(ref)} names no GitLab project` };
      }
      return yield* approveReview(
        glabLoginTo(hostOf(project) ?? "gitlab.com"),
        project,
        ref,
        head,
        cwd,
      );
    }),
  descends: (ref, previous, head, cwd, run) =>
    Effect.gen(function* () {
      const project = ref.project ?? (yield* projectHere(cwd, run));
      if (project === null) {
        return { ok: false, reason: `${whereOf(ref)} names no GitLab project` };
      }
      return yield* descendsFrom(
        glabLoginTo(hostOf(project) ?? "gitlab.com"),
        project,
        previous,
        head,
        cwd,
      );
    }),
  approvedAt: (ref, login, head, cwd, run) =>
    Effect.gen(function* () {
      const project = ref.project ?? (yield* projectHere(cwd, run));
      if (project === null) {
        return { ok: false, reason: `${whereOf(ref)} names no GitLab project` };
      }
      return yield* approvedAt(
        glabLoginTo(hostOf(project) ?? "gitlab.com"),
        project,
        ref,
        login,
        head,
        cwd,
      );
    }),
  findNote: (ref, signature, cwd, run) =>
    Effect.gen(function* () {
      const project = ref.project ?? (yield* projectHere(cwd, run));
      if (project === null) {
        return { ok: false, reason: `${whereOf(ref)} names no GitLab project` };
      }
      return yield* findReviewNote(
        glabLoginTo(hostOf(project) ?? "gitlab.com"),
        project,
        ref,
        signature,
        cwd,
      );
    }),
  post: (ref, body, cwd, run) =>
    Effect.gen(function* () {
      const project = ref.project ?? (yield* projectHere(cwd, run));
      if (project === null) {
        return { ok: false, message: `${whereOf(ref)} names no GitLab project` };
      }
      return yield* postReview(
        glabLoginTo(hostOf(project) ?? "gitlab.com"),
        project,
        ref,
        body,
        cwd,
      );
    }),
  reviewRequests: (host, login, cwd) => reviewRequests(host, login, cwd),
  mine: (named, cwd, run) =>
    Effect.gen(function* () {
      const project = named ?? (yield* projectHere(cwd, run));
      return project === null
        ? []
        : yield* myMergeRequests(glabLoginTo(hostOf(project) ?? "gitlab.com"), project, cwd);
    }),
  open: (ref, cwd, run) =>
    run("glab", ["mr", "view", ref.iid, ...repoArgs(ref.project), "--web"], cwd),
  review: (ref) => {
    const glab = (verb: string, ...rest: ReadonlyArray<string>) =>
      Result.getOrThrow(
        CommandLine.join(["glab", "mr", verb, ref.iid, ...repoArgs(ref.project), ...rest]),
      );
    return {
      diff: glab("diff"),
      view: glab("view", "--comments"),
      checkout: glab("checkout"),
    };
  },
};
