// The GitLab adapter: everything Collie asks GitLab, through `glab` or over HTTP with
// glab's token.

import { DateTime, Effect, FileSystem, Option, Path, Schema } from "effect";
import {
  mrPath,
  mrWords,
  type ForgeChecks,
  type Mergeability,
  type MrDetails,
  type MrPanel,
  type MrRef,
  type MrUnavailable,
} from "../board-model";
import { epochMs } from "../time";
import { keepCredentialHelper, projectHere, whatItSaid, type Runner } from "../mr";
import { shellQuote } from "../script";
import type {
  DeployTier,
  DeployedRead,
  StagingEnvironment,
  StagingRead,
  Forge,
  ForBranch,
  FromBranch,
  FromBranchList,
  BaseJobRead,
  JobRead,
  JobState,
  PipelineRead,
  TagPipelineRead,
  Readiness,
} from "./forge";
import { ForgeHttp, pagesAs, request, requestAs, type Answered, type ForgeLogin } from "./http";
import {
  listIssues,
  createIssue,
  commentIssue,
  postReview,
  viewerLogin,
  myMergeRequests,
} from "./threads";
import { judgeComments, type ForgeComment, type MergeAnswer, type ReviewRead } from "./review";

export const MR_TEMPLATE = ".gitlab/merge_request_templates/default.md";

/** The glab arguments that point a command at a project rather than at the cwd. */
export function repoArgs(project: string | null): string[] {
  return project ? ["--repo", project] : [];
}

/** `group/project!42`, with its host, as a note's message names it. */
const whereOf = (ref: MrRef) => (ref.project ? `${ref.project}!${ref.iid}` : `!${ref.iid}`);

/** The host part of `host/group/project`, which is what glab authenticates against. */
export function hostOf(project: string | null): string | null {
  const host = project?.split("/")[0];
  return host && host.includes(".") ? host : null;
}

/**
 * Absent and `null` are the same answer here, and GitLab gives both: a merge request with
 * no second pipeline sends `"pipeline": null`, not a missing key. A schema that allowed
 * the key to be omitted but not null rejected real merge requests outright, and the panel
 * reported one it had just read successfully as "not a merge request" — then cached that
 * for the whole TTL. Every field a GitLab version or a token might not answer is optional
 * *and* nullable for that reason.
 */
const optionalText = Schema.optionalKey(Schema.NullOr(Schema.String));
const optionalFlag = Schema.optionalKey(Schema.NullOr(Schema.Boolean));
const optionalCount = Schema.optionalKey(Schema.NullOr(Schema.Number));
const optionalStatus = Schema.optionalKey(
  Schema.NullOr(Schema.Struct({ status: optionalText, sha: optionalText, web_url: optionalText })),
);

const MrFields = Schema.Struct({
  iid: Schema.optionalKey(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
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
  notes: Schema.Array(Schema.Struct({ resolvable: optionalFlag, resolved: optionalFlag })),
});

/** What GitLab says while it is still working out whether it can merge. */
const SETTLING_MERGE = new Set([
  "checking",
  "unchecked",
  "preparing",
  "approvals_syncing",
  "cannot_be_merged_recheck",
]);

/**
 * GitLab's own answer to "can this merge now", which carries its approval rules: the
 * detailed status where this GitLab has one, else the older `merge_status`.
 */
function mergeabilityOf(
  detailed: string | null | undefined,
  legacy: string | null | undefined,
): Mergeability | undefined {
  const said = detailed ?? (legacy === "can_be_merged" ? "mergeable" : legacy);
  if (said === undefined || said === null || said === "") return undefined;
  const words = said.replaceAll("_", " ");
  if (said === "mergeable") return { state: "mergeable", said: words };
  return { state: SETTLING_MERGE.has(said) ? "unknown" : "blocked", said: words };
}

/**
 * One merge request: the merge request, its approvals and its discussions, asked together.
 *
 * Never called from a render path and never for a list: the app fetches this when a Run
 * with a merge-request target becomes the Selection, and caches it per ref.
 */
export function mrDetails<R>(
  ref: MrRef,
  cwd: string,
  run: Runner<R>,
): Effect.Effect<MrPanel, never, R | ForgeHttp> {
  return Effect.gen(function* () {
    const where = whereOf(ref);
    // A bare `!42` is the checkout's own, as glab read it from the remote.
    const named = ref.project ?? (yield* projectHere(cwd, run));
    const reached = projectRest({ ...ref, project: named }, cwd);
    if (!reached.ok) return { _tag: "Unavailable", reason: reached.reason } satisfies MrUnavailable;
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
    if (!read.ok)
      return {
        _tag: "Unavailable",
        reason: `could not read ${where}: ${read.reason}`,
      } satisfies MrUnavailable;
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
      assignees: (mr.assignees ?? [])
        .map((one) => one.username ?? "")
        .filter((name) => name !== ""),
      sourceBranch: mr.source_branch ?? "",
      fork: mr.source_project_id !== mr.target_project_id,
      targetBranch: mr.target_branch ?? "",
      pipeline,
      checks: headChecks(mr.head_pipeline ?? mr.pipeline ?? null, mr.sha ?? ""),
      approvals: approvals.ok
        ? approvalsOf(approvals.value)
        : approvalsLine(mr.approvals_required, mr.approvals_left),
      unresolved: discussions.ok
        ? discussions.value.some((one) =>
            one.notes.some((note) => note.resolvable === true && note.resolved !== true),
          )
        : mr.blocking_discussions_resolved === false,
      notes: mr.user_notes_count ?? 0,
      headSha: (mr.sha ?? "").slice(0, 7),
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
}

/** A merge request's approvals; one that requires none and has none says nothing. */
const approvalsOf = (approvals: typeof Approvals.Type) =>
  approvals.approvals_required === 0 && (approvals.approved_by ?? []).length === 0
    ? ""
    : approvalsLine(approvals.approvals_required, approvals.approvals_left);

/**
 * Approvals are not on the merge-request object on every GitLab; where neither field is
 * answered the panel says nothing about them rather than guessing at zero.
 */
function approvalsLine(
  requiredOrNull: number | null | undefined,
  leftOrNull: number | null | undefined,
): string {
  const required = requiredOrNull ?? undefined;
  const left = leftOrNull ?? undefined;
  if (required === undefined && left === undefined) return "";
  if (left === 0) return "approved";
  if (required === undefined) return `${left} still needed`;
  // How many are still needed is the fact this GitLab did not answer, and standing the
  // requirement in for it would claim nobody has approved yet.
  if (left === undefined) return `${required} approval(s) required`;
  return `${left} of ${required} still needed`;
}

/** A pipeline counts for the head it ran on; its own head pipeline need not say which. */
function headChecks(
  pipeline: {
    readonly status?: string | null;
    readonly sha?: string | null;
    readonly web_url?: string | null;
  } | null,
  head: string,
): ForgeChecks {
  if (pipeline === null) return { state: "none" };
  const checks: ForgeChecks =
    pipeline.sha && head !== "" && pipeline.sha !== head
      ? { state: "unknown" }
      : pipelineChecks(pipeline.status ?? "");
  return pipeline.web_url ? { ...checks, url: pipeline.web_url } : checks;
}

/** GitLab's head pipeline status, as the card reads it. */
export function pipelineChecks(status: string): ForgeChecks {
  if (status === "") return { state: "none" };
  if (status === "success" || status === "passed") return { state: "passed" };
  if (status === "failed") return { state: "failed", name: "pipeline" };
  if (
    ["running", "pending", "created", "preparing", "waiting_for_resource", "scheduled"].includes(
      status,
    )
  )
    return { state: "running" };
  return { state: "unknown" };
}

/**
 * What a step pointed at a merge request needs: glab, and glab logged in to that host.
 * The cwd's remotes are none of its business — which forge a checkout is on is decided
 * before an adapter is asked.
 */
export function gitlabForProject<R>(
  project: string | null,
  cwd: string,
  run: Runner<R>,
): Effect.Effect<Readiness, never, R> {
  return Effect.gen(function* () {
    const glab = yield* run("glab", ["--version"], cwd);
    if (glab.code !== 0) return { ok: false, reason: "glab is not installed" };

    const host = hostOf(project);
    if (!host) return { ok: true, reason: "" };
    const auth = yield* run("glab", ["auth", "status", "--hostname", host], cwd);
    return auth.code === 0
      ? { ok: true, reason: "" }
      : { ok: false, reason: `glab is not logged in to ${host}` };
  });
}

/**
 * Whoever glab is logged in as for this checkout's host, and null where it will not
 * say. The authenticated user, not a configured assignee: a branch belongs to whoever
 * is pushing it, and the two are different people whenever an assignee is set at all.
 */
export function glabLogin<R>(
  cwd: string,
  run: Runner<R>,
  project: string | null = null,
): Effect.Effect<string | null, never, R | ForgeHttp> {
  return Effect.gen(function* () {
    const named = project ?? (yield* projectHere(cwd, run));
    return yield* viewerLogin(glabLoginTo(hostOf(named) ?? "gitlab.com"), cwd);
  });
}

const Environments = Schema.Array(Schema.Struct({ name: Schema.String, tier: optionalText }));
const Deployments = Schema.Array(
  Schema.Struct({ sha: Schema.String, environment: Schema.Struct({ name: Schema.String }) }),
);
const MergeBase = Schema.Struct({ id: optionalText });

/**
 * The furthest a merged commit has got: live in production, live on staging, or neither.
 * "Live" is what the newest successful deployment of each environment has on it, which is
 * the commit itself or one descending from it — GitLab's merge-base says which. A project
 * with no staging or production environment answers null, and so does GitLab not
 * answering: the board then says "merged", which is true, rather than guessing further.
 */
export function liveTier(
  ref: MrRef,
  mergedSha: string,
  cwd: string,
): Effect.Effect<DeployTier | null, never, ForgeHttp> {
  return Effect.gen(function* () {
    if (mergedSha === "") return null;
    const api = projectRest(ref, cwd);
    if (!api.ok) return null;
    const environments = yield* api.rest(Environments, "environments");
    if (!environments.ok) return null;
    const tiers = new Map<string, DeployTier>();
    for (const env of environments.value) {
      if (env.tier === "production" || env.tier === "staging") tiers.set(env.name, env.tier);
    }
    if (tiers.size === 0) return null;
    const deployments = yield* api.rest(
      Deployments,
      "deployments?status=success&order_by=created_at&sort=desc&per_page=50",
    );
    if (!deployments.ok) return null;
    // Newest first, so the first deployment seen per environment is what is live there.
    const live = new Map<string, string>();
    for (const deployment of deployments.value) {
      if (tiers.has(deployment.environment.name) && !live.has(deployment.environment.name))
        live.set(deployment.environment.name, deployment.sha);
    }
    const carries = (sha: string) =>
      Effect.gen(function* () {
        if (sha === mergedSha) return true;
        const base = yield* api.rest(
          MergeBase,
          `repository/merge_base?refs[]=${mergedSha}&refs[]=${sha}`,
        );
        return base.ok && base.value.id === mergedSha;
      });
    for (const tier of ["production", "staging"] as const) {
      for (const [name, sha] of live) {
        if (tiers.get(name) === tier && (yield* carries(sha))) return tier;
      }
    }
    return null;
  });
}

/** The commit the newest successful deployment to an environment of `tier` has. */
function deployed(
  ref: MrRef,
  tier: DeployTier,
  cwd: string,
): Effect.Effect<DeployedRead, never, ForgeHttp> {
  return Effect.gen(function* () {
    const reached = projectRest(ref, cwd);
    if (!reached.ok) return reached;
    const { rest } = reached;
    const names = new Set<string>();
    for (let page = 1; ; page++) {
      const listed = yield* rest(Environments, `environments?per_page=100&page=${page}`);
      if (!listed.ok) return listed;
      for (const env of listed.value) if (env.tier === tier) names.add(env.name);
      if (listed.value.length < 100) break;
    }
    if (names.size === 0) return { ok: true, sha: null };
    for (let page = 1; ; page++) {
      const newest = yield* rest(
        Deployments,
        `deployments?status=success&order_by=created_at&sort=desc&per_page=100&page=${page}`,
      );
      if (!newest.ok) return newest;
      const found = newest.value.find((one) => names.has(one.environment.name));
      if (found !== undefined) return { ok: true, sha: found.sha };
      if (newest.value.length < 100) return { ok: true, sha: null };
    }
  });
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
): Effect.Effect<StagingRead, never, ForgeHttp> {
  return Effect.gen(function* () {
    const api = projectRest(ref, cwd);
    if (!api.ok) return api;
    const unread = (reason: string) => ({
      ok: false as const,
      reason: `GitLab could not read ${ref.project}'s stage environments: ${reason}`,
    });
    const names: string[] = [];
    for (let page = 1; ; page++) {
      const listed = yield* api.rest(Environments, `environments?per_page=100&page=${page}`);
      if (!listed.ok) return unread(listed.reason);
      for (const env of listed.value) if (env.tier === "staging") names.push(env.name);
      if (listed.value.length < 100) break;
    }
    const environments: StagingEnvironment[] = [];
    const builtFrom = new Map<string, boolean>();
    for (const name of names) {
      let live: string | null = null;
      let hasCommit = false;
      for (let page = 1; live === null || (commit !== null && !hasCommit); page++) {
        const newest = yield* api.rest(
          Schema.Array(EnvironmentDeployment),
          `deployments?environment=${encodeURIComponent(name)}&order_by=created_at&sort=desc&per_page=100&page=${page}`,
        );
        if (!newest.ok) return unread(newest.reason);
        for (const one of newest.value) {
          if (live === null && one.status === "success") live = one.sha;
          if (hasCommit || commit === null) continue;
          if (jobs !== undefined && !jobs.includes(one.deployable?.name ?? "")) continue;
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
              if (!parents.ok) return unread(parents.reason);
              matches = parents.value.parent_ids.includes(commit);
              builtFrom.set(one.sha, matches);
            }
            hasCommit = matches;
          }
        }
        if (newest.value.length < 100) break;
      }
      environments.push({ name, live, hasCommit });
    }
    return { ok: true, environments };
  });
}

const BranchMr = Schema.Struct({
  iid: Schema.Union([Schema.String, Schema.Number]),
  web_url: optionalText,
  merge_when_pipeline_succeeds: optionalFlag,
  state: Schema.String,
  created_at: Schema.String,
  merged_at: optionalText,
  closed_at: optionalText,
});

/** The merge requests from `branch` into `project`, `opened` or in any state, every page of them. */
const mrsFrom = (
  project: string,
  branch: string,
  state: "opened" | "all",
  cwd: string,
): Effect.Effect<Answered<Array<typeof BranchMr.Type>>, never, ForgeHttp> => {
  const reached = projectRest({ project, iid: "" }, cwd);
  if (!reached.ok) return Effect.succeed({ ok: false, reason: reached.reason });
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

/** The open merge request from `branch`; a failed read is not "none". */
function forBranch(
  project: string,
  branch: string,
  cwd: string,
): Effect.Effect<ForBranch, never, ForgeHttp> {
  return Effect.map(mrsFrom(project, branch, "opened", cwd), (listed) => {
    if (!listed.ok) return listed;
    const mr =
      listed.value.find((one) => one.merge_when_pipeline_succeeds === true) ?? listed.value[0];
    if (mr === undefined) return { ok: true, open: null };
    const iid = String(mr.iid);
    return {
      ok: true,
      open: {
        iid,
        url: mr.web_url ?? `https://${project}/-/merge_requests/${iid}`,
        autoMerge: mr.merge_when_pipeline_succeeds === true,
      },
    };
  });
}

const DefaultBranch = Schema.Struct({ default_branch: Schema.String });
const ProtectedBranch = Schema.Struct({ name: Schema.String });
const PAGE = 100;

/** GitLab's `*` stands for any run of characters, `/` included. */
const wildcard = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`);

/** The default branch, or a protected branch as listed, wildcards matched; null where either is unread. */
function protects(
  project: string,
  branch: string,
  cwd: string,
): Effect.Effect<boolean | null, never, ForgeHttp> {
  return Effect.gen(function* () {
    const host = hostOf(project);
    if (host === null) return null;
    const route = `projects/${encodeURIComponent(project.slice(host.length + 1))}`;
    const login = glabLoginTo(host);
    const repo = yield* requestAs(DefaultBranch, login, cwd, route);
    if (!repo.ok) return null;
    if (repo.value.default_branch === branch) return true;
    const rules = yield* pagesAs(ProtectedBranch, login, cwd, `${route}/protected_branches`);
    if (!rules.ok) return null;
    return rules.value.some((rule) => wildcard(rule.name).test(branch));
  });
}

/** Every merge request from `branch`, whatever its state; a failed read is not "none". */
function fromBranch(
  project: string,
  branch: string,
  cwd: string,
): Effect.Effect<FromBranchList, never, ForgeHttp> {
  return Effect.map(mrsFrom(project, branch, "all", cwd), (listed) => {
    if (!listed.ok) return listed;
    return {
      ok: true,
      mrs: listed.value.map((mr): FromBranch => {
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
  });
}

const MrHead = Schema.Struct({
  sha: optionalText,
  head_pipeline: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ id: Schema.Number, sha: optionalText })),
  ),
});
const Commit = Schema.Struct({ parent_ids: Schema.Array(Schema.String) });
const Jobs = Schema.Array(
  Schema.Struct({
    id: Schema.Number,
    name: Schema.String,
    status: Schema.String,
    web_url: optionalText,
  }),
);
const Pipelines = Schema.Array(Schema.Struct({ id: Schema.Number, sha: Schema.String }));
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
  // Nobody started it, so nothing it would prove ran.
  ["manual", "skipped"],
  ["running", "running"],
]);

/**
 * The job on the merge request's head pipeline. A merged-results pipeline runs on a merge
 * commit, which counts for the head only where GitLab shows that commit's parent is it.
 */
function job(ref: MrRef, name: string, cwd: string): Effect.Effect<JobRead, never, ForgeHttp> {
  return Effect.gen(function* () {
    const where = whereOf(ref);
    const reached = projectRest(ref, cwd);
    if (!reached.ok) return reached;
    const { rest } = reached;
    const mr = yield* rest(MrHead, `merge_requests/${ref.iid}`);
    if (!mr.ok) return { ok: false, reason: `could not read ${where}: ${mr.reason}` };
    const head = mr.value.sha ?? "";
    const pipeline = mr.value.head_pipeline ?? null;
    const waiting = { ok: true, head, state: "pending", url: null, id: null, merge: null } as const;
    if (pipeline === null) return waiting;
    let merge: string | null = null;
    if (pipeline.sha && pipeline.sha !== head) {
      const commit = yield* rest(Commit, `repository/commits/${pipeline.sha}`);
      if (!commit.ok)
        return {
          ok: false,
          reason: `GitLab would not say which head ${where}'s pipeline ${pipeline.id} at ${pipeline.sha} was built from: ${commit.reason}`,
        };
      // An older head's: this head's pipeline has not started.
      if (!commit.value.parent_ids.includes(head)) return waiting;
      merge = pipeline.sha;
    }
    const found = yield* jobIn(rest, pipeline.id, name);
    if (!found.ok)
      return {
        ok: false,
        reason: `could not list the jobs of ${where}'s pipeline ${pipeline.id}: ${found.reason}`,
      };
    return { ok: true, head, ...found.value, merge };
  });
}

/** glab's login to `host`, which ForgeHttp asks GitLab with. */
export function glabLoginTo(host: string, stored = false): ForgeLogin {
  // glab answers a token in its environment for any host; a stored login is the host's own.
  const glab = (args: ReadonlyArray<string>, run: Runner, cwd: string) =>
    stored
      ? run(
          "env",
          ["-u", "GITLAB_TOKEN", "-u", "GITLAB_ACCESS_TOKEN", "-u", "OAUTH_TOKEN", "glab", ...args],
          cwd,
        )
      : run("glab", [...args], cwd);
  const value = (key: string, run: Runner, cwd: string) =>
    Effect.map(glab(["config", "get", key, "--host", host], run, cwd), (ran) =>
      ran.code === 0 ? ran.stdout.trim() : "",
    );
  return {
    forge: "gitlab",
    host,
    key: stored ? `${host} stored` : host,
    display: "GitLab",
    cli: "glab",
    notReady: `glab is not logged in to ${host}`,
    relogin: `glab auth login --hostname ${host}`,
    // Empty for a personal access token, which does not expire.
    expiry: (run, cwd) =>
      Effect.map(value("oauth2_expiry_date", run, cwd), (said) =>
        said === "" ? null : glabExpiry(said),
      ),
    token: (run, cwd) =>
      Effect.map(value("token", run, cwd), (said) => (said === "" ? null : said)),
    // glab refreshes an expired OAuth token only when it builds an API client, as this does.
    refresh: (run, cwd) =>
      Effect.map(run("glab", ["auth", "status", "--hostname", host], cwd), (ran) => ran.code === 0),
  };
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

/**
 * When an OAuth token glab stored expires: Go's RFC 822, `02 Jan 06 15:04 MST`, written in
 * the Machine's own zone, so a zone named by its abbreviation is this Machine's.
 */
export function glabExpiry(said: string): number | null {
  const m = /^(\d{2}) (\w{3}) (\d{2}) (\d{2}):(\d{2}) (\S+)$/.exec(said.trim());
  if (m === null) return null;
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

/** A GET of a route under one project, its body read as `schema`. */
type Rest = <S extends Schema.Decoder<unknown>>(
  schema: S,
  route: string,
) => Effect.Effect<Answered<S["Type"]>, never, ForgeHttp>;

/** Requests to the merge request's project, as its host's glab login, or why there are none. */
const projectRest = (ref: MrRef, cwd: string) => {
  const host = hostOf(ref.project);
  if (host === null || ref.project === null)
    return { ok: false, reason: `${whereOf(ref)} names no GitLab project` } as const;
  const login = glabLoginTo(host);
  const project = `projects/${encodeURIComponent(ref.project.slice(host.length + 1))}`;
  const rest: Rest = (schema, route) => requestAs(schema, login, cwd, `${project}/${route}`);
  return { ok: true, login, project, rest } as const;
};

const jobIn = (rest: Rest, id: number, name: string) =>
  Effect.gen(function* () {
    let found: (typeof Jobs.Type)[number] | undefined;
    for (let page = 1; found === undefined; page++) {
      const jobs = yield* rest(Jobs, `pipelines/${id}/jobs?per_page=100&page=${page}`);
      if (!jobs.ok) return jobs;
      found = jobs.value.find((one) => one.name === name);
      if (jobs.value.length < 100) break;
    }
    return {
      ok: true,
      value: {
        state: found === undefined ? "missing" : (JOB_STATES.get(found.status) ?? "pending"),
        url: found?.web_url ?? null,
        id: found === undefined ? null : String(found.id),
      },
    } as const;
  });

/** The job at the merge request's merge-base pipeline, else on its target branch's latest. */
function baseJob(
  ref: MrRef,
  name: string,
  cwd: string,
): Effect.Effect<BaseJobRead, never, ForgeHttp> {
  return Effect.gen(function* () {
    const where = whereOf(ref);
    const reached = projectRest(ref, cwd);
    if (!reached.ok) return reached;
    const { rest } = reached;
    const mr = yield* rest(MrBase, `merge_requests/${ref.iid}`);
    if (!mr.ok) return { ok: false, reason: `could not read ${where}: ${mr.reason}` };
    const base = mr.value.diff_refs?.base_sha;
    const target = mr.value.target_branch;
    if (!base || !target)
      return { ok: false, reason: `GitLab would not say where ${where} leaves its target branch` };
    const latest = (query: string) =>
      Effect.map(rest(Pipelines, `pipelines?${query}&per_page=1`), (listed) =>
        listed.ok ? ({ ok: true, value: listed.value[0] } as const) : listed,
      );
    const at = yield* latest(`sha=${base}`);
    if (!at.ok)
      return {
        ok: false,
        reason: `could not list the pipelines of ${where}'s target: ${at.reason}`,
      };
    const tip = at.value === undefined ? yield* latest(`ref=${encodeURIComponent(target)}`) : at;
    if (!tip.ok)
      return {
        ok: false,
        reason: `could not list the pipelines of ${where}'s target: ${tip.reason}`,
      };
    const pipeline = tip.value;
    if (pipeline === undefined)
      return { ok: false, reason: `no pipeline at ${base.slice(0, 12)} or on ${target}` };
    const found = yield* jobIn(rest, pipeline.id, name);
    if (!found.ok)
      return {
        ok: false,
        reason: `could not list the jobs of pipeline ${pipeline.id}: ${found.reason}`,
      };
    return { ok: true, at: pipeline.sha, state: found.value.state, url: found.value.url };
  });
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
      approvals_required: Schema.Number,
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
        id: Schema.Number,
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

/** A project or group access token's user. */
const TOKEN_BOT = /^(project|group)_\d+_bot(_\w+)?$/;

/** Each rule's requirement, counted again without `login`'s approval. */
function approvalOf(
  rules: ReadonlyArray<{
    readonly name: string;
    readonly required: number;
    readonly by: ReadonlyArray<string>;
  }>,
  login: string,
  changesRequested: boolean,
): string {
  const requiring = rules.filter((rule) => rule.required > 0);
  if (requiring.length === 0) return changesRequested ? "changes were requested" : "";
  return requiring
    .flatMap((rule) => {
      const others = rule.by.filter((who) => who !== login).length;
      return others >= rule.required
        ? []
        : [
            `${rule.name} needs ${rule.required} approval(s) and has ${others} besides ${login}'s own`,
          ];
    })
    .join("; ");
}

/**
 * The merge request, its approvals (rule by rule where this GitLab has approval state) and
 * every page of its discussions.
 */
function readReview(ref: MrRef, cwd: string): Effect.Effect<ReviewRead, never, ForgeHttp> {
  return Effect.gen(function* () {
    const where = whereOf(ref);
    const reached = projectRest(ref, cwd);
    if (!reached.ok) return reached;
    const { rest } = reached;
    const login = yield* viewerLogin(reached.login, cwd);
    if (login === null) return { ok: false, reason: "glab will not say who it is logged in as" };
    const route = `merge_requests/${ref.iid}`;
    const mr = yield* rest(ReviewMr, route);
    if (!mr.ok) return mr;
    const approved = yield* rest(ReviewApprovals, `${route}/approvals`);
    if (!approved.ok) return approved;
    const approvers = (approved.value.approved_by ?? []).map((one) => one.user.username);
    // Approval state is Premium's and Ultimate's; elsewhere the approvals read is one rule.
    const state = yield* rest(ApprovalState, `${route}/approval_state`);
    const rules = !state.ok
      ? [
          {
            name: "the merge request",
            required: approved.value.approvals_required ?? 0,
            by: approvers,
          },
        ]
      : state.value.rules.map((rule) => ({
          name: `rule "${rule.name}"`,
          required: rule.approvals_required,
          by: (rule.approved_by ?? []).map((one) => one.username),
        }));
    const comments: ForgeComment[] = [];
    const resolved = new Set<string>();
    const web = mr.value.web_url ?? mrWords(ref).url ?? "";
    for (let page = 1; ; page++) {
      const discussions = yield* rest(
        Discussions,
        `${route}/discussions?per_page=${PAGE}&page=${page}`,
      );
      if (!discussions.ok)
        return {
          ok: false,
          reason: `could not read ${where}'s discussions: ${discussions.reason}`,
        };
      for (const discussion of discussions.value) {
        const thread = discussion.individual_note ? null : discussion.id;
        const resolvable = discussion.notes.filter((note) => note.resolvable === true);
        if (thread !== null && resolvable.length > 0 && resolvable.every((note) => note.resolved))
          resolved.add(thread);
        for (const note of discussion.notes)
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
      if (discussions.value.length < PAGE) break;
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
      approvers: approvers.filter((who) => who !== login),
      changesRequested,
      mergeable: mergeabilityOf(said.detailed_merge_status, said.merge_status) ?? null,
      pipeline: headChecks(said.head_pipeline ?? said.pipeline ?? null, head),
      comments: judgeComments(comments, login, resolved),
    };
  });
}

/** A note in the comment's discussion, or a note of its own on the merge request. */
function reply(
  ref: MrRef,
  to: Pick<ForgeComment, "thread">,
  body: string,
  cwd: string,
): Effect.Effect<Readiness, never, ForgeHttp> {
  return Effect.gen(function* () {
    const reached = projectRest(ref, cwd);
    if (!reached.ok) return reached;
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

/**
 * GitLab's merge endpoint at `head`, never `glab mr merge`, whose `--auto-merge` defaults
 * to on. No squash is passed, so the project's own setting stands.
 */
function merge(
  ref: MrRef,
  head: string,
  cwd: string,
): Effect.Effect<MergeAnswer, never, ForgeHttp> {
  return Effect.gen(function* () {
    const where = whereOf(ref);
    const reached = projectRest(ref, cwd);
    if (!reached.ok) return { _tag: "Refused", reason: reached.reason };
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
    const refusal = `GitLab refused to merge ${where}: ${merging.reason}`;
    if (mr === null) return { _tag: "Refused", reason: refusal };
    if (mr.state === "merged")
      return {
        _tag: "AlreadyMerged",
        merged: mergedSha(mr),
        head: mr.sha ?? "",
        by: mr.merge_user?.username ?? mr.merged_by?.username ?? "",
        at: mr.merged_at ?? "",
      };
    if ((mr.sha ?? "") !== head) return { _tag: "HeadMoved", head: mr.sha ?? "" };
    return { _tag: "Refused", reason: refusal };
  });
}

function retryJob(ref: MrRef, id: string, cwd: string): Effect.Effect<Readiness, never, ForgeHttp> {
  return Effect.gen(function* () {
    const reached = projectRest(ref, cwd);
    if (!reached.ok) return reached;
    const ran = yield* request(reached.login, cwd, "POST", `${reached.project}/jobs/${id}/retry`);
    return ran.ok
      ? { ok: true, reason: "" }
      : { ok: false, reason: `could not retry job ${id} of ${whereOf(ref)}: ${ran.reason}` };
  });
}

const jobLog = (ref: MrRef, id: string) =>
  ["glab", "ci", "trace", id, ...repoArgs(ref.project)].join(" ");

function template(cwd: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return (yield* fs.exists(path.join(cwd, MR_TEMPLATE))) ? MR_TEMPLATE : null;
  });
}

const PipelineState = Schema.Struct({ status: Schema.String });

/** `https://host/group/project/-/pipelines/7`'s status, or null where GitLab does not say. */
function pipelineStatus(url: string, cwd: string): Effect.Effect<string | null, never, ForgeHttp> {
  return Effect.gen(function* () {
    const m = /^https?:\/\/([^/\s]+)\/(.+?)\/-\/pipelines\/(\d+)(?:[/?#]\S*)?$/.exec(url.trim());
    if (!m) return null;
    const [, host, project, id] = m;
    // The address is agent text: only a host the human signed glab in to is asked.
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

/** The newest pipeline of `tag` in `ref`'s project. */
function tagPipeline(
  ref: MrRef,
  tag: string,
  cwd: string,
): Effect.Effect<TagPipelineRead, never, ForgeHttp> {
  return Effect.gen(function* () {
    const reached = projectRest(ref, cwd);
    if (!reached.ok) return reached;
    const pipelines = yield* reached.rest(
      Pipelines,
      `pipelines?ref=${encodeURIComponent(tag)}&order_by=id&sort=desc&per_page=1`,
    );
    if (!pipelines.ok) return pipelines;
    const newest = pipelines.value[0];
    return {
      ok: true,
      url: newest === undefined ? null : `https://${ref.project}/-/pipelines/${newest.id}`,
    };
  });
}

/** `https://host/group/project/-/pipelines/7` and its jobs, a manual one as waiting by hand. */
function pipeline(url: string, cwd: string): Effect.Effect<PipelineRead, never, ForgeHttp> {
  return Effect.gen(function* () {
    const m = /^https?:\/\/([^/\s]+)\/(.+?)\/-\/pipelines\/(\d+)(?:[/?#]\S*)?$/.exec(url.trim());
    if (!m) return { ok: false, reason: `${url} is not a GitLab pipeline` };
    const [, host, project, id] = m;
    const login = glabLoginTo(host!, true);
    const route = `projects/${encodeURIComponent(project!)}/pipelines/${id}`;
    const status = yield* requestAs(PipelineIdentity, login, cwd, route);
    if (!status.ok) return status;
    const jobs: Array<(typeof Jobs.Type)[number]> = [];
    for (let page = 1; ; page++) {
      const some = yield* requestAs(Jobs, login, cwd, `${route}/jobs?per_page=100&page=${page}`);
      if (!some.ok) return some;
      jobs.push(...some.value);
      if (some.value.length < 100) break;
    }
    return {
      ok: true,
      succeeded: status.value.status === "success",
      project: `${host}/${project}`,
      ref: status.value.ref,
      sha: status.value.sha,
      jobs: jobs.map((one) => ({
        name: one.name,
        state: one.status === "manual" ? "manual" : (JOB_STATES.get(one.status) ?? "pending"),
        url: one.web_url ?? null,
      })),
    };
  });
}

/** A clone with glab's token for the host as git's auth header, so no credential is stored. */
function clone<R>(
  project: string,
  into: string,
  cwd: string,
  run: Runner<R>,
): Effect.Effect<Readiness, never, R> {
  return Effect.gen(function* () {
    const host = hostOf(project) ?? project.split("/")[0]!;
    const token = (yield* run(
      "glab",
      ["config", "get", "token", "--host", host],
      cwd,
    )).stdout.trim();
    if (token === "") return { ok: false, reason: `could not authenticate to ${host}` };
    const credentials = Buffer.from(`oauth2:${token}`).toString("base64");
    const cloned = yield* run(
      "env",
      [
        "GIT_CONFIG_COUNT=1",
        "GIT_CONFIG_KEY_0=http.extraHeader",
        `GIT_CONFIG_VALUE_0=Authorization: Basic ${credentials}`,
        "git",
        "clone",
        "--quiet",
        `https://${project}.git`,
        into,
      ],
      cwd,
    );
    return cloned.code === 0
      ? { ok: true, reason: "" }
      : { ok: false, reason: whatItSaid(cloned) || "git clone failed" };
  });
}

export const gitlab: Forge = {
  name: "gitlab",
  issues: (project, cwd) => listIssues(glabLoginTo(hostOf(project) ?? "gitlab.com"), project, cwd),
  fileIssue: (project, title, body, cwd) =>
    createIssue(glabLoginTo(hostOf(project) ?? "gitlab.com"), project, title, body, cwd),
  commentIssue: (project, number, body, cwd) =>
    commentIssue(glabLoginTo(hostOf(project) ?? "gitlab.com"), project, number, body, cwd),
  tagPipeline,
  clone,
  credentials: (project, into, run) => {
    const host = hostOf(project) ?? project.split("/")[0]!;
    return keepCredentialHelper(
      into,
      host,
      `!f() { test "$1" = get || exit 0; echo username=oauth2; echo "password=$(glab config get token --host ${shellQuote(host)})"; }; f`,
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
  retryJob,
  jobLog,
  template,
  // `glab mr create` and `glab mr note` take text only, so a file goes through the API,
  // which reads `@<file>` itself: no command substitution (CrowdStrike flags it).
  commands: ({ project, assignee, existing }) => {
    const api = `glab api --hostname ${shellQuote(hostOf(project) ?? "")}`;
    const route = `projects/${encodeURIComponent(mrPath({ project, iid: "" }))}/merge_requests`;
    return {
      create: [
        `glab mr create --assignee ${shellQuote(assignee)} --title "<title>" --description "<title>" --yes`,
        `${api} --method PUT ${shellQuote(`${route}/<iid>`)} -F description=@<file>`,
      ].join("\n"),
      comment:
        existing === null
          ? ""
          : `${api} --method POST ${shellQuote(`${route}/${existing}/notes`)} -F body=@<file>`,
    };
  },
  ready: gitlabForProject,
  login: glabLogin,
  details: mrDetails,
  liveTier,
  deployed,
  stagingEnvironments,
  readReview,
  reply,
  merge,
  post: (ref, body, approve, cwd, run) =>
    Effect.gen(function* () {
      const project = ref.project ?? (yield* projectHere(cwd, run));
      if (project === null)
        return { ok: false, message: `${whereOf(ref)} names no GitLab project` };
      return yield* postReview(
        glabLoginTo(hostOf(project) ?? "gitlab.com"),
        project,
        ref,
        body,
        approve,
        cwd,
      );
    }),
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
    const repo = ref.project === null ? "" : ` --repo ${shellQuote(ref.project)}`;
    const iid = shellQuote(ref.iid);
    return {
      diff: `glab mr diff ${iid}${repo}`,
      view: `glab mr view ${iid}${repo} --comments`,
      checkout: `glab mr checkout ${iid}${repo}`,
    };
  },
};
