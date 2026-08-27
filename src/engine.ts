// Executes a Run: one tab per Step, agents started with the right Harness,
// Model and Persona, gates and loops driven by Output files.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Definitions, ResolvedStep, ResolvedWorkflow, Variant } from "./definitions";
import { stepVariants, variantKeys } from "./definitions";
import type { Defaults } from "./config";
import type { Herdr } from "./herdr";
import { HerdrError } from "./herdr";
import { HARNESSES, personaPrefix, startArgs } from "./harness";
import { formatFindings, parseReviewOutput, unionFindings, type Finding, type ReviewOutput } from "./output";
import { agentName, shellQuote, stepLabel } from "./naming";
import { renderTemplate } from "./template";
import type { Run, RunStatus, StepStatus, VariantRecord } from "./run";

export const VIEW_SOURCE_PREFIX = "cego.workflows:";

export interface EngineOptions {
  herdr: Herdr;
  defs: Definitions;
  defaults: Defaults;
  wf: ResolvedWorkflow;
  run: Run;
  /** The Run's status pane; the first Step splits off it. */
  hostPaneId: string | null;
  out: (line: string) => void;
  stepTimeoutMs?: number;
  /** How long to keep waiting for an Output after the agent hands off to the human. */
  handoffTimeoutMs?: number;
  outputPollMs?: number;
}

interface VariantOutcome {
  record: VariantRecord;
  output: unknown | null;
  review: ReviewOutput | null;
}

export async function executeRun(o: EngineOptions): Promise<RunStatus> {
  const { herdr, run, wf, out } = o;
  const viewSource = `${VIEW_SOURCE_PREFIX}${run.id}`;
  // Only panes this process created: a resumed run's recorded panes are gone.
  const panes: string[] = [];
  const outputs = new Map<string, VariantOutcome[]>();
  const ran = new Set<string>();
  let host = o.hostPaneId;

  run.record.status = "running";
  run.record.finished_at = null;
  run.save();

  const indexOf = (id: string) => wf.steps.findIndex((s) => s.id === id);
  const repeats = wf.steps
    .map((s, at) => (s.repeat ? { at, from: indexOf(s.repeat.from), max: s.repeat.max ?? wf.maxIterations } : null))
    .filter((r): r is { at: number; from: number; max: number } => r !== null);

  let index = 0;
  while (index < wf.steps.length) {
    const step = wf.steps[index]!;
    const record = run.step(step.id);

    if (record.status === "done") {
      out(`✓ ${step.id} — already done, skipped`);
      index += 1;
      continue;
    }

    const variants = stepVariants(step, o.defaults);
    const keys = variantKeys(variants);
    record.status = "running";
    record.iteration = run.record.iteration;
    run.save();
    out(`▶ ${step.id}${variants.length > 1 ? ` (${variants.length} in parallel)` : ""} — iteration ${run.record.iteration}`);

    let outcomes: VariantOutcome[];
    try {
      outcomes = await runStep(o, step, variants, keys, outputs, panes, host, viewSource, ran);
    } catch (e) {
      record.status = "failed";
      record.note = e instanceof HerdrError ? `${e.message}: ${e.detail}` : (e as Error).message;
      run.save();
      out(`✗ ${step.id} — ${record.note}`);
      return await finish(o, "failed", viewSource);
    }
    // Only the very first pane splits off the status pane.
    host = null;
    ran.add(step.id);

    record.variants = outcomes.map((v) => v.record);
    outputs.set(step.id, outcomes);

    const blocked = outcomes.filter((v) => v.record.status !== "done");
    record.status = blocked.length > 0 ? "blocked" : "done";
    run.save();

    for (const v of outcomes) {
      const mark = v.record.status === "done" ? "✓" : v.record.status === "failed" ? "✗" : "⚠";
      out(`  ${mark} ${v.record.label}${v.record.error ? ` — ${v.record.error}` : ""}`);
      await markTab(herdr, v.record, mark);
    }

    if (blocked.length > 0) {
      return await finish(o, "blocked", viewSource, `${step.id} needs you`);
    }

    const gate = repeats.find((r) => r.from === index);
    if (gate) {
      const verdict = verdictOf(outcomes);
      if (verdict.clean) {
        out(`  reviews clean — skipping ${wf.steps[gate.at]!.id}`);
        for (const s of wf.steps.slice(index + 1, gate.at + 1)) {
          const rec = run.step(s.id);
          rec.status = "done";
          rec.note = "skipped: reviews clean";
        }
        run.save();
        index = gate.at + 1;
        continue;
      }
      out(`  ${verdict.findings.length} finding(s) to fix`);
    }

    const mine = repeats.find((r) => r.at === index);
    if (mine) {
      if (run.record.iteration < mine.max) {
        run.record.iteration += 1;
        for (const s of wf.steps.slice(mine.from, index + 1)) {
          const rec = run.step(s.id);
          rec.status = "pending";
          rec.note = null;
        }
        run.save();
        out(`  looping back to ${wf.steps[mine.from]!.id} (iteration ${run.record.iteration})`);
        index = mine.from;
        continue;
      }
      // Committing work the reviewers still object to would be worse than stopping.
      const still = verdictOf(outputs.get(wf.steps[mine.from]!.id) ?? []);
      run.record.outstanding = still.findings;
      run.step(step.id).note = `stopped at max_iterations ${mine.max} with ${still.findings.length} finding(s)`;
      run.save();
      out(`  max_iterations (${mine.max}) reached with ${still.findings.length} finding(s)`);
      return await finish(o, "blocked", viewSource, `max_iterations reached with findings`);
    }

    index += 1;
  }

  return await finish(o, "done", viewSource);
}

async function runStep(
  o: EngineOptions,
  step: ResolvedStep,
  variants: Variant[],
  keys: (string | null)[],
  outputs: Map<string, VariantOutcome[]>,
  panes: string[],
  host: string | null,
  viewSource: string,
  ran: Set<string>,
): Promise<VariantOutcome[]> {
  const { herdr, run } = o;
  // A step that has not run in this process gets fresh agents: a resumed Run
  // never reattaches, and the recorded panes may not exist any more.
  const previous = ran.has(step.id) ? run.step(step.id).variants : [];
  const records: VariantRecord[] = [];

  // Start (or reuse) every agent first, then prompt them all, so they work at once.
  for (const [i, variant] of variants.entries()) {
    const key = keys[i]!;
    const label = stepLabel(run.record.slug, step.id, key);
    const prior = previous[i] ?? borrowedAgent(o, step, ran);
    const record: VariantRecord = {
      harness: variant.harness,
      model: variant.model,
      effort: variant.effort ?? null,
      agent: prior?.agent ?? agentName(run.record.slug, step.id, key, run.record.seq),
      label: prior?.label ?? label,
      tabId: prior?.tabId ?? null,
      paneId: prior?.paneId ?? null,
      status: "running",
      output: null,
      error: null,
    };

    const reuse = prior !== null && !step.fresh;
    if (!reuse) {
      if (prior?.paneId) {
        // fresh: replace the pane so `agent start` sees a shell prompt again.
        const replacement = await herdr.paneSplit({ paneId: prior.paneId, direction: "right", cwd: run.record.cwd });
        await herdr.paneClose(prior.paneId);
        record.paneId = replacement;
        record.tabId = prior.tabId;
      } else if (host && i === 0) {
        record.paneId = await herdr.paneSplit({ paneId: host, direction: "right", ratio: 0.75, cwd: run.record.cwd });
        record.tabId = null;
      } else {
        const tab = await herdr.tabCreate({ label, cwd: run.record.cwd });
        record.tabId = tab.tabId;
        record.paneId = tab.paneId;
      }
      if (record.tabId) await herdr.tabRename(record.tabId, label);
      else if (record.paneId) await herdr.paneRename(record.paneId, label);

      // herdr 0.7.5 ignores --cwd on tab create and pane split, so cd explicitly.
      if (record.paneId) await herdr.paneRun(record.paneId, `cd ${shellQuote(run.record.cwd)}`);

      const adapter = HARNESSES[variant.harness]!;
      await herdr.agentStart({
        name: record.agent,
        kind: adapter.kind,
        paneId: record.paneId!,
        args: startArgs(adapter, variant.model, personaFile(o, step), variant.effort),
      });
      if (record.paneId) {
        panes.push(record.paneId);
        await setView(o, viewSource, panes);
      }
    }

    records.push(record);
  }

  for (const [i, record] of records.entries()) {
    const variant = variants[i]!;
    const key = keys[i]!;
    // A multi-line prompt cannot be typed into a harness reliably, so the prompt
    // goes to a file in the run dir and the agent is pointed at it.
    const path = join(run.stepDir(step.id, key), `prompt-${run.record.iteration}.md`);
    writeFileSync(path, `${buildPrompt(o, step, variant, key, outputs)}\n`);
    run.log(`prompt ${record.agent} -> ${relative(run.dir, path)}`);
    await herdr.agentPrompt(record.agent, `Your task for this step is in ${path} — read it and follow it.`);
  }

  const outcomes: VariantOutcome[] = [];
  for (const [i, record] of records.entries()) {
    const key = keys[i]!;
    try {
      // The agent may settle before herdr reports `working`; that is not an error.
      await o.herdr.agentWait(record.agent, { until: ["working"], timeoutMs: 10_000 });
    } catch {
      /* ignore */
    }
    await o.herdr.agentWait(record.agent, {
      until: ["idle", "done", "blocked"],
      timeoutMs: o.stepTimeoutMs,
    });
    outcomes.push(await collect(o, step, record, key));
  }
  return outcomes;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A settled agent does not mean a finished Step: an interviewing agent goes idle
 * waiting for the human. The Output file is the completion signal, so keep
 * waiting for it and toast once so the human knows they are needed.
 */
async function awaitOutput(o: EngineOptions, agent: string, stepId: string, path: string): Promise<void> {
  if (existsSync(path)) return;
  const budget = o.handoffTimeoutMs ?? 0;
  if (budget <= 0) return;

  o.out(`  ⏸ ${agent} is waiting for you in its tab`);
  try {
    await o.herdr.notify(`${o.run.record.slug} needs you`, `${stepId}: answer the agent in its tab`, "request");
  } catch {
    /* a missing toast must not fail the run */
  }
  const poll = o.outputPollMs ?? 2000;
  const deadline = Date.now() + budget;
  while (!existsSync(path) && Date.now() < deadline) {
    await sleep(Math.min(poll, Math.max(1, deadline - Date.now())));
  }
  if (existsSync(path)) o.out(`  ▸ ${agent} produced its Output`);
}

async function collect(
  o: EngineOptions,
  step: ResolvedStep,
  record: VariantRecord,
  variantKey: string | null,
): Promise<VariantOutcome> {
  if (!step.output) {
    const status = await o.herdr.agentStatus(record.agent);
    record.status = status === "blocked" ? "blocked" : "done";
    if (record.status === "blocked") record.error = "agent is blocked and needs input";
    return { record, output: null, review: null };
  }

  const path = o.run.outputPath(step.id, variantKey, step.output);
  record.output = relative(o.run.dir, path);
  await awaitOutput(o, record.agent, step.id, path);
  if (!existsSync(path)) {
    record.status = "blocked";
    record.error = `no Output at ${record.output}`;
    return { record, output: null, review: null };
  }

  const text = readFileSync(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    record.status = "failed";
    record.error = `${record.output}: not valid JSON (${(e as Error).message})`;
    return { record, output: null, review: null };
  }

  let review: ReviewOutput | null = null;
  if (parsed !== null && typeof parsed === "object" && "verdict" in (parsed as object)) {
    const result = parseReviewOutput(text, record.output);
    if (!result.ok) {
      record.status = "failed";
      record.error = result.error;
      return { record, output: parsed, review: null };
    }
    review = result.value;
    // A re-run step must not double-report what it disputed last time.
    for (const finding of review.disputed) {
      const key = `${finding.file ?? ""}:${finding.line ?? ""}:${finding.title}`;
      const seen = o.run.record.disputed.some(
        (d) => `${d.file ?? ""}:${d.line ?? ""}:${d.title}` === key,
      );
      if (!seen) o.run.record.disputed.push(finding);
    }
  }

  record.status = "done";
  return { record, output: parsed, review };
}

/** The agent of an earlier step, but only one this process actually started. */
function borrowedAgent(o: EngineOptions, step: ResolvedStep, ran: Set<string>): VariantRecord | null {
  if (!step.agent || !ran.has(step.agent)) return null;
  return o.run.step(step.agent).variants[0] ?? null;
}

function personaBody(o: EngineOptions, step: ResolvedStep): string {
  return step.persona ? (o.defs.personas.get(step.persona)?.body ?? "") : "";
}

/** The Persona as a file, since herdr will not pass multi-line agent arguments. */
function personaFile(o: EngineOptions, step: ResolvedStep): string {
  const dir = join(o.run.dir, "personas");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${step.persona ?? "none"}.md`);
  writeFileSync(path, `${personaBody(o, step)}\n`);
  return path;
}

function buildPrompt(
  o: EngineOptions,
  step: ResolvedStep,
  variant: Variant,
  variantKey: string | null,
  outputs: Map<string, VariantOutcome[]>,
): string {
  const adapter = HARNESSES[variant.harness]!;
  const outputPath = step.output ? o.run.outputPath(step.id, variantKey, step.output) : "";
  const vars: Record<string, unknown> = {
    inputs: o.run.record.inputs,
    outputs: Object.fromEntries(
      [...outputs.entries()].map(([id, list]) => [
        id,
        list.length === 1 ? list[0]!.output : list.map((v) => v.output),
      ]),
    ),
    findings: formatFindings(lastFindings(o, step, outputs)),
    run_dir: o.run.dir,
    output_path: outputPath,
    iteration: String(o.run.record.iteration),
    max_iterations: String(o.run.record.max_iterations),
    cwd: o.run.record.cwd,
    step: step.id,
    harness: variant.harness,
    model: variant.model,
    effort: variant.effort ?? "",
  };

  const parts: string[] = [];
  const prefix = personaPrefix(adapter, personaBody(o, step));
  if (prefix) parts.push(prefix);
  const rendered = renderTemplate([step.preamble, step.prompt].filter((p) => p.trim()).join("\n\n"), vars);
  if (rendered.missing.length > 0) {
    o.run.log(`unknown template keys in ${step.id}: ${rendered.missing.join(", ")}`);
  }
  parts.push(rendered.text);
  if (outputPath) {
    parts.push(
      `When you are done, write your result as JSON to the path below. Nothing else may go in that file.\nOUTPUT_PATH: ${outputPath}`,
    );
  }
  return parts.join("\n\n");
}

function lastFindings(
  o: EngineOptions,
  step: ResolvedStep,
  outputs: Map<string, VariantOutcome[]>,
): Finding[] {
  const from = step.repeat?.from;
  const source = from ? outputs.get(from) : undefined;
  if (!source) return [];
  return unionFindings(source.map((v) => v.review).filter((r): r is ReviewOutput => r !== null));
}

function verdictOf(outcomes: VariantOutcome[]): { clean: boolean; findings: Finding[] } {
  const reviews = outcomes.map((v) => v.review).filter((r): r is ReviewOutput => r !== null);
  const findings = unionFindings(reviews);
  return { clean: reviews.length > 0 && reviews.every((r) => r.verdict === "clean") && findings.length === 0, findings };
}

async function markTab(herdr: Herdr, record: VariantRecord, mark: string): Promise<void> {
  const label = `${mark} ${record.label}`;
  if (record.tabId) await herdr.tabRename(record.tabId, label);
  else if (record.paneId) await herdr.paneRename(record.paneId, label);
}

async function setView(o: EngineOptions, source: string, panes: string[]): Promise<void> {
  try {
    await o.herdr.agentViewSet(source, o.run.record.slug, panes);
  } catch (e) {
    // A filtered sidebar is a nicety; losing it must not fail the run.
    o.run.log(`agent.view.set failed: ${(e as Error).message}`);
  }
}

async function finish(
  o: EngineOptions,
  status: RunStatus,
  viewSource: string,
  detail?: string,
): Promise<RunStatus> {
  const { run, out } = o;
  run.record.status = status;
  run.record.finished_at = new Date().toISOString();
  run.record.summary = summarise(o, status);
  run.save();
  out("");
  out(run.record.summary);
  try {
    await o.herdr.agentViewClear(viewSource);
  } catch {
    /* the sidebar filter is a nicety */
  }
  const title =
    status === "done" ? `${run.record.slug} finished` : `${run.record.slug} ${status}`;
  try {
    await o.herdr.notify(title, detail ?? run.record.summary.split("\n")[0], status === "done" ? "done" : "request");
  } catch {
    /* a missing toast must not fail the run */
  }
  return status;
}

export function summarise(o: EngineOptions, status: RunStatus): string {
  const { run } = o;
  const lines = [`Run ${run.id} — ${status} after ${run.record.iteration} iteration(s)`];
  for (const step of run.record.steps) {
    const marks: Record<StepStatus, string> = {
      pending: "·",
      running: "…",
      done: "✓",
      blocked: "⚠",
      failed: "✗",
    };
    const detail = step.note ? ` (${step.note})` : "";
    const errors = step.variants
      .filter((v) => v.error)
      .map((v) => `\n    ${v.label}: ${v.error}`)
      .join("");
    lines.push(`  ${marks[step.status]} ${step.id}${detail}${errors}`);
  }
  if (run.record.outstanding.length > 0) {
    lines.push("", "Findings still open:", formatFindings(run.record.outstanding));
  }
  if (run.record.disputed.length > 0) {
    lines.push("", "Disputed findings (the implementer did not apply these):", formatFindings(run.record.disputed));
  }
  return lines.join("\n");
}
