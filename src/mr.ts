// What the MR step needs to know before it can run: whether its forge is reachable
// at all, who to assign, which template to fill, and which Linear tickets this
// branch is answering. Push is this step's business and nothing else's.

import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { pipe as pipe_ } from "effect/Function";
import { Effect, FileSystem, Option, Path, Redacted, Stream } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { YamlValue } from "./yaml";
import { isString } from "./schema";
import { targetKind, workSourceOf, type Settled } from "./strategies";
import {
  type MrDetails,
  type MrForge,
  type MrRef,
  mrPath,
  mrTarget,
  parseMrTarget,
} from "./board-model";
import { FORGES, forgeOf, forgeOfHost, type Forge } from "./forge/forge";
import type { ForgeHttp } from "./forge/http";
import type { MrReady, Posted } from "./sdk";

/** Variables a command gets on top of this process's environment. */
export type RunnerEnv = Record<string, string | Redacted.Redacted<string>>;

export type Runner<R = never> = (
  cmd: string,
  args: string[],
  cwd: string,
  env?: RunnerEnv,
) => Effect.Effect<Ran, never, R>;

/** What a command said. `stderr` is optional so fakes may omit it; real runners always fill it. */
export interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr?: string;
}

/** What a command told a human — its stdout, then its stderr. An answer is read from `stdout` alone. */
export function whatItSaid(result: Ran): string {
  return Arr.join(
    Arr.filter(
      [
        Str.trim(result.stdout),
        Option.getOrUndefined(
          Option.map(Option.fromNullishOr(result.stderr), (present) => Str.trim(present)),
        ) ?? "",
      ],
      Boolean,
    ),
    "\n",
  );
}

/**
 * Makes `helper` the checkout's only credential helper for `host`: the empty entry before
 * it drops any helper git read from a wider config. Setting it again changes nothing.
 */
export const keepCredentialHelper = Effect.fn("mr.keepCredentialHelper")(function* <R>(
  checkout: string,
  host: string,
  helper: string,
  run: Runner<R>,
) {
  const key = `credential.https://${host}.helper`;
  yield* run("git", ["config", "--local", "--unset-all", key], checkout);
  for (const value of ["", helper]) {
    const set = yield* run("git", ["config", "--local", "--add", key, value], checkout);
    if (set.code !== 0) return { ok: false, reason: whatItSaid(set) || `git could not set ${key}` };
  }
  return { ok: true, reason: "" };
});

/** A Linear id, the shape it takes in a branch name, a URL, or an Output. */
const LINEAR_ID = /\b([A-Z][A-Z0-9]+-\d+)\b/g;

/**
 * What `branch:<base>...<head>` — or a bare `branch:<head>` — is pointed at. Null for a
 * target of any other kind, and empty for one that names nothing: a caller that has
 * somewhere else to look wants those told apart. A ref, not necessarily a branch —
 * `branch:main...HEAD` and a diff of two shas are both things a human may review — so
 * what a caller may do with it depends on what the caller wants it for.
 */
export function branchTargetHead(target: string): string | null {
  if (!pipe_(target, Str.startsWith("branch:"))) return null;
  return (
    Option.getOrUndefined(
      Option.map(
        Option.fromNullishOr(Str.split(pipe_(target, Str.slice("branch:".length)), "...").at(-1)),
        (present_) => Str.trim(present_),
      ),
    ) ?? ""
  );
}

/**
 * Whether this merge request is already `who`'s to get merged.
 *
 * GitLab keeps assignee and reviewer apart because they are two jobs: one person owns
 * landing the change, another says whether it should land. The same name in both roles is
 * a review nobody independent is doing — so where the answer here is yes, Collie reviews
 * for the human rather than at them: the findings are fixed here and nothing is posted.
 *
 * An unreadable merge request answers no. The costly mistake is the other one: staying
 * quiet about someone else's change because glab had a bad minute.
 */
export function assignedTo<R>(
  mr: MrRef,
  who: string,
  cwd: string,
  run: Runner<R>,
): Effect.Effect<boolean, never, R | ForgeHttp> {
  return Effect.gen(function* () {
    const panel = yield* forgeOf(mr).details(mr, cwd, run);
    return panel._tag === "Details" && panel.assignees.includes(who);
  });
}

/**
 * A review on the merge request it is about, as one note that Collie sends.
 *
 * Every refusal is the message rather than an error: a target that is not a merge
 * request, a GitLab this machine cannot reach, and — the one worth saying out loud — a
 * merge request assigned to whoever is running this, whose findings are theirs to fix
 * rather than to write to themselves.
 */
export function postNote<R>(
  options: {
    readonly target: string;
    readonly cwd: string;
    readonly body: string;
    /** Approve it too, which a review with nothing live left asks for. */
    readonly approve?: boolean;
    /** The Flock's GitLab, which is GitLab whatever its name. */
    readonly gitlabHost?: string;
  },
  run: Runner<R>,
): Effect.Effect<Posted, never, R | ForgeHttp> {
  return Effect.gen(function* () {
    const mr = parseMrTarget(options.target);
    if (!mr)
      return { ok: false, message: `${options.target || "this run"} is not a merge request` };
    const here =
      mr.project === null
        ? yield* forgeHere(options.cwd, run, options.gitlabHost)
        : { ok: true as const, forge: forgeOf(mr) };
    if (!here.ok) return { ok: false, message: here.reason };
    if (here.forge.name !== forgeOf(mr).name)
      return {
        ok: false,
        message: `${options.target} is a GitLab target, but this checkout is on GitHub`,
      };
    const forge = here.forge;
    const ready = yield* forge.ready(mr.project, options.cwd, run);
    if (!ready.ok) return { ok: false, message: ready.reason };
    const me = yield* forge.login(options.cwd, run, mr.project);
    if (me !== null && (yield* assignedTo(mr, me, options.cwd, run))) {
      return {
        ok: false,
        message: `${options.target} is assigned to you, so its findings are yours to fix rather than to post`,
      };
    }
    return yield* forge.post(mr, options.body, options.approve === true, options.cwd, run);
  });
}

export { mrTarget, targetKind };

/**
 * `git@host:group/project.git` and `https://host/group/project.git` both name the
 * same project; either is what a bare iid or a branch's MR is resolved against.
 */
export function projectFromRemote(url: string): string | null {
  const text = Str.trim(url);
  if (text === "") return null;
  const ssh = /^(?:ssh:\/\/)?(?:[^@\s]+@)?([^:/\s]+)[:/](.+?)(?:\.git)?$/.exec(
    pipe_(text, Str.replace(/^https?:\/\//, "")),
  );
  if (!ssh) return null;
  const [, host = "", path = ""] = ssh;
  if (!pipe_(host, Str.includes(".")) || path === "") return null;
  return `${host}/${pipe_(path, Str.replace(/^\/+/, ""), Str.replace(/\.git$/, ""))}`;
}

/**
 * Runs a command and reports what it said, never failing: a command that could not start
 * comes back as exit 127 with why on stderr, which is what lets callers treat "no glab
 * here" as an answer rather than an error.
 */
export function shell(
  cmd: string,
  args: string[],
  cwd: string,
  env?: RunnerEnv,
): Effect.Effect<Ran, never, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = ChildProcess.make(cmd, args, {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
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
      [text(handle.stdout), text(handle.stderr), handle.exitCode],
      { concurrency: "unbounded" },
    );
    return { code: Number(code), stdout, stderr };
  }).pipe(
    Effect.scoped,
    Effect.catch((cause) => Effect.succeed({ code: 127, stdout: "", stderr: String(cause) })),
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
/** A checkout's forge and the project it pushes to, or why it has none. */
export type ForgeHere =
  | { readonly ok: true; readonly forge: Forge; readonly project: string }
  | { readonly ok: false; readonly reason: string };

/** The forge of the checkout at `cwd`: its `origin`'s host, else `upstream`'s (ADR-0050 D2). */
export function forgeHere<R>(
  cwd: string,
  run: Runner<R>,
  gitlabHost?: string,
): Effect.Effect<ForgeHere, never, R> {
  return Effect.map(projectHere(cwd, run), (project): ForgeHere => {
    if (project === null) return { ok: false, reason: "this repo has no remote" };
    const host = Str.split(project, "/")[0]!;
    const name = forgeOfHost(host, gitlabHost);
    return name === null
      ? { ok: false, reason: `${host} is neither GitHub nor GitLab` }
      : { ok: true, forge: FORGES[name], project };
  });
}

/** Whether the forge shows production carrying `sha`: false where it cannot say. */
export function productionCarries<R>(
  cwd: string,
  sha: string,
  run: Runner<R>,
  gitlabHost?: string,
): Effect.Effect<boolean, never, R | ForgeHttp> {
  return Effect.gen(function* () {
    const here = yield* forgeHere(cwd, run, gitlabHost);
    if (!here.ok) return false;
    const ref = { project: here.project, iid: "" };
    return (yield* here.forge.liveTier(ref, sha, cwd, run)) === "production";
  });
}

/**
 * The URL of the checkout's branch's open merge request where it merges itself once green,
 * else null. A checkout on no forge has none to merge; a forge that cannot be read fails with
 * why, since a push is safe only once it has said no.
 */
export function autoMergingHere<R>(
  cwd: string,
  run: Runner<R>,
  gitlabHost?: string,
): Effect.Effect<string | null, string, R | ForgeHttp> {
  return Effect.gen(function* () {
    const here = yield* forgeHere(cwd, run, gitlabHost);
    if (!here.ok) return null;
    const branch = Str.trim((yield* run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd)).stdout);
    if (branch === "HEAD" || branch === "") return null;
    const found = yield* here.forge.forBranch(here.project, branch, cwd, run);
    if (!found.ok) return yield* Effect.fail(found.reason);
    return found.open?.autoMerge === true ? found.open.url : null;
  });
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

/** The configured assignee wins; otherwise whoever the forge's CLI is logged in as. */
export function resolveAssignee<R>(
  cwd: string,
  configured: YamlValue | undefined,
  forge: Forge,
  run: Runner<R>,
  project: string | null = null,
): Effect.Effect<string | null, never, R | ForgeHttp> {
  return Effect.gen(function* () {
    if (configured !== undefined && isString(configured) && Str.trim(configured) !== "")
      return Str.trim(configured);
    return yield* forge.login(cwd, run, project);
  });
}

/**
 * Every Linear ticket this branch could be answering: the work source when the
 * human named one, and the branch name.
 */
export function linearIssues<R>(
  opts: { cwd: string } & Settled,
  run: Runner<R>,
): Effect.Effect<string[], never, R> {
  return Effect.gen(function* () {
    const found: string[] = [];
    const add = (id: string) => {
      const up = Str.toUpperCase(id);
      if (!found.includes(up)) found.push(up);
    };

    const work = workSourceOf(opts);
    if (work?.kind === "linear") for (const id of matchAll(work.value)) add(id);

    const branch = yield* run("git", ["rev-parse", "--abbrev-ref", "HEAD"], opts.cwd);
    for (const id of matchAll(branch.stdout)) add(id);
    return found;
  });
}

function matchAll(text: string): string[] {
  return Arr.map([...pipe_(text, Str.matchAll(LINEAR_ID))], (m) => m[1]!);
}

/** The forge this branch pushes to, and the facts its delivery prompt needs. */
export function prepareMergeRequest<R>(
  opts: {
    readonly cwd: string;
    readonly target?: string;
    readonly source?: { readonly value: string; readonly kind: string };
    /** `<forge>.assignee` from the user's config, by forge: one forge's never answers for another. */
    readonly assignees?: Partial<Record<MrForge, YamlValue>>;
    /** The Flock's GitLab, which is GitLab whatever its name. */
    readonly gitlabHost?: string;
  },
  run: Runner<R>,
): Effect.Effect<MrReady, PlatformError, FileSystem.FileSystem | Path.Path | R | ForgeHttp> {
  return Effect.gen(function* () {
    const unavailable = (reason: string): MrReady => ({
      ok: false,
      reason,
      assignee: "",
      template: "",
      issues: [],
    });
    const ref = opts.target === undefined ? null : parseMrTarget(opts.target);
    const here =
      ref?.project != null
        ? { ok: true as const, forge: forgeOf(ref), project: ref.project }
        : yield* forgeHere(opts.cwd, run, opts.gitlabHost);
    if (!here.ok) return unavailable(here.reason);
    if (ref !== null && here.forge.name !== forgeOf(ref).name)
      return unavailable(`${opts.target} is a GitLab target, but this checkout is on GitHub`);
    const { forge, project } = here;
    const ready = yield* forge.ready(project, opts.cwd, run);
    if (!ready.ok) return unavailable(ready.reason);
    const assignee = yield* resolveAssignee(
      opts.cwd,
      opts.assignees?.[forge.name],
      forge,
      run,
      project,
    );
    if (assignee === null && forge.name === "github")
      return unavailable("gh did not report a GitHub login");
    const branch = Str.trim(
      (yield* run("git", ["rev-parse", "--abbrev-ref", "HEAD"], opts.cwd)).stdout,
    );
    // A detached checkout, as renovate's is, is on no branch to have a merge request.
    const found =
      branch === "HEAD" || branch === ""
        ? { ok: true as const, open: null }
        : yield* forge.forBranch(project, branch, opts.cwd, run);
    if (!found.ok) return unavailable(found.reason);
    const work = {
      cwd: opts.cwd,
      inputs: { source: opts.source?.value ?? "", source_kind: opts.source?.kind ?? "" },
      strategies: { source: "work-source" },
    };
    return {
      ok: true,
      reason: "",
      provider: forge.name,
      repository: mrPath({ project, iid: "" }),
      assignee: assignee ?? "",
      template: (yield* forge.template(opts.cwd)) ?? "",
      issues: yield* linearIssues(work, run),
      forge: forge.display,
      noun: forge.noun,
      url: forge.webUrl(project),
      branch: branch === "HEAD" ? "" : branch,
      existing: found.open?.url ?? "",
      autoMerge: found.open?.autoMerge ?? false,
      commands: forge.commands({
        project,
        branch,
        assignee: assignee ?? "",
        existing: found.open?.iid ?? null,
      }),
    };
  });
}
