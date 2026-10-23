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

/** A comment on a merge request; on GitHub one with a thread is a review comment. */
export const FakeComment = Schema.Struct({
  id: Schema.Number,
  author: Schema.String,
  /** A person where unsaid; `system` is a GitLab system note. */
  kind: Schema.optionalKey(Schema.Literals(["person", "bot", "system"])),
  at: Schema.String,
  body: Schema.String,
  /** GitLab's discussion id, or the id of a GitHub review thread's first comment. */
  thread: Schema.optionalKey(Schema.String),
  file: Schema.optionalKey(Schema.String),
  line: Schema.optionalKey(Schema.Number),
});
export type FakeComment = typeof FakeComment.Type;

/** A GitHub review, with the body it was submitted with. */
export const FakeReview = Schema.Struct({
  id: Schema.Number,
  author: Schema.String,
  bot: Schema.optionalKey(Schema.Boolean),
  state: Schema.Literals(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]),
  body: Schema.optionalKey(Schema.String),
  at: Schema.String,
});
export type FakeReview = typeof FakeReview.Type;

/** A GitLab approval rule, with who approved for it. */
const FakeRule = Schema.Struct({
  name: Schema.String,
  required: Schema.Number,
  approvers: Schema.Array(Schema.String),
});

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
  checksUrl: Schema.optionalKey(Schema.String),
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
  mergedBy: Schema.optionalKey(Schema.String),
  comments: Schema.optionalKey(Schema.Array(FakeComment)),
  /** Threads resolved, by their id. */
  resolved: Schema.optionalKey(Schema.Array(Schema.String)),
  /** GitHub's reviews. */
  reviews: Schema.optionalKey(Schema.Array(FakeReview)),
  /** GitLab: who approved it, and how many approvals it requires. */
  approvers: Schema.optionalKey(Schema.Array(Schema.String)),
  required: Schema.optionalKey(Schema.Number),
  /** GitLab's approval rules; one rule of `required` and `approvers` where unsaid. */
  rules: Schema.optionalKey(Schema.Array(FakeRule)),
  /** GitLab's merge status says changes were requested. */
  changesRequested: Schema.optionalKey(Schema.Boolean),
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
  /** The token the CLI hands out for its host, where a test changes it. */
  token: Schema.optionalKey(Schema.String),
  mrs: Schema.Array(FakeMr),
  checksAt: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(FakeJob))),
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
        job: Schema.optionalKey(Schema.String),
        /** Every deployment there, newest first; `deployed` and `failed` are not read where set. */
        deployments: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              sha: Schema.String,
              status: Schema.Literals(["success", "failed", "running"]),
              job: Schema.optionalKey(Schema.String),
              jobId: Schema.optionalKey(Schema.Number),
              logUrl: Schema.optionalKey(Schema.String),
              pipeline: Schema.optionalKey(
                Schema.Struct({ ref: Schema.String, sha: Schema.String }),
              ),
            }),
          ),
        ),
      }),
    ),
  ),
  /** Pipelines and Actions runs, by id, with their jobs where a test names them. */
  runs: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        status: Schema.String,
        conclusion: Schema.optionalKey(Schema.String),
        /** The branch or tag it ran for, and its commit. */
        ref: Schema.optionalKey(Schema.String),
        sha: Schema.optionalKey(Schema.String),
        /** The GitHub event that started it, `push` where not said. */
        event: Schema.optionalKey(Schema.String),
        jobs: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              name: Schema.String,
              state: Schema.Literals([...JobStates.literals, "manual"]),
            }),
          ),
        ),
      }),
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
  /** `main` where unsaid. */
  defaultBranch: Schema.optionalKey(Schema.String),
  /** GitLab's protected branches, or GitHub's classic protection rules, by pattern. */
  protectedBranches: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ name: Schema.String, allowForcePush: Schema.optionalKey(Schema.Boolean) }),
    ),
  ),
  /** GitHub's rulesets, by the branch pattern each includes. */
  rulesets: Schema.optionalKey(Schema.Array(Schema.String)),
  /** Neither the repository nor its protection can be read. */
  protectionDown: Schema.optionalKey(Schema.Boolean),
  /** GitLab without merge requests' approval state, as on Free. */
  free: Schema.optionalKey(Schema.Boolean),
  /** GitHub's required approving reviews: branch protection's, each ruleset's, and code owners'. */
  reviewsRequired: Schema.optionalKey(
    Schema.Struct({
      classic: Schema.optionalKey(Schema.Number),
      rulesets: Schema.optionalKey(Schema.Array(Schema.Number)),
      codeOwners: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  /** GitHub's `viewerDefaultMergeMethod`; `MERGE` where unsaid. */
  mergeMethod: Schema.optionalKey(Schema.Literals(["MERGE", "SQUASH", "REBASE"])),
  /** Replies posted, by `project!iid` or `project#iid`: the thread, null for none, and the body. */
  replies: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Array(Schema.Struct({ thread: Schema.NullOr(Schema.String), body: Schema.String })),
    ),
  ),
  /** Merges made: the merge request's key, the head, the method, every field, who and when. */
  merges: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        key: Schema.String,
        sha: Schema.String,
        method: Schema.NullOr(Schema.String),
        fields: Schema.Array(Schema.String),
        by: Schema.String,
        at: Schema.String,
      }),
    ),
  ),
  /** What the forge stamps a reply or a merge with. */
  now: Schema.optionalKey(Schema.String),
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
  readonly replied?: { readonly mr: FakeMr; readonly thread: string | null; readonly body: string };
  readonly merged?: {
    readonly mr: FakeMr;
    readonly sha: string;
    readonly method: string | undefined;
    readonly fields: ReadonlyArray<string>;
  };
}

const Json = Schema.fromJsonString(Schema.Json);
const ok = (stdout = ""): Answer => ({ ran: { code: 0, stdout } });
const json = (value: Schema.Json): Answer => ok(Schema.encodeSync(Json)(value));
const no = (code = 1): Answer => ({ ran: { code, stdout: "" } });

const flag = (args: ReadonlyArray<string>, name: string) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

/** Every `-f name=value` an API call carries, or each `-F` one. */
const fieldsOf = (args: ReadonlyArray<string>, kind = "-f") =>
  args.flatMap((arg, at) => (args[at - 1] === kind ? [arg] : []));
const field = (args: ReadonlyArray<string>, name: string, kind = "-f") =>
  fieldsOf(args, kind)
    .find((one) => one.startsWith(`${name}=`))
    ?.slice(name.length + 1);

/** A refusal, with what the CLI says of it. */
const refused = (said: string): Answer => ({ ran: { code: 1, stdout: "", stderr: said } });

const NOW = "2026-10-20T12:00:00Z";

/** The commit a merge of `mr` makes, where the test did not name one. */
export const mergeCommitOf = (mr: FakeMr) => mr.mergedSha ?? `merge-of-${mr.head ?? ""}`;

const NOT_MERGEABLE = {
  gitlab: "405 Method Not Allowed",
  github: "Pull Request is not mergeable (HTTP 405)",
} as const;
const HEAD_MOVED = {
  gitlab: "409 SHA does not match HEAD of source branch",
  github: "Head branch was modified. Review and try the merge again. (HTTP 409)",
} as const;

/** The forge's merge of `mr` at the head `sha` asks for, refused as each forge refuses it. */
function mergeAnswer(forge: MrForge, mr: FakeMr, args: ReadonlyArray<string>): Answer {
  const sha = field(args, "sha") ?? "";
  if (mr.state !== "open") return refused(NOT_MERGEABLE[forge]);
  if (sha !== (mr.head ?? "")) return refused(HEAD_MOVED[forge]);
  if ((mr.mergeable ?? "yes") !== "yes") return refused(NOT_MERGEABLE[forge]);
  return {
    ...json(
      forge === "gitlab"
        ? { state: "merged", merge_commit_sha: mergeCommitOf(mr) }
        : { merged: true, sha: mergeCommitOf(mr) },
    ),
    merged: { mr, sha, method: field(args, "merge_method"), fields: fieldsOf(args) },
  };
}

/** GitLab's discussions of `mr`: one per thread, and one of its own for each other note. */
function discussionsOf(mr: FakeMr) {
  const threads = new Map<string, FakeComment[]>();
  for (const comment of mr.comments ?? []) {
    const id = comment.thread ?? `note-${comment.id}`;
    threads.set(id, [...(threads.get(id) ?? []), comment]);
  }
  return [...threads].map(([id, notes]) => ({
    id,
    individual_note: notes[0]?.thread === undefined,
    notes: notes.map((note) => ({
      id: note.id,
      body: note.body,
      author: { username: note.author, bot: note.kind === "bot" },
      created_at: note.at,
      system: note.kind === "system",
      resolvable: note.thread !== undefined && note.kind !== "system",
      resolved: note.thread !== undefined && (mr.resolved ?? []).includes(note.thread),
      position:
        note.file === undefined
          ? null
          : {
              new_path: note.file,
              new_line: note.line ?? null,
              old_path: note.file,
              old_line: null,
            },
    })),
  }));
}

/** GitLab's approval rules of `mr`: its own, or one rule of what it requires. */
const rulesOf = (mr: FakeMr) =>
  mr.rules ??
  (mr.required === undefined && mr.approvers === undefined
    ? []
    : [{ name: "All Members", required: mr.required ?? 0, approvers: mr.approvers ?? [] }]);

/** Each reviewer's standing review: their latest that is not only a comment. */
const standingOf = (reviews: ReadonlyArray<FakeReview>) => {
  const standing = new Map<string, FakeReview>();
  for (const review of reviews)
    if (review.state !== "COMMENTED") standing.set(review.author, review);
  return [...standing.values()];
};

/** GitHub's review decision: none where the base branch requires no review. */
function decisionOf(model: ForgeModel, pull: FakeMr): string | null {
  if (pull.approved === true) return "APPROVED";
  const rules = model.reviewsRequired;
  const required = Math.max(rules?.classic ?? 0, ...(rules?.rulesets ?? []));
  if (required === 0 && rules?.codeOwners !== true) return null;
  const standing = standingOf(pull.reviews ?? []);
  if (standing.some((one) => one.state === "CHANGES_REQUESTED")) return "CHANGES_REQUESTED";
  return standing.filter((one) => one.state === "APPROVED").length >= required
    ? "APPROVED"
    : "REVIEW_REQUIRED";
}

const userOf = (login: string, bot: boolean | undefined) => ({
  login,
  type: bot === true ? "Bot" : "User",
});

/** `gh api --paginate --slurp`'s pages of `items`. */
const pagesOf = (items: ReadonlyArray<Schema.Json>, args: ReadonlyArray<string>): Answer =>
  json(args.includes("--slurp") ? [[...items]] : [...items]);

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
  manual: "manual",
  passed: "success",
  pending: "pending",
  running: "running",
  failed: "failed",
  skipped: "skipped",
  cancelled: "canceled",
} as const;

const GITHUB_RUN = {
  manual: { status: "waiting", conclusion: null },
  passed: { status: "completed", conclusion: "success" },
  pending: { status: "queued", conclusion: null },
  running: { status: "in_progress", conclusion: null },
  failed: { status: "completed", conclusion: "failure" },
  skipped: { status: "completed", conclusion: "skipped" },
  cancelled: { status: "completed", conclusion: "cancelled" },
} as const;

/** The pipelines or Actions runs for `ref`, newest first. */
const runsFor = (model: ForgeModel, ref: string) =>
  Object.entries(model.runs ?? {})
    .filter(([, one]) => one.ref === ref)
    .toSorted(([a], [b]) => Number(b) - Number(a));

/** The page a GitLab list route asks for, 20 to a page where it does not say. */
function pageOf<T>(route: string, all: ReadonlyArray<T>): Array<T> {
  const page = Number(/[?&]page=(\d+)/.exec(route)?.[1] ?? "1");
  const size = Number(/[?&]per_page=(\d+)/.exec(route)?.[1] ?? "20");
  return all.slice((page - 1) * size, page * size);
}

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

/** A GitLab merge request as `glab mr view` and its API answer it. */
function glabMrJson(mr: FakeMr) {
  const pipeline = pipelineOf(mr.checks);
  return {
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
            web_url: mr.checksUrl ?? null,
          },
    source_branch: mr.sourceBranch ?? null,
    source_project_id: mr.fork === true ? 7 : 3,
    target_project_id: 3,
    target_branch: mr.targetBranch ?? null,
    diff_refs: { base_sha: mr.base?.at ?? null },
    merge_when_pipeline_succeeds: mr.autoMerge ?? false,
    approvals_left: mr.approved === true ? 0 : null,
    detailed_merge_status:
      mr.changesRequested === true && mr.mergeable === undefined
        ? "requested_changes"
        : GITLAB_MERGE_STATUS[mr.mergeable ?? "yes"],
    merge_user: mr.mergedBy === undefined ? null : { username: mr.mergedBy },
    updated_at: mr.updatedAt ?? null,
    web_url: `https://${mr.project}/-/merge_requests/${mr.iid}`,
  };
}

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
    return mr === undefined ? no() : json(glabMrJson(mr));
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
    return model.loggedIn.includes(host) ? ok(`${model.token ?? "glpat-fake"}\n`) : ok("");
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
    const route = args.at(-1) ?? "";
    if (/^projects\/[^/]+$/.test(route))
      return model.protectionDown === true
        ? no()
        : json({ default_branch: model.defaultBranch ?? "main" });
    if (/^projects\/[^/]+\/protected_branches/.test(route))
      return model.protectionDown === true
        ? no()
        : json(
            (model.protectedBranches ?? []).map((one) => ({
              name: one.name,
              allow_force_push: one.allowForcePush ?? false,
            })),
          );
    if (model.deploysDown === true) return no();
    const environments = model.environments ?? [];
    if (/\/environments(\?|$)/.test(route))
      return json(
        pageOf(
          route,
          environments.map(({ name, tier }) => ({ name, tier })),
        ),
      );
    if (route.includes("/deployments?"))
      return json(
        pageOf(
          route,
          deploymentsAsked(model, route).map(({ sha, status, environment, job, pipeline }) => ({
            sha,
            status,
            environment: { name: environment },
            deployable: job === undefined ? null : { name: job, pipeline: pipeline ?? null },
          })),
        ),
      );
    const onMr = /^projects\/([^/]+)\/merge_requests\/(\d+)(?:\/(.+))?$/.exec(route);
    if (onMr) {
      const [, path = "", iid = "", rest] = onMr;
      const mr = model.mrs.find(
        (one) => one.iid === iid && one.project.endsWith(`/${decodeURIComponent(path)}`),
      );
      return mr === undefined ? no() : glabOnMr(model, mr, rest ?? "", args);
    }
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
    const tagged = byRef === null ? [] : runsFor(model, decodeURIComponent(byRef[1]!));
    if (tagged.length > 0)
      return json(tagged.map(([id, one]) => ({ id: Number(id), sha: one.sha ?? "" })));
    if (byRef) {
      const mr = model.mrs.find(
        (one) => one.targetBranch === decodeURIComponent(byRef[1]!) && one.target !== undefined,
      );
      return json(mr === undefined ? [] : [{ id: pipelineIdOf(mr) + 2, sha: mr.target!.at }]);
    }
    const jobs = /^projects\/([^/]+)\/pipelines\/(\d+)\/jobs/.exec(route);
    const named = jobs === null ? undefined : model.runs?.[jobs[2]!]?.jobs;
    if (named !== undefined)
      return json(
        named.map((job, at) => ({
          id: at + 1,
          name: job.name,
          status: GITLAB_JOB[job.state],
          web_url: `https://${flag(args, "--hostname")}/${decodeURIComponent(jobs![1]!)}/-/jobs/${at + 1}`,
        })),
      );
    if (jobs) {
      const id = Number(jobs[2]);
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
      const parents =
        model.ancestry?.[commit[1]!] ??
        (deploymentsOf(model).some((deployment) => deployment.sha === commit[1]) ? [] : undefined);
      return parents === undefined ? no() : json({ id: commit[1]!, parent_ids: [...parents] });
    }
    const pipeline = /\/pipelines\/(\d+)$/.exec(route);
    if (pipeline) {
      const said = model.runs?.[pipeline[1]!];
      return said === undefined
        ? no()
        : json({ status: said.status, ref: said.ref ?? "main", sha: said.sha ?? "" });
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

/** `glab api` on one merge request: its approvals, its discussions, a reply and the merge. */
function glabOnMr(
  model: ForgeModel,
  mr: FakeMr,
  rest: string,
  args: ReadonlyArray<string>,
): Answer {
  const method = flag(args, "-X") ?? "GET";
  if (rest === "" && method === "GET") return json(glabMrJson(mr));
  if (rest === "approval_state")
    return model.free === true
      ? refused("403 Forbidden")
      : json({
          rules: rulesOf(mr).map((rule) => ({
            name: rule.name,
            approvals_required: rule.required,
            approved_by: rule.approvers.map((username) => ({ username })),
          })),
        });
  if (rest === "approvals") {
    const rules = rulesOf(mr);
    const approvers = mr.approvers ?? [...new Set(rules.flatMap((rule) => rule.approvers))];
    const required = mr.required ?? Math.max(0, ...rules.map((rule) => rule.required));
    return json({
      approvals_required: required,
      approvals_left: Math.max(0, required - approvers.length),
      approved_by: approvers.map((username) => ({ user: { username } })),
    });
  }
  if (rest.startsWith("discussions?") && method === "GET") {
    const page = Number(/[?&]page=(\d+)/.exec(rest)?.[1] ?? "1");
    const size = Number(/[?&]per_page=(\d+)/.exec(rest)?.[1] ?? "20");
    return json(discussionsOf(mr).slice((page - 1) * size, page * size));
  }
  const thread = /^discussions\/([^/]+)\/notes$/.exec(rest)?.[1];
  if ((thread !== undefined || rest === "notes") && method === "POST") {
    if (thread !== undefined && !discussionsOf(mr).some((one) => one.id === thread))
      return refused("404 Discussion Not Found");
    return {
      ...json({ id: 1 }),
      replied: { mr, thread: thread ?? null, body: field(args, "body") ?? "" },
    };
  }
  if (rest === "merge" && method === "PUT") return mergeAnswer("gitlab", mr, args);
  return no();
}

/** `gh api` on one pull request: its comments and reviews, a reply and the merge. */
function ghOnPull(pull: FakeMr, kind: string, rest: string, args: ReadonlyArray<string>): Answer {
  const url = `https://${pull.project}/pull/${pull.iid}`;
  const method = flag(args, "-X") ?? "GET";
  const comments = pull.comments ?? [];
  const body = field(args, "body") ?? "";
  if (kind === "issues" && rest === "comments" && method === "POST")
    return { ...json({ id: 1 }), replied: { mr: pull, thread: null, body } };
  if (kind === "issues" && rest.startsWith("comments?"))
    return pagesOf(
      comments
        .filter((one) => one.thread === undefined)
        .map((one) => ({
          id: one.id,
          html_url: `${url}#issuecomment-${one.id}`,
          user: userOf(one.author, one.kind === "bot"),
          created_at: one.at,
          body: one.body,
        })),
      args,
    );
  const replyTo = /^comments\/(\d+)\/replies$/.exec(rest)?.[1];
  if (kind === "pulls" && replyTo !== undefined && method === "POST")
    return comments.some((one) => String(one.id) === replyTo && one.thread === replyTo)
      ? { ...json({ id: 1 }), replied: { mr: pull, thread: replyTo, body } }
      : refused("Not Found (HTTP 404)");
  if (kind === "pulls" && rest.startsWith("comments?"))
    return pagesOf(
      comments.flatMap((one) =>
        one.thread === undefined
          ? []
          : [
              {
                id: one.id,
                html_url: `${url}#discussion_r${one.id}`,
                user: userOf(one.author, one.kind === "bot"),
                created_at: one.at,
                body: one.body,
                path: one.file ?? null,
                line: one.line ?? null,
                in_reply_to_id: one.thread === String(one.id) ? null : Number(one.thread),
              },
            ],
      ),
      args,
    );
  if (kind === "pulls" && rest.startsWith("reviews?"))
    return pagesOf(
      (pull.reviews ?? []).map((one) => ({
        id: one.id,
        html_url: `${url}#pullrequestreview-${one.id}`,
        user: userOf(one.author, one.bot),
        state: one.state,
        body: one.body ?? "",
        submitted_at: one.at,
      })),
      args,
    );
  if (kind === "pulls" && rest === "merge" && method === "PUT")
    return mergeAnswer("github", pull, args);
  return no();
}

/** `gh api graphql`: a pull request's review threads, or a branch's protection for the viewer. */
function ghGraphql(model: ForgeModel, args: ReadonlyArray<string>): Answer | undefined {
  const query = field(args, "query") ?? "";
  const typed = (name: string) => field(args, name, "-F");
  if (query.includes("reviewThreads")) {
    const pull = model.mrs.find(
      (one) =>
        one.project === `github.com/${typed("owner")}/${typed("name")}` &&
        one.iid === typed("number"),
    );
    if (pull === undefined) return no();
    const threads = new Set((pull.comments ?? []).flatMap((one) => one.thread ?? []));
    const page = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [...threads].map((thread) => ({
                isResolved: (pull.resolved ?? []).includes(thread),
                comments: { nodes: [{ databaseId: Number(thread) }] },
              })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    };
    return json(args.includes("--slurp") ? [page] : page);
  }
  if (query.includes("refUpdateRule")) {
    if (model.protectionDown === true) return no();
    const required = model.reviewsRequired;
    return json({
      data: {
        repository: {
          ref: {
            refUpdateRule:
              required?.classic === undefined
                ? null
                : {
                    requiredApprovingReviewCount: required.classic,
                    requiresCodeOwnerReviews: required.codeOwners === true,
                  },
          },
        },
      },
    });
  }
  return undefined;
}

/** Each environment's deployments, newest first: by default a failed newer one, then what is live. */
const deploymentsOf = (model: ForgeModel) =>
  (model.environments ?? []).flatMap((env, at) =>
    (
      env.deployments ?? [
        ...(env.failed === undefined || env.failed === ""
          ? []
          : [{ sha: env.failed, status: "failed" as const }]),
        ...(env.deployed === undefined ? [] : [{ sha: env.deployed, status: "success" as const }]),
      ]
    ).map((one, n) => ({
      id: at * 1000 + n + 1,
      sha: one.sha,
      environment: env.name,
      state:
        one.status === "failed" ? "failure" : one.status === "running" ? "in_progress" : one.status,
      status: one.status,
      job: "job" in one ? one.job : env.job,
      jobId: "jobId" in one ? one.jobId : undefined,
      logUrl: "logUrl" in one ? one.logUrl : undefined,
      pipeline: "pipeline" in one ? one.pipeline : undefined,
    })),
  );

/** The deployments a deployment list route asks for, by its `environment`, `sha` and `status`. */
const deploymentsAsked = (model: ForgeModel, route: string) => {
  const query = new URLSearchParams(route.split("?")[1] ?? "");
  const environment = query.get("environment");
  const sha = query.get("sha");
  const status = query.get("status");
  return deploymentsOf(model).filter(
    (one) =>
      (environment === null || one.environment === environment) &&
      (sha === null || one.sha === sha) &&
      (status === null || one.status === status),
  );
};

/** `gh api repos/<o>/<r>/…`, for deployments, compare and Actions runs. */
function ghApi(model: ForgeModel, route: string, args: ReadonlyArray<string>): Answer {
  if (/^repos\/[^/]+\/[^/]+$/.test(route))
    return model.protectionDown === true
      ? no()
      : json({ default_branch: model.defaultBranch ?? "main" });
  const ruled = /\/rules\/branches\/(.+)$/.exec(route);
  if (ruled) {
    if (model.protectionDown === true) return no();
    const required = model.reviewsRequired;
    return pagesOf(
      [
        ...(model.rulesets ?? [])
          .filter((pattern) => new Bun.Glob(pattern).match(decodeURIComponent(ruled[1]!)))
          .map((_, at) => ({ type: "pull_request", ruleset_id: at + 1 })),
        ...(required?.rulesets ?? []).map((count, at) => ({
          type: "pull_request",
          ruleset_id: 100 + at,
          parameters: {
            required_approving_review_count: count,
            require_code_owner_review: required?.codeOwners === true,
          },
        })),
      ],
      args,
    );
  }
  const asked = route === "graphql" ? ghGraphql(model, args) : undefined;
  if (asked !== undefined) return asked;
  const onPull = /^repos\/([^/]+\/[^/]+)\/(pulls|issues)\/(\d+)\/(.+)$/.exec(route);
  if (onPull) {
    const [, repo = "", kind = "", number = "", rest = ""] = onPull;
    const pull = model.mrs.find(
      (one) => one.project === `github.com/${repo}` && one.iid === number,
    );
    return pull === undefined ? no() : ghOnPull(pull, kind, rest, args);
  }
  if (route === "graphql")
    return model.protectionDown === true
      ? no()
      : json({
          data: {
            repository: {
              branchProtectionRules: {
                nodes: (model.protectedBranches ?? []).map((one) => ({ pattern: one.name })),
              },
            },
          },
        });
  if (model.deploysDown === true) return no();
  const tierOf = (name: string) =>
    (model.environments ?? []).find((env) => env.name === name)?.tier;
  if (/\/environments\?/.test(route)) {
    const environments = (model.environments ?? []).map((env) => ({ name: env.name }));
    const page = { total_count: environments.length, environments };
    return json(args.includes("--slurp") ? [page] : page);
  }
  if (/\/deployments\?/.test(route)) {
    const deployments = deploymentsAsked(model, route).map(({ id, sha, environment }) => ({
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
    if (one === undefined) return no();
    const mr = model.mrs[0];
    const jobId =
      one.jobId ??
      (mr?.jobs ?? []).find((job) => job.name === one.job)?.id ??
      (mr?.jobs ?? []).findIndex((job) => job.name === one.job) + 1;
    return json([
      {
        state: one.state,
        log_url:
          one.logUrl ?? (jobId > 0 ? `https://${mr?.project}/actions/runs/7/job/${jobId}` : ""),
      },
    ]);
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
    /^repos\/(.+)\/commits\/([^/]+)\/check-runs\?(?:check_name=([^&]+)(?:&.*)?|per_page=1)$/.exec(
      route,
    );
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
            : [jobsOf(model.checksAt?.[sha] ?? [], 0), sha];
    const page = {
      check_runs: jobs
        .filter(
          (job, at) =>
            route.includes("filter=all") || jobs.findIndex((one) => one.name === job.name) === at,
        )
        .flatMap((job) =>
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
    };
    return args.includes("--slurp") ? json([page]) : json(page);
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
  const runJobs = /^repos\/(.+)\/actions\/runs\/(\d+)\/jobs/.exec(route);
  if (runJobs) {
    const said = model.runs?.[runJobs[2]!];
    if (said === undefined) return no();
    const jobs = (said.jobs ?? []).map((job, at) => ({
      id: at + 1,
      name: job.name,
      ...GITHUB_RUN[job.state],
      html_url: `https://github.com/${runJobs[1]}/actions/runs/${runJobs[2]}/job/${at + 1}`,
    }));
    if (!args.includes("--paginate")) return json({ jobs: jobs.slice(0, 100) });
    const pages = [];
    for (let at = 0; at === 0 || at < jobs.length; at += 100)
      pages.push({ jobs: jobs.slice(at, at + 100) });
    return json(args.includes("--slurp") ? pages : pages[0]!);
  }
  const runs = /\/actions\/runs\/(\d+)$/.exec(route);
  if (runs) {
    const said = model.runs?.[runs[1]!];
    return said === undefined
      ? no()
      : json({
          status: said.status,
          conclusion: said.conclusion ?? null,
          head_branch: said.ref ?? "main",
          head_sha: said.sha ?? "",
        });
  }
  const byBranch = /^repos\/(.+)\/actions\/runs\?.*\bbranch=([^&]+)/.exec(route);
  if (byBranch)
    return json({
      workflow_runs: runsFor(model, decodeURIComponent(byBranch[2]!))
        .filter(([, one]) => {
          const event = /[?&]event=([^&]+)/.exec(route)?.[1];
          return event === undefined || (one.event ?? "push") === event;
        })
        .map(([id]) => ({
          id: Number(id),
          html_url: `https://github.com/${byBranch[1]}/actions/runs/${id}`,
        })),
    });
  return no();
}

function gh(model: ForgeModel, args: ReadonlyArray<string>): Answer {
  if (!model.installed) return no(127);
  const [verb, sub] = args;
  if (verb === "--version") return ok("gh version 2.0.0");
  if (verb === "auth" && sub === "status")
    return model.loggedIn.includes(flag(args, "--hostname") ?? FORGE_HOST.github) ? ok() : no();
  if (!model.loggedIn.includes(FORGE_HOST.github)) return no(4);
  if (verb === "auth" && sub === "git-credential" && args[2] === "get")
    return ok(
      `protocol=https\nhost=${FORGE_HOST.github}\nusername=x-access-token\npassword=${model.token ?? "gho-fake"}\n`,
    );
  if (verb === "issue") return issueAnswer("github", model, args);
  if (verb === "api" && sub === "user")
    return model.login === null ? no() : json({ login: model.login });
  if (verb === "repo" && sub === "clone")
    return { ...ok(), cloned: `github.com/${args[2] ?? ""} ${args[3] ?? ""}` };
  if (verb === "api") return ghApi(model, sub ?? "", args);
  if (verb === "repo" && sub === "view") {
    const repo = args[2] ?? "";
    return (model.unreadable ?? []).includes(repo)
      ? no()
      : json({ nameWithOwner: repo, viewerDefaultMergeMethod: model.mergeMethod ?? "MERGE" });
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
      reviewDecision: decisionOf(model, pull),
      mergedBy: pull.mergedBy === undefined ? null : { login: pull.mergedBy },
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
        detailsUrl: pull.checksUrl ?? null,
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
          : args.join(" ") === "symbolic-ref --quiet --short HEAD" && model.branch !== "HEAD"
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
  if (said.replied !== undefined) {
    const { mr, thread, body } = said.replied;
    const key = keyOf(forge, mr);
    const replies = after.replies ?? {};
    const unthreaded: FakeComment = {
      id: Math.max(0, ...after.mrs.flatMap((one) => (one.comments ?? []).map((c) => c.id))) + 1,
      author: after.login ?? "",
      at: after.now ?? NOW,
      body,
    };
    const comment = thread === null ? unthreaded : { ...unthreaded, thread };
    after = {
      ...after,
      replies: { ...replies, [key]: [...(replies[key] ?? []), { thread, body }] },
      mrs: after.mrs.map((one) =>
        one === mr ? { ...one, comments: [...(one.comments ?? []), comment] } : one,
      ),
    };
  }
  if (said.merged !== undefined) {
    const { mr, sha, method, fields } = said.merged;
    const at = after.now ?? NOW;
    const by = after.login ?? "";
    after = {
      ...after,
      merges: [
        ...(after.merges ?? []),
        { key: keyOf(forge, mr), sha, method: method ?? null, fields, by, at },
      ],
      mrs: after.mrs.map((one) =>
        one === mr
          ? { ...one, state: "merged", mergedSha: mergeCommitOf(one), mergedBy: by, mergedAt: at }
          : one,
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
  // Writing back an unchanged model would undo a test's write that landed since the read.
  if (said.model !== model)
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
