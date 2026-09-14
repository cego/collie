// What the Collie tab renders and what it can be asked to do, as plain data. Effect
// produces the board; this projects it into rows and actions; components read those and
// dispatch the commands back.
//
// Nothing here imports `effect` and nothing here holds a runtime, which is what keeps the
// components testable with plain fixtures and no services — `test/ui/boundary.test.ts`
// is that rule, made executable. The bar is a direct import and a live runtime, not the
// transitive graph: the value imports below reach `effect` through their own imports, and
// what matters is that nothing in this file or the components can run an Effect.

import type { PendingChoice } from "../driver";
import type { PickItem } from "../inputs";
import { GLYPH } from "../naming";
import { markFor, marksOf, NO_MARKS, worstOf, type Marks } from "../lines";
import { agoShort } from "../time";
import type { Mode } from "../flows";
import type { DefinitionRow, RunDetail, SettingsView } from "../views";
import { MAX_AGENTS, type AgentRow, type RunRow } from "../workspace";
import type { WideGroup, WideView, WorkspaceView } from "../workspace";
import type { Scope } from "../config";
import type { Live } from "../live";

/** What the nav switches between. One at a time, each a projection of state. */
export type ViewName = "runs" | "history" | "workflows" | "settings";
export const VIEWS: ReadonlyArray<{ name: ViewName; title: string }> = [
  { name: "runs", title: "Runs" },
  { name: "history", title: "History" },
  { name: "workflows", title: "Workflows" },
  { name: "settings", title: "Settings" },
];

/**
 * What the Runs view is a board of. One Herd has one board (ADR-0009), so "this
 * workspace" is a filter over it rather than a board of its own — and a run filter is
 * how a `navigate` action puts one piece of work on screen without focusing a pane.
 */
export type Filter =
  | { kind: "all" }
  | { kind: "workspace"; id: string }
  | { kind: "run"; id: string };

/**
 * Whether this board is one Session's. Starting a run and handing off a review act on
 * one workspace's checkout and on this Session's register, so they mean something only
 * where the board has been narrowed — to a workspace, or to a Run inside one. Asked of
 * the filter itself rather than of a `local`/`all` copy of it: the persisted default is
 * the one place that vocabulary belongs, and every key set that used to be handed a
 * `Scope` was answering this one question about the filter.
 */
export function sessionLocal(filter: Filter): boolean {
  return filter.kind !== "all";
}

/**
 * Which filter a board opens on. `local` means the workspace it was opened from, which
 * is a thing only where that workspace is known: the Home is opened from anywhere, and
 * a Home whose shortcut recorded no origin has nothing to narrow to.
 */
export function openingFilter(scope: Scope, origin: string | null): Filter {
  return scope === "local" && origin !== null ? { kind: "workspace", id: origin } : { kind: "all" };
}

/**
 * What is being looked at, which is what decides how much has to be read. Plain data,
 * and held by the bridge as one source: which View is showing and what is selected
 * decide what the producers read, so they are state rather than render-local signals.
 */
export interface Focus {
  view: ViewName;
  /** Which of the Herd's work the Runs view is showing. */
  filter: Filter;
  /**
   * The workspace the board was opened from, which is what `g` narrows to. Null for a
   * board nobody opened from anywhere — there is then nothing to narrow to, and `g`
   * says so by doing nothing rather than by inventing a workspace.
   */
  origin: string | null;
  /**
   * What is half-typed in the Steer box. State rather than a render-local signal for
   * the same reason the Selection is: it decides what the Steer box draws, and it has
   * to survive the redraw every board tick causes.
   */
  steerDraft: string | null;
  /**
   * Whether what is being typed is aimed at the selected Run. False is the ordinary
   * case and means the flock: a question, read-only, about every Run. Aiming is explicit
   * because a mutation has to name its target, and the row a human is sitting on is not
   * consent to act on it.
   */
  steerAimed: boolean;
  /** The proposal whose actions are on screen for a yes or no, or null. */
  previewing: string | null;
  /**
   * Every View shown at least once. Those are kept fresh; one never opened is never
   * read at all, which is what keeps opening the tab cheap however much is on disk.
   */
  shown: ReadonlyArray<ViewName>;
  /** The Selection's row id, so its detail — and only its detail — is produced. */
  selected: string | null;
  /** Whether the panel's log tail is showing, which is what makes the log worth reading. */
  tail: boolean;
  /**
   * How many caps of the selected Run's review to read. A review is capped so that one
   * an agent wrote at 4 MB cannot stall a redraw, and this is how the rest of it is read
   * without leaving the tab: `m` asks for another page. Reset by a new Selection.
   */
  reviewPages: number;
  /**
   * Bumped whenever the state has to be read past a cache: a Refresh, and the read after
   * a command changed something. A number rather than a flag because the same focus
   * asked for twice must look new — `changes` drops a repeat, and a repeated Refresh is
   * exactly what a human presses when they want to know now.
   */
  nonce: number;
}

/**
 * Everything the app draws. Each View's data is `null` until that View is first shown —
 * the laziness is here, in the state, because reading every run's Outputs at startup is
 * what would make the tab slow the day it became useful.
 */
export interface AppState {
  view: ViewName;
  filter: Filter;
  board: WorkspaceView;
  /**
   * Every workspace of this herdr session Collie has work in, or null while the scope
   * is local — the wide board is read only while it is the one showing.
   */
  wide: WideView | null;
  note: string | null;
  /** Every finished Run of this checkout, whatever session it came from. */
  history: RunRow[] | null;
  definitions: { workflows: DefinitionRow[]; errors: string[] } | null;
  settings: SettingsView | null;
  /** The selected Run, read from its directory. Null for any other Selection. */
  detail: RunDetail | null;
  /**
   * What steering has found about each Run on the board. Herd-wide, because a mark is
   * what makes a row worth selecting — a human must not have to select a Run to find
   * out that it has drifted.
   */
  marks: Marks;
  /**
   * What the Live region draws, or null until the Runs view has been shown. Produced for
   * the Selection's Run, and the Herd's newest cards while nothing is selected.
   */
  live: Live | null;
  steerDraft: string | null;
  steerAimed: boolean;
  previewing: string | null;
}

export type RowKind =
  | "agent"
  | "active"
  | "recent"
  | "history"
  | "definition"
  | "setting"
  /** A workspace, in the wide scope: selectable, and the runs under it are its own. */
  | "group"
  /** A name for the group under it, and nothing to act on. */
  | "header";

/**
 * One selectable line. `id` is stable across refreshes — an agent by name, a run by
 * its id — because the list re-sorts under the cursor and an index would silently
 * retarget whatever the human pressed next.
 */
export interface Row {
  id: string;
  kind: RowKind;
  /** How long it has been like this — `2m ago` — or empty where nothing says. */
  ago: string;
  /** The digit that focuses this agent, where the board had one left to give. */
  key: string | null;
  glyph: string;
  /** What steering has found about this row's Run, as glyphs. Empty for most rows. */
  marks: string;
  title: string;
  detail: string;
  runId: string | null;
  agent: string | null;
  /** What this Run reviewed, so "review again" and the MR panel have their ref. */
  target: string | null;
  /** Whether this Run can supply the work for a fix round. */
  fixable: boolean;
  /** Whether this Run has stopped and is waiting on the human. */
  needsYou: boolean;
  /** The Workflow or Persona this row names, for the Workflows view. */
  definition: DefinitionRow | null;
  /** The config key this row names, for the Settings view. */
  setting: { key: string; value: string; writable: boolean } | null;
  choice: PendingChoice | null;
  /** Where Enter on this row goes, or null for a row that is only a row. */
  jump: Jump | null;
  /**
   * How deep this row sits in the wide tree: 0 a workspace, 1 its runs, 2 a run's
   * agents. The indent belongs in the gutter beside the glyph and never in the title —
   * padding the title left the glyphs in one column and the text in three, which is
   * what made the tree unreadable.
   */
  depth: number;
}

/**
 * Where a row points, as little of it as re-resolving the jump at Enter time needs: a
 * workspace id, a run id, an agent name. Never a tab or pane id — herdr compacts those,
 * so one cached when the row was drawn jumps into whatever has taken its place. `none`
 * is a row whose panes this session cannot reach, which still has to answer Enter.
 */
export type Jump = { label: string } & (
  | { kind: "workspace"; workspaceId: string }
  | { kind: "run"; runId: string }
  | { kind: "agent"; agent: string }
  | { kind: "none" }
);

/**
 * Everything a component may ask for, as plain data. The four at the bottom change what
 * is shown rather than what is true, so the bridge answers those itself; every other one
 * is a function in `src/operations.ts` that the CLI reaches too.
 */
export type Command =
  | { _tag: "FocusAgent"; agent: string }
  | { _tag: "StopRun"; runId: string }
  | { _tag: "OpenLog"; runId: string }
  /**
   * Answer the Choice the board drew, named by its id. The id is what makes it that
   * Choice: a question replaced between the refresh that drew it and the key that
   * answered it is a different question, and the answer belongs to the one on screen.
   */
  | { _tag: "Answer"; runId: string; choiceId: string; value: string }
  /**
   * Hand the named Run's review to the live implementer. It names one, because every
   * other action on the board acts on the Selection: an argument-less "send the review"
   * meant the newest one in the Session, which with an older review selected handed off
   * a different run's findings and said nothing about the mismatch. `null` is a
   * Selection with no Run behind it, which sends nothing and says so — the text view
   * asks the operation directly rather than through a command.
   */
  | { _tag: "SendReview"; runId: string | null }
  | { _tag: "FixFindings"; runId: string }
  | { _tag: "ReviewAgain"; target: string }
  | { _tag: "PostReview"; runId: string }
  /**
   * The merge request in a browser. It names the run as well as the target, because
   * `glab` resolves an unqualified `mr:42` from the directory it runs in, and on a
   * board of every workspace that directory is not the run's.
   */
  | { _tag: "OpenMr"; target: string; runId: string | null }
  | { _tag: "RunWorkflow"; workflow: string }
  /**
   * Say something to Collie. `runId` null is a question about the flock: read-only, and
   * answered about every Run whatever the board has selected or filtered to.
   *
   * A targeted message names its Run rather than taking it from the Selection. Two
   * reasons, and both have bitten: a board whose filter moved between reading a row and
   * typing about it would steer another one, and the row a human happens to be sitting
   * on is not consent to act on it.
   */
  | { _tag: "Steer"; text: string; runId: string | null; from?: string }
  /**
   * Carry out a proposal. The hash travels with the id because that is what makes this
   * consent to a payload rather than to a summary — the board passes back exactly what
   * it drew.
   */
  | { _tag: "ConfirmProposal"; id: string; hash: string }
  | { _tag: "DeclineProposal"; id: string }
  /**
   * Ask for a value, rather than write one. The app answers this itself by opening its
   * editor: an empty `SetDefault` used to stand in for "ask me first", which the
   * keyboard honoured and a click on the same button took literally — unsetting the
   * default it was labelled to set.
   */
  | { _tag: "EditSetting"; key: string }
  /**
   * Go to the next unanswered question. The app answers this itself, like
   * `EditSetting`: it moves the Selection and clears a filter hiding the row, neither
   * of which is anything the bridge owns.
   */
  | { _tag: "NextQuestion" }
  | { _tag: "SetDefault"; key: string; value: string }
  | { _tag: "OpenMode"; mode: Mode }
  | { _tag: "ShowView"; view: ViewName }
  /** Show or hide the selected Run's log tail inside the panel. */
  | { _tag: "ToggleTail" }
  /** Read another cap of the selected Run's review, for one that was cut short. */
  | { _tag: "MoreReview" }
  | { _tag: "Select"; id: string | null }
  /** Go to what a row points at, resolved from its key at the moment Enter is pressed. */
  | { _tag: "Jump"; jump: Jump }
  /** The whole Herd ⇄ the workspace this board was opened from. */
  | { _tag: "ToggleFilter" }
  /** Which of the Herd's work the board shows: a group row narrows, Esc widens. */
  | { _tag: "SetFilter"; filter: Filter }
  | { _tag: "DraftSteer"; text: string | null; aimed?: boolean }
  /** Put one proposal's actions on screen for a yes or no, or take them off. */
  | { _tag: "Preview"; id: string | null }
  | { _tag: "Refresh" }
  | { _tag: "Quit" };

/**
 * The commands the bridge answers itself; they never reach an operation. One list, read
 * both as a guard and as the type below, because a command added to one of those and not
 * the other is a command that quietly goes down the wrong lane.
 */
const FOCUS_ONLY = [
  "ShowView",
  "ToggleTail",
  "MoreReview",
  "Select",
  "ToggleFilter",
  "SetFilter",
  "DraftSteer",
  "Preview",
  "Refresh",
  "Quit",
] as const;

export type FocusCommand = Extract<Command, { _tag: (typeof FOCUS_ONLY)[number] }>;

export function changesFocusOnly(command: Command): command is FocusCommand {
  return FOCUS_ONLY.some((tag) => tag === command._tag);
}

/**
 * Where one focus command leaves what is being looked at. Exhaustive over
 * `FocusCommand`, so a new one of those is a type error here rather than a command the
 * bridge takes and does nothing with.
 */
export function retarget(at: Focus, command: FocusCommand): Focus {
  switch (command._tag) {
    case "ShowView":
      return {
        ...at,
        view: command.view,
        shown: at.shown.includes(command.view) ? at.shown : [...at.shown, command.view],
      };
    case "ToggleTail":
      return { ...at, tail: !at.tail };
    // A row of one filter is not a row of the other, so the Selection starts again:
    // `clampSelection` then lands it on the first row of the board that arrives.
    case "ToggleFilter":
      return retarget(at, { _tag: "SetFilter", filter: widened(at) });
    case "SetFilter":
      return { ...at, filter: command.filter, selected: null, previewing: null };
    // Neither is a change in the world: the Steer box is a field, and a preview is what
    // was already read, drawn. `rereads` is where that costs nothing.
    case "DraftSteer":
      // Closing the composer stops it being aimed too: the next thing typed is a
      // question about the flock unless somebody says otherwise again.
      return {
        ...at,
        steerDraft: command.text,
        steerAimed: command.text === null ? false : (command.aimed ?? at.steerAimed),
      };
    case "Preview":
      return { ...at, previewing: command.id };
    case "MoreReview":
      return { ...at, reviewPages: at.reviewPages + 1 };
    // From the first page again: how far the last Selection had been paged says nothing
    // about this one.
    case "Select":
      return { ...at, selected: command.id, reviewPages: 1 };
    case "Refresh":
      return { ...at, nonce: at.nonce + 1 };
    // The bridge answers the close before this; there is no focus after it.
    case "Quit":
      return at;
  }
}

/** What may be reused from the last read, and what has to be read past its cache. */
export interface Rereads {
  /** Whether the board and the Views may be taken from the last state. */
  reuse: boolean;
  /** Whether the Selection's merge request must be read past its TTL. */
  forceMr: boolean;
}

// By contents, not by reference: `retarget` happens to return the same array when the
// View is already shown, and relying on that made a reasonable-looking edit there —
// `shown: [...at.shown]` — turn every cursor move back into a full re-read of the run
// dirs, the definition layers and the config, with no test to catch it.
const sameViews = (a: ReadonlyArray<ViewName>, b: ReadonlyArray<ViewName>) =>
  a.length === b.length && a.every((view, at) => view === b[at]);

/**
 * What a new Focus means for the reads behind it. One decision, in one place: "only the
 * Selection moved, so keep the board" and "something asked for a fresh read, so go past
 * the merge-request cache" are the same comparison of the same two Focus values, and a
 * field added to Focus without a decision here is how a cursor move starts re-reading
 * every run directory again — or worse, reuses a board it should not.
 */
export function rereads(last: Focus | null, next: Focus): Rereads {
  if (last === null) return { reuse: false, forceMr: false };
  // A Refresh, and the read after a command: posting a review is the obvious case, and
  // a panel still showing the merge request as it was before would be lying.
  const asked = last.nonce !== next.nonce;
  // Moving the cursor is not a change in the world, and re-reading every run directory
  // per arrow key is a lag on every keypress — the tick and every command still re-read.
  const movedOnly =
    last.view === next.view &&
    sameFilter(last.filter, next.filter) &&
    sameViews(last.shown, next.shown) &&
    last.tail === next.tail &&
    last.reviewPages === next.reviewPages &&
    // Typing in the Steer box and previewing a proposal are the two focus changes that
    // read nothing at all: the draft is a field, and the proposal is already in `live`.
    // Neither is required to move the Selection, so they reuse whether it moved or not.
    (last.selected !== next.selected ||
      last.steerDraft !== next.steerDraft ||
      last.steerAimed !== next.steerAimed ||
      last.previewing !== next.previewing);
  return { reuse: !asked && movedOnly, forceMr: asked };
}

const sameFilter = (a: Filter, b: Filter) =>
  a.kind === b.kind && ("id" in a ? "id" in b && a.id === b.id : true);

/**
 * Where `g` goes from here: the whole Herd from anything narrower, and the workspace
 * this board was opened from when it is already showing everything. A board with no
 * origin has nothing to narrow to, so it stays where it is rather than narrowing to a
 * workspace nobody named.
 */
function widened(at: Focus): Filter {
  if (at.filter.kind !== "all" || at.origin === null) return { kind: "all" };
  return { kind: "workspace", id: at.origin };
}

/** The fields every row shares, so each builder below only states what it differs in. */
const BLANK = {
  ago: "",
  key: null,
  glyph: " ",
  marks: "",
  detail: "",
  runId: null,
  agent: null,
  target: null,
  fixable: false,
  needsYou: false,
  definition: null,
  setting: null,
  choice: null,
  jump: null,
  depth: 0,
} as const;

/**
 * One agent, under the run it works for. `connector` is what joins it to that run — the
 * last of a run's agents closes the group — and the run named by the row above it is not
 * named again here.
 */
function agentRow(a: AgentRow, connector: string, marks?: Marks): Row {
  return {
    ...BLANK,
    id: `agent:${a.agent}`,
    kind: "agent",
    // Only the override: the rest of a Run's marks are about the Run, and repeating
    // them on every agent under it would say the same thing four times.
    marks: markFor(marks, a.run).override ? marksOf({ ...NO_MARKS, override: true }) : "",
    // An agent's row is its live status, which herdr answers with no time attached.
    key: a.key === "" ? null : a.key,
    title: `${connector} ${a.name}`,
    // What it is doing, where its harness publishes one: "working" alone said nothing a
    // spinner does not. Which run it belongs to is the row above it, so this says what
    // that run's agent is actually on.
    detail: doingLine(a),
    runId: a.run,
    agent: a.agent,
    // By name: `agent.focus` selects the workspace, the tab and the pane in one call.
    jump: { kind: "agent", agent: a.agent, label: a.name },
  };
}

/**
 * What an agent's row says it is doing: its live status, and the task its harness
 * publishes as the pane's terminal title where there is one. Claude Code puts the task
 * it is on there, and it comes back on the same `agent list` the statuses do.
 */
function doingLine(a: AgentRow, ...rest: string[]): string {
  return [a.status, a.now ?? "", ...rest].filter((part) => part !== "").join(" · ");
}

/**
 * One agent in the trailing group. It has no run above it, so its own row is the only
 * place left to say which run it names.
 */
function orphanRow(a: AgentRow, connector: string, marks?: Marks): Row {
  return { ...agentRow(a, connector, marks), detail: doingLine(a, a.run) };
}

/**
 * One group of agents as rows: a run's own, or the orphans. `├` joins each to the group
 * and the last one closes it with `└`, which is the whole of the nesting — the list
 * itself stays flat.
 */
function agentGroup(
  agents: readonly AgentRow[],
  row: (a: AgentRow, connector: string, marks?: Marks) => Row,
  marks?: Marks,
): Row[] {
  return agents.map((a, at) => row(a, at === agents.length - 1 ? "└" : "├", marks));
}

/** The prefix a Run's row id carries, minted here and read back by `runIdOf`. */
const RUN_ROW = "run:";

/**
 * The Run behind a row id, or `null` for a Selection that is not one. The shape of the
 * id is this module's own — it mints them — and the producers ask rather than parse: a
 * second `startsWith("run:")` elsewhere is a format two modules have to agree on.
 */
export function runIdOf(rowId: string | null): string | null {
  return rowId !== null && rowId.startsWith(RUN_ROW) ? rowId.slice(RUN_ROW.length) : null;
}

function runRow(r: RunRow, now: number, kind: "active" | "recent" | "history", marks?: Marks): Row {
  return {
    ...BLANK,
    id: `${RUN_ROW}${r.id}`,
    kind,
    ago: agoShort(r.at, now),
    glyph: r.glyph,
    marks: marksOf(markFor(marks, r.id)),
    title: r.title,
    detail: r.detail,
    runId: r.id,
    target: r.target,
    fixable: r.fixable,
    needsYou: r.needsYou,
    choice: r.choice,
    // A History row is a record rather than a pane — the run it names may have been
    // over for a week — so there is nowhere for Enter to go.
    jump: kind === "history" ? null : { kind: "run", runId: r.id, label: r.title },
  };
}

function definitionRow(d: DefinitionRow): Row {
  return {
    ...BLANK,
    id: `workflow:${d.name}`,
    kind: "definition",
    // A fork that cannot run should be visible here rather than at launch.
    glyph: d.problems.length > 0 ? GLYPH.failed : GLYPH.done,
    title: d.title || d.name,
    detail: [
      `[${d.layer}]`,
      d.provenance,
      d.problems.length > 0 ? `${d.problems.length} problem(s)` : "",
    ]
      .filter((part) => part !== "")
      .join(" · "),
    definition: d,
  };
}

/**
 * `id` is given rather than derived from the key, because two rows can be about the same
 * key: the writable `trust` default and the trust state of this directory. They shared an
 * id, so clicking one selected both and `current()` resolved the first — every key after
 * that acted on the editable default rather than the row that was clicked.
 */
function settingRow(id: string, key: string, value: string, writable: boolean): Row {
  return {
    ...BLANK,
    id: `setting:${id}`,
    kind: "setting",
    title: key,
    detail: value === "" ? "(unset)" : value,
    setting: { key, value, writable },
  };
}

/**
 * The board as one flat, ordered list: each Run followed by the agents working for it,
 * the running ones first and then the ones that have finished, and last any agent whose
 * Run is not on the board at all. Flat because one list region, one Selection and one set
 * of keys is the whole design — the nesting is drawn by the connector each agent row
 * carries, not by a tree the list would have to know about.
 *
 * A finished Run keeps its agents: the implementer a hand-off names outlives the Run it
 * was started for, and filing it under "no run here" while its Run sat two rows above
 * was the board contradicting itself.
 */
export function rowsOf(board: WorkspaceView, marks?: Marks): Row[] {
  const rows: Row[] = [];
  const onBoard = [...board.active, ...board.recent];
  /** The rows this board has, by id: what a child id and an agent's run resolve against. */
  const byId = new Map(onBoard.map((r) => [r.id, r]));
  const agentsOf = (run: RunRow) => board.agents.filter((a) => a.run === run.id);
  const childrenOf = (run: RunRow) => run.children.flatMap((id) => byId.get(id) ?? []);
  /**
   * One run, its children, and each of their agents — a run that fanned out into one
   * run per repository is one thing on the board, not several beside each other.
   */
  const under = (run: RunRow, kind: "active" | "recent", depth = 0): Row[] => [
    nested(runRow(run, board.now, kind, marks), depth),
    // An agent sits at its run's own depth: the connector is what joins it, and the
    // gutter is what says which run is inside which.
    ...agentGroup(agentsOf(run), agentRow, marks).map((a) => nested(a, depth)),
    ...childrenOf(run).flatMap((child) =>
      under(child, board.active.includes(child) ? "active" : "recent", depth + 1),
    ),
  ];
  // A child is drawn under its parent, so it is not also drawn beside it. Filtered once
  // here, because a header counted over one list and drawn over another is how the
  // "Needs you" header came to stand over no rows at all.
  const nestedIds = new Set(onBoard.flatMap((r) => r.children));
  const top = (runs: ReadonlyArray<RunRow>) => runs.filter((run) => !nestedIds.has(run.id));
  const active = top(board.active);
  // The runs that have stopped for the human first, under a header saying so: a
  // blocked run costs the whole run's wall-clock and used to be visible only if its
  // row happened to be the Selection. Each keeps the agents nested under it.
  const waiting = active.filter((r) => r.needsYou);
  if (waiting.length > 0) rows.push(headerRow(NEEDS_YOU));
  for (const run of [...waiting, ...active.filter((r) => !r.needsYou)]) {
    rows.push(...under(run, "active"));
  }
  for (const run of top(board.recent)) {
    rows.push(...under(run, "recent"));
  }
  const orphans = board.agents.filter((a) => !byId.has(a.run));
  if (orphans.length > 0) {
    rows.push(headerRow("agents with no run here"));
    rows.push(...agentGroup(orphans, orphanRow, marks));
  }
  return rows;
}

/**
 * The wide board: one group per workspace Collie has work in, in herdr's order, with
 * that workspace's runs under it and each run's agents under those. A tree, drawn as
 * one flat list the way the local board is — the depth is in the gutter, so title,
 * detail and age start in the same column at every level.
 */
export function wideRows(wide: WideView, marks?: Marks): Row[] {
  const rows: Row[] = [];
  for (const [at, group] of wide.groups.entries()) {
    // A blank line between workspaces. Groups of one-line rows with nothing between
    // them read as one wall of text, whatever the columns do.
    if (at > 0) rows.push(spacer(`gap:${group.workspaceId ?? ELSEWHERE}`));
    // Being unreachable is the group's property, not each row's: a workspace this
    // session has lost has nothing in it that Enter can reach — and its runs keep the
    // target that says which of the checkouts its group row names they are in.
    const away = group.workspaceId === null;
    /**
     * One run, and the agents working for it. A run is named by its workflow alone —
     * the group row above already says which branch this is, and repeating it under it
     * was the same sentence twice, clipped — but its jump keeps the run's whole name,
     * because that is what the footer says it went to. An agent keeps its own name in
     * full: the model is what tells two variants of one step apart.
     */
    const inGroup = [...group.active, ...group.recent];
    const byId = new Map(inGroup.map((r) => [r.id, r]));
    const under = (run: RunRow, kind: "active" | "recent", depth = 1): Row[] => {
      const row = runRow(run, wide.now, kind, marks);
      return [
        nested(away ? row : unqualified(row), depth),
        ...agentGroup(
          group.agents.filter((a) => a.run === run.id),
          agentRow,
          marks,
        ).map((agent) => nested(agent, depth + 1)),
        // A repository run of a plan that fanned out, under the plan run that started it.
        ...run.children
          .flatMap((id) => byId.get(id) ?? [])
          .flatMap((child) =>
            under(child, group.active.includes(child) ? "active" : "recent", depth + 1),
          ),
      ];
    };
    // A child is drawn under its parent, so it is not also drawn beside it.
    const nestedIds = new Set(inGroup.flatMap((r) => r.children));
    const top = (runs: ReadonlyArray<RunRow>) => runs.filter((run) => !nestedIds.has(run.id));
    const atTop = top(group.active);
    // The runs with a question first, the way the local board lists them: a run that
    // has stopped for you is costing its whole wall-clock while it waits.
    const active = [...atTop.filter((r) => r.needsYou), ...atTop.filter((r) => !r.needsYou)];
    const inside = [
      groupRow(group, marks),
      ...active.flatMap((r) => under(r, "active")),
      ...top(group.recent).flatMap((r) => under(r, "recent")),
      ...agentGroup(
        group.agents.filter((a) => !byId.has(a.run)),
        orphanRow,
        marks,
      ).map((row) => nested(row, 1)),
    ];
    rows.push(...(away ? inside.map(unreachable) : inside));
  }
  return keyedInOrder([...rows, ...quietRow(wide)]);
}

/**
 * The agents' digits, numbered across the whole tree. Every group numbers its own from
 * 1, so without this each workspace showed a `1` and the key focused the first of them
 * — the digit has to name the row it is drawn on. Nine of them, as on the local board;
 * the tenth agent onwards keeps its row and loses its digit.
 */
function keyedInOrder(rows: readonly Row[]): Row[] {
  let digit = 0;
  return rows.map((row) => {
    if (row.kind !== "agent") return row;
    digit += 1;
    return { ...row, key: digit <= MAX_AGENTS ? String(digit) : null };
  });
}

/**
 * A row in a workspace this session no longer has. Its panes are somewhere this herdr
 * cannot select, so Enter says so rather than failing at a tab that is not there.
 */
const unreachable = (row: Row): Row => ({
  ...row,
  jump: row.jump === null ? null : { kind: "none", label: row.jump.label },
});

const ELSEWHERE = "elsewhere";

/** A blank line. A header, so the arrows step over it and nothing can select it. */
const spacer = (id: string): Row => ({ ...BLANK, id, kind: "header", title: "" });

/** One row inside a group, at its depth in the tree. */
function nested(row: Row, depth: number): Row {
  return { ...row, depth };
}

/**
 * A run inside its workspace group, named by its workflow alone. The group row already
 * says what the workspace is for, and the run's own detail and age are what tell two
 * runs of it apart.
 */
const unqualified = (row: Row): Row => ({ ...row, title: row.title.split(" · ")[0]! });

/**
 * One workspace. Selectable and bold: its own line is where the eye stops, and the
 * counts and the leading run's step are what make expanding it unnecessary.
 *
 * It carries no `needsYou`, though it counts them in its summary: that field is what
 * the footer counts and what a run row is ordered by, and a workspace counted beside
 * its own waiting run made "1 run(s) need you" read as two.
 */
function groupRow(group: WideGroup, marks?: Marks): Row {
  return {
    ...BLANK,
    id: `group:${group.workspaceId ?? ELSEWHERE}`,
    kind: "group",
    glyph: group.glyph,
    marks: worstOf([...group.active, ...group.recent].map((run) => markFor(marks, run.id))),
    title: group.label,
    detail: group.summary,
    jump: group.workspaceId
      ? { kind: "workspace", workspaceId: group.workspaceId, label: group.label }
      : { kind: "none", label: group.label },
  };
}

/**
 * The session's other workspaces, on one line at the end. A herdr session is mostly
 * workspaces Collie has never run anything in; naming them here is what keeps them out
 * of the list without hiding them.
 */
function quietRow(wide: WideView): Row[] {
  if (wide.quiet.length === 0) return [];
  return [
    spacer("gap:quiet"),
    {
      ...BLANK,
      id: "header:quiet",
      kind: "header",
      title: `${wide.quiet.length} more workspace(s)`,
      detail: `nothing of Collie's in them · ${wide.quiet.join(" · ")}`,
    },
  ];
}

/**
 * A name for the group of rows under it. Selectable, like every row, and inert. Short
 * enough to fit the title column, which is a share of the pane: a header clipped
 * mid-word says less than no header at all.
 */
/** The header over the runs that have stopped for the human. */
export const NEEDS_YOU = "Needs you";

function headerRow(title: string): Row {
  return { ...BLANK, id: `header:${title}`, kind: "header", title };
}

/**
 * "2 run(s) need you", while the Selection is not on one of them. On one of them the
 * question itself is already on screen under the row, so the count would only be telling
 * the human about what they are looking at.
 */
export function needsYouStatus(rows: readonly Row[], selected: string | null): string | null {
  const waiting = rows.filter((row) => row.needsYou);
  if (waiting.length === 0 || waiting.some((row) => row.id === selected)) return null;
  return `${waiting.length} run(s) need you`;
}

/**
 * The rows the Selection may land on. A header names the group under it and nothing acts
 * on one, so the cursor steps over it: with a header first in the list, the board opened
 * with an inert row selected and the detail panel titled after a heading. Rendering still
 * draws every row — this is only about where the Selection can rest.
 */
export function selectableRows(rows: readonly Row[]): Row[] {
  return rows.filter((row) => row.kind !== "header");
}

/**
 * The rows of whichever View is showing. One list region, one Selection, one filter, one
 * set of scroll keys — a second implementation per View is how they would drift apart.
 */
/**
 * The Runs view's rows, whichever View is showing. The same View at whichever scope is
 * showing, and the local board until the wide one has been read: a scope toggle is
 * answered before its board arrives.
 *
 * Read from outside the Runs view too, because a question is a question wherever the
 * human happens to be looking — `n` reaches one from Settings, and the button offering
 * it is drawn there for the same reason.
 */
export function runsRows(state: AppState): Row[] {
  const filter = state.filter;
  if (filter.kind === "run") return onlyRun(everyRow(state), filter.id);
  if (filter.kind === "workspace" && state.wide) {
    const group = state.wide.groups.find((g) => g.workspaceId === filter.id);
    // Not on the wide board at all — a workspace Collie has nothing in — so this
    // board's own runs are what is left to show.
    if (!group) return rowsOf(state.board, state.marks);
    return wideRows({ ...state.wide, groups: [group], quiet: [] }, state.marks);
  }
  return everyRow(state);
}

/** The Herd's whole board, and this board's own until the wide one has been read. */
function everyRow(state: AppState): Row[] {
  return state.wide ? wideRows(state.wide, state.marks) : rowsOf(state.board, state.marks);
}

/**
 * One Run and what hangs off it: the run's row, the agents working for it, and the
 * repository runs it fanned out.
 *
 * Not by depth: on the local board an agent sits at its run's *own* depth — the connector
 * is what joins them — so a depth test ended the group at the first agent and showed a
 * run with nothing under it. An agent is kept when it names this run, and a deeper row
 * when it is nested under what has been kept so far.
 */
function onlyRun(rows: readonly Row[], runId: string): Row[] {
  const at = rows.findIndex((row) => row.kind !== "agent" && row.runId === runId);
  if (at < 0) return [];
  const start = rows[at]!;
  const kept = [start];
  const mine = new Set([runId]);
  for (const row of rows.slice(at + 1)) {
    const nestedDeeper = row.depth > start.depth;
    const ofMine = row.runId !== null && mine.has(row.runId);
    if (!nestedDeeper && !(row.kind === "agent" && ofMine)) break;
    kept.push(row);
    // A child run of this one brings its own agents along, so it joins the set.
    if (row.kind !== "agent" && row.runId !== null) mine.add(row.runId);
  }
  return kept;
}

export function viewRows(state: AppState): Row[] {
  switch (state.view) {
    case "runs":
      return runsRows(state);
    case "history":
      return (state.history ?? []).map((r) => runRow(r, state.board.now, "history", state.marks));
    case "workflows":
      // Workflows only: a persona is instructions, not something that can be run, so a
      // persona row here offered a key that did nothing. Fork is where they are acted on.
      return (state.definitions?.workflows ?? []).map(definitionRow);
    case "settings": {
      const settings = state.settings;
      if (!settings) return [];
      return [
        ...settings.defaults.map((d) => settingRow(d.key, d.key, d.value, true)),
        ...settings.remembered.map((d) => settingRow(`remembered:${d.key}`, d.key, d.value, false)),
        settingRow(
          "trust-here",
          "trust (this directory)",
          `${settings.trust.state} · ${settings.trust.cwd}`,
          false,
        ),
      ];
    }
  }
}

/** What to say when a View has nothing in it, so an empty list is not a dead end. */
export function emptyStateOf(view: ViewName): string {
  switch (view) {
    case "runs":
      return "Nothing running here — p runs a workflow";
    case "history":
      return "No finished runs for this checkout yet — p runs a workflow";
    case "workflows":
      return "No workflows found — check the plugin's workflows/ directory";
    case "settings":
      return "No defaults set — everything is the baseline";
  }
}

/**
 * The Selection after a refresh. The same id if it is still there; otherwise whatever
 * took its place, so a run finishing under the cursor leaves the neighbour selected
 * rather than nothing — and nothing only when there is nothing left to select.
 */
export function clampSelection(
  selected: string | null,
  before: readonly Row[],
  after: readonly Row[],
): string | null {
  if (after.length === 0) return null;
  if (selected !== null && after.some((r) => r.id === selected)) return selected;
  const was = selected === null ? -1 : before.findIndex((r) => r.id === selected);
  return after[Math.min(Math.max(was, 0), after.length - 1)]!.id;
}

/**
 * The detail of the Selection, and nothing while a newer Selection is still being read.
 * The read happens in a fiber, so `state.detail` lags the row the human has just moved
 * to — and a panel that drew it anyway attributed the previous Run's review, Outputs and
 * merge request to the new row, `c` copying the wrong URL with it.
 */
export function detailFor(state: AppState, row: Row | null): RunDetail | null {
  const detail = state.detail;
  return detail !== null && row !== null && row.runId === detail.id ? detail : null;
}

export interface Action {
  key: string;
  label: string;
  command: Command;
}

/**
 * What this row can be asked to do. The row buttons and the footer both read this, so
 * a key the footer offers always acts on the Selection and never on something else —
 * and a key with nothing to act on is never on the line at all.
 *
 * The Scope decides two of them. Starting a workflow is this Session's: a fix round or
 * a second review runs in this workspace's checkout, so offering either on a board of
 * every workspace would start one against the wrong repository. They are offered on a
 * local board only, the way `s` is.
 */
export function actionsFor(row: Row | null, filter: Filter): Action[] {
  if (!row) return [];
  // A workspace is somewhere to go and nothing else: Enter on it is the jump, which
  // `keyIntent` answers from the row for every kind of row alike.
  if (row.kind === "group") return [];
  if (row.kind === "agent") {
    return row.key && row.agent
      ? [{ key: row.key, label: "focus", command: { _tag: "FocusAgent", agent: row.agent } }]
      : [];
  }
  if (row.kind === "definition") {
    const definition = row.definition;
    if (!definition) return [];
    // Every definition row is a Workflow: a persona is instructions injected into an
    // agent, so there is nothing to run on its own and the view stopped listing them.
    return [
      { key: "\r", label: "run", command: { _tag: "RunWorkflow", workflow: definition.name } },
    ];
  }
  if (row.kind === "setting") {
    // A remembered value is a Run's own note to itself; the defaults are what a human
    // sets, so only those are offered for editing.
    return row.setting?.writable
      ? [{ key: "\r", label: "set", command: { _tag: "EditSetting", key: row.setting.key } }]
      : [];
  }

  const runId = row.runId;
  if (runId === null) return [];
  const actions: Action[] = [{ key: "l", label: "log", command: { _tag: "OpenLog", runId } }];
  // A finished run has no driver left to stop, so the key is not offered for one.
  if (row.kind === "active") {
    actions.push({ key: "k", label: "stop", command: { _tag: "StopRun", runId } });
  } else if (row.fixable && sessionLocal(filter)) {
    // Only for a run that has stopped: a fix round over a run still writing its own
    // review would build from half of it.
    actions.push({ key: "x", label: "fix what is open", command: { _tag: "FixFindings", runId } });
  }
  if (row.target) {
    if (sessionLocal(filter)) {
      actions.push({
        key: "a",
        label: "review again",
        command: { _tag: "ReviewAgain", target: row.target },
      });
    }
    if (row.target.startsWith("mr:")) {
      // Posting needs a review to post, and `fixable` is the row's only word on whether
      // one was written. Looking at the merge request needs nothing but the target, so a
      // review that came back clean is still one you can open.
      if (row.fixable) {
        actions.push({ key: "o", label: "post to the MR", command: { _tag: "PostReview", runId } });
      }
      actions.push({
        key: "w",
        label: "open in a browser",
        command: { _tag: "OpenMr", target: row.target, runId },
      });
    }
  }
  return actions;
}

/**
 * What the tab's keyboard is on. Three things have to agree about it — which keys act, a
 * paste, and what the footer offers — and they each used to work it out again from the
 * same four facts, in the same order, by hand. One value instead, so the order is stated
 * once: a flow asking a question owns the keyboard, then the selected run's question,
 * then the filter, then a Settings value, and the board's own keys when nothing is
 * taking typing.
 */
export type Keyboarding =
  | { _tag: "Flow" }
  /** A proposal on screen, which takes exactly two keys and refuses every other. */
  | { _tag: "Proposal"; proposal: { id: string; hash: string } }
  | { _tag: "Choice"; choice: PendingChoice }
  | { _tag: "Filter" }
  | { _tag: "Setting"; setting: { key: string; value: string } }
  | { _tag: "Steering"; draft: string; aimed: boolean }
  | { _tag: "Board" };

/** Where the keyboard is, from what the tab has open. Pure, and the order is the point. */
export function keyboardOn(at: {
  /** A flow asking a question inline; it has handlers of its own. */
  flow: boolean;
  /**
   * The proposal on screen, where one is. Above the question, because it is the narrower
   * of the two — two keys and nothing else — and a human reading one has already been
   * put in front of a decision.
   */
  proposal?: { id: string; hash: string } | null;
  /** The selected run's pending question, where it has one. */
  choice: PendingChoice | null;
  /** Whether the cursor is in the filter, which outlives the text being kept. */
  filtering: boolean;
  /** A Settings row being given a new value. */
  setting: { key: string; value: string } | null;
  steering?: string | null;
  /** Whether the composer is aimed at the selected Run rather than at the flock. */
  steerAimed?: boolean;
}): Keyboarding {
  if (at.flow) return { _tag: "Flow" };
  if (at.proposal) return { _tag: "Proposal", proposal: at.proposal };
  if (at.choice) return { _tag: "Choice", choice: at.choice };
  if (at.filtering) return { _tag: "Filter" };
  if (at.setting) return { _tag: "Setting", setting: at.setting };
  if (at.steering !== null && at.steering !== undefined) {
    return { _tag: "Steering", draft: at.steering, aimed: at.steerAimed === true };
  }
  return { _tag: "Board" };
}

const PASTED = new TextDecoder();

/**
 * A paste appended to the field it was pasted into. opentui delivers a paste as bytes on
 * its own event rather than as keys, and the keyboard handlers take one printable
 * character at a time, so this is the one place a whole pasted string becomes field text.
 *
 * Every control character is dropped, the trailing newline a copied line carries most of
 * all: a newline is the submit key, and a pasted value has to be readable before it is
 * sent. Non-ASCII letters survive — a pasted branch name keeps them.
 */
export function pasteInto(value: string, bytes: Uint8Array): string {
  return value + PASTED.decode(bytes).replace(/\p{C}/gu, "");
}

/**
 * The options a question with room for `room` lines can show, as a window that keeps the
 * cursor inside it, and how many it leaves out. A question's region is capped so the list
 * it belongs to keeps rows of its own, and an option the cursor is on but nobody can see
 * is one nobody can knowingly press Enter on.
 */
export function optionWindow<T>(items: readonly T[], at: number, room: number): Windowed<T> {
  if (items.length <= room) return { shown: items, hidden: 0 };
  // The window ends one past the cursor at the earliest, and stops at the last option.
  const end = Math.min(items.length, Math.max(room, at + 1));
  return { shown: items.slice(end - room, end), hidden: items.length - room };
}

/** The slice of a list a capped region shows, and how many it leaves out. */
export interface Windowed<T> {
  shown: readonly T[];
  hidden: number;
}

/**
 * The footer's buttons: the Selection's own, and the one board-wide action there is.
 * Each is offered only where there is something to act on and the key beside it does
 * what the label says — a button whose key would type a character is a lie, and both
 * kinds of lie are read off the one fact about who has the keyboard.
 *
 * The Selection's own drop out for any field, because Enter and every letter belong to
 * it. The next-question button drops out only for a field taking text: a menu takes
 * none, and a board of several asking Runs is exactly when `n` is wanted.
 */
export function footerActions(opts: {
  row: Row | null;
  filter: Filter;
  /** Whether anything on this board is asking, which is what `n` can act on. */
  questions: boolean;
  on: Keyboarding;
}): Action[] {
  return [
    ...(fieldHasKeys(opts.on) ? [] : actionsFor(opts.row, opts.filter)),
    ...(opts.questions && !takesText(opts.on)
      ? [
          {
            key: NEXT_QUESTION,
            label: "next question",
            command: { _tag: "NextQuestion" } as const,
          },
        ]
      : []),
  ];
}

/** Whether anything but the board has the keys: a question, the filter, a value. */
function fieldHasKeys(on: Keyboarding): boolean {
  return (
    on._tag === "Choice" ||
    on._tag === "Filter" ||
    on._tag === "Setting" ||
    on._tag === "Steering" ||
    on._tag === "Proposal"
  );
}

/**
 * Every key the app handles, with what it does. One list: the help overlay draws it,
 * `docs/using.md` restates it, and a key added to the handler and not to this is a key
 * nobody can find. The footer offers a subset — only what the Selection can be asked
 * for — which is why the complete list needs a place of its own.
 *
 * Kept short on purpose: the overlay has to fit a 24-row pane, and `docs/using.md` is
 * where the sentence-long version of each of these lives.
 */
export const ALL_KEYS: ReadonlyArray<{ key: string; what: string }> = [
  { key: "↑↓", what: "Move the Selection" },
  { key: "Shift+↑↓", what: "Scroll the panel by a line" },
  { key: "PgUp/PgDn", what: "Scroll the panel by a page" },
  { key: "Tab", what: "Move between views" },
  { key: "1-9", what: "Focus that agent's pane" },
  { key: "p", what: "Run a workflow" },
  { key: "u", what: "Resume an unfinished run" },
  { key: "f", what: "Fork a workflow or persona" },
  { key: "s", what: "Send the review to an implementer" },
  { key: "l", what: "Open the run's log in a pane" },
  { key: "t", what: "Tail that log in the panel" },
  { key: "m", what: "Read more of a cut-short panel" },
  { key: "x", what: "Fix what the review left open" },
  { key: "a", what: "Review that target again" },
  { key: "o", what: "Post the review to its MR" },
  { key: "w", what: "Open that MR in a browser" },
  { key: "c", what: "Copy that MR's URL" },
  { key: "k", what: "Stop the selected run" },
  { key: "n", what: "Go to the next unanswered question" },
  { key: "Enter", what: "Go to it, or run what is selected" },
  { key: ":", what: "Steer the selected run" },
  { key: "/", what: "Filter the list" },
  { key: "Esc", what: "Clear the filter, then widen" },
  { key: "g", what: "This workspace, or the whole Herd" },
  { key: "R", what: "Re-read what is on screen" },
  { key: "?", what: "This list; any key closes it" },
  { key: "q", what: "Close the tab" },
];
/**
 * The globals the line always ends in. Few, because the footer's job is the Selection's
 * own keys: the two-line wrap of every global was what made the important ones
 * unreadable, and `?` is what the rest of them live behind now. The scope is here
 * rather than behind `?` because it is the one thing about this board that is not
 * visible on it — and the key names where it goes, not where it is.
 */
const globalKeys = (filter: Filter): ReadonlyArray<string> => [
  `g ${sessionLocal(filter) ? "all" : "local"}`,
  // Starting a run is this Session's, so it is not offered from a board of every
  // workspace; `g local` above is how you get back to somewhere it means something.
  ...(sessionLocal(filter) ? ["p run"] : []),
  "? keys",
  "q close",
];

/**
 * The footer's key line: what a field that has taken the keys says they do, and the
 * board's own three where nothing has. Pure, so what the line says in each of those is a
 * test rather than a screenshot — and so it cannot drift from what each mode accepts.
 */
export function footerKeys(opts: {
  panel: ReadonlyArray<string>;
  on: Keyboarding;
  filter: Filter;
}): string {
  if (opts.on._tag === "Choice") return "↑↓ move · Enter choose · Esc leave the run open";
  if (opts.on._tag === "Setting") return "type a value · Enter set it · Esc leave it";
  // The filter has the keys too, so the board's own are as much a lie here as the
  // Selection's buttons were: `k` typed a `k` while `[k stop]` stopped the run.
  if (opts.on._tag === "Filter") return "type to narrow · Enter keep it · Esc drop it";
  if (opts.on._tag === "Steering") {
    return opts.on.aimed
      ? "type · Tab stops aiming · Enter proposes · Esc back to the board"
      : "type · Tab aims at the selected run · Enter asks about the flock · Esc back";
  }
  if (opts.on._tag === "Proposal") return "Enter carry it out · Esc decline it";
  return [...opts.panel, ...globalKeys(opts.filter)].join(" · ");
}

/**
 * One keypress, as much of it as anything here needs. Structurally typed rather than
 * OpenTUI's `KeyEvent`, because this module must stay renderer-free — the same reason it
 * stays Effect-free.
 */
export interface Keypress {
  sequence: string;
  name?: string;
  shift?: boolean;
  ctrl?: boolean;
}

/**
 * What the board is, as far as the keyboard is concerned. Plain facts, which is what
 * makes the whole cascade below a unit test instead of a rendered one: the precedence
 * between six things that can own the keyboard used to be readable only as the order of
 * early returns inside a `useKeyboard` callback.
 */
export interface KeyContext {
  /** Which View is showing: the scope is the Runs view's, so `g` is that view's key. */
  view: ViewName;
  /**
   * What the board is filtered to. Only the Session-local keys ask: a hand-off names one
   * of this Session's live agents, and a board of the whole session has rows that are
   * not this Session's.
   */
  filter: Filter;
  /**
   * Where the keyboard is. `keyboardOn` above is the one answer to that, shared with the
   * paste handler and the footer, so this does not restate the facts it is made of.
   */
  on: Keyboarding;
  /**
   * Whether the help overlay is up, in which case any key closes it. Not part of
   * `Keyboarding`, because the overlay takes no typing — it is drawn over whatever does.
   */
  helping: boolean;
  /** Where answering the pending question has got to. */
  asking: Asking;
  /** The text narrowing the list, while the keyboard is in it. Not the board's Filter. */
  query: string;
  /** Whether the detail panel is on screen and can be scrolled. */
  scrollable: boolean;
  /** The Selection, and every row, for the keys that act on one or find one. */
  row: Row | null;
  rows: readonly Row[];
  /** Whether the panel cut something short, which is the only thing `m` can act on. */
  cutShort: boolean;
  /** The merge request URL `c` copies, where there is one. */
  mrUrl: string | null;
}

/**
 * What one keypress does. Everything the app can be asked to do by the keyboard, as
 * plain data: the four at the top are the app's own state, `Scroll` and `Copy` are the
 * two effects only a renderer can perform, and `Do` is every command that already has a
 * name. `null` is a key this board does nothing with.
 */
export type KeyIntent =
  | { _tag: "Help"; open: boolean }
  /** Where one keystroke left a pending question: what to show, and what to send. */
  | { _tag: "Answered"; asking: Asking; value: string | null }
  | { _tag: "Filtering"; filter: string; typing: boolean }
  /** What is in the Steer box now, or `null` for a box the human has closed. */
  | { _tag: "Steering"; draft: string | null; aimed: boolean }
  | { _tag: "Editing"; editing: { key: string; value: string } | null }
  /**
   * The value being edited, sent: dispatch it and close the editor. One intent for one
   * key doing both, the way `Answered` carries the new asking state and the answer —
   * a bare `Do` left the footer in editor mode with every later key still editing.
   */
  | { _tag: "Submitted"; command: Command }
  /** Select the next pending Choice; the app knows the rows and the filter. */
  | { _tag: "NextQuestion" }
  | { _tag: "Move"; by: -1 | 1 }
  | { _tag: "ShowViewBy"; by: -1 | 1 }
  | { _tag: "Scroll"; by: -1 | 1; unit: "line" | "page" }
  | { _tag: "Copy"; text: string }
  | { _tag: "Do"; command: Command };

const PRINTABLE = /^[\x20-\x7e]$/;

/**
 * The key that goes to the next unanswered question. Unused by the rest of the map,
 * and deliberately reachable while a menu is up: a board of several asking Runs is
 * exactly when it is needed, and a menu takes no text for it to steal.
 */
const NEXT_QUESTION = "n";

/**
 * Whether what has the keyboard is a field being typed into. A global shortcut must
 * never be read out of one — the character belongs to the answer, the filter or the
 * value — which is what keeps `n` from jumping while a free-text question is open.
 */
function takesText(on: Keyboarding): boolean {
  if (on._tag === "Filter" || on._tag === "Setting" || on._tag === "Steering") return true;
  return on._tag === "Choice" && on.choice.kind === "ask";
}

/**
 * The next Run with a pending Choice after the Selection, wrapping once. Over every row
 * of the current Scope rather than what a filter left, because a question hidden behind
 * a filter is still unanswered — the app clears the filter to show the one this picks.
 *
 * A Selection that is not on this board starts the search at the top, so the first
 * question is not skipped. `null` means there is no question anywhere.
 */
export function nextQuestionId(rows: readonly Row[], selected: string | null): string | null {
  const list = selectableRows(rows);
  const at = list.findIndex((row) => row.id === selected);
  const from = at < 0 ? -1 : at;
  for (let step = 1; step <= list.length; step++) {
    const row = list[(from + step + list.length) % list.length]!;
    if (row.choice) return row.id;
  }
  return null;
}

/** The keys that start something in this Session, and what each opens. */
const SESSION_MODES = new Map<string, Mode>([
  ["p", "pick"],
  ["u", "resume"],
  ["f", "fork"],
]);

const doing = (command: Command): KeyIntent => ({ _tag: "Do", command });

/**
 * What one keypress means, given what is on screen. One ordered cascade, and the order
 * is the whole design: whoever owns the keyboard is asked first, and only a board with
 * nobody else asking gets to the list's own keys.
 *
 * Pure, so each of those rules is a test. It returns intents rather than performing
 * anything because two of them — scrolling the panel, putting a URL on the clipboard —
 * belong to the renderer, and a function that reached for those could not be tested at
 * all. `Do` carries the commands unchanged, so a key and a click on the same row button
 * still cannot mean different things.
 */
export function keyIntent(at: KeyContext, key: Keypress): KeyIntent | null {
  // The overlay is the whole screen and every key behind it acts on something nobody
  // can see, so any key closes it and does nothing else. First, because that is the
  // order App draws them in: it hides the Flow behind the overlay, so giving a flow the
  // keyboard here left a visible overlay that no key could close.
  if (at.helping) return { _tag: "Help", open: false };
  // A flow asking a question owns the keyboard: `Flow` has its own handler, and a key
  // that also moved the Selection underneath would act on a board nobody is looking at.
  if (at.on._tag === "Flow") return null;
  // A proposal on screen: two keys, and every other one refused. A human reading what
  // they are being asked to consent to must not be able to stop a run by pressing `k` at
  // it — the payload is on screen, and the only answers to it are yes and no.
  if (at.on._tag === "Proposal") {
    const { id, hash } = at.on.proposal;
    if (key.name === "return") return doing({ _tag: "ConfirmProposal", id, hash });
    if (key.name === "escape") return doing({ _tag: "DeclineProposal", id });
    return null;
  }
  // Before whoever has the keyboard, but only where that is not a field taking text:
  // this is the one way to a question on a board where a question already has the keys.
  if (key.sequence === NEXT_QUESTION && !takesText(at.on)) return { _tag: "NextQuestion" };
  if (at.on._tag === "Choice") {
    const next = answerFor(at.on.choice, at.asking, key.sequence);
    return { _tag: "Answered", asking: next.asking, value: next.value };
  }
  if (at.on._tag === "Filter") {
    // Enter stops typing and keeps the text — `/` narrows the list so a row can then be
    // acted on — and only Esc drops it.
    if (key.name === "escape") return { _tag: "Filtering", filter: "", typing: false };
    if (key.name === "return") return { _tag: "Filtering", filter: at.query, typing: false };
    if (key.name === "backspace") {
      return { _tag: "Filtering", filter: at.query.slice(0, -1), typing: true };
    }
    if (PRINTABLE.test(key.sequence)) {
      return { _tag: "Filtering", filter: at.query + key.sequence, typing: true };
    }
    return null;
  }
  // A Settings row being given a new value: every key belongs to that until it is sent
  // or abandoned, the same rule a pending question follows.
  if (at.on._tag === "Setting") {
    const editing = at.on.setting;
    if (key.name === "escape") return { _tag: "Editing", editing: null };
    if (key.name === "return") {
      const command: Command = { _tag: "SetDefault", key: editing.key, value: editing.value };
      return { _tag: "Submitted", command };
    }
    if (key.name === "backspace") {
      return { _tag: "Editing", editing: { ...editing, value: editing.value.slice(0, -1) } };
    }
    if (PRINTABLE.test(key.sequence)) {
      return { _tag: "Editing", editing: { ...editing, value: editing.value + key.sequence } };
    }
    return null;
  }
  // The composer. Enter with nothing aimed is a question about the flock — read-only,
  // answered about every Run — and that is the ordinary case. A message aimed at one Run
  // names it explicitly, and the target is never taken from whichever row the board
  // happens to have selected: a question typed while looking at an old Run used to be
  // dropped on the floor, and aiming it at that Run instead would be worse.
  if (at.on._tag === "Steering") {
    const draft = at.on.draft;
    if (key.name === "escape") return { _tag: "Steering", draft: null, aimed: false };
    if (key.name === "return") {
      if (draft.trim() === "") return null;
      const runId = at.on.aimed ? (at.row?.runId ?? null) : null;
      return { _tag: "Submitted", command: { _tag: "Steer", text: draft, runId } };
    }
    // Aim it, or stop aiming it. Explicit, and only where there is a row to aim at: a
    // mutation has to name its target, and this is where a human says which.
    if (key.name === "tab") {
      return { _tag: "Steering", draft, aimed: !at.on.aimed && at.row?.runId !== undefined };
    }
    if (key.name === "backspace")
      return { _tag: "Steering", draft: draft.slice(0, -1), aimed: at.on.aimed };
    if (PRINTABLE.test(key.sequence))
      return { _tag: "Steering", draft: draft + key.sequence, aimed: at.on.aimed };
    return null;
  }
  // A filter kept so a row can be acted on outlives the keyboard being in it, so Esc
  // has to reach it from the board too: it used to mean `/` first, and a filter nobody
  // remembers setting hides whole workspaces on a wide board.
  if (key.name === "escape" && at.query !== "") {
    return { _tag: "Filtering", filter: "", typing: false };
  }
  // And once there is no text filter left to drop, Esc widens the board: narrowing to a
  // workspace is a filter too, and the way out of one has to be the same key.
  if (key.name === "escape") return doing({ _tag: "SetFilter", filter: { kind: "all" } });
  // After everything that takes text, never before: a printable character belongs to
  // the answer, the filter or the value being typed, and a free-text answer that could
  // not contain a question mark was the cost of checking this first.
  if (key.sequence === "?") return { _tag: "Help", open: true };
  // The panel's keys before the list's: the arrows move the Selection, so these are
  // deliberately the arrows with a modifier plus the two keys that mean "page" on every
  // other reader.
  if (at.scrollable) {
    if (key.name === "pageup") return { _tag: "Scroll", by: -1, unit: "page" };
    if (key.name === "pagedown") return { _tag: "Scroll", by: 1, unit: "page" };
    if (key.shift && key.name === "up") return { _tag: "Scroll", by: -1, unit: "line" };
    if (key.shift && key.name === "down") return { _tag: "Scroll", by: 1, unit: "line" };
  }
  // Arrows, and not `hjkl`: `k` is the stop key the board has always had and the one the
  // footer offers, and a destructive key that sometimes means "up" is worse than no vim
  // binding.
  if (key.name === "up") return { _tag: "Move", by: -1 };
  if (key.name === "down") return { _tag: "Move", by: 1 };
  if (key.name === "tab") return { _tag: "ShowViewBy", by: key.shift ? -1 : 1 };
  if (key.sequence === "/") return { _tag: "Filtering", filter: at.query, typing: true };
  // `:` and not `s`: `s` is the hand-off, and a key that sometimes sends a review and
  // sometimes opens a text box is a key nobody can press with confidence.
  if (key.sequence === ":") return { _tag: "Steering", draft: "", aimed: false };
  // Re-reading what is on screen, and the one merge request behind it: a cached read is
  // what makes selecting cheap, so there has to be a way to say "ask again".
  if (key.sequence === "R") return doing({ _tag: "Refresh" });
  // The log, in the panel: `l` still opens it in a pane, because grepping and copying
  // belong in one.
  if (key.sequence === "t") return at.row?.runId ? doing({ _tag: "ToggleTail" }) : null;
  // The rest of a review the panel cut short, a cap at a time.
  if (key.sequence === "m") return at.cutShort ? doing({ _tag: "MoreReview" }) : null;
  if (key.sequence === "c") return at.mrUrl ? { _tag: "Copy", text: at.mrUrl } : null;
  if (key.name === "q" || (key.ctrl && key.name === "c")) return doing({ _tag: "Quit" });
  // A digit focuses that agent wherever the Selection is: those keys are the board's
  // shortcut into a pane, not an action on a row.
  if (/^[1-9]$/.test(key.sequence)) {
    const agent = at.rows.find((r) => r.kind === "agent" && r.key === key.sequence);
    return agent?.agent ? doing({ _tag: "FocusAgent", agent: agent.agent }) : null;
  }
  // The way into the whole session, and back. The Runs view's own key: it is the only
  // View a Scope means anything to, and widening one nobody is looking at would read
  // the whole session on every tick for nothing.
  if (key.sequence === "g") return at.view === "runs" ? doing({ _tag: "ToggleFilter" }) : null;
  // The local board's keys, all four under the one rule: starting a workflow, resuming
  // one and forking a definition act on this workspace's checkout rather than on the
  // selected row, and the hand-off `s` names an agent on this Session's register —
  // none of which is what a board of every workspace is about. A wide board falls
  // through to the row's own keys, which are none of these.
  if (sessionLocal(at.filter)) {
    const mode = SESSION_MODES.get(key.sequence);
    if (mode) return doing({ _tag: "OpenMode", mode });
    if (key.sequence === "s") return doing({ _tag: "SendReview", runId: at.row?.runId ?? null });
  }
  // Enter means "go to it" wherever a row points at anything — a workspace, a run, an
  // agent, in either scope — resolved from the row's own key when it is pressed rather
  // than from an id cached when the row was drawn. A Workflow and a Settings row point
  // at nothing and keep Enter for their own action, below.
  // A workspace row is a filter, not a pane: Enter narrows the board to it, and its
  // runs are what Enter jumps into from there.
  if (key.name === "return" && at.row?.kind === "group" && at.row.jump?.kind === "workspace") {
    return doing({ _tag: "SetFilter", filter: { kind: "workspace", id: at.row.jump.workspaceId } });
  }
  if (key.name === "return" && at.row?.jump) return doing({ _tag: "Jump", jump: at.row.jump });
  const action = actionsFor(at.row, at.filter).find(
    (a) => a.key === (key.name === "return" ? "\r" : key.sequence),
  );
  return action ? doing(action.command) : null;
}

/** How one line of a panel's markdown is drawn. Four, because four is what helps. */
export type LineStyle = "heading" | "list" | "code" | "plain";

export interface StyledLine {
  text: string;
  style: LineStyle;
}

/**
 * A review or a plan spec as styled lines. Four styles and no markdown dependency: the
 * panel needs a long document to be skimmable — where the headings are, what is a list,
 * what is code — and nothing beyond that. Inline emphasis is deliberately left alone,
 * because rewriting the text is how a review stops saying what the agent wrote.
 *
 * ponytail: line-level only. A parser goes in the day something needs tables.
 */
/** A hash needs its space: `#!/bin/sh` in something the agent pasted is not a heading. */
const HEADING = /^#{1,6}\s/;
const LIST_ITEM = /^\s*([-*+]|\d+\.)\s/;
const FENCE = "```";

export function markdownLines(text: string): StyledLine[] {
  let fenced = false;
  return text.split("\n").map((line): StyledLine => {
    if (line.trimStart().startsWith(FENCE)) {
      fenced = !fenced;
      return { text: line, style: "code" };
    }
    if (fenced) return { text: line, style: "code" };
    if (HEADING.test(line)) return { text: line, style: "heading" };
    if (LIST_ITEM.test(line)) return { text: line, style: "list" };
    return { text: line, style: "plain" };
  });
}

/** Where a pending question has got to: the highlighted option, or the text so far. */
export interface Asking {
  index: number;
  typed: string;
}

/** Where one keystroke left a question: what to show next, and what to send back. */
export interface Answered {
  asking: Asking;
  /** `""` for Esc, which leaves the run open; `null` while it is still being composed. */
  value: string | null;
}

/**
 * One keystroke against a pending question. Pure, so the app and the text fallback
 * answer a question identically rather than each having their own idea of Esc.
 */
export function answerFor(choice: PendingChoice, asking: Asking, key: string): Answered {
  if (key === "\x1b" || key === "\x03") return { asking, value: "" };
  if (key === "\r" || key === "\n") {
    const value = choice.kind === "ask" ? asking.typed : (choice.items[asking.index]?.id ?? null);
    return { asking: { index: 0, typed: "" }, value };
  }
  if (choice.kind === "ask") {
    if (key === "\x7f" || key === "\b") {
      return { asking: { ...asking, typed: asking.typed.slice(0, -1) }, value: null };
    }
    if (/^[\x20-\x7e]$/.test(key)) {
      return { asking: { ...asking, typed: asking.typed + key }, value: null };
    }
    return { asking, value: null };
  }
  if (key === "\x1b[A") {
    return { asking: { ...asking, index: Math.max(0, asking.index - 1) }, value: null };
  }
  if (key === "\x1b[B") {
    const last = Math.max(0, choice.items.length - 1);
    return { asking: { ...asking, index: Math.min(last, asking.index + 1) }, value: null };
  }
  return { asking, value: null };
}

/**
 * The colour that reinforces a status glyph. Colour is never the only carrier — the
 * glyph is what the text fallback and herdr's tab strip show, and not everyone can see
 * the colour — so this only ever restates what the glyph already says.
 */
export function statusColour(glyph: string): string | undefined {
  switch (glyph) {
    case GLYPH.running:
      return "#7aa2f7";
    case GLYPH.waiting:
      return "#e0af68";
    case GLYPH.failed:
      return "#f7768e";
    case GLYPH.done:
      return "#9ece6a";
    default:
      return undefined;
  }
}

function subsequence(needle: string, hay: string): boolean {
  let at = 0;
  for (const character of hay) {
    if (character === needle[at]) at += 1;
    if (at === needle.length) return true;
  }
  return needle.length === 0;
}

/**
 * Name prefix first, then substring anywhere, then in-order characters. The popup
 * picker's filter, kept when the popup became components: typing `imp` should find
 * `implement` before it finds a run whose detail mentions "improved", and the fuzzy
 * pass is what makes a half-remembered name findable at all.
 */
export function filterItems<T>(items: readonly T[], query: string, hay: (item: T) => string): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...items];
  const prefix: T[] = [];
  const anywhere: T[] = [];
  const fuzzy: T[] = [];
  for (const item of items) {
    const straw = hay(item).toLowerCase();
    if (straw.startsWith(needle)) prefix.push(item);
    else if (straw.includes(needle)) anywhere.push(item);
    else if (subsequence(needle, straw)) fuzzy.push(item);
  }
  return [...prefix, ...anywhere, ...fuzzy];
}

/**
 * The rows a filter leaves. The list is already nested when this sees it — a run, then
 * the agents working for it — so a row is kept when it matches and a run or a header is
 * kept when anything in its group does: filtering the rows one by one dropped a run whose
 * agent matched and left that agent under nothing, and an agent row does not name its own
 * run any more.
 *
 * The order is the board's own, not the order the matches were ranked in. Ranking is
 * what a pick list wants; here it would lift an agent above the run it hangs off.
 */
export function matching(rows: readonly Row[], query: string): Row[] {
  if (query.trim() === "") return [...rows];
  // A header is not something to look for: it says what the group under it is, so it is
  // never a match of its own — a heading kept over a group that was filtered out is a
  // line that names nothing.
  const looked = rows.filter((row) => row.kind !== "header");
  const hit = new Set(filterItems(looked, query, rowHay).map((row) => row.id));
  return rows.filter(
    (row, at) =>
      hit.has(row.id) ||
      (opensAGroup(row) && groupHasAMatch(rows, at, hit)) ||
      underAMatch(rows, at, hit),
  );
}

/**
 * Whether a row this one is nested under matched, which is what a filter on a workspace
 * name is asking for: narrowing the wide board to `gitlab` means that workspace and the
 * runs in it, not one row saying its name. Local rows are all at depth 0 and have no
 * such row above them, so this only ever answers in the tree.
 */
function underAMatch(rows: readonly Row[], at: number, hit: ReadonlySet<string>): boolean {
  let depth = rows[at]!.depth;
  for (let above = at - 1; above >= 0 && depth > 0; above--) {
    const over = rows[above]!;
    if (over.depth >= depth) continue;
    if (hit.has(over.id)) return true;
    depth = over.depth;
  }
  return false;
}

/** The rows that have a group under them, which is what `rowsOf` puts there. A finished
 * run keeps its agents, so it opens a group exactly as a running one does. */
const opensAGroup = (row: Row) =>
  row.kind === "active" || row.kind === "recent" || row.kind === "header" || row.kind === "group";

/**
 * Whether anything in the group under this row matched: the rows that follow it, until
 * one that is not nested under it. A run's group is the agent rows under it, so a later
 * run matching is not this run's business. A header's group is what the header names —
 * the runs that need you, or the agents with no run here — and the agents of those runs
 * come along with them. A workspace's group is everything indented under it, which is
 * how a filtered wide board keeps the row that says which workspace a run is in.
 */
function groupHasAMatch(rows: readonly Row[], at: number, hit: ReadonlySet<string>): boolean {
  const opener = rows[at]!;
  const nested = (under: Row) =>
    under.kind === "agent" ||
    (opener.kind === "header" && under.needsYou) ||
    (opener.kind === "group" && under.depth > opener.depth);
  for (const under of rows.slice(at + 1)) {
    if (!nested(under)) return false;
    if (hit.has(under.id)) return true;
  }
  return false;
}

/** What a row is matched against: everything on it a human might type at. */
export function rowHay(row: Row): string {
  return `${row.title} ${row.detail}`;
}

/** And what a pick item is matched against; its id is the name the prefix pass finds. */
export function itemHay(item: PickItem): string {
  return `${item.id} ${item.title} ${item.subtitle ?? ""}`;
}
