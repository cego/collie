import * as Str from "effect/String";
import * as Arr from "effect/Array";
import { pipe as pipe_ } from "effect/Function";
import type { FileSystem, Path, Redacted } from "effect";
import { Effect, Option, Stream } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { YamlValue } from "./yaml";
import { isString } from "./schema";
import { targetKind, workSourceOf } from "./strategies";
import type { Settled } from "./strategies";
import { mrId, mrPath, mrTarget, parseMrTarget, readMrRef } from "./board-model";
import type { MrDetails, MrForge, MrRef } from "./board-model";
import { FORGES, forgeOf, forgeOfHost } from "./forge/forge";
import type { Forge } from "./forge/forge";
import type { ForgeHttp } from "./forge/http";
import type { MrReady, Posted } from "./sdk";
import { waitingForIO } from "./foreground";
import type { ParkCause } from "./park-cause";

export type RunnerEnv = Record<string, string | Redacted.Redacted<string>>;

export type Runner<R = never> = (
  cmd: string,
  args: Array<string>,
  cwd: string,
  env?: RunnerEnv,
) => Effect.Effect<Ran, never, R>;

export interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr?: string;
}

export function whatItSaid(result: Ran) {
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

// WARNING: the empty helper entry first drops any helper git read from a wider config; setting it again changes nothing.
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

const LINEAR_ID = /\b([A-Z][A-Z0-9]+-\d+)\b/g;

// WARNING: null for a target that is not a branch, empty for one naming none: callers must tell them apart.
export function branchTargetHead(target: string) {
  if (!pipe_(target, Str.startsWith("branch:"))) {
    const returned: string | null = null;
    return returned;
  }
  const returned: string | null =
    Option.getOrUndefined(
      Option.map(
        Option.fromNullishOr(Str.split(pipe_(target, Str.slice("branch:".length)), "...").at(-1)),
        (present_) => Str.trim(present_),
      ),
    ) ?? "";
  return returned;
}

// WARNING: an unreadable merge request answers no: staying quiet on someone else's change is the costlier mistake.
export function assignedTo<R>(mr: MrRef, who: string, cwd: string, run: Runner<R>) {
  const returned: Effect.Effect<boolean, never, R | ForgeHttp> = Effect.gen(function* () {
    const panel = yield* forgeOf(mr).details(mr, cwd, run);
    return panel._tag === "Details" && panel.assignees.includes(who);
  });
  return returned;
}

export function postNote<R>(
  options: {
    readonly target: string;
    readonly cwd: string;
    readonly body: string;
    readonly review?: { readonly runId: string; readonly head: string; readonly round: number };
    // WARNING: this host is GitLab whatever its name, so the forge is never read from the host name.
    readonly gitlabHost?: string;
  },
  run: Runner<R>,
) {
  const returned: Effect.Effect<Posted, never, R | ForgeHttp> = Effect.gen(function* () {
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
    let body = options.body;
    if (options.review !== undefined) {
      const { runId, head, round } = options.review;
      if (me === null || head === "")
        return {
          ok: false,
          message: `could not sign the review: the forge did not report the login and reviewed head`,
        };
      const signature = `<!-- collie:${runId} round ${round} at ${head} by ${me} -->`;
      const found = yield* forge.findNote(mr, signature, options.cwd, run);
      if (!found.ok)
        return {
          ok: false,
          message: `could not read the review before posting: ${found.reason}`,
        };
      if (found.value)
        return { ok: true, message: `posted the review to ${options.target}`, signature };
      const current = yield* forge.details(mr, options.cwd, run);
      if (current._tag !== "Details")
        return {
          ok: false,
          message: `could not read ${options.target} before posting: ${current.reason}`,
        };
      if (!["open", "opened", "draft"].includes(current.state) || current.head !== head)
        return {
          ok: false,
          message: `${options.target} is no longer open at ${head}; no review posted`,
        };
      body = `Review at ${head}\n\n${Str.trimEnd(body)}\n\n${signature}`;
      const posted = yield* forge.post(mr, body, options.cwd, run);
      return posted.ok ? { ...posted, signature } : posted;
    }
    return yield* forge.post(mr, body, options.cwd, run);
  });
  return returned;
}

export { mrTarget, targetKind };

export function projectFromRemote(url: string) {
  const text = Str.trim(url);
  if (text === "") {
    const returned: string | null = null;
    return returned;
  }
  const ssh = /^(?:ssh:\/\/)?(?:[^@\s]+@)?([^:/\s]+)[:/](.+?)(?:\.git)?$/.exec(
    pipe_(text, Str.replace(/^https?:\/\//, "")),
  );
  if (!ssh) {
    const returned: string | null = null;
    return returned;
  }
  const [, host = "", path = ""] = ssh;
  if (!pipe_(host, Str.includes(".")) || path === "") {
    const returned: string | null = null;
    return returned;
  }
  const returned: string | null =
    `${host}/${pipe_(path, Str.replace(/^\/+/, ""), Str.replace(/\.git$/, ""))}`;
  return returned;
}

// WARNING: a command that cannot start exits 127 with why on stderr; it never throws, so no glab is an answer.
export function shell(cmd: string, args: Array<string>, cwd: string, env?: RunnerEnv) {
  const returned: Effect.Effect<Ran, never, ChildProcessSpawner.ChildProcessSpawner> = Effect.gen(
    function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const command = ChildProcess.make(cmd, args, {
        cwd,
        // WARNING: optional locks off, so a status does not hold index.lock and refuse a commit an agent makes meanwhile.
        env: cmd === "git" ? { GIT_OPTIONAL_LOCKS: "0", ...env } : env,
        stdout: "pipe",
        stderr: "pipe",
        // WARNING: extendEnv keeps this process's environment, which git and glab need to find their config and credentials.
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
    },
  ).pipe(
    Effect.scoped,
    waitingForIO,
    Effect.catch((cause) => Effect.succeed({ code: 127, stdout: "", stderr: String(cause) })),
  );
  return returned;
}

export function projectHere<R>(cwd: string, run: Runner<R>) {
  const returned: Effect.Effect<string | null, never, R> = Effect.gen(function* () {
    for (const remote of ["origin", "upstream"]) {
      const url = yield* run("git", ["remote", "get-url", remote], cwd);
      if (url.code !== 0) continue;
      const project = projectFromRemote(url.stdout);
      if (project) return project;
    }
    return null;
  });
  return returned;
}
export function mrIdIn<R>(mr: string, cwd: string, run: Runner<R>) {
  const returned: Effect.Effect<string | null, never, R> = Effect.gen(function* () {
    const id = mrId(mr);
    if (id !== null) return id;
    const said = Str.trim(mr);
    if (readMrRef(said, { project: null }) === null && readMrRef(`mr:${said}`) === null)
      return null;
    const known = checkouts.get(cwd);
    const project = known ?? (yield* projectHere(cwd, run));
    if (project !== null) checkouts.set(cwd, project);
    return mrId(mr, { project });
  });
  return returned;
}

const checkouts = new Map<string, string>();

export type ForgeHere =
  | { readonly ok: true; readonly forge: Forge; readonly project: string }
  | { readonly ok: false; readonly reason: string };

export function forgeHere<R>(cwd: string, run: Runner<R>, gitlabHost?: string) {
  const answer: Effect.Effect<ForgeHere, never, R> = Effect.map(
    projectHere(cwd, run),
    (project) => {
      if (project === null) {
        const returned: ForgeHere = { ok: false, reason: "this repo has no remote" };
        return returned;
      }
      const host = Str.split(project, "/")[0]!;
      const name = forgeOfHost(host, gitlabHost);
      {
        const returned: ForgeHere =
          name === null
            ? { ok: false, reason: `${host} is neither GitHub nor GitLab` }
            : { ok: true, forge: FORGES[name], project };
        return returned;
      }
    },
  );
  return answer;
}

export function productionCarries<R>(
  cwd: string,
  sha: string,
  run: Runner<R>,
  gitlabHost?: string,
) {
  const returned: Effect.Effect<boolean, never, R | ForgeHttp> = Effect.gen(function* () {
    const here = yield* forgeHere(cwd, run, gitlabHost);
    if (!here.ok) return false;
    const ref = { project: here.project, iid: "" };
    return (yield* here.forge.liveTier(ref, sha, cwd, run)) === "production";
  });
  return returned;
}

// WARNING: a forge that cannot be read fails rather than answering none, since a push is safe only once it has said no.
export function autoMergingHere<R>(cwd: string, run: Runner<R>, gitlabHost?: string) {
  const returned: Effect.Effect<string | null, string, R | ForgeHttp> = Effect.gen(function* () {
    const here = yield* forgeHere(cwd, run, gitlabHost);
    if (!here.ok) return null;
    const branch = Str.trim((yield* run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd)).stdout);
    if (branch === "HEAD" || branch === "") return null;
    const found = yield* here.forge.forBranch(here.project, branch, cwd, run);
    if (!found.ok) return yield* Effect.fail(found.reason);
    return found.open?.autoMerge === true ? found.open.url : null;
  });
  return returned;
}

export function sinceReview(details: MrDetails, reviewedAt: number) {
  if (reviewedAt <= 0 || details.updatedAt <= 0) {
    return "";
  }
  if (details.updatedAt <= reviewedAt) {
    return "nothing has moved since this review";
  }
  const hours = Math.round((details.updatedAt - reviewedAt) / 3_600_000);
  const when = hours < 1 ? "since" : `${hours}h after`;
  return `changed ${when} this review — head ${details.headSha}`;
}

export function resolveAssignee<R>(
  cwd: string,
  configured: YamlValue | undefined,
  forge: Forge,
  run: Runner<R>,
  project: string | null = null,
) {
  const returned: Effect.Effect<string | null, never, R | ForgeHttp> = Effect.gen(function* () {
    if (configured !== undefined && isString(configured) && Str.trim(configured) !== "")
      return Str.trim(configured);
    return yield* forge.login(cwd, run, project);
  });
  return returned;
}

export function linearIssues<R>(opts: { cwd: string } & Settled, run: Runner<R>) {
  const returned: Effect.Effect<Array<string>, never, R> = Effect.gen(function* () {
    const found: Array<string> = [];
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
  return returned;
}

function matchAll(text: string) {
  const returned: Array<string> = Arr.map([...pipe_(text, Str.matchAll(LINEAR_ID))], (m) => m[1]!);
  return returned;
}

export function prepareMergeRequest<R>(
  opts: {
    readonly cwd: string;
    readonly target?: string;
    readonly source?: { readonly value: string; readonly kind: string };
    readonly onto?: string | undefined;
    readonly assignees?: Partial<Record<MrForge, YamlValue>>;
    // WARNING: this host is GitLab whatever its name, so the forge is never read from the host name.
    readonly gitlabHost?: string;
  },
  run: Runner<R>,
) {
  const answer: Effect.Effect<
    MrReady,
    PlatformError,
    FileSystem.FileSystem | Path.Path | R | ForgeHttp
  > = Effect.gen(function* () {
    const unavailable = (reason: string, cause?: ParkCause) => {
      const result = { ok: false, reason, assignee: "", template: "", issues: [] };
      {
        const returned: MrReady = cause === undefined ? result : { ...result, cause };
        return returned;
      }
    };
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
    if (!ready.ok) return unavailable(ready.reason, ready.cause);
    const assignee = yield* resolveAssignee(
      opts.cwd,
      opts.assignees?.[forge.name],
      forge,
      run,
      project,
    );
    if (assignee === null && forge.name === "github")
      return unavailable("gh did not report a GitHub login", "forge-unavailable");
    const branch = Str.trim(
      (yield* run("git", ["rev-parse", "--abbrev-ref", "HEAD"], opts.cwd)).stdout,
    );
    // WARNING: a detached checkout is on no branch, so it has no merge request.
    const found =
      branch === "HEAD" || branch === ""
        ? { ok: true as const, open: null }
        : yield* forge.forBranch(project, branch, opts.cwd, run);
    if (!found.ok) return unavailable(found.reason, "forge-unavailable");
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
    };
  });
  return answer;
}
