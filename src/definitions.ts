// Workflow and Persona definitions across the three Layers: baseline (this repo),
// the user's plugin config dir, and the project's .herdr/. Later wins by name.

import { skillsIn } from "./template";
import { unsafePathComponent } from "./naming";
import { isYamlMap, parseDocument, YamlError, type YamlMap, type YamlValue } from "./yaml";
import { Crypto, Data, Effect, FileSystem, Path, Result, type PlatformError } from "effect";
import {
  DEFAULT_MODEL,
  HARNESSES,
  harnessNames,
  isPermissionMode,
  knownModel,
  modelHint,
  PERMISSION_MODES,
  permissionsAsWritten,
} from "./harness";
import type { Defaults } from "./config";
import { isBoolean, isNumber, isString } from "./schema";

export type LayerName = "baseline" | "user" | "project";

export interface Layer {
  name: LayerName;
  dir: string;
}

export const INPUT_STRATEGIES = [
  "goal",
  "plan-dir",
  "work-source",
  "diff-target",
  "ticket",
  "flag",
  "optional",
  "gitlab-repository",
] as const;

/** What a step may declare it needs before it is worth starting. */
export const STEP_REQUIREMENTS = ["gitlab", "mr-target", "someone-elses-mr"] as const;
/** What a step may declare it waits for, rather than be skipped without. */
export const STEP_WAITS = ["helle"] as const;
export type StepRequirement = string;
export type InputStrategy = string;

const STEP_REQUIREMENT_SET: ReadonlySet<string> = new Set(STEP_REQUIREMENTS);
const STEP_WAIT_SET: ReadonlySet<string> = new Set(STEP_WAITS);
const INPUT_STRATEGY_SET: ReadonlySet<string> = new Set(INPUT_STRATEGIES);

export interface Variant {
  harness: string;
  model: string;
  effort?: string;
  /**
   * Set only where a Step or Round asked for a mode of its own; absent means the Run's
   * `permissions` default decides, the way an unset `effort` leaves it to the harness.
   * As written, so validation can name an unknown one rather than dropping it.
   */
  permissions?: string;
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
  permissions?: string;
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
  /** Keep the harness's own tool-call prompting for this step; see `Defaults.permissions`. */
  permissions?: string;
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
  /** Blocked, before any agent starts, until this is the Run's to take. */
  waits?: StepRequirement[];
  /** This step reconciles that earlier step's parallel Outputs into one. */
  fanIn?: string;
  /**
   * Run this step once per ticket of the plan, in an order its `Blocked by` lines allow,
   * on the same agent, with a compact hand-off between slices. See docs/authoring.md.
   */
  each?: string;
  /**
   * `from` is the gate; `back_to` is the earliest step to run again (default `from`).
   * `converge` makes only blocking findings drive the loop and lets the last fix's own
   * dispositions and checks decide the run; see docs/authoring.md Loops.
   */
  repeat?: { from: string; back_to?: string; max?: number; converge?: boolean };
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
  /**
   * The name at the bottom of this definition's `extends` chain — what it ultimately
   * is, rather than what this file is called. A fork of `renovate` is still a Renovate
   * Run and still needs the roaming checkout that goes with one, so behaviour keyed on
   * which Workflow this is keys on `base`, never on `name`.
   */
  base: string;
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

export const contentHash = Effect.fn("Definitions.contentHash")(function* (text: string) {
  const crypto = yield* Crypto.Crypto;
  const bytes = yield* crypto.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
});

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
export const skillDirs = Effect.fn("Definitions.skillDirs")(function* (env: {
  home: string;
  cwd: string;
}) {
  const path = yield* Path.Path;
  return [path.join(env.cwd, ".agents", "skills"), path.join(env.home, ".agents", "skills")];
});

export const layers = Effect.fn("Definitions.layers")(function* (env: {
  pluginRoot: string;
  configDir: string;
  cwd: string;
}) {
  const path = yield* Path.Path;
  const baseline: Layer = { name: "baseline", dir: env.pluginRoot };
  const user: Layer = { name: "user", dir: env.configDir };
  const project: Layer = { name: "project", dir: path.join(env.cwd, ".herdr") };
  return { baseline, user, project, all: [baseline, user, project] };
});

const markdownFiles = Effect.fn("Definitions.markdownFiles")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(dir))) return [];
  return (yield* fs.readDirectory(dir))
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => path.join(dir, f));
});

function str(value: YamlValue | undefined, fallback = ""): string {
  return value !== undefined && isString(value) ? value : fallback;
}

const parseWorkflow = Effect.fn("Definitions.parseWorkflow")(function* (
  file: string,
  layer: LayerName,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs.readFileString(file);
  const { data, body } = yield* Effect.try({
    try: () => parseDocument(text),
    catch: (cause) => (cause instanceof YamlError ? cause : new Error(String(cause))),
  });
  const stem = path.basename(file, ".md");
  const rawInputs = data.inputs !== undefined && isYamlMap(data.inputs) ? data.inputs : {};
  const inputs: Record<string, InputStrategy> = {};
  for (const [key, value] of Object.entries(rawInputs)) inputs[key] = str(value);
  const rawSteps = Array.isArray(data.steps) ? data.steps : [];
  const steps: StepDef[] = rawSteps.map((raw, index) => {
    const stepData = isYamlMap(raw) ? raw : {};
    const step: StepDef = { id: str(stepData.id, `step-${index + 1}`) };
    if (isString(stepData.persona)) step.persona = stepData.persona;
    if (isString(stepData.harness)) step.harness = stepData.harness;
    if (isString(stepData.model)) step.model = stepData.model;
    if (isString(stepData.effort)) step.effort = stepData.effort;
    const stepPermissions = permissionsAsWritten(stepData.permissions);
    if (stepPermissions !== undefined) step.permissions = stepPermissions;
    if (isBoolean(stepData.fresh)) step.fresh = stepData.fresh;
    if (isString(stepData.output)) step.output = stepData.output;
    if (isString(stepData.agent)) step.agent = stepData.agent;
    if (isString(stepData.skill)) step.skill = stepData.skill;
    if (isString(stepData.use)) step.use = stepData.use;
    if (Array.isArray(stepData.parallel)) {
      step.parallel = stepData.parallel.map((rawVariant) => {
        const variantData = isYamlMap(rawVariant) ? rawVariant : {};
        const variant: Variant = {
          harness: str(variantData.harness),
          model: str(variantData.model),
        };
        if (isString(variantData.effort)) variant.effort = variantData.effort;
        const variantPermissions = permissionsAsWritten(variantData.permissions);
        if (variantPermissions !== undefined) variant.permissions = variantPermissions;
        return variant;
      });
    }
    if (isString(stepData.prompt)) step.promptSection = stepData.prompt;
    if (stepData.standalone === true) step.standalone = true;
    const requires = parseNames(stepData.requires);
    if (requires) step.requires = requires;
    const waits = parseNames(stepData.waits);
    if (waits) step.waits = waits;
    if (isString(stepData.fan_in)) step.fanIn = stepData.fan_in;
    if (isString(stepData.each)) step.each = stepData.each;
    if (Array.isArray(stepData.choices)) step.choices = stepData.choices.map(parseChoice);
    if (isYamlMap(stepData.repeat)) {
      step.repeat = { from: str(stepData.repeat.from) };
      if (isString(stepData.repeat.back_to)) step.repeat.back_to = stepData.repeat.back_to;
      if (isNumber(stepData.repeat.max)) step.repeat.max = stepData.repeat.max;
      if (stepData.repeat.converge === true) step.repeat.converge = true;
    }
    return step;
  });

  const workflow: WorkflowDef = {
    name: str(data.name, stem),
    // Its own name until resolution finds it a parent, whose `base` it then inherits.
    base: str(data.name, stem),
    title: str(data.title, str(data.name, stem)),
    description: str(data.description),
    inputs,
    maxIterations: isNumber(data.max_iterations) ? data.max_iterations : null,
    steps,
    body,
    path: file,
    layer,
  };
  if (isString(data.extends)) workflow.extends = data.extends;
  if (isString(data.forked_from_hash)) workflow.forkedFromHash = data.forked_from_hash;
  return workflow;
});

function parseRound(raw: YamlMap): RoundDef | undefined {
  if (!isString(raw.prompt)) return undefined;
  const round: RoundDef = { section: raw.prompt, prompt: "" };
  for (const key of [
    "agent",
    "persona",
    "harness",
    "model",
    "effort",
    "output",
    "skill",
  ] as const) {
    const value = raw[key];
    if (isString(value)) round[key] = value;
  }
  const permissions = permissionsAsWritten(raw.permissions);
  if (permissions !== undefined) round.permissions = permissions;
  if (isBoolean(raw.fresh)) round.fresh = raw.fresh;
  return round;
}

/** One name and a list of them are the same thing: `requires: gitlab`, `waits: helle`. */
function parseNames(raw: YamlValue | undefined): StepRequirement[] | undefined {
  if (raw !== undefined && isString(raw)) return [raw];
  if (Array.isArray(raw)) return raw.filter(isString);
  return undefined;
}

function parseChoice(raw: YamlValue): ChoiceDef {
  const choiceData = isYamlMap(raw) ? raw : {};
  const choice: ChoiceDef = { title: str(choiceData.title) };
  if (isString(choiceData.run)) choice.run = choiceData.run;
  if (choiceData.stop === true) choice.stop = true;
  if (choiceData.post === true) choice.post = true;
  if (isString(choiceData.handoff)) choice.handoff = choiceData.handoff;
  if (isString(choiceData.unless)) choice.unless = choiceData.unless;
  const requires = parseNames(choiceData.requires);
  if (requires) choice.requires = requires;
  if (isNumber(choiceData.max)) choice.max = choiceData.max;
  const round = parseRound(choiceData);
  if (round) choice.round = round;
  if (isYamlMap(choiceData.inputs)) {
    const inputs: Record<string, string> = {};
    for (const [key, value] of Object.entries(choiceData.inputs)) inputs[key] = str(value);
    choice.inputs = inputs;
  }
  if (isYamlMap(choiceData.config)) {
    choice.config = { key: str(choiceData.config.key), question: str(choiceData.config.question) };
  }
  if (isYamlMap(choiceData.follow_up)) {
    const follow = parseRound(choiceData.follow_up);
    if (follow) choice.followUp = follow;
  }
  return choice;
}

const parsePersona = Effect.fn("Definitions.parsePersona")(function* (
  file: string,
  layer: LayerName,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs.readFileString(file);
  const { data, body } = yield* Effect.try({
    try: () => parseDocument(text),
    catch: (cause) => (cause instanceof YamlError ? cause : new Error(String(cause))),
  });
  const persona: PersonaDef = {
    name: str(data.name, path.basename(file, ".md")),
    description: str(data.description),
    body,
    path: file,
    layer,
  };
  if (isString(data.extends)) persona.extends = data.extends;
  if (isString(data.forked_from_hash)) persona.forkedFromHash = data.forked_from_hash;
  return persona;
});

export const loadDefinitions = Effect.fn("Definitions.loadDefinitions")(function* (
  layers: Layer[] | { readonly all: Layer[] },
) {
  const workflows = new Map<string, WorkflowDef>();
  const personas = new Map<string, PersonaDef>();
  const errors: string[] = [];

  for (const layer of Array.isArray(layers) ? layers : layers.all) {
    yield* loadLayer(workflows, layer, "workflows", parseWorkflow, mergeWorkflow, errors);
    yield* loadLayer(personas, layer, "personas", parsePersona, mergePersona, errors);
  }

  return { workflows, personas, errors };
});

/**
 * One layer of one kind. A file that names no parent replaces what the layers below
 * had; a file with `extends:` changes only what it names, and is resolved in
 * dependency order so a parent in the same layer is merged before its child.
 */
const loadLayer = Effect.fn("Definitions.loadLayer")(function* <
  T extends Provenance & { name: string },
>(
  into: Map<string, T>,
  layer: Layer,
  kind: "workflows" | "personas",
  parse: (
    path: string,
    layer: LayerName,
  ) => Effect.Effect<
    T,
    YamlError | Error | PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path
  >,
  merge: (parent: T, child: T) => T,
  errors: string[],
) {
  const pathSvc = yield* Path.Path;
  const parsed = new Map<string, T>();
  for (const path of yield* markdownFiles(pathSvc.join(layer.dir, kind))) {
    const result = yield* Effect.result(parse(path, layer.name));
    if (Result.isSuccess(result)) parsed.set(result.success.name, result.success);
    else
      errors.push(
        `${path}: ${result.failure instanceof YamlError ? result.failure.message : String(result.failure)}`,
      );
  }

  const settled = new Set<string>();
  const resolve = (
    name: string,
    chain: string[],
  ): Effect.Effect<
    void,
    PlatformError.PlatformError,
    FileSystem.FileSystem | Path.Path | Crypto.Crypto
  > =>
    Effect.gen(function* () {
      if (settled.has(name)) return;
      const def = parsed.get(name);
      if (!def) return;
      settled.add(name);

      // What this file is built on, before it goes in: the same name from a lower
      // layer is the usual case, and another name in this layer is resolved first.
      const parentName = def.extends;
      if (!parentName) {
        into.set(name, yield* withParentHash(def, into));
        return;
      }
      if (chain.includes(parentName)) {
        errors.push(`${def.path}: extends cycle (${[...chain, parentName].join(" → ")})`);
        return;
      }
      if (parsed.has(parentName) && parentName !== name)
        yield* resolve(parentName, [...chain, name]);

      const parent = into.get(parentName);
      if (!parent) {
        errors.push(`${def.path}: extends "${parentName}", which no layer below this one defines`);
        return;
      }
      into.set(name, yield* withParentHash(merge(parent, def), into));
    });
  for (const name of parsed.keys()) yield* resolve(name, []);
});

/**
 * The hash of the file this definition shadows, so a full copy whose original has
 * moved on can be spotted. Only a full copy carries a hash to compare against.
 */
const withParentHash = Effect.fn("Definitions.withParentHash")(function* <
  T extends Provenance & { name: string },
>(def: T, into: Map<string, T>) {
  if (!def.forkedFromHash) return def;
  const shadowed = into.get(def.name);
  const parentHash = shadowed ? yield* readHash(shadowed.path) : undefined;
  return parentHash ? { ...def, parentHash } : def;
});

const readHash = Effect.fn("Definitions.readHash")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(path).pipe(Effect.catch(() => Effect.succeed(undefined)));
  return text === undefined ? undefined : yield* contentHash(text);
});

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
    // `base` is deliberately not among the keys the child brings: inheriting the
    // parent's carries the bottom of the chain up, however many forks deep it is.
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
export interface BodySections {
  preamble: string;
  sections: Map<string, string>;
}

export function bodySections(body: string): BodySections {
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
  /** The bottom of the `extends` chain — see `WorkflowDef.base`. */
  base: string;
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
 * Every skill a resolved Workflow *mentions*, and where it asked for it: a step's
 * prompt, its persona, and every Choice round's prompt and persona — a round is an
 * agent too, and `review`'s fix round is an implementer whose skills are the point of
 * it. One walk, because the engine resolves these to `SKILL.md` paths and the
 * validator reports the ones nobody installed, and a place a skill can be named that
 * only one of them knows about is a skill that silently goes missing in the other.
 */
export function skillMentions(wf: ResolvedWorkflow, defs: Definitions): Map<string, string> {
  const asked = new Map<string, string>();
  const note = (name: string, by: string) => {
    if (!asked.has(name)) asked.set(name, by);
  };
  const notePersona = (name: string | undefined) => {
    const persona = name ? defs.personas.get(name) : undefined;
    if (persona)
      for (const skill of skillsIn(persona.body)) note(skill, `persona "${persona.name}"`);
  };
  for (const step of wf.steps) {
    for (const name of skillsIn(`${step.preamble}\n${step.prompt}`))
      note(name, `${wf.name} step "${step.id}"`);
    notePersona(step.persona);
    for (const choice of step.choices ?? []) {
      for (const round of [choice.round, choice.followUp]) {
        if (!round) continue;
        for (const name of skillsIn(round.prompt))
          note(name, `${wf.name} step "${step.id}" choice "${choice.title}"`);
        notePersona(round.persona ?? step.persona);
      }
    }
  }
  return asked;
}

/**
 * Whether one skill is installed in any of these directories. The file, not the
 * directory: a mention renders the path to `SKILL.md`, so a directory without one is
 * a skill that validates and then reads as missing to the agent told to follow it.
 */
export const skillInstalled = Effect.fn("Definitions.skillInstalled")(function* (
  dirs: string[],
  name: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const dir of dirs) {
    if (yield* fs.exists(path.join(dir, name, "SKILL.md"))) return true;
  }
  return false;
});

/**
 * Every skill this Workflow asks for, and what asked for it: the ones a Step or a
 * Choice round *starts*, and the ones a prompt or a Persona mentions. `doctor` and
 * validation ask the same question, so they ask it in one place.
 */
export function requiredSkills(wf: ResolvedWorkflow, defs: Definitions): Map<string, string> {
  // A step's `skill:` is started rather than mentioned, and is just as missing; the
  // rest is the same walk the engine resolves paths from.
  const asked = new Map<string, string>();
  const started = (skill: string | undefined, where: string) => {
    if (skill && !asked.has(skill)) asked.set(skill, where);
  };
  for (const step of wf.steps) {
    started(step.skill, `${wf.name} step "${step.id}"`);
    // A round drives a skill the same way a step does, and a user-only one that is
    // not installed costs the same turn — discovered only once the agent is open.
    for (const choice of step.choices ?? []) {
      for (const round of [choice.round, choice.followUp]) {
        started(round?.skill, `${wf.name} step "${step.id}" choice "${choice.title}"`);
      }
    }
  }
  for (const [name, by] of skillMentions(wf, defs)) {
    if (!asked.has(name)) asked.set(name, by);
  }
  return asked;
}

/**
 * Every skill this Workflow asks for that is not installed. Named one per line with
 * the command that installs it: a run that starts without them wastes an agent's
 * whole turn discovering the same thing.
 */
const missingSkills = Effect.fn("Definitions.missingSkills")(function* (
  wf: ResolvedWorkflow,
  defs: Definitions,
  dirs: string[],
) {
  const asked = requiredSkills(wf, defs);
  const errors: string[] = [];
  for (const [name, by] of asked) {
    if (!(yield* skillInstalled(dirs, name)))
      errors.push(`${by}: the skill "${name}" is not installed — run \`npx skills add ${name}\``);
  }
  return errors;
});

export class DefinitionError extends Data.TaggedError("DefinitionError")<{ message: string }> {
  constructor(message: string) {
    super({ message });
  }
}

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
  const inputs = { ...wf.inputs };
  for (const [key, strategy] of Object.entries(inherited)) {
    if (!(key in inputs)) inputs[key] = strategy;
  }
  return {
    name: wf.name,
    base: wf.base,
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
        throw new DefinitionError(
          `workflow "${chain[0]}" embeds "${step.use}" in a cycle: ${[...chain, step.use].join(" -> ")}`,
        );
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
      const rebase = (id: string | undefined) =>
        id !== undefined ? (ids.get(id) ?? id) : undefined;
      for (const child of embedded) {
        const resolvedChild: ResolvedStep = {
          ...child,
          ...override,
          // The embedding step's own settings win over the embedded defaults.
          id: ids.get(child.id)!,
          persona: step.persona ?? child.persona,
          harness: step.harness ?? child.harness,
          model: step.model ?? child.model,
          effort: step.effort ?? child.effort,
          permissions: step.permissions ?? child.permissions,
          fresh: step.fresh ?? child.fresh,
          output: step.output ?? child.output,
          parallel: step.parallel ?? child.parallel,
          repeat: step.repeat ?? rebaseRepeat(child.repeat, rebase),
          agent: step.agent ?? rebase(child.agent),
          fanIn: step.fanIn ?? rebase(child.fanIn),
          skill: step.skill ?? child.skill,
        };
        if (child.choices)
          resolvedChild.choices = child.choices.map((choice) => rebaseChoice(choice, rebase));
        out.push(resolvedChild);
      }
      continue;
    }
    const section = step.promptSection ?? step.id;
    const resolvedStep: ResolvedStep = {
      ...step,
      origin: wf.name,
      // A body with no headings IS the prompt, so it must not also be the preamble.
      preamble: single ? "" : preamble,
      prompt: single ? wf.body : (sections.get(section) ?? ""),
      known: [...sections.keys()],
    };
    if (step.choices)
      resolvedStep.choices = step.choices.map((choice) => resolveChoice(choice, sections));
    out.push(resolvedStep);
  }
  return out;
}

type Rebase = (id: string | undefined) => string | undefined;

function rebaseRepeat(repeat: StepDef["repeat"], rebase: Rebase): StepDef["repeat"] {
  if (!repeat) return undefined;
  const rebased = { ...repeat, from: rebase(repeat.from)! };
  if (repeat.back_to) rebased.back_to = rebase(repeat.back_to)!;
  return rebased;
}

function rebaseRound(round: RoundDef, rebase: Rebase): RoundDef {
  return round.agent ? { ...round, agent: rebase(round.agent)! } : round;
}

function rebaseChoice(choice: ChoiceDef, rebase: Rebase): ChoiceDef {
  const rebased = { ...choice };
  if (choice.round) rebased.round = rebaseRound(choice.round, rebase);
  if (choice.followUp) rebased.followUp = rebaseRound(choice.followUp, rebase);
  return rebased;
}

function resolveRound(round: RoundDef, sections: Map<string, string>): RoundDef {
  return { ...round, prompt: sections.get(round.section) ?? "" };
}

function resolveChoice(choice: ChoiceDef, sections: Map<string, string>): ChoiceDef {
  const resolved = { ...choice };
  if (choice.round) resolved.round = resolveRound(choice.round, sections);
  if (choice.followUp) resolved.followUp = resolveRound(choice.followUp, sections);
  return resolved;
}

export const validateWorkflow = Effect.fn("Definitions.validateWorkflow")(function* (
  wf: ResolvedWorkflow,
  defs: Definitions,
  defaults: Defaults,
  /** Where installed skills live; omit to skip the check (tests without a fixture). */
  skills?: string[],
) {
  const errors: string[] = [];
  const where = (stepId: string) => `workflow "${wf.name}" step "${stepId}"`;

  if (skills) errors.push(...(yield* missingSkills(wf, defs, skills)));

  // The workflow's own name becomes the Run directory, so it is held to the same
  // rule as every other Workflow-controlled name.
  errors.push(...nameErrors(`workflow "${wf.name}"`, "name", wf.name, "the Run directory"));

  for (const step of wf.steps) {
    for (const need of step.requires ?? []) {
      if (!STEP_REQUIREMENT_SET.has(need)) {
        errors.push(
          `${where(step.id)}: unknown requires "${need}" (known: ${STEP_REQUIREMENTS.join(", ")})`,
        );
      }
    }
    for (const gate of step.waits ?? []) {
      if (!STEP_WAIT_SET.has(gate)) {
        errors.push(`${where(step.id)}: unknown waits "${gate}" (known: ${STEP_WAITS.join(", ")})`);
      }
    }
  }

  for (const [input, strategy] of Object.entries(wf.inputs)) {
    if (!INPUT_STRATEGY_SET.has(strategy)) {
      errors.push(
        `workflow "${wf.name}" input "${input}": unknown strategy "${strategy}" (known: ${INPUT_STRATEGIES.join(", ")})`,
      );
    }
  }

  if (wf.steps.length === 0) errors.push(`workflow "${wf.name}" has no steps`);
  // The Run's own default, named once: every step that does not override it runs with
  // this, so an unknown one is not a property of any single step.
  if (!isPermissionMode(defaults.permissions)) {
    errors.push(
      `config.json: unknown permissions "${defaults.permissions}" (known: ${PERMISSION_MODES.join(", ")})`,
    );
  }

  const seen = new Set<string>();
  for (const step of wf.steps) {
    if (seen.has(step.id)) errors.push(`${where(step.id)}: duplicate step id`);
    seen.add(step.id);

    errors.push(...nameErrors(where(step.id), "step id", step.id, "a directory inside the Run"));
    if (step.output) {
      errors.push(
        ...nameErrors(
          where(step.id),
          `output "${step.output}"`,
          step.output,
          "a file inside the Step directory",
        ),
      );
    }

    const isChoice = (step.choices?.length ?? 0) > 0;
    const personaName = step.persona;
    if (personaName) {
      errors.push(
        ...nameErrors(
          where(step.id),
          `persona "${personaName}"`,
          personaName,
          "the Persona file in the Run",
        ),
      );
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

    const combos = stepVariants(step, defaults);
    for (const combo of combos) errors.push(...variantErrors(where(step.id), combo, defaults));
    if (isChoice) errors.push(...choiceErrors(wf, step, defs, defaults));

    if (step.fanIn && !earlier(wf, step, step.fanIn)) {
      errors.push(`${where(step.id)}: fan_in "${step.fanIn}" is not an earlier step`);
    }
    // The reconciled review is this step's Output; without one there is nothing to read.
    if (step.fanIn && !step.output) {
      errors.push(`${where(step.id)}: fan_in needs an output, so the synthesis can be read`);
    }
    if (step.each !== undefined) {
      if (step.each !== "tickets") {
        errors.push(`${where(step.id)}: each must be "tickets" (got "${step.each}")`);
      }
      // The tickets come from a work source, so without one there is nothing to loop.
      if (!Object.values(wf.inputs).includes("work-source")) {
        errors.push(
          `${where(step.id)}: each: tickets needs a work-source input to take the tickets from`,
        );
      }
      // Slices are sequential on one agent; a parallel step and a fan-in are the two
      // shapes that cannot also be one-at-a-time.
      if (step.parallel !== undefined) {
        errors.push(`${where(step.id)}: each and parallel cannot both be set`);
      }
      if (step.fanIn) errors.push(`${where(step.id)}: each and fan_in cannot both be set`);
      if (!step.output) {
        errors.push(`${where(step.id)}: each needs an output, so every slice records one`);
      }
    }
    if (step.agent && !earlier(wf, step, step.agent)) {
      errors.push(`${where(step.id)}: agent "${step.agent}" is not an earlier step`);
    }
    // Every parallel entry of a continued step borrows the same prior agent, so every
    // entry's mode has to reach it — deduplicated, because one message per distinct mode
    // is all a reader needs.
    for (const mode of new Set(combos.map((combo) => combo.permissions))) {
      errors.push(...continuedPermissionErrors(where(step.id), wf, step.agent, mode, defaults));
    }
    if (step.repeat && !earlier(wf, step, step.repeat.from)) {
      errors.push(`${where(step.id)}: repeat.from "${step.repeat.from}" is not an earlier step`);
    }
    if (step.repeat?.back_to && !earlier(wf, step, step.repeat.back_to)) {
      errors.push(
        `${where(step.id)}: repeat.back_to "${step.repeat.back_to}" is not an earlier step`,
      );
    }
    if (step.agent && step.fresh) {
      errors.push(`${where(step.id)}: agent and fresh are mutually exclusive`);
    }
  }

  return errors;
});

/**
 * A step with `agent:` continues a process that is already running, so it never reaches
 * the start that would apply a permissions mode — the mode was decided when that agent
 * started. Saying the same mode again is harmless, and is what every step of an embedded
 * workflow says when the embedding step names one, so only a mode that differs is an
 * error. (`model`, `effort` and `harness` are ignored on a continued step for the same
 * reason; they are left alone here because this branch did not introduce them and a
 * workflow may already be relying on the silence.)
 */
function continuedPermissionErrors(
  where: string,
  wf: ResolvedWorkflow,
  agent: string | undefined,
  mode: string | undefined,
  defaults: Defaults,
): string[] {
  if (agent === undefined || mode === undefined) return [];
  const starts = startsOfAgent(wf, agent, defaults);
  // `every` is true for no starts too, which is what an unresolvable agent should get:
  // the reference itself is already an error.
  if (starts.every((start) => start.mode === mode)) return [];
  // Naming the step only where it is not the one named here, so a direct continuation
  // does not read as "continues "build" … starts in step "build"".
  const named = (start: AgentStart) =>
    start.id === agent ? `"${start.mode}"` : `"${start.mode}" in step "${start.id}"`;
  const opened = [...new Set(starts.map(named))].join(" or ");
  const ids = [...new Set(starts.map((start) => start.id))];
  // One place to put it is worth naming; several, and the author has to pick the one
  // whose round they meant.
  const remedy = ids.length === 1 ? `set it on "${ids[0]}"` : "set it where that agent starts";
  return [
    `${where}: permissions "${mode}" cannot apply to a step that continues agent ` +
      `"${agent}", which starts with ${opened} — ${remedy}, or drop "agent" so this step ` +
      `starts one of its own`,
  ];
}

interface AgentStart {
  /** The step whose definition decides the mode: the step itself, or the one holding the round. */
  id: string;
  mode: string;
}

/**
 * Every mode the agent registered under `agent` could have been started with. A step in
 * the middle of an `agent:` chain has no mode of its own — it resolves to the Run default,
 * which is not what its process was started with — so the walk goes back to whatever
 * opened the agent. A Choice step opens it in a round, and which round runs is the
 * human's answer at the time, so every round that starts one counts.
 */
function startsOfAgent(
  wf: ResolvedWorkflow,
  agent: string,
  defaults: Defaults,
  seen: Set<string> = new Set(),
): AgentStart[] {
  if (seen.has(agent)) return [];
  seen.add(agent);
  const step = wf.steps.find((s) => s.id === agent);
  if (!step) return [];
  if (step.agent !== undefined) return startsOfAgent(wf, step.agent, defaults, seen);
  const rounds = (step.choices ?? []).flatMap((choice) => [choice.round, choice.followUp]);
  const starts: AgentStart[] = [];
  for (const round of rounds) {
    if (!round) continue;
    if (round.agent !== undefined) starts.push(...startsOfAgent(wf, round.agent, defaults, seen));
    else {
      starts.push({
        id: step.id,
        mode: roundVariant(round, step, defaults).permissions ?? defaults.permissions,
      });
    }
  }
  if (starts.length > 0) return starts;
  return [
    { id: step.id, mode: stepVariants(step, defaults)[0]?.permissions ?? defaults.permissions },
  ];
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
  if (combo.permissions !== undefined && !isPermissionMode(combo.permissions)) {
    errors.push(
      `${where}: unknown permissions "${combo.permissions}" (known: ${PERMISSION_MODES.join(", ")})`,
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
  // A title is what a human decides, so two choices may share one only when they can
  // never both be offered: a hand-off and the twin that runs when nothing is live.
  // Anything else would make a decided title resolve to whichever sorted first.
  const byTitle = new Map<string, ChoiceDef[]>();
  for (const choice of step.choices ?? []) {
    if (choice.title) byTitle.set(choice.title, [...(byTitle.get(choice.title) ?? []), choice]);
  }
  for (const [title, sharing] of byTitle) {
    const [a, b] = sharing;
    const pair =
      sharing.length === 2 &&
      ((a!.handoff && b!.unless === a!.handoff) || (b!.handoff && a!.unless === b!.handoff));
    if (sharing.length > 1 && !pair) {
      errors.push(`workflow "${wf.name}" step "${step.id}": duplicate choice title "${title}"`);
    }
  }
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
      if (!STEP_REQUIREMENT_SET.has(need)) {
        errors.push(
          `${where}: unknown requires "${need}" (known: ${STEP_REQUIREMENTS.join(", ")})`,
        );
      }
    }
    // `handoff` is already "when that role is live"; saying it twice is a mistake.
    if (choice.handoff && choice.unless)
      errors.push(`${where}: handoff is already conditional on a live agent`);

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
        errors.push(
          ...nameErrors(where, `persona "${persona}"`, persona, "the Persona file in the Run"),
        );
      }
      if (persona && !defs.personas.has(persona)) {
        const known = [...defs.personas.keys()].sort().join(", ") || "none";
        errors.push(`${where}: unknown persona "${persona}" (known: ${known})`);
      }
      if (round.output) {
        errors.push(
          ...nameErrors(
            where,
            `output "${round.output}"`,
            round.output,
            "a file inside the Step directory",
          ),
        );
      }
      if (round.agent && !earlier(wf, step, round.agent)) {
        errors.push(`${where}: agent "${round.agent}" is not an earlier step`);
      }
      if (!round.output) errors.push(`${where}: needs an output, so the round can finish`);
      const variant = roundVariant(round, step, defaults);
      errors.push(...variantErrors(where, variant, defaults));
      // A round continues an agent the same way a step does, and cannot re-permission it
      // either. `round.agent` falls back to the step's, so both spellings are covered.
      errors.push(
        ...continuedPermissionErrors(
          where,
          wf,
          round.agent ?? step.agent,
          variant.permissions,
          defaults,
        ),
      );
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
  if (!choice.run) return [`${where}: chained choice has no workflow`];
  let child: ResolvedWorkflow;
  try {
    child = resolveWorkflow(choice.run, defs, defaults);
  } catch (cause) {
    return [`${where}: ${cause instanceof DefinitionError ? cause.message : String(cause)}`];
  }
  const unknown = Object.keys(choice.inputs ?? {}).filter((k) => !(k in child.inputs));
  return unknown.length === 0
    ? []
    : [
        `${where}: workflow "${child.name}" has no input(s) ${unknown.join(", ")} (known: ${Object.keys(child.inputs).join(", ") || "none"})`,
      ];
}

/** The harness/model/effort/permissions one Choice round runs with. */
export function roundVariant(round: RoundDef, step: ResolvedStep, defaults: Defaults): Variant {
  return variantOf({
    harness: round.harness ?? step.harness ?? defaults.harness,
    model: round.model ?? step.model ?? defaults.model,
    effort: round.effort ?? step.effort ?? defaults.effort,
    permissions: round.permissions ?? step.permissions,
  });
}

function earlier(wf: ResolvedWorkflow, step: ResolvedStep, id: string): boolean {
  const at = wf.steps.indexOf(step);
  return wf.steps.slice(0, at).some((s) => s.id === id);
}

/**
 * Every harness/model/effort/permissions combination a step will run, one per parallel
 * variant. A parallel entry's own values win over the step's, which win over the Run's.
 */
export function stepVariants(step: StepDef, defaults: Defaults): Variant[] {
  // A parallel entry parsed from YAML has `""` for a key it did not name, hence `||`
  // there and `??` for the step's own keys.
  if (step.parallel && step.parallel.length > 0) {
    return step.parallel.map((v) =>
      variantOf({
        harness: v.harness || step.harness || defaults.harness,
        model: v.model || step.model || defaults.model,
        effort: v.effort ?? step.effort ?? defaults.effort,
        permissions: v.permissions ?? step.permissions,
      }),
    );
  }
  return [
    variantOf({
      harness: step.harness ?? defaults.harness,
      model: step.model ?? defaults.model,
      effort: step.effort ?? defaults.effort,
      permissions: step.permissions,
    }),
  ];
}

/**
 * One Variant from what a Step, Round or parallel entry resolved to. The optional keys
 * are omitted rather than set to `undefined`: a Variant is compared, recorded in the run
 * and turned into an agent name, so "unset" has to mean absent everywhere.
 */
function variantOf(resolved: {
  harness: string;
  model: string;
  effort: string | undefined;
  permissions: string | undefined;
}): Variant {
  const variant: Variant = {
    harness: resolved.harness,
    model: resolvedModel(resolved.harness, resolved.model),
  };
  if (resolved.effort !== undefined) variant.effort = resolved.effort;
  if (resolved.permissions !== undefined) variant.permissions = resolved.permissions;
  return variant;
}

function resolvedModel(harness: string, model: string): string {
  return model === DEFAULT_MODEL ? (HARNESSES[harness]?.defaultModel ?? model) : model;
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
