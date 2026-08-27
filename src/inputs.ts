// Input inference: branch, cwd, earlier Runs and the open MR. The human is asked
// only when inference fails (docs/SPEC.md).

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { InputStrategy } from "./definitions";
import { RunStore } from "./run";

export interface Resolution {
  name: string;
  strategy: InputStrategy;
  value: string;
  source: string;
  /** True when nothing could be inferred and the human must supply it. */
  needsAsking: boolean;
  question: string;
  /** A short name for this value, when the value itself would name the Run badly. */
  label?: string;
}

export interface InferContext {
  cwd: string;
  /** The plugin state dir, so earlier Runs can be searched for a plan. */
  stateDir?: string;
  run?: (cmd: string, args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;
}

async function shell(cmd: string, args: string[], cwd: string): Promise<{ code: number; stdout: string }> {
  try {
    // The env must be passed explicitly or PATH changes are not honoured.
    const proc = Bun.spawn([cmd, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env } as Record<string, string>,
    });
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

    case "plan-dir": {
      const plan = ctx.stateDir ? newestPlanDir(ctx.stateDir, ctx.cwd) : null;
      if (plan) {
        return { ...base, value: plan.dir, source: `plan run ${plan.runId}`, label: plan.label };
      }
      return {
        ...base,
        value: "",
        source: "ask",
        needsAsking: true,
        question: "Path to the plan directory (no finished run has planned this project yet)",
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

/**
 * The newest finished Run for this repo that wrote a plan. Any workflow may write
 * one (`plan`, `ticket`, `architecture`), so having `plan/SPEC.md` is the test,
 * not the workflow's name (ADR-0002).
 */
export function newestPlanDir(
  stateDir: string,
  cwd: string,
): { dir: string; runId: string; label: string } | null {
  for (const run of new RunStore(stateDir).list()) {
    if (run.record.cwd !== cwd || run.record.status !== "done") continue;
    const dir = join(run.dir, "plan");
    if (!existsSync(join(dir, "SPEC.md"))) continue;
    const prefix = `${run.record.workflow}-`;
    const slug = run.record.slug;
    return { dir, runId: run.id, label: slug.startsWith(prefix) ? slug.slice(prefix.length) : slug };
  }
  return null;
}

export function confirmLine(workflow: string, resolutions: Resolution[]): string {
  const parts = resolutions
    .filter((r) => r.value !== "" || r.strategy !== "ticket")
    .map((r) => `${r.name}=${r.value || "(empty)"} [${r.source}]`);
  return `${workflow}: ${parts.join("  ")}`;
}
