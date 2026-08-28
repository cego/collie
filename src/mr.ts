// What the MR step needs to know before it can run: whether GitLab is reachable
// at all, who to assign, which template to fill, and which Linear tickets this
// branch is answering. Push is this step's business and nothing else's.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export type Runner = (cmd: string, args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;

export const MR_TEMPLATE = join(".gitlab", "merge_request_templates", "default.md");

/** A Linear id, the shape it takes in a branch name, a URL, or an Output. */
const LINEAR_ID = /\b([A-Z][A-Z0-9]+-\d+)\b/g;

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
