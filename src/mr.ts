// What the MR step needs to know before it can run: whether GitLab is reachable
// at all, who to assign, which template to fill, and which Linear tickets this
// branch is answering. Push is this step's business and nothing else's.

import { Effect, FileSystem, Option, Path, Schema, Stream } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { YamlValue } from "./yaml";
import { isString } from "./schema";

export type Runner<R = never> = (
  cmd: string,
  args: string[],
  cwd: string,
) => Effect.Effect<{ code: number; stdout: string }, never, R>;

const UserJson = Schema.fromJsonString(Schema.Struct({ username: Schema.String }));
const IssueJson = Schema.fromJsonString(
  Schema.Struct({ issue: Schema.optionalKey(Schema.String) }),
);

export const MR_TEMPLATE = ".gitlab/merge_request_templates/default.md";

/** A Linear id, the shape it takes in a branch name, a URL, or an Output. */
const LINEAR_ID = /\b([A-Z][A-Z0-9]+-\d+)\b/g;

/**
 * An MR target names its project, not just its iid: reviewing or commenting on
 * someone else's merge request has to work from a directory that is not a
 * checkout of it, and every glab call then needs `--repo`.
 */
export interface MrRef {
  /** `host/group/project`, or null for an old target that only carried an iid. */
  project: string | null;
  iid: string;
}

/** `mr:gitlab.example.com/group/project!42`, or the bare `mr:42` that came before. */
export function parseMrTarget(target: string): MrRef | null {
  if (!target.startsWith("mr:")) return null;
  const rest = target.slice(3);
  const at = rest.lastIndexOf("!");
  if (at < 0) return /^\d+$/.test(rest) ? { project: null, iid: rest } : null;
  const iid = rest.slice(at + 1);
  if (!/^\d+$/.test(iid)) return null;
  const project = rest.slice(0, at);
  return { project: project === "" ? null : project, iid };
}

/**
 * What `branch:<base>...<head>` — or a bare `branch:<head>` — is pointed at. Null for a
 * target of any other kind, and empty for one that names nothing: a caller that has
 * somewhere else to look wants those told apart. A ref, not necessarily a branch —
 * `branch:main...HEAD` and a diff of two shas are both things a human may review — so
 * what a caller may do with it depends on what the caller wants it for.
 */
export function branchTargetHead(target: string): string | null {
  if (!target.startsWith("branch:")) return null;
  return target.slice("branch:".length).split("...").at(-1)?.trim() ?? "";
}

/** `https://host/group/project/-/merge_requests/7`, the way glab reports what it opened. */
export function parseMrUrl(url: string): MrRef | null {
  const m = /^https?:\/\/([^/\s]+)\/(.+?)\/-\/merge_requests\/(\d+)/.exec(url.trim());
  return m ? { project: `${m[1]}/${m[2]}`, iid: m[3]! } : null;
}

export type MrRole = "assignee" | "reviewer";

/**
 * Puts a user on the merge request in that role, next to whoever is there already.
 * Who ran this is a fact, so the engine records it itself rather than asking an agent to.
 */
export function addMrRole<R>(
  mr: MrRef,
  role: MrRole,
  who: string,
  cwd: string,
  run: Runner<R>,
): Effect.Effect<{ code: number; stdout: string }, never, R> {
  return run(
    "glab",
    ["mr", "update", mr.iid, ...repoArgs(mr.project), `--${role}`, `+${who}`],
    cwd,
  );
}

export function mrTarget(project: string | null, iid: string): string {
  return project ? `mr:${project}!${iid}` : `mr:${iid}`;
}

/** The glab arguments that point a command at a project rather than at the cwd. */
export function repoArgs(project: string | null): string[] {
  return project ? ["--repo", project] : [];
}

/** The host part of `host/group/project`, which is what glab authenticates against. */
export function hostOf(project: string | null): string | null {
  const host = project?.split("/")[0];
  return host && host.includes(".") ? host : null;
}

/**
 * `git@host:group/project.git` and `https://host/group/project.git` both name the
 * same project; either is what a bare iid or a branch's MR is resolved against.
 */
export function projectFromRemote(url: string): string | null {
  const text = url.trim();
  if (text === "") return null;
  const ssh = /^(?:ssh:\/\/)?(?:[^@\s]+@)?([^:/\s]+)[:/](.+?)(?:\.git)?$/.exec(
    text.replace(/^https?:\/\//, ""),
  );
  if (!ssh) return null;
  const [, host = "", path = ""] = ssh;
  if (!host.includes(".") || path === "") return null;
  return `${host}/${path.replace(/^\/+/, "").replace(/\.git$/, "")}`;
}

/**
 * Runs a command and reports what it said, never failing: a missing executable comes
 * back as exit 127 with no output, which is what lets callers treat "no glab here" as
 * an answer rather than an error.
 */
export function shell(
  cmd: string,
  args: string[],
  cwd: string,
  /**
   * `"say"` folds stderr into the output. Inference wants it ignored — a probe that
   * fails is an answer, and its noise is not — but a command a human asked for owes
   * them the reason it failed.
   */
  errors: "ignore" | "say" = "ignore",
): Effect.Effect<{ code: number; stdout: string }, never, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = ChildProcess.make(cmd, args, {
      cwd,
      stdout: "pipe",
      stderr: errors === "say" ? "pipe" : "ignore",
      // extendEnv, so git and glab inherit this process's environment and find their
      // config and credentials — the Effect-native spelling of `{ ...process.env }`.
      extendEnv: true,
    });
    const handle = yield* spawner.spawn(command);
    const text = (stream: typeof handle.stdout) =>
      stream.pipe(
        Stream.decodeText(),
        Stream.runFold(
          () => "",
          (out, chunk) => out + chunk,
        ),
      );
    const [stdout, stderr, code] = yield* Effect.all(
      [
        text(handle.stdout),
        errors === "say" ? text(handle.stderr) : Effect.succeed(""),
        handle.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    return { code: Number(code), stdout: stdout + stderr };
  }).pipe(
    Effect.scoped,
    Effect.catch(() => Effect.succeed({ code: 127, stdout: "" })),
  );
}

/** The project this checkout pushes to, or null when there is no GitLab remote. */
export function projectHere<R>(
  cwd: string,
  run: Runner<R>,
): Effect.Effect<string | null, never, R> {
  return Effect.gen(function* () {
    for (const remote of ["origin", "upstream"]) {
      const url = yield* run("git", ["remote", "get-url", remote], cwd);
      if (url.code !== 0) continue;
      const project = projectFromRemote(url.stdout);
      if (project) return project;
    }
    return null;
  });
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
const optionalStatus = Schema.optionalKey(Schema.NullOr(Schema.Struct({ status: optionalText })));

const MrDetailsJson = Schema.fromJsonString(
  Schema.Struct({
    iid: Schema.optionalKey(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
    title: optionalText,
    state: optionalText,
    draft: optionalFlag,
    work_in_progress: optionalFlag,
    author: Schema.optionalKey(Schema.NullOr(Schema.Struct({ username: optionalText }))),
    source_branch: optionalText,
    target_branch: optionalText,
    sha: optionalText,
    updated_at: optionalText,
    web_url: optionalText,
    head_pipeline: optionalStatus,
    pipeline: optionalStatus,
    blocking_discussions_resolved: optionalFlag,
    user_notes_count: optionalCount,
    approvals_required: optionalCount,
    approvals_left: optionalCount,
  }),
);

/**
 * The merge request behind a review, as the app's panel shows it. Every field but the
 * iid is optional on the wire — glab's shape varies with the GitLab version and what
 * the token may see — so a field nobody answered renders as unknown rather than
 * taking the panel down.
 */
export interface MrDetails {
  _tag: "Details";
  iid: string;
  project: string | null;
  title: string;
  /** `opened`, `merged`, `closed`, or `draft` where the MR says it is one. */
  state: string;
  author: string;
  sourceBranch: string;
  targetBranch: string;
  /** The head pipeline's status, or `""` when there is no pipeline to report. */
  pipeline: string;
  /** Phrased, because "2" alone does not say whether that is good. */
  approvals: string;
  /** Whether a discussion is still blocking, which is the one a reviewer chases. */
  unresolved: boolean;
  notes: number;
  /** Seven characters: enough to tell two heads apart, short enough to read. */
  headSha: string;
  /** When GitLab last saw it change, in epoch milliseconds, or 0 when it did not say. */
  updatedAt: number;
  url: string;
}

/** Why the panel has nothing to show — one line, and nothing else in the panel breaks. */
export interface MrUnavailable {
  _tag: "Unavailable";
  reason: string;
}

export type MrPanel = MrDetails | MrUnavailable;

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

    const where = ref.project ? `${ref.project}!${ref.iid}` : `!${ref.iid}`;
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
    const updated = mr.updated_at ? Date.parse(mr.updated_at) : Number.NaN;
    return {
      _tag: "Details",
      iid: mr.iid === undefined || mr.iid === null ? ref.iid : String(mr.iid),
      project: ref.project,
      title: mr.title ?? "",
      state: draft ? "draft" : (mr.state ?? ""),
      author: mr.author?.username ?? "",
      sourceBranch: mr.source_branch ?? "",
      targetBranch: mr.target_branch ?? "",
      pipeline: mr.head_pipeline?.status ?? mr.pipeline?.status ?? "",
      approvals: approvalsLine(mr.approvals_required, mr.approvals_left),
      unresolved: mr.blocking_discussions_resolved === false,
      notes: mr.user_notes_count ?? 0,
      headSha: (mr.sha ?? "").slice(0, 7),
      updatedAt: Number.isFinite(updated) ? updated : 0,
      url: mr.web_url ?? "",
    } satisfies MrDetails;
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

/**
 * The line that decides whether to look again: has this merge request moved since the
 * review finished. GitLab's `updated_at` is what answers it in the one call the panel
 * makes — a commit count would need a second, and "has anything moved" is the question
 * a human actually has.
 */
export function sinceReview(details: MrDetails, reviewedAt: number): string {
  if (reviewedAt <= 0 || details.updatedAt <= 0) return "";
  if (details.updatedAt <= reviewedAt) return "nothing has moved since this review";
  const hours = Math.round((details.updatedAt - reviewedAt) / 3_600_000);
  const when = hours < 1 ? "since" : `${hours}h after`;
  return `changed ${when} this review — head ${details.headSha}`;
}

export interface Readiness {
  ok: boolean;
  /** Why not, phrased for the runner's skip note. */
  reason: string;
}

export interface MrFacts {
  /** The GitLab username the MR is assigned to, or null when it could not be resolved. */
  assignee: string | null;
  /** Path of the repo's MR template, relative to the repo, or null when it has none. */
  template: string | null;
  /** Linear ids this branch answers, deduplicated, in the order they were found. */
  issues: string[];
}

/** glab has to exist and the repo has to actually be on GitLab. */
export function gitlabReadiness<R>(
  cwd: string,
  run: Runner<R>,
): Effect.Effect<Readiness, never, R> {
  return Effect.gen(function* () {
    const glab = yield* run("glab", ["--version"], cwd);
    if (glab.code !== 0) return { ok: false, reason: "glab is not installed" };

    const remotes = yield* run("git", ["remote", "-v"], cwd);
    if (remotes.code !== 0 || remotes.stdout.trim() === "") {
      return { ok: false, reason: "this repo has no remote" };
    }
    if (!/gitlab/i.test(remotes.stdout)) return { ok: false, reason: "no GitLab remote" };
    return { ok: true, reason: "" };
  });
}

/**
 * What a step pointed at someone else's merge request needs: glab, and glab logged
 * in to that host. The cwd's remotes are none of its business — the whole point of
 * carrying the project is that no checkout is required.
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
    if (!host) {
      // No project to check against: fall back to what this directory can prove.
      return yield* gitlabReadiness(cwd, run);
    }
    const auth = yield* run("glab", ["auth", "status", "--hostname", host], cwd);
    return auth.code === 0
      ? { ok: true, reason: "" }
      : { ok: false, reason: `glab is not logged in to ${host}` };
  });
}

/** The configured assignee wins; otherwise whoever glab is logged in as. */
export function resolveAssignee<R>(
  cwd: string,
  configured: YamlValue | undefined,
  run: Runner<R>,
): Effect.Effect<string | null, never, R> {
  return Effect.gen(function* () {
    if (configured !== undefined && isString(configured) && configured.trim() !== "")
      return configured.trim();
    const me = yield* run("glab", ["api", "user"], cwd);
    if (me.code !== 0) return null;
    return Option.match(Schema.decodeUnknownOption(UserJson)(me.stdout), {
      onNone: () => null,
      onSome: (user) => (user.username === "" ? null : user.username),
    });
  });
}

export function templateFile(
  cwd: string,
): Effect.Effect<string | null, PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    return (yield* fs.exists(pathService.join(cwd, MR_TEMPLATE))) ? MR_TEMPLATE : null;
  });
}

/**
 * Every Linear ticket this branch could be answering: the work source when the
 * human named one, the branch name, and whatever a `plan` run put on the board.
 */
export function linearIssues<R>(
  opts: { cwd: string; inputs: Record<string, string>; planInput?: string },
  run: Runner<R>,
): Effect.Effect<string[], PlatformError, FileSystem.FileSystem | Path.Path | R> {
  return Effect.gen(function* () {
    const found: string[] = [];
    const add = (id: string) => {
      const up = id.toUpperCase();
      if (!found.includes(up)) found.push(up);
    };

    const plan = opts.planInput ?? "plan";
    if (opts.inputs[`${plan}_kind`] === "linear") {
      for (const id of matchAll(opts.inputs[plan] ?? "")) add(id);
    }

    const branch = yield* run("git", ["rev-parse", "--abbrev-ref", "HEAD"], opts.cwd);
    for (const id of matchAll(branch.stdout)) add(id);

    if (opts.inputs[`${plan}_kind`] === "plan-dir") {
      for (const id of yield* offloadedIssues(opts.inputs[plan] ?? "")) add(id);
    }
    return found;
  });
}

function matchAll(text: string): string[] {
  return [...text.matchAll(LINEAR_ID)].map((m) => m[1]!);
}

/**
 * A `plan` run that took "Offload to Linear" wrote the issue id into that choice's
 * Output. The plan dir is inside the run dir, so the outputs are one level up.
 */
function offloadedIssues(
  planDir: string,
): Effect.Effect<string[], PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const runDir = pathService.dirname(planDir);
    if (planDir === "" || !(yield* fs.exists(pathService.join(runDir, "run.json")))) return [];
    const out: string[] = [];
    for (const file of yield* jsonFiles(pathService.join(runDir, "steps"))) {
      const text = yield* fs
        .readFileString(file, "utf8")
        .pipe(Effect.catch(() => Effect.succeed("")));
      const parsed = Schema.decodeUnknownOption(IssueJson)(text);
      if (Option.isSome(parsed) && parsed.value.issue !== undefined)
        out.push(...matchAll(parsed.value.issue));
    }
    return out;
  });
}

function jsonFiles(
  dir: string,
  depth = 0,
): Effect.Effect<string[], PlatformError, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    if (depth > 3 || !(yield* fs.exists(dir))) return [];
    const out: string[] = [];
    const names = yield* fs.readDirectory(dir).pipe(Effect.catch(() => Effect.succeed([])));
    for (const name of names) {
      const file = pathService.join(dir, name);
      const info = yield* fs.stat(file).pipe(Effect.option);
      if (Option.isNone(info)) {
        // Raced with a step writing its Output; the next run will see it.
        continue;
      }
      if (info.value.type === "Directory") out.push(...(yield* jsonFiles(file, depth + 1)));
      else if (name.endsWith(".json")) out.push(file);
    }
    return out;
  });
}

export function mrFacts<R>(
  opts: {
    cwd: string;
    inputs: Record<string, string>;
    configuredAssignee?: YamlValue;
    planInput?: string;
  },
  run: Runner<R>,
): Effect.Effect<MrFacts, PlatformError, FileSystem.FileSystem | Path.Path | R> {
  return Effect.gen(function* () {
    return {
      assignee: yield* resolveAssignee(opts.cwd, opts.configuredAssignee, run),
      template: yield* templateFile(opts.cwd),
      issues: yield* linearIssues(opts, run),
    };
  });
}
