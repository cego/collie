// What each plugin action does. Actions have no tty, so they only open a pane;
// the interactive work happens in the `picker` and `runner` pane entrypoints.

import { loadDefaults } from "./config";
import {
  DefinitionError,
  layers,
  loadDefinitions,
  resolveWorkflow,
  validateWorkflow,
  type Definitions,
} from "./definitions";
import { executeRun, runTarget } from "./engine";
import type { PluginEnv } from "./env";
import type { Herdr } from "./herdr";
import {
  confirmLine,
  inferInputs,
  inputSources,
  inputValues,
  isKindCompanion,
  resolveCandidates,
  type Resolution,
} from "./inputs";
import { ask, confirm, nextKey, pick, releaseKeyboard, type PickItem } from "./picker";
import { forkDefinition, type DefinitionKind } from "./fork";
import { GLYPH, tabLabel } from "./naming";
import { RunStore } from "./run";

export type Mode = "pick" | "resume" | "fork";

/** An action: open the popup that does the actual work. */
export async function openPicker(herdr: Herdr, env: PluginEnv, mode: Mode): Promise<number> {
  console.log(`${mode}: opening the picker in ${env.cwd}`);
  await herdr.pluginPaneOpen({
    entrypoint: "picker",
    env: { HERDR_WORKFLOWS_MODE: mode, HERDR_WORKFLOWS_CWD: env.cwd },
    focus: true,
  });
  return 0;
}

function banner(defs: Definitions): string | undefined {
  if (defs.errors.length === 0) return undefined;
  return ["Definitions with errors (skipped):", ...defs.errors.map((e) => `  ${e}`)].join("\n");
}

export async function pickFlow(herdr: Herdr, env: PluginEnv): Promise<number> {
  const defs = loadDefinitions(layers(env));
  const defaults = loadDefaults(env.configDir);

  const items: PickItem[] = [...defs.workflows.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((wf) => ({ id: wf.name, title: wf.title, subtitle: `[${wf.layer}]` }));

  if (items.length === 0) {
    return await bail("No workflows found. Check the plugin's workflows/ directory.", banner(defs));
  }

  const chosen = await pick(items, {
    header: `Workflows — ${env.cwd}`,
    footer: "↑↓ move · type to filter · Enter run · Esc cancel",
    banner: banner(defs),
  });
  if (!chosen) return 0;

  let resolved;
  try {
    resolved = resolveWorkflow(chosen.id, defs, defaults);
  } catch (e) {
    if (!(e instanceof DefinitionError)) throw e;
    return await bail(e.message);
  }

  // Nothing opens until the whole workflow is valid.
  const errors = validateWorkflow(resolved, defs, defaults);
  if (errors.length > 0) {
    return await bail([`${resolved.name} is not runnable:`, ...errors.map((e) => `  ${e}`)].join("\n"));
  }

  const resolutions = await inferInputs(resolved.inputs, { cwd: env.cwd, stateDir: env.stateDir });
  // An embedded workflow's inputs belong to the run that embeds it, which never asks.
  const embedded = new Set(resolved.embeddedInputs);
  for (const r of resolutions) {
    // An Input with candidates is chosen from what this repo offers, not typed blind.
    if (r.candidates && !embedded.has(r.name)) {
      if (!(await resolveCandidates(r, { menu: pick, ask }))) return 0;
      continue;
    }
    if (!r.needsAsking) continue;
    const answer = await ask(r.question);
    if (answer === null) return 0;
    r.value = answer.trim();
    r.source = "asked";
    if (r.value === "") return await bail(`${resolved.name} needs an input for "${r.name}".`);
  }

  const line = confirmLine(resolved.name, resolutions);
  if (!(await confirm(line))) return 0;

  const store = new RunStore(env.stateDir);
  const run = store.create({
    workflow: resolved.name,
    cwd: env.cwd,
    inputs: inputValues(resolutions),
    inputSources: inputSources(resolutions),
    stepIds: resolved.steps.map((s) => s.id),
    maxIterations: resolved.maxIterations,
    primaryInput: primaryInput(resolutions),
  });
  run.log(`created from ${resolved.path} (${resolved.layer} layer)`);
  run.log(line);

  await herdr.pluginPaneOpen({
    entrypoint: "runner",
    env: { HERDR_WORKFLOWS_RUN: run.id, HERDR_WORKFLOWS_CWD: env.cwd },
    focus: true,
    workspaceId: env.workspaceId,
    cwd: env.cwd,
  });
  try {
    await herdr.popupClose();
  } catch {
    // Only a popup can close itself; running the picker in a plain pane is fine.
  }
  return 0;
}

export async function forkFlow(herdr: Herdr, env: PluginEnv): Promise<number> {
  const defs = loadDefinitions(layers(env));
  const sources = new Map<string, { kind: DefinitionKind; path: string }>();
  const items: PickItem[] = [];

  for (const wf of [...defs.workflows.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    sources.set(`workflow:${wf.name}`, { kind: "workflows", path: wf.path });
    items.push({ id: `workflow:${wf.name}`, title: `workflow ${wf.name}`, subtitle: `[${wf.layer}]` });
  }
  for (const persona of [...defs.personas.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    sources.set(`persona:${persona.name}`, { kind: "personas", path: persona.path });
    items.push({ id: `persona:${persona.name}`, title: `persona ${persona.name}`, subtitle: `[${persona.layer}]` });
  }

  if (items.length === 0) return await bail("Nothing to fork.", banner(defs));

  const chosen = await pick(items, {
    header: "Fork a definition",
    footer: "↑↓ move · type to filter · Enter choose · Esc cancel",
    banner: banner(defs),
  });
  if (!chosen) return 0;

  const layerDirs = layers(env);
  const targets: PickItem[] = [
    { id: "user", title: "my layer", subtitle: layerDirs[1]!.dir },
    { id: "project", title: "this project", subtitle: layerDirs[2]!.dir },
  ];
  const target = await pick(targets, {
    header: `Fork ${chosen.title} into`,
    footer: "↑↓ move · Enter fork · Esc cancel",
  });
  if (!target) return 0;

  const source = sources.get(chosen.id)!;
  const dir = target.id === "user" ? layerDirs[1]!.dir : layerDirs[2]!.dir;
  const result = forkDefinition(source.path, source.kind, dir);
  return await notice(`${chosen.title}: ${result.message}`, result.ok ? 0 : 1);
}

export async function resumeFlow(herdr: Herdr, env: PluginEnv): Promise<number> {
  const store = new RunStore(env.stateDir);
  const runs = store.resumable();
  if (runs.length === 0) return await bail("No runs with unfinished steps.");

  const items: PickItem[] = runs.map((run) => {
    const left = run.unfinished().map((s) => s.id).join(", ");
    return {
      id: run.id,
      title: run.record.slug,
      subtitle: `${run.record.status} · left: ${left} · ${run.record.created_at.slice(0, 16).replace("T", " ")}`,
    };
  });

  const chosen = await pick(items, {
    header: "Resume a run",
    footer: "↑↓ move · type to filter · Enter resume · Esc cancel",
  });
  if (!chosen) return 0;

  const run = store.load(chosen.id);
  await herdr.pluginPaneOpen({
    entrypoint: "runner",
    env: { HERDR_WORKFLOWS_RUN: run.id, HERDR_WORKFLOWS_CWD: run.record.cwd },
    focus: true,
    workspaceId: env.workspaceId,
    cwd: run.record.cwd,
  });
  try {
    await herdr.popupClose();
  } catch {
    // Only a popup can close itself; running the picker in a plain pane is fine.
  }
  return 0;
}

export async function runnerFlow(herdr: Herdr, env: PluginEnv): Promise<number> {
  const runId = process.env.HERDR_WORKFLOWS_RUN;
  if (!runId) {
    console.error("HERDR_WORKFLOWS_RUN is not set; open this pane through the picker.");
    return 2;
  }
  const store = new RunStore(env.stateDir);
  const run = store.load(runId);
  const defs = loadDefinitions(layers({ ...env, cwd: run.record.cwd }));
  const defaults = loadDefaults(env.configDir);
  const wf = resolveWorkflow(run.record.workflow, defs, defaults);

  if (env.tabId) {
    await herdr.tabRename(env.tabId, tabLabel(GLYPH.running, run.record.workflow, runTarget(wf, run.record)));
  }
  console.log(`${run.id}\n${wf.title}\n`);
  for (const [name, value] of Object.entries(run.record.inputs)) {
    // The kind is shown with its own Input, not as a second line of its own.
    if (isKindCompanion(name, run.record.inputs)) continue;
    const kind = run.record.inputs[`${name}_kind`];
    const where = run.record.input_sources[name] ?? "?";
    console.log(`  ${name} = ${value || "(empty)"} [${kind ? `${kind} · ${where}` : where}]`);
  }
  console.log("");

  const status = await executeRun({
    herdr,
    defs,
    defaults,
    wf,
    run,
    env,
    hostPaneId: env.paneId,
    out: (line) => console.log(line),
    handoffTimeoutMs: defaults.handoffTimeoutMs,
    // A Choice step asks in this pane, which is where the terminal is.
    prompts: {
      menu: (items, opts) => pick(items, opts),
      ask: (question) => ask(question),
    },
  });

  console.log(`\nRun dir: ${run.dir}`);
  await hold();
  return status === "done" ? 0 : 1;
}

function primaryInput(resolutions: Resolution[]): string {
  const first = resolutions.find((r) => r.value !== "");
  if (!first) return "run";
  // A path value would slug the whole path, so a strategy may offer a short name.
  return first.label ?? first.value;
}

async function bail(message: string, extra?: string): Promise<number> {
  return await notice(message, 1, extra);
}

async function notice(message: string, code: number, extra?: string): Promise<number> {
  process.stdout.write(`\x1b[2J\x1b[H${extra ? `${extra}\n\n` : ""}${message}\n\nPress any key to close.\n`);
  await anyKey();
  return code;
}

async function hold(): Promise<void> {
  if (!process.stdin.isTTY) return;
  process.stdout.write("\nPress any key to close this pane.\n");
  await anyKey();
}

async function anyKey(): Promise<void> {
  if (!process.stdin.isTTY) return;
  await nextKey();
  releaseKeyboard();
}
