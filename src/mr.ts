// What the MR step needs to know before it can run: whether GitLab is reachable
// at all, who to assign, which template to fill, and which Linear tickets this
// branch is answering. Push is this step's business and nothing else's.

import { Effect, FileSystem, Option, Path, Schema, Stream } from "effect";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type { YamlValue } from "./yaml";

export type Runner<R = never> = (
  cmd: string,
  args: string[],
  cwd: string,
) => Effect.Effect<{ code: number; stdout: string }, never, R>;

const isString = Schema.is(Schema.String);
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
): Effect.Effect<{ code: number; stdout: string }, never, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = ChildProcess.make(cmd, args, {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
      // extendEnv, so git and glab inherit this process's environment and find their
      // config and credentials — the Effect-native spelling of `{ ...process.env }`.
      extendEnv: true,
    });
    const handle = yield* spawner.spawn(command);
    const [stdout, code] = yield* Effect.all(
      [
        handle.stdout.pipe(
          Stream.decodeText(),
          Stream.runFold(
            () => "",
            (out, chunk) => out + chunk,
          ),
        ),
        handle.exitCode,
      ],
      { concurrency: "unbounded" },
    );
    return { code: Number(code), stdout };
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
