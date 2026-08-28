// Executes a Run: one tab per Step, agents started with the right Harness,
// Model and Persona, gates and loops driven by Output files.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { ChoiceDef, Definitions, ResolvedStep, ResolvedWorkflow, RoundDef, Variant } from "./definitions";
import { roundVariant, stepVariants, variantKeys } from "./definitions";
import type { Defaults } from "./config";
import { configValue, readConfig, writeConfigValue } from "./config";
import type { PluginEnv } from "./env";
import type { PickItem } from "./picker";
import { slugify } from "./template";
import type { Herdr } from "./herdr";
import { HerdrError } from "./herdr";
import { HARNESSES, personaPrefix, startArgs } from "./harness";
import {
  findingKey,
  formatFindings,
  parseFindings,
  parseReviewOutput,
  splitDisputed,
  unionFindings,
  type Finding,
  type ReviewOutput,
} from "./output";
import { agentName, shellQuote, stepLabel } from "./naming";
import { inferInputs } from "./inputs";
import { RunStore } from "./run";
import { renderTemplate } from "./template";
import { resolveWorkflow } from "./definitions";
import type { Run, RunStatus, StepStatus, VariantRecord } from "./run";

export const VIEW_SOURCE_PREFIX = "cego.workflows:";

/** How a Choice step reaches the human. The runner pane supplies the picker TUI. */
export interface EnginePrompts {
  menu(items: PickItem[], opts: { header: string; footer?: string }): Promise<PickItem | null>;
  ask(question: string): Promise<string | null>;
}

export interface EngineOptions {
  herdr: Herdr;
  defs: Definitions;
  defaults: Defaults;
  wf: ResolvedWorkflow;
  run: Run;
  env: PluginEnv;
  /** The Run's status pane; the first Step splits off it. */
  hostPaneId: string | null;
  out: (line: string) => void;
  stepTimeoutMs?: number;
  /** How long to keep waiting for an Output after the agent hands off to the human. */
  handoffTimeoutMs?: number;
  outputPollMs?: number;
  /** Required by any Workflow with a Choice step. */
  prompts?: EnginePrompts;
}

interface VariantOutcome {
  record: VariantRecord;
  output: unknown | null;
  review: ReviewOutput | null;
}

/** What one execution accumulates as it goes: only this process's panes and agents. */
interface RunCtx {
  outputs: Map<string, VariantOutcome[]>;
  /** Panes this process created; a resumed run's recorded panes are gone. */
  panes: string[];
  ran: Set<string>;
  /** One agent per `agent:` group, so a resumed run still keeps one implementer. */
  groups: Map<string, VariantRecord>;
  viewSource: string;
}

export async function executeRun(o: EngineOptions): Promise<RunStatus> {
  const { herdr, run, wf, out } = o;
  const viewSource = `${VIEW_SOURCE_PREFIX}${run.id}`;
  const ctx: RunCtx = {
    outputs: new Map(),
    panes: [],
    ran: new Set(),
    groups: new Map(),
    viewSource,
  };
  let host = o.hostPaneId;

  run.record.status = "running";
  run.record.finished_at = null;
  run.save();

  const indexOf = (id: string) => wf.steps.findIndex((s) => s.id === id);
  const repeats = wf.steps
    .map((s, at) =>
      s.repeat
        ? {
            at,
            from: indexOf(s.repeat.from),
            // The gate is `from`; the loop restarts at `back_to`, which may be earlier.
            back: indexOf(s.repeat.back_to ?? s.repeat.from),
            max: s.repeat.max ?? wf.maxIterations,
          }
        : null,
    )
    .filter((r): r is { at: number; from: number; back: number; max: number } => r !== null);

  let index = 0;
  while (index < wf.steps.length) {
    const step = wf.steps[index]!;
    const record = run.step(step.id);

    if (record.status === "done") {
      out(`✓ ${step.id} — already done, skipped`);
      index += 1;
      continue;
    }

    if ((step.choices?.length ?? 0) > 0) {
      record.status = "running";
      record.iteration = run.record.iteration;
      record.note = null;
      record.variants = [];
      run.save();
      out(`▶ ${step.id} — over to you`);
      let result: ChoiceResult;
      try {
        result = await runChoiceStep(o, step, ctx, host);
      } catch (e) {
        record.status = "failed";
        record.note = e instanceof HerdrError ? `${e.message}: ${e.detail}` : (e as Error).message;
        run.save();
        out(`✗ ${step.id} — ${record.note}`);
        return await finish(o, "failed", viewSource);
      }
      host = null;
      ctx.ran.add(step.id);
      record.status = result.status;
      record.note = result.note;
      run.save();
      if (result.status !== "done") {
        return await finish(o, "blocked", viewSource, `${step.id} needs you`);
      }
      // A chained Run takes over from here, so the parent stops where it is.
      if (result.chained) {
        for (const s of wf.steps.slice(index + 1)) {
          const rec = run.step(s.id);
          if (rec.status === "pending") rec.note = `not run: ${result.note}`;
        }
        run.save();
        return await finish(o, "done", viewSource, result.note ?? undefined);
      }
      index += 1;
      continue;
    }

    const variants = stepVariants(step, o.defaults);
    const keys = variantKeys(variants);
    record.status = "running";
    record.iteration = run.record.iteration;
    // A step that failed and is being tried again must not keep the old note.
    record.note = null;
    run.save();
    out(`▶ ${step.id}${variants.length > 1 ? ` (${variants.length} in parallel)` : ""} — iteration ${run.record.iteration}`);

    let outcomes: VariantOutcome[];
    try {
      outcomes = await runStep(o, step, variants, keys, ctx, host);
    } catch (e) {
      record.status = "failed";
      record.note = e instanceof HerdrError ? `${e.message}: ${e.detail}` : (e as Error).message;
      run.save();
      out(`✗ ${step.id} — ${record.note}`);
      return await finish(o, "failed", viewSource);
    }
    // Only the very first pane splits off the status pane.
    host = null;
    ctx.ran.add(step.id);

    record.variants = outcomes.map((v) => v.record);
    ctx.outputs.set(step.id, outcomes);

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
      const verdict = verdictOf(outcomes, run.record.disputed);
      // A reviewer that answered a dispute reopens it: the argument has moved on.
      if (verdict.rebutted.length > 0) {
        const answered = new Set(verdict.rebutted.map(findingKey));
        run.record.disputed = run.record.disputed.filter((d) => !answered.has(findingKey(d)));
        run.save();
        out(`  ${verdict.rebutted.length} disputed finding(s) answered by a reviewer`);
      }
      if (verdict.settled.length > 0) {
        out(`  ${verdict.settled.length} finding(s) already disputed — your call, not the loop's`);
      }
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
        for (const s of wf.steps.slice(mine.back, index + 1)) {
          const rec = run.step(s.id);
          rec.status = "pending";
          rec.note = null;
        }
        run.save();
        out(`  looping back to ${wf.steps[mine.back]!.id} (iteration ${run.record.iteration})`);
        index = mine.back;
        continue;
      }
      // Committing work the reviewers still object to would be worse than stopping.
      const still = verdictOf(ctx.outputs.get(wf.steps[mine.from]!.id) ?? [], run.record.disputed);
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
  ctx: RunCtx,
  host: string | null,
  extraVars?: Record<string, unknown>,
): Promise<VariantOutcome[]> {
  const { herdr, run } = o;
  // A step that has not run in this process gets fresh agents: a resumed Run
  // never reattaches, and the recorded panes may not exist any more.
  const previous = ctx.ran.has(step.id) ? run.step(step.id).variants : [];
  const records: VariantRecord[] = [];

  // Start (or reuse) every agent first, then prompt them all, so they work at once.
  for (const [i, variant] of variants.entries()) {
    const key = keys[i]!;
    const label = stepLabel(run.record.slug, step.id, key);
    const prior = previous[i] ?? borrowedAgent(o, step, ctx);
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
      await startAgent(o, step, {
        name: record.agent,
        kind: adapter.kind,
        paneId: record.paneId!,
        args: startArgs(adapter, variant.model, personaFile(o, step), variant.effort),
      });
      if (record.paneId) {
        ctx.panes.push(record.paneId);
        await setView(o, ctx.viewSource, ctx.panes);
      }
      // The first step of an `agent:` group lends its agent to the rest of it.
      if (step.agent && !ctx.groups.has(step.agent)) ctx.groups.set(step.agent, record);
    }

    records.push(record);
  }

  for (const [i, record] of records.entries()) {
    const variant = variants[i]!;
    const key = keys[i]!;
    // A multi-line prompt cannot be typed into a harness reliably, so the prompt
    // goes to a file in the run dir and the agent is pointed at it.
    const path = join(run.stepDir(step.id, key), `prompt-${run.record.iteration}.md`);
    writeFileSync(path, `${buildPrompt(o, step, variant, key, ctx.outputs, extraVars)}\n`);
    run.log(`prompt ${record.agent} -> ${relative(run.dir, path)}`);
    // A skill marked `disable-model-invocation` refuses an agent that invokes it
    // itself; `agent prompt` is the human's channel, so a slash command here runs.
    const command = step.skill ? `/${step.skill} ` : "";
    await herdr.agentPrompt(
      record.agent,
      `${command}Your task for this step is in ${path} — read it and follow it.`,
    );
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

interface ChoiceResult {
  status: StepStatus;
  note: string | null;
  /** True when a child Run took over, so the parent should stop. */
  chained?: boolean;
}

/**
 * A Choice step: a menu in the runner pane instead of an agent. A `prompt` choice
 * runs one agent round and offers the menu again; `run` and `stop` end the step.
 */
async function runChoiceStep(
  o: EngineOptions,
  step: ResolvedStep,
  ctx: RunCtx,
  host: string | null,
): Promise<ChoiceResult> {
  const { run, out } = o;
  const prompts = o.prompts;
  if (!prompts) {
    return { status: "failed", note: `${step.id} needs a menu, and this run has no terminal` };
  }
  const choices = step.choices ?? [];
  let hostPane = host;

  for (;;) {
    const taken = (title: string) =>
      run.record.choices.filter((c) => c.step === step.id && c.title === title).length;
    const items: PickItem[] = choices
      .filter((c) => c.max === undefined || taken(c.title) < c.max)
      .map((c) => ({ id: c.title, title: c.title, subtitle: choiceHint(c) }));

    const picked = await prompts.menu(items, {
      header: `${run.record.slug} — ${step.id}`,
      footer: "↑↓ move · Enter choose · Esc leave the run open",
    });
    if (!picked) return { status: "blocked", note: "no choice taken" };

    const choice = choices.find((c) => c.title === picked.id)!;
    run.record.choices.push({ step: step.id, title: choice.title, at: new Date().toISOString() });
    run.save();
    out(`  ▸ ${choice.title}`);

    if (choice.stop) return { status: "done", note: `chose "${choice.title}"` };

    if (choice.run) {
      const child = await chain(o, choice, prompts);
      if (!child) continue;
      return {
        status: "done",
        note: `chose "${choice.title}" → ${choice.run} run ${child}`,
        chained: true,
      };
    }

    if (choice.config) await ensureConfig(o, prompts, choice.config);

    const round = choice.round!;
    const key = `${slugify(choice.title)}-${taken(choice.title)}`;
    const first = await runRound(o, step, round, key, ctx, hostPane);
    hostPane = null;
    if (first.record.status !== "done") {
      out(`  ⚠ ${first.record.label} — ${first.record.error ?? "did not finish"}`);
      continue;
    }
    const findings = first.review?.findings ?? [];
    if (choice.followUp && findings.length > 0) {
      const next = await runRound(o, step, choice.followUp, `${key}-then`, ctx, null, {
        findings: formatFindings(findings),
      });
      if (next.record.status !== "done") {
        out(`  ⚠ ${next.record.label} — ${next.record.error ?? "did not finish"}`);
      }
    }
  }
}

/**
 * Starts the chosen Workflow as a child Run in this workspace and links it to this
 * one. Returns null when the human abandoned it at a question, so the menu comes back.
 */
async function chain(
  o: EngineOptions,
  choice: ChoiceDef,
  prompts: EnginePrompts,
): Promise<string | null> {
  const { run, out } = o;
  const child = resolveWorkflow(choice.run!, o.defs, o.defaults);
  const vars = { run: { dir: run.dir, id: run.id, slug: run.record.slug }, inputs: run.record.inputs, cwd: run.record.cwd };
  const forwarded: Record<string, string> = {};
  for (const [key, value] of Object.entries(choice.inputs ?? {})) {
    forwarded[key] = renderTemplate(value, vars).text;
  }

  const inputs: Record<string, string> = {};
  const sources: Record<string, string> = {};
  for (const r of await inferInputs(child.inputs, { cwd: run.record.cwd, stateDir: o.env.stateDir })) {
    if (forwarded[r.name] !== undefined) {
      inputs[r.name] = forwarded[r.name]!;
      sources[r.name] = `chained from ${run.id}`;
      continue;
    }
    if (!r.needsAsking) {
      inputs[r.name] = r.value;
      sources[r.name] = r.source;
      continue;
    }
    const answer = await prompts.ask(r.question);
    if (answer === null || answer.trim() === "") {
      out(`  ${choice.run} needs "${r.name}" — nothing started`);
      return null;
    }
    inputs[r.name] = answer.trim();
    sources[r.name] = "asked";
  }

  // The parent already names the work, so the child inherits its name.
  const prefix = `${run.record.workflow}-`;
  const tail = run.record.slug.startsWith(prefix) ? run.record.slug.slice(prefix.length) : run.record.slug;
  const childRun = new RunStore(o.env.stateDir).create({
    workflow: child.name,
    cwd: run.record.cwd,
    inputs,
    inputSources: sources,
    stepIds: child.steps.map((s) => s.id),
    maxIterations: child.maxIterations,
    primaryInput: tail,
    parent: run.id,
  });
  childRun.log(`chained from ${run.id}`);
  run.record.children.push(childRun.id);
  run.save();
  out(`  ▸ ${child.name} run ${childRun.id}`);

  await o.herdr.pluginPaneOpen({
    entrypoint: "runner",
    env: { HERDR_WORKFLOWS_RUN: childRun.id, HERDR_WORKFLOWS_CWD: run.record.cwd },
    focus: true,
    workspaceId: o.env.workspaceId,
    cwd: run.record.cwd,
  });
  return childRun.id;
}

/** One agent round inside a Choice: a Step in every way except its own id. */
async function runRound(
  o: EngineOptions,
  step: ResolvedStep,
  round: RoundDef,
  key: string,
  ctx: RunCtx,
  host: string | null,
  extraVars?: Record<string, unknown>,
): Promise<VariantOutcome> {
  const synth: ResolvedStep = {
    ...round,
    id: step.id,
    skill: round.skill,
    persona: round.persona ?? step.persona,
    origin: step.origin,
    preamble: step.preamble,
    prompt: round.prompt,
    known: step.known,
    choices: undefined,
  };
  const variant = roundVariant(round, step, o.defaults);
  const outcomes = await runStep(o, synth, [variant], [key], ctx, host, extraVars);
  const outcome = outcomes[0]!;
  o.run.step(step.id).variants.push(outcome.record);
  ctx.outputs.set(step.id, [outcome]);
  o.run.save();
  const mark = outcome.record.status === "done" ? "✓" : "⚠";
  await markTab(o.herdr, outcome.record, mark);
  return outcome;
}

function choiceHint(choice: ChoiceDef): string {
  if (choice.run) return `runs ${choice.run}`;
  if (choice.stop) return "ends here";
  return choice.round?.agent ? `prompts ${choice.round.agent}` : "a fresh agent";
}

/** A value the human is asked for once and that stays in config.json. */
async function ensureConfig(
  o: EngineOptions,
  prompts: EnginePrompts,
  cfg: { key: string; question: string },
): Promise<void> {
  if (configValue(readConfig(o.env.configDir), cfg.key) !== undefined) return;
  const answer = await prompts.ask(cfg.question);
  if (answer === null || answer.trim() === "") return;
  writeConfigValue(o.env.configDir, cfg.key, answer.trim());
  o.out(`  saved ${cfg.key} in config.json`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** herdr says this when the harness stopped on a prompt before it was ready to work. */
function blockedAtStartup(e: unknown): boolean {
  return e instanceof HerdrError && /agent_not_ready|blocked during startup/.test(e.detail);
}

/**
 * A harness may stop on a first-run prompt — claude asks before it will work in a
 * directory it has not been trusted with, and the dialog cannot be answered from here:
 * it shuffles its options, so there is no safe key to send. The agent exists and is
 * blocked, so this waits for the human exactly as a Step waits for an Output.
 */
async function startAgent(
  o: EngineOptions,
  step: ResolvedStep,
  opts: { name: string; kind: string; paneId: string; args: string[] },
): Promise<void> {
  try {
    await o.herdr.agentStart(opts);
    return;
  } catch (e) {
    if (!blockedAtStartup(e)) throw e;
    const budget = o.handoffTimeoutMs ?? 0;
    o.out(`  ⏸ ${opts.name} is waiting for you in its pane — answer the prompt there`);
    o.run.log(`${opts.name}: blocked at startup, waiting for the human`);
    try {
      await o.herdr.notify(
        `${o.run.record.slug} needs you`,
        `${step.id}: answer the prompt in its pane`,
        "request",
      );
    } catch {
      /* a missing toast must not fail the run */
    }
    const deadline = Date.now() + budget;
    while (Date.now() < deadline) {
      await sleep(Math.min(o.outputPollMs ?? 2000, Math.max(1, deadline - Date.now())));
      if ((await o.herdr.agentStatus(opts.name)) !== "blocked") {
        o.out(`  ▸ ${opts.name} is ready`);
        return;
      }
    }
    throw e;
  }
}

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
    collectList(o, "deferred", parsed);
    // A re-run step must not double-report what it disputed last time.
    for (const finding of review.disputed) {
      const key = findingKey(finding);
      if (!o.run.record.disputed.some((d) => findingKey(d) === key)) {
        o.run.record.disputed.push(finding);
      }
    }
  }

  record.status = "done";
  return { record, output: parsed, review };
}

/** Appends an Output's `deferred` entries to the run, without repeating one. */
function collectList(o: EngineOptions, key: "deferred", parsed: unknown): void {
  const raw = (parsed as Record<string, unknown>)[key];
  if (!Array.isArray(raw)) return;
  const result = parseFindings(raw, `${key}`);
  if (!result.ok) return;
  for (const finding of result.value) {
    const id = findingKey(finding);
    if (!o.run.record[key].some((f) => findingKey(f) === id)) o.run.record[key].push(finding);
  }
}

/** The agent of an earlier step, but only one this process actually started. */
function borrowedAgent(o: EngineOptions, step: ResolvedStep, ctx: RunCtx): VariantRecord | null {
  if (!step.agent) return null;
  if (ctx.ran.has(step.agent)) return o.run.step(step.agent).variants[0] ?? null;
  // On a resumed run the named step is long gone; the group's first agent stands in.
  return ctx.groups.get(step.agent) ?? null;
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
  extraVars?: Record<string, unknown>,
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
    disputed: formatFindings(o.run.record.disputed),
    run: { dir: o.run.dir, id: o.run.id, slug: o.run.record.slug },
    output_path: outputPath,
    iteration: String(o.run.record.iteration),
    max_iterations: String(o.run.record.max_iterations),
    cwd: o.run.record.cwd,
    step: step.id,
    harness: variant.harness,
    model: variant.model,
    effort: variant.effort ?? "",
    config: readConfig(o.env.configDir),
    ...extraVars,
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
  return source ? verdictOf(source, o.run.record.disputed).findings : [];
}

interface Verdict {
  clean: boolean;
  /** What the fix step gets: everything except what is already settled. */
  findings: Finding[];
  settled: Finding[];
  rebutted: Finding[];
}

function verdictOf(outcomes: VariantOutcome[], disputed: Finding[]): Verdict {
  const reviews = outcomes.map((v) => v.review).filter((r): r is ReviewOutput => r !== null);
  const split = splitDisputed(unionFindings(reviews), disputed);
  // Clean means "nothing left for the implementer", not "nobody said anything":
  // a finding the implementer already rejected with a reason is the human's call.
  return {
    clean: reviews.length > 0 && split.live.length === 0,
    findings: split.live,
    settled: split.settled,
    rebutted: split.rebutted,
  };
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
  if (run.record.choices.length > 0) {
    lines.push("", "Choices:", ...run.record.choices.map((c) => `  ${c.step}: ${c.title}`));
  }
  if (run.record.children.length > 0) {
    lines.push("", `Chained: ${run.record.children.join(", ")}`);
  }
  if (run.record.deferred.length > 0) {
    lines.push("", "Deferred (the architect did not apply these):", formatFindings(run.record.deferred));
  }
  if (run.record.disputed.length > 0) {
    lines.push(
      "",
      "Disputed findings (the implementer did not apply these; the loop stopped arguing about them):",
      formatFindings(run.record.disputed),
    );
  }
  return lines.join("\n");
}
