// Workflow and Persona definitions across the three Layers: baseline (this repo),
// the user's plugin config dir, and the project's .herdr/. Later wins by name.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parseDocument, YamlError } from "./yaml";
import { HARNESSES, harnessNames, knownModel, modelHint } from "./harness";
import type { Defaults } from "./config";

export type LayerName = "baseline" | "user" | "project";

export interface Layer {
  name: LayerName;
  dir: string;
}

export const INPUT_STRATEGIES = ["goal", "plan-dir", "diff-target", "ticket", "issue", "flag"] as const;
export type InputStrategy = (typeof INPUT_STRATEGIES)[number];

export interface Variant {
  harness: string;
  model: string;
  effort?: string;
}

/** What one agent round of a Choice runs; `prompt:` names the body section. */
export interface RoundDef {
  section: string;
  /** The section's text, filled in when the workflow is resolved. */
  prompt: string;
  agent?: string;
  skill?: string;
  persona?: string;
  harness?: string;
  model?: string;
  effort?: string;
  fresh?: boolean;
  output?: string;
}

export interface ChoiceDef {
  title: string;
  /** Exactly one of these three: chain a Workflow, prompt an agent, or just end. */
  run?: string;
  round?: RoundDef;
  stop?: boolean;
  /** Inputs forwarded to a chained Workflow; values are templated. */
  inputs?: Record<string, string>;
  /** How often this choice may be taken in one Run. */
  max?: number;
  /** A config.json value the round needs; asked once, then remembered. */
  config?: { key: string; question: string };
  /** Run only when the first round reported findings. */
  followUp?: RoundDef;
}

export interface StepDef {
  id: string;
  persona?: string;
  harness?: string;
  model?: string;
  effort?: string;
  fresh?: boolean;
  output?: string;
  /** Continue the agent started by this earlier step instead of starting a new one. */
  agent?: string;
  /** Send the prompt as `/<skill> …`, which is the only way to run a user-only skill. */
  skill?: string;
  parallel?: Variant[];
  use?: string;
  /** A body section other than the step's own id; see ADR-0002 workflows design. */
  promptSection?: string;
  choices?: ChoiceDef[];
  /** Only run this step when its workflow is the one being run, not when embedded. */
  standalone?: boolean;
  /** `from` is the gate; `back_to` is the earliest step to run again (default `from`). */
  repeat?: { from: string; back_to?: string; max?: number };
}

export interface WorkflowDef {
  name: string;
  title: string;
  description: string;
  inputs: Record<string, InputStrategy>;
  maxIterations: number | null;
  steps: StepDef[];
  body: string;
  path: string;
  layer: LayerName;
}

export interface PersonaDef {
  name: string;
  description: string;
  body: string;
  path: string;
  layer: LayerName;
}

export interface Definitions {
  workflows: Map<string, WorkflowDef>;
  personas: Map<string, PersonaDef>;
  errors: string[];
}

export function layers(env: { pluginRoot: string; configDir: string; cwd: string }): Layer[] {
  return [
    { name: "baseline", dir: env.pluginRoot },
    { name: "user", dir: env.configDir },
    { name: "project", dir: join(env.cwd, ".herdr") },
  ];
}

function markdownFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => join(dir, f));
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function parseWorkflow(path: string, layer: LayerName): WorkflowDef {
  const { data, body } = parseDocument(readFileSync(path, "utf8"));
  const stem = basename(path, ".md");
  const rawInputs = (data.inputs ?? {}) as Record<string, unknown>;
  const inputs: Record<string, InputStrategy> = {};
  for (const [key, value] of Object.entries(rawInputs)) {
    inputs[key] = str(value) as InputStrategy;
  }
  const rawSteps = Array.isArray(data.steps) ? data.steps : [];
  const steps: StepDef[] = rawSteps.map((raw, i) => {
    const s = (raw ?? {}) as Record<string, unknown>;
    const step: StepDef = { id: str(s.id, `step-${i + 1}`) };
    if (typeof s.persona === "string") step.persona = s.persona;
    if (typeof s.harness === "string") step.harness = s.harness;
    if (typeof s.model === "string") step.model = s.model;
    if (typeof s.effort === "string") step.effort = s.effort;
    if (typeof s.fresh === "boolean") step.fresh = s.fresh;
    if (typeof s.output === "string") step.output = s.output;
    if (typeof s.agent === "string") step.agent = s.agent;
    if (typeof s.skill === "string") step.skill = s.skill;
    if (typeof s.use === "string") step.use = s.use;
    if (Array.isArray(s.parallel)) {
      step.parallel = s.parallel.map((v) => {
        const o = (v ?? {}) as Record<string, unknown>;
        const variant: Variant = { harness: str(o.harness), model: str(o.model) };
        if (typeof o.effort === "string") variant.effort = o.effort;
        return variant;
      });
    }
    if (typeof s.prompt === "string") step.promptSection = s.prompt;
    if (s.standalone === true) step.standalone = true;
    if (Array.isArray(s.choices)) step.choices = s.choices.map(parseChoice);
    if (s.repeat && typeof s.repeat === "object") {
      const r = s.repeat as Record<string, unknown>;
      step.repeat = { from: str(r.from) };
      if (typeof r.back_to === "string") step.repeat.back_to = r.back_to;
      if (typeof r.max === "number") step.repeat.max = r.max;
    }
    return step;
  });

  return {
    name: str(data.name, stem),
    title: str(data.title, str(data.name, stem)),
    description: str(data.description),
    inputs,
    maxIterations: typeof data.max_iterations === "number" ? data.max_iterations : null,
    steps,
    body,
    path,
    layer,
  };
}

function parseRound(raw: Record<string, unknown>): RoundDef | undefined {
  if (typeof raw.prompt !== "string") return undefined;
  const round: RoundDef = { section: raw.prompt, prompt: "" };
  for (const key of ["agent", "persona", "harness", "model", "effort", "output", "skill"] as const) {
    if (typeof raw[key] === "string") round[key] = raw[key] as string;
  }
  if (typeof raw.fresh === "boolean") round.fresh = raw.fresh;
  return round;
}

function parseChoice(raw: unknown): ChoiceDef {
  const c = (raw ?? {}) as Record<string, unknown>;
  const choice: ChoiceDef = { title: str(c.title) };
  if (typeof c.run === "string") choice.run = c.run;
  if (c.stop === true) choice.stop = true;
  if (typeof c.max === "number") choice.max = c.max;
  const round = parseRound(c);
  if (round) choice.round = round;
  if (c.inputs && typeof c.inputs === "object") {
    const inputs: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.inputs as Record<string, unknown>)) inputs[k] = str(v);
    choice.inputs = inputs;
  }
  if (c.config && typeof c.config === "object") {
    const cfg = c.config as Record<string, unknown>;
    choice.config = { key: str(cfg.key), question: str(cfg.question) };
  }
  if (c.follow_up && typeof c.follow_up === "object") {
    const follow = parseRound(c.follow_up as Record<string, unknown>);
    if (follow) choice.followUp = follow;
  }
  return choice;
}

function parsePersona(path: string, layer: LayerName): PersonaDef {
  const { data, body } = parseDocument(readFileSync(path, "utf8"));
  return {
    name: str(data.name, basename(path, ".md")),
    description: str(data.description),
    body,
    path,
    layer,
  };
}

export function loadDefinitions(ls: Layer[]): Definitions {
  const workflows = new Map<string, WorkflowDef>();
  const personas = new Map<string, PersonaDef>();
  const errors: string[] = [];

  for (const layer of ls) {
    for (const path of markdownFiles(join(layer.dir, "workflows"))) {
      try {
        const wf = parseWorkflow(path, layer.name);
        workflows.set(wf.name, wf);
      } catch (e) {
        errors.push(`${path}: ${e instanceof YamlError ? e.message : (e as Error).message}`);
      }
    }
    for (const path of markdownFiles(join(layer.dir, "personas"))) {
      try {
        const persona = parsePersona(path, layer.name);
        personas.set(persona.name, persona);
      } catch (e) {
        errors.push(`${path}: ${e instanceof YamlError ? e.message : (e as Error).message}`);
      }
    }
  }

  return { workflows, personas, errors };
}

/** Body split into a shared preamble plus one section per `## <step-id>` heading. */
export function bodySections(body: string): { preamble: string; sections: Map<string, string> } {
  const sections = new Map<string, string>();
  const lines = body.split("\n");
  const preamble: string[] = [];
  let current: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current !== null) sections.set(current, buf.join("\n").trim());
    buf = [];
  };
  for (const line of lines) {
    const m = /^##\s+(\S+)\s*$/.exec(line);
    if (m) {
      flush();
      current = m[1]!;
      continue;
    }
    if (current === null) preamble.push(line);
    else buf.push(line);
  }
  flush();
  return { preamble: preamble.join("\n").trim(), sections };
}

export interface ResolvedStep extends StepDef {
  /** Which workflow file this step's prompt came from; `use:` makes it differ. */
  origin: string;
  prompt: string;
  preamble: string;
  /** Section names the origin body offers, for the error message when one is missing. */
  known: string[];
}

export interface ResolvedWorkflow {
  name: string;
  title: string;
  description: string;
  inputs: Record<string, InputStrategy>;
  maxIterations: number;
  steps: ResolvedStep[];
  layer: LayerName;
  path: string;
}

export class DefinitionError extends Error {}

export function resolveWorkflow(
  name: string,
  defs: Definitions,
  defaults: Defaults,
): ResolvedWorkflow {
  const wf = defs.workflows.get(name);
  if (!wf) {
    const known = [...defs.workflows.keys()].sort().join(", ") || "none";
    throw new DefinitionError(`unknown workflow "${name}" (known: ${known})`);
  }
  const inherited: Record<string, InputStrategy> = {};
  const steps = expand(wf, defs, [wf.name], inherited);
  // An embedded workflow brings its own Inputs, but the embedder's come first and
  // win: the first one names the Run.
  const inputs: Record<string, InputStrategy> = { ...wf.inputs };
  for (const [key, strategy] of Object.entries(inherited)) {
    if (!(key in inputs)) inputs[key] = strategy;
  }
  return {
    name: wf.name,
    title: wf.title,
    description: wf.description,
    inputs,
    maxIterations: wf.maxIterations ?? defaults.maxIterations,
    steps,
    layer: wf.layer,
    path: wf.path,
  };
}

function expand(
  wf: WorkflowDef,
  defs: Definitions,
  chain: string[],
  inherited: Record<string, InputStrategy>,
): ResolvedStep[] {
  const { preamble, sections } = bodySections(wf.body);
  const single = wf.steps.length === 1 && sections.size === 0;
  const out: ResolvedStep[] = [];

  for (const step of wf.steps) {
    // A Choice needs the human, and an embedding workflow decides what comes next,
    // so a standalone step is dropped as soon as this workflow is embedded.
    if (step.standalone && chain.length > 1) continue;
    if (step.use) {
      if (chain.includes(step.use)) {
        throw new DefinitionError(`workflow "${chain[0]}" embeds "${step.use}" in a cycle: ${[...chain, step.use].join(" -> ")}`);
      }
      const inner = defs.workflows.get(step.use);
      if (!inner) {
        const known = [...defs.workflows.keys()].sort().join(", ") || "none";
        throw new DefinitionError(
          `workflow "${wf.name}" step "${step.id}" uses unknown workflow "${step.use}" (known: ${known})`,
        );
      }
      for (const [key, strategy] of Object.entries(inner.inputs)) inherited[key] = strategy;
      const embedded = expand(inner, defs, [...chain, inner.name], inherited);
      // The embedder may pick a different section of the embedded body, so one
      // workflow can carry an attended and an unattended prompt.
      const innerSections = bodySections(inner.body).sections;
      const override = step.promptSection
        ? {
            promptSection: step.promptSection,
            prompt: innerSections.get(step.promptSection) ?? "",
            known: [...innerSections.keys()],
          }
        : {};
      // Prefixed ids mean the embedded steps' own back-references must move too.
      const ids = new Map(
        embedded.map((child) => [child.id, embedded.length === 1 ? step.id : `${step.id}.${child.id}`]),
      );
      const rebase = (id: string | undefined) => (id !== undefined ? (ids.get(id) ?? id) : undefined);
      for (const child of embedded) {
        out.push({
          ...child,
          ...override,
          // The embedding step's own settings win over the embedded defaults.
          id: ids.get(child.id)!,
          persona: step.persona ?? child.persona,
          harness: step.harness ?? child.harness,
          model: step.model ?? child.model,
          effort: step.effort ?? child.effort,
          fresh: step.fresh ?? child.fresh,
          output: step.output ?? child.output,
          parallel: step.parallel ?? child.parallel,
          repeat: step.repeat ?? rebaseRepeat(child.repeat, rebase),
          agent: step.agent ?? rebase(child.agent),
          skill: step.skill ?? child.skill,
          ...(child.choices ? { choices: child.choices.map((c) => rebaseChoice(c, rebase)) } : {}),
        });
      }
      continue;
    }
    const section = step.promptSection ?? step.id;
    out.push({
      ...step,
      origin: wf.name,
      // A body with no headings IS the prompt, so it must not also be the preamble.
      preamble: single ? "" : preamble,
      prompt: single ? wf.body : (sections.get(section) ?? ""),
      known: [...sections.keys()],
      ...(step.choices ? { choices: step.choices.map((c) => resolveChoice(c, sections)) } : {}),
    });
  }
  return out;
}

type Rebase = (id: string | undefined) => string | undefined;

function rebaseRepeat(repeat: StepDef["repeat"], rebase: Rebase): StepDef["repeat"] {
  if (!repeat) return undefined;
  return {
    ...repeat,
    from: rebase(repeat.from)!,
    ...(repeat.back_to ? { back_to: rebase(repeat.back_to)! } : {}),
  };
}

function rebaseRound(round: RoundDef, rebase: Rebase): RoundDef {
  return round.agent ? { ...round, agent: rebase(round.agent)! } : round;
}

function rebaseChoice(choice: ChoiceDef, rebase: Rebase): ChoiceDef {
  return {
    ...choice,
    ...(choice.round ? { round: rebaseRound(choice.round, rebase) } : {}),
    ...(choice.followUp ? { followUp: rebaseRound(choice.followUp, rebase) } : {}),
  };
}

function resolveRound(round: RoundDef, sections: Map<string, string>): RoundDef {
  return { ...round, prompt: sections.get(round.section) ?? "" };
}

function resolveChoice(choice: ChoiceDef, sections: Map<string, string>): ChoiceDef {
  return {
    ...choice,
    ...(choice.round ? { round: resolveRound(choice.round, sections) } : {}),
    ...(choice.followUp ? { followUp: resolveRound(choice.followUp, sections) } : {}),
  };
}

export function validateWorkflow(
  wf: ResolvedWorkflow,
  defs: Definitions,
  defaults: Defaults,
): string[] {
  const errors: string[] = [];
  const where = (stepId: string) => `workflow "${wf.name}" step "${stepId}"`;

  for (const [input, strategy] of Object.entries(wf.inputs)) {
    if (!(INPUT_STRATEGIES as readonly string[]).includes(strategy)) {
      errors.push(
        `workflow "${wf.name}" input "${input}": unknown strategy "${strategy}" (known: ${INPUT_STRATEGIES.join(", ")})`,
      );
    }
  }

  if (wf.steps.length === 0) errors.push(`workflow "${wf.name}" has no steps`);

  const seen = new Set<string>();
  for (const step of wf.steps) {
    if (seen.has(step.id)) errors.push(`${where(step.id)}: duplicate step id`);
    seen.add(step.id);

    const isChoice = (step.choices?.length ?? 0) > 0;
    const personaName = step.persona;
    if (!personaName && !isChoice) errors.push(`${where(step.id)}: no persona`);
    else if (personaName && !defs.personas.has(personaName)) {
      const known = [...defs.personas.keys()].sort().join(", ") || "none";
      errors.push(`${where(step.id)}: unknown persona "${personaName}" (known: ${known})`);
    }

    // A Choice step's "prompt" is its menu, so it needs no section of its own.
    if (step.prompt.trim() === "" && !isChoice) {
      errors.push(
        step.promptSection
          ? `${where(step.id)}: unknown prompt section "${step.promptSection}" in ${step.origin}.md (known: ${step.known.join(", ") || "none"})`
          : `${where(step.id)}: no prompt (add a "## ${step.id}" section to ${step.origin}.md)`,
      );
    }

    for (const combo of stepVariants(step, defaults)) {
      errors.push(...variantErrors(where(step.id), combo, defaults));
    }
    if (isChoice) errors.push(...choiceErrors(wf, step, defs, defaults));

    if (step.agent && !earlier(wf, step, step.agent)) {
      errors.push(`${where(step.id)}: agent "${step.agent}" is not an earlier step`);
    }
    if (step.repeat && !earlier(wf, step, step.repeat.from)) {
      errors.push(`${where(step.id)}: repeat.from "${step.repeat.from}" is not an earlier step`);
    }
    if (step.repeat?.back_to && !earlier(wf, step, step.repeat.back_to)) {
      errors.push(`${where(step.id)}: repeat.back_to "${step.repeat.back_to}" is not an earlier step`);
    }
    if (step.agent && step.fresh) {
      errors.push(`${where(step.id)}: agent and fresh are mutually exclusive`);
    }
  }

  return errors;
}

function variantErrors(where: string, combo: Variant, defaults: Defaults): string[] {
  const adapter = HARNESSES[combo.harness];
  if (!adapter) {
    return [`${where}: unknown harness "${combo.harness}" (known: ${harnessNames().join(", ")})`];
  }
  const errors: string[] = [];
  const extra = defaults.models[combo.harness] ?? [];
  if (!knownModel(adapter, combo.model, extra)) {
    errors.push(
      `${where}: unknown model "${combo.model}" for harness "${combo.harness}" (known: ${modelHint(adapter, extra)})`,
    );
  }
  if (combo.effort !== undefined) {
    if (!adapter.effortArgs) {
      errors.push(`${where}: harness "${combo.harness}" has no effort setting`);
    } else if (!(adapter.efforts ?? []).includes(combo.effort)) {
      errors.push(
        `${where}: unknown effort "${combo.effort}" for harness "${combo.harness}" (known: ${(adapter.efforts ?? []).join(", ")})`,
      );
    }
  }
  return errors;
}

function choiceErrors(
  wf: ResolvedWorkflow,
  step: ResolvedStep,
  defs: Definitions,
  defaults: Defaults,
): string[] {
  const errors: string[] = [];
  for (const [i, choice] of (step.choices ?? []).entries()) {
    const at = choice.title ? `choice "${choice.title}"` : `choice ${i + 1}`;
    const where = `workflow "${wf.name}" step "${step.id}" ${at}`;
    if (!choice.title) errors.push(`${where}: needs a title`);
    const forms = [choice.run, choice.round, choice.stop].filter((f) => f !== undefined).length;
    if (forms !== 1) errors.push(`${where}: needs exactly one of run, prompt or stop`);

    for (const round of [choice.round, choice.followUp]) {
      if (!round) continue;
      if (round.prompt.trim() === "") {
        errors.push(
          `${where}: unknown prompt section "${round.section}" in ${step.origin}.md (known: ${step.known.join(", ") || "none"})`,
        );
      }
      const persona = round.persona ?? step.persona;
      if (!round.agent && !persona) errors.push(`${where}: needs a persona or an agent`);
      if (persona && !defs.personas.has(persona)) {
        const known = [...defs.personas.keys()].sort().join(", ") || "none";
        errors.push(`${where}: unknown persona "${persona}" (known: ${known})`);
      }
      if (round.agent && !earlier(wf, step, round.agent)) {
        errors.push(`${where}: agent "${round.agent}" is not an earlier step`);
      }
      if (!round.output) errors.push(`${where}: needs an output, so the round can finish`);
      errors.push(...variantErrors(where, roundVariant(round, step, defaults), defaults));
    }

    if (choice.config && (!choice.config.key || !choice.config.question)) {
      errors.push(`${where}: config needs a key and a question`);
    }
    if (choice.max !== undefined && choice.max < 1) errors.push(`${where}: max must be at least 1`);
    if (choice.run) errors.push(...chainErrors(where, choice, defs, defaults));
  }
  return errors;
}

/** Chaining is checked here so a broken menu cannot open a single tab. */
function chainErrors(
  where: string,
  choice: ChoiceDef,
  defs: Definitions,
  defaults: Defaults,
): string[] {
  let child: ResolvedWorkflow;
  try {
    child = resolveWorkflow(choice.run!, defs, defaults);
  } catch (e) {
    return [`${where}: ${(e as Error).message}`];
  }
  const unknown = Object.keys(choice.inputs ?? {}).filter((k) => !(k in child.inputs));
  return unknown.length === 0
    ? []
    : [
        `${where}: workflow "${child.name}" has no input(s) ${unknown.join(", ")} (known: ${Object.keys(child.inputs).join(", ") || "none"})`,
      ];
}

/** The harness/model/effort one Choice round runs with. */
export function roundVariant(round: RoundDef, step: ResolvedStep, defaults: Defaults): Variant {
  const effort = round.effort ?? step.effort ?? defaults.effort;
  const variant: Variant = {
    harness: round.harness ?? step.harness ?? defaults.harness,
    model: round.model ?? step.model ?? defaults.model,
  };
  return effort === undefined ? variant : { ...variant, effort };
}

function earlier(wf: ResolvedWorkflow, step: ResolvedStep, id: string): boolean {
  const at = wf.steps.indexOf(step);
  return wf.steps.slice(0, at).some((s) => s.id === id);
}

/** Every harness/model/effort combination a step will run, one per parallel variant. */
export function stepVariants(step: StepDef, defaults: Defaults): Variant[] {
  const effortOf = (own?: string) => own ?? step.effort ?? defaults.effort;
  if (step.parallel && step.parallel.length > 0) {
    return step.parallel.map((v) => withEffort(
      {
        harness: v.harness || step.harness || defaults.harness,
        model: v.model || step.model || defaults.model,
      },
      effortOf(v.effort),
    ));
  }
  return [
    withEffort(
      { harness: step.harness ?? defaults.harness, model: step.model ?? defaults.model },
      effortOf(undefined),
    ),
  ];
}

function withEffort(variant: Variant, effort: string | undefined): Variant {
  return effort === undefined ? variant : { ...variant, effort };
}

/**
 * The name that distinguishes one parallel variant from another in tabs and agent
 * names. Harness and model are enough almost always; effort joins in when two
 * variants would otherwise share a name.
 */
export function variantKeys(variants: Variant[]): (string | null)[] {
  if (variants.length < 2) return variants.map(() => null);
  const base = variants.map((v) => `${v.harness}-${v.model}`);
  const withEfforts = variants.map((v, i) => (v.effort ? `${base[i]}-${v.effort}` : base[i]!));
  const keys = base.some((k, i) => base.indexOf(k) !== i) ? withEfforts : base;
  return keys.map((key, i) => (keys.indexOf(key) === i ? key : `${key}-${i + 1}`));
}
