// The `workflows` tab: one per workspace, the Session's control surface. It owns
// no engine state — it reads the run dirs and the live-agent registry and draws
// what it finds, so deleting the tab loses nothing and the next Run recreates it.

import { basename } from "node:path";
import { GLYPH, targetLabel, WORKSPACE_TAB } from "./naming";
import { liveEntries, readRegistry, registryPath } from "./registry";
import { RunStore, type RunRecord } from "./run";
import type { AgentInfo } from "./herdr";

/** How many finished runs stay on the screen; the tab must not need scrolling. */
const RECENT = 5;

export interface AgentRow {
  /** The key that focuses this agent's pane. */
  key: string;
  role: string;
  agent: string;
  status: string;
  run: string;
}

export interface RunRow {
  id: string;
  glyph: string;
  title: string;
  detail: string;
}

export interface WorkspaceView {
  repo: string;
  cwd: string;
  agents: AgentRow[];
  active: RunRow[];
  recent: RunRow[];
}

/** A Session is one workspace and one repo cwd; nothing else belongs on this tab. */
function inSession(record: RunRecord, workspaceId: string | null, cwd: string): boolean {
  if (record.cwd !== cwd) return false;
  // A run recorded before workspaces were noted is judged on its cwd alone.
  return record.workspace === null || record.workspace === workspaceId;
}

function title(record: RunRecord): string {
  const target = record.target_label ?? targetLabel(record.workflow, record.slug, record.inputs);
  return target ? `${record.workflow} · ${target}` : record.workflow;
}

function activeDetail(record: RunRecord): string {
  if (record.awaiting) return `${record.awaiting} — your turn`;
  const step = record.steps.find((s) => s.status === "running" || s.status === "blocked");
  const where = step ? step.id : "starting";
  return record.max_iterations > 1
    ? `${where} · iteration ${record.iteration}/${record.max_iterations}`
    : where;
}

function recentDetail(record: RunRecord): string {
  const open = record.outstanding.length;
  const parts: string[] = [record.status];
  if (open > 0) parts.push(`${open} finding(s) open`);
  if (record.mr_url) parts.push(record.mr_url);
  return parts.join(" · ");
}

function glyphFor(record: RunRecord): string {
  if (record.status === "done") return GLYPH.done;
  if (record.status === "failed") return GLYPH.failed;
  if (record.status === "blocked") return GLYPH.waiting;
  return record.awaiting ? GLYPH.waiting : GLYPH.running;
}

/**
 * Everything the tab shows, from the files alone: the runs in this Session and
 * the registry entries herdr still recognises. `alive` is what herdr answered,
 * so this stays a pure function of state and is testable without a herdr.
 */
export function buildView(opts: {
  stateDir: string;
  workspaceId: string | null;
  cwd: string;
  alive: AgentInfo[];
}): WorkspaceView {
  const runs = new RunStore(opts.stateDir)
    .list()
    .filter((r) => inSession(r.record, opts.workspaceId, opts.cwd));

  const entries = liveEntries(
    readRegistry(registryPath(opts.stateDir, opts.workspaceId, opts.cwd)),
    opts.alive,
  );
  const status = new Map(opts.alive.map((a) => [a.name, a.status]));

  return {
    repo: basename(opts.cwd),
    cwd: opts.cwd,
    agents: entries.map((e, i) => ({
      key: String(i + 1),
      role: e.role,
      agent: e.agent,
      status: status.get(e.agent) ?? "unknown",
      run: e.runId,
    })),
    active: runs
      .filter((r) => r.record.status === "running")
      .map((r) => ({ id: r.id, glyph: glyphFor(r.record), title: title(r.record), detail: activeDetail(r.record) })),
    recent: runs
      .filter((r) => r.record.status !== "running")
      .slice(0, RECENT)
      .map((r) => ({ id: r.id, glyph: glyphFor(r.record), title: title(r.record), detail: recentDetail(r.record) })),
  };
}

const KEYS = [
  "1-9 focus that agent",
  "p run a workflow",
  "u resume",
  "f fork",
  "s send the last review to the implementer",
  "q close this tab",
];

function section(name: string, rows: string[], empty: string): string[] {
  return ["", name, ...(rows.length > 0 ? rows : [`  (${empty})`])];
}

/** Plain lists, one screen, no boxes: this is a status board, not an application. */
export function renderWorkspace(view: WorkspaceView, note?: string): string {
  const lines = [`${WORKSPACE_TAB} — ${view.repo}`, view.cwd];

  lines.push(
    ...section(
      "Agents",
      view.agents.map((a) => `  ${a.key}  ${a.role.padEnd(12)}${a.status.padEnd(9)}${a.run}`),
      "none live here",
    ),
    ...section(
      "Runs",
      view.active.map((r) => `  ${r.glyph} ${r.title.padEnd(30)}${r.detail}`),
      "none running",
    ),
    ...section(
      "Finished",
      view.recent.map((r) => `  ${r.glyph} ${r.title.padEnd(30)}${r.detail}`),
      "nothing yet",
    ),
    "",
    KEYS.join(" · "),
  );
  if (note) lines.push("", note);
  return lines.join("\n");
}

export function agentForKey(view: WorkspaceView, key: string): AgentRow | null {
  return view.agents.find((a) => a.key === key) ?? null;
}
