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
import type { DeployTier, Forge, ForBranch, FromBranch, FromBranchList, Readiness } from "./forge";
import { Issue, filedIssueOf } from "./issues";

const HOST = "github.com";

const optionalText = Schema.optionalKey(Schema.NullOr(Schema.String));
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
    statusCheckRollup: Schema.optionalKey(
      Schema.NullOr(
        Schema.Array(
          Schema.Struct({
            name: optionalText,
            context: optionalText,
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
    // A check run has a conclusion once it completes; a status context has only a state.
    said:
      one.conclusion ??
      (one.status != null && one.status !== "COMPLETED" ? "PENDING" : (one.state ?? "PENDING")),
  }));
  const red = verdicts.find((one) => RED.has(one.said));
  if (red !== undefined) return { state: "failed", name: red.name };
  if (verdicts.some((one) => !GREEN.has(one.said))) return { state: "running" };
  return { state: "passed" };
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
const StatusesJson = Schema.fromJsonString(Schema.Array(Schema.Struct({ state: Schema.String })));
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
  runStatus,
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
