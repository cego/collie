// The Control Plane tab: one per workspace, the Session's control surface. It owns
// no engine state — it reads the run dirs and the live-agent register and draws
// what it finds, so deleting the tab loses nothing and the next Run recreates it.

import { Clock, Effect, FileSystem, Option, Path } from "effect";
import { behindRemote } from "./doctor";
import { driverAlive, lastProgress, readChoice, type PendingChoice } from "./driver";
import { COLLIE_TAB, displayName, GLYPH, runLabel, stepNow } from "./naming";
import { liveEntries, readRegistry, registryPath, type AgentEntry } from "./registry";
import { REVIEW_FILE } from "./output";
import { RunStore, type Run, type RunRecord, type VariantRecord } from "./run";
import { stepDuration, took } from "./time";
import { LEADING_GLYPH, type AgentInfo, type WorkspaceInfo } from "./herdr";

/** How many finished runs stay on the screen; the tab must not need scrolling. */
const RECENT = 5;
/** Keys 1–9 focus an agent, so that is how many the board can offer. */
export const MAX_AGENTS = 9;
/**
 * How long a `running` run with no live agent has to have been quiet before it is
 * called abandoned. A live run always has an agent, except in the seconds between
 * being created and starting its first one.
 */
const STALE_MS = 60_000;
/**
 * The fallback for the board's quiet threshold, for a caller with no defaults to hand —
 * a test drawing one board. `board_quiet_ms` is what a human sets.
 */
const DEFAULT_QUIET_MS = 5 * 60_000;

/** What identifies a Session: one herdr session and one workspace. */
export interface SessionKey {
  /** The herdr session, as its socket path — 0.8.2 exposes no session id. */
  session: string | null;
  workspaceId: string | null;
  /** The live workspace's label, which is how a recycled workspace id is caught. */
  workspaceLabel: string | null;
  /**
   * The directory the board runs in: what it shows as its root and where `p` roots a
   * run. Not part of the identity — a Run's own checkout is a worktree elsewhere, and
   * it still belongs to the workspace it was started from.
   */
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
  /**
   * What the agent says it is doing, from the terminal title its harness publishes, or
   * `null` where it publishes none. The board asks nothing extra for it: it comes back
   * on the same `agent list` the statuses do.
   */
  now: string | null;
}

export interface RunRow {
  id: string;
  /** The run dir, so an answer or a log can be written back to it. */
  dir: string;
  glyph: string;
  title: string;
  detail: string;
  /**
   * When this run last changed, in epoch milliseconds, or 0 when nothing says. A run
   * list answers "how long has this been like this", so the app shows it as a relative
   * time; `now` below is what it is relative to.
   */
  at: number;
  /** What this run reviewed, so its merge request can be looked up on selection. */
  target: string | null;
  /**
   * Whether this run can supply the work for another: `implement` takes a run directory
   * as a work source only when there is a review in it, so "fix what is still open" is
   * offered for those and for nothing else.
   */
  fixable: boolean;
  /** The question this run is waiting on, rendered under its row. */
  choice: PendingChoice | null;
  /**
   * Whether this run has a question for the human, i.e. whether `choice` is set. The
   * board lists these first, because a blocked run costs the whole run's wall-clock and
   * used to be visible only if its row happened to be the Selection. Nothing else counts
   * as needing you: a gate the run recorded itself as awaiting has nothing to answer.
   */
  needsYou: boolean;
}

export interface WorkspaceView {
  repo: string;
  cwd: string;
  /** What pruning did and what it is holding, one line each. */
  worktrees: string[];
  /**
   * How many commits this installation is behind its remote, or null when there is
   * nothing to say. Shown on the board and never notified: being a few commits
   * behind is worth seeing, not worth interrupting for.
   */
  behind: number | null;
  /** When this view was built, so a row's `at` can be read as a relative time. */
  now: number;
  agents: AgentRow[];
  /** Live agents the board had no key left for. */
  extraAgents: number;
  active: RunRow[];
  recent: RunRow[];
}

/**
 * A workspace of this herdr session with something of Collie's in it, or the one
 * trailing group for everything the session cannot reach.
 */
export interface WideGroup {
  /**
   * Which workspace this is, for the jump, and null for Elsewhere. Never drawn: `w28`
   * is how herdr addresses a workspace, not what a human calls one.
   */
  workspaceId: string | null;
  /** What the human calls it: herdr's own label, or the checkout's own name. */
  label: string;
  /** The worst of its runs: ⚠ over ⚙ over whatever the newest finished one was. */
  glyph: string;
  running: number;
  needsYou: number;
  /** `2 running · 1 need you · fix 3/5`: counts, and the leading run's step. */
  summary: string;
  /** What is in this workspace: its running runs, at most two finished, and its agents. */
  active: RunRow[];
  recent: RunRow[];
  agents: AgentRow[];
}

export interface WideView {
  groups: WideGroup[];
  /**
   * The session's other workspaces, by name: the ones with no run, no agent and no
   * history of Collie's. A herdr session is mostly those, and a group row for each was
   * most of what a wide board showed — named rather than dropped, because a board that
   * hides a workspace is one you cannot trust to be the whole session.
   */
  quiet: string[];
  now: number;
}

/** How many finished runs a group keeps: enough to say why a workspace is quiet. */
const RECENT_PER_GROUP = 2;

/**
 * Which of a group's runs speaks for it: one with a question, else the newest active,
 * else the newest finished. A group row with an empty detail says nothing about why a
 * workspace is quiet.
 */
function leader(runs: Pick<WideGroup, "active" | "recent">): RunRow | null {
  return runs.active.find((r) => r.needsYou) ?? runs.active[0] ?? runs.recent[0] ?? null;
}

/** Whether Collie has anything at all in a workspace: a run, an agent, or a history. */
function collies(group: WideGroup): boolean {
  return group.active.length > 0 || group.agents.length > 0 || group.recent.length > 0;
}

/**
 * What the group's leading run is doing: the step it is on and the round of the loop
 * where that step has looped, and what it settled on once nothing is running. Off the
 * record, not out of the run row's detail — a detail carries the elapsed time and the
 * last progress line too, and taking the first two of those words dropped exactly the
 * iteration this is for. The rest of the detail belongs on the run's own row, which
 * sits directly under this one.
 */
function summarise(record: RunRecord): string {
  const step = stepNow(record);
  if (!step) return record.awaiting ?? record.status;
  return [step.id, step.round].filter((part) => part !== null).join(" · ");
}

function groupGlyph(runs: Pick<WideGroup, "active" | "recent">): string {
  if (runs.active.some((r) => r.needsYou)) return GLYPH.waiting;
  if (runs.active.length > 0) return GLYPH.running;
  // Nothing running: the newest finished run's own glyph, so a workspace whose last
  // run failed or stopped does not wear a tick.
  return runs.recent[0]?.glyph ?? " ";
}

/** The last component of a path, which is the name a human uses for a checkout. */
function checkoutName(cwd: string): string {
  return (
    cwd
      .split("/")
      .filter((part) => part !== "")
      .at(-1) ?? "somewhere else"
  );
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
 * agents is alive in this workspace, which is the only proof available for it — and
 * that proof is a Session's own, so a group of the wide scope takes only the runs that
 * name its workspace: an agent herdr reports no workspace for is not proof of any one
 * of them. The run's directory says nothing either way: a mutating Run's checkout is a
 * worktree of its own, and comparing it with the board's directory hid every such run
 * from its tab.
 */
function belongs(
  record: RunRecord,
  key: SessionKey,
  hereNames: Set<string>,
  grouped: boolean,
): boolean {
  if (record.session && key.session && record.session !== key.session) return false;
  if (record.workspace === null) return !grouped && agentsHere(record, hereNames).length > 0;
  // The id and the label, because ids are reused.
  return record.workspace === key.workspaceId && sameWorkspace(record, key);
}

/**
 * Whether the workspace this run was recorded against is still the one wearing that id.
 * Workspace ids compact, so a label recorded and since changed means a different
 * workspace is wearing the same id — and yesterday's runs would otherwise be nested
 * under today's workspace. Unanswerable either way is not a reason to hide a run.
 */
function sameWorkspace(record: RunRecord, key: SessionKey): boolean {
  return (
    !record.workspace_label || !key.workspaceLabel || record.workspace_label === key.workspaceLabel
  );
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

const activeDetail = Effect.fn("activeDetail")(function* (
  run: Run,
  now: number,
  quietMs: number,
  /** The question this run has for the human, which is the only thing they can answer. */
  choice: PendingChoice | null,
) {
  const record = run.record;
  // Before the reads below, and before the quiet scan: a run waiting on the human is
  // meant to be quiet, so saying so would be noise on the one row that needs none.
  // `your turn` only where there is something to answer: `awaiting` is also set for a
  // gate the run is holding at and for an agent answering in its own pane, and neither
  // of those is a question this board can put under the row.
  if (record.awaiting) return choice ? `${record.awaiting} — your turn` : record.awaiting;
  const step = record.steps.find((s) => s.status === "running" || s.status === "blocked");
  const where = step ? step.id : "starting";
  const parts = [where];
  // How long this step has been going: a stuck agent and a slow one look identical
  // without it, and the step id alone said nothing about either.
  const elapsed = step ? stepDuration(step, now) : null;
  if (elapsed) parts.push(elapsed);
  if (record.max_iterations > 1) {
    parts.push(`iteration ${record.iteration}/${record.max_iterations}`);
  }
  // What the driver last said, which is what the runner pane used to show.
  const said = yield* lastProgress(run.dir);
  if (said) parts.push(said);
  const quiet = yield* quietFor(run.dir, now, quietMs);
  if (quiet) parts.push(quiet);
  return parts.join(" · ");
});

/**
 * When a file last changed, or `0` when nothing says — a file that is not there, or a
 * filesystem that does not keep the time. One answer, because two spellings of it is
 * how a row's clock and the quiet check would come to disagree.
 */
const mtimeOf = Effect.fn("mtimeOf")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.stat(file).pipe(
    Effect.map((s) => (Option.isSome(s.mtime) ? s.mtime.value.getTime() : 0)),
    Effect.catch(() => Effect.succeed(0)),
  );
});

/**
 * When anything in the run's own directory last changed. A shallow scan: the files a
 * running run writes as it goes — `run.json`, `runner.log`, `progress.jsonl` — are all
 * at the top of it, and walking the steps and their Outputs would be a directory tree
 * per run per tick for the same answer.
 *
 * ponytail: shallow, deepen it only if a run turns up that writes only into `steps/`.
 */
const touchedDirAt = Effect.fn("touchedDirAt")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fs.readDirectory(dir).pipe(Effect.catch(() => Effect.succeed([])));
  let newest = 0;
  for (const name of names) {
    const at = yield* mtimeOf(path.join(dir, name));
    if (at > newest) newest = at;
  }
  return newest;
});

/**
 * "quiet for 9m", for a run whose directory has not changed for longer than the
 * threshold. A run that is working writes — progress lines, its own record — so silence
 * for minutes is the one signal available from outside that an agent has hung.
 */
const quietFor = Effect.fn("quietFor")(function* (dir: string, now: number, quietMs: number) {
  const at = yield* touchedDirAt(dir);
  if (at === 0 || now - at <= quietMs) return null;
  return `quiet for ${took(now - at)}`;
});

function recentDetail(record: RunRecord, abandoned: boolean): string {
  const parts: string[] = [abandoned ? "abandoned" : record.status];
  if (record.outstanding.length > 0) {
    // Open findings that were handed to another Run's agent are being worked on
    // somewhere this record cannot see; say so instead of presenting them as untouched.
    const handedOff = record.handoffs.some((h) => h.direction === "sent");
    parts.push(`${record.outstanding.length} finding(s) open${handedOff ? " · handed off" : ""}`);
  }
  // Why it stopped, which used to be in the runner pane and is now only in the log.
  const note = record.steps.filter((s) => s.note && s.status !== "done").at(-1)?.note;
  if (note && record.status !== "done") parts.push(note);
  // A round that had to be rescued is not the same as one that went cleanly.
  const repairs = record.steps.flatMap((s) => s.variants).flatMap((v) => v.repairs).length;
  if (repairs > 0) parts.push(`${repairs} Output(s) rewritten`);
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

/**
 * Whether a run is something the next one can be built from: a review it wrote, and a
 * finding still open in it. The review is what `implement` reads as its work source; the
 * findings are what make the offer honest — a review that came back clean has a
 * `review.md` and nothing to fix, and used to be offered "fix what is open" anyway.
 * The synthesis writes both at once, so a run that has one has the other.
 */
export const fixableRun = Effect.fn("fixableRun")(function* (run: Run) {
  if (run.record.outstanding.length === 0) return false;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fs.exists(path.join(run.dir, REVIEW_FILE));
});

/** When a run last changed: a run making progress rewrites run.json as it goes. */
const touchedAt = Effect.fn("touchedAt")(function* (run: Run) {
  const path = yield* Path.Path;
  return yield* mtimeOf(path.join(run.dir, "run.json"));
});

/**
 * A run whose driver is gone: still marked `running`, nothing driving it, no agent
 * of its own left alive, and quiet for long enough that it cannot be one that has
 * just started. Nothing marks such a run — the process that would have is the one
 * that died — so the board says so instead of showing it as work in progress.
 */
const abandonedRun = Effect.fn("abandonedRun")(function* (
  run: Run,
  hereNames: Set<string>,
  now: number,
) {
  if (run.record.status !== "running") return false;
  if (yield* driverAlive(run.dir)) return false;
  if (agentsHere(run.record, hereNames).length > 0) return false;
  return now - (yield* touchedAt(run)) > STALE_MS;
});

/**
 * Everything the tab shows, from the run dirs and one `agent list`: the runs of
 * this Session and every agent of theirs herdr still knows about. `alive` is what
 * herdr answered, so this stays a pure function of state and is testable without
 * a herdr.
 */
export const buildView = Effect.fn("buildView")(function* (
  opts: SessionKey & {
    stateDir: string;
    alive: AgentInfo[];
    now?: number;
    /** What the last prune said; the board reports it rather than deciding it. */
    worktrees?: string[];
    /** The installation, when the caller has one to compare against its remote. */
    pluginRoot?: string;
    /** The Runs already read, so a caller drawing two Views scans the dir once. */
    runs?: ReadonlyArray<Run>;
    /** How long a running run may write nothing before its row says so. */
    quietMs?: number;
    /**
     * Whether this view is one workspace of a wide board rather than the Session's
     * own: a group takes only the runs that name its workspace, and its agents are
     * given no digits, because a wide board numbers those down the whole tree.
     */
    grouped?: boolean;
  },
) {
  const path = yield* Path.Path;
  const now = opts.now ?? (yield* Clock.currentTimeMillis);
  const quietMs = opts.quietMs ?? DEFAULT_QUIET_MS;
  // Only agents in this workspace count, whatever a run record claims.
  const here = opts.alive.filter(
    (a) => a.workspaceId === null || a.workspaceId === opts.workspaceId,
  );
  const hereNames = new Set(here.map((a) => a.name));
  const live = new Map(here.map((a) => [a.name, a]));

  const all = opts.runs ?? (yield* new RunStore(opts.stateDir).list());
  const runs = all.filter((r) => belongs(r.record, opts, hereNames, opts.grouped ?? false));
  const regPath = yield* registryPath(opts.stateDir, opts);
  const registered = new Map(
    liveEntries(yield* readRegistry(regPath), here).map((e) => [e.agent, e]),
  );

  const rows: AgentRow[] = [];
  for (const run of runs) {
    for (const variant of agentsHere(run.record, hereNames)) {
      if (rows.some((r) => r.agent === variant.agent)) continue;
      const alive = live.get(variant.agent);
      rows.push({
        key: "",
        name: agentTitle(variant, registered.get(variant.agent)),
        agent: variant.agent,
        status: alive?.status ?? "unknown",
        run: run.id,
        now: alive?.title ?? null,
      });
    }
  }
  // The ones a hand-off can name come first; that is mostly what the keys are for.
  rows.sort((a, b) => Number(registered.has(b.agent)) - Number(registered.has(a.agent)));
  // A group of the wide scope keeps every agent it has and gives none of them a digit:
  // the digits there are numbered down the whole tree, and a group that had numbered
  // its own nine would have hidden its tenth row rather than just its tenth digit — on
  // a board whose whole claim is that it hides nothing.
  const agents = opts.grouped
    ? rows
    : rows.slice(0, MAX_AGENTS).map((r, i) => ({ ...r, key: String(i + 1) }));

  const fixable = new Set<string>();
  for (const r of runs) if (yield* fixableRun(r)) fixable.add(r.id);

  const abandoned = new Set<string>();
  for (const r of runs) if (yield* abandonedRun(r, hereNames, now)) abandoned.add(r.id);
  const stopped = runs.filter((r) => r.record.status !== "running" || abandoned.has(r.id));

  const active: RunRow[] = [];
  for (const r of runs.filter((r) => r.record.status === "running" && !abandoned.has(r.id))) {
    const choice = yield* readChoice(r.dir);
    active.push({
      id: r.id,
      dir: r.dir,
      glyph: glyphFor(r.record, false),
      title: runLabel(r.record),
      detail: yield* activeDetail(r, now, quietMs, choice),
      at: yield* touchedAt(r),
      target: r.record.inputs.target ?? null,
      // The same set the finished rows read: this used to stat every active run's dir a
      // second time, on the 3s poll and on every watch event and command.
      fixable: fixable.has(r.id),
      choice,
      // A pending Choice and nothing else: a count that sends a human to a row with
      // nothing under it to answer is worse than no count.
      needsYou: choice !== null,
    });
  }

  return {
    repo: path.basename(opts.cwd),
    cwd: opts.cwd,
    worktrees: opts.worktrees ?? [],
    behind: opts.pluginRoot ? yield* behindRemote(opts.pluginRoot, undefined, now) : null,
    now,
    agents,
    extraAgents: rows.length - agents.length,
    active,
    recent: stopped.slice(0, RECENT).map((r) => ({
      id: r.id,
      dir: r.dir,
      glyph: glyphFor(r.record, abandoned.has(r.id)),
      title: runLabel(r.record),
      detail: recentDetail(r.record, abandoned.has(r.id)),
      // The record's own word for when it ended; a run that never recorded one has
      // only its file's mtime to go on.
      at: r.record.finished_at ? Date.parse(r.record.finished_at) : 0,
      target: r.record.inputs.target ?? null,
      fixable: fixable.has(r.id),
      choice: null,
      // A finished run is waiting on nobody, whatever it was awaiting when it stopped.
      needsYou: false,
    })),
  };
});

/**
 * One workspace as a group: what is in it, and what its group row says about it. The
 * runs are the ones recorded against that workspace id — grouping is by id alone,
 * because a workspace with no worktree reports no cwd and would otherwise lose every
 * run recorded against it.
 */
const groupOf = Effect.fn("groupOf")(function* (
  opts: SessionKey & {
    stateDir: string;
    label: string;
    alive: AgentInfo[];
    runs: ReadonlyArray<Run>;
    now: number;
    quietMs?: number;
  },
) {
  const view = yield* buildView({ ...opts, grouped: true });
  // Two finished runs, not five: five per workspace is what makes a board of the
  // whole session unreadable. Nothing else of the local board travels with a group —
  // the repo, the worktrees and how far behind the installation is are the Session's,
  // not one workspace's.
  const kept = { active: view.active, recent: view.recent.slice(0, RECENT_PER_GROUP) };
  const needsYou = kept.active.filter((r) => r.needsYou).length;
  // The run that speaks for the group, as its record: its step and its round are what
  // the group row says, and a row carries neither.
  const lead = leader(kept);
  const leading = lead ? (opts.runs.find((r) => r.id === lead.id)?.record ?? null) : null;
  return {
    workspaceId: opts.workspaceId,
    label: opts.label,
    glyph: groupGlyph(kept),
    running: kept.active.length,
    needsYou,
    summary: [
      kept.active.length > 0 ? `${kept.active.length} running` : "nothing running",
      needsYou > 0 ? `${needsYou} need you` : "",
      leading ? summarise(leading) : "",
    ]
      .filter((part) => part !== "")
      .join(" · "),
    ...kept,
    agents: view.agents,
  } satisfies WideGroup;
});

/**
 * The whole herdr session as groups: the workspaces it reports, in its own order, then
 * one `Elsewhere` for the active runs recorded against a workspace the session no longer
 * has. Everything comes off one `workspace list`, one `agent list` and one scan of the
 * run dirs — a wide scope is a scope, not a second data source — and the groups
 * partition that scan rather than each rescanning it.
 */
export const buildWideView = Effect.fn("buildWideView")(function* (opts: {
  session: string | null;
  stateDir: string;
  workspaces: ReadonlyArray<WorkspaceInfo>;
  alive: AgentInfo[];
  runs?: ReadonlyArray<Run>;
  now?: number;
  quietMs?: number;
}) {
  const now = opts.now ?? (yield* Clock.currentTimeMillis);
  const runs = opts.runs ?? (yield* new RunStore(opts.stateDir).list());
  const shared = {
    session: opts.session,
    stateDir: opts.stateDir,
    alive: opts.alive,
    runs,
    now,
    quietMs: opts.quietMs,
  };

  const all: WideGroup[] = [];
  for (const workspace of opts.workspaces) {
    all.push(
      yield* groupOf({
        ...shared,
        workspaceId: workspace.workspaceId,
        workspaceLabel: workspace.label,
        // herdr's own answer, and nothing is derived from it: a group is a workspace,
        // and the directory a workspace is sitting in decides nothing about which runs
        // are in it.
        cwd: workspace.cwd,
        // herdr's own label, minus the status glyph it starts with — the gutter carries
        // one already. Never an id: this is the workspace's name. The boundary's own
        // regex, which is what keeps a workspace called `.dotfiles` called that.
        label: workspace.label.replace(LEADING_GLYPH, ""),
      }),
    );
  }

  // Collie's workspaces are the board; the rest of the session is one line at the end.
  const groups = all.filter(collies);
  const quiet = all.filter((group) => !collies(group)).map((group) => group.label);

  // Elsewhere: every workspace id an active run names that this session has no
  // workspace for — one that was closed, or another herdr session's. Nothing is hidden;
  // a run still going somewhere this board cannot show is still news.
  const mine = new Set(opts.workspaces.map((w) => w.workspaceId));
  const foreign = new Set(
    runs
      .filter((r) => r.record.status === "running" && r.record.workspace !== null)
      .map((r) => r.record.workspace!)
      .filter((id) => !mine.has(id)),
  );
  const away: WideGroup[] = [];
  for (const workspaceId of foreign) {
    const cwd = runs.find((r) => r.record.workspace === workspaceId)?.record.cwd ?? "";
    away.push(
      yield* groupOf({
        ...shared,
        // No session and no label to hold a run to: the workspace has gone, and a run
        // recorded against an id this session does not have may be another herdr
        // session's — which is what Elsewhere is for.
        session: null,
        workspaceId,
        workspaceLabel: null,
        cwd,
        // The workspace has gone and its label with it; what is left to call it by is
        // the checkout the run was working in.
        label: checkoutName(cwd),
      }),
    );
  }
  // Only the ones that actually contributed a row: a foreign id whose runs all turned
  // out to be abandoned is not something to name in a heading.
  const named = away.filter((group) => group.active.length > 0);
  if (named.length > 0) {
    groups.push({
      workspaceId: null,
      label: `Elsewhere · ${named.map((g) => g.label).join(" · ")}`,
      glyph: named.some((g) => g.needsYou > 0) ? GLYPH.waiting : GLYPH.running,
      running: named.reduce((n, g) => n + g.running, 0),
      needsYou: named.reduce((n, g) => n + g.needsYou, 0),
      summary: "a workspace this session no longer has — nothing to jump to",
      active: named.flatMap((g) => g.active),
      // Nothing finished, and no agents: their panes are in a workspace this session
      // cannot reach, so there is nothing here to focus or to give a digit to.
      recent: [],
      agents: [],
    });
  }
  return { groups, quiet, now } satisfies WideView;
});

const indent = (line: string) => `  ${line}`;

/**
 * "3 commits behind", in the one place that decides the plural: the app's nav says
 * it and the text board says it, with room for different amounts of sentence around
 * it — the nav row is a fixed width and the board's line has itself to spread into.
 */
export function commitsBehind(behind: number): string {
  return `${behind} commit${behind === 1 ? "" : "s"} behind`;
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
  const lines = [`${COLLIE_TAB} — ${view.repo}`, view.cwd];
  if (view.behind !== null && view.behind > 0) {
    lines.push(`Collie is ${commitsBehind(view.behind)} its remote — \`collie upgrade\``);
  }

  const agents = view.agents.map(
    (a) => `  ${a.key}  ${a.name.padEnd(22)}${a.status.padEnd(9)}${a.now ?? a.run}`,
  );
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
    // Only where there are any: a repository Collie has no checkout of has nothing to
    // say here, and an empty section would be noise on every refresh.
    ...(view.worktrees.length > 0 ? section("Worktrees", view.worktrees.map(indent), "") : []),
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
