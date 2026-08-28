// Input inference: branch, cwd, earlier Runs and the open MR. The human is asked
// only when inference fails (docs/SPEC.md).

import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { InputStrategy } from "./definitions";
import type { PickItem } from "./picker";
import { RunStore } from "./run";

/** Where the work to be done was described. */
export type WorkSourceKind = "plan-dir" | "linear" | "text";

export interface WorkSourceCandidate {
  kind: WorkSourceKind;
  value: string;
  source: string;
  label?: string;
}

/** How a work-source reaches the human; the picker and the runner pane both supply it. */
export interface InputPrompts {
  menu(items: PickItem[], opts: { header: string; footer?: string }): Promise<PickItem | null>;
  ask(question: string): Promise<string | null>;
}

/** More than this and the oldest plans would bury the branch's own ticket. */
const PLAN_DIR_CANDIDATES = 3;
const WORK_SOURCE_QUESTION = "What should be built?";
const TYPE_IT = "type";

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
  /** Where the work is described, for a `work-source`. */
  kind?: WorkSourceKind;
  /** What the human may pick from, when a `work-source` could not be inferred. */
  candidates?: WorkSourceCandidate[];
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
      const plan = ctx.stateDir ? planDirs(ctx.stateDir, ctx.cwd, 1)[0] : undefined;
      if (plan) {
        return { ...base, value: plan.value, source: plan.source, label: plan.label };
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
      const found = await ticketFromBranch(run, ctx.cwd);
      return found ? { ...base, ...found } : { ...base, value: "", source: "none" };
    }

    case "work-source": {
      const candidates = await workSourceCandidates(ctx);
      // One candidate is an answer; none or several are a question for the human.
      if (candidates.length === 1) return { ...base, ...candidates[0]! };
      return { ...base, value: "", source: "ask", needsAsking: true, question: WORK_SOURCE_QUESTION, candidates };
    }

    case "flag":
      return { ...base, value: "false", source: "default" };
  }
}

async function ticketFromBranch(
  run: NonNullable<InferContext["run"]>,
  cwd: string,
): Promise<{ value: string; source: string } | null> {
  const branch = (await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd)).stdout.trim();
  const m = /([A-Z][A-Z0-9]+-\d+)/.exec(branch);
  return m ? { value: m[1]!, source: `branch ${branch}` } : null;
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
 * The newest finished Runs for this repo that wrote a plan, newest first. Any
 * workflow may write one (`plan`, `architecture`), so having `plan/SPEC.md` is the
 * test, not the workflow's name (ADR-0002).
 */
export function planDirs(stateDir: string, cwd: string, limit: number): WorkSourceCandidate[] {
  const found: WorkSourceCandidate[] = [];
  for (const run of new RunStore(stateDir).list()) {
    if (found.length >= limit) break;
    if (run.record.cwd !== cwd || run.record.status !== "done") continue;
    const dir = join(run.dir, "plan");
    if (!existsSync(join(dir, "SPEC.md"))) continue;
    const prefix = `${run.record.workflow}-`;
    const slug = run.record.slug;
    found.push({
      kind: "plan-dir",
      value: dir,
      source: `plan run ${run.id}`,
      label: slug.startsWith(prefix) ? slug.slice(prefix.length) : slug,
    });
  }
  return found;
}

/** Everything that could describe the work here: the recent plans, then the branch's ticket. */
export async function workSourceCandidates(ctx: InferContext): Promise<WorkSourceCandidate[]> {
  const candidates = ctx.stateDir ? planDirs(ctx.stateDir, ctx.cwd, PLAN_DIR_CANDIDATES) : [];
  const ticket = await ticketFromBranch(ctx.run ?? shell, ctx.cwd);
  if (ticket) candidates.push({ kind: "linear", value: ticket.value, source: ticket.source });
  return candidates;
}

/** What the human typed: a plan directory, a Linear issue, or the work in their own words. */
export function classifyWorkSource(typed: string): WorkSourceCandidate {
  const text = typed.trim();
  const source = "typed";

  const url = /linear\.app\/[^/\s]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)/.exec(text);
  if (url) return { kind: "linear", value: url[1]!.toUpperCase(), source };

  if (/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(text)) return { kind: "linear", value: text.toUpperCase(), source };

  if (isPlanDir(text)) return { kind: "plan-dir", value: text, source, label: textLabel(basename(text)) };

  return { kind: "text", value: text, source, label: textLabel(text) };
}

/**
 * Settles a work-source the human has to choose: the candidates as a menu, plus
 * "Type it…" for a Linear issue or a description. False when they backed out.
 */
export async function resolveWorkSource(r: Resolution, prompts: InputPrompts): Promise<boolean> {
  const candidates = r.candidates ?? [];
  const items: PickItem[] = candidates.map((c, i) => ({
    id: String(i),
    title: c.label ?? c.value,
    subtitle: `${c.kind} · ${c.source}`,
  }));
  items.push({ id: TYPE_IT, title: "Type it…", subtitle: "a Linear id or URL, or the work in your own words" });

  const chosen = await prompts.menu(items, {
    header: WORK_SOURCE_QUESTION,
    footer: "↑↓ move · type to filter · Enter choose · Esc cancel",
  });
  if (!chosen) return false;

  if (chosen.id !== TYPE_IT) {
    settle(r, candidates[Number(chosen.id)]!);
    return true;
  }

  const typed = await prompts.ask("Linear id or URL, or the work in your own words");
  if (typed === null || typed.trim() === "") return false;
  settle(r, classifyWorkSource(typed));
  return true;
}

function settle(r: Resolution, candidate: WorkSourceCandidate): void {
  r.value = candidate.value;
  r.kind = candidate.kind;
  r.source = candidate.source;
  r.label = candidate.label;
  r.needsAsking = false;
  delete r.candidates;
}

function isPlanDir(path: string): boolean {
  try {
    return statSync(path).isDirectory() && existsSync(join(path, "SPEC.md"));
  } catch {
    return false;
  }
}

/** A few words, enough to name the Run after work that has no shorter name. */
function textLabel(text: string): string {
  const words = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter(Boolean);
  let label = "";
  for (const word of words) {
    const next = label ? `${label}-${word}` : word;
    if (next.length > 24) break;
    label = next;
  }
  return label || "work";
}

/** Inputs as the prompts see them: a work-source also exposes `<name>_kind`. */
export function inputValues(resolutions: Resolution[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const r of resolutions) {
    values[r.name] = r.value;
    if (r.kind) values[`${r.name}_kind`] = r.kind;
  }
  return values;
}

export function inputSources(resolutions: Resolution[]): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const r of resolutions) {
    sources[r.name] = r.source;
    if (r.kind) sources[`${r.name}_kind`] = r.source;
  }
  return sources;
}

export function confirmLine(workflow: string, resolutions: Resolution[]): string {
  const parts = resolutions
    .filter((r) => r.value !== "" || r.strategy !== "ticket")
    .map((r) => {
      const where = r.kind ? `${r.kind} · ${r.source}` : r.source;
      return `${r.name}=${abbreviate(r.value) || "(empty)"} [${where}]`;
    });
  return `${workflow}: ${parts.join("  ")}`;
}

/** Free text is a whole sentence; the confirm line only has room for the start of it. */
function abbreviate(value: string): string {
  return value.length > 60 ? `${value.slice(0, 57)}...` : value;
}
