// The Control Plane tab: one per workspace, the Session's control surface. It owns
// no engine state — it reads the run dirs and the live-agent register and draws
// what it finds, so deleting the tab loses nothing and the next Run recreates it.

import { existsSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { driverAlive, lastProgress, readChoice, type PendingChoice } from "./driver";
import { CONTROL_PLANE, displayName, GLYPH, targetLabel } from "./naming";
import { liveEntries, readRegistry, registryPath, type AgentEntry } from "./registry";
import { RunStore, type Run, type RunRecord, type VariantRecord } from "./run";
import type { AgentInfo } from "./herdr";

/** How many finished runs stay on the screen; the tab must not need scrolling. */
const RECENT = 5;
/** Keys 1–9 focus an agent, so that is how many the board can offer. */
const MAX_AGENTS = 9;
/**
 * How long a `running` run with no live agent has to have been quiet before it is
 * called abandoned. A live run always has an agent, except in the seconds between
 * being created and starting its first one.
 */
const STALE_MS = 60_000;

/** What identifies a Session: one herdr session, one workspace, one repo cwd. */
export interface SessionKey {
  /** The herdr session, as its socket path — 0.8.2 exposes no session id. */
  session: string | null;
  workspaceId: string | null;
  /** The live workspace's label, which is how a recycled workspace id is caught. */
  workspaceLabel: string | null;
  cwd: string;
}

export interface AgentRow {
  /** The key that focuses this agent's pane. */
  key: string;
  /** What to call it: its registered role, else its step and model. */
  name: string;
  agent: string;
  status: string;
  run: string;
}

export interface RunRow {
  id: string;
  /** The run dir, so an answer or a log can be written back to it. */
  dir: string;
  glyph: string;
  title: string;
  detail: string;
  /** The question this run is waiting on, rendered under its row. */
  choice: PendingChoice | null;
}

export interface WorkspaceView {
  repo: string;
  cwd: string;
  agents: AgentRow[];
  /** Live agents the board had no key left for. */
  extraAgents: number;
  active: RunRow[];
  recent: RunRow[];
}

function variantsOf(record: RunRecord): VariantRecord[] {
  return record.steps.flatMap((s) => s.variants);
}

/** The run's own agents that herdr still has, in this workspace. */
function agentsHere(record: RunRecord, hereNames: Set<string>): VariantRecord[] {
  return variantsOf(record).filter((v) => hereNames.has(v.agent));
}

/**
 * A run recorded against another workspace never belongs here, even for the same
 * repo. One recorded before workspaces were noted belongs here only if one of its
 * agents is alive in this workspace, which is the only proof available for it.
 */
function belongs(record: RunRecord, key: SessionKey, hereNames: Set<string>): boolean {
  if (record.cwd !== key.cwd) return false;
  if (record.session && key.session && record.session !== key.session) return false;
  if (record.workspace !== null) {
    if (record.workspace !== key.workspaceId) return false;
    // Workspace ids compact, so a label recorded and since changed means a
    // different workspace is wearing the same id.
    return !record.workspace_label || !key.workspaceLabel || record.workspace_label === key.workspaceLabel;
  }
  return agentsHere(record, hereNames).length > 0;
}

function title(record: RunRecord): string {
  const target = record.target_label ?? targetLabel(record.workflow, record.slug, record.inputs);
  const name = displayName(record.workflow);
  return target ? `${name} · ${target}` : name;
}

/**
 * What an agent is called here: the role it was registered under where it has one
 * — those are the agents a hand-off can name — and otherwise its step, plus its
 * model where that step ran several. Roles label agents; they never filter them.
 */
function agentTitle(variant: VariantRecord, registered: AgentEntry | undefined): string {
  if (registered) return displayName(registered.role);
  const [, step = "", key] = variant.label.split("/");
  const name = displayName(step.slice(step.lastIndexOf(".") + 1));
  if (!key) return name;
  return `${name} · ${displayName(variant.model.slice(variant.model.lastIndexOf("/") + 1))}`;
}

function activeDetail(run: Run): string {
  const record = run.record;
  if (record.awaiting) return `${record.awaiting} — your turn`;
  const step = record.steps.find((s) => s.status === "running" || s.status === "blocked");
  const where = step ? step.id : "starting";
  const at = record.max_iterations > 1
    ? `${where} · iteration ${record.iteration}/${record.max_iterations}`
    : where;
  // What the driver last said, which is what the runner pane used to show.
  const said = lastProgress(run.dir);
  return said ? `${at} · ${said}` : at;
}

function recentDetail(record: RunRecord, abandoned: boolean): string {
  const parts: string[] = [abandoned ? "abandoned" : record.status];
  if (record.outstanding.length > 0) parts.push(`${record.outstanding.length} finding(s) open`);
  // Why it stopped, which used to be in the runner pane and is now only in the log.
  const note = record.steps.filter((s) => s.note && s.status !== "done").at(-1)?.note;
  if (note && record.status !== "done") parts.push(note);
  if (record.mr_url) parts.push(record.mr_url);
  return parts.join(" · ");
}

function glyphFor(record: RunRecord, abandoned: boolean): string {
  if (abandoned) return GLYPH.waiting;
  if (record.status === "done") return GLYPH.done;
  if (record.status === "failed") return GLYPH.failed;
  if (record.status === "blocked") return GLYPH.waiting;
  return record.awaiting ? GLYPH.waiting : GLYPH.running;
}

/** When a run last changed: a run making progress rewrites run.json as it goes. */
function touchedAt(run: Run): number {
  const path = join(run.dir, "run.json");
  try {
    return existsSync(path) ? statSync(path).mtimeMs : 0;
  } catch {
    return 0;
  }
}

/**
 * A run whose driver is gone: still marked `running`, nothing driving it, no agent
 * of its own left alive, and quiet for long enough that it cannot be one that has
 * just started. Nothing marks such a run — the process that would have is the one
 * that died — so the board says so instead of showing it as work in progress.
 */
function abandonedRun(run: Run, hereNames: Set<string>, now: number): boolean {
  if (run.record.status !== "running") return false;
  if (driverAlive(run.dir)) return false;
  if (agentsHere(run.record, hereNames).length > 0) return false;
  return now - touchedAt(run) > STALE_MS;
}

/**
 * Everything the tab shows, from the run dirs and one `agent list`: the runs of
 * this Session and every agent of theirs herdr still knows about. `alive` is what
 * herdr answered, so this stays a pure function of state and is testable without
 * a herdr.
 */
export function buildView(
  opts: SessionKey & { stateDir: string; alive: AgentInfo[]; now?: number },
): WorkspaceView {
  const now = opts.now ?? Date.now();
  // Only agents in this workspace count, whatever a run record claims.
  const here = opts.alive.filter((a) => a.workspaceId === null || a.workspaceId === opts.workspaceId);
  const hereNames = new Set(here.map((a) => a.name));
  const status = new Map(here.map((a) => [a.name, a.status]));

  const runs = new RunStore(opts.stateDir).list().filter((r) => belongs(r.record, opts, hereNames));
  const registered = new Map(
    liveEntries(readRegistry(registryPath(opts.stateDir, opts)), here).map((e) => [e.agent, e]),
  );

  const rows: AgentRow[] = [];
  for (const run of runs) {
    for (const variant of agentsHere(run.record, hereNames)) {
      if (rows.some((r) => r.agent === variant.agent)) continue;
      rows.push({
        key: "",
        name: agentTitle(variant, registered.get(variant.agent)),
        agent: variant.agent,
        status: status.get(variant.agent) ?? "unknown",
        run: run.id,
      });
    }
  }
  // The ones a hand-off can name come first; that is mostly what the keys are for.
  rows.sort((a, b) => Number(registered.has(b.agent)) - Number(registered.has(a.agent)));
  const agents = rows.slice(0, MAX_AGENTS).map((r, i) => ({ ...r, key: String(i + 1) }));

  const abandoned = new Set(runs.filter((r) => abandonedRun(r, hereNames, now)).map((r) => r.id));
  const stopped = runs.filter((r) => r.record.status !== "running" || abandoned.has(r.id));

  return {
    repo: basename(opts.cwd),
    cwd: opts.cwd,
    agents,
    extraAgents: rows.length - agents.length,
    active: runs
      .filter((r) => r.record.status === "running" && !abandoned.has(r.id))
      .map((r) => ({
        id: r.id,
        dir: r.dir,
        glyph: glyphFor(r.record, false),
        title: title(r.record),
        detail: activeDetail(r),
        choice: readChoice(r.dir),
      })),
    recent: stopped.slice(0, RECENT).map((r) => ({
      id: r.id,
      dir: r.dir,
      glyph: glyphFor(r.record, abandoned.has(r.id)),
      title: title(r.record),
      detail: recentDetail(r.record, abandoned.has(r.id)),
      choice: null,
    })),
  };
}

function section(name: string, rows: string[], empty: string): string[] {
  return ["", name, ...(rows.length > 0 ? rows : [`  (${empty})`])];
}

/** What the human is being asked, under the run that is asking, never elsewhere. */
export interface Asking {
  /** Which option is highlighted, or the text typed so far for a question. */
  index: number;
  typed: string;
}

function askingRows(choice: PendingChoice, asking: Asking): string[] {
  const rows = [`      ${choice.header}`];
  if (choice.kind === "ask") {
    rows.push(`      > ${asking.typed}`, "      type an answer · Enter send · Esc leave it");
    return rows;
  }
  for (const [i, item] of choice.items.entries()) {
    const marker = i === asking.index ? "❯" : " ";
    rows.push(`      ${marker} ${item.title.padEnd(26)}${item.subtitle ?? ""}`);
  }
  rows.push("      ↑↓ move · Enter choose · Esc leave the run open");
  return rows;
}

function runRows(rows: RunRow[], asking: Asking, waiting: string | null): string[] {
  const out: string[] = [];
  for (const r of rows) {
    out.push(`  ${r.glyph} ${r.title.padEnd(30)}${r.detail}`);
    if (r.choice && r.id === waiting) out.push(...askingRows(r.choice, asking));
  }
  return out;
}

/** The run whose question is being answered, if any: the first one asking. */
export function askingRun(view: WorkspaceView): RunRow | null {
  return view.active.find((r) => r.choice) ?? null;
}

/** Plain lists, one screen, no boxes: this is a status board, not an application. */
export function renderWorkspace(
  view: WorkspaceView,
  note?: string,
  asking: Asking = { index: 0, typed: "" },
): string {
  const lines = [`${CONTROL_PLANE} — ${view.repo}`, view.cwd];

  const agents = view.agents.map((a) => `  ${a.key}  ${a.name.padEnd(22)}${a.status.padEnd(9)}${a.run}`);
  if (view.extraAgents > 0) agents.push(`     … and ${view.extraAgents} more without a key`);

  const waiting = askingRun(view);
  // The key line offers only what is there: a key with nothing to act on is a lie.
  // While a run is asking, the keys are that question's.
  const keys = waiting
    ? ["answering " + waiting.title]
    : [
        ...(view.agents.length > 0 ? ["1-9 focus that agent"] : []),
        "p run a workflow",
        "u resume",
        "f fork",
        "s send the last review to the implementer",
        "l open a run's log",
        "k stop the newest run",
        "q close this tab",
      ];

  lines.push(
    ...section("Agents", agents, "none live here"),
    ...section("Runs", runRows(view.active, asking, waiting?.id ?? null), "none running"),
    ...section("Finished", runRows(view.recent, asking, null), "nothing yet"),
    "",
    keys.join(" · "),
  );
  if (note) lines.push("", note);
  return lines.join("\n");
}

export function agentForKey(view: WorkspaceView, key: string): AgentRow | null {
  return view.agents.find((a) => a.key === key) ?? null;
}
