// A fake of each forge, from one model: a Runner answering the argv its adapter uses, and
// a FakeBin executable answering from the same model for host-driven tests. Both log
// every call they get.

import { Config, Effect, FileSystem, Path, Schema } from "effect";
import type { MrForge } from "../../src/board-model";
import type { Ran, Runner } from "../../src/mr";
import type { FakeBin } from "./bin";
import { shellQuote } from "../../src/script";

export const Check = Schema.Struct({
  name: Schema.String,
  state: Schema.Literals(["passed", "failed", "running"]),
});
export type Check = typeof Check.Type;

/** A pipeline job on a merge request's head, in the words a check left to CI is read in. */
const JobStates = Schema.Literals([
  "passed",
  "pending",
  "running",
  "failed",
  "skipped",
  "cancelled",
]);
export const FakeJob = Schema.Struct({
  name: Schema.String,
  state: JobStates,
  /** What a retry leaves it in; unchanged where unsaid. */
  retried: Schema.optionalKey(JobStates),
  /** Its id once retried, as the forge gives a retry a job of its own. */
  id: Schema.optionalKey(Schema.Number),
});
export type FakeJob = typeof FakeJob.Type;

export const FakeMr = Schema.Struct({
  /** `host/path`, as an `MrRef`'s project. */
  project: Schema.String,
  iid: Schema.String,
  state: Schema.Literals(["open", "merged", "closed"]),
  draft: Schema.optionalKey(Schema.Boolean),
  title: Schema.optionalKey(Schema.String),
  author: Schema.optionalKey(Schema.String),
  assignees: Schema.optionalKey(Schema.Array(Schema.String)),
  head: Schema.optionalKey(Schema.String),
  /** The revision its pipeline ran on, where that is not its head. */
  pipelineAt: Schema.optionalKey(Schema.String),
  mergedSha: Schema.optionalKey(Schema.String),
  checks: Schema.optionalKey(Schema.Array(Check)),
  /** Its head pipeline's jobs, the nth with id n; on GitLab its pipeline ran at `pipelineAt`. */
  jobs: Schema.optionalKey(Schema.Array(FakeJob)),
  /** Where its head leaves its target branch, and that commit's pipeline jobs, if it has a pipeline. */
  base: Schema.optionalKey(
    Schema.Struct({ at: Schema.String, jobs: Schema.optionalKey(Schema.Array(FakeJob)) }),
  ),
  /** Its target branch's latest pipeline: the commit it ran on, and its jobs. */
  target: Schema.optionalKey(Schema.Struct({ at: Schema.String, jobs: Schema.Array(FakeJob) })),
  sourceBranch: Schema.optionalKey(Schema.String),
  fork: Schema.optionalKey(Schema.Boolean),
  targetBranch: Schema.optionalKey(Schema.String),
  autoMerge: Schema.optionalKey(Schema.Boolean),
  approved: Schema.optionalKey(Schema.Boolean),
  updatedAt: Schema.optionalKey(Schema.String),
  createdAt: Schema.optionalKey(Schema.String),
  mergedAt: Schema.optionalKey(Schema.String),
  closedAt: Schema.optionalKey(Schema.String),
  /** Whether the forge would merge it now; mergeable where unsaid. */
  mergeable: Schema.optionalKey(Schema.Literals(["yes", "conflict", "unapproved", "checking"])),
});
export type FakeMr = typeof FakeMr.Type;

const FakeIssue = Schema.Struct({
  project: Schema.String,
  number: Schema.Int,
  title: Schema.String,
  body: Schema.String,
  state: Schema.Literals(["open", "closed"]),
});
type FakeIssue = typeof FakeIssue.Type;

const GITLAB_MERGE_STATUS = {
  yes: "mergeable",
  conflict: "conflict",
  unapproved: "not_approved",
  checking: "checking",
} as const;

const GITHUB_MERGE_STATE = {
  yes: { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" },
  conflict: { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" },
  unapproved: { mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" },
  checking: { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" },
} as const;

export const ForgeModel = Schema.Struct({
  installed: Schema.Boolean,
  /** Hosts the CLI is logged in to. */
  loggedIn: Schema.Array(Schema.String),
  login: Schema.NullOr(Schema.String),
  mrs: Schema.Array(FakeMr),
  issues: Schema.optionalKey(Schema.Array(FakeIssue)),
  issueNotes: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  /** The checkout's `origin` and `upstream` remote URLs, and the branch it is on. */
  origin: Schema.optionalKey(Schema.String),
  upstream: Schema.optionalKey(Schema.String),
  branch: Schema.optionalKey(Schema.String),
  /** Each environment, and the sha its newest successful deployment has. */
  environments: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        tier: Schema.String,
        deployed: Schema.optionalKey(Schema.String),
        /** A newer deployment there that failed, which is not what is live. */
        failed: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
  /** Pipelines and Actions runs, by id. */
  runs: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({ status: Schema.String, conclusion: Schema.optionalKey(Schema.String) }),
    ),
  ),
  /** The shas each sha descends from. */
  ancestry: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  /** Repositories gh cannot read, by `owner/repo`. */
  unreadable: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The deploy API does not answer. */
  deploysDown: Schema.optionalKey(Schema.Boolean),
  /** Notes posted, by `project!iid` or `project#iid`. */
  notes: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  /** What was cloned, as `<host/path> <directory>`. */
  cloned: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Merge requests approved, by the same key. */
  approved: Schema.optionalKey(Schema.Array(Schema.String)),
  /** The forge refuses an approval, as it does one by the author. */
  refusesApproval: Schema.optionalKey(Schema.Boolean),
});
export type ForgeModel = typeof ForgeModel.Type;
const ModelJson = Schema.fromJsonString(ForgeModel);

export const FORGE_HOST = { gitlab: "gitlab.example.com", github: "github.com" } as const;
export const PROJECT = {
  gitlab: "gitlab.example.com/group/app",
  github: "github.com/owner/repo",
} as const;

export const CLI = { gitlab: "glab", github: "gh" } as const;

/** One answer, and the note it posted where it posted one. */
interface Answer {
  readonly ran: Ran;
  readonly filedIssue?: FakeIssue;
  readonly issueNoted?: { readonly key: string; readonly body: string };
  readonly cloned?: string;
  readonly noted?: { readonly key: string; readonly body: string };
  readonly approved?: string;
  readonly retried?: { readonly mr: FakeMr; readonly at: number };
}

const Json = Schema.fromJsonString(Schema.Json);
const ok = (stdout = ""): Answer => ({ ran: { code: 0, stdout } });
const json = (value: Schema.Json): Answer => ok(Schema.encodeSync(Json)(value));
const no = (code = 1): Answer => ({ ran: { code, stdout: "" } });

const flag = (args: ReadonlyArray<string>, name: string) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

function issueAnswer(forge: MrForge, model: ForgeModel, args: ReadonlyArray<string>): Answer {
  const project = `${forge === "github" ? "github.com/" : ""}${flag(args, "--repo") ?? ""}`;
  const issues = (model.issues ?? []).filter((one) => one.project === project);
  const url = (number: number) =>
    `https://${project}/${forge === "gitlab" ? "-/issues" : "issues"}/${number}`;
  if (args[1] === "list") {
    const open = issues.filter((one) => one.state === "open");
    const page = Number(flag(args, "--page") ?? "1");
    const size = Number(flag(args, "--per-page") ?? flag(args, "--limit") ?? "30");
    return json(
      open.slice((page - 1) * size, page * size).map((one): Schema.Json =>
        forge === "github"
          ? { number: one.number, title: one.title, body: one.body, url: url(one.number) }
          : {
              iid: one.number,
              title: one.title,
              description: one.body,
              web_url: url(one.number),
            },
      ),
    );
  }
  if (args[1] === "create") {
    const number = Math.max(0, ...issues.map((one) => one.number)) + 1;
    return {
      ...ok(`${url(number)}\n`),
      filedIssue: {
        project,
        number,
        title: flag(args, "--title") ?? "",
        body: flag(args, forge === "github" ? "--body" : "--description") ?? "",
        state: "open",
      },
    };
  }
  if (args[1] === "comment" || args[1] === "note") {
    const number = Number(args[2]);
    if (!issues.some((one) => one.number === number)) return no();
    return {
      ...ok(),
      issueNoted: {
        key: `${project}#${number}`,
        body: flag(args, forge === "github" ? "--body" : "--message") ?? "",
      },
    };
  }
  return no();
}

const keyOf = (forge: MrForge, mr: FakeMr) =>
  `${mr.project}${forge === "github" ? "#" : "!"}${mr.iid}`;

/** Open merge requests the logged-in user is assigned to (`--assignee`) or wrote (`--author`). */
const mine = (model: ForgeModel, who: string | undefined) =>
  model.mrs.filter(
    (one) =>
      one.state === "open" &&
      model.login !== null &&
      (who === "--assignee"
        ? (one.assignees ?? []).includes(model.login)
        : one.author === model.login),
  );

function pipelineOf(checks: ReadonlyArray<Check> | undefined): string | null {
  if (checks === undefined || checks.length === 0) return null;
  if (checks.some((one) => one.state === "failed")) return "failed";
  if (checks.some((one) => one.state === "running")) return "running";
  return "success";
}

const GITLAB_JOB = {
  passed: "success",
  pending: "pending",
  running: "running",
  failed: "failed",
  skipped: "skipped",
  cancelled: "canceled",
} as const;

const GITHUB_RUN = {
  passed: { status: "completed", conclusion: "success" },
  pending: { status: "queued", conclusion: null },
  running: { status: "in_progress", conclusion: null },
  failed: { status: "completed", conclusion: "failure" },
  skipped: { status: "completed", conclusion: "skipped" },
  cancelled: { status: "completed", conclusion: "cancelled" },
} as const;

/** The id a merge request's head pipeline has; its base's is one more, its target's two. */
const pipelineIdOf = (mr: FakeMr) => Number(mr.iid) * 100;

/** A job as a forge lists it: the head pipeline's nth has id n, its base's 1000 + n, its target's 2000 + n. */
const jobsOf = (jobs: ReadonlyArray<FakeJob>, from: number) =>
  jobs.map((job, at) => ({ ...job, id: job.id ?? from + at + 1 }));

/** The merge request a project's job `id` is on its head pipeline of. */
const headJobAt = (model: ForgeModel, project: (mr: FakeMr) => boolean, id: number) => {
  for (const mr of model.mrs.filter(project)) {
    const at = jobsOf(mr.jobs ?? [], 0).findIndex((job) => job.id === id);
    if (at !== -1) return { mr, at };
  }
  return undefined;
};

function glab(model: ForgeModel, args: ReadonlyArray<string>): Answer {
  if (!model.installed) return no(127);
  const [verb, sub] = args;
  if (verb === "issue") return issueAnswer("gitlab", model, args);
  if (verb === "--version") return ok("glab 1.0.0");
  if (verb === "auth" && sub === "status") {
    const host = flag(args, "--hostname");
    return host === undefined || model.loggedIn.includes(host) ? ok() : no();
  }
  if (verb === "api" && sub === "user")
    return model.login === null ? no() : json({ username: model.login });
  const mrAt = (iid: string | undefined) => {
    const repo = flag(args, "--repo");
    return model.mrs.find((one) => one.iid === iid && (repo === undefined || one.project === repo));
  };
  if (verb === "mr" && sub === "view") {
    const mr = mrAt(args[2]);
    if (mr === undefined) return no();
    const pipeline = pipelineOf(mr.checks);
    return json({
      iid: Number(mr.iid),
      title: mr.title ?? "",
      state: mr.state === "open" ? "opened" : mr.state,
      draft: mr.draft ?? false,
      author: { username: mr.author ?? "" },
      assignees: (mr.assignees ?? []).map((username) => ({ username })),
      sha: mr.head ?? null,
      merge_commit_sha: mr.mergedSha ?? null,
      merged_at: mr.mergedAt ?? null,
      head_pipeline:
        pipeline === null && mr.jobs === undefined
          ? null
          : {
              id: pipelineIdOf(mr),
              status: pipeline ?? "running",
              sha: mr.pipelineAt ?? mr.head ?? null,
            },
      source_branch: mr.sourceBranch ?? null,
      source_project_id: mr.fork === true ? 7 : 3,
      target_project_id: 3,
      target_branch: mr.targetBranch ?? null,
      diff_refs: { base_sha: mr.base?.at ?? null },
      merge_when_pipeline_succeeds: mr.autoMerge ?? false,
      approvals_left: mr.approved === true ? 0 : null,
      detailed_merge_status: GITLAB_MERGE_STATUS[mr.mergeable ?? "yes"],
      updated_at: mr.updatedAt ?? null,
      web_url: `https://${mr.project}/-/merge_requests/${mr.iid}`,
    });
  }
  if (verb === "mr" && sub === "list" && flag(args, "--source-branch") !== undefined) {
    const repo = flag(args, "--repo");
    if (repo !== undefined && !model.loggedIn.includes(repo.split("/")[0]!)) return no();
    return json(
      model.mrs
        .filter(
          (one) =>
            (args.includes("--all") || one.state === "open") &&
            one.sourceBranch === flag(args, "--source-branch") &&
            (repo === undefined || one.project === repo),
        )
        .map((one) => ({
          iid: Number(one.iid),
          web_url: `https://${one.project}/-/merge_requests/${one.iid}`,
          merge_when_pipeline_succeeds: one.autoMerge ?? false,
          state: one.state === "open" ? "opened" : one.state,
          created_at: one.createdAt ?? null,
          merged_at: one.mergedAt ?? null,
          closed_at: one.closedAt ?? null,
        })),
    );
  }
  if (verb === "config" && sub === "get" && args[2] === "token") {
    const host = flag(args, "--host") ?? "";
    return model.loggedIn.includes(host) ? ok("glpat-fake\n") : ok("");
  }
  if (verb === "mr" && sub === "list" && args[3] === "@me")
    return json(
      mine(model, args[2]).map((one) => ({ iid: Number(one.iid), title: one.title ?? "" })),
    );
  if (verb === "mr" && sub === "approve") {
    const mr = mrAt(args[2]);
    if (mr === undefined || model.refusesApproval === true) return no();
    return { ...ok(), approved: keyOf("gitlab", mr) };
  }
  if (verb === "mr" && sub === "note") {
    const mr = mrAt(args[2]);
    if (mr === undefined) return no();
    return { ...ok(), noted: { key: keyOf("gitlab", mr), body: flag(args, "--message") ?? "" } };
  }
  if (verb === "api" && flag(args, "--hostname") !== undefined) {
    if (model.deploysDown === true) return no();
    const route = args.at(-1) ?? "";
    const environments = model.environments ?? [];
    if (route.endsWith("/environments"))
      return json(environments.map(({ name, tier }) => ({ name, tier })));
    if (route.includes("/deployments?"))
      return json(
        environments.flatMap((env) =>
          env.deployed === undefined
            ? []
            : [{ sha: env.deployed, environment: { name: env.name } }],
        ),
      );
    const retry = /^projects\/([^/]+)\/jobs\/(\d+)\/retry$/.exec(route);
    if (retry && args.includes("POST")) {
      const path = decodeURIComponent(retry[1]!);
      const found = headJobAt(model, (one) => one.project.endsWith(`/${path}`), Number(retry[2]));
      return found === undefined ? no() : { ...json({ id: Number(retry[2]) }), retried: found };
    }
    const bySha = /\/pipelines\?sha=([^&]+)/.exec(route);
    if (bySha) {
      const sha = bySha[1]!;
      const mr = model.mrs.find((one) => one.base?.at === sha && one.base?.jobs !== undefined);
      return json(mr === undefined ? [] : [{ id: pipelineIdOf(mr) + 1, sha }]);
    }
    const byRef = /\/pipelines\?ref=([^&]+)/.exec(route);
    if (byRef) {
      const mr = model.mrs.find(
        (one) => one.targetBranch === decodeURIComponent(byRef[1]!) && one.target !== undefined,
      );
      return json(mr === undefined ? [] : [{ id: pipelineIdOf(mr) + 2, sha: mr.target!.at }]);
    }
    const jobs = /\/pipelines\/(\d+)\/jobs/.exec(route);
    if (jobs) {
      const id = Number(jobs[1]);
      const mr = model.mrs.find((one) => Math.floor(id / 100) === Number(one.iid));
      const listed =
        mr === undefined
          ? undefined
          : [
              jobsOf(mr.jobs ?? [], 0),
              jobsOf(mr.base?.jobs ?? [], 1000),
              jobsOf(mr.target?.jobs ?? [], 2000),
            ][id - pipelineIdOf(mr)];
      const page = Number(/[?&]page=(\d+)/.exec(route)?.[1] ?? "1");
      const size = Number(/[?&]per_page=(\d+)/.exec(route)?.[1] ?? "20");
      return mr === undefined || listed === undefined
        ? no()
        : json(
            listed.slice((page - 1) * size, page * size).map((job) => ({
              id: job.id,
              name: job.name,
              status: GITLAB_JOB[job.state],
              web_url: `https://${mr.project}/-/jobs/${job.id}`,
            })),
          );
    }
    const commit = /\/repository\/commits\/([^/?]+)$/.exec(route);
    if (commit) {
      const parents = model.ancestry?.[commit[1]!];
      return parents === undefined ? no() : json({ id: commit[1]!, parent_ids: [...parents] });
    }
    const pipeline = /\/pipelines\/(\d+)$/.exec(route);
    if (pipeline) {
      const said = model.runs?.[pipeline[1]!];
      return said === undefined ? no() : json({ status: said.status });
    }
    const base = /merge_base\?refs\[\]=([^&]+)&refs\[\]=(.+)$/.exec(route);
    if (base) {
      const [, merged = "", live = ""] = base;
      const carries = live === merged || (model.ancestry?.[live] ?? []).includes(merged);
      return json({ id: carries ? merged : "0000000" });
    }
  }
  return no();
}

/** Each environment's deployments, newest first: a failed newer one, then what is live. */
const deploymentsOf = (model: ForgeModel) =>
  (model.environments ?? []).flatMap((env, at) => [
    ...(env.failed === undefined || env.failed === ""
      ? []
      : [{ id: at * 10 + 1, sha: env.failed, environment: env.name, state: "failure" }]),
    ...(env.deployed === undefined
      ? []
      : [{ id: at * 10 + 2, sha: env.deployed, environment: env.name, state: "success" }]),
  ]);

/** `gh api repos/<o>/<r>/…`, for deployments, compare and Actions runs. */
function ghApi(model: ForgeModel, route: string, args: ReadonlyArray<string>): Answer {
  if (model.deploysDown === true) return no();
  const tierOf = (name: string) =>
    (model.environments ?? []).find((env) => env.name === name)?.tier;
  if (/\/deployments\?/.test(route)) {
    const deployments = deploymentsOf(model).map(({ id, sha, environment }) => ({
      id,
      sha,
      environment,
      production_environment: tierOf(environment) === "production",
    }));
    if (!args.includes("--paginate")) return json(deployments.slice(0, 100));
    const pages = [];
    for (let at = 0; at < deployments.length; at += 100)
      pages.push(deployments.slice(at, at + 100));
    return args.includes("--slurp") ? json(pages) : no();
  }
  const statuses = /\/deployments\/(\d+)\/statuses/.exec(route);
  if (statuses) {
    const one = deploymentsOf(model).find((deployment) => deployment.id === Number(statuses[1]));
    return one === undefined ? no() : json([{ state: one.state }]);
  }
  const compare = /\/compare\/([^.]+)\.\.\.(.+)$/.exec(route);
  if (compare) {
    const [, merged = "", live = ""] = compare;
    const status =
      merged === live
        ? "identical"
        : (model.ancestry?.[live] ?? []).includes(merged)
          ? "ahead"
          : "behind";
    const pull = model.mrs.find((one) => one.targetBranch === merged && one.head === live);
    return json({
      status,
      merge_base_commit: pull?.base === undefined ? null : { sha: pull.base.at },
    });
  }
  const checkRuns =
    /^repos\/(.+)\/commits\/([^/]+)\/check-runs\?(?:check_name=(.+)|per_page=1)$/.exec(route);
  if (checkRuns) {
    const [, repo = "", sha = "", name] = checkRuns;
    const ofRepo = model.mrs.filter((one) => one.project === `github.com/${repo}`);
    const head = ofRepo.find((one) => one.head === sha);
    const base = ofRepo.find((one) => one.base?.at === sha);
    const target = ofRepo.find((one) => one.targetBranch === sha && one.target !== undefined);
    const [jobs, at] =
      head !== undefined
        ? [jobsOf(head.jobs ?? [], 0), sha]
        : base !== undefined
          ? [jobsOf(base.base?.jobs ?? [], 1000), sha]
          : target !== undefined
            ? [jobsOf(target.target!.jobs, 2000), target.target!.at]
            : [[], sha];
    return json({
      check_runs: jobs.flatMap((job) =>
        name === undefined || job.name === decodeURIComponent(name)
          ? [
              {
                id: job.id,
                name: job.name,
                head_sha: at,
                ...GITHUB_RUN[job.state],
                html_url: `https://github.com/${repo}/runs/${job.id}`,
              },
            ]
          : [],
      ),
    });
  }
  const rerun = /^repos\/(.+)\/actions\/jobs\/(\d+)\/rerun$/.exec(route);
  if (rerun && args.includes("POST")) {
    const found = headJobAt(
      model,
      (one) => one.project === `github.com/${rerun[1]}`,
      Number(rerun[2]),
    );
    return found === undefined ? no() : { ...ok(), retried: found };
  }
  const runs = /\/actions\/runs\/(\d+)$/.exec(route);
  if (runs) {
    const said = model.runs?.[runs[1]!];
    return said === undefined
      ? no()
      : json({ status: said.status, conclusion: said.conclusion ?? null });
  }
  return no();
}

function gh(model: ForgeModel, args: ReadonlyArray<string>): Answer {
  if (!model.installed) return no(127);
  const [verb, sub] = args;
  if (verb === "--version") return ok("gh version 2.0.0");
  if (verb === "auth" && sub === "status")
    return model.loggedIn.includes(flag(args, "--hostname") ?? FORGE_HOST.github) ? ok() : no();
  if (!model.loggedIn.includes(FORGE_HOST.github)) return no(4);
  if (verb === "issue") return issueAnswer("github", model, args);
  if (verb === "api" && sub === "user")
    return model.login === null ? no() : json({ login: model.login });
  if (verb === "repo" && sub === "clone")
    return { ...ok(), cloned: `github.com/${args[2] ?? ""} ${args[3] ?? ""}` };
  if (verb === "api") return ghApi(model, sub ?? "", args);
  if (verb === "repo" && sub === "view") {
    const repo = args[2] ?? "";
    return (model.unreadable ?? []).includes(repo) ? no() : json({ nameWithOwner: repo });
  }
  const pullAt = (number: string | undefined) =>
    model.mrs.find(
      (one) => one.iid === number && one.project === `github.com/${flag(args, "--repo")}`,
    );
  if (verb === "pr" && sub === "view" && args.includes("--web"))
    return pullAt(args[2]) ? ok() : no();
  if (verb === "pr" && sub === "review" && args.includes("--approve")) {
    const pull = pullAt(args[2]);
    if (pull === undefined || model.refusesApproval === true) return no();
    return {
      ...ok(),
      noted: { key: keyOf("github", pull), body: flag(args, "--body") ?? "" },
      approved: keyOf("github", pull),
    };
  }
  if (verb === "pr" && sub === "view") {
    const pull = pullAt(args[2]);
    if (pull === undefined) return no();
    return json({
      title: pull.title ?? "",
      state: pull.state.toUpperCase(),
      isDraft: pull.draft ?? false,
      author: { login: pull.author ?? "" },
      assignees: (pull.assignees ?? []).map((login) => ({ login })),
      headRefName: pull.sourceBranch ?? "",
      isCrossRepository: pull.fork === true,
      baseRefName: pull.targetBranch ?? "",
      reviewDecision: pull.approved === true ? "APPROVED" : "",
      comments: [],
      updatedAt: pull.updatedAt ?? null,
      url: `https://${pull.project}/pull/${pull.iid}`,
      autoMergeRequest: pull.autoMerge === true ? { enabledAt: "2026-10-01T00:00:00Z" } : null,
      headRefOid: pull.head ?? null,
      ...GITHUB_MERGE_STATE[pull.mergeable ?? "yes"],
      mergeCommit: pull.mergedSha === undefined ? null : { oid: pull.mergedSha },
      mergedAt: pull.mergedAt ?? null,
      statusCheckRollup: (pull.checks ?? []).map((check) => ({
        __typename: "CheckRun",
        name: check.name,
        status: check.state === "running" ? "QUEUED" : "COMPLETED",
        conclusion:
          check.state === "running" ? null : check.state === "passed" ? "SUCCESS" : "FAILURE",
      })),
    });
  }
  if (verb === "pr" && sub === "list" && args.includes("@me")) {
    const who = args.includes("--assignee") ? "--assignee" : "--author";
    return json(
      mine(model, who)
        .filter((one) => one.project === `github.com/${flag(args, "--repo")}`)
        .map((one) => ({ number: Number(one.iid), title: one.title ?? "" })),
    );
  }
  if (verb === "pr" && sub === "list") {
    const repo = `github.com/${flag(args, "--repo")}`;
    return json(
      model.mrs
        .filter(
          (one) =>
            one.project === repo &&
            (flag(args, "--state") === "all" || one.state === "open") &&
            one.sourceBranch === flag(args, "--head"),
        )
        .map((one) => ({
          number: Number(one.iid),
          url: `https://${one.project}/pull/${one.iid}`,
          autoMergeRequest: one.autoMerge === true ? { enabledAt: "2026-10-01T00:00:00Z" } : null,
          state: one.state.toUpperCase(),
          createdAt: one.createdAt ?? "",
          mergedAt: one.mergedAt ?? null,
          // GitHub stamps a merged pull request closed too.
          closedAt: one.closedAt ?? one.mergedAt ?? null,
        })),
    );
  }
  if (verb === "pr" && sub === "comment") {
    const pull = pullAt(args[2]);
    if (pull === undefined) return no();
    return { ...ok(), noted: { key: keyOf("github", pull), body: flag(args, "--body") ?? "" } };
  }
  return no();
}

interface Answered {
  readonly ran: Ran;
  readonly model: ForgeModel;
}

/**
 * What the fake forge answers to one command, and the model after it; git answers the
 * checkout's remotes.
 */
export function answer(
  forge: MrForge,
  model: ForgeModel,
  cmd: string,
  args: ReadonlyArray<string>,
): Answered {
  if (cmd === "git") {
    const said =
      args[0] === "remote" && args[1] === "get-url"
        ? args[2] === "origin"
          ? model.origin
          : args[2] === "upstream"
            ? model.upstream
            : undefined
        : args.join(" ") === "rev-parse --abbrev-ref HEAD"
          ? model.branch
          : undefined;
    return { ran: said === undefined ? no().ran : ok(`${said}\n`).ran, model };
  }
  // GitLab's clone is git's own, with glab's token as its header.
  const cloning =
    cmd === "env" && args.includes("clone")
      ? /^https:\/\/(.+)\.git$/.exec(args.at(-2) ?? "")
      : null;
  if (cloning)
    return {
      ran: ok().ran,
      model: { ...model, cloned: [...(model.cloned ?? []), `${cloning[1]} ${args.at(-1)}`] },
    };
  if (cmd !== CLI[forge]) return { ran: no(127).ran, model };
  const said = forge === "gitlab" ? glab(model, args) : gh(model, args);
  let after = model;
  if (said.filedIssue !== undefined)
    after = { ...after, issues: [...(after.issues ?? []), said.filedIssue] };
  if (said.issueNoted !== undefined) {
    const { key, body } = said.issueNoted;
    const notes = after.issueNotes ?? {};
    after = { ...after, issueNotes: { ...notes, [key]: [...(notes[key] ?? []), body] } };
  }
  if (said.noted !== undefined) {
    const { key, body } = said.noted;
    const notes = after.notes ?? {};
    after = { ...after, notes: { ...notes, [key]: [...(notes[key] ?? []), body] } };
  }
  if (said.cloned !== undefined)
    after = { ...after, cloned: [...(after.cloned ?? []), said.cloned] };
  if (said.approved !== undefined)
    after = { ...after, approved: [...(after.approved ?? []), said.approved] };
  if (said.retried !== undefined) {
    const { mr, at } = said.retried;
    after = {
      ...after,
      mrs: after.mrs.map((one) =>
        one !== mr
          ? one
          : {
              ...one,
              jobs: (one.jobs ?? []).map((job, n) =>
                n === at
                  ? { ...job, state: job.retried ?? job.state, id: (job.id ?? n + 1) + 100 }
                  : job,
              ),
            },
      ),
    };
  }
  return { ran: said.ran, model: after };
}

/** The Runner face: answers from the model, and logs `cmd args…` to `calls`. */
export function fakeForge(forge: MrForge, start: ForgeModel) {
  const calls: string[] = [];
  let model = start;
  const run: Runner = (cmd, args) =>
    Effect.sync(() => {
      calls.push([cmd, ...args].join(" "));
      const said = answer(forge, model, cmd, args);
      model = said.model;
      return said.ran;
    });
  return { run, calls, model: () => model };
}

/** The FakeBin face: the compiled fake or `bun forge-bin.ts`, with the same arguments. */
export const forgeBin = Effect.fn("forge.bin")(function* (
  forge: MrForge,
  file: string,
  args: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const model = Schema.decodeSync(ModelJson)(yield* fs.readFileString(file));
  yield* fs.writeFileString(`${file}.log`, `${[CLI[forge], ...args].join(" ")}\n`, { flag: "a" });
  const said = answer(forge, model, CLI[forge], args);
  yield* fs.writeFileString(file, Schema.encodeSync(ModelJson)(said.model));
  return said.ran;
});

/**
 * The forge's CLI on PATH, answering from `model` as kept beside it. The model is read back
 * with `model()`, so a note posted through the host can be seen.
 */
export const forgeOnPath = Effect.fn("forge.onPath")(function* (
  bin: FakeBin,
  forge: MrForge,
  model: ForgeModel,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(bin.dir, `${forge}.model.json`);
  yield* fs.writeFileString(file, Schema.encodeSync(ModelJson)(model));
  const script = yield* path.fromFileUrl(new URL("./forge-bin.ts", import.meta.url));
  const binary = yield* Config.String("COLLIE_TEST_FAKE_FORGE").pipe(Config.withDefault(""));
  const command = binary === "" ? [process.execPath, script] : [binary];
  yield* bin.add(CLI[forge], `exec ${[...command, forge, file].map(shellQuote).join(" ")} "$@"`);
  return {
    /** The model file holding `next`, as an agent's scripted write would leave it. */
    holding: (next: ForgeModel) => ({ path: file, text: Schema.encodeSync(ModelJson)(next) }),
    set: (next: ForgeModel) => fs.writeFileString(file, Schema.encodeSync(ModelJson)(next)),
    model: () => Effect.map(fs.readFileString(file), Schema.decodeSync(ModelJson)),
    calls: () =>
      Effect.map(
        fs.readFileString(`${file}.log`).pipe(Effect.catch(() => Effect.succeed(""))),
        (text) => text.split("\n").filter(Boolean),
      ),
  };
});
