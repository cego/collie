// The GitLab adapter: everything Collie asks GitLab, through `glab`.

import { Effect, FileSystem, Option, Path, Schema } from "effect";
import {
  mrPath,
  type ForgeChecks,
  type Mergeability,
  type MrDetails,
  type MrPanel,
  type MrRef,
  type MrUnavailable,
} from "../board-model";
import { epochMs } from "../time";
import { keepCredentialHelper, whatItSaid, type Runner } from "../mr";
import { shellQuote } from "../script";
import type { DeployTier, Forge, ForBranch, FromBranch, FromBranchList, Readiness } from "./forge";
import { filedIssueOf, type Issue } from "./issues";

export const MR_TEMPLATE = ".gitlab/merge_request_templates/default.md";

const UserJson = Schema.fromJsonString(Schema.Struct({ username: Schema.String }));

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
  Schema.NullOr(Schema.Struct({ status: optionalText, sha: optionalText })),
);

const MrDetailsJson = Schema.fromJsonString(
  Schema.Struct({
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
  }),
);

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
 * One merge request, in one `glab mr view` call. `gitlabForProject` first, because "no
 * glab" and "not logged in to that host" are answers a panel can state rather than
 * failures a fetch should discover.
 *
 * Never called from a render path and never for a list: the app fetches this when a Run
 * with a merge-request target becomes the Selection, and caches it per ref.
 */
export function mrDetails<R>(
  ref: MrRef,
  cwd: string,
  run: Runner<R>,
): Effect.Effect<MrPanel, never, R> {
  return Effect.gen(function* () {
    const ready = yield* gitlabForProject(ref.project, cwd, run);
    if (!ready.ok) return { _tag: "Unavailable", reason: ready.reason } satisfies MrUnavailable;

    const where = whereOf(ref);
    const view = yield* run(
      "glab",
      ["mr", "view", ref.iid, ...repoArgs(ref.project), "-F", "json"],
      cwd,
    );
    if (view.code !== 0) {
      return {
        _tag: "Unavailable",
        reason: `glab could not read ${where}`,
      } satisfies MrUnavailable;
    }
    const decoded = Schema.decodeUnknownOption(MrDetailsJson)(view.stdout);
    if (Option.isNone(decoded)) {
      return {
        _tag: "Unavailable",
        reason: `what glab said about ${where} is not a merge request`,
      } satisfies MrUnavailable;
    }
    const mr = decoded.value;
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
      approvals: approvalsLine(mr.approvals_required, mr.approvals_left),
      unresolved: mr.blocking_discussions_resolved === false,
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
  pipeline: { readonly status?: string | null; readonly sha?: string | null } | null,
  head: string,
): ForgeChecks {
  if (pipeline === null) return { state: "none" };
  if (pipeline.sha && head !== "" && pipeline.sha !== head) return { state: "unknown" };
  return pipelineChecks(pipeline.status ?? "");
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
): Effect.Effect<string | null, never, R> {
  return Effect.gen(function* () {
    const host = hostOf(project);
    const me = yield* run("glab", ["api", "user", ...(host ? ["--hostname", host] : [])], cwd);
    if (me.code !== 0) return null;
    return Option.match(Schema.decodeUnknownOption(UserJson)(me.stdout), {
      onNone: () => null,
      onSome: (user) => (user.username === "" ? null : user.username),
    });
  });
}

const EnvironmentsJson = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ name: Schema.String, tier: optionalText })),
);
const DeploymentsJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({ sha: Schema.String, environment: Schema.Struct({ name: Schema.String }) }),
  ),
);
const MergeBaseJson = Schema.fromJsonString(Schema.Struct({ id: optionalText }));

/**
 * The furthest a merged commit has got: live in production, live on staging, or neither.
 * "Live" is what the newest successful deployment of each environment has on it, which is
 * the commit itself or one descending from it — GitLab's merge-base says which. A project
 * with no staging or production environment answers null, and so does GitLab not
 * answering: the board then says "merged", which is true, rather than guessing further.
 */
export function liveTier<R>(
  ref: MrRef,
  mergedSha: string,
  cwd: string,
  run: Runner<R>,
): Effect.Effect<DeployTier | null, never, R> {
  return Effect.gen(function* () {
    const host = hostOf(ref.project);
    if (!host || !ref.project || mergedSha === "") return null;
    const path = encodeURIComponent(ref.project.slice(host.length + 1));
    const api = (route: string) =>
      run("glab", ["api", "--hostname", host, `projects/${path}/${route}`], cwd);
    const environments = yield* api("environments");
    const tiers = new Map<string, DeployTier>();
    for (const env of Option.getOrElse(
      Schema.decodeUnknownOption(EnvironmentsJson)(environments.stdout),
      () => [],
    )) {
      if (env.tier === "production" || env.tier === "staging") tiers.set(env.name, env.tier);
    }
    if (tiers.size === 0) return null;
    const deployments = yield* api(
      "deployments?status=success&order_by=created_at&sort=desc&per_page=50",
    );
    // Newest first, so the first deployment seen per environment is what is live there.
    const live = new Map<string, string>();
    for (const deployment of Option.getOrElse(
      Schema.decodeUnknownOption(DeploymentsJson)(deployments.stdout),
      () => [],
    )) {
      if (tiers.has(deployment.environment.name) && !live.has(deployment.environment.name))
        live.set(deployment.environment.name, deployment.sha);
    }
    const carries = (sha: string) =>
      Effect.gen(function* () {
        if (sha === mergedSha) return true;
        const base = yield* api(`repository/merge_base?refs[]=${mergedSha}&refs[]=${sha}`);
        const decoded = Schema.decodeUnknownOption(MergeBaseJson)(base.stdout);
        return Option.isSome(decoded) && decoded.value.id === mergedSha;
      });
    for (const tier of ["production", "staging"] as const) {
      for (const [name, sha] of live) {
        if (tiers.get(name) === tier && (yield* carries(sha))) return tier;
      }
    }
    return null;
  });
}

const OpenMrsJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      iid: Schema.Union([Schema.String, Schema.Number]),
      web_url: optionalText,
      merge_when_pipeline_succeeds: optionalFlag,
    }),
  ),
);

/** The open merge request from `branch`, read with `glab mr list`; a failed read is not "none". */
function forBranch<R>(
  project: string,
  branch: string,
  cwd: string,
  run: Runner<R>,
): Effect.Effect<ForBranch, never, R> {
  return Effect.gen(function* () {
    const listed = yield* run(
      "glab",
      ["mr", "list", "--source-branch", branch, ...repoArgs(project), "--output", "json"],
      cwd,
    );
    // An empty answer from a CLI that succeeded is an empty list.
    if (listed.code === 0 && listed.stdout.trim() === "") return { ok: true, open: null };
    const decoded = Schema.decodeUnknownOption(OpenMrsJson)(listed.stdout);
    if (listed.code !== 0 || Option.isNone(decoded))
      return {
        ok: false,
        reason: `glab could not list ${project}'s merge requests from ${branch}`,
      };
    const mr =
      decoded.value.find((one) => one.merge_when_pipeline_succeeds === true) ?? decoded.value[0];
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

const DefaultBranchJson = Schema.fromJsonString(Schema.Struct({ default_branch: Schema.String }));
const ProtectedJson = Schema.fromJsonString(Schema.Array(Schema.Struct({ name: Schema.String })));
const PAGE = 100;

/** GitLab's `*` stands for any run of characters, `/` included. */
const wildcard = (pattern: string) =>
  new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*")}$`);

/** The default branch, or a protected branch as listed, wildcards matched; null where either is unread. */
function protects<R>(
  project: string,
  branch: string,
  cwd: string,
  run: Runner<R>,
): Effect.Effect<boolean | null, never, R> {
  return Effect.gen(function* () {
    const host = hostOf(project);
    if (host === null) return null;
    const route = `projects/${encodeURIComponent(project.slice(host.length + 1))}`;
    const api = (path: string) => run("glab", ["api", "--hostname", host, path], cwd);
    const repo = yield* api(route);
    const named = Schema.decodeUnknownOption(DefaultBranchJson)(repo.stdout);
    if (repo.code !== 0 || Option.isNone(named)) return null;
    if (named.value.default_branch === branch) return true;
    const listed = yield* api(`${route}/protected_branches?per_page=${PAGE}`);
    const rules = Schema.decodeUnknownOption(ProtectedJson)(listed.stdout);
    // ponytail: one page; a full one is a project with more rules than it reads, so it cannot say.
    if (listed.code !== 0 || Option.isNone(rules) || rules.value.length >= PAGE) return null;
    return rules.value.some((rule) => wildcard(rule.name).test(branch));
  });
}

const BranchMrsJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      iid: Schema.Union([Schema.String, Schema.Number]),
      web_url: optionalText,
      state: Schema.String,
      created_at: Schema.String,
      merged_at: optionalText,
      closed_at: optionalText,
    }),
  ),
);

/** Every merge request from `branch`, read with `glab mr list --all`; a failed read is not "none". */
function fromBranch<R>(
  project: string,
  branch: string,
  cwd: string,
  run: Runner<R>,
): Effect.Effect<FromBranchList, never, R> {
  return Effect.gen(function* () {
    const listed = yield* run(
      "glab",
      ["mr", "list", "--source-branch", branch, "--all", ...repoArgs(project), "--output", "json"],
      cwd,
    );
    if (listed.code === 0 && listed.stdout.trim() === "") return { ok: true, mrs: [] };
    const decoded = Schema.decodeUnknownOption(BranchMrsJson)(listed.stdout);
    if (listed.code !== 0 || Option.isNone(decoded))
      return {
        ok: false,
        reason: `glab could not list ${project}'s merge requests from ${branch}`,
      };
    return {
      ok: true,
      mrs: decoded.value.map((mr): FromBranch => {
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

function template(cwd: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return (yield* fs.exists(path.join(cwd, MR_TEMPLATE))) ? MR_TEMPLATE : null;
  });
}

const MineJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({ iid: Schema.Union([Schema.String, Schema.Number]), title: optionalText }),
  ),
);

const PipelineJson = Schema.fromJsonString(Schema.Struct({ status: Schema.String }));

/** `https://host/group/project/-/pipelines/7`'s status, or null where GitLab does not say. */
function pipelineStatus<R>(
  url: string,
  cwd: string,
  run: Runner<R>,
): Effect.Effect<string | null, never, R> {
  return Effect.gen(function* () {
    const m = /^https?:\/\/([^/\s]+)\/(.+?)\/-\/pipelines\/(\d+)(?:[/?#]\S*)?$/.exec(url.trim());
    if (!m) return null;
    const [, host, project, id] = m;
    // The address is agent text: only a host the human signed glab in to is called.
    if ((yield* run("glab", ["auth", "status", "--hostname", host!], cwd)).code !== 0) return null;
    const answer = yield* run(
      "glab",
      ["api", "--hostname", host!, `projects/${encodeURIComponent(project!)}/pipelines/${id}`],
      cwd,
    );
    if (answer.code !== 0) return null;
    return Option.getOrNull(
      Option.map(Schema.decodeUnknownOption(PipelineJson)(answer.stdout), (one) => one.status),
    );
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

const IssuesJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      iid: Schema.Int.check(Schema.isGreaterThan(0)),
      title: Schema.String,
      description: Schema.NullOr(Schema.String),
      web_url: Schema.String,
    }),
  ),
);

export const gitlab: Forge = {
  name: "gitlab",
  issues: (project, cwd, run) =>
    Effect.gen(function* () {
      const issues: Issue[] = [];
      for (let page = 1; ; page++) {
        const answer = yield* run(
          "glab",
          [
            "issue",
            "list",
            ...repoArgs(project),
            "--output",
            "json",
            "--page",
            String(page),
            "--per-page",
            "100",
          ],
          cwd,
        );
        if (answer.code !== 0)
          return { ok: false, reason: whatItSaid(answer) || "issue listing failed" };
        const decoded = Schema.decodeUnknownOption(IssuesJson)(answer.stdout);
        if (Option.isNone(decoded))
          return { ok: false, reason: "issue listing returned invalid JSON" };
        issues.push(
          ...decoded.value.map((one) => ({
            number: one.iid,
            title: one.title,
            body: one.description ?? "",
            url: one.web_url,
          })),
        );
        if (decoded.value.length < 100) return { ok: true, issues };
      }
    }),
  fileIssue: (project, title, body, cwd, run) =>
    Effect.map(
      run(
        "glab",
        ["issue", "create", ...repoArgs(project), "--title", title, "--description", body, "--yes"],
        cwd,
      ),
      (answer) => filedIssueOf(answer, project, true),
    ),
  commentIssue: (project, number, body, cwd, run) =>
    Effect.map(
      run("glab", ["issue", "note", String(number), ...repoArgs(project), "--message", body], cwd),
      (answer) => ({
        ok: answer.code === 0,
        reason: answer.code === 0 ? "" : whatItSaid(answer) || "issue comment failed",
      }),
    ),
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
  noun: "merge request",
  webUrl: (project) => `https://${project}`,
  forBranch,
  fromBranch,
  protects,
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
  post: (ref, body, approve, cwd, run) =>
    Effect.gen(function* () {
      const where = whereOf(ref);
      // `--repo` is what lets this work from a directory that is not that checkout.
      const note = yield* run(
        "glab",
        ["mr", "note", ref.iid, ...repoArgs(ref.project), "--message", body],
        cwd,
      );
      if (note.code !== 0)
        return { ok: false, message: `glab mr note ${where} failed (exit ${note.code})` };
      if (!approve) return { ok: true, message: `posted the review to ${where}` };
      const approved = yield* run(
        "glab",
        ["mr", "approve", ref.iid, ...repoArgs(ref.project)],
        cwd,
      );
      return {
        ok: true,
        message:
          approved.code === 0
            ? `posted the review to ${where} and approved it`
            : `posted the review to ${where} and did not approve it: glab mr approve failed (exit ${approved.code})`,
      };
    }),
  mine: (_project, cwd, run) =>
    Effect.gen(function* () {
      const seen = new Map<string, string>();
      for (const who of ["--assignee", "--author"]) {
        const listed = yield* run("glab", ["mr", "list", who, "@me", "--output", "json"], cwd);
        if (listed.code !== 0) continue;
        for (const row of Option.getOrElse(
          Schema.decodeUnknownOption(MineJson)(listed.stdout),
          () => [],
        ))
          if (!seen.has(String(row.iid))) seen.set(String(row.iid), row.title ?? "");
      }
      return [...seen].map(([iid, title]) => ({ iid, title }));
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
