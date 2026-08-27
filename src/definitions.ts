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

export const INPUT_STRATEGIES = ["goal", "plan-file", "diff-target", "ticket", "flag"] as const;
export type InputStrategy = (typeof INPUT_STRATEGIES)[number];

export interface Variant {
  harness: string;
  model: string;
}

export interface StepDef {
  id: string;
  persona?: string;
  harness?: string;
  model?: string;
  fresh?: boolean;
  output?: string;
  /** Continue the agent started by this earlier step instead of starting a new one. */
  agent?: string;
  parallel?: Variant[];
  use?: string;
  repeat?: { from: string; max?: number };
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
    if (typeof s.fresh === "boolean") step.fresh = s.fresh;
    if (typeof s.output === "string") step.output = s.output;
    if (typeof s.agent === "string") step.agent = s.agent;
    if (typeof s.use === "string") step.use = s.use;
    if (Array.isArray(s.parallel)) {
      step.parallel = s.parallel.map((v) => {
        const o = (v ?? {}) as Record<string, unknown>;
        return { harness: str(o.harness), model: str(o.model) };
      });
    }
    if (s.repeat && typeof s.repeat === "object") {
      const r = s.repeat as Record<string, unknown>;
      step.repeat = { from: str(r.from) };
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
      for (const child of embedded) {
        out.push({
          ...child,
          // The embedding step's own settings win over the embedded defaults.
          id: embedded.length === 1 ? step.id : `${step.id}.${child.id}`,
          persona: step.persona ?? child.persona,
          harness: step.harness ?? child.harness,
          model: step.model ?? child.model,
          fresh: step.fresh ?? child.fresh,
          output: step.output ?? child.output,
          parallel: step.parallel ?? child.parallel,
          repeat: step.repeat ?? child.repeat,
          agent: step.agent ?? child.agent,
        });
      }
      continue;
    }
    out.push({
      ...step,
      origin: wf.name,
      preamble,
      prompt: single ? wf.body : (sections.get(step.id) ?? ""),
    });
  }
  return out;
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

    const personaName = step.persona;
    if (!personaName) errors.push(`${where(step.id)}: no persona`);
    else if (!defs.personas.has(personaName)) {
      const known = [...defs.personas.keys()].sort().join(", ") || "none";
      errors.push(`${where(step.id)}: unknown persona "${personaName}" (known: ${known})`);
    }

    if (step.prompt.trim() === "") {
      errors.push(`${where(step.id)}: no prompt (add a "## ${step.id}" section to ${step.origin}.md)`);
    }

    for (const combo of stepVariants(step, defaults)) {
      const adapter = HARNESSES[combo.harness];
      if (!adapter) {
        errors.push(
          `${where(step.id)}: unknown harness "${combo.harness}" (known: ${harnessNames().join(", ")})`,
        );
        continue;
      }
      const extra = defaults.models[combo.harness] ?? [];
      if (!knownModel(adapter, combo.model, extra)) {
        errors.push(
          `${where(step.id)}: unknown model "${combo.model}" for harness "${combo.harness}" (known: ${modelHint(adapter, extra)})`,
        );
      }
    }

    if (step.agent && !earlier(wf, step, step.agent)) {
      errors.push(`${where(step.id)}: agent "${step.agent}" is not an earlier step`);
    }
    if (step.repeat && !earlier(wf, step, step.repeat.from)) {
      errors.push(`${where(step.id)}: repeat.from "${step.repeat.from}" is not an earlier step`);
    }
    if (step.agent && step.fresh) {
      errors.push(`${where(step.id)}: agent and fresh are mutually exclusive`);
    }
  }

  return errors;
}

function earlier(wf: ResolvedWorkflow, step: ResolvedStep, id: string): boolean {
  const at = wf.steps.indexOf(step);
  return wf.steps.slice(0, at).some((s) => s.id === id);
}

/** Every harness/model pair a step will run, one per parallel variant. */
export function stepVariants(step: StepDef, defaults: Defaults): Variant[] {
  if (step.parallel && step.parallel.length > 0) {
    return step.parallel.map((v) => ({
      harness: v.harness || step.harness || defaults.harness,
      model: v.model || step.model || defaults.model,
    }));
  }
  return [{ harness: step.harness ?? defaults.harness, model: step.model ?? defaults.model }];
}
