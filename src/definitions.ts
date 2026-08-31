// Workflow and Persona definitions across the three Layers: baseline (this repo),
// the user's plugin config dir, and the project's .herdr/. Later wins by name.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { skillsIn } from "./template";
import { unsafePathComponent } from "./naming";
import { parseDocument, YamlError } from "./yaml";
import { DEFAULT_MODEL, HARNESSES, harnessNames, knownModel, modelHint } from "./harness";
import type { Defaults } from "./config";

export type LayerName = "baseline" | "user" | "project";

export interface Layer {
  name: LayerName;
  dir: string;
}

export const INPUT_STRATEGIES = ["goal", "plan-dir", "work-source", "diff-target", "ticket", "flag"] as const;

/** What a step may declare it needs before it is worth starting. */
export const STEP_REQUIREMENTS = ["gitlab", "mr-target"] as const;
export type StepRequirement = (typeof STEP_REQUIREMENTS)[number];
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
  /** Exactly one of these five: chain a Workflow, prompt an agent, post the run's
   * review to the merge request it reviewed, hand it to a live agent, or just end. */
  run?: string;
  round?: RoundDef;
  stop?: boolean;
  post?: boolean;
  /** Give this Run's result to the Session's live agent for that role. */
  handoff?: string;
  /** Offer this only when no agent for that role is live in this Session. */
  unless?: string;
  /** What the environment has to provide for this choice to be offered at all. */
  requires?: StepRequirement[];
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
  /** Skipped, with a note, when this run cannot give the step what it asks for. */
  requires?: StepRequirement[];
  /** This step reconciles that earlier step's parallel Outputs into one. */
  fanIn?: string;
  /** `from` is the gate; `back_to` is the earliest step to run again (default `from`). */
  repeat?: { from: string; back_to?: string; max?: number };
}

/** What every definition carries about where it came from and what it is built on. */
export interface Provenance {
  path: string;
  layer: LayerName;
  /** The definition this one changes only part of, resolved through the layers below. */
  extends?: string;
  /** For a full copy: the parent's content hash when the copy was taken. */
  forkedFromHash?: string;
  /** The parent's content hash now, so a stale full copy can be spotted. */
  parentHash?: string;
}

export interface WorkflowDef extends Provenance {
  name: string;
  title: string;
  description: string;
  inputs: Record<string, InputStrategy>;
  maxIterations: number | null;
  steps: StepDef[];
  body: string;
}

export interface PersonaDef extends Provenance {
  name: string;
  description: string;
  body: string;
}

/** A full copy whose parent has changed since: what it copied is no longer what it forked. */
export function isStale(def: Provenance): boolean {
  return Boolean(def.forkedFromHash && def.parentHash && def.forkedFromHash !== def.parentHash);
}

export function contentHash(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 12);
}

export interface Definitions {
  workflows: Map<string, WorkflowDef>;
  personas: Map<string, PersonaDef>;
  errors: string[];
}

/**
 * Where the skills themselves live. They are shared across harnesses and installed
 * by skills.sh, so a missing one is a missing prerequisite — like the harness binary
 * — not a definition error to work around.
 */
export function skillDirs(env: { home: string; cwd: string }): string[] {
  return [join(env.cwd, ".agents", "skills"), join(env.home, ".agents", "skills")];
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
    const requires = parseRequires(s.requires);
    if (requires) step.requires = requires;
    if (typeof s.fan_in === "string") step.fanIn = s.fan_in;
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
    ...(typeof data.extends === "string" ? { extends: data.extends } : {}),
    ...(typeof data.forked_from_hash === "string" ? { forkedFromHash: data.forked_from_hash } : {}),
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

/** `requires: gitlab` and `requires: [mr-target, gitlab]` are the same thing. */
function parseRequires(raw: unknown): StepRequirement[] | undefined {
  if (typeof raw === "string") return [raw as StepRequirement];
  if (Array.isArray(raw)) return raw.filter((r) => typeof r === "string") as StepRequirement[];
  return undefined;
}

function parseChoice(raw: unknown): ChoiceDef {
  const c = (raw ?? {}) as Record<string, unknown>;
  const choice: ChoiceDef = { title: str(c.title) };
  if (typeof c.run === "string") choice.run = c.run;
  if (c.stop === true) choice.stop = true;
  if (c.post === true) choice.post = true;
  if (typeof c.handoff === "string") choice.handoff = c.handoff;
  if (typeof c.unless === "string") choice.unless = c.unless;
  const requires = parseRequires(c.requires);
  if (requires) choice.requires = requires;
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
    ...(typeof data.extends === "string" ? { extends: data.extends } : {}),
    ...(typeof data.forked_from_hash === "string" ? { forkedFromHash: data.forked_from_hash } : {}),
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
    loadLayer(workflows, layer, "workflows", parseWorkflow, mergeWorkflow, errors);
    loadLayer(personas, layer, "personas", parsePersona, mergePersona, errors);
  }

  return { workflows, personas, errors };
}

/**
 * One layer of one kind. A file that names no parent replaces what the layers below
 * had; a file with `extends:` changes only what it names, and is resolved in
 * dependency order so a parent in the same layer is merged before its child.
 */
function loadLayer<T extends Provenance & { name: string }>(
  into: Map<string, T>,
  layer: Layer,
  kind: "workflows" | "personas",
  parse: (path: string, layer: LayerName) => T,
  merge: (parent: T, child: T) => T,
  errors: string[],
): void {
  const parsed = new Map<string, T>();
  for (const path of markdownFiles(join(layer.dir, kind))) {
    try {
      const def = parse(path, layer.name);
      parsed.set(def.name, def);
    } catch (e) {
      errors.push(`${path}: ${e instanceof YamlError ? e.message : (e as Error).message}`);
    }
  }

  const settled = new Set<string>();
  const resolve = (name: string, chain: string[]): void => {
    if (settled.has(name)) return;
    const def = parsed.get(name);
    if (!def) return;
    settled.add(name);

    // What this file is built on, before it goes in: the same name from a lower
    // layer is the usual case, and another name in this layer is resolved first.
    const parentName = def.extends;
    if (!parentName) {
      into.set(name, withParentHash(def, into));
      return;
    }
    if (chain.includes(parentName)) {
      errors.push(`${def.path}: extends cycle (${[...chain, parentName].join(" → ")})`);
      return;
    }
    if (parsed.has(parentName) && parentName !== name) resolve(parentName, [...chain, name]);

    const parent = into.get(parentName);
    if (!parent) {
      errors.push(`${def.path}: extends "${parentName}", which no layer below this one defines`);
      return;
    }
    into.set(name, withParentHash(merge(parent, def), into));
  };
  for (const name of parsed.keys()) resolve(name, []);
}

/**
 * The hash of the file this definition shadows, so a full copy whose original has
 * moved on can be spotted. Only a full copy carries a hash to compare against.
 */
function withParentHash<T extends Provenance & { name: string }>(def: T, into: Map<string, T>): T {
  if (!def.forkedFromHash) return def;
  const shadowed = into.get(def.name);
  const parentHash = shadowed ? readHash(shadowed.path) : undefined;
  return parentHash ? { ...def, parentHash } : def;
}

function readHash(path: string): string | undefined {
  try {
    return contentHash(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** The parent with the child's frontmatter and sections laid over it. */
function mergeWorkflow(parent: WorkflowDef, child: WorkflowDef): WorkflowDef {
  const byId = new Map(child.steps.map((s) => [s.id, s]));
  const steps: StepDef[] = parent.steps.map((step) => {
    const over = byId.get(step.id);
    byId.delete(step.id);
    // `parallel` and `choices` are lists a human reasons about whole, so a child
    // that names either replaces it rather than merging entries positionally.
    return over ? { ...step, ...over } : step;
  });
  // A child step with an id the parent does not have is new work, appended in order.
  for (const step of child.steps) if (byId.has(step.id)) steps.push(step);

  return {
    ...parent,
    ...pick(child, ["name", "path", "layer", "extends", "forkedFromHash"]),
    // A file with no `title:` is parsed as titled after itself, so that is what
    // "the child did not name one" looks like here.
    title: child.title && child.title !== child.name ? child.title : parent.title,
    description: child.description || parent.description,
    inputs: { ...parent.inputs, ...child.inputs },
    maxIterations: child.maxIterations ?? parent.maxIterations,
    steps,
    body: mergeBody(parent.body, child.body),
  };
}

function mergePersona(parent: PersonaDef, child: PersonaDef): PersonaDef {
  return {
    ...parent,
    ...pick(child, ["name", "path", "layer", "extends", "forkedFromHash"]),
    description: child.description || parent.description,
    body: mergeBody(parent.body, child.body),
  };
}

function pick<T, K extends keyof T>(from: T, keys: K[]): Partial<T> {
  const out: Partial<T> = {};
  for (const key of keys) if (from[key] !== undefined) out[key] = from[key];
  return out;
}

/**
 * Section by section: a child's `## <name>` replaces the parent's of the same name,
 * new ones are appended, and the preamble is replaced only when the child has one.
 * The result is rebuilt rather than spliced, so the merged body is normalised —
 * which is what every reader of it already assumes.
 */
function mergeBody(parent: string, child: string): string {
  const a = bodySections(parent);
  const b = bodySections(child);
  const sections = new Map(a.sections);
  for (const [name, text] of b.sections) sections.set(name, text);

  const preamble = b.preamble.trim() === "" ? a.preamble : b.preamble;
  const parts = [preamble.trim()];
  for (const [name, text] of sections) parts.push(`## ${name}\n\n${text}`);
  return `${parts.filter((p) => p !== "").join("\n\n")}\n`;
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
  /** Inputs that arrived only from an embedded workflow, so this run must not ask for them. */
  embeddedInputs: string[];
  maxIterations: number;
  steps: ResolvedStep[];
  layer: LayerName;
  path: string;
}

/**
 * Every skill this Workflow asks for that is not installed. Named one per line with
 * the command that installs it: a run that starts without them wastes an agent's
 * whole turn discovering the same thing.
 */
function missingSkills(wf: ResolvedWorkflow, defs: Definitions, dirs: string[]): string[] {
  const asked = new Map<string, string>();
  const note = (name: string, by: string) => {
    if (!asked.has(name)) asked.set(name, by);
  };
  for (const step of wf.steps) {
    if (step.skill) note(step.skill, `${wf.name} step "${step.id}"`);
    for (const name of skillsIn(`${step.preamble}\n${step.prompt}`)) note(name, `${wf.name} step "${step.id}"`);
    const persona = step.persona ? defs.personas.get(step.persona) : undefined;
    if (persona) for (const name of skillsIn(persona.body)) note(name, `persona "${persona.name}"`);
  }

  const errors: string[] = [];
  for (const [name, by] of asked) {
    if (dirs.some((dir) => existsSync(join(dir, name)))) continue;
    errors.push(`${by}: the skill "${name}" is not installed — run \`npx skills add ${name}\``);
  }
  return errors;
}

export class DefinitionError extends Error {}

/** The error for one Workflow-controlled name, or nothing when it is safe. */
function nameErrors(where: string, label: string, value: string, names: string): string[] {
  const bad = unsafePathComponent(value);
  return bad ? [`${where}: ${label} ${bad}, and it names ${names}`] : [];
}

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
    embeddedInputs: Object.keys(inherited).filter((key) => !(key in wf.inputs)),
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
        embedded.map((child) => [
          child.id,
          // The one embedded step IS the embedding step, and so is a child that
          // shares its name; only that child's siblings need the prefix to stay unique.
          embedded.length === 1 || child.id === step.id ? step.id : `${step.id}.${child.id}`,
        ]),
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
          fanIn: step.fanIn ?? rebase(child.fanIn),
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
  /** Where installed skills live; omit to skip the check (tests without a fixture). */
  skills?: string[],
): string[] {
  const errors: string[] = [];
  const where = (stepId: string) => `workflow "${wf.name}" step "${stepId}"`;

  if (skills) errors.push(...missingSkills(wf, defs, skills));

  // The workflow's own name becomes the Run directory, so it is held to the same
  // rule as every other Workflow-controlled name.
  errors.push(...nameErrors(`workflow "${wf.name}"`, "name", wf.name, "the Run directory"));

  for (const step of wf.steps) {
    for (const need of step.requires ?? []) {
      if (!(STEP_REQUIREMENTS as readonly string[]).includes(need)) {
        errors.push(`${where(step.id)}: unknown requires "${need}" (known: ${STEP_REQUIREMENTS.join(", ")})`);
      }
    }
  }

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

    errors.push(...nameErrors(where(step.id), "step id", step.id, "a directory inside the Run"));
    if (step.output) {
      errors.push(...nameErrors(where(step.id), `output "${step.output}"`, step.output, "a file inside the Step directory"));
    }

    const isChoice = (step.choices?.length ?? 0) > 0;
    const personaName = step.persona;
    if (personaName) {
      errors.push(...nameErrors(where(step.id), `persona "${personaName}"`, personaName, "the Persona file in the Run"));
    }
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

    if (step.fanIn && !earlier(wf, step, step.fanIn)) {
      errors.push(`${where(step.id)}: fan_in "${step.fanIn}" is not an earlier step`);
    }
    // The reconciled review is this step's Output; without one there is nothing to read.
    if (step.fanIn && !step.output) {
      errors.push(`${where(step.id)}: fan_in needs an output, so the synthesis can be read`);
    }
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
    const forms = [choice.run, choice.round, choice.stop, choice.post, choice.handoff].filter(
      (f) => f !== undefined,
    ).length;
    if (forms !== 1) {
      errors.push(`${where}: needs exactly one of run, prompt, post, handoff or stop`);
    }
    for (const need of choice.requires ?? []) {
      if (!(STEP_REQUIREMENTS as readonly string[]).includes(need)) {
        errors.push(`${where}: unknown requires "${need}" (known: ${STEP_REQUIREMENTS.join(", ")})`);
      }
    }
    // `handoff` is already "when that role is live"; saying it twice is a mistake.
    if (choice.handoff && choice.unless) errors.push(`${where}: handoff is already conditional on a live agent`);

    for (const round of [choice.round, choice.followUp]) {
      if (!round) continue;
      if (round.prompt.trim() === "") {
        errors.push(
          `${where}: unknown prompt section "${round.section}" in ${step.origin}.md (known: ${step.known.join(", ") || "none"})`,
        );
      }
      const persona = round.persona ?? step.persona;
      if (!round.agent && !persona) errors.push(`${where}: needs a persona or an agent`);
      if (persona) {
        errors.push(...nameErrors(where, `persona "${persona}"`, persona, "the Persona file in the Run"));
      }
      if (persona && !defs.personas.has(persona)) {
        const known = [...defs.personas.keys()].sort().join(", ") || "none";
        errors.push(`${where}: unknown persona "${persona}" (known: ${known})`);
      }
      if (round.output) {
        errors.push(...nameErrors(where, `output "${round.output}"`, round.output, "a file inside the Step directory"));
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
  const harness = round.harness ?? step.harness ?? defaults.harness;
  const variant: Variant = {
    harness,
    model: resolvedModel(harness, round.model ?? step.model ?? defaults.model),
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
        model: resolvedModel(
          v.harness || step.harness || defaults.harness,
          v.model || step.model || defaults.model,
        ),
      },
      effortOf(v.effort),
    ));
  }
  return [
    withEffort(
      {
        harness: step.harness ?? defaults.harness,
        model: resolvedModel(step.harness ?? defaults.harness, step.model ?? defaults.model),
      },
      effortOf(undefined),
    ),
  ];
}

function resolvedModel(harness: string, model: string): string {
  return model === DEFAULT_MODEL ? (HARNESSES[harness]?.defaultModel ?? model) : model;
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
  // A key becomes a directory under the Step, so a provider-qualified model
  // (`openai-codex/gpt-5.6-sol`) is encoded to one component rather than two.
  const component = (text: string) => text.replace(/[^A-Za-z0-9._-]+/g, "-");
  const base = variants.map((v) => component(`${v.harness}-${v.model}`));
  const withEfforts = variants.map((v, i) => (v.effort ? `${base[i]}-${v.effort}` : base[i]!));
  const keys = base.some((k, i) => base.indexOf(k) !== i) ? withEfforts : base;
  // Uniqueness is allocated against the keys actually emitted: encoding can make
  // two different models collide, and a bare numeric suffix could collide with a
  // third model that already ends in one.
  const out: string[] = [];
  for (const key of keys) {
    let candidate = key;
    for (let n = 2; out.includes(candidate); n++) candidate = `${key}-${n}`;
    out.push(candidate);
  }
  return out;
}
