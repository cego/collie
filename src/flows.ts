// What each plugin action does. Actions have no tty, so they only open a pane;
// the interactive work happens in the `picker` and `runner` pane entrypoints.

import { spawn } from "node:child_process";
import { loadDefaults } from "./config";
import {
  DefinitionError,
  layers,
  loadDefinitions,
  resolveWorkflow,
  validateWorkflow,
  type Definitions,
} from "./definitions";
import { executeRun } from "./engine";
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
import {
  ask,
  confirm,
  nextKey,
  pick,
  releaseKeyboard,
  startKeyboard,
  takeKey,
  type PickItem,
} from "./picker";
import { forkDefinition, type DefinitionKind } from "./fork";
import { RunStore } from "./run";
import { sendReviewToImplementer, type Session } from "./handoff";
import {
  answerChoice,
  appendProgress,
  clearPid,
  driverAlive,
  filePrompts,
  lastProgress,
  readChoice,
  RUNNER_LOG,
  stopDriver,
  writePid,
  type PendingChoice,
} from "./driver";
import { scopeFor } from "./registry";
import {
  agentForKey,
  askingRun,
  buildView,
  renderWorkspace,
  type Asking,
  type RunRow,
  type WorkspaceView,
} from "./workspace";

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

/**
 * The workspace a Run is started in, by name as well as by id: ids compact, so the
 * label is what tells a recycled id from the workspace the Run actually belongs to.
 */
async function workspaceLabel(herdr: Herdr, env: PluginEnv): Promise<string | null> {
  if (!env.workspaceId) return null;
  try {
    return (await herdr.workspaceList()).find((w) => w.workspaceId === env.workspaceId)?.label ?? null;
  } catch {
    // Without a label the Run is still scoped by session, workspace id and cwd.
    return null;
  }
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
    session: env.socketPath,
    workspace: env.workspaceId,
    workspaceLabel: await workspaceLabel(herdr, env),
    inputs: inputValues(resolutions),
    inputSources: inputSources(resolutions),
    stepIds: resolved.steps.map((s) => s.id),
    maxIterations: resolved.maxIterations,
    primaryInput: primaryInput(resolutions),
  });
  run.log(`created from ${resolved.path} (${resolved.layer} layer)`);
  run.log(line);

  spawnDriver(env, run.id, env.cwd);
  try {
    await herdr.popupClose();
  } catch {
    // Only a popup can close itself; running the picker in a plain pane is fine.
  }
  return 0;
}

/**
 * The run driver, detached: it outlives this pane, because the picker closes the
 * moment it has started one and a run takes hours.
 *
 * `detached` is the load-bearing word. Closing a pane sends SIGHUP to the whole
 * process group, and `nohup` protects only the process it wraps — the driver's own
 * `herdr` calls died with `exit 129` the first time this was tried. A session of its
 * own is what actually takes the driver out of the terminal's reach.
 */
export function spawnDriver(env: PluginEnv, runId: string, cwd: string): void {
  const [command = "", ...rest] = (
    process.env.HERDR_WORKFLOWS_DRIVER ?? `${env.pluginRoot}/bin/herdr-workflows`
  ).split(" ");
  spawn(command, [...rest, "drive"], {
    cwd,
    env: {
      ...process.env,
      HERDR_WORKFLOWS_RUN: runId,
      HERDR_WORKFLOWS_CWD: cwd,
    } as Record<string, string>,
    detached: true,
    stdio: "ignore",
  }).unref();
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
  // A run something is still driving is not a run to resume: a second driver would
  // fight the first over the same agents and the same run record.
  const runs = store.resumable().filter((run) => !driverAlive(run.dir));
  if (runs.length === 0) return await bail("No runs with unfinished steps that nothing is already driving.");

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
  if (driverAlive(run.dir)) {
    return await bail(`${run.record.slug} is already being driven; nothing started.`);
  }
  spawnDriver(env, run.id, run.record.cwd);
  try {
    await herdr.popupClose();
  } catch {
    // Only a popup can close itself; running the picker in a plain pane is fine.
  }
  return 0;
}

/**
 * The run driver. No terminal, no pane: it writes what it is doing into the run
 * dir and asks its questions there, and the Control Plane is what renders both.
 * Everything it can say about a failure goes into `runner.log`.
 */
export async function driveFlow(herdr: Herdr, env: PluginEnv): Promise<number> {
  const runId = process.env.HERDR_WORKFLOWS_RUN;
  if (!runId) {
    console.error("HERDR_WORKFLOWS_RUN is not set; a driver is started by the picker.");
    return 2;
  }
  const store = new RunStore(env.stateDir);
  const run = store.load(runId);
  const out = (line: string) => appendProgress(run.dir, line);

  if (driverAlive(run.dir)) {
    out("a driver is already running this run; this one is stopping");
    return 1;
  }
  writePid(run.dir);

  try {
    const defs = loadDefinitions(layers({ ...env, cwd: run.record.cwd }));
    const defaults = loadDefaults(env.configDir);
    const wf = resolveWorkflow(run.record.workflow, defs, defaults);
    out(`${wf.title}`);

    const status = await executeRun({
      herdr,
      defs,
      defaults,
      wf,
      run,
      env,
      out,
      handoffTimeoutMs: defaults.handoffTimeoutMs,
      // Every question this run asks goes through the run dir to the Control Plane.
      prompts: filePrompts({
        dir: run.dir,
        run: run.id,
        step: () => run.record.steps.find((st) => st.status === "running")?.id ?? "",
        timeoutMs: defaults.handoffTimeoutMs,
      }),
    });
    return status === "done" ? 0 : 1;
  } catch (e) {
    // Nobody is watching a pane for this, so the only useful place is the log.
    const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
    out(`the driver stopped: ${detail.split("\n")[0]}`);
    run.log(`driver failed: ${detail}`);
    run.record.status = "failed";
    run.save();
    try {
      await herdr.notify(`${run.record.slug} failed`, `see ${RUNNER_LOG} in the run dir`, "request");
    } catch {
      /* a missing toast must not be the last word */
    }
    return 1;
  } finally {
    clearPid(run.dir);
  }
}

/** How often the tab re-reads the files and asks herdr what is still alive. */
const REFRESH_MS = 1500;
/** How long a keypress may wait; the tab has to feel like a TUI, not a report. */
const TICK_MS = 120;

const CLEAR = "\x1b[2J\x1b[H";

/**
 * The Control Plane tab: the Session's control surface. It watches the run dirs
 * and the register and draws them; the quick actions are the plugin's own
 * actions and one hand-off. It drives no run and holds no engine state, so
 * closing it loses nothing.
 */
export async function workspaceFlow(herdr: Herdr, env: PluginEnv): Promise<number> {
  const session: Session = {
    herdr,
    ...scopeFor(env, env.cwd),
    stateDir: env.stateDir,
    paneId: env.paneId,
  };
  startKeyboard();
  let view = await load(session);
  const open = (mode: Mode) => openMode(herdr, env, mode);
  let note: string | null = null;
  let drawn = "";
  let read = Date.now();
  let asking: Asking = { index: 0, typed: "" };
  let answering: string | null = null;

  for (;;) {
    const waiting = askingRun(view);
    // A new question starts from the top, with nothing typed.
    if (waiting && waiting.id !== answering) {
      asking = { index: 0, typed: "" };
      answering = waiting.id;
      await announce(herdr, env, waiting);
    }
    if (!waiting) answering = null;

    const text = renderWorkspace(view, note ?? undefined, asking);
    if (text !== drawn) {
      process.stdout.write(`${CLEAR}${text.replace(/\n/g, "\r\n")}\r\n`);
      drawn = text;
    }
    const key = takeKey();
    if (key !== null) {
      // While a run is asking, every key belongs to that question.
      if (waiting) {
        const answered = answerKey(waiting, asking, key);
        asking = answered.asking;
        note = answered.note ?? note;
      } else if (key === "q" || key === "\x03") {
        releaseKeyboard();
        return 0;
      } else {
        note = await act(session, view, key, open);
      }
      view = await load(session);
      read = Date.now();
      continue;
    }
    if (Date.now() - read >= REFRESH_MS) {
      view = await load(session);
      read = Date.now();
    }
    await new Promise((r) => setTimeout(r, TICK_MS));
  }
}

/**
 * A question nobody sees is a run that has silently stopped, so the board says it
 * twice: a toast, and this tab brought to the front.
 */
async function announce(herdr: Herdr, env: PluginEnv, waiting: RunRow): Promise<void> {
  try {
    await herdr.notify(`${waiting.title} needs you`, `${waiting.choice?.step}: pick what happens next`, "request");
  } catch {
    /* a missing toast must not stop the question being asked */
  }
  if (!env.tabId) return;
  try {
    await herdr.tabFocus(env.tabId);
  } catch {
    /* a tab that will not focus is still a tab the human can reach */
  }
}

/** One keypress against a pending question; the answer goes back to the run dir. */
export function answerKey(
  waiting: RunRow,
  asking: Asking,
  key: string,
): { asking: Asking; note?: string } {
  const choice = waiting.choice!;
  const send = (answer: { choice?: string | null; text?: string | null }) => {
    answerChoice(waiting.dir, { id: choice.id, ...answer });
    return { asking: { index: 0, typed: "" }, note: `answered ${waiting.title}` };
  };

  if (key === "\x1b" || key === "\x03") return send({ choice: null, text: null });
  if (key === "\r" || key === "\n") {
    if (choice.kind === "ask") return send({ text: asking.typed });
    const picked = choice.items[asking.index];
    return picked ? send({ choice: picked.id }) : { asking };
  }
  if (choice.kind === "ask") {
    if (key === "\x7f" || key === "\b") return { asking: { ...asking, typed: asking.typed.slice(0, -1) } };
    if (/^[\x20-\x7e]$/.test(key)) return { asking: { ...asking, typed: asking.typed + key } };
    return { asking };
  }
  if (key === "\x1b[A") return { asking: { ...asking, index: Math.max(0, asking.index - 1) } };
  if (key === "\x1b[B") {
    return { asking: { ...asking, index: Math.min(choice.items.length - 1, asking.index + 1) } };
  }
  return { asking };
}

/**
 * The picker, opened in the board's own pane rather than as a popup: a popup lands
 * on whatever pane herdr has focused, which is rarely the workspace this board is
 * for, and the mode and cwd have to be this board's.
 */
async function openMode(herdr: Herdr, env: PluginEnv, mode: Mode): Promise<void> {
  await herdr.pluginPaneOpen({
    entrypoint: "picker",
    placement: "split",
    targetPaneId: env.paneId ?? undefined,
    direction: "down",
    cwd: env.cwd,
    env: { HERDR_WORKFLOWS_MODE: mode, HERDR_WORKFLOWS_CWD: env.cwd },
    focus: true,
  });
}

/** What one keypress does. Returns the line to show under the lists, if any. */
async function act(
  session: Session,
  view: WorkspaceView,
  key: string,
  open: (mode: Mode) => Promise<void>,
): Promise<string | null> {
  if (/^[1-9]$/.test(key)) {
    const agent = agentForKey(view, key);
    if (!agent) return null;
    try {
      await session.herdr.agentFocus(agent.agent);
      return `focused ${agent.name} (${agent.agent})`;
    } catch (e) {
      return `${agent.agent}: ${(e as Error).message}`;
    }
  }
  const modes: Record<string, Mode> = { p: "pick", u: "resume", f: "fork" };
  const mode = modes[key];
  if (mode) {
    try {
      await open(mode);
      return null;
    } catch (e) {
      return `${mode}: ${(e as Error).message}`;
    }
  }
  if (key === "s") return (await sendReviewToImplementer(session)).message;
  if (key === "l") return await openLog(session, view);
  if (key === "k") return stopRun(view);
  return null;
}

/**
 * Stops the newest run. A run used to stop when you closed its pane; the driver has
 * no pane now, so this replaces that. Its agents are left where they are: their
 * panes are the transcript of what happened.
 */
function stopRun(view: WorkspaceView): string {
  const run = view.active[0];
  if (!run) return "nothing running here to stop";
  return stopDriver(run.dir) ? `stopped ${run.title}` : `${run.title} has no driver to stop`;
}

/**
 * The newest run's `runner.log` in a pane of its own. The driver has no pane, so
 * this is the only place its detail can be read, and a temporary pane is the
 * cheapest way to read it without leaving the board.
 */
export async function openLog(session: Session, view: WorkspaceView): Promise<string | null> {
  const run = view.active[0] ?? view.recent[0];
  if (!run) return "no run here to open a log for";
  const path = `${run.dir}/${RUNNER_LOG}`;
  try {
    const pane = await session.herdr.paneSplit({ paneId: session.paneId ?? "", direction: "down", ratio: 0.6 });
    await session.herdr.paneRun(pane, `less +G ${path}`);
    return `opened ${run.title}'s log`;
  } catch (e) {
    return `${path}: ${(e as Error).message}`;
  }
}

async function load(session: Session): Promise<WorkspaceView> {
  let alive: Awaited<ReturnType<Herdr["agentList"]>> = [];
  let label: string | null = null;
  try {
    alive = await session.herdr.agentList();
    // The live label is how a run recorded against a since-recycled workspace id
    // is kept out; without it the board falls back to the id alone.
    label =
      (await session.herdr.workspaceList()).find((w) => w.workspaceId === session.workspaceId)?.label ?? null;
  } catch {
    // A herdr that will not answer means "nothing verified live", not a crash.
  }
  return buildView({ ...session, stateDir: session.stateDir, workspaceLabel: label, alive });
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
