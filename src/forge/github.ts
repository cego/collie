// The GitHub adapter: everything Collie asks GitHub, through `gh` or over HTTP with gh's
// token. Only github.com.

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
import {
  ForgeHttp,
  graphqlAs,
  pagesAs,
  request,
  requestAs,
  type Answered,
  type ForgeLogin,
} from "./http";
import {
  listIssues,
  createIssue,
  commentIssue,
  postReview,
  viewerLogin,
  myMergeRequests,
} from "./threads";
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

/** GitHub's merge states it would merge in; the rest say why not, or that it is still deciding. */
const MERGES = new Set(["CLEAN", "HAS_HOOKS", "UNSTABLE"]);

/** GitHub's own answer to "can this merge now", which carries its branch protection. */
function mergeabilityOf(
  pull: Pick<Pull, "mergeable" | "mergeStateStatus">,
): Mergeability | undefined {
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
type Pull = PanelPull;

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
export function rollupChecks(rollup: typeof Rollup.Type | null | undefined): ForgeChecks {
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

const Rollup = Schema.Array(
  Schema.Struct({
    name: optionalText,
    context: optionalText,
    detailsUrl: optionalText,
    targetUrl: optionalText,
    status: optionalText,
    conclusion: optionalText,
    state: optionalText,
  }),
);

/** One page of a pull request's panel, as GitHub's GraphQL answers `PANEL`. */
const PanelData = Schema.Struct({
  repository: Schema.NullOr(
    Schema.Struct({
      pullRequest: Schema.NullOr(
        Schema.Struct({
          title: optionalText,
          state: Schema.String,
          isDraft: optionalFlag,
          author: Schema.optionalKey(Schema.NullOr(Login)),
          assignees: Schema.optionalKey(
            Schema.NullOr(Schema.Struct({ nodes: Schema.Array(Login) })),
          ),
          headRefName: optionalText,
          isCrossRepository: optionalFlag,
          baseRefName: optionalText,
          headRefOid: optionalText,
          mergeCommit: Schema.optionalKey(Schema.NullOr(Schema.Struct({ oid: Schema.String }))),
          mergedAt: optionalText,
          mergedBy: Schema.optionalKey(Schema.NullOr(Login)),
          reviewDecision: optionalText,
          comments: Schema.optionalKey(Schema.NullOr(Schema.Struct({ totalCount: Schema.Number }))),
          updatedAt: optionalText,
          url: optionalText,
          autoMergeRequest: Schema.optionalKey(Schema.NullOr(Schema.Struct({}))),
          mergeable: optionalText,
          mergeStateStatus: optionalText,
          commits: Schema.Struct({
            nodes: Schema.Array(
              Schema.Struct({
                commit: Schema.Struct({
                  statusCheckRollup: Schema.NullOr(
                    Schema.Struct({
                      contexts: Schema.Struct({
                        nodes: Rollup,
                        pageInfo: Schema.Struct({
                          hasNextPage: Schema.Boolean,
                          endCursor: optionalText,
                        }),
                      }),
                    }),
                  ),
                }),
              }),
            ),
          }),
        }),
      ),
    }),
  ),
});

/** Every field `gh pr view --json` read for the panel, the head's checks a page at a time. */
const PANEL = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      title state isDraft author { login } assignees(first: 100) { nodes { login } }
      headRefName isCrossRepository baseRefName headRefOid mergeCommit { oid } mergedAt mergedBy { login }
      reviewDecision comments { totalCount } updatedAt url autoMergeRequest { enabledAt }
      mergeable mergeStateStatus
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100, after: $after) {
        nodes { __typename ... on CheckRun { name detailsUrl status conclusion } ... on StatusContext { context targetUrl state } }
        pageInfo { hasNextPage endCursor }
      } } } } }
    }
  }
}`;

/** GitHub's review decision, phrased as a GitLab panel phrases its approvals. */
const APPROVALS = new Map([
  ["APPROVED", "approved"],
  ["CHANGES_REQUESTED", "changes requested"],
  ["REVIEW_REQUIRED", "review required"],
]);

/** One page of `ref`'s panel, its checks from `after`. */
const panelPage = (ref: MrRef, cwd: string, after: string | null) => {
  const [owner = "", name = ""] = mrPath(ref).split("/");
  return graphqlAs(PanelData, LOGIN, cwd, PANEL, { owner, name, number: Number(ref.iid), after });
};

type PanelPull = NonNullable<NonNullable<typeof PanelData.Type.repository>["pullRequest"]>;
type PanelContexts = NonNullable<
  PanelPull["commits"]["nodes"][number]["commit"]["statusCheckRollup"]
>["contexts"];

/** The pull request, with every page of its head's checks. */
const panelOf = (
  ref: MrRef,
  cwd: string,
): Effect.Effect<Answered<{ pull: PanelPull; rollup: typeof Rollup.Type }>, never, ForgeHttp> =>
  Effect.gen(function* () {
    const rollup: Array<(typeof Rollup.Type)[number]> = [];
    let after: string | null = null;
    for (;;) {
      const page: Answered<typeof PanelData.Type> = yield* panelPage(ref, cwd, after);
      if (!page.ok) return page;
      const pull: PanelPull | null | undefined = page.value.repository?.pullRequest;
      if (pull === undefined || pull === null)
        return { ok: false, reason: "GitHub has no such pull request" };
      const contexts: PanelContexts | undefined =
        pull.commits.nodes[0]?.commit.statusCheckRollup?.contexts;
      rollup.push(...(contexts?.nodes ?? []));
      if (contexts?.pageInfo.hasNextPage !== true || !contexts.pageInfo.endCursor)
        return { ok: true, value: { pull, rollup } };
      after = contexts.pageInfo.endCursor;
    }
  });

/** One pull request, in one GraphQL query, and one more per further page of its checks. */
function details(ref: MrRef, cwd: string): Effect.Effect<MrPanel, never, ForgeHttp> {
  return Effect.map(panelOf(ref, cwd), (read) => {
    if (!read.ok)
      return {
        _tag: "Unavailable",
        reason: `could not read ${mrWords(ref).label}: ${read.reason}`,
      };
    const { pull, rollup } = read.value;
    const checks = rollupChecks(rollup);
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
      assignees: (pull.assignees?.nodes ?? [])
        .map((one) => one.login ?? "")
        .filter((login) => login !== ""),
      sourceBranch: pull.headRefName ?? "",
      fork: pull.isCrossRepository === true,
      targetBranch: pull.baseRefName ?? "",
      pipeline: checks.state === "none" ? "" : checks.state,
      checks,
      approvals: APPROVALS.get(pull.reviewDecision ?? "") ?? "",
      unresolved: false,
      notes: pull.comments?.totalCount ?? 0,
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

const login = (cwd: string) => viewerLogin(LOGIN, cwd);

const BranchPull = Schema.Struct({
  number: Schema.Number,
  html_url: optionalText,
  state: Schema.String,
  created_at: Schema.String,
  merged_at: optionalText,
  closed_at: optionalText,
  auto_merge: Schema.optionalKey(Schema.NullOr(Schema.Struct({}))),
});

/** The pull requests from `branch` of the repository's own, in `state`, every page of them. */
const pullsFrom = (project: string, branch: string, state: "open" | "all", cwd: string) => {
  const repo = mrPath({ project, iid: "" });
  const head = encodeURIComponent(`${repo.split("/")[0]}:${branch}`);
  return Effect.map(
    pagesAs(BranchPull, LOGIN, cwd, `repos/${repo}/pulls?head=${head}&state=${state}`),
    (listed) =>
      listed.ok
        ? listed
        : ({
            ok: false,
            reason: `could not list ${repo}'s pull requests from ${branch}: ${listed.reason}`,
          } as const),
  );
};

const DefaultBranch = Schema.Struct({ default_branch: Schema.String });
const ClassicRules = Schema.Struct({
  repository: Schema.Struct({
    branchProtectionRules: Schema.Struct({
      nodes: Schema.Array(Schema.Struct({ pattern: Schema.String })),
    }),
  }),
});
const PAGE = 100;
const CLASSIC_RULES = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { branchProtectionRules(first: ${PAGE}) { nodes { pattern } } } }`;

/**
 * The default branch, the rules active for the name (which GitHub answers for a branch not
 * pushed yet), and the classic protection rules' patterns; null where any is unread.
 */
function protects(
  project: string,
  branch: string,
  cwd: string,
): Effect.Effect<boolean | null, never, ForgeHttp> {
  return Effect.gen(function* () {
    const repo = mrPath({ project, iid: "" });
    const about = yield* rest(DefaultBranch, cwd, `repos/${repo}`);
    if (!about.ok) return null;
    if (about.value.default_branch === branch) return true;
    const active = yield* rest(
      Schema.Array(Schema.Unknown),
      cwd,
      `repos/${repo}/rules/branches/${encodeURIComponent(branch)}`,
    );
    if (!active.ok) return null;
    if (active.value.length > 0) return true;
    const [owner = "", name = ""] = repo.split("/");
    const classic = yield* graphqlAs(ClassicRules, LOGIN, cwd, CLASSIC_RULES, { owner, name });
    if (!classic.ok) return null;
    const nodes = classic.value.repository.branchProtectionRules.nodes;
    // A full page leaves protection unknown.
    if (nodes.length >= PAGE) return null;
    return nodes.some((rule) => new Bun.Glob(rule.pattern).match(branch));
  });
}

/** The open pull request from `branch`; a failed read is not "none". */
function forBranch(
  project: string,
  branch: string,
  cwd: string,
): Effect.Effect<ForBranch, never, ForgeHttp> {
  return Effect.map(pullsFrom(project, branch, "open", cwd), (listed) => {
    if (!listed.ok) return listed;
    const pull = listed.value.find((one) => one.auto_merge != null) ?? listed.value[0];
    if (pull === undefined) return { ok: true, open: null };
    const iid = String(pull.number);
    return {
      ok: true,
      open: {
        iid,
        url: pull.html_url ?? `https://${project}/pull/${iid}`,
        autoMerge: pull.auto_merge != null,
      },
    };
  });
}

/** Every pull request from `branch`, whatever its state; a failed read is not "none". */
function fromBranch(
  project: string,
  branch: string,
  cwd: string,
): Effect.Effect<FromBranchList, never, ForgeHttp> {
  return Effect.map(pullsFrom(project, branch, "all", cwd), (listed) => {
    if (!listed.ok) return listed;
    return {
      ok: true,
      mrs: listed.value.map((pull): FromBranch => {
        const iid = String(pull.number);
        return {
          iid,
          url: pull.html_url ?? `https://${project}/pull/${iid}`,
          state: pull.merged_at ? "merged" : pull.state === "open" ? "open" : "closed",
          created: pull.created_at,
          // A merged pull request is closed too; when it merged is when it ended.
          ended: pull.merged_at ?? pull.closed_at ?? null,
        };
      }),
    };
  });
}

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
const PullRefs = Schema.Struct({
  head: Schema.Struct({ sha: Schema.String }),
  base: Schema.Struct({ ref: Schema.String }),
});
const MergeBase = Schema.Struct({
  merge_base_commit: Schema.NullOr(Schema.Struct({ sha: Schema.String })),
});

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

/** gh's login to github.com, which ForgeHttp asks GitHub with; its token does not expire. */
const LOGIN: ForgeLogin = {
  forge: "github",
  host: HOST,
  key: HOST,
  display: "GitHub",
  cli: "gh",
  notReady: `gh is not logged in to ${HOST}`,
  relogin: `gh auth login --hostname ${HOST}`,
  expiry: () => Effect.succeed(null),
  token: (run, cwd) =>
    Effect.map(run("gh", ["auth", "token", "--hostname", HOST], cwd), (ran) =>
      ran.code === 0 && ran.stdout.trim() !== "" ? ran.stdout.trim() : null,
    ),
  refresh: () => Effect.succeed(false),
};

const rest = <S extends Schema.Decoder<unknown>>(schema: S, cwd: string, path: string) =>
  requestAs(schema, LOGIN, cwd, path);

/** The check run of that name on the pull request's head commit; GitHub lists the newest first. */
function job(ref: MrRef, name: string, cwd: string): Effect.Effect<JobRead, never, ForgeHttp> {
  return Effect.gen(function* () {
    const where = mrWords(ref).label;
    const repo = mrPath({ project: ref.project, iid: "" });
    const pull = yield* rest(PullRefs, cwd, `repos/${repo}/pulls/${ref.iid}`);
    if (!pull.ok) return { ok: false, reason: `could not read ${where}: ${pull.reason}` };
    const head = pull.value.head.sha;
    const found = yield* checkRun(repo, head, name, cwd);
    if (!found.ok)
      return { ok: false, reason: `could not list the check runs on ${head}: ${found.reason}` };
    return {
      ok: true,
      head,
      state: found.value === undefined ? "missing" : stateOf(found.value),
      url: found.value?.html_url ?? null,
      id: found.value === undefined ? null : String(found.value.id),
      merge: null,
    };
  });
}

/** The newest check run named `name` on `ref`, undefined for none. */
const checkRun = (repo: string, ref: string, name: string, cwd: string) =>
  Effect.map(
    checkRuns(repo, ref, `check_name=${encodeURIComponent(name)}`, cwd),
    (runs): Answered<(typeof CheckRuns.Type)["check_runs"][number] | undefined> =>
      runs.ok ? { ok: true, value: runs.value[0] } : runs,
  );

const checkRuns = (repo: string, ref: string, query: string, cwd: string) =>
  Effect.map(rest(CheckRuns, cwd, `repos/${repo}/commits/${ref}/check-runs?${query}`), (listed) =>
    listed.ok ? ({ ok: true, value: listed.value.check_runs } as const) : listed,
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
function baseJob(
  ref: MrRef,
  name: string,
  cwd: string,
): Effect.Effect<BaseJobRead, never, ForgeHttp> {
  return Effect.gen(function* () {
    const where = mrWords(ref).label;
    const repo = mrPath({ project: ref.project, iid: "" });
    const pull = yield* rest(PullRefs, cwd, `repos/${repo}/pulls/${ref.iid}`);
    if (!pull.ok) return { ok: false, reason: `could not read ${where}: ${pull.reason}` };
    const {
      base: { ref: target },
      head: { sha: head },
    } = pull.value;
    const compared = yield* rest(MergeBase, cwd, `repos/${repo}/compare/${target}...${head}`);
    const base = compared.ok ? compared.value.merge_base_commit?.sha : undefined;
    if (base === undefined)
      return {
        ok: false,
        reason: `GitHub would not say where ${where} leaves ${target}${compared.ok ? "" : `: ${compared.reason}`}`,
      };
    const unread = (why: string) =>
      ({ ok: false, reason: `could not list the check runs at ${base}: ${why}` }) as const;
    const there = yield* checkRun(repo, base, name, cwd);
    if (!there.ok) return unread(there.reason);
    if (there.value === undefined) {
      // Only where CI never ran at the merge-base does the target branch's tip stand in for it.
      const any = yield* checkRuns(repo, base, "per_page=1", cwd);
      if (!any.ok) return unread(any.reason);
      if (any.value.length > 0) return { ok: true, at: base, state: "missing", url: null };
    }
    const tip = there.value === undefined ? yield* checkRun(repo, target, name, cwd) : there;
    if (!tip.ok) return unread(tip.reason);
    const found = tip.value;
    if (found === undefined)
      return {
        ok: false,
        reason: `no check run ${name} at ${base.slice(0, 12)} or on ${target}`,
      };
    return { ok: true, at: found.head_sha, state: stateOf(found), url: found.html_url ?? null };
  });
}

const User = Schema.Struct({ login: Schema.String, type: optionalText });
const IssueComment = Schema.Struct({
  id: Schema.Number,
  html_url: Schema.String,
  user: Schema.NullOr(User),
  created_at: Schema.String,
  body: optionalText,
});
const ReviewComment = Schema.Struct({
  id: Schema.Number,
  html_url: Schema.String,
  user: Schema.NullOr(User),
  created_at: Schema.String,
  body: optionalText,
  path: optionalText,
  line: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  original_line: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  in_reply_to_id: Schema.optionalKey(Schema.NullOr(Schema.Number)),
});
const Review = Schema.Struct({
  id: Schema.Number,
  html_url: Schema.String,
  user: Schema.NullOr(User),
  state: Schema.String,
  body: optionalText,
  submitted_at: optionalText,
});
const Threads = Schema.Struct({
  repository: Schema.Struct({
    pullRequest: Schema.Struct({
      reviewThreads: Schema.Struct({
        nodes: Schema.Array(
          Schema.Struct({
            isResolved: Schema.Boolean,
            comments: Schema.Struct({
              nodes: Schema.Array(Schema.Struct({ databaseId: Schema.NullOr(Schema.Number) })),
            }),
          }),
        ),
        pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: optionalText }),
      }),
    }),
  }),
});
const REVIEW_THREADS = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: ${PAGE}, after: $endCursor) { nodes { isResolved comments(first: 1) { nodes { databaseId } } } pageInfo { hasNextPage endCursor } } } } }`;
const Protection = Schema.Struct({
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
});
const PROTECTION = `query($owner: String!, $name: String!, $ref: String!) { repository(owner: $owner, name: $name) { ref(qualifiedName: $ref) { refUpdateRule { requiredApprovingReviewCount requiresCodeOwnerReviews } } } }`;
const BranchRule = Schema.Struct({
  type: Schema.String,
  parameters: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        required_approving_review_count: Schema.optionalKey(Schema.Number),
        require_code_owner_review: optionalFlag,
      }),
    ),
  ),
});

/** The approving reviews `base` requires, or why that cannot be counted. */
const requiredReviews = (repo: string, base: string, cwd: string) =>
  Effect.gen(function* () {
    const [owner = "", name = ""] = repo.split("/");
    const protection = yield* graphqlAs(Protection, LOGIN, cwd, PROTECTION, {
      owner,
      name,
      ref: `refs/heads/${base}`,
    });
    const rulesets = yield* pagesAs(
      BranchRule,
      LOGIN,
      cwd,
      `repos/${repo}/rules/branches/${encodeURIComponent(base)}`,
    );
    if (!protection.ok || !rulesets.ok)
      return {
        ok: false,
        reason: `GitHub would not say how many approvals ${base} requires: ${!protection.ok ? protection.reason : !rulesets.ok ? rulesets.reason : ""}`,
      } as const;
    const rule = protection.value.repository.ref?.refUpdateRule ?? null;
    const pullRules = rulesets.value.filter((one) => one.type === "pull_request");
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
function readReview(ref: MrRef, cwd: string): Effect.Effect<ReviewRead, never, ForgeHttp> {
  return Effect.gen(function* () {
    const where = mrWords(ref).label;
    const me = yield* login(cwd);
    if (me === null) return { ok: false, reason: "gh will not say who it is logged in as" };
    const repo = mrPath(ref);
    const pull = yield* panelOf(ref, cwd);
    if (!pull.ok) return { ok: false, reason: `could not read ${where}: ${pull.reason}` };
    const issueComments = yield* pagesAs(
      IssueComment,
      LOGIN,
      cwd,
      `repos/${repo}/issues/${ref.iid}/comments`,
    );
    if (!issueComments.ok) return issueComments;
    const reviewComments = yield* pagesAs(
      ReviewComment,
      LOGIN,
      cwd,
      `repos/${repo}/pulls/${ref.iid}/comments`,
    );
    if (!reviewComments.ok) return reviewComments;
    const reviews = yield* pagesAs(Review, LOGIN, cwd, `repos/${repo}/pulls/${ref.iid}/reviews`);
    if (!reviews.ok) return reviews;
    const [owner = "", name = ""] = repo.split("/");
    const resolved = new Set<string>();
    let endCursor: string | null = null;
    for (;;) {
      const page: Answered<typeof Threads.Type> = yield* graphqlAs(
        Threads,
        LOGIN,
        cwd,
        REVIEW_THREADS,
        {
          owner,
          name,
          number: Number(ref.iid),
          endCursor,
        },
      );
      if (!page.ok) return page;
      const threads: typeof Threads.Type.repository.pullRequest.reviewThreads =
        page.value.repository.pullRequest.reviewThreads;
      for (const thread of threads.nodes) {
        const first = thread.comments.nodes[0]?.databaseId;
        if (thread.isResolved && first != null) resolved.add(String(first));
      }
      if (!threads.pageInfo.hasNextPage) break;
      endCursor = threads.pageInfo.endCursor ?? null;
      if (endCursor === null)
        return {
          ok: false,
          reason: `GitHub did not name the next page of ${where}'s review threads`,
        };
    }
    const kindOf = (user: typeof User.Type | null): CommentKind =>
      user?.type === "Bot" ? "bot" : "person";
    const comments: ForgeComment[] = [
      ...issueComments.value.map((one) => ({
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
      ...reviewComments.value.map((one) => ({
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
      ...reviews.value.flatMap((one) =>
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
    for (const one of reviews.value)
      if (one.user !== null && one.state !== "COMMENTED" && one.state !== "PENDING")
        standing.set(one.user.login, { state: one.state, bot: one.user.type === "Bot" });
    const approvers = [...standing]
      .filter(([, review]) => review.state === "APPROVED")
      .map(([who]) => who);
    const others = approvers.filter((who) => who !== me);
    const changesRequested = [...standing].some(
      ([who, review]) => review.state === "CHANGES_REQUESTED" && !review.bot && who !== me,
    );
    const said = pull.value.pull;
    const decision = said.reviewDecision ?? "";
    const unapproved = yield* Effect.gen(function* () {
      if (decision === "CHANGES_REQUESTED") return "changes were requested";
      if (decision === "REVIEW_REQUIRED") return "a review is still required";
      if (decision !== "APPROVED") return changesRequested ? "changes were requested" : "";
      if (!approvers.includes(me)) return "";
      const required = yield* requiredReviews(repo, said.baseRefName ?? "", cwd);
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
      pipeline: rollupChecks(pull.value.rollup),
      comments: judgeComments(comments, me, resolved),
    };
  });
}

/** A reply in a review comment's thread, else a new comment on the pull request. */
function reply(
  ref: MrRef,
  to: Pick<ForgeComment, "thread">,
  body: string,
  cwd: string,
): Effect.Effect<Readiness, never, ForgeHttp> {
  const repo = mrPath(ref);
  const route =
    to.thread === null
      ? `repos/${repo}/issues/${ref.iid}/comments`
      : `repos/${repo}/pulls/${ref.iid}/comments/${to.thread}/replies`;
  return Effect.map(request(LOGIN, cwd, "POST", route, { body }), (posted) =>
    posted.ok
      ? { ok: true, reason: "" }
      : {
          ok: false,
          reason: `could not reply on ${mrWords(ref).label}: ${posted.reason}; inspect the thread before retrying, since the reply may have landed`,
        },
  );
}

const MergeMethod = Schema.Struct({
  repository: Schema.NullOr(
    Schema.Struct({
      viewerDefaultMergeMethod: Schema.Literals(["MERGE", "SQUASH", "REBASE"]),
    }),
  ),
});
const MERGE_METHOD = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { viewerDefaultMergeMethod } }`;
const MergedPull = Schema.Struct({
  state: Schema.String,
  headRefOid: optionalText,
  mergeCommit: Schema.optionalKey(Schema.NullOr(Schema.Struct({ oid: Schema.String }))),
  mergedAt: optionalText,
  mergedBy: Schema.optionalKey(Schema.NullOr(Login)),
});
const MergedData = Schema.Struct({
  repository: Schema.NullOr(Schema.Struct({ pullRequest: Schema.NullOr(MergedPull) })),
});
const MERGED_PULL = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { state headRefOid mergeCommit { oid } mergedAt mergedBy { login } } } }`;

/** GitHub's merge endpoint at `head`, by the repository's default merge method for the viewer. */
function merge(
  ref: MrRef,
  head: string,
  cwd: string,
): Effect.Effect<MergeAnswer, never, ForgeHttp> {
  return Effect.gen(function* () {
    const where = mrWords(ref).label;
    const repo = mrPath(ref);
    const [owner = "", name = ""] = repo.split("/");
    const method = yield* graphqlAs(MergeMethod, LOGIN, cwd, MERGE_METHOD, { owner, name });
    if (!method.ok || method.value.repository === null)
      return {
        _tag: "Refused",
        reason: `gh would not say how ${repo} merges${!method.ok ? `: ${method.reason}` : ""}`,
      };
    const merging = yield* request(LOGIN, cwd, "PUT", `repos/${repo}/pulls/${ref.iid}/merge`, {
      sha: head,
      merge_method: method.value.repository.viewerDefaultMergeMethod.toLowerCase(),
    });
    const after = yield* graphqlAs(MergedData, LOGIN, cwd, MERGED_PULL, {
      owner,
      name,
      number: Number(ref.iid),
    });
    const pull = after.ok ? (after.value.repository?.pullRequest ?? null) : null;
    if (merging.ok) return { _tag: "Merged", merged: pull?.mergeCommit?.oid ?? "" };
    const refusal = `GitHub refused to merge ${where}: ${merging.reason}`;
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

function retryJob(ref: MrRef, id: string, cwd: string): Effect.Effect<Readiness, never, ForgeHttp> {
  const repo = mrPath({ project: ref.project, iid: "" });
  return Effect.map(request(LOGIN, cwd, "POST", `repos/${repo}/actions/jobs/${id}/rerun`), (ran) =>
    ran.ok
      ? { ok: true, reason: "" }
      : { ok: false, reason: `could not rerun job ${id} of ${mrWords(ref).label}: ${ran.reason}` },
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

const Deployment = Schema.Struct({
  id: Schema.Number,
  sha: Schema.String,
  environment: Schema.String,
  production_environment: optionalFlag,
});
const Statuses = Schema.Array(Schema.Struct({ state: Schema.String, log_url: optionalText }));
const Compare = Schema.Struct({ status: Schema.String });
const RunState = Schema.Struct({ status: Schema.String, conclusion: optionalText });

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
function liveTier(
  ref: MrRef,
  mergedSha: string,
  cwd: string,
): Effect.Effect<DeployTier | null, never, ForgeHttp> {
  return Effect.gen(function* () {
    if (mergedSha === "" || ref.project === null) return null;
    const repo = `repos/${mrPath(ref)}`;
    const listed = yield* pagesAs(Deployment, LOGIN, cwd, `${repo}/deployments`);
    if (!listed.ok) return null;
    // Newest first, so the first successful one seen per environment is what is live there.
    const live = new Map<string, { readonly sha: string; readonly tier: DeployTier }>();
    for (const deployment of listed.value) {
      const tier = tierOf(deployment.environment, deployment.production_environment === true);
      if (tier === null || live.has(deployment.environment)) continue;
      const statuses = yield* rest(
        Statuses,
        cwd,
        `${repo}/deployments/${deployment.id}/statuses?per_page=1`,
      );
      if (statuses.ok && statuses.value[0]?.state === "success")
        live.set(deployment.environment, { sha: deployment.sha, tier });
    }
    const carries = (sha: string) =>
      Effect.gen(function* () {
        if (sha === mergedSha) return true;
        const compared = yield* rest(Compare, cwd, `${repo}/compare/${mergedSha}...${sha}`);
        return (
          compared.ok &&
          (compared.value.status === "identical" || compared.value.status === "ahead")
        );
      });
    for (const tier of ["production", "staging"] as const)
      for (const one of live.values())
        if (one.tier === tier && (yield* carries(one.sha))) return tier;
    return null;
  });
}

/** The commit the newest deployment of `tier` whose latest status is `success` has. */
function deployed(
  ref: MrRef,
  tier: DeployTier,
  cwd: string,
): Effect.Effect<DeployedRead, never, ForgeHttp> {
  return Effect.gen(function* () {
    if (ref.project === null) return { ok: false, reason: "no repository to read deployments of" };
    const repo = `repos/${mrPath(ref)}`;
    const pages = yield* pagesAs(Deployment, LOGIN, cwd, `${repo}/deployments`);
    if (!pages.ok) return pages;
    for (const deployment of pages.value) {
      if (tierOf(deployment.environment, deployment.production_environment === true) !== tier)
        continue;
      const latest = yield* rest(
        Statuses,
        cwd,
        `${repo}/deployments/${deployment.id}/statuses?per_page=1`,
      );
      if (!latest.ok) return latest;
      if (latest.value[0]?.state === "success") return { ok: true, sha: deployment.sha };
    }
    return { ok: true, sha: null };
  });
}

const EnvironmentPage = Schema.Struct({
  environments: Schema.Array(Schema.Struct({ name: Schema.String })),
});

const isStaging = (name: string) => /^(?:.+[-_/ ])?(?:stage|staging)(?:[-_/ ].+)?$/i.test(name);

function stagingEnvironments<R>(
  ref: MrRef,
  commit: string | null,
  cwd: string,
  _run: Runner<R>,
  jobs?: ReadonlyArray<string>,
): Effect.Effect<StagingRead, never, ForgeHttp> {
  return Effect.gen(function* () {
    if (ref.project === null) return { ok: false, reason: "no repository to read deployments of" };
    const repo = `repos/${mrPath(ref)}`;
    const unread = (reason: string) => ({
      ok: false as const,
      reason: `GitHub could not read ${ref.project}'s stage environments: ${reason}`,
    });
    const selected = new Set<number>();
    if (jobs !== undefined && commit !== null) {
      for (const job of jobs) {
        for (let page = 1; ; page++) {
          const checks = yield* rest(
            CheckRuns,
            cwd,
            `${repo}/commits/${commit}/check-runs?check_name=${encodeURIComponent(job)}&filter=all&per_page=100&page=${page}`,
          );
          if (!checks.ok) return unread(checks.reason);
          for (const check of checks.value.check_runs) selected.add(check.id);
          if (checks.value.check_runs.length < 100) break;
        }
      }
    }
    const names: string[] = [];
    for (let page = 1; ; page++) {
      const named = yield* rest(
        EnvironmentPage,
        cwd,
        `${repo}/environments?per_page=100&page=${page}`,
      );
      if (!named.ok) return unread(named.reason);
      for (const { name } of named.value.environments) if (isStaging(name)) names.push(name);
      if (named.value.environments.length < 100) break;
    }
    const environments: StagingEnvironment[] = [];
    for (const name of names) {
      const all = yield* pagesAs(
        Deployment,
        LOGIN,
        cwd,
        `${repo}/deployments?environment=${encodeURIComponent(name)}`,
      );
      if (!all.ok) return unread(all.reason);
      let live: string | null = null;
      let hasCommit = false;
      for (const deployment of all.value) {
        const candidate = deployment.sha === commit;
        if (live !== null && (!candidate || hasCommit)) continue;
        const latest = yield* rest(
          Statuses,
          cwd,
          `${repo}/deployments/${deployment.id}/statuses?per_page=1`,
        );
        if (!latest.ok) return unread(latest.reason);
        if (live === null && latest.value[0]?.state === "success") live = deployment.sha;
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
function runStatus(url: string, cwd: string): Effect.Effect<string | null, never, ForgeHttp> {
  return Effect.gen(function* () {
    const m =
      /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/actions\/runs\/(\d+)(?:[/?#]\S*)?$/.exec(
        url.trim(),
      );
    if (!m) return null;
    const said = yield* rest(RunState, cwd, `repos/${m[1]}/actions/runs/${m[2]}`);
    return said.ok ? (said.value.conclusion ?? said.value.status) : null;
  });
}

const RunJob = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  conclusion: optionalText,
  html_url: optionalText,
});
const RunJobs = Schema.Struct({ jobs: Schema.Array(RunJob) });
const RunIdentity = Schema.Struct({
  status: Schema.String,
  conclusion: optionalText,
  head_branch: optionalText,
  head_sha: Schema.String,
});
const WorkflowRuns = Schema.Struct({
  workflow_runs: Schema.Array(Schema.Struct({ html_url: Schema.String })),
});

/** The newest Actions run `tag` started in `ref`'s repository, a push or a release. */
function tagPipeline(
  ref: MrRef,
  tag: string,
  cwd: string,
): Effect.Effect<TagPipelineRead, never, ForgeHttp> {
  return Effect.gen(function* () {
    if (ref.project === null) return { ok: false, reason: "no repository to read runs of" };
    const runs = yield* rest(
      WorkflowRuns,
      cwd,
      `repos/${mrPath(ref)}/actions/runs?branch=${encodeURIComponent(tag)}&per_page=1`,
    );
    if (!runs.ok) return runs;
    return { ok: true, url: runs.value.workflow_runs[0]?.html_url ?? null };
  });
}

/** An Actions run and its jobs; one waiting on an environment's reviewers waits by hand. */
function pipeline(url: string, cwd: string): Effect.Effect<PipelineRead, never, ForgeHttp> {
  return Effect.gen(function* () {
    const m =
      /^https?:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/actions\/runs\/(\d+)(?:[/?#]\S*)?$/.exec(
        url.trim(),
      );
    if (!m) return { ok: false, reason: `${url} is not a GitHub Actions run` };
    const route = `repos/${m[1]}/actions/runs/${m[2]}`;
    const status = yield* rest(RunIdentity, cwd, route);
    if (!status.ok) return status;
    const jobs: Array<typeof RunJob.Type> = [];
    for (let page = 1; ; page++) {
      const listed = yield* rest(RunJobs, cwd, `${route}/jobs?per_page=100&page=${page}`);
      if (!listed.ok) return listed;
      jobs.push(...listed.value.jobs);
      if (listed.value.jobs.length < 100) break;
    }
    return {
      ok: true,
      succeeded: status.value.conclusion === "success",
      project: `${HOST}/${m[1]}`,
      ref: status.value.head_branch ?? "",
      sha: status.value.head_sha,
      jobs: jobs.map((one) => ({
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

export const github: Forge = {
  name: "github",
  issues: (project, cwd, _run, numbers) => listIssues(LOGIN, project, cwd, numbers),
  fileIssue: (project, title, body, cwd) => createIssue(LOGIN, project, title, body, cwd),
  commentIssue: (project, number, body, cwd) => commentIssue(LOGIN, project, number, body, cwd),
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
  post: (ref, body, approve, cwd) =>
    ref.project === null
      ? Effect.succeed({ ok: false, message: `${mrWords(ref).label} names no GitHub project` })
      : postReview(LOGIN, ref.project, ref, body, approve, cwd),
  mine: (project, cwd) =>
    project === null ? Effect.succeed([]) : myMergeRequests(LOGIN, project, cwd),
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
