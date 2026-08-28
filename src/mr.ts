// What the MR step needs to know before it can run: whether GitLab is reachable
// at all, who to assign, which template to fill, and which Linear tickets this
// branch is answering. Push is this step's business and nothing else's.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export type Runner = (cmd: string, args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;

export const MR_TEMPLATE = join(".gitlab", "merge_request_templates", "default.md");

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
  const ssh = /^(?:ssh:\/\/)?(?:[^@\s]+@)?([^:/\s]+)[:/](.+?)(?:\.git)?$/.exec(text.replace(/^https?:\/\//, ""));
  if (!ssh) return null;
  const [, host = "", path = ""] = ssh;
  if (!host.includes(".") || path === "") return null;
  return `${host}/${path.replace(/^\/+/, "").replace(/\.git$/, "")}`;
}

/** The project this checkout pushes to, or null when there is no GitLab remote. */
export async function projectHere(cwd: string, run: Runner): Promise<string | null> {
  for (const remote of ["origin", "upstream"]) {
    const url = await run("git", ["remote", "get-url", remote], cwd);
    if (url.code !== 0) continue;
    const project = projectFromRemote(url.stdout);
    if (project) return project;
  }
  return null;
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
export async function gitlabReadiness(cwd: string, run: Runner): Promise<Readiness> {
  const glab = await run("glab", ["--version"], cwd);
  if (glab.code !== 0) return { ok: false, reason: "glab is not installed" };

  const remotes = await run("git", ["remote", "-v"], cwd);
  if (remotes.code !== 0 || remotes.stdout.trim() === "") {
    return { ok: false, reason: "this repo has no remote" };
  }
  if (!/gitlab/i.test(remotes.stdout)) return { ok: false, reason: "no GitLab remote" };
  return { ok: true, reason: "" };
}

/**
 * What a step pointed at someone else's merge request needs: glab, and glab logged
 * in to that host. The cwd's remotes are none of its business — the whole point of
 * carrying the project is that no checkout is required.
 */
export async function gitlabForProject(
  project: string | null,
  cwd: string,
  run: Runner,
): Promise<Readiness> {
  const glab = await run("glab", ["--version"], cwd);
  if (glab.code !== 0) return { ok: false, reason: "glab is not installed" };

  const host = hostOf(project);
  if (!host) {
    // No project to check against: fall back to what this directory can prove.
    return await gitlabReadiness(cwd, run);
  }
  const auth = await run("glab", ["auth", "status", "--hostname", host], cwd);
  return auth.code === 0 ? { ok: true, reason: "" } : { ok: false, reason: `glab is not logged in to ${host}` };
}

/** The configured assignee wins; otherwise whoever glab is logged in as. */
export async function resolveAssignee(
  cwd: string,
  configured: unknown,
  run: Runner,
): Promise<string | null> {
  if (typeof configured === "string" && configured.trim() !== "") return configured.trim();
  const me = await run("glab", ["api", "user"], cwd);
  if (me.code !== 0) return null;
  try {
    const user = JSON.parse(me.stdout) as Record<string, unknown>;
    return typeof user.username === "string" && user.username !== "" ? user.username : null;
  } catch {
    return null;
  }
}

export function templateFile(cwd: string): string | null {
  return existsSync(join(cwd, MR_TEMPLATE)) ? MR_TEMPLATE : null;
}

/**
 * Every Linear ticket this branch could be answering: the work source when the
 * human named one, the branch name, and whatever a `plan` run put on the board.
 */
export async function linearIssues(
  opts: { cwd: string; inputs: Record<string, string>; planInput?: string },
  run: Runner,
): Promise<string[]> {
  const found: string[] = [];
  const add = (id: string) => {
    const up = id.toUpperCase();
    if (!found.includes(up)) found.push(up);
  };

  const plan = opts.planInput ?? "plan";
  if (opts.inputs[`${plan}_kind`] === "linear") {
    for (const id of matchAll(opts.inputs[plan] ?? "")) add(id);
  }

  const branch = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], opts.cwd);
  for (const id of matchAll(branch.stdout)) add(id);

  if (opts.inputs[`${plan}_kind`] === "plan-dir") {
    for (const id of offloadedIssues(opts.inputs[plan] ?? "")) add(id);
  }
  return found;
}

function matchAll(text: string): string[] {
  return [...text.matchAll(LINEAR_ID)].map((m) => m[1]!);
}

/**
 * A `plan` run that took "Offload to Linear" wrote the issue id into that choice's
 * Output. The plan dir is inside the run dir, so the outputs are one level up.
 */
function offloadedIssues(planDir: string): string[] {
  const runDir = dirname(planDir);
  if (planDir === "" || !existsSync(join(runDir, "run.json"))) return [];
  const out: string[] = [];
  for (const file of jsonFiles(join(runDir, "steps"))) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      if (typeof parsed.issue === "string") out.push(...matchAll(parsed.issue));
    } catch {
      // A half-written Output must not stop the MR from being opened.
    }
  }
  return out;
}

function jsonFiles(dir: string, depth = 0): string[] {
  if (depth > 3 || !existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try {
      if (statSync(path).isDirectory()) out.push(...jsonFiles(path, depth + 1));
      else if (name.endsWith(".json")) out.push(path);
    } catch {
      // Raced with a step writing its Output; the next run will see it.
    }
  }
  return out;
}

export async function mrFacts(
  opts: { cwd: string; inputs: Record<string, string>; configuredAssignee?: unknown; planInput?: string },
  run: Runner,
): Promise<MrFacts> {
  return {
    assignee: await resolveAssignee(opts.cwd, opts.configuredAssignee, run),
    template: templateFile(opts.cwd),
    issues: await linearIssues(opts, run),
  };
}
