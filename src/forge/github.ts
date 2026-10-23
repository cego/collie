// The GitHub adapter: everything Collie asks GitHub, through `gh`. Only github.com.

import { Effect, FileSystem, Option, Path, Schema } from "effect";
import {
  mrPath,
  mrWords,
  type ForgeChecks,
  type Mergeability,
  type MrDetails,
  type MrPanel,
  type MrRef,
} from "../board-model";
import { keepCredentialHelper, whatItSaid, type Runner } from "../mr";
import { shellQuote } from "../script";
import { epochMs } from "../time";
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
import { Issue, filedIssueOf } from "./issues";
import {
  judgeComments,
  type CommentKind,
  type ForgeComment,
  type MergeAnswer,
  type ReviewRead,
} from "./review";

const HOST = "github.com";

const optionalText = Schema.optionalKey(Schema.NullOr(Schema.String));
const optionalFlag = Schema.optionalKey(Schema.NullOr(Schema.Boolean));
const Login = Schema.Struct({ login: optionalText });

const PullJson = Schema.fromJsonString(
  Schema.Struct({
    title: optionalText,
    state: Schema.String,
    isDraft: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
    author: Schema.optionalKey(Schema.NullOr(Login)),
    assignees: Schema.optionalKey(Schema.NullOr(Schema.Array(Login))),
    headRefName: optionalText,
    isCrossRepository: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
    baseRefName: optionalText,
    headRefOid: optionalText,
    mergeCommit: Schema.optionalKey(Schema.NullOr(Schema.Struct({ oid: Schema.String }))),
    mergedAt: optionalText,
    mergedBy: Schema.optionalKey(Schema.NullOr(Login)),
    statusCheckRollup: Schema.optionalKey(
      Schema.NullOr(
        Schema.Array(
          Schema.Struct({
            name: optionalText,
            context: optionalText,
            detailsUrl: optionalText,
            targetUrl: optionalText,
            status: optionalText,
            conclusion: optionalText,
            state: optionalText,
          }),
        ),
      ),
    ),
    reviewDecision: optionalText,
    comments: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Unknown))),
    updatedAt: optionalText,
    url: optionalText,
    autoMergeRequest: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
    mergeable: optionalText,
    mergeStateStatus: optionalText,
  }),
);

/** GitHub's merge states it would merge in; the rest say why not, or that it is still deciding. */
const MERGES = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);

/** GitHub's own answer to "can this merge now", which carries its branch protection. */
function mergeabilityOf(pull: Pull): Mergeability | undefined {
  if (pull.mergeable === "CONFLICTING") return { state: "blocked", said: "conflicting" };
  const status = pull.mergeStateStatus;
  if (status === undefined || status === null || status === "") {
    if (pull.mergeable === "MERGEABLE") return { state: "mergeable", said: "mergeable" };
    return pull.mergeable === "UNKNOWN" ? { state: "unknown", said: "unknown" } : undefined;
  }
  if (status === "UNKNOWN") return { state: "unknown", said: "unknown" };
  if (MERGES.has(status)) return { state: "mergeable", said: "mergeable" };
  return { state: "blocked", said: status.toLowerCase().replaceAll("_", " ") };
}
type Pull = typeof PullJson.Type;

const RED = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "CANCELLED",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);
const GREEN = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);

/** A pull request's check rollup: a check run's conclusion, or a status context's state. */
export function rollupChecks(rollup: Pull["statusCheckRollup"]): ForgeChecks {
  const checks = rollup ?? [];
  if (checks.length === 0) return { state: "none" };
  const verdicts = checks.map((one) => ({
    name: one.name ?? one.context ?? "a check",
    url: one.detailsUrl ?? one.targetUrl,
    // A check run has a conclusion once it completes; a status context has only a state.
    said:
      one.conclusion ??
      (one.status != null && one.status !== "COMPLETED" ? "PENDING" : (one.state ?? "PENDING")),
  }));
  const red = verdicts.find((one) => RED.has(one.said));
  const waiting = verdicts.find((one) => !GREEN.has(one.said));
  const result: ForgeChecks =
    red !== undefined
      ? { state: "failed", name: red.name }
      : waiting !== undefined
        ? { state: "running" }
        : { state: "passed" };
  const url = (red ?? waiting ?? verdicts[0])?.url;
  return url ? { ...result, url } : result;
}

const FIELDS = [
  "title",
  "state",
  "isDraft",
  "author",
  "assignees",
  "headRefName",
  "isCrossRepository",
  "baseRefName",
  "headRefOid",
  "mergeCommit",
  "mergedAt",
  "statusCheckRollup",
  "reviewDecision",
  "comments",
  "updatedAt",
  "url",
  "autoMergeRequest",
  "mergeable",
  "mergeStateStatus",
].join(",");

/** GitHub's review decision, phrased as a GitLab panel phrases its approvals. */
const APPROVALS = new Map([
  ["APPROVED", "approved"],
  ["CHANGES_REQUESTED", "changes requested"],
  ["REVIEW_REQUIRED", "review required"],
]);

/** One pull request, in one `gh pr view` call. */
function details<R>(ref: MrRef, cwd: string, run: Runner<R>): Effect.Effect<MrPanel, never, R> {
  return Effect.gen(function* () {
    const where = mrWords(ref).label;
    const view = yield* run(
      "gh",
      ["pr", "view", ref.iid, "--repo", mrPath(ref), "--json", FIELDS],
      cwd,
    );
    if (view.code !== 0) return { _tag: "Unavailable", reason: `gh could not read ${where}` };
    const decoded = Schema.decodeUnknownOption(PullJson)(view.stdout);
    if (Option.isNone(decoded))
      return { _tag: "Unavailable", reason: `what gh said about ${where} is not a pull request` };
    const pull = decoded.value;
    const checks = rollupChecks(pull.statusCheckRollup);
    const head = pull.headRefOid ?? "";
    const updated = pull.updatedAt ? epochMs(pull.updatedAt) : Number.NaN;
    const mergeable = mergeabilityOf(pull);
    const details = {
      _tag: "Details",
      iid: ref.iid,
      project: ref.project,
      title: pull.title ?? "",
      state: pull.isDraft === true && pull.state === "OPEN" ? "draft" : pull.state.toLowerCase(),
      author: pull.author?.login ?? "",
      assignees: (pull.assignees ?? []).map((one) => one.login ?? "").filter((name) => name !== ""),
      sourceBranch: pull.headRefName ?? "",
      fork: pull.isCrossRepository === true,
      targetBranch: pull.baseRefName ?? "",
      pipeline: checks.state === "none" ? "" : checks.state,
      checks,
      approvals: APPROVALS.get(pull.reviewDecision ?? "") ?? "",
      unresolved: false,
      notes: pull.comments?.length ?? 0,
      headSha: head.slice(0, 7),
      head,
      mergedSha: pull.mergeCommit?.oid ?? "",
      updatedAt: Number.isFinite(updated) ? updated : 0,
      url: pull.url ?? mrWords(ref).url ?? "",
      autoMerge: pull.autoMergeRequest != null,
    } satisfies MrDetails;
    const merged = pull.mergedAt ? { ...details, mergedAt: pull.mergedAt } : details;
    return mergeable === undefined ? merged : { ...merged, mergeable };
  });
}

const RepoJson = Schema.fromJsonString(Schema.Struct({ nameWithOwner: Schema.String }));
const UserJson = Schema.fromJsonString(Schema.Struct({ login: Schema.String }));

/** gh installed, logged in to github.com, and — where a repository is named — able to read it. */
function ready<R>(
  project: string | null,
  cwd: string,
  run: Runner<R>,
): Effect.Effect<Readiness, never, R> {
  return Effect.gen(function* () {
    const no = (reason: string) => ({ ok: false, reason });
    if ((yield* run("gh", ["--version"], cwd)).code !== 0) return no("gh is not installed");
    if ((yield* run("gh", ["auth", "status", "--hostname", HOST], cwd)).code !== 0)
      return no(`gh is not logged in to ${HOST}`);
    const repository = project === null ? "" : mrPath({ project, iid: "" });
    if (repository === "" || repository === project) return { ok: true, reason: "" };
    const repo = yield* run("gh", ["repo", "view", repository, "--json", "nameWithOwner"], cwd);
    const decoded = Schema.decodeUnknownOption(RepoJson)(repo.stdout);
    if (
      repo.code !== 0 ||
      Option.isNone(decoded) ||
      decoded.value.nameWithOwner.toLowerCase() !== repository.toLowerCase()
    )
      return no(`gh cannot read ${repository}`);
    return { ok: true, reason: "" };
  });
}

function login<R>(cwd: string, run: Runner<R>): Effect.Effect<string | null, never, R> {
  return Effect.gen(function* () {
    const me = yield* run("gh", ["api", "user", "--hostname", HOST], cwd);
    if (me.code !== 0) return null;
    return Option.match(Schema.decodeUnknownOption(UserJson)(me.stdout), {
      onNone: () => null,
      onSome: (user) => (user.login.trim() === "" ? null : user.login),
    });
  });
}

const OpenPullsJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      number: Schema.Number,
      url: optionalText,
      autoMergeRequest: Schema.optionalKey(Schema.NullOr(Schema.Unknown)),
    }),
  ),
);

const DefaultBranchJson = Schema.fromJsonString(Schema.Struct({ default_branch: Schema.String }));
const RulesJson = Schema.fromJsonString(Schema.Array(Schema.Unknown));
const ClassicRulesJson = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.Struct({
      repository: Schema.Struct({
        branchProtectionRules: Schema.Struct({
          nodes: Schema.Array(Schema.Struct({ pattern: Schema.String })),
        }),
      }),
    }),
  }),
);
const PAGE = 100;
const CLASSIC_RULES = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { branchProtectionRules(first: ${PAGE}) { nodes { pattern } } } }`;

/**
 * The default branch, the rules active for the name (which GitHub answers for a branch not
 * pushed yet), and the classic protection rules' patterns; null where any is unread.
 */
function protects<R>(
  project: string,
  branch: string,
  cwd: string,
  run: Runner<R>,
): Effect.Effect<boolean | null, never, R> {
  return Effect.gen(function* () {
    const repo = mrPath({ project, iid: "" });
    const api = (...args: ReadonlyArray<string>) => run("gh", ["api", ...args], cwd);
    const about = yield* api(`repos/${repo}`);
    const named = Schema.decodeUnknownOption(DefaultBranchJson)(about.stdout);
    if (about.code !== 0 || Option.isNone(named)) return null;
    if (named.value.default_branch === branch) return true;
    const active = yield* api(`repos/${repo}/rules/branches/${encodeURIComponent(branch)}`);
    const rules = Schema.decodeUnknownOption(RulesJson)(active.stdout);
    if (active.code !== 0 || Option.isNone(rules)) return null;
    if (rules.value.length > 0) return true;
    const [owner = "", name = ""] = repo.split("/");
    const classic = yield* api(
      "graphql",
      "-f",
      `query=${CLASSIC_RULES}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `name=${name}`,
    );
    const patterns = Schema.decodeUnknownOption(ClassicRulesJson)(classic.stdout);
    if (classic.code !== 0 || Option.isNone(patterns)) return null;
    const nodes = patterns.value.data.repository.branchProtectionRules.nodes;
    // ponytail: one page; a full one is a repository with more rules than it reads, so it cannot say.
    if (nodes.length >= PAGE) return null;
    return nodes.some((rule) => new Bun.Glob(rule.pattern).match(branch));
  });
}

/** The open pull request from `branch`, read with `gh pr list`; a failed read is not "none". */
function forBranch<R>(
  project: string,
  branch: string,
  cwd: string,
  run: Runner<R>,
): Effect.Effect<ForBranch, never, R> {
  return Effect.gen(function* () {
    const repo = mrPath({ project, iid: "" });
    const listed = yield* run(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        repo,
        "--head",
        branch,
        "--state",
        "open",
        "--json",
        "number,url,autoMergeRequest",
      ],
      cwd,
    );
    // An empty answer from a CLI that succeeded is an empty list.
    if (listed.code === 0 && listed.stdout.trim() === "") return { ok: true, open: null };
    const decoded = Schema.decodeUnknownOption(OpenPullsJson)(listed.stdout);
    if (listed.code !== 0 || Option.isNone(decoded))
      return { ok: false, reason: `gh could not list ${repo}'s pull requests from ${branch}` };
    const pull = decoded.value.find((one) => one.autoMergeRequest != null) ?? decoded.value[0];
    if (pull === undefined) return { ok: true, open: null };
    const iid = String(pull.number);
    return {
      ok: true,
      open: {
        iid,
        url: pull.url ?? `https://${project}/pull/${iid}`,
        autoMerge: pull.autoMergeRequest != null,
      },
    };
  });
}

const BranchPullsJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      number: Schema.Number,
      url: optionalText,
      state: Schema.String,
      createdAt: Schema.String,
      mergedAt: optionalText,
      closedAt: optionalText,
    }),
  ),
);

/** Every pull request from `branch`, read with `gh pr list --state all`; a failed read is not "none". */
function fromBranch<R>(
  project: string,
  branch: string,
  cwd: string,
  run: Runner<R>,
): Effect.Effect<FromBranchList, never, R> {
  return Effect.gen(function* () {
    const repo = mrPath({ project, iid: "" });
    const listed = yield* run(
      "gh",
      [
        "pr",
        "list",
        "--repo",
        repo,
        "--head",
        branch,
        "--state",
        "all",
        "--json",
        "number,url,state,createdAt,mergedAt,closedAt",
      ],
      cwd,
    );
    if (listed.code === 0 && listed.stdout.trim() === "") return { ok: true, mrs: [] };
    const decoded = Schema.decodeUnknownOption(BranchPullsJson)(listed.stdout);
    if (listed.code !== 0 || Option.isNone(decoded))
      return { ok: false, reason: `gh could not list ${repo}'s pull requests from ${branch}` };
    return {
      ok: true,
      mrs: decoded.value.map((pull): FromBranch => {
        const iid = String(pull.number);
        return {
          iid,
          url: pull.url ?? `https://${project}/pull/${iid}`,
          state: pull.state === "MERGED" ? "merged" : pull.state === "OPEN" ? "open" : "closed",
          created: pull.createdAt,
          // A merged pull request is closed too; when it merged is when it ended.
          ended: pull.mergedAt ?? pull.closedAt ?? null,
        };
      }),
    };
  });
}

const HeadJson = Schema.fromJsonString(Schema.Struct({ headRefOid: Schema.String }));
const CheckRuns = Schema.Struct({
  check_runs: Schema.Array(
    Schema.Struct({
      id: Schema.Number,
      head_sha: Schema.String,
      status: Schema.String,
      conclusion: optionalText,
      html_url: optionalText,
    }),
  ),
});
const CheckRunsJson = Schema.fromJsonString(CheckRuns);
const CheckRunsPagesJson = Schema.fromJsonString(Schema.Array(CheckRuns));
const BaseJson = Schema.fromJsonString(
  Schema.Struct({ baseRefName: Schema.String, headRefOid: Schema.String }),
);
const MergeBaseJson = Schema.fromJsonString(
  Schema.Struct({ merge_base_commit: Schema.NullOr(Schema.Struct({ sha: Schema.String })) }),
);

const CONCLUSIONS = new Map<string, JobState>([
  ["success", "passed"],
  ["failure", "failed"],
  ["timed_out", "failed"],
  ["action_required", "failed"],
  ["cancelled", "cancelled"],
  ["stale", "cancelled"],
  ["skipped", "skipped"],
  ["neutral", "skipped"],
]);

/** The check run of that name on the pull request's head commit; GitHub lists the newest first. */
function job<R>(
  ref: MrRef,
  name: string,
  cwd: string,
  run: Runner<R>,
): Effect.Effect<JobRead, never, R> {
  return Effect.gen(function* () {
    const where = mrWords(ref).label;
    const repo = mrPath({ project: ref.project, iid: "" });
    const view = yield* run(
      "gh",
      ["pr", "view", ref.iid, "--repo", repo, "--json", "headRefOid"],
      cwd,
    );
    const pull = Schema.decodeUnknownOption(HeadJson)(view.stdout);
    if (view.code !== 0 || Option.isNone(pull))
      return { ok: false, reason: `gh could not read ${where}` };
    const head = pull.value.headRefOid;
    const found = yield* checkRun(repo, head, name, cwd, run);
    if (found === null) return { ok: false, reason: `gh could not list the check runs on ${head}` };
    return {
      ok: true,
      head,
      state: found === undefined ? "missing" : stateOf(found),
      url: found?.html_url ?? null,
      id: found === undefined ? null : String(found.id),
      merge: null,
    };
  });
}

/** The newest check run named `name` on `ref`, undefined for none, null where gh could not say. */
const checkRun = <R>(repo: string, ref: string, name: string, cwd: string, run: Runner<R>) =>
  Effect.map(
    checkRuns(repo, ref, `check_name=${encodeURIComponent(name)}`, cwd, run),
    (runs) => runs && runs[0],
  );

const checkRuns = <R>(repo: string, ref: string, query: string, cwd: string, run: Runner<R>) =>
  Effect.map(
    run("gh", ["api", `repos/${repo}/commits/${ref}/check-runs?${query}`], cwd),
    (listed) => {
      const runs = Schema.decodeUnknownOption(CheckRunsJson)(listed.stdout);
      return listed.code !== 0 || Option.isNone(runs) ? null : runs.value.check_runs;
    },
  );

const stateOf = (found: {
  readonly status: string;
  readonly conclusion?: string | null;
}): JobState =>
  found.status !== "completed"
    ? found.status === "in_progress"
      ? "running"
      : "pending"
    : (CONCLUSIONS.get(found.conclusion ?? "") ?? "failed");

/** The check run at the pull request's merge-base, else on its base branch's tip. */
function baseJob<R>(
  ref: MrRef,
  name: string,
  cwd: string,
  run: Runner<R>,
): Effect.Effect<BaseJobRead, never, R> {
  return Effect.gen(function* () {
    const where = mrWords(ref).label;
    const repo = mrPath({ project: ref.project, iid: "" });
    const view = yield* run(
      "gh",
      ["pr", "view", ref.iid, "--repo", repo, "--json", "baseRefName,headRefOid"],
      cwd,
    );
    const pull = Schema.decodeUnknownOption(BaseJson)(view.stdout);
    if (view.code !== 0 || Option.isNone(pull))
      return { ok: false, reason: `gh could not read ${where}` };
    const { baseRefName: target, headRefOid: head } = pull.value;
    const compared = yield* run("gh", ["api", `repos/${repo}/compare/${target}...${head}`], cwd);
    const base = Option.getOrNull(Schema.decodeUnknownOption(MergeBaseJson)(compared.stdout))
      ?.merge_base_commit?.sha;
    if (compared.code !== 0 || base === undefined)
      return { ok: false, reason: `GitHub would not say where ${where} leaves ${target}` };
    const unread = { ok: false, reason: `gh could not list the check runs at ${base}` } as const;
    const there = yield* checkRun(repo, base, name, cwd, run);
    if (there === null) return unread;
    if (there === undefined) {
      // Only where CI never ran at the merge-base does the target branch's tip stand in for it.
      const any = yield* checkRuns(repo, base, "per_page=1", cwd, run);
      if (any === null) return unread;
      if (any.length > 0) return { ok: true, at: base, state: "missing", url: null };
    }
    const found = there ?? (yield* checkRun(repo, target, name, cwd, run));
    if (found === null || found === undefined)
      return {
        ok: false,
        reason: `no check run ${name} at ${base.slice(0, 12)} or on ${target}`,
      };
    return { ok: true, at: found.head_sha, state: stateOf(found), url: found.html_url ?? null };
  });
}

const REVIEW_FIELDS =
  "state,headRefOid,baseRefName,mergeCommit,mergedAt,mergedBy,reviewDecision,mergeable,mergeStateStatus,statusCheckRollup,url";
const User = Schema.Struct({ login: Schema.String, type: optionalText });
/** `gh api --paginate --slurp`'s pages. */
const pagesOf = <S extends Schema.Top>(item: S) =>
  Schema.fromJsonString(Schema.Array(Schema.Array(item)));
const IssueCommentsJson = pagesOf(
  Schema.Struct({
    id: Schema.Number,
    html_url: Schema.String,
    user: Schema.NullOr(User),
    created_at: Schema.String,
    body: optionalText,
  }),
);
const ReviewCommentsJson = pagesOf(
  Schema.Struct({
    id: Schema.Number,
    html_url: Schema.String,
    user: Schema.NullOr(User),
    created_at: Schema.String,
    body: optionalText,
    path: optionalText,
    line: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    original_line: Schema.optionalKey(Schema.NullOr(Schema.Number)),
    in_reply_to_id: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  }),
);
const ReviewsJson = pagesOf(
  Schema.Struct({
    id: Schema.Number,
    html_url: Schema.String,
    user: Schema.NullOr(User),
    state: Schema.String,
    body: optionalText,
    submitted_at: optionalText,
  }),
);
const ThreadsJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      data: Schema.Struct({
        repository: Schema.Struct({
          pullRequest: Schema.Struct({
            reviewThreads: Schema.Struct({
              nodes: Schema.Array(
                Schema.Struct({
                  isResolved: Schema.Boolean,
                  comments: Schema.Struct({
                    nodes: Schema.Array(
                      Schema.Struct({ databaseId: Schema.NullOr(Schema.Number) }),
                    ),
                  }),
                }),
              ),
            }),
          }),
        }),
      }),
    }),
  ),
);
const REVIEW_THREADS = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: ${PAGE}, after: $endCursor) { nodes { isResolved comments(first: 1) { nodes { databaseId } } } pageInfo { hasNextPage endCursor } } } } }`;
const ProtectionJson = Schema.fromJsonString(
  Schema.Struct({
    data: Schema.Struct({
      repository: Schema.Struct({
        ref: Schema.NullOr(
          Schema.Struct({
            refUpdateRule: Schema.NullOr(
              Schema.Struct({
                requiredApprovingReviewCount: Schema.NullOr(Schema.Number),
                requiresCodeOwnerReviews: Schema.Boolean,
              }),
            ),
          }),
        ),
      }),
    }),
  }),
);
const PROTECTION = `query($owner: String!, $name: String!, $ref: String!) { repository(owner: $owner, name: $name) { ref(qualifiedName: $ref) { refUpdateRule { requiredApprovingReviewCount requiresCodeOwnerReviews } } } }`;
const BranchRulesJson = pagesOf(
  Schema.Struct({
    type: Schema.String,
    parameters: Schema.optionalKey(
      Schema.NullOr(
        Schema.Struct({
          required_approving_review_count: Schema.optionalKey(Schema.Number),
          require_code_owner_review: optionalFlag,
        }),
      ),
    ),
  }),
);

/** The approving reviews `base` requires, or why that cannot be counted. */
const requiredReviews = <R>(repo: string, base: string, cwd: string, run: Runner<R>) =>
  Effect.gen(function* () {
    const [owner = "", name = ""] = repo.split("/");
    const classic = yield* run(
      "gh",
      [
        "api",
        "graphql",
        "-f",
        `query=${PROTECTION}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${name}`,
        "-F",
        `ref=refs/heads/${base}`,
      ],
      cwd,
    );
    const protection = Schema.decodeUnknownOption(ProtectionJson)(classic.stdout);
    const rules = yield* run(
      "gh",
      ["api", `repos/${repo}/rules/branches/${encodeURIComponent(base)}`, "--paginate", "--slurp"],
      cwd,
    );
    const rulesets = Schema.decodeUnknownOption(BranchRulesJson)(rules.stdout);
    if (
      classic.code !== 0 ||
      Option.isNone(protection) ||
      rules.code !== 0 ||
      Option.isNone(rulesets)
    )
      return {
        ok: false,
        reason: `GitHub would not say how many approvals ${base} requires`,
      } as const;
    const rule = protection.value.data.repository.ref?.refUpdateRule ?? null;
    const pullRules = rulesets.value.flat().filter((one) => one.type === "pull_request");
    if (
      rule?.requiresCodeOwnerReviews === true ||
      pullRules.some((one) => one.parameters?.require_code_owner_review === true)
    )
      return { ok: false, reason: `${base} requires code owners' review` } as const;
    return {
      ok: true,
      count: Math.max(
        rule?.requiredApprovingReviewCount ?? 0,
        ...pullRules.map((one) => one.parameters?.required_approving_review_count ?? 0),
      ),
    } as const;
  });

/**
 * The pull request's view, every page of its issue comments, review comments and reviews,
 * and which review threads are resolved.
 */
function readReview<R>(
  ref: MrRef,
  cwd: string,
  run: Runner<R>,
): Effect.Effect<ReviewRead, never, R> {
  return Effect.gen(function* () {
    const where = mrWords(ref).label;
    const reached = yield* ready(ref.project, cwd, run);
    if (!reached.ok) return { ok: false, reason: reached.reason };
    const me = yield* login(cwd, run);
    if (me === null) return { ok: false, reason: "gh will not say who it is logged in as" };
    const repo = mrPath(ref);
    const view = yield* run(
      "gh",
      ["pr", "view", ref.iid, "--repo", repo, "--json", REVIEW_FIELDS],
      cwd,
    );
    const pull = Schema.decodeUnknownOption(PullJson)(view.stdout);
    if (view.code !== 0 || Option.isNone(pull))
      return { ok: false, reason: `gh could not read ${where}` };
    const list = <A>(schema: Schema.Codec<A, string>, route: string) =>
      Effect.map(
        run("gh", ["api", `repos/${repo}/${route}?per_page=${PAGE}`, "--paginate", "--slurp"], cwd),
        (ran) =>
          ran.code === 0 ? Option.getOrNull(Schema.decodeUnknownOption(schema)(ran.stdout)) : null,
      );
    const issueComments = yield* list(IssueCommentsJson, `issues/${ref.iid}/comments`);
    const reviewComments = yield* list(ReviewCommentsJson, `pulls/${ref.iid}/comments`);
    const reviews = yield* list(ReviewsJson, `pulls/${ref.iid}/reviews`);
    const [owner = "", name = ""] = repo.split("/");
    const threads = yield* run(
      "gh",
      [
        "api",
        "graphql",
        "--paginate",
        "--slurp",
        "-f",
        `query=${REVIEW_THREADS}`,
        "-F",
        `owner=${owner}`,
        "-F",
        `name=${name}`,
        "-F",
        `number=${ref.iid}`,
      ],
      cwd,
    );
    const resolvedThreads = Schema.decodeUnknownOption(ThreadsJson)(threads.stdout);
    if (
      issueComments === null ||
      reviewComments === null ||
      reviews === null ||
      threads.code !== 0 ||
      Option.isNone(resolvedThreads)
    )
      return { ok: false, reason: `gh could not read ${where}'s comments and reviews` };
    const resolved = new Set(
      resolvedThreads.value.flatMap((page) =>
        page.data.repository.pullRequest.reviewThreads.nodes.flatMap((thread) => {
          const first = thread.comments.nodes[0]?.databaseId;
          return thread.isResolved && first != null ? [String(first)] : [];
        }),
      ),
    );
    const kindOf = (user: typeof User.Type | null): CommentKind =>
      user?.type === "Bot" ? "bot" : "person";
    const comments: ForgeComment[] = [
      ...issueComments.flat().map((one) => ({
        id: String(one.id),
        url: one.html_url,
        thread: null,
        author: one.user?.login ?? "",
        kind: kindOf(one.user),
        at: one.created_at,
        body: one.body ?? "",
        file: null,
        line: null,
      })),
      ...reviewComments.flat().map((one) => ({
        id: String(one.id),
        url: one.html_url,
        thread: String(one.in_reply_to_id ?? one.id),
        author: one.user?.login ?? "",
        kind: kindOf(one.user),
        at: one.created_at,
        body: one.body ?? "",
        file: one.path ?? null,
        line: one.line ?? one.original_line ?? null,
      })),
      ...reviews.flat().flatMap((one) =>
        (one.body ?? "") === ""
          ? []
          : [
              {
                id: String(one.id),
                url: one.html_url,
                thread: null,
                author: one.user?.login ?? "",
                kind: kindOf(one.user),
                at: one.submitted_at ?? "",
                body: one.body ?? "",
                file: null,
                line: null,
              },
            ],
      ),
    ];
    // Each reviewer's latest review that is more than a comment is the one that stands.
    const standing = new Map<string, { readonly state: string; readonly bot: boolean }>();
    for (const one of reviews.flat())
      if (one.user !== null && one.state !== "COMMENTED" && one.state !== "PENDING")
        standing.set(one.user.login, { state: one.state, bot: one.user.type === "Bot" });
    const approvers = [...standing]
      .filter(([, review]) => review.state === "APPROVED")
      .map(([who]) => who);
    const others = approvers.filter((who) => who !== me);
    const changesRequested = [...standing].some(
      ([who, review]) => review.state === "CHANGES_REQUESTED" && !review.bot && who !== me,
    );
    const said = pull.value;
    const decision = said.reviewDecision ?? "";
    const unapproved = yield* Effect.gen(function* () {
      if (decision === "CHANGES_REQUESTED") return "changes were requested";
      if (decision === "REVIEW_REQUIRED") return "a review is still required";
      if (decision !== "APPROVED") return changesRequested ? "changes were requested" : "";
      if (!approvers.includes(me)) return "";
      const required = yield* requiredReviews(repo, said.baseRefName ?? "", cwd, run);
      if (!required.ok) return `${required.reason}, and ${me}'s own approval stands`;
      return others.length >= required.count
        ? ""
        : `${said.baseRefName} requires ${required.count} approval(s) and has ${others.length} besides ${me}'s own`;
    });
    const head = said.headRefOid ?? "";
    const state = said.state === "MERGED" ? "merged" : said.state === "OPEN" ? "open" : "closed";
    return {
      ok: true,
      login: me,
      state,
      head,
      merged:
        state === "merged"
          ? {
              sha: said.mergeCommit?.oid ?? "",
              by: said.mergedBy?.login ?? "",
              at: said.mergedAt ?? "",
            }
          : null,
      approved: unapproved === "",
      unapproved,
      approvers: others,
      changesRequested,
      mergeable: mergeabilityOf(said) ?? null,
      pipeline: rollupChecks(said.statusCheckRollup),
      comments: judgeComments(comments, me, resolved),
    };
  });
}

/** A reply in a review comment's thread, else a new comment on the pull request. */
function reply<R>(
  ref: MrRef,
  to: Pick<ForgeComment, "thread">,
  body: string,
  cwd: string,
  run: Runner<R>,
): Effect.Effect<Readiness, never, R> {
  const repo = mrPath(ref);
  const route =
    to.thread === null
      ? `repos/${repo}/issues/${ref.iid}/comments`
      : `repos/${repo}/pulls/${ref.iid}/comments/${to.thread}/replies`;
  return Effect.map(run("gh", ["api", route, "-X", "POST", "-f", `body=${body}`], cwd), (posted) =>
    posted.code === 0
      ? { ok: true, reason: "" }
      : {
          ok: false,
          reason: `gh could not reply on ${mrWords(ref).label}: ${whatItSaid(posted) || `exit ${posted.code}`}`,
        },
  );
}

const MergeMethodJson = Schema.fromJsonString(
  Schema.Struct({ viewerDefaultMergeMethod: Schema.Literals(["MERGE", "SQUASH", "REBASE"]) }),
);
const MergedJson = Schema.fromJsonString(
  Schema.Struct({
    state: Schema.String,
    headRefOid: optionalText,
    mergeCommit: Schema.optionalKey(Schema.NullOr(Schema.Struct({ oid: Schema.String }))),
    mergedAt: optionalText,
    mergedBy: Schema.optionalKey(Schema.NullOr(Login)),
  }),
);

/** GitHub's merge endpoint at `head`, by the repository's default merge method for the viewer. */
function merge<R>(
  ref: MrRef,
  head: string,
  cwd: string,
  run: Runner<R>,
): Effect.Effect<MergeAnswer, never, R> {
  return Effect.gen(function* () {
    const where = mrWords(ref).label;
    const repo = mrPath(ref);
    const viewed = yield* run(
      "gh",
      ["repo", "view", repo, "--json", "viewerDefaultMergeMethod"],
      cwd,
    );
    const method = Schema.decodeUnknownOption(MergeMethodJson)(viewed.stdout);
    if (viewed.code !== 0 || Option.isNone(method))
      return { _tag: "Refused", reason: `gh would not say how ${repo} merges` };
    const merging = yield* run(
      "gh",
      [
        "api",
        `repos/${repo}/pulls/${ref.iid}/merge`,
        "-X",
        "PUT",
        "-f",
        `sha=${head}`,
        "-f",
        `merge_method=${method.value.viewerDefaultMergeMethod.toLowerCase()}`,
      ],
      cwd,
    );
    const after = yield* run(
      "gh",
      [
        "pr",
        "view",
        ref.iid,
        "--repo",
        repo,
        "--json",
        "state,headRefOid,mergeCommit,mergedAt,mergedBy",
      ],
      cwd,
    );
    const pull =
      after.code === 0
        ? Option.getOrNull(Schema.decodeUnknownOption(MergedJson)(after.stdout))
        : null;
    if (merging.code === 0) return { _tag: "Merged", merged: pull?.mergeCommit?.oid ?? "" };
    const refusal = `GitHub refused to merge ${where}: ${whatItSaid(merging) || `exit ${merging.code}`}`;
    if (pull === null) return { _tag: "Refused", reason: refusal };
    if (pull.state === "MERGED")
      return {
        _tag: "AlreadyMerged",
        merged: pull.mergeCommit?.oid ?? "",
        head: pull.headRefOid ?? "",
        by: pull.mergedBy?.login ?? "",
        at: pull.mergedAt ?? "",
      };
    if ((pull.headRefOid ?? "") !== head) return { _tag: "HeadMoved", head: pull.headRefOid ?? "" };
    return { _tag: "Refused", reason: refusal };
  });
}

function retryJob<R>(
  ref: MrRef,
  id: string,
  cwd: string,
  run: Runner<R>,
): Effect.Effect<Readiness, never, R> {
  const repo = mrPath({ project: ref.project, iid: "" });
  return Effect.map(
    run("gh", ["api", `repos/${repo}/actions/jobs/${id}/rerun`, "-X", "POST"], cwd),
    (ran) =>
      ran.code === 0
        ? { ok: true, reason: "" }
        : { ok: false, reason: `gh could not rerun job ${id} of ${mrWords(ref).label}` },
  );
}

const jobLog = (ref: MrRef, id: string) =>
  `gh run view --job ${id} --log --repo ${mrPath({ project: ref.project, iid: "" })}`;

/** Where GitHub looks for a pull request template, in the order it looks. */
const TEMPLATES = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
];

function template(cwd: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const candidate of TEMPLATES)
      if (yield* fs.exists(path.join(cwd, candidate))) return candidate;
    return null;
  });
}

const MineJson = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ number: Schema.Number, title: optionalText })),
);

const DeploymentsJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Array(
      Schema.Struct({
        id: Schema.Number,
        sha: Schema.String,
        environment: Schema.String,
        production_environment: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
      }),
    ),
  ),
);
const StatusesJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      state: Schema.String,
      log_url: optionalText,
    }),
  ),
);
const CompareJson = Schema.fromJsonString(Schema.Struct({ status: Schema.String }));
const RunJson = Schema.fromJsonString(
  Schema.Struct({ status: Schema.String, conclusion: optionalText }),
);

/** Production by the flag or by name, staging by name; any other environment is neither. */
function tierOf(environment: string, production: boolean): DeployTier | null {
  const name = environment.toLowerCase();
  if (production || name === "production" || name === "prod") return "production";
  if (name === "staging" || name === "stage") return "staging";
  return null;
}

/**
 * How far a merged commit has got on GitHub (ADR-0050 D7): the newest deployment of each
 * environment whose latest status is `success` is what is live there, and it carries the
 * merge where GitHub's compare of the two says `identical` or `ahead`. No such
 * environment, or no answer, is null, and the card says "Merged." and nothing more.
 */
function liveTier<R>(
  ref: MrRef,
  mergedSha: string,
  cwd: string,
  run: Runner<R>,
): Effect.Effect<DeployTier | null, never, R> {
  return Effect.gen(function* () {
    if (mergedSha === "" || ref.project === null) return null;
    const repo = `repos/${mrPath(ref)}`;
    const api = (route: string) => run("gh", ["api", `${repo}/${route}`], cwd);
    const listed = yield* run(
      "gh",
      ["api", `${repo}/deployments?per_page=100`, "--paginate", "--slurp"],
      cwd,
    );
    if (listed.code !== 0) return null;
    const deployments = Option.getOrElse(
      Schema.decodeUnknownOption(DeploymentsJson)(listed.stdout),
      () => [],
    ).flat();
    // Newest first, so the first successful one seen per environment is what is live there.
    const live = new Map<string, { readonly sha: string; readonly tier: DeployTier }>();
    for (const deployment of deployments) {
      const tier = tierOf(deployment.environment, deployment.production_environment === true);
      if (tier === null || live.has(deployment.environment)) continue;
      const statuses = yield* api(`deployments/${deployment.id}/statuses?per_page=1`);
      const [latest] = Option.getOrElse(
        Schema.decodeUnknownOption(StatusesJson)(statuses.stdout),
        () => [],
      );
      if (latest?.state === "success")
        live.set(deployment.environment, { sha: deployment.sha, tier });
    }
    const carries = (sha: string) =>
      Effect.gen(function* () {
        if (sha === mergedSha) return true;
        const compared = yield* api(`compare/${mergedSha}...${sha}`);
        const status = Option.getOrNull(Schema.decodeUnknownOption(CompareJson)(compared.stdout));
        return status?.status === "identical" || status?.status === "ahead";
      });
    for (const tier of ["production", "staging"] as const)
      for (const one of live.values())
        if (one.tier === tier && (yield* carries(one.sha))) return tier;
    return null;
  });
}

/** The commit the newest deployment of `tier` whose latest status is `success` has. */
function deployed<R>(
  ref: MrRef,
  tier: DeployTier,
  cwd: string,
  run: Runner<R>,
): Effect.Effect<DeployedRead, never, R> {
  return Effect.gen(function* () {
    if (ref.project === null) return { ok: false, reason: "no repository to read deployments of" };
    const repo = `repos/${mrPath(ref)}`;
    const unread = { ok: false, reason: `gh could not read ${ref.project}'s deployments` } as const;
    const listed = yield* run(
      "gh",
      ["api", `${repo}/deployments?per_page=100`, "--paginate", "--slurp"],
      cwd,
    );
    const pages = Schema.decodeUnknownOption(DeploymentsJson)(listed.stdout);
    if (listed.code !== 0 || Option.isNone(pages)) return unread;
    for (const deployment of pages.value.flat()) {
      if (tierOf(deployment.environment, deployment.production_environment === true) !== tier)
        continue;
      const statuses = yield* run(
        "gh",
        ["api", `${repo}/deployments/${deployment.id}/statuses?per_page=1`],
        cwd,
      );
      const latest = Schema.decodeUnknownOption(StatusesJson)(statuses.stdout);
      if (statuses.code !== 0 || Option.isNone(latest)) return unread;
      if (latest.value[0]?.state === "success") return { ok: true, sha: deployment.sha };
    }
    return { ok: true, sha: null };
  });
}

const EnvironmentsJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({ environments: Schema.Array(Schema.Struct({ name: Schema.String })) }),
  ),
);
const EnvironmentDeploymentsJson = Schema.fromJsonString(
  Schema.Array(Schema.Array(Schema.Struct({ id: Schema.Number, sha: Schema.String }))),
);

/** GitHub's environments have no tier, so a staging one is named for it: `stage-web`, `web_staging`. */
const isStaging = (name: string) => /^(?:.+[-_/ ])?(?:stage|staging)(?:[-_/ ].+)?$/i.test(name);

/**
 * Each staging environment: its deployments newest first, the first whose latest status is
 * `success` live. A selected job owns a deployment where its status's log names that job id.
 */
function stagingEnvironments<R>(
  ref: MrRef,
  commit: string | null,
  cwd: string,
  run: Runner<R>,
  jobs?: ReadonlyArray<string>,
): Effect.Effect<StagingRead, never, R> {
  return Effect.gen(function* () {
    if (ref.project === null) return { ok: false, reason: "no repository to read deployments of" };
    const repo = `repos/${mrPath(ref)}`;
    const unread = {
      ok: false,
      reason: `gh could not read ${ref.project}'s stage environments`,
    } as const;
    const pages = (route: string) =>
      run("gh", ["api", `${repo}/${route}`, "--paginate", "--slurp"], cwd);
    const selected = new Set<number>();
    if (jobs !== undefined && commit !== null) {
      for (const job of jobs) {
        const listed = yield* pages(
          `commits/${commit}/check-runs?check_name=${encodeURIComponent(job)}&filter=all&per_page=100`,
        );
        const checks = Schema.decodeUnknownOption(CheckRunsPagesJson)(listed.stdout);
        if (listed.code !== 0 || Option.isNone(checks)) return unread;
        for (const page of checks.value)
          for (const check of page.check_runs) selected.add(check.id);
      }
    }
    const listed = yield* pages("environments?per_page=100");
    const named = Schema.decodeUnknownOption(EnvironmentsJson)(listed.stdout);
    if (listed.code !== 0 || Option.isNone(named)) return unread;
    const environments: StagingEnvironment[] = [];
    for (const { name } of named.value.flatMap((page) => page.environments)) {
      if (!isStaging(name)) continue;
      const env = encodeURIComponent(name);
      const deployments = (route: string) =>
        Effect.map(pages(route), (answer) =>
          answer.code === 0
            ? Option.map(
                Schema.decodeUnknownOption(EnvironmentDeploymentsJson)(answer.stdout),
                (all) => all.flat(),
              )
            : Option.none(),
        );
      const all = yield* deployments(`deployments?environment=${env}&per_page=100`);
      if (Option.isNone(all)) return unread;
      let live: string | null = null;
      let hasCommit = false;
      for (const deployment of all.value) {
        const candidate = deployment.sha === commit;
        if (live !== null && (!candidate || hasCommit)) continue;
        const statuses = yield* run(
          "gh",
          ["api", `${repo}/deployments/${deployment.id}/statuses?per_page=1`],
          cwd,
        );
        const latest = Schema.decodeUnknownOption(StatusesJson)(statuses.stdout);
        if (statuses.code !== 0 || Option.isNone(latest)) return unread;
        if (live === null && latest.value[0]?.state === "success") {
          live = deployment.sha;
        }
        const link =
          /^https:\/\/github\.com\/([^/]+\/[^/]+)\/actions\/runs\/\d+\/job\/(\d+)(?:[/?#]|$)/.exec(
            latest.value[0]?.log_url ?? "",
          );
        if (
          candidate &&
          (jobs === undefined ||
            (link !== null &&
              link[1]?.toLowerCase() === mrPath(ref).toLowerCase() &&
              selected.has(Number(link[2]))))
        )
          hasCommit = true;
      }
      environments.push({ name, live, hasCommit });
    }
    return { ok: true, environments };
  });
}

/** `https://github.com/<o>/<r>/actions/runs/<id>`'s conclusion, or its status while it runs. */
function runStatus<R>(
  url: string,
  cwd: string,
  run: Runner<R>,
): Effect.Effect<string | null, never, R> {
  return Effect.gen(function* () {
    const m =
      /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/actions\/runs\/(\d+)(?:[/?#]\S*)?$/.exec(
        url.trim(),
      );
    if (!m) return null;
    if ((yield* run("gh", ["auth", "status", "--hostname", HOST], cwd)).code !== 0) return null;
    const answer = yield* run("gh", ["api", `repos/${m[1]}/actions/runs/${m[2]}`], cwd);
    if (answer.code !== 0) return null;
    const said = Option.getOrNull(Schema.decodeUnknownOption(RunJson)(answer.stdout));
    return said === null ? null : (said.conclusion ?? said.status);
  });
}

const RunJobsJson = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      jobs: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          status: Schema.String,
          conclusion: optionalText,
          html_url: optionalText,
        }),
      ),
    }),
  ),
);

const RunIdentityJson = Schema.fromJsonString(
  Schema.Struct({
    status: Schema.String,
    conclusion: optionalText,
    head_branch: optionalText,
    head_sha: Schema.String,
  }),
);
const WorkflowRunsJson = Schema.fromJsonString(
  Schema.Struct({ workflow_runs: Schema.Array(Schema.Struct({ html_url: Schema.String })) }),
);

/** The newest Actions run `tag` started in `ref`'s repository, a push or a release. */
function tagPipeline<R>(
  ref: MrRef,
  tag: string,
  cwd: string,
  run: Runner<R>,
): Effect.Effect<TagPipelineRead, never, R> {
  return Effect.gen(function* () {
    if (ref.project === null) return { ok: false, reason: "no repository to read runs of" };
    const listed = yield* run(
      "gh",
      ["api", `repos/${mrPath(ref)}/actions/runs?branch=${encodeURIComponent(tag)}&per_page=1`],
      cwd,
    );
    const runs = Schema.decodeUnknownOption(WorkflowRunsJson)(listed.stdout);
    if (listed.code !== 0 || Option.isNone(runs))
      return { ok: false, reason: `gh could not list ${tag}'s Actions runs in ${ref.project}` };
    return { ok: true, url: runs.value.workflow_runs[0]?.html_url ?? null };
  });
}

/** An Actions run and its jobs; one waiting on an environment's reviewers waits by hand. */
function pipeline<R>(
  url: string,
  cwd: string,
  run: Runner<R>,
): Effect.Effect<PipelineRead, never, R> {
  return Effect.gen(function* () {
    const m =
      /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/actions\/runs\/(\d+)(?:[/?#]\S*)?$/.exec(
        url.trim(),
      );
    if (!m) return { ok: false, reason: `${url} is not a GitHub Actions run` };
    if ((yield* run("gh", ["auth", "status", "--hostname", HOST], cwd)).code !== 0)
      return { ok: false, reason: `gh is not logged in to ${HOST}` };
    const route = `repos/${m[1]}/actions/runs/${m[2]}`;
    const said = yield* run("gh", ["api", route], cwd);
    const status = Schema.decodeUnknownOption(RunIdentityJson)(said.stdout);
    if (said.code !== 0 || Option.isNone(status))
      return { ok: false, reason: `gh could not read ${url}` };
    const listed = yield* run(
      "gh",
      ["api", `${route}/jobs?per_page=100`, "--paginate", "--slurp"],
      cwd,
    );
    const pages = Schema.decodeUnknownOption(RunJobsJson)(listed.stdout);
    if (listed.code !== 0 || Option.isNone(pages))
      return { ok: false, reason: `gh could not list the jobs of ${url}` };
    return {
      ok: true,
      succeeded: status.value.conclusion === "success",
      project: `${HOST}/${m[1]}`,
      ref: status.value.head_branch ?? "",
      sha: status.value.head_sha,
      jobs: pages.value
        .flatMap((page) => page.jobs)
        .map((one) => ({
          name: one.name,
          state:
            one.status === "waiting"
              ? "manual"
              : one.status === "completed"
                ? (CONCLUSIONS.get(one.conclusion ?? "") ?? "failed")
                : one.status === "in_progress"
                  ? "running"
                  : "pending",
          url: one.html_url ?? null,
        })),
    };
  });
}

/** `gh repo clone`, with gh's own login; one nobody logged in to says how to log in. */
function clone<R>(
  project: string,
  into: string,
  cwd: string,
  run: Runner<R>,
): Effect.Effect<Readiness, never, R> {
  return Effect.gen(function* () {
    if ((yield* run("gh", ["auth", "status", "--hostname", HOST], cwd)).code !== 0)
      return {
        ok: false,
        reason: `gh is not logged in to ${HOST}: log in with \`gh auth login --hostname ${HOST}\``,
      };
    const repo = mrPath({ project, iid: "" });
    const cloned = yield* run("gh", ["repo", "clone", repo, into, "--", "--quiet"], cwd);
    return cloned.code === 0
      ? { ok: true, reason: "" }
      : { ok: false, reason: whatItSaid(cloned) || "gh repo clone failed" };
  });
}

const IssuesJson = Schema.fromJsonString(Schema.Array(Issue));

export const github: Forge = {
  name: "github",
  issues: (project, cwd, run) =>
    Effect.gen(function* () {
      const answer = yield* run(
        "gh",
        [
          "issue",
          "list",
          "--repo",
          mrPath({ project, iid: "" }),
          "--state",
          "open",
          "--limit",
          String(2 ** 31 - 1),
          "--json",
          "number,title,body,url",
        ],
        cwd,
      );
      if (answer.code !== 0)
        return { ok: false, reason: whatItSaid(answer) || "issue listing failed" };
      const decoded = Schema.decodeUnknownOption(IssuesJson)(answer.stdout);
      return Option.isSome(decoded)
        ? { ok: true, issues: decoded.value }
        : { ok: false, reason: "issue listing returned invalid JSON" };
    }),
  fileIssue: (project, title, body, cwd, run) =>
    Effect.map(
      run(
        "gh",
        [
          "issue",
          "create",
          "--repo",
          mrPath({ project, iid: "" }),
          "--title",
          title,
          "--body",
          body,
        ],
        cwd,
      ),
      (answer) => filedIssueOf(answer, project, false),
    ),
  commentIssue: (project, number, body, cwd, run) =>
    Effect.map(
      run(
        "gh",
        [
          "issue",
          "comment",
          String(number),
          "--repo",
          mrPath({ project, iid: "" }),
          "--body",
          body,
        ],
        cwd,
      ),
      (answer) => ({
        ok: answer.code === 0,
        reason: answer.code === 0 ? "" : whatItSaid(answer) || "issue comment failed",
      }),
    ),
  clone,
  credentials: (_project, into, run) =>
    keepCredentialHelper(into, HOST, "!gh auth git-credential", run),
  display: "GitHub",
  cli: "gh",
  noun: "pull request",
  webUrl: (project) => `https://${project}`,
  forBranch,
  fromBranch,
  protects,
  job,
  baseJob,
  retryJob,
  jobLog,
  template,
  commands: ({ project, branch, assignee, existing }) => {
    const repo = shellQuote(mrPath({ project, iid: "" }));
    return {
      create: `gh pr create --repo ${repo} --head ${shellQuote(branch)} --assignee ${shellQuote(assignee)} --title "<title>" --body-file <file>`,
      comment:
        existing === null
          ? ""
          : `gh pr comment ${shellQuote(existing)} --repo ${repo} --body-file <file>`,
    };
  },
  ready,
  login,
  details,
  liveTier,
  deployed,
  stagingEnvironments,
  runStatus,
  pipeline,
  tagPipeline,
  readReview,
  reply,
  merge,
  post: (ref, body, approve, cwd, run) =>
    Effect.gen(function* () {
      const where = mrWords(ref).label;
      const repo = ["--repo", mrPath(ref)];
      // One review that is both the note and the approval, as GitHub counts a review.
      const reviewed = approve
        ? yield* run("gh", ["pr", "review", ref.iid, ...repo, "--approve", "--body", body], cwd)
        : null;
      if (reviewed?.code === 0)
        return { ok: true, message: `posted the review to ${where} and approved it` };
      const note = yield* run("gh", ["pr", "comment", ref.iid, ...repo, "--body", body], cwd);
      if (note.code !== 0)
        return { ok: false, message: `gh pr comment ${where} failed (exit ${note.code})` };
      return {
        ok: true,
        message:
          reviewed === null
            ? `posted the review to ${where}`
            : `posted the review to ${where} and did not approve it: gh pr review --approve failed (exit ${reviewed.code})`,
      };
    }),
  mine: (project, cwd, run) =>
    Effect.gen(function* () {
      if (project === null) return [];
      const seen = new Map<string, string>();
      for (const who of ["--assignee", "--author"]) {
        const listed = yield* run(
          "gh",
          [
            "pr",
            "list",
            "--repo",
            mrPath({ project, iid: "" }),
            who,
            "@me",
            "--state",
            "open",
            "--json",
            "number,title",
          ],
          cwd,
        );
        if (listed.code !== 0) continue;
        for (const row of Option.getOrElse(
          Schema.decodeUnknownOption(MineJson)(listed.stdout),
          () => [],
        ))
          if (!seen.has(String(row.number))) seen.set(String(row.number), row.title ?? "");
      }
      return [...seen].map(([iid, title]) => ({ iid, title }));
    }),
  open: (ref, cwd, run) => run("gh", ["pr", "view", ref.iid, "--repo", mrPath(ref), "--web"], cwd),
  review: (ref) => {
    const repo = `--repo ${shellQuote(mrPath(ref))}`;
    const iid = shellQuote(ref.iid);
    return {
      diff: `gh pr diff ${iid} ${repo}`,
      view: `gh pr view ${iid} ${repo} --comments`,
      checkout: `gh pr checkout ${iid} ${repo}`,
    };
  },
};
