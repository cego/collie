import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Rec from "effect/Record";
import * as BunFileSystem from "@effect/platform-bun/BunFileSystem";
import type { PlatformServices } from "../../src/platform";
import type { Records } from "../../src/records";
import {
  Clock,
  Config,
  ConfigProvider,
  DateTime,
  Effect,
  FileSystem,
  Layer,
  Option,
  Order,
  Path,
  Schema,
  flow,
  Result,
} from "effect";
import type { Scope } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type { MrForge, MrState } from "../../src/board-model";
import type { ForgeFacts } from "../../src/board";
import { writeMrStates } from "../../src/merges";
import { forgeHttpTest } from "../../src/forge/http";
import type { ForgeHttp } from "../../src/forge/http";
import { runEffect } from "./effect";
import { glabExpiry, MONTHS } from "../../src/forge/gitlab";
import { shell } from "../../src/mr";
import type { Ran, Runner, RunnerEnv } from "../../src/mr";
import type { FakeBin } from "./bin";
import { recordStart } from "../../src/starts";
import { forwarding } from "./forwarding";

export const Check = Schema.Struct({
  name: Schema.String,
  state: Schema.Literals(["passed", "failed", "running"]),
});
export type Check = typeof Check.Type;

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
  retried: Schema.optionalKey(JobStates),
  id: Schema.optionalKey(Schema.Finite),
  trace: Schema.optionalKey(Schema.String),
  attempts: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.Finite,
        state: JobStates,
        trace: Schema.optionalKey(Schema.String),
        finished: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});
export type FakeJob = typeof FakeJob.Type;

export const FakeComment = Schema.Struct({
  id: Schema.Finite,
  author: Schema.String,
  kind: Schema.optionalKey(Schema.Literals(["person", "bot", "system"])),
  at: Schema.String,
  body: Schema.String,
  thread: Schema.optionalKey(Schema.String),
  file: Schema.optionalKey(Schema.String),
  line: Schema.optionalKey(Schema.Finite),
});
export type FakeComment = typeof FakeComment.Type;

export const FakeReview = Schema.Struct({
  id: Schema.Finite,
  author: Schema.String,
  bot: Schema.optionalKey(Schema.Boolean),
  state: Schema.Literals(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"]),
  body: Schema.optionalKey(Schema.String),
  at: Schema.String,
});
export type FakeReview = typeof FakeReview.Type;

const FakeRule = Schema.Struct({
  name: Schema.String,
  required: Schema.Finite,
  approvers: Schema.Array(Schema.String),
});

export const FakeMr = Schema.Struct({
  project: Schema.String,
  iid: Schema.String,
  state: Schema.Literals(["open", "merged", "closed"]),
  draft: Schema.optionalKey(Schema.Boolean),
  title: Schema.optionalKey(Schema.String),
  body: Schema.optionalKey(Schema.String),
  author: Schema.optionalKey(Schema.String),
  assignees: Schema.optionalKey(Schema.Array(Schema.String)),
  reviewers: Schema.optionalKey(Schema.Array(Schema.String)),
  head: Schema.optionalKey(Schema.String),
  diff: Schema.optionalKey(Schema.String),
  interdiff: Schema.optionalKey(Schema.String),
  pipelineAt: Schema.optionalKey(Schema.String),
  checksUrl: Schema.optionalKey(Schema.String),
  mergedSha: Schema.optionalKey(Schema.String),
  checks: Schema.optionalKey(Schema.Array(Check)),
  jobs: Schema.optionalKey(Schema.Array(FakeJob)),
  base: Schema.optionalKey(
    Schema.Struct({ at: Schema.String, jobs: Schema.optionalKey(Schema.Array(FakeJob)) }),
  ),
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
  mergeable: Schema.optionalKey(
    Schema.Literals(["yes", "conflict", "unapproved", "checking", "running"]),
  ),
  mergedBy: Schema.optionalKey(Schema.String),
  comments: Schema.optionalKey(Schema.Array(FakeComment)),
  resolved: Schema.optionalKey(Schema.Array(Schema.String)),
  reviews: Schema.optionalKey(Schema.Array(FakeReview)),
  approvers: Schema.optionalKey(Schema.Array(Schema.String)),
  required: Schema.optionalKey(Schema.Finite),
  rules: Schema.optionalKey(Schema.Array(FakeRule)),
  changesRequested: Schema.optionalKey(Schema.Boolean),
  queued: Schema.optionalKey(Schema.String),
  dequeuedFor: Schema.optionalKey(Schema.String),
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
  running: "ci_still_running",
} as const;

const GITHUB_MERGE_STATE = {
  yes: { mergeable: "MERGEABLE", mergeStateStatus: "CLEAN" },
  conflict: { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" },
  unapproved: { mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" },
  checking: { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" },
  running: { mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED" },
} as const;

export const ForgeModel = Schema.Struct({
  installed: Schema.Boolean,
  loggedIn: Schema.Array(Schema.String),
  login: Schema.NullOr(Schema.String),
  token: Schema.optionalKey(Schema.String),
  oauth: Schema.optionalKey(Schema.Struct({ token: Schema.String, expiry: Schema.String })),
  envToken: Schema.optionalKey(Schema.String),
  revoked: Schema.optionalKey(Schema.Boolean),
  httpFault: Schema.optionalKey(
    Schema.Union([
      Schema.Struct({
        status: Schema.Finite,
        message: Schema.optionalKey(Schema.String),
        headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
      }),
      Schema.Literals(["network", "hold"]),
    ]),
  ),
  mrs: Schema.Array(FakeMr),
  checksAt: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(FakeJob))),
  issues: Schema.optionalKey(Schema.Array(FakeIssue)),
  issueNotes: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  origin: Schema.optionalKey(Schema.String),
  upstream: Schema.optionalKey(Schema.String),
  branch: Schema.optionalKey(Schema.String),
  environments: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        tier: Schema.String,
        project: Schema.optionalKey(Schema.String),
        deployed: Schema.optionalKey(Schema.String),
        failed: Schema.optionalKey(Schema.String),
        job: Schema.optionalKey(Schema.String),
        deployments: Schema.optionalKey(
          Schema.Array(
            Schema.Struct({
              sha: Schema.String,
              status: Schema.Literals(["success", "failed", "running"]),
              job: Schema.optionalKey(Schema.String),
              jobId: Schema.optionalKey(Schema.Finite),
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
  runs: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        status: Schema.String,
        conclusion: Schema.optionalKey(Schema.String),
        ref: Schema.optionalKey(Schema.String),
        sha: Schema.optionalKey(Schema.String),
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
  pipelinesOn: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Array(
        Schema.Struct({
          id: Schema.Finite,
          status: Schema.String,
          source: Schema.optionalKey(Schema.String),
          ref: Schema.optionalKey(Schema.String),
        }),
      ),
    ),
  ),
  refusesPipeline: Schema.optionalKey(
    Schema.Struct({
      mr: Schema.optionalKey(Schema.Finite),
      branch: Schema.optionalKey(Schema.Finite),
    }),
  ),
  refusesNote: Schema.optionalKey(Schema.Finite),
  refusesIssueWrite: Schema.optionalKey(Schema.Finite),
  ancestry: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  gone: Schema.optionalKey(Schema.Array(Schema.String)),
  unreadable: Schema.optionalKey(Schema.Array(Schema.String)),
  deploysDown: Schema.optionalKey(Schema.Boolean),
  notes: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  cloned: Schema.optionalKey(Schema.Array(Schema.String)),
  approved: Schema.optionalKey(Schema.Array(Schema.String)),
  refusesApproval: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.String])),
  refusesMerge: Schema.optionalKey(Schema.Boolean),
  defaultBranch: Schema.optionalKey(Schema.String),
  protectedBranches: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ name: Schema.String, allowForcePush: Schema.optionalKey(Schema.Boolean) }),
    ),
  ),
  rulesets: Schema.optionalKey(Schema.Array(Schema.String)),
  protectionDown: Schema.optionalKey(Schema.Boolean),
  free: Schema.optionalKey(Schema.Boolean),
  reviewsRequired: Schema.optionalKey(
    Schema.Struct({
      classic: Schema.optionalKey(Schema.Finite),
      rulesets: Schema.optionalKey(Schema.Array(Schema.Finite)),
      codeOwners: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  mergeQueues: Schema.optionalKey(Schema.Array(Schema.String)),
  enqueued: Schema.optionalKey(
    Schema.Array(Schema.Struct({ key: Schema.String, head: Schema.String })),
  ),
  dequeued: Schema.optionalKey(Schema.Array(Schema.String)),
  refusesDequeue: Schema.optionalKey(Schema.Boolean),
  mergeMethod: Schema.optionalKey(Schema.Literals(["MERGE", "SQUASH", "REBASE"])),
  replies: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Array(Schema.Struct({ thread: Schema.NullOr(Schema.String), body: Schema.String })),
    ),
  ),
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
  tags: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        project: Schema.String,
        run: Schema.String,
        sha: Schema.String,
        merged: Schema.Array(Schema.String),
      }),
    ),
  ),
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

interface Answer {
  readonly ran: Ran;
  readonly filedIssue?: FakeIssue;
  readonly issueNoted?: { readonly key: string; readonly body: string };
  readonly cloned?: string;
  readonly noted?: { readonly key: string; readonly body: string };
  readonly approved?: string;
  readonly dismissed?: string;
  readonly retried?: { readonly mr: FakeMr; readonly at: number | ReadonlyArray<number> };
  readonly pipelineStarted?: {
    readonly sha: string;
    readonly pipeline: NonNullable<ForgeModel["pipelinesOn"]>[string][number];
  };
  readonly oauth?: { readonly token: string; readonly expiry: string };
  readonly replied?: {
    readonly mr: FakeMr;
    readonly thread: string | null;
    readonly body: string;
  };
  readonly enqueued?: { readonly mr: FakeMr; readonly head: string };
  readonly dequeued?: FakeMr;
  readonly merged?: {
    readonly mr: FakeMr;
    readonly sha: string;
    readonly method: string | undefined;
    readonly fields: ReadonlyArray<string>;
  };
}

const Json = Schema.fromJsonString(Schema.Json);
const ok: (stdout?: string) => Answer = (stdout = "") => ({ ran: { code: 0, stdout } });
const json: (value: Schema.Json) => Answer = (value) =>
  ok(flow(Schema.encodeResult(Json), Result.getOrThrow)(value));
const no: (code?: number) => Answer = (code = 1) => ({ ran: { code, stdout: "" } });

const flag = (args: ReadonlyArray<string>, name: string) => {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
};

const fieldsOf = (args: ReadonlyArray<string>, kind = "-f") =>
  Arr.flatMap(args, (arg, at) => (args[at - 1] === kind ? [arg] : []));
const field = (args: ReadonlyArray<string>, name: string, kind = "-f") =>
  Option.getOrUndefined(
    Option.map(
      Option.fromNullishOr(
        Option.getOrUndefined(
          Arr.findFirst(fieldsOf(args, kind), (one) => pipe(one, Str.startsWith(`${name}=`))),
        ),
      ),
      (present) => pipe(present, Str.slice(name.length + 1)),
    ),
  );

const refused: (said: string) => Answer = (said) => ({
  ran: { code: 1, stdout: "", stderr: said },
});

const NOW = "2026-10-20T12:00:00Z";

export const mergeCommitOf = (mr: FakeMr) => mr.mergedSha ?? `merge-of-${mr.head ?? ""}`;

const NOT_MERGEABLE = {
  gitlab: "405 Method Not Allowed",
  github: "Pull Request is not mergeable (HTTP 405)",
} as const;
const HEAD_MOVED = {
  gitlab: "409 SHA does not match HEAD of source branch",
  github: "Head branch was modified. Review and try the merge again. (HTTP 409)",
} as const;

function mergeAnswer(forge: MrForge, mr: FakeMr, args: ReadonlyArray<string>) {
  const sha = field(args, "sha") ?? "";
  if (mr.state !== "open") {
    const returned: Answer = refused(NOT_MERGEABLE[forge]);
    return returned;
  }
  if (sha !== (mr.head ?? "")) {
    const returned: Answer = refused(HEAD_MOVED[forge]);
    return returned;
  }
  if ((mr.mergeable ?? "yes") !== "yes") {
    const returned: Answer = refused(NOT_MERGEABLE[forge]);
    return returned;
  }
  const returned: Answer = {
    ...json(
      forge === "gitlab"
        ? { state: "merged", merge_commit_sha: mergeCommitOf(mr) }
        : { merged: true, sha: mergeCommitOf(mr) },
    ),
    merged: { mr, sha, method: field(args, "merge_method"), fields: fieldsOf(args) },
  };
  return returned;
}

function discussionsOf(mr: FakeMr) {
  const threads = new Map<string, Array<FakeComment>>();
  for (const comment of mr.comments ?? []) {
    const id = comment.thread ?? `note-${comment.id}`;
    threads.set(id, [...(threads.get(id) ?? []), comment]);
  }
  return Arr.map([...threads], ([id, notes]) => ({
    id,
    individual_note: notes[0]?.thread === undefined,
    notes: Arr.map(notes, (note) => ({
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

const rulesOf = (mr: FakeMr) =>
  mr.rules ??
  (mr.required === undefined && mr.approvers === undefined
    ? []
    : [{ name: "All Members", required: mr.required ?? 0, approvers: mr.approvers ?? [] }]);

const standingOf = (reviews: ReadonlyArray<FakeReview>) => {
  const standing = new Map<string, FakeReview>();
  for (const review of reviews)
    if (review.state !== "COMMENTED") standing.set(review.author, review);
  return [...standing.values()];
};

function decisionOf(model: ForgeModel, pull: FakeMr) {
  if (pull.approved === true) {
    const returned: string | null = "APPROVED";
    return returned;
  }
  const rules = model.reviewsRequired;
  const required = Math.max(rules?.classic ?? 0, ...(rules?.rulesets ?? []));
  if (required === 0 && rules?.codeOwners !== true) {
    const returned: string | null = null;
    return returned;
  }
  const standing = standingOf(pull.reviews ?? []);
  if (Arr.some(standing, (one) => one.state === "CHANGES_REQUESTED")) {
    const returned: string | null = "CHANGES_REQUESTED";
    return returned;
  }
  const returned: string | null =
    Arr.filter(standing, (one) => one.state === "APPROVED").length >= required
      ? "APPROVED"
      : "REVIEW_REQUIRED";
  return returned;
}

const userOf = (login: string, bot: boolean | undefined) => ({
  login,
  type: bot === true ? "Bot" : "User",
});

const pagesOf: (items: ReadonlyArray<Schema.Json>, args: ReadonlyArray<string>) => Answer = (
  items,
  args,
) =>
  json(
    args.includes("--slurp")
      ? [[...items]]
      : pageOf(
          Option.getOrUndefined(
            Arr.findFirst(args, (one) => pipe(one, Str.startsWith("repos/"))),
          ) ?? "",
          items,
        ),
  );

function issueAnswer(forge: MrForge, model: ForgeModel, args: ReadonlyArray<string>) {
  const project = `${forge === "github" ? "github.com/" : ""}${flag(args, "--repo") ?? ""}`;
  const issues = Arr.filter(model.issues ?? [], (one) => one.project === project);
  const url = (number: number) =>
    `https://${project}/${forge === "gitlab" ? "-/issues" : "issues"}/${number}`;
  if (args[1] === "list") {
    const open = Arr.filter(issues, (one) => one.state === "open");
    const page = Number(flag(args, "--page") ?? "1");
    const size = Number(flag(args, "--per-page") ?? flag(args, "--limit") ?? "30");
    const answer: Answer = json(
      Arr.map(open.slice((page - 1) * size, page * size), (one) => {
        const returned: Schema.Json =
          forge === "github"
            ? { number: one.number, title: one.title, body: one.body, url: url(one.number) }
            : {
                iid: one.number,
                title: one.title,
                description: one.body,
                web_url: url(one.number),
              };
        return returned;
      }),
    );
    return answer;
  }
  if (args[1] === "create") {
    const number = Math.max(0, ...Arr.map(issues, (one) => one.number)) + 1;
    const answer: Answer = {
      ...ok(`${url(number)}\n`),
      filedIssue: {
        project,
        number,
        title: flag(args, "--title") ?? "",
        body: flag(args, forge === "github" ? "--body" : "--description") ?? "",
        state: "open",
      },
    };
    return answer;
  }
  if (args[1] === "comment" || args[1] === "note") {
    const number = Number(args[2]);
    if (!Arr.some(issues, (one) => one.number === number)) {
      const answer: Answer = no();
      return answer;
    }
    const answer: Answer = {
      ...ok(),
      issueNoted: {
        key: `${project}#${number}`,
        body: flag(args, forge === "github" ? "--body" : "--message") ?? "",
      },
    };
    return answer;
  }
  const answer: Answer = no();
  return answer;
}

function issueApi(forge: MrForge, model: ForgeModel, route: string, args: ReadonlyArray<string>) {
  if (route === "user") {
    const answer: Answer | null =
      model.login === null
        ? no()
        : json(forge === "github" ? { login: model.login } : { id: 1, username: model.login });
    return answer;
  }
  const match =
    forge === "github"
      ? /^repos\/([^/]+\/[^/]+)\/issues(?:\/(\d+)(\/comments)?)?(?:\?.*)?$/.exec(route)
      : /^projects\/([^/]+)\/issues(?:\/(\d+)(\/notes)?)?(?:\?.*)?$/.exec(route);
  if (match === null) {
    const answer: Answer | null = null;
    return answer;
  }
  const path = decodeURIComponent(match[1]!);
  const project = `${forge === "github" ? "github.com" : flag(args, "--hostname")}/${path}`;
  if (flag(args, "-X") === "POST" && match[2] !== undefined && match[3] !== undefined) {
    if (Arr.some(model.mrs, (one) => one.project === project && one.iid === match[2])) {
      const answer: Answer | null = null;
      return answer;
    }
    if (model.refusesIssueWrite !== undefined) {
      const answer: Answer | null = refused(`${model.refusesIssueWrite} Forbidden`);
      return answer;
    }
    const noted = issueAnswer(forge, model, [
      "issue",
      "comment",
      match[2],
      "--repo",
      forge === "github" ? path : project,
      forge === "github" ? "--body" : "--message",
      field(args, "body") ?? "",
    ]);
    const answer: Answer | null =
      noted.ran.code !== 0
        ? noted
        : { ...noted, ...json({ id: 1, body: field(args, "body") ?? "" }) };
    return answer;
  }
  if (flag(args, "-X") === "POST" && match[2] === undefined) {
    if (model.refusesIssueWrite !== undefined) {
      const answer: Answer | null = refused(`${model.refusesIssueWrite} Forbidden`);
      return answer;
    }
    const filed = issueAnswer(forge, model, [
      "issue",
      "create",
      "--repo",
      forge === "github" ? path : project,
      "--title",
      field(args, "title") ?? "",
      forge === "github" ? "--body" : "--description",
      field(args, forge === "github" ? "body" : "description") ?? "",
    ]);
    const one = filed.filedIssue;
    if (one === undefined) {
      const answer: Answer | null = filed;
      return answer;
    }
    const answer: Answer | null = {
      ...filed,
      ...json(
        forge === "github"
          ? {
              number: one.number,
              title: one.title,
              body: one.body,
              html_url: `https://${project}/issues/${one.number}`,
            }
          : {
              iid: one.number,
              title: one.title,
              description: one.body,
              web_url: `https://${project}/-/issues/${one.number}`,
            },
      ),
    };
    return answer;
  }
  if ((flag(args, "-X") ?? "GET") !== "GET") {
    const answer: Answer | null = null;
    return answer;
  }
  if (match[3] !== undefined) {
    const answer: Answer | null = null;
    return answer;
  }
  if (match[2] !== undefined) {
    const one = Option.getOrUndefined(
      Arr.findFirst(
        model.issues ?? [],
        (issue) => issue.project === project && issue.number === Number(match[2]),
      ),
    );
    if (one === undefined) {
      const answer: Answer | null = no();
      return answer;
    }
    const answer: Answer | null = json(
      forge === "github"
        ? {
            number: one.number,
            title: one.title,
            body: one.body,
            state: one.state,
            html_url: `https://${project}/issues/${one.number}`,
          }
        : {
            iid: one.number,
            title: one.title,
            description: one.body,
            state: one.state === "open" ? "opened" : "closed",
            web_url: `https://${project}/-/issues/${one.number}`,
          },
    );
    return answer;
  }
  const query = new URLSearchParams(Str.split(route, "?")[1]);
  const issues: Array<Schema.Json> = Arr.map(
    Arr.filter(
      model.issues ?? [],
      (one) =>
        one.project === project &&
        one.state === "open" &&
        !query.has("creator") &&
        !query.has("assignee"),
    ),
    (one) => {
      const returned: Schema.Json =
        forge === "github"
          ? {
              number: one.number,
              title: one.title,
              body: one.body,
              state: "open",
              html_url: `https://${project}/issues/${one.number}`,
            }
          : {
              iid: one.number,
              title: one.title,
              description: one.body,
              state: "opened",
              web_url: `https://${project}/-/issues/${one.number}`,
            };
      return returned;
    },
  );
  if (forge === "github")
    issues.push(
      ...Arr.map(
        Arr.filter(
          model.mrs,
          (one) =>
            one.project === project &&
            one.state === "open" &&
            (!query.has("creator") || one.author === query.get("creator")) &&
            (!query.has("assignee") || (one.assignees ?? []).includes(query.get("assignee")!)),
        ),
        (one) => ({
          number: Number(one.iid),
          title: one.title ?? "",
          body: "",
          state: "open",
          pull_request: {},
          user: { login: one.author ?? "" },
          assignees: Arr.map(one.assignees ?? [], (login) => ({ login })),
        }),
      ),
    );
  const answer: Answer | null = json(pageOf(route, issues));
  return answer;
}

const keyOf = (forge: MrForge, mr: FakeMr) =>
  `${mr.project}${forge === "github" ? "#" : "!"}${mr.iid}`;

const mine = (model: ForgeModel, who: string | undefined) =>
  Arr.filter(
    model.mrs,
    (one) =>
      one.state === "open" &&
      model.login !== null &&
      (who === "--assignee"
        ? (one.assignees ?? []).includes(model.login)
        : one.author === model.login),
  );

function pipelineOf(checks: ReadonlyArray<Check> | undefined) {
  if (checks === undefined || checks.length === 0) {
    const returned: string | null = null;
    return returned;
  }
  if (Arr.some(checks, (one) => one.state === "failed")) {
    const returned: string | null = "failed";
    return returned;
  }
  if (Arr.some(checks, (one) => one.state === "running")) {
    const returned: string | null = "running";
    return returned;
  }
  const returned: string | null = "success";
  return returned;
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

const runsFor = (model: ForgeModel, ref: string) => {
  const entries = Rec.toEntries(model.runs ?? {});
  const runs = Arr.filter(entries, ([, one]) => one.ref === ref);
  return Arr.sortWith(runs, ([id]) => Number(id), Order.flip(Order.Number));
};

function pageOf<T>(route: string, all: ReadonlyArray<T>) {
  const page = Number(/[?&]page=(\d+)/.exec(route)?.[1] ?? "1");
  const size = Number(/[?&]per_page=(\d+)/.exec(route)?.[1] ?? "20");
  const returned: Array<T> = all.slice((page - 1) * size, page * size);
  return returned;
}

const pipelineIdOf = (mr: FakeMr) => Number(mr.iid) * 100;

const jobsOf = (jobs: ReadonlyArray<FakeJob>, from: number) =>
  Arr.map(jobs, (job, at) => ({ ...job, id: job.id ?? from + at + 1 }));

const retriedJob: ({ trace, ...job }: FakeJob, n: number) => FakeJob = ({ trace, ...job }, n) => {
  const id = job.id ?? n + 1;
  const attempt = trace === undefined ? { id, state: job.state } : { id, state: job.state, trace };
  return {
    ...job,
    state: job.retried ?? job.state,
    id: id + 100,
    attempts: [...(job.attempts ?? []), attempt],
  };
};

const actionsRun = (mr: FakeMr | undefined, from = 0) => 4000 + from + Number(mr?.iid ?? 0);

const actionsAttempts = (mr: FakeMr) =>
  Arr.flatMap(
    [
      [mr.jobs ?? [], 0],
      [mr.base?.jobs ?? [], 1000],
      [mr.target?.jobs ?? [], 2000],
    ] as const,
    ([jobs, from]) =>
      Arr.flatMap(jobsOf(jobs, from), ({ attempts = [], ...job }) => [
        ...Arr.map(attempts, (one, at) => ({
          ...one,
          name: job.name,
          attempt: at + 1,
          run: actionsRun(mr, from),
        })),
        { ...job, attempt: attempts.length + 1, run: actionsRun(mr, from) },
      ]),
  );

const headJobAt = (model: ForgeModel, project: (mr: FakeMr) => boolean, id: number) => {
  for (const mr of Arr.filter(model.mrs, project)) {
    const at = Option.getOrElse(
      Arr.findFirstIndex(jobsOf(mr.jobs ?? [], 0), (job) => job.id === id),
      () => -1,
    );
    if (at !== -1) return { mr, at };
  }
  return undefined;
};

function glabMrJson(mr: FakeMr) {
  const pipeline = pipelineOf(mr.checks);
  return {
    iid: Number(mr.iid),
    title: mr.title ?? "",
    state: mr.state === "open" ? "opened" : mr.state,
    draft: mr.draft ?? false,
    author: { username: mr.author ?? "" },
    assignees: Arr.map(mr.assignees ?? [], (username) => ({ username })),
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

interface Under {
  readonly now: number;
  readonly environment: boolean;
}

export const tokenOf = (forge: MrForge, model: ForgeModel) =>
  forge === "gitlab"
    ? (model.oauth?.token ?? model.token ?? "glpat-fake")
    : (model.token ?? "gho-fake");

// WARNING: glab stores a token's expiry as Go's RFC 822, in UTC.
export const rfc822 = (ms: number) => {
  const at = DateTime.toPartsUtc(DateTime.makeUnsafe(ms));
  const two = (n: number) => pipe(String(n), Str.padStart(2, "0"));
  return `${two(at.day)} ${MONTHS[at.month - 1]} ${two(at.year % 100)} ${two(at.hour)}:${two(at.minute)} UTC`;
};

function glab(model: ForgeModel, args: ReadonlyArray<string>, under: Under) {
  if (!model.installed) {
    const returned: Answer = no(127);
    return returned;
  }
  const [verb, sub] = args;
  if (verb === "issue") {
    const returned: Answer = issueAnswer("gitlab", model, args);
    return returned;
  }
  if (verb === "--version") {
    const returned: Answer = ok("glab 1.0.0");
    return returned;
  }
  if (verb === "auth" && sub === "status") {
    const host = flag(args, "--hostname");
    if (host !== undefined && !model.loggedIn.includes(host)) {
      const returned: Answer = no();
      return returned;
    }
    const login = model.oauth;
    const expires = login === undefined ? null : glabExpiry(login.expiry);
    // WARNING: Building glab's API client refreshes an expired OAuth token, as glab 1.53.0 does.
    const returned: Answer =
      login !== undefined && expires !== null && expires <= under.now
        ? {
            ...ok(),
            oauth: { token: `${login.token}-refreshed`, expiry: rfc822(under.now + 7_200_000) },
          }
        : ok();
    return returned;
  }
  if (verb === "config" && sub === "get") {
    if (args[2] === "host") {
      const returned: Answer = ok(`${model.loggedIn[0] ?? ""}\n`);
      return returned;
    }
    const host = flag(args, "--host") ?? "";
    const signedIn = model.loggedIn.includes(host);
    if (args[2] === "token") {
      if (under.environment && model.envToken !== undefined) {
        const returned: Answer = ok(`${model.envToken}\n`);
        return returned;
      }
      const returned: Answer = ok(signedIn ? `${tokenOf("gitlab", model)}\n` : "");
      return returned;
    }
    if (args[2] === "oauth2_expiry_date") {
      const returned: Answer = ok(
        signedIn && model.oauth !== undefined ? `${model.oauth.expiry}\n` : "",
      );
      return returned;
    }
  }
  if (verb === "api" && (sub === "user" || args.at(-1) === "user")) {
    const returned: Answer = model.login === null ? no() : json({ username: model.login });
    return returned;
  }
  const mrAt = (iid: string | undefined) => {
    const repo = flag(args, "--repo");
    return Option.getOrUndefined(
      Arr.findFirst(
        model.mrs,
        (one) => one.iid === iid && (repo === undefined || one.project === repo),
      ),
    );
  };
  if (verb === "mr" && sub === "view") {
    const mr = mrAt(args[2]);
    const returned: Answer = mr === undefined ? no() : json(glabMrJson(mr));
    return returned;
  }
  if (verb === "mr" && sub === "list" && flag(args, "--source-branch") !== undefined) {
    const repo = flag(args, "--repo");
    if (repo !== undefined && !model.loggedIn.includes(Str.split(repo, "/")[0])) {
      const returned: Answer = no();
      return returned;
    }
    const returned: Answer = json(
      Arr.map(
        Arr.filter(
          model.mrs,
          (one) =>
            (args.includes("--all") || one.state === "open") &&
            one.sourceBranch === flag(args, "--source-branch") &&
            (repo === undefined || one.project === repo),
        ),
        (one) => ({
          iid: Number(one.iid),
          web_url: `https://${one.project}/-/merge_requests/${one.iid}`,
          merge_when_pipeline_succeeds: one.autoMerge ?? false,
          state: one.state === "open" ? "opened" : one.state,
          created_at: one.createdAt ?? null,
          merged_at: one.mergedAt ?? null,
          closed_at: one.closedAt ?? null,
        }),
      ),
    );
    return returned;
  }
  if (verb === "mr" && sub === "list" && args[3] === "@me") {
    const returned: Answer = json(
      Arr.map(mine(model, args[2]), (one) => ({ iid: Number(one.iid), title: one.title ?? "" })),
    );
    return returned;
  }
  if (verb === "mr" && sub === "approve") {
    const mr = mrAt(args[2]);
    if (mr === undefined || model.refusesApproval === true) {
      const returned: Answer = no();
      return returned;
    }
    const returned: Answer = { ...ok(), approved: keyOf("gitlab", mr) };
    return returned;
  }
  if (verb === "mr" && sub === "note") {
    const mr = mrAt(args[2]);
    if (mr === undefined) {
      const returned: Answer = no();
      return returned;
    }
    const returned: Answer = {
      ...ok(),
      noted: { key: keyOf("gitlab", mr), body: flag(args, "--message") ?? "" },
    };
    return returned;
  }
  if (verb === "api" && flag(args, "--hostname") !== undefined) {
    const route = args.at(-1) ?? "";
    const issue = issueApi("gitlab", model, route, args);
    if (issue !== null) {
      const returned: Answer = issue;
      return returned;
    }
    if (/^projects\/[^/]+$/.test(route)) {
      const returned: Answer =
        model.protectionDown === true
          ? no()
          : json({ default_branch: model.defaultBranch ?? "main" });
      return returned;
    }
    if (/^projects\/[^/]+\/protected_branches/.test(route)) {
      const returned: Answer =
        model.protectionDown === true
          ? no()
          : json(
              pageOf(
                route,
                Arr.map(model.protectedBranches ?? [], (one) => ({
                  name: one.name,
                  allow_force_push: one.allowForcePush ?? false,
                })),
              ),
            );
      return returned;
    }
    if (model.deploysDown === true) {
      const returned: Answer = no();
      return returned;
    }
    const project = `${flag(args, "--hostname")}/${decodeURIComponent(/^projects\/([^/]+)/.exec(route)?.[1] ?? "")}`;
    const environments = Arr.filter(
      model.environments ?? [],
      (one) => one.project === undefined || one.project === project,
    );
    if (/\/environments(\?|$)/.test(route)) {
      const returned: Answer = json(
        pageOf(
          route,
          Arr.map(environments, ({ name, tier }) => ({ name, tier })),
        ),
      );
      return returned;
    }
    if (pipe(route, Str.includes("/deployments?"))) {
      const returned: Answer = json(
        pageOf(
          route,
          Arr.map(
            deploymentsAsked({ ...model, environments }, route),
            ({ sha, status, environment, job, pipeline }) => ({
              sha,
              status,
              environment: { name: environment },
              deployable: job === undefined ? null : { name: job, pipeline: pipeline ?? null },
            }),
          ),
        ),
      );
      return returned;
    }
    const reviewing = /^merge_requests\?(.*)$/.exec(route);
    if (reviewing) {
      const query = new URLSearchParams(reviewing[1]);
      const returned: Answer = json(
        pageOf(
          route,
          Arr.map(
            Arr.filter(
              model.mrs,
              (one) =>
                one.state === "open" &&
                (one.reviewers ?? []).includes(query.get("reviewer_username") ?? ""),
            ),
            (one) => ({
              web_url: `https://${one.project}/-/merge_requests/${one.iid}`,
              title: one.title ?? "",
              author: { username: one.author ?? "" },
            }),
          ),
        ),
      );
      return returned;
    }
    const byBranch = /^projects\/([^/]+)\/merge_requests\?(.*)$/.exec(route);
    if (byBranch) {
      const path = decodeURIComponent(byBranch[1]!);
      const query = new URLSearchParams(byBranch[2]);
      const state = query.get("state");
      const returned: Answer = json(
        pageOf(
          route,
          Arr.map(
            Arr.filter(
              model.mrs,
              (one) =>
                pipe(one.project, Str.endsWith(`/${path}`)) &&
                (!query.has("source_branch") || one.sourceBranch === query.get("source_branch")) &&
                (!query.has("author_username") || one.author === query.get("author_username")) &&
                (!query.has("assignee_username") ||
                  (one.assignees ?? []).includes(query.get("assignee_username")!)) &&
                (state === null || state === "all" || glabMrJson(one).state === state),
            ),
            (one) => ({
              iid: Number(one.iid),
              title: one.title ?? "",
              web_url: `https://${one.project}/-/merge_requests/${one.iid}`,
              merge_when_pipeline_succeeds: one.autoMerge ?? false,
              state: one.state === "open" ? "opened" : one.state,
              created_at: one.createdAt ?? NOW,
              merged_at: one.mergedAt ?? null,
              closed_at: one.closedAt ?? null,
            }),
          ),
        ),
      );
      return returned;
    }
    const onMr = /^projects\/([^/]+)\/merge_requests\/(\d+)(?:\/(.+))?$/.exec(route);
    if (onMr) {
      const [, path = "", iid = "", rest] = onMr;
      const mr = Option.getOrUndefined(
        Arr.findFirst(
          model.mrs,
          (one) =>
            one.iid === iid && pipe(one.project, Str.endsWith(`/${decodeURIComponent(path)}`)),
        ),
      );
      const returned: Answer = mr === undefined ? no() : glabOnMr(model, mr, rest ?? "", args);
      return returned;
    }
    const trace = /^projects\/([^/]+)\/jobs\/(\d+)(\/trace)?$/.exec(route);
    if (trace && !args.includes("POST")) {
      const found = Option.getOrUndefined(
        Arr.findFirst(
          Arr.flatMap(model.mrs, (mr) =>
            Arr.flatMap([mr.jobs ?? [], mr.base?.jobs ?? [], mr.target?.jobs ?? []], (jobs, n) =>
              Arr.flatMap(jobsOf(jobs, n * 1000), (job) =>
                Arr.map([...(job.attempts ?? []), job], (one) => ({
                  mr,
                  one,
                  pipeline: pipelineIdOf(mr) + n,
                })),
              ),
            ),
          ),
          ({ one }) => one.id === Number(trace[2]),
        ),
      );
      if (found === undefined) {
        const returned: Answer = no();
        return returned;
      }
      const returned: Answer =
        trace[3] === undefined
          ? json({
              id: found.one.id,
              web_url: `https://${found.mr.project}/-/jobs/${found.one.id}`,
              pipeline: { id: found.pipeline },
            })
          : ok(found.one.trace ?? "");
      return returned;
    }
    const retry = /^projects\/([^/]+)\/jobs\/(\d+)\/retry$/.exec(route);
    if (retry && args.includes("POST")) {
      const path = decodeURIComponent(retry[1]!);
      const found = headJobAt(
        model,
        (one) => pipe(one.project, Str.endsWith(`/${path}`)),
        Number(retry[2]),
      );
      const returned: Answer =
        found === undefined ? no() : { ...json({ id: Number(retry[2]) }), retried: found };
      return returned;
    }
    const bySha = /\/pipelines\?sha=([^&]+)/.exec(route);
    if (bySha) {
      const sha = bySha[1]!;
      const mr = Option.getOrUndefined(
        Arr.findFirst(model.mrs, (one) => one.base?.at === sha && one.base?.jobs !== undefined),
      );
      const returned: Answer = json([
        ...(mr === undefined ? [] : [{ id: pipelineIdOf(mr) + 1, sha, status: "success" }]),
        ...Arr.map(model.pipelinesOn?.[sha] ?? [], ({ id, status }) => ({
          id,
          sha,
          status,
          web_url: `https://${flag(args, "--hostname")}/${decodeURIComponent(/^projects\/([^/]+)/.exec(route)?.[1] ?? "")}/-/pipelines/${id}`,
        })),
      ]);
      return returned;
    }
    const branchPipeline = /^projects\/([^/]+)\/pipeline\?ref=([^&]+)$/.exec(route);
    if (branchPipeline && args.includes("POST")) {
      const ref = decodeURIComponent(branchPipeline[2]!);
      const mr = Option.getOrUndefined(Arr.findFirst(model.mrs, (one) => one.sourceBranch === ref));
      const returned: Answer =
        mr === undefined
          ? refused("400 Reference not found")
          : pipelineStart(model, mr, model.refusesPipeline?.branch, { source: "api", ref });
      return returned;
    }
    const byRef = /\/pipelines\?ref=([^&]+)/.exec(route);
    const tagged = byRef === null ? [] : runsFor(model, decodeURIComponent(byRef[1]!));
    if (tagged.length > 0) {
      const returned: Answer = json(
        Arr.map(tagged, ([id, one]) => ({ id: Number(id), sha: one.sha ?? "" })),
      );
      return returned;
    }
    if (byRef) {
      const mr = Option.getOrUndefined(
        Arr.findFirst(
          model.mrs,
          (one) => one.targetBranch === decodeURIComponent(byRef[1]!) && one.target !== undefined,
        ),
      );
      const returned: Answer = json(
        mr === undefined ? [] : [{ id: pipelineIdOf(mr) + 2, sha: mr.target!.at }],
      );
      return returned;
    }
    const jobs = /^projects\/([^/]+)\/pipelines\/(\d+)\/jobs/.exec(route);
    const named = jobs === null ? undefined : model.runs?.[jobs[2]!]?.jobs;
    if (named !== undefined) {
      const returned: Answer = json(
        Arr.map(named, (job, at) => ({
          id: at + 1,
          name: job.name,
          status: GITLAB_JOB[job.state],
          web_url: `https://${flag(args, "--hostname")}/${decodeURIComponent(jobs![1]!)}/-/jobs/${at + 1}`,
        })),
      );
      return returned;
    }
    if (jobs) {
      const id = Number(jobs[2]);
      const mr = Option.getOrUndefined(
        Arr.findFirst(model.mrs, (one) => Math.floor(id / 100) === Number(one.iid)),
      );
      const listed =
        mr === undefined
          ? undefined
          : [
              jobsOf(mr.jobs ?? [], 0),
              jobsOf(mr.base?.jobs ?? [], 1000),
              jobsOf(mr.target?.jobs ?? [], 2000),
            ][id - pipelineIdOf(mr)];
      const retriedToo = pipe(route, Str.includes("include_retried=true"));
      const attempts = Arr.flatMap(listed ?? [], (job) => [
        ...Arr.map(retriedToo ? (job.attempts ?? []) : [], (one) => ({
          ...one,
          name: job.name,
        })),
        job,
      ]);
      const returned: Answer =
        mr === undefined || listed === undefined
          ? no()
          : json(
              Arr.map(
                pageOf(
                  route,
                  Arr.sortWith(attempts, (job) => -job.id, Order.Number),
                ),
                (job) => ({
                  id: job.id,
                  name: job.name,
                  status: GITLAB_JOB[job.state],
                  web_url: `https://${mr.project}/-/jobs/${job.id}`,
                  finished_at:
                    "finished" in job && job.finished !== undefined ? job.finished : null,
                }),
              ),
            );
      return returned;
    }
    const commit = /\/repository\/commits\/([^/?]+)$/.exec(route);
    if (commit) {
      const parents =
        model.ancestry?.[commit[1]!] ??
        (Arr.some(deploymentsOf(model), (deployment) => deployment.sha === commit[1])
          ? []
          : undefined);
      const returned: Answer =
        parents === undefined ? no() : json({ id: commit[1]!, parent_ids: [...parents] });
      return returned;
    }
    const pipeline = /\/pipelines\/(\d+)$/.exec(route);
    if (pipeline) {
      const said = model.runs?.[pipeline[1]!];
      const returned: Answer =
        said === undefined
          ? no()
          : json({ status: said.status, ref: said.ref ?? "main", sha: said.sha ?? "" });
      return returned;
    }
    const comparison = /repository\/compare\?from=([^&]+)&to=([^&]+)&straight=true$/.exec(route);
    if (comparison) {
      const mr = Option.getOrUndefined(
        Arr.findFirst(model.mrs, (one) => one.head === comparison[2]),
      );
      const returned: Answer =
        mr === undefined
          ? no()
          : json({
              diffs: [{ new_path: "src/a.ts", diff: mr.interdiff ?? "" }],
              compare_timeout: false,
            });
      return returned;
    }
    const base = /merge_base\?refs\[\]=([^&]+)&refs\[\]=(.+)$/.exec(route);
    if (base) {
      const [, merged = "", live = ""] = base;
      if ((model.gone ?? []).includes(merged)) {
        const returned: Answer = no();
        return returned;
      }
      const carries = live === merged || (model.ancestry?.[live] ?? []).includes(merged);
      const returned: Answer = json({ id: carries ? merged : "0000000" });
      return returned;
    }
  }
  const returned: Answer = no();
  return returned;
}

function pipelineStart(
  model: ForgeModel,
  mr: FakeMr,
  refusing: number | undefined,
  how: { readonly source: string; readonly ref: string },
) {
  if (refusing !== undefined) {
    const returned: Answer = refused(
      `${refusing} ${refusing === 400 ? "No stages / jobs for this pipeline." : "Internal Server Error"}`,
    );
    return returned;
  }
  const sha = (how.source === "merge_request_event" ? mr.pipelineAt : undefined) ?? mr.head ?? "";
  const id =
    1 +
    Math.max(
      0,
      ...Arr.flatMap(
        Rec.values(model.pipelinesOn ?? {}),
        Arr.map((one) => one.id),
      ),
    );
  const pipeline = { id, status: "created", ...how };
  const returned: Answer = {
    ...json({
      id,
      sha,
      ref: how.ref,
      status: "created",
      web_url: `https://${mr.project}/-/pipelines/${id}`,
    }),
    pipelineStarted: { sha, pipeline },
  };
  return returned;
}

function glabOnMr(model: ForgeModel, mr: FakeMr, rest: string, args: ReadonlyArray<string>) {
  const method = flag(args, "-X") ?? "GET";
  if (pipe(rest, Str.startsWith("diffs?")) && method === "GET") {
    const returned: Answer = json(
      pageOf(rest, [{ old_path: "src/a.ts", new_path: "src/a.ts", diff: mr.diff ?? "" }]),
    );
    return returned;
  }
  if (pipe(rest, Str.startsWith("notes?")) && method === "GET") {
    const returned: Answer = json(pageOf(rest, mr.comments ?? []));
    return returned;
  }
  if (rest === "notes" && method === "POST" && model.refusesNote !== undefined) {
    const returned: Answer = refused(`${model.refusesNote} Internal Server Error`);
    return returned;
  }
  if (rest === "notes" && method === "POST") {
    const returned: Answer = {
      ...json({ id: 1, body: field(args, "body") ?? "" }),
      noted: { key: keyOf("gitlab", mr), body: field(args, "body") ?? "" },
      replied: { mr, thread: null, body: field(args, "body") ?? "" },
    };
    return returned;
  }
  if (rest === "approve" && method === "POST" && field(args, "sha") !== mr.head) {
    const returned: Answer = refused("409 SHA does not match HEAD");
    return returned;
  }
  if (rest === "approve" && method === "POST") {
    const returned: Answer = model.refusesApproval
      ? refused(model.refusesApproval === true ? "403 Forbidden" : `403 ${model.refusesApproval}`)
      : {
          ...json({ approved_by: [{ user: { username: model.login ?? "me", id: 1 } }] }),
          approved: keyOf("gitlab", mr),
        };
    return returned;
  }
  if (rest === "" && method === "GET") {
    const returned: Answer = json(glabMrJson(mr));
    return returned;
  }
  if (rest === "approval_state") {
    const returned: Answer =
      model.free === true
        ? refused("403 Forbidden")
        : json({
            rules: Arr.map(rulesOf(mr), (rule) => ({
              name: rule.name,
              approvals_required: rule.required,
              approved_by: Arr.map(rule.approvers, (username) => ({ username })),
            })),
          });
    return returned;
  }
  if (rest === "approvals") {
    const rules = rulesOf(mr);
    const named = mr.approvers ?? [...new Set(Arr.flatMap(rules, (rule) => rule.approvers))];
    const others = named.length === 0 && mr.approved === true ? ["a-reviewer"] : named;
    const approvers = (model.approved ?? []).includes(keyOf("gitlab", mr))
      ? [...others, model.login ?? "me"]
      : others;
    const required = mr.required ?? Math.max(0, ...Arr.map(rules, (rule) => rule.required));
    const returned: Answer = json({
      approvals_required: required,
      approvals_left: Math.max(0, required - approvers.length),
      approved_by: Arr.map(approvers, (username) => ({ user: { username } })),
    });
    return returned;
  }
  if (pipe(rest, Str.startsWith("discussions?")) && method === "GET") {
    const page = Number(/[?&]page=(\d+)/.exec(rest)?.[1] ?? "1");
    const size = Number(/[?&]per_page=(\d+)/.exec(rest)?.[1] ?? "20");
    const returned: Answer = json(discussionsOf(mr).slice((page - 1) * size, page * size));
    return returned;
  }
  const thread = /^discussions\/([^/]+)\/notes$/.exec(rest)?.[1];
  if ((thread !== undefined || rest === "notes") && method === "POST") {
    if (thread !== undefined && !Arr.some(discussionsOf(mr), (one) => one.id === thread)) {
      const returned: Answer = refused("404 Discussion Not Found");
      return returned;
    }
    const returned: Answer = {
      ...json({ id: 1 }),
      replied: { mr, thread: thread ?? null, body: field(args, "body") ?? "" },
    };
    return returned;
  }
  if (rest === "pipelines" && method === "POST") {
    const returned: Answer = pipelineStart(model, mr, model.refusesPipeline?.mr, {
      source: "merge_request_event",
      ref: `refs/merge-requests/${mr.iid}/${mr.pipelineAt === undefined ? "head" : "merge"}`,
    });
    return returned;
  }
  if (rest === "merge" && method === "PUT") {
    const returned: Answer =
      model.refusesMerge === true ? refused(NOT_MERGEABLE.gitlab) : mergeAnswer("gitlab", mr, args);
    return returned;
  }
  const returned: Answer = no();
  return returned;
}

function ghOnPull(
  model: ForgeModel,
  pull: FakeMr,
  kind: string,
  rest: string,
  args: ReadonlyArray<string>,
) {
  const url = `https://${pull.project}/pull/${pull.iid}`;
  const method = flag(args, "-X") ?? "GET";
  if (kind === "pulls" && pipe(rest, Str.startsWith("files?"))) {
    const returned: Answer = json(
      pageOf(rest, [{ filename: "src/a.ts", status: "modified", patch: pull.diff ?? "" }]),
    );
    return returned;
  }
  const comments = pull.comments ?? [];
  const body = field(args, "body") ?? "";
  if (kind === "issues" && rest === "comments" && method === "POST") {
    const returned: Answer = { ...json({ id: 1 }), replied: { mr: pull, thread: null, body } };
    return returned;
  }
  if (kind === "issues" && pipe(rest, Str.startsWith("comments?"))) {
    const returned: Answer = pagesOf(
      Arr.map(
        Arr.filter(comments, (one) => one.thread === undefined),
        (one) => ({
          id: one.id,
          html_url: `${url}#issuecomment-${one.id}`,
          user: userOf(one.author, one.kind === "bot"),
          created_at: one.at,
          body: one.body,
        }),
      ),
      args,
    );
    return returned;
  }
  const replyTo = /^comments\/(\d+)\/replies$/.exec(rest)?.[1];
  if (kind === "pulls" && replyTo !== undefined && method === "POST") {
    const returned: Answer = Arr.some(
      comments,
      (one) => String(one.id) === replyTo && one.thread === replyTo,
    )
      ? { ...json({ id: 1 }), replied: { mr: pull, thread: replyTo, body } }
      : refused("Not Found (HTTP 404)");
    return returned;
  }
  if (kind === "pulls" && pipe(rest, Str.startsWith("comments?"))) {
    const returned: Answer = pagesOf(
      Arr.flatMap(comments, (one) =>
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
    return returned;
  }
  if (kind === "pulls" && pipe(rest, Str.startsWith("reviews?"))) {
    const returned: Answer = pagesOf(
      Arr.map(approvedAs(model, pull), (one) => ({
        id: one.id,
        html_url: `${url}#pullrequestreview-${one.id}`,
        user: userOf(one.author, one.bot),
        state: one.state,
        body: one.body ?? "",
        submitted_at: one.at,
      })),
      args,
    );
    return returned;
  }
  if (kind === "pulls" && rest === "merge" && method === "PUT") {
    const returned: Answer = mergeAnswer("github", pull, args);
    return returned;
  }
  const returned: Answer = no();
  return returned;
}

const approvedAs: (model: ForgeModel, pull: FakeMr) => ReadonlyArray<FakeReview> = (model, pull) =>
  (model.approved ?? []).includes(keyOf("github", pull))
    ? [
        ...(pull.reviews ?? []),
        { id: 1, author: model.login ?? "me", state: "APPROVED", at: "2026-11-11T10:00:00Z" },
      ]
    : (pull.reviews ?? []);

const ghPullNode = (model: ForgeModel, pull: FakeMr) => ({
  id: `PR_${pull.iid}`,
  mergeQueueEntry: pull.queued === undefined ? null : { headCommit: { oid: pull.queued } },
  timelineItems: {
    nodes: pull.dequeuedFor === undefined ? [] : [{ reason: pull.dequeuedFor }],
  },
  title: pull.title ?? "",
  state: Str.toUpperCase(pull.state),
  isDraft: pull.draft ?? false,
  author: { login: pull.author ?? "" },
  assignees: { nodes: Arr.map(pull.assignees ?? [], (login) => ({ login })) },
  headRefName: pull.sourceBranch ?? "",
  isCrossRepository: pull.fork === true,
  baseRefName: pull.targetBranch ?? "",
  reviewDecision: decisionOf(model, pull),
  comments: {
    totalCount: 0,
    nodes: Arr.flatMap(pull.comments ?? [], (one) =>
      one.kind === "system" || one.thread !== undefined
        ? []
        : [{ databaseId: one.id, body: one.body }],
    ),
  },
  updatedAt: pull.updatedAt ?? null,
  url: `https://${pull.project}/pull/${pull.iid}`,
  autoMergeRequest: pull.autoMerge === true ? { enabledAt: "2026-10-01T00:00:00Z" } : null,
  headRefOid: pull.head ?? null,
  ...GITHUB_MERGE_STATE[pull.mergeable ?? "yes"],
  mergeCommit: pull.mergedSha === undefined ? null : { oid: pull.mergedSha },
  mergedAt: pull.mergedAt ?? null,
  mergedBy: pull.mergedBy === undefined ? null : { login: pull.mergedBy },
  commits: {
    nodes: [
      {
        commit: {
          statusCheckRollup:
            (pull.checks ?? []).length === 0
              ? null
              : {
                  contexts: {
                    nodes: Arr.map(pull.checks ?? [], (check) => ({
                      __typename: "CheckRun",
                      name: check.name,
                      detailsUrl: pull.checksUrl ?? null,
                      status: check.state === "running" ? "QUEUED" : "COMPLETED",
                      conclusion:
                        check.state === "running"
                          ? null
                          : check.state === "passed"
                            ? "SUCCESS"
                            : "FAILURE",
                    })),
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
        },
      },
    ],
  },
});

function ghGraphql(model: ForgeModel, args: ReadonlyArray<string>) {
  const query = field(args, "query") ?? "";
  const typed = (name: string) => field(args, name, "-F");
  const asked = Option.getOrUndefined(
    Arr.findFirst(
      model.mrs,
      (one) =>
        one.project === `github.com/${typed("owner")}/${typed("name")}` &&
        one.iid === typed("number"),
    ),
  );
  const queueing = /(enqueue|dequeue)PullRequest/.exec(query)?.[1];
  if (queueing !== undefined) {
    const pull = Option.getOrUndefined(
      Arr.findFirst(model.mrs, (one) => `PR_${one.iid}` === typed("id")),
    );
    const refusal = (message: string) =>
      json({ data: null, errors: [{ type: "UNPROCESSABLE", message }] });
    if (pull === undefined) {
      const returned: Answer | undefined = refusal("Could not resolve to a node.");
      return returned;
    }
    if (queueing === "dequeue") {
      const returned: Answer | undefined =
        model.refusesDequeue === true
          ? refusal("Something went wrong while executing your query.")
          : { ...json({ data: { dequeuePullRequest: {} } }), dequeued: pull };
      return returned;
    }
    if (pull.state !== "open") {
      const returned: Answer | undefined = refusal("Pull request is not open.");
      return returned;
    }
    if (typed("head") !== pull.head) {
      const returned: Answer | undefined = refusal("Head sha didn't match expected head sha.");
      return returned;
    }
    const returned: Answer | undefined = {
      ...json({ data: { enqueuePullRequest: {} } }),
      enqueued: { mr: pull, head: typed("head") ?? "" },
    };
    return returned;
  }
  if (pipe(query, Str.includes("mergeQueue("))) {
    const returned: Answer | undefined = json({
      data: {
        repository: {
          mergeQueue: (model.mergeQueues ?? []).includes(typed("branch") ?? "")
            ? { id: `MQ_${typed("branch")}` }
            : null,
        },
      },
    });
    return returned;
  }
  if (pipe(query, Str.includes("viewerDefaultMergeMethod"))) {
    const returned: Answer | undefined = json({
      data: {
        repository: {
          viewerDefaultMergeMethod: model.mergeMethod ?? "MERGE",
          pullRequest: asked === undefined ? null : ghPullNode(model, asked),
        },
      },
    });
    return returned;
  }
  if (pipe(query, Str.includes("statusCheckRollup")) || pipe(query, Str.includes("mergedBy"))) {
    const pull = asked;
    if (pull === undefined) {
      const returned: Answer | undefined = json({
        data: { repository: { pullRequest: null } },
        errors: [{ type: "NOT_FOUND", message: "Could not resolve to a PullRequest." }],
      });
      return returned;
    }
    const returned: Answer | undefined = json({
      data: { repository: { pullRequest: ghPullNode(model, pull) } },
    });
    return returned;
  }
  if (pipe(query, Str.includes("reviewThreads"))) {
    const pull = Option.getOrUndefined(
      Arr.findFirst(
        model.mrs,
        (one) =>
          one.project === `github.com/${typed("owner")}/${typed("name")}` &&
          one.iid === typed("number"),
      ),
    );
    if (pull === undefined) {
      const returned: Answer | undefined = no();
      return returned;
    }
    const threads = new Set(
      Arr.flatMap(pull.comments ?? [], (one) => Arr.ensure(one.thread ?? [])),
    );
    const page = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: Arr.map([...threads], (thread) => ({
                isResolved: (pull.resolved ?? []).includes(thread),
                comments: { nodes: [{ databaseId: Number(thread) }] },
              })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    };
    const returned: Answer | undefined = json(args.includes("--slurp") ? [page] : page);
    return returned;
  }
  if (pipe(query, Str.includes("refUpdateRule"))) {
    if (model.protectionDown === true) {
      const returned: Answer | undefined = no();
      return returned;
    }
    const required = model.reviewsRequired;
    const returned: Answer | undefined = json({
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
    return returned;
  }
  const returned: Answer | undefined = undefined;
  return returned;
}

const deploymentsOf = (model: ForgeModel) =>
  Arr.flatMap(model.environments ?? [], (env, at) =>
    Arr.map(
      env.deployments ?? [
        ...(env.failed === undefined || env.failed === ""
          ? []
          : [{ sha: env.failed, status: "failed" as const }]),
        ...(env.deployed === undefined ? [] : [{ sha: env.deployed, status: "success" as const }]),
      ],
      (one, n) => ({
        id: at * 1000 + n + 1,
        sha: one.sha,
        environment: env.name,
        state:
          one.status === "failed"
            ? "failure"
            : one.status === "running"
              ? "in_progress"
              : one.status,
        status: one.status,
        job: "job" in one ? one.job : env.job,
        jobId: "jobId" in one ? one.jobId : undefined,
        logUrl: "logUrl" in one ? one.logUrl : undefined,
        pipeline: "pipeline" in one ? one.pipeline : undefined,
      }),
    ),
  );

const deploymentsAsked = (model: ForgeModel, route: string) => {
  const query = new URLSearchParams(Str.split(route, "?")[1] ?? "");
  const environment = query.get("environment");
  const sha = query.get("sha");
  const status = query.get("status");
  return Arr.filter(
    deploymentsOf(model),
    (one) =>
      (environment === null || one.environment === environment) &&
      (sha === null || one.sha === sha) &&
      (status === null || one.status === status),
  );
};

function ghApi(model: ForgeModel, route: string, args: ReadonlyArray<string>) {
  const issue = issueApi("github", model, route, args);
  if (issue !== null) {
    const returned: Answer = issue;
    return returned;
  }
  if (/^repos\/[^/]+\/[^/]+$/.test(route)) {
    const returned: Answer =
      model.protectionDown === true
        ? no()
        : json({ default_branch: model.defaultBranch ?? "main" });
    return returned;
  }
  const ruled = /\/rules\/branches\/(.+)$/.exec(route);
  if (ruled) {
    if (model.protectionDown === true) {
      const returned: Answer = no();
      return returned;
    }
    const required = model.reviewsRequired;
    const returned: Answer = pagesOf(
      [
        ...Arr.map(
          Arr.filter(model.rulesets ?? [], (pattern) =>
            new Bun.Glob(pattern).match(decodeURIComponent(ruled[1]!)),
          ),
          (_, at) => ({ type: "pull_request", ruleset_id: at + 1 }),
        ),
        ...Arr.map(required?.rulesets ?? [], (count, at) => ({
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
    return returned;
  }
  const searched = /^search\/issues\?(.*)$/.exec(route);
  if (searched) {
    const words = Str.split(new URLSearchParams(searched[1]).get("q") ?? "", " ");
    const requested = Option.getOrUndefined(
      Arr.findFirst(words, (word) => pipe(word, Str.startsWith("review-requested:"))),
    );
    const returned: Answer = json({
      items: pageOf(
        route,
        Arr.map(
          Arr.filter(
            model.mrs,
            (one) =>
              one.state === "open" &&
              words.includes("is:pr") &&
              words.includes("is:open") &&
              requested !== undefined &&
              (one.reviewers ?? []).includes(
                pipe(requested, Str.slice("review-requested:".length)),
              ),
          ),
          (one) => ({
            html_url: `https://${one.project}/pull/${one.iid}`,
            title: one.title ?? "",
            user: { login: one.author ?? "" },
          }),
        ),
      ),
    });
    return returned;
  }
  const asked = route === "graphql" ? ghGraphql(model, args) : undefined;
  if (asked !== undefined) {
    const returned: Answer = asked;
    return returned;
  }
  const pulls = /^repos\/([^/]+\/[^/]+)\/pulls\?(.*)$/.exec(route);
  if (pulls) {
    const query = new URLSearchParams(pulls[2]);
    const [owner, branch = ""] = Str.split(query.get("head") ?? "", /:(.*)/);
    const returned: Answer = json(
      pageOf(
        route,
        Arr.map(
          Arr.filter(
            model.mrs,
            (one) =>
              one.project === `github.com/${pulls[1]}` &&
              pipe(pulls[1]!, Str.startsWith(`${owner}/`)) &&
              (query.get("state") === "all" || one.state === "open") &&
              one.sourceBranch === branch,
          ),
          (one) => ({
            number: Number(one.iid),
            html_url: `https://${one.project}/pull/${one.iid}`,
            state: one.state === "open" ? "open" : "closed",
            created_at: one.createdAt ?? "",
            merged_at: one.mergedAt ?? null,
            // WARNING: GitHub stamps a merged pull request closed too.
            closed_at: one.closedAt ?? one.mergedAt ?? null,
            auto_merge:
              one.autoMerge === true
                ? { merge_method: "merge", enabled_by: { login: "me" } }
                : null,
          }),
        ),
      ),
    );
    return returned;
  }
  const pullOnly = /^repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(route);
  if (pullOnly) {
    const pull = Option.getOrUndefined(
      Arr.findFirst(
        model.mrs,
        (one) => one.project === `github.com/${pullOnly[1]}` && one.iid === pullOnly[2],
      ),
    );
    const returned: Answer =
      pull === undefined
        ? no()
        : json({
            number: Number(pull.iid),
            head: { sha: pull.head ?? "", ref: pull.sourceBranch ?? "" },
            base: { ref: pull.targetBranch ?? "" },
          });
    return returned;
  }
  const onPull = /^repos\/([^/]+\/[^/]+)\/(pulls|issues)\/(\d+)\/(.+)$/.exec(route);
  if (onPull) {
    const [, repo = "", kind = "", number = "", rest = ""] = onPull;
    const pull = Option.getOrUndefined(
      Arr.findFirst(model.mrs, (one) => one.project === `github.com/${repo}` && one.iid === number),
    );
    if (
      pull !== undefined &&
      kind === "pulls" &&
      rest === "reviews/1/dismissals" &&
      flag(args, "-X") === "PUT"
    ) {
      const returned: Answer = {
        ...json({ id: 1, state: "DISMISSED" }),
        dismissed: keyOf("github", pull),
      };
      return returned;
    }
    if (
      pull !== undefined &&
      kind === "pulls" &&
      rest === "reviews" &&
      flag(args, "-X") === "POST"
    ) {
      const returned: Answer = model.refusesApproval
        ? refused(model.refusesApproval === true ? "403 Forbidden" : `403 ${model.refusesApproval}`)
        : { ...json({ id: 1, state: "APPROVED" }), approved: keyOf("github", pull) };
      return returned;
    }
    if (pull !== undefined && kind === "pulls" && rest === "merge" && model.refusesMerge === true) {
      const returned: Answer = refused(NOT_MERGEABLE.github);
      return returned;
    }
    if (
      pull !== undefined &&
      kind === "issues" &&
      rest === "comments" &&
      flag(args, "-X") === "POST"
    ) {
      const returned: Answer = {
        ...ghOnPull(model, pull, kind, rest, args),
        noted: { key: keyOf("github", pull), body: field(args, "body") ?? "" },
      };
      return returned;
    }
    const returned: Answer = pull === undefined ? no() : ghOnPull(model, pull, kind, rest, args);
    return returned;
  }
  if (route === "graphql") {
    const returned: Answer =
      model.protectionDown === true
        ? no()
        : json({
            data: {
              repository: {
                branchProtectionRules: {
                  nodes: Arr.map(model.protectedBranches ?? [], (one) => ({ pattern: one.name })),
                },
              },
            },
          });
    return returned;
  }
  if (model.deploysDown === true) {
    const returned: Answer = no();
    return returned;
  }
  const tierOf = (name: string) =>
    Option.getOrUndefined(Arr.findFirst(model.environments ?? [], (env) => env.name === name))
      ?.tier;
  if (/\/environments\?/.test(route)) {
    const environments = Arr.map(model.environments ?? [], (env) => ({ name: env.name }));
    const page = {
      total_count: environments.length,
      environments: args.includes("--slurp") ? environments : pageOf(route, environments),
    };
    const returned: Answer = json(args.includes("--slurp") ? [page] : page);
    return returned;
  }
  if (/\/deployments\?/.test(route)) {
    const deployments = Arr.map(deploymentsAsked(model, route), ({ id, sha, environment }) => ({
      id,
      sha,
      environment,
      production_environment: tierOf(environment) === "production",
    }));
    if (!args.includes("--paginate")) {
      const returned: Answer = json(pageOf(route, deployments));
      return returned;
    }
    const pages = [];
    for (let at = 0; at < deployments.length; at += 100)
      pages.push(deployments.slice(at, at + 100));
    const returned: Answer = args.includes("--slurp") ? json(pages) : no();
    return returned;
  }
  const statuses = /\/deployments\/(\d+)\/statuses/.exec(route);
  if (statuses) {
    const one = Option.getOrUndefined(
      Arr.findFirst(deploymentsOf(model), (deployment) => deployment.id === Number(statuses[1])),
    );
    if (one === undefined) {
      const returned: Answer = no();
      return returned;
    }
    const mr = model.mrs[0];
    const jobId =
      one.jobId ??
      Option.getOrUndefined(Arr.findFirst(mr?.jobs ?? [], (job) => job.name === one.job))?.id ??
      Option.getOrElse(
        Arr.findFirstIndex(mr?.jobs ?? [], (job) => job.name === one.job),
        () => -1,
      ) + 1;
    const returned: Answer = json([
      {
        state: one.state,
        log_url:
          one.logUrl ?? (jobId > 0 ? `https://${mr?.project}/actions/runs/7/job/${jobId}` : ""),
      },
    ]);
    return returned;
  }
  const compare = /\/compare\/([^.]+)\.\.\.(.+)$/.exec(route);
  if (compare) {
    const [, merged = "", live = ""] = compare;
    if ((model.gone ?? []).includes(merged)) {
      const returned: Answer = no();
      return returned;
    }
    const status =
      merged === live
        ? "identical"
        : (model.ancestry?.[live] ?? []).includes(merged)
          ? "ahead"
          : "behind";
    const pull = Option.getOrUndefined(
      Arr.findFirst(model.mrs, (one) => one.targetBranch === merged && one.head === live),
    );
    const returned: Answer = json({
      status,
      merge_base_commit: pull?.base === undefined ? null : { sha: pull.base.at },
      files: [
        {
          filename: "src/a.ts",
          patch:
            Option.getOrUndefined(Arr.findFirst(model.mrs, (one) => one.head === live))
              ?.interdiff ?? "",
        },
      ],
    });
    return returned;
  }
  const checkRuns =
    /^repos\/(.+)\/commits\/([^/]+)\/check-runs\?(?:check_name=([^&]+)(?:&.*)?|per_page=\d+(?:&page=\d+)?)$/.exec(
      route,
    );
  if (checkRuns) {
    const [, repo = "", sha = "", name] = checkRuns;
    const ofRepo = Arr.filter(model.mrs, (one) => one.project === `github.com/${repo}`);
    const head = Option.getOrUndefined(Arr.findFirst(ofRepo, (one) => one.head === sha));
    const base = Option.getOrUndefined(Arr.findFirst(ofRepo, (one) => one.base?.at === sha));
    const target = Option.getOrUndefined(
      Arr.findFirst(ofRepo, (one) => one.targetBranch === sha && one.target !== undefined),
    );
    const [jobs, at, run] =
      head !== undefined
        ? [jobsOf(head.jobs ?? [], 0), sha, actionsRun(head)]
        : base !== undefined
          ? [jobsOf(base.base?.jobs ?? [], 1000), sha, actionsRun(base, 1000)]
          : target !== undefined
            ? [jobsOf(target.target!.jobs, 2000), target.target!.at, actionsRun(target, 2000)]
            : [jobsOf(model.checksAt?.[sha] ?? [], 0), sha, actionsRun(undefined)];
    const page = {
      check_runs: pipe(
        Arr.flatMap(jobs, (job) => [
          job,
          ...Arr.map(Arr.reverse(job.attempts ?? []), (one) => ({ ...job, ...one })),
        ]),
        Arr.filter(
          (job, at) =>
            pipe(route, Str.includes("filter=all")) ||
            Option.getOrElse(
              Arr.findFirstIndex(jobs, (one) => one.name === job.name),
              () => -1,
            ) === at,
        ),
        Arr.flatMap((job) =>
          name === undefined || job.name === decodeURIComponent(name)
            ? [
                {
                  id: job.id,
                  name: job.name,
                  head_sha: at,
                  ...GITHUB_RUN[job.state],
                  html_url: `https://github.com/${repo}/actions/runs/${run}/job/${job.id}`,
                },
              ]
            : [],
        ),
      ),
    };
    const returned: Answer = args.includes("--slurp")
      ? json([page])
      : json({ check_runs: pageOf(route, page.check_runs) });
    return returned;
  }
  const actionsJob = /^repos\/(.+)\/actions\/jobs\/(\d+)(\/logs)?$/.exec(route);
  if (actionsJob) {
    const [, repo = "", id = "", logs] = actionsJob;
    const found = Option.getOrUndefined(
      Arr.findFirst(
        Arr.flatMap(
          Arr.filter(model.mrs, (one) => one.project === `github.com/${repo}`),
          (mr: FakeMr) => Arr.map(actionsAttempts(mr), (job) => ({ mr, job })),
        ),
        ({ job }) => job.id === Number(id),
      ),
    );
    if (found === undefined) {
      const returned: Answer = no();
      return returned;
    }
    const run = found.job.run;
    if (logs !== undefined) {
      const returned: Answer = found.job.trace === undefined ? no() : ok(found.job.trace);
      return returned;
    }
    const returned: Answer = json({
      id: found.job.id,
      run_id: run,
      run_attempt: found.job.attempt,
      html_url: `https://github.com/${repo}/actions/runs/${run}/job/${found.job.id}`,
    });
    return returned;
  }
  const attemptJobs = /^repos\/(.+)\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs/.exec(route);
  if (attemptJobs) {
    const [, repo = "", run = "", attempt = ""] = attemptJobs;
    const mr = Option.getOrUndefined(
      Arr.findFirst(
        model.mrs,
        (one) =>
          one.project === `github.com/${repo}` &&
          (actionsRun(one) === Number(run) ||
            Arr.some(actionsAttempts(one), (job) => job.run === Number(run))),
      ),
    );
    if (mr === undefined) {
      const returned: Answer = no();
      return returned;
    }
    const jobs = Arr.flatMap(actionsAttempts(mr), (job) =>
      job.run === Number(run) && job.attempt === Number(attempt)
        ? [
            {
              id: job.id,
              name: job.name,
              ...GITHUB_RUN[job.state],
              html_url: `https://github.com/${repo}/actions/runs/${run}/job/${job.id}`,
            },
          ]
        : [],
    );
    const returned: Answer = json({ jobs: pageOf(route, jobs) });
    return returned;
  }
  const rerun = /^repos\/(.+)\/actions\/runs\/(\d+)\/rerun-failed-jobs$/.exec(route);
  if (rerun && args.includes("POST")) {
    const mr = Option.getOrUndefined(
      Arr.findFirst(
        model.mrs,
        (one) => one.project === `github.com/${rerun[1]}` && actionsRun(one) === Number(rerun[2]),
      ),
    );
    const at = Arr.flatMap(mr?.jobs ?? [], (job, n) => (job.state === "failed" ? [n] : []));
    const returned: Answer =
      mr === undefined || at.length === 0 ? no() : { ...ok(), retried: { mr, at } };
    return returned;
  }
  const runJobs = /^repos\/(.+)\/actions\/runs\/(\d+)\/jobs/.exec(route);
  if (runJobs) {
    const said = model.runs?.[runJobs[2]!];
    if (said === undefined) {
      const returned: Answer = no();
      return returned;
    }
    const jobs = Arr.map(said.jobs ?? [], (job, at) => ({
      id: at + 1,
      name: job.name,
      ...GITHUB_RUN[job.state],
      html_url: `https://github.com/${runJobs[1]}/actions/runs/${runJobs[2]}/job/${at + 1}`,
    }));
    if (!args.includes("--paginate")) {
      const returned: Answer = json({ jobs: pageOf(route, jobs) });
      return returned;
    }
    const pages = [];
    for (let at = 0; at === 0 || at < jobs.length; at += 100)
      pages.push({ jobs: jobs.slice(at, at + 100) });
    const returned: Answer = json(args.includes("--slurp") ? pages : pages[0]!);
    return returned;
  }
  const runs = /\/actions\/runs\/(\d+)$/.exec(route);
  if (runs) {
    const said = model.runs?.[runs[1]!];
    const returned: Answer =
      said === undefined
        ? no()
        : json({
            status: said.status,
            conclusion: said.conclusion ?? null,
            head_branch: said.ref ?? "main",
            head_sha: said.sha ?? "",
          });
    return returned;
  }
  const byBranch = /^repos\/(.+)\/actions\/runs\?.*\bbranch=([^&]+)/.exec(route);
  if (byBranch) {
    const event = /[?&]event=([^&]+)/.exec(route)?.[1];
    const runs = runsFor(model, decodeURIComponent(byBranch[2]!));
    const matching = Arr.filter(
      runs,
      ([, one]) => event === undefined || (one.event ?? "push") === event,
    );
    const returned: Answer = json({
      workflow_runs: Arr.map(matching, ([id]) => ({
        id: Number(id),
        html_url: `https://github.com/${byBranch[1]}/actions/runs/${id}`,
      })),
    });
    return returned;
  }
  const returned: Answer = no();
  return returned;
}

function gh(model: ForgeModel, args: ReadonlyArray<string>) {
  if (!model.installed) {
    const returned: Answer = no(127);
    return returned;
  }
  const [verb, sub] = args;
  if (verb === "--version") {
    const returned: Answer = ok("gh version 2.0.0");
    return returned;
  }
  if (verb === "auth" && sub === "status") {
    const returned: Answer = model.loggedIn.includes(flag(args, "--hostname") ?? FORGE_HOST.github)
      ? ok(`Logged in to github.com account ${model.login ?? "tester"}\n`)
      : { ran: { code: 1, stdout: "You are not logged into any GitHub hosts\n" } };
    return returned;
  }
  if (!model.loggedIn.includes(FORGE_HOST.github)) {
    const returned: Answer = no(4);
    return returned;
  }
  if (verb === "auth" && sub === "token") {
    const returned: Answer = ok(`${tokenOf("github", model)}\n`);
    return returned;
  }
  if (verb === "auth" && sub === "git-credential" && args[2] === "get") {
    const returned: Answer = ok(
      `protocol=https\nhost=${FORGE_HOST.github}\nusername=x-access-token\npassword=${tokenOf("github", model)}\n`,
    );
    return returned;
  }
  if (verb === "issue") {
    const returned: Answer = issueAnswer("github", model, args);
    return returned;
  }
  if (verb === "api" && sub === "user") {
    const returned: Answer = model.login === null ? no() : json({ login: model.login });
    return returned;
  }
  if (verb === "repo" && sub === "clone") {
    const returned: Answer = { ...ok(), cloned: `github.com/${args[2] ?? ""} ${args[3] ?? ""}` };
    return returned;
  }
  if (verb === "api") {
    const returned: Answer = ghApi(model, sub ?? "", args);
    return returned;
  }
  if (verb === "repo" && sub === "view") {
    const repo = args[2] ?? "";
    const returned: Answer = (model.unreadable ?? []).includes(repo)
      ? no()
      : json({ nameWithOwner: repo, viewerDefaultMergeMethod: model.mergeMethod ?? "MERGE" });
    return returned;
  }
  const pullAt = (number: string | undefined) =>
    Option.getOrUndefined(
      Arr.findFirst(
        model.mrs,
        (one) => one.iid === number && one.project === `github.com/${flag(args, "--repo")}`,
      ),
    );
  if (verb === "pr" && sub === "view" && args.includes("--web")) {
    const returned: Answer = pullAt(args[2]) ? ok() : no();
    return returned;
  }
  if (verb === "pr" && sub === "review" && args.includes("--approve")) {
    const pull = pullAt(args[2]);
    if (pull === undefined || model.refusesApproval === true) {
      const returned: Answer = no();
      return returned;
    }
    const returned: Answer = {
      ...ok(),
      noted: { key: keyOf("github", pull), body: flag(args, "--body") ?? "" },
      approved: keyOf("github", pull),
    };
    return returned;
  }
  if (verb === "pr" && sub === "view") {
    const pull = pullAt(args[2]);
    if (pull === undefined) {
      const returned: Answer = no();
      return returned;
    }
    const returned: Answer = json({
      title: pull.title ?? "",
      state: Str.toUpperCase(pull.state),
      isDraft: pull.draft ?? false,
      author: { login: pull.author ?? "" },
      assignees: Arr.map(pull.assignees ?? [], (login) => ({ login })),
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
      statusCheckRollup: Arr.map(pull.checks ?? [], (check) => ({
        __typename: "CheckRun",
        name: check.name,
        detailsUrl: pull.checksUrl ?? null,
        status: check.state === "running" ? "QUEUED" : "COMPLETED",
        conclusion:
          check.state === "running" ? null : check.state === "passed" ? "SUCCESS" : "FAILURE",
      })),
    });
    return returned;
  }
  if (verb === "pr" && sub === "list" && args.includes("@me")) {
    const who = args.includes("--assignee") ? "--assignee" : "--author";
    const returned: Answer = json(
      Arr.map(
        Arr.filter(mine(model, who), (one) => one.project === `github.com/${flag(args, "--repo")}`),
        (one) => ({ number: Number(one.iid), title: one.title ?? "" }),
      ),
    );
    return returned;
  }
  if (verb === "pr" && sub === "list") {
    const repo = `github.com/${flag(args, "--repo")}`;
    const returned: Answer = json(
      Arr.map(
        Arr.filter(
          model.mrs,
          (one) =>
            one.project === repo &&
            (flag(args, "--state") === "all" || one.state === "open") &&
            one.sourceBranch === flag(args, "--head"),
        ),
        (one) => ({
          number: Number(one.iid),
          url: `https://${one.project}/pull/${one.iid}`,
          autoMergeRequest: one.autoMerge === true ? { enabledAt: "2026-10-01T00:00:00Z" } : null,
          state: Str.toUpperCase(one.state),
          createdAt: one.createdAt ?? "",
          mergedAt: one.mergedAt ?? null,
          // WARNING: GitHub stamps a merged pull request closed too.
          closedAt: one.closedAt ?? one.mergedAt ?? null,
        }),
      ),
    );
    return returned;
  }
  if (verb === "pr" && sub === "comment") {
    const pull = pullAt(args[2]);
    if (pull === undefined) {
      const returned: Answer = no();
      return returned;
    }
    const returned: Answer = {
      ...ok(),
      noted: { key: keyOf("github", pull), body: flag(args, "--body") ?? "" },
    };
    return returned;
  }
  const returned: Answer = no();
  return returned;
}

interface Answered {
  readonly ran: Ran;
  readonly model: ForgeModel;
}

export function answer(
  forge: MrForge,
  model: ForgeModel,
  cmd: string,
  args: ReadonlyArray<string>,
  under: Under,
) {
  if (cmd === "env" && args[0] === "-u") {
    let at = 0;
    while (args[at] === "-u") at += 2;
    const returned: Answered = answer(forge, model, args[at] ?? "", args.slice(at + 1), {
      ...under,
      environment: false,
    });
    return returned;
  }
  const cloning =
    cmd === "git" && args[0] === "clone" ? /^https:\/\/(.+)\.git$/.exec(args.at(-2) ?? "") : null;
  if (cloning) {
    const returned: Answered = {
      ran: ok().ran,
      model: { ...model, cloned: [...(model.cloned ?? []), `${cloning[1]} ${args.at(-1)}`] },
    };
    return returned;
  }
  if (cmd === "git") {
    const said =
      args[0] === "remote" && args[1] === "get-url"
        ? args[2] === "origin"
          ? model.origin
          : args[2] === "upstream"
            ? model.upstream
            : undefined
        : Arr.join(args, " ") === "rev-parse --abbrev-ref HEAD"
          ? model.branch
          : Arr.join(args, " ") === "symbolic-ref --quiet --short HEAD" && model.branch !== "HEAD"
            ? model.branch
            : undefined;
    const returned: Answered = {
      ran: said === undefined ? no().ran : ok(`${said}\n`).ran,
      model,
    };
    return returned;
  }
  if (cmd !== CLI[forge]) {
    const returned: Answered = { ran: no(127).ran, model };
    return returned;
  }
  if (model.installed && args[0] === (forge === "github" ? "pr" : "mr") && args[1] === "create") {
    const project =
      forge === "github" ? `github.com/${flag(args, "--repo")}` : (flag(args, "--repo") ?? "");
    const iid = String(Math.max(0, ...Arr.map(model.mrs, (one) => Number(one.iid))) + 1);
    const made: FakeMr = {
      project,
      iid,
      state: "open",
      title: flag(args, "--title") ?? "",
      body: flag(args, forge === "github" ? "--body" : "--description") ?? "",
      assignees: [flag(args, "--assignee") ?? ""],
      sourceBranch: flag(args, forge === "github" ? "--head" : "--source-branch") ?? "",
      targetBranch: flag(args, forge === "github" ? "--base" : "--target-branch") ?? "main",
    };
    const returned: Answered = {
      ran: ok(`https://${project}/${forge === "github" ? "pull" : "-/merge_requests"}/${iid}\n`)
        .ran,
      model: { ...model, mrs: [...model.mrs, made] },
    };
    return returned;
  }
  const said = forge === "gitlab" ? glab(model, args, under) : gh(model, args);
  let after = model;
  if (said.oauth !== undefined) after = { ...after, oauth: said.oauth };
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
  if (said.dismissed !== undefined)
    after = {
      ...after,
      approved: Arr.filter(after.approved ?? [], (one) => one !== said.dismissed),
    };
  if (said.retried !== undefined) {
    const { mr, at } = said.retried;
    after = {
      ...after,
      mrs: Arr.map(after.mrs, (one) =>
        one !== mr
          ? one
          : {
              ...one,
              jobs: Arr.map(one.jobs ?? [], (job, n) =>
                [at].flat().includes(n) ? retriedJob(job, n) : job,
              ),
            },
      ),
    };
  }
  if (said.pipelineStarted !== undefined) {
    const { sha, pipeline } = said.pipelineStarted;
    const on = after.pipelinesOn ?? {};
    after = { ...after, pipelinesOn: { ...on, [sha]: [...(on[sha] ?? []), pipeline] } };
  }
  if (said.replied !== undefined) {
    const { mr, thread, body } = said.replied;
    const key = keyOf(forge, mr);
    const replies = after.replies ?? {};
    const unthreaded: FakeComment = {
      id:
        Math.max(0, ...Arr.flatMap(after.mrs, (one) => Arr.map(one.comments ?? [], (c) => c.id))) +
        1,
      author: after.login ?? "",
      at: after.now ?? NOW,
      body,
    };
    const comment = thread === null ? unthreaded : { ...unthreaded, thread };
    after = {
      ...after,
      replies: {
        ...replies,
        [key]: [...(replies[key] ?? []), { thread, body }],
      },
      mrs: Arr.map(after.mrs, (one) =>
        one === mr ? { ...one, comments: [...(one.comments ?? []), comment] } : one,
      ),
    };
  }
  if (said.enqueued !== undefined) {
    const { mr, head } = said.enqueued;
    after = {
      ...after,
      enqueued: [...(after.enqueued ?? []), { key: keyOf(forge, mr), head }],
      mrs: Arr.map(after.mrs, (one) => (one === mr ? { ...one, queued: head } : one)),
    };
  }
  if (said.dequeued !== undefined) {
    const mr = said.dequeued;
    after = {
      ...after,
      dequeued: [...(after.dequeued ?? []), keyOf(forge, mr)],
      mrs: Arr.map(after.mrs, (one) => {
        if (one !== mr) return one;
        const { queued: _, ...rest } = one;
        return rest;
      }),
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
      mrs: Arr.map(after.mrs, (one) =>
        one === mr
          ? { ...one, state: "merged", mergedSha: mergeCommitOf(one), mergedBy: by, mergedAt: at }
          : one,
      ),
    };
  }
  const returned: Answered = { ran: said.ran, model: after };
  return returned;
}

export interface FakeRequest {
  readonly method: string;
  readonly url: string;
  readonly token: string;
  readonly body: Schema.Json | null;
}

const API = { gitlab: "/api/v4/", github: "/" } as const;
const GraphqlBody = Schema.fromJsonString(
  Schema.Struct({
    query: Schema.String,
    variables: Schema.optionalKey(
      Schema.Record(
        Schema.String,
        Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null]),
      ),
    ),
  }),
);

const graphqlFields = (body: RequestInit["body"]) => {
  const sent = Schema.decodeUnknownOption(GraphqlBody)(body);
  if (Option.isNone(sent)) return [];
  return [
    "-f",
    `query=${sent.value.query}`,
    ...Arr.flatMap(Rec.toEntries(sent.value.variables ?? {}), ([name, value]) =>
      value === null ? [] : ["-F", `${name}=${String(value)}`],
    ),
  ];
};

const bodyFields = (body: RequestInit["body"]) => {
  const read = Schema.decodeUnknownOption(
    Schema.fromJsonString(
      Schema.Record(
        Schema.String,
        Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Null]),
      ),
    ),
  )(body);
  return Option.isNone(read)
    ? []
    : Arr.flatMap(Rec.toEntries(read.value), ([name, value]) =>
        value === null ? [] : ["-f", `${name}=${String(value)}`],
      );
};

const Said = Schema.fromJsonString(Schema.Struct({ message: Schema.String }));

export function httpFace(
  forge: MrForge,
  state: {
    readonly read: Effect.Effect<ForgeModel>;
    readonly write: (next: ForgeModel) => Effect.Effect<void>;
  },
  requests: Array<FakeRequest>,
  aborted: Array<string>,
) {
  const answered = (status: number, body: string, headers: Record<string, string> = {}) =>
    new Response(body === "" ? null : body, {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  const respond = Effect.fn("forge.httpFace")(function* (input: string, init: RequestInit) {
    const method = Str.toUpperCase(init.method ?? "GET");
    const token = pipe(
      new Headers(init.headers).get("authorization") ?? "",
      Str.replace(/^Bearer /, ""),
    );
    requests.push({
      method,
      url: input,
      token,
      body:
        init.body === undefined
          ? null
          : yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json))(init.body).pipe(
              Effect.orDie,
            ),
    });
    const model = yield* state.read;
    const fault = model.httpFault;
    if (fault === "network") return yield* Effect.die(new TypeError("fetch failed"));
    if (fault === "hold")
      return yield* Effect.callback<Response>((resume) => {
        const abort = () => {
          aborted.push(input);
          resume(Effect.die(init.signal?.reason));
        };
        if (init.signal?.aborted) abort();
        else init.signal?.addEventListener("abort", abort);
      });
    if (fault !== undefined)
      return answered(
        fault.status,
        flow(
          Schema.encodeResult(Json),
          Result.getOrThrow,
        )({
          message: fault.message ?? String(fault.status),
        }),
        fault.headers,
      );
    const url = new URL(input);
    const host = forge === "github" ? FORGE_HOST.github : url.host;
    if (!model.loggedIn.includes(host) || model.revoked === true || token !== tokenOf(forge, model))
      return answered(401, `{"message":"401 Unauthorized"}`);
    const route = `${pipe(url.pathname, Str.slice(API[forge].length))}${url.search}`;
    const args =
      forge === "github"
        ? ["api", route, "-X", method, ...graphqlFields(init.body), ...bodyFields(init.body)]
        : ["api", "--hostname", host, "-X", method, ...bodyFields(init.body), route];
    const reachable = { ...model, installed: true };
    const now = yield* Clock.currentTimeMillis;
    const said = answer(forge, reachable, CLI[forge], args, { now, environment: true });
    if (said.model !== reachable) yield* state.write({ ...said.model, installed: model.installed });
    if (said.ran.code === 0) {
      const headers: Record<string, string> = {};
      const size = Number(url.searchParams.get("per_page"));
      const page = Number(url.searchParams.get("page") ?? "1");
      const items = Schema.decodeOption(Schema.fromJsonString(Schema.Array(Schema.Json)))(
        said.ran.stdout,
      );
      if (size > 0 && Option.isSome(items) && items.value.length === size) {
        url.searchParams.set("page", String(page + 1));
        headers.link = `<${url.toString()}>; rel="next"`;
      }
      return answered(said.ran.stdout === "" ? 204 : 200, said.ran.stdout, headers);
    }
    const status = Number(/^(\d{3})\b/.exec(said.ran.stderr ?? "")?.[1] ?? "404");
    return answered(
      status,
      yield* Schema.encodeEffect(Said)({ message: said.ran.stderr || `${status}` }).pipe(
        Effect.orDie,
      ),
    );
  });
  return (input: string, init: RequestInit = {}) => Effect.runPromise(respond(input, init));
}

export const cliFetch =
  (run: Runner) =>
  (input: string, init: RequestInit = {}) => {
    const returned: Promise<Response> = Effect.runPromise(
      Effect.gen(function* () {
        const url = new URL(input);
        const method = Str.toUpperCase(init.method ?? "GET");
        const github = url.host === "api.github.com";
        const route = `${pipe(url.pathname, Str.slice((github ? API.github : API.gitlab).length))}${url.search}`;
        const ran = github
          ? yield* run(
              "gh",
              ["api", route, "-X", method, ...graphqlFields(init.body), ...bodyFields(init.body)],
              ".",
            )
          : yield* run(
              "glab",
              ["api", "--hostname", url.host, "-X", method, ...bodyFields(init.body), route],
              ".",
            );
        if (ran.code === 0)
          return new Response(ran.stdout === "" ? null : ran.stdout, {
            status: ran.stdout === "" ? 204 : 200,
            headers: { "content-type": "application/json" },
          });
        const status = Number(/^(\d{3})\b/.exec(ran.stderr ?? "")?.[1] ?? "404");
        return new Response(
          yield* Schema.encodeEffect(Said)({ message: ran.stderr || `${status}` }).pipe(
            Effect.orDie,
          ),
          {
            status,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );
    return returned;
  };

export const forgeHttpOver = (run: Runner) => forgeHttpTest(run, cliFetch(run));

export const forgeHttpOnPath = Layer.unwrap(
  Effect.map(Effect.context<ChildProcessSpawner.ChildProcessSpawner>(), (spawner) =>
    forgeHttpOver((cmd, args, cwd) => shell(cmd, args, cwd).pipe(Effect.provideContext(spawner))),
  ),
);

export const runOnPath = <A, E>(
  effect: Effect.Effect<A, E, ForgeHttp | Scope.Scope | PlatformServices | Records>,
) => runEffect(effect.pipe(Effect.provide(Layer.fresh(forgeHttpOnPath))));

export function fakeForge(forge: MrForge, start: ForgeModel) {
  const calls: Array<string> = [];
  const environments: Array<RunnerEnv | undefined> = [];
  const requests: Array<FakeRequest> = [];
  const aborted: Array<string> = [];
  let model = start;
  const run: Runner = (cmd, args, _cwd, env) =>
    Effect.map(Clock.currentTimeMillis, (now) => {
      calls.push(Arr.join([cmd, ...args], " "));
      environments.push(env);
      const said = answer(forge, model, cmd, args, { now, environment: true });
      model = said.model;
      return said.ran;
    });
  const fetch = httpFace(
    forge,
    {
      read: Effect.sync(() => model),
      write: (next) =>
        Effect.sync(() => {
          model = next;
        }),
    },
    requests,
    aborted,
  );
  return {
    run,
    calls,
    environments,
    requests,
    aborted,
    fetch,
    layer: forgeHttpTest(run, fetch),
    model: () => model,
    set: (next: ForgeModel) => {
      model = next;
    },
  };
}

const glabEnvironment = Effect.gen(function* () {
  for (const name of ["GITLAB_TOKEN", "GITLAB_ACCESS_TOKEN", "OAUTH_TOKEN"])
    if ((yield* Config.String(name).pipe(Config.withDefault(""))) !== "") return true;
  return false;
}).pipe(Effect.orElseSucceed(() => false));

// WARNING: Readers in the host and CLI must see a complete model while another face replaces it.
let modelWrites = 0;
const writeModel = (file: string, model: ForgeModel) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const staged = `${file}.${process.pid}.${++modelWrites}.tmp`;
    yield* fs
      .writeFileString(staged, yield* Schema.encodeEffect(ModelJson)(model).pipe(Effect.orDie))
      .pipe(
        Effect.andThen(fs.rename(staged, file)),
        Effect.ensuring(fs.remove(staged).pipe(Effect.ignore)),
      );
  });

export const forgeBin = Effect.fn("forge.bin")(function* (
  forge: MrForge,
  file: string,
  args: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const model = yield* Schema.decodeEffect(ModelJson)(yield* fs.readFileString(file)).pipe(
    Effect.orDie,
  );
  yield* fs.writeFileString(`${file}.log`, `${Arr.join([CLI[forge], ...args], " ")}\n`, {
    flag: "a",
  });
  const said = answer(forge, model, CLI[forge], args, {
    now: yield* Clock.currentTimeMillis,
    environment: yield* glabEnvironment,
  });
  // WARNING: Writing back an unchanged model would undo a test's write that landed since the read.
  if (said.model !== model) yield* writeModel(file, said.model);
  return said.ran;
});

export const forgeOnPath = Effect.fn("forge.onPath")(function* (
  bin: FakeBin,
  forge: MrForge,
  model: ForgeModel,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(bin.dir, `${forge}.model.json`);
  yield* writeModel(file, model);
  const binary = yield* Config.String("COLLIE_TEST_FAKE_FORGE").pipe(Config.withDefault(""));
  const line = yield* forwarding(binary, [forge, file], ([, , ...args], env) =>
    recordStart(`forge ${forge}`, args).pipe(
      Effect.andThen(forgeBin(forge, file, args)),
      Effect.map(({ code, stdout }) => ({ code, stdout, stderr: "" })),
      Effect.provide(
        Layer.mergeAll(BunFileSystem.layer, ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
      ),
    ),
  );
  yield* bin.add(CLI[forge], line);
  const requests: Array<FakeRequest> = [];
  const face = httpFace(
    forge,
    {
      read: Effect.orDie(
        Effect.map(
          fs.readFileString(file),
          flow(Schema.decodeResult(ModelJson), Result.getOrThrow),
        ),
      ),
      write: (next) =>
        Effect.orDie(writeModel(file, next).pipe(Effect.provideService(FileSystem.FileSystem, fs))),
    },
    requests,
    [],
  );
  return {
    forge,
    face,
    requests: () => [...requests],
    holding: (next: ForgeModel) => ({
      path: file,
      text: flow(Schema.encodeResult(ModelJson), Result.getOrThrow)(next),
    }),
    set: (next: ForgeModel) =>
      writeModel(file, next).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
    model: () =>
      Effect.map(fs.readFileString(file), flow(Schema.decodeResult(ModelJson), Result.getOrThrow)),
    calls: () =>
      Effect.map(fs.readFileString(`${file}.log`).pipe(Effect.orElseSucceed(() => "")), (text) =>
        Arr.filter(Str.split(text, "\n"), Boolean),
      ),
  };
});

export const serveForges = (
  ...onPath: ReadonlyArray<{
    readonly forge: MrForge;
    readonly face: (input: string, init?: RequestInit) => Promise<Response>;
  }>
) =>
  Effect.map(
    Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          fetch: (request) => {
            const url = new URL(request.url);
            const [, apiHost = "", ...rest] = Str.split(url.pathname, "/");
            const forge = apiHost === "api.github.com" ? "github" : "gitlab";
            const face = Option.getOrUndefined(
              Arr.findFirst(onPath, (one) => one.forge === forge),
            )?.face;
            if (face === undefined) return new Response(null, { status: 404 });
            const body = request.body === null ? Promise.resolve(undefined) : request.text();
            return body.then((body) =>
              face(`https://${apiHost}/${Arr.join(rest, "/")}${url.search}`, {
                method: request.method,
                headers: request.headers,
                signal: request.signal,
                body,
              }),
            );
          },
        }),
      ),
      (server) => Effect.promise(() => server.stop(true)),
    ),
    (server) => `http://127.0.0.1:${server.port}`,
  );

export const storedAnswers = (
  stateDir: string,
  states: ReadonlyMap<string, MrState>,
  facts: ReadonlyMap<string, ForgeFacts> = new Map(),
  read = "2026-09-17T10:00:00Z",
) =>
  writeMrStates(
    stateDir,
    states,
    new Map(
      Arr.map([...states.keys()], (id) => [
        id,
        { checks: { state: "unknown" as const }, head: null, ...facts.get(id), read },
      ]),
    ),
  );
