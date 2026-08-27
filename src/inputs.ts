// Input inference: branch, cwd, tasks/ and the open MR. The human is asked only
// when inference fails (docs/SPEC.md).

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { InputStrategy } from "./definitions";

export interface Resolution {
  name: string;
  strategy: InputStrategy;
  value: string;
  source: string;
  /** True when nothing could be inferred and the human must supply it. */
  needsAsking: boolean;
  question: string;
}

export interface InferContext {
  cwd: string;
  run?: (cmd: string, args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;
}

async function shell(cmd: string, args: string[], cwd: string): Promise<{ code: number; stdout: string }> {
  try {
    const proc = Bun.spawn([cmd, ...args], { cwd, stdout: "pipe", stderr: "ignore" });
    const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return { code, stdout };
  } catch {
    return { code: 127, stdout: "" };
  }
}

export async function inferInput(
  name: string,
  strategy: InputStrategy,
  ctx: InferContext,
): Promise<Resolution> {
  const run = ctx.run ?? shell;
  const base = { name, strategy, needsAsking: false, question: `${name}?` };

  switch (strategy) {
    case "goal":
      return { ...base, value: "", source: "ask", needsAsking: true, question: "What is the goal?" };

    case "plan-file": {
      const plan = newestPlan(ctx.cwd);
      if (plan) return { ...base, value: plan, source: `newest ${plan}` };
      return {
        ...base,
        value: "",
        source: "ask",
        needsAsking: true,
        question: "Path to the plan file (no tasks/**/PLAN.md found)",
      };
    }

    case "diff-target": {
      const mr = await run("glab", ["mr", "view", "--output", "json"], ctx.cwd);
      if (mr.code === 0) {
        const iid = mrIid(mr.stdout);
        if (iid) return { ...base, value: `mr:${iid}`, source: `open merge request !${iid}` };
      }
      const branch = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], ctx.cwd)).stdout.trim();
      const baseRef = await defaultBase(run, ctx.cwd);
      if (branch && baseRef && branch !== baseRef) {
        return { ...base, value: `branch:${baseRef}...${branch}`, source: `${branch} vs ${baseRef}` };
      }
      return { ...base, value: "worktree", source: "working tree" };
    }

    case "ticket": {
      const branch = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], ctx.cwd)).stdout.trim();
      const m = /([A-Z][A-Z0-9]+-\d+)/.exec(branch);
      if (m) return { ...base, value: m[1]!, source: `branch ${branch}` };
      return { ...base, value: "", source: "none" };
    }

    case "flag":
      return { ...base, value: "false", source: "default" };
  }
}

export async function inferInputs(
  inputs: Record<string, InputStrategy>,
  ctx: InferContext,
): Promise<Resolution[]> {
  const out: Resolution[] = [];
  for (const [name, strategy] of Object.entries(inputs)) {
    out.push(await inferInput(name, strategy, ctx));
  }
  return out;
}

function mrIid(stdout: string): string | null {
  try {
    const data = JSON.parse(stdout) as Record<string, unknown>;
    if (typeof data.state === "string" && data.state.toLowerCase() !== "opened" && data.state.toLowerCase() !== "open") {
      return null;
    }
    const iid = data.iid ?? data.id;
    return iid === undefined || iid === null ? null : String(iid);
  } catch {
    return null;
  }
}

async function defaultBase(
  run: NonNullable<InferContext["run"]>,
  cwd: string,
): Promise<string | null> {
  const head = await run("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], cwd);
  if (head.code === 0 && head.stdout.trim()) {
    return head.stdout.trim().replace(/^origin\//, "");
  }
  for (const candidate of ["main", "master"]) {
    const exists = await run("git", ["rev-parse", "--verify", "--quiet", candidate], cwd);
    if (exists.code === 0) return candidate;
  }
  return null;
}

/** Newest `tasks/<slug>/PLAN.md` under cwd, relative to cwd. */
export function newestPlan(cwd: string): string | null {
  const tasks = join(cwd, "tasks");
  if (!existsSync(tasks)) return null;
  let best: { path: string; mtime: number } | null = null;
  const walk = (dir: string, depth: number) => {
    if (depth > 3) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.name === "PLAN.md") {
        const mtime = statSync(path).mtimeMs;
        if (!best || mtime > best.mtime) best = { path, mtime };
      }
    }
  };
  walk(tasks, 0);
  return best ? relative(cwd, (best as { path: string }).path) : null;
}

export function confirmLine(workflow: string, resolutions: Resolution[]): string {
  const parts = resolutions
    .filter((r) => r.value !== "" || r.strategy !== "ticket")
    .map((r) => `${r.name}=${r.value || "(empty)"} [${r.source}]`);
  return `${workflow}: ${parts.join("  ")}`;
}
