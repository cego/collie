// WARNING: owns no engine state: deleting the tab loses nothing and the next Run recreates it.
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { Clock, Effect, FileSystem, Option, Path } from "effect";
import { behindRemote } from "./doctor";
import { newerRelease, RELEASES } from "./releases";
import manifest from "../package.json";
import { COLLIE_TAB, displayName, GLYPH, runTitle } from "./naming";
import { diffTargetOf } from "./strategies";
import type { Live } from "./live";
import { boardLines } from "./board";
import type { PendingChoice } from "./board";
import type { TaskView } from "./board-model";
import { asText, cardLines, deliveryLine, driftLines, newsLines } from "./lines";
import type { Line } from "./lines";
import { liveEntries } from "./registry";
import type { AgentEntry } from "./registry";
import { latest, readDispositions } from "./disposition";
import { openFindingsIn } from "./output";
import { settled } from "./runs";
import type { RunFacts } from "./runs";
import type { TaskRecord } from "./task";
import { took, epochMs } from "./time";
import type { AgentInfo } from "./herdr";

const RECENT = 5;
// WARNING: keys 1-9 focus an agent, which bounds how many the board can offer.
export const MAX_AGENTS = 9;
const DEFAULT_QUIET_MS = 5 * 60_000;

export interface SessionKey {
  session: string | null;
  workspaceId: string | null;
  workspaceLabel: string | null;
  cwd: string;
}

export interface AgentRow {
  key: string;
  name: string;
  agent: string;
  status: string;
  run: string;
  now: string | null;
}

export interface RunRow {
  id: string;
  dir: string;
  glyph: string;
  title: string;
  detail: string;
  at: number;
  target: string | null;
  // WARNING: the fan-out's own record: an ordinary chain's parent ends early, so parentage would misplace live runs.
  children: ReadonlyArray<string>;
  fixable: boolean;
  choice: PendingChoice | null;
  needsYou: boolean;
  outcome: string | null;
  gaps: number;
  obstacle: string | null;
  next: string | null;
  delivered: string | null;
}

export interface WorkspaceView {
  repo: string;
  cwd: string;
  worktrees: Array<string>;
  behind: number | null;
  newer?: string | null;
  now: number;
  agents: Array<AgentRow>;
  extraAgents: number;
  active: Array<RunRow>;
  recent: Array<RunRow>;
}

export interface WideGroup {
  workspaceId: string | null;
  label: string;
  glyph: string;
  running: number;
  needsYou: number;
  summary: string;
  active: Array<RunRow>;
  recent: Array<RunRow>;
  agents: Array<AgentRow>;
}

export interface WideView {
  groups: Array<WideGroup>;
  quiet: Array<string>;
  now: number;
}

function workspaceOf(run: RunFacts, tasks: ReadonlyMap<string, TaskRecord>) {
  return run.workspace ?? (run.task === null ? null : (tasks.get(run.task)?.workspace ?? null));
}

function belongs(
  where: string | null,
  key: SessionKey,
  agentsHere: ReadonlyArray<AgentEntry>,
  grouped: boolean,
) {
  if (where === null) {
    return !grouped && agentsHere.length > 0;
  }
  return where === key.workspaceId;
}

const activeDetail = Effect.fn("activeDetail")(function* (
  run: RunFacts,
  now: number,
  quietMs: number,
) {
  const asked = run.asking[0];
  // WARNING: must come before the quiet scan, or a run waiting on the human reads as quiet.
  if (asked !== undefined) {
    return `waiting on ${asked.name} — your turn`;
  }
  if (run.state === "waiting") {
    return run.note ?? "parked";
  }
  if (run.awaiting !== null) {
    return `waiting for ${run.awaiting.on}`;
  }
  const parts = [run.workflow];
  const quiet = yield* quietFor(run.dir, now, quietMs);
  if (quiet) {
    parts.push(quiet);
  }
  return Arr.join(parts, " · ");
});

const mtimeOf = Effect.fn("mtimeOf")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.stat(file).pipe(
    Effect.map((s) => (Option.isSome(s.mtime) ? s.mtime.value.getTime() : 0)),
    Effect.orElseSucceed(() => 0),
  );
});

// WARNING: a shallow scan: a run that writes only below its top is not seen.
export const touchedDirAt = Effect.fn("touchedDirAt")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
  let newest = 0;
  for (const name of names) {
    const at = yield* mtimeOf(path.join(dir, name));
    if (at > newest) {
      newest = at;
    }
  }
  return newest;
});

const quietFor = Effect.fn("quietFor")(function* (dir: string, now: number, quietMs: number) {
  const at = yield* touchedDirAt(dir);
  if (at === 0 || now - at <= quietMs) {
    return null;
  }
  return `quiet for ${took(now - at)}`;
});

export const NO_OUTCOME = {
  outcome: null,
  gaps: 0,
  obstacle: null,
  next: null,
  delivered: null,
} as const;

function outcomeOf(run: RunFacts) {
  return {
    outcome: run.outcome === "unspecified" ? null : run.outcome,
    gaps: 0,
    obstacle: run.state === "failed" || run.state === "waiting" ? run.note : null,
    next: run.asking.length > 0 ? "answer" : null,
  };
}

const deliveredOf = Effect.fn("deliveredOf")(function* (run: RunFacts) {
  if (run.state === "succeeded") {
    return null;
  }
  const line = latest(yield* readDispositions(run.dir).pipe(Effect.orElseSucceed(() => [])));
  if (line === null) {
    return null;
  }
  return line.ref === "" ? line.kind : `${line.kind} ${line.ref}`;
});

function recentDetail(run: RunFacts) {
  const parts: Array<string> = [run.state];
  if (run.state !== "succeeded" && run.note !== null) {
    parts.push(run.note);
  }
  if (run.mr !== null) {
    parts.push(run.mr);
  }
  return Arr.join(parts, " · ");
}

function glyphFor(run: RunFacts) {
  switch (run.state) {
    case "succeeded":
    case "ended":
      return GLYPH.done;
    case "failed":
    case "stopped":
      return GLYPH.failed;
    case "waiting":
      return GLYPH.waiting;
    case "running":
      return GLYPH.running;
  }
}

export const fixableRun = (run: Pick<RunFacts, "dir">) =>
  openFindingsIn(run.dir).pipe(Effect.map((open) => open > 0));

const touchedAt = (run: RunFacts) =>
  run.finished === null ? touchedDirAt(run.dir) : Effect.succeed(epochMs(run.finished));

export const buildView = Effect.fn("buildView")(function* (
  opts: SessionKey & {
    stateDir: string;
    alive: Array<AgentInfo>;
    runs: ReadonlyArray<RunFacts>;
    tasks: ReadonlyArray<TaskRecord>;
    registered: ReadonlyArray<AgentEntry>;
    now?: number;
    worktrees?: Array<string>;
    pluginRoot?: string;
    releases?: string;
    quietMs?: number;
    grouped?: boolean;
  },
) {
  const path = yield* Path.Path;
  const now = opts.now ?? (yield* Clock.currentTimeMillis);
  const quietMs = opts.quietMs ?? DEFAULT_QUIET_MS;
  const here = opts.alive;
  const live = new Map(Arr.map(here, (a) => [a.name, a]));
  const alive = liveEntries(opts.registered, here);
  const tasks = new Map(Arr.map(opts.tasks, (task) => [task.id, task]));
  const agentsHere = (run: RunFacts) => Arr.filter(alive, (entry) => entry.runId === run.id);

  const runs = Arr.filter(opts.runs, (r) =>
    belongs(workspaceOf(r, tasks), opts, agentsHere(r), opts.grouped ?? false),
  );

  const rows: Array<AgentRow> = [];
  for (const run of runs) {
    for (const entry of agentsHere(run)) {
      if (Arr.some(rows, (r) => r.agent === entry.agent)) {
        continue;
      }
      const agent = live.get(entry.agent);
      rows.push({
        key: "",
        name: displayName(entry.role),
        agent: entry.agent,
        status: agent?.status ?? "unknown",
        run: run.id,
        now: null,
      });
    }
  }
  // WARNING: a wide group keeps every agent and gives none a digit: digits number the whole tree.
  const agents = opts.grouped
    ? rows
    : Arr.map(rows.slice(0, MAX_AGENTS), (r, i) => ({ ...r, key: String(i + 1) }));

  const fixable = new Set<string>();
  for (const r of runs) {
    if (yield* fixableRun(r)) {
      fixable.add(r.id);
    }
  }

  const active: Array<RunRow> = [];
  for (const r of Arr.filter(runs, (r) => !settled(r))) {
    // WARNING: herdr's blocked is a permission prompt that nothing else records.
    const blocked = Arr.some(rows, (row) => row.run === r.id && row.status === "blocked");
    active.push({
      id: r.id,
      dir: r.dir,
      glyph: glyphFor(r),
      title: runTitle(r),
      detail: yield* activeDetail(r, now, quietMs),
      at: yield* touchedAt(r),
      target: diffTargetOf(r.settled)?.value ?? null,
      children: [],
      fixable: fixable.has(r.id),
      choice: null,
      needsYou: blocked || r.state === "waiting",
      ...outcomeOf(r),
      delivered: null,
    });
  }

  const recent: Array<RunRow> = [];
  for (const r of Arr.filter(runs, settled).slice(0, RECENT)) {
    recent.push({
      id: r.id,
      dir: r.dir,
      glyph: glyphFor(r),
      title: runTitle(r),
      detail: recentDetail(r),
      at: yield* touchedAt(r),
      target: diffTargetOf(r.settled)?.value ?? null,
      children: [],
      fixable: fixable.has(r.id),
      choice: null,
      needsYou: false,
      ...outcomeOf(r),
      delivered: yield* deliveredOf(r),
    });
  }

  return {
    repo: path.basename(opts.cwd),
    cwd: opts.cwd,
    worktrees: opts.worktrees ?? [],
    behind: opts.pluginRoot ? yield* behindRemote(opts.pluginRoot, undefined, now) : null,
    newer:
      opts.pluginRoot && !(yield* (yield* FileSystem.FileSystem).exists(`${opts.pluginRoot}/.git`))
        ? yield* newerRelease(opts.releases ?? RELEASES, manifest.version, now)
        : null,
    now,
    agents,
    extraAgents: rows.length - agents.length,
    active,
    recent,
  };
});

const indent = (line: string) => `  ${line}`;

export function commitsBehind(behind: number) {
  return `${behind} commit${behind === 1 ? "" : "s"} behind`;
}

function section(name: string, rows: Array<string>, empty: string) {
  return ["", name, ...(rows.length > 0 ? rows : [`  (${empty})`])];
}

export interface Asking {
  index: number;
  typed: string;
}

function askingRows(choice: PendingChoice, asking: Asking) {
  const rows = [`      ${choice.header}`];
  if (choice.kind === "ask") {
    rows.push(`      > ${asking.typed}`, "      type an answer · Enter send · Esc leave it");
    return rows;
  }
  for (const [i, item] of choice.items.entries()) {
    const marker = i === asking.index ? "❯" : " ";
    rows.push(`      ${marker} ${pipe(item.title, Str.padEnd(26))}${item.subtitle ?? ""}`);
  }
  rows.push("      ↑↓ move · Enter choose · Esc leave the run open");
  return rows;
}

function liveLines(live: Live) {
  const lines: Array<Line> = [
    ...newsLines(live.news),
    ...Arr.flatMap(live.cards, cardLines),
    ...Arr.flatMap(live.drift, (report) => driftLines(report)),
    ...Arr.flatMap(live.pending, (report) => driftLines(report, true)),
    ...Arr.map(live.deliveries, deliveryLine),
  ];
  return Arr.map(lines, (entry) => `  ${asText(entry)}`);
}

export function askingRun(view: WorkspaceView) {
  return Option.getOrUndefined(Arr.findFirst(view.active, (r) => Boolean(r.choice))) ?? null;
}

export const newerLine = (version: string) => `Collie ${version} is out — collie upgrade`;

export function renderWorkspace(
  view: WorkspaceView,
  note?: string,
  asking: Asking = { index: 0, typed: "" },
  steering: { live?: Live | null; tasks?: ReadonlyArray<TaskView> } = {},
) {
  const lines = [`${COLLIE_TAB} — ${view.repo}`, view.cwd];
  if (view.behind !== null && view.behind > 0) {
    lines.push(`Collie is ${commitsBehind(view.behind)} its remote — \`collie upgrade\``);
  }
  if (view.newer) {
    lines.push(newerLine(view.newer));
  }

  const agents = Arr.map(
    view.agents,
    (a) =>
      `  ${a.key}  ${pipe(a.name, Str.padEnd(22))}${pipe(a.status, Str.padEnd(9))}${a.now ?? a.run}`,
  );
  if (view.extraAgents > 0) {
    agents.push(`     … and ${view.extraAgents} more without a key`);
  }

  const waiting = askingRun(view);
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
    ...(view.worktrees.length > 0 ? section("Worktrees", Arr.map(view.worktrees, indent), "") : []),
    ...section("Agents", agents, "none live here"),
    ...boardLines(
      steering.tasks ?? [],
      waiting?.choice ? { run: waiting.id, lines: askingRows(waiting.choice, asking) } : null,
    ),
    ...(steering.live ? section("Live", liveLines(steering.live), "nothing yet") : []),
    "",
    Arr.join(keys, " · "),
  );
  if (note) {
    lines.push("", note);
  }
  return Arr.join(lines, "\n");
}

export function agentForKey(view: WorkspaceView, key: string) {
  return Option.getOrUndefined(Arr.findFirst(view.agents, (a) => a.key === key)) ?? null;
}
