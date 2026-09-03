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
import { agoShort } from "../time";
import type { Mode } from "../flows";
import type { DefinitionRow, RunDetail, SettingsView } from "../views";
import type { AgentRow, RunRow, WorkspaceView } from "../workspace";

/** What the nav switches between. One at a time, each a projection of state. */
export type ViewName = "runs" | "history" | "workflows" | "settings";
export const VIEWS: ReadonlyArray<{ name: ViewName; title: string }> = [
  { name: "runs", title: "Runs" },
  { name: "history", title: "History" },
  { name: "workflows", title: "Workflows" },
  { name: "settings", title: "Settings" },
];

/**
 * What is being looked at, which is what decides how much has to be read. Plain data,
 * and held by the bridge as one source: which View is showing and what is selected
 * decide what the producers read, so they are state rather than render-local signals.
 */
export interface Focus {
  view: ViewName;
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
  board: WorkspaceView;
  note: string | null;
  /** Every finished Run of this checkout, whatever session it came from. */
  history: RunRow[] | null;
  definitions: { workflows: DefinitionRow[]; errors: string[] } | null;
  settings: SettingsView | null;
  /** The selected Run, read from its directory. Null for any other Selection. */
  detail: RunDetail | null;
}

export type RowKind =
  | "agent"
  | "active"
  | "recent"
  | "history"
  | "definition"
  | "setting"
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
  title: string;
  detail: string;
  runId: string | null;
  agent: string | null;
  /** What this Run reviewed, so "review again" and the MR panel have their ref. */
  target: string | null;
  /** Whether this Run can supply the work for a fix round. */
  fixable: boolean;
  /** The Workflow or Persona this row names, for the Workflows view. */
  definition: DefinitionRow | null;
  /** The config key this row names, for the Settings view. */
  setting: { key: string; value: string; writable: boolean } | null;
  choice: PendingChoice | null;
}

/**
 * Everything a component may ask for, as plain data. The four at the bottom change what
 * is shown rather than what is true, so the bridge answers those itself; every other one
 * is a function in `src/operations.ts` that the CLI reaches too.
 */
export type Command =
  | { _tag: "FocusAgent"; agent: string }
  | { _tag: "StopRun"; runId: string }
  | { _tag: "OpenLog"; runId: string }
  | { _tag: "Answer"; runId: string; value: string }
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
  | { _tag: "OpenMr"; target: string }
  | { _tag: "RunWorkflow"; workflow: string }
  /**
   * Ask for a value, rather than write one. The app answers this itself by opening its
   * editor: an empty `SetDefault` used to stand in for "ask me first", which the
   * keyboard honoured and a click on the same button took literally — unsetting the
   * default it was labelled to set.
   */
  | { _tag: "EditSetting"; key: string }
  | { _tag: "SetDefault"; key: string; value: string }
  | { _tag: "OpenMode"; mode: Mode }
  | { _tag: "ShowView"; view: ViewName }
  /** Show or hide the selected Run's log tail inside the panel. */
  | { _tag: "ToggleTail" }
  /** Read another cap of the selected Run's review, for one that was cut short. */
  | { _tag: "MoreReview" }
  | { _tag: "Select"; id: string | null }
  | { _tag: "Refresh" }
  | { _tag: "Quit" };

/**
 * The commands the bridge answers itself; they never reach an operation. One list, read
 * both as a guard and as the type below, because a command added to one of those and not
 * the other is a command that quietly goes down the wrong lane.
 */
const FOCUS_ONLY = ["ShowView", "ToggleTail", "MoreReview", "Select", "Refresh", "Quit"] as const;

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
    sameViews(last.shown, next.shown) &&
    last.tail === next.tail &&
    last.reviewPages === next.reviewPages &&
    last.selected !== next.selected;
  return { reuse: !asked && movedOnly, forceMr: asked };
}

/** The fields every row shares, so each builder below only states what it differs in. */
const BLANK = {
  ago: "",
  key: null,
  glyph: " ",
  detail: "",
  runId: null,
  agent: null,
  target: null,
  fixable: false,
  definition: null,
  setting: null,
  choice: null,
} as const;

/**
 * One agent, under the run it works for. `connector` is what joins it to that run — the
 * last of a run's agents closes the group — and the run named by the row above it is not
 * named again here.
 */
function agentRow(a: AgentRow, connector: string): Row {
  return {
    ...BLANK,
    id: `agent:${a.agent}`,
    kind: "agent",
    // An agent's row is its live status, which herdr answers with no time attached.
    key: a.key === "" ? null : a.key,
    title: `${connector} ${a.name}`,
    detail: a.status,
    runId: a.run,
    agent: a.agent,
  };
}

/**
 * One agent in the trailing group. It has no run above it, so its own row is the only
 * place left to say which run it names.
 */
function orphanRow(a: AgentRow, connector: string): Row {
  return { ...agentRow(a, connector), detail: `${a.status} · ${a.run}` };
}

/**
 * One group of agents as rows: a run's own, or the orphans. `├` joins each to the group
 * and the last one closes it with `└`, which is the whole of the nesting — the list
 * itself stays flat.
 */
function agentGroup(
  agents: readonly AgentRow[],
  row: (a: AgentRow, connector: string) => Row,
): Row[] {
  return agents.map((a, at) => row(a, at === agents.length - 1 ? "└" : "├"));
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

function runRow(r: RunRow, now: number, kind: "active" | "recent" | "history"): Row {
  return {
    ...BLANK,
    id: `${RUN_ROW}${r.id}`,
    kind,
    ago: agoShort(r.at, now),
    glyph: r.glyph,
    title: r.title,
    detail: r.detail,
    runId: r.id,
    target: r.target,
    fixable: r.fixable,
    choice: r.choice,
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
export function rowsOf(board: WorkspaceView): Row[] {
  const rows: Row[] = [];
  const listed = new Set([...board.active, ...board.recent].map((r) => r.id));
  const under = (run: RunRow) => board.agents.filter((a) => a.run === run.id);
  for (const run of board.active) {
    rows.push(runRow(run, board.now, "active"), ...agentGroup(under(run), agentRow));
  }
  for (const run of board.recent) {
    rows.push(runRow(run, board.now, "recent"), ...agentGroup(under(run), agentRow));
  }
  const orphans = board.agents.filter((a) => !listed.has(a.run));
  if (orphans.length > 0) {
    rows.push(headerRow("agents with no run here"));
    rows.push(...agentGroup(orphans, orphanRow));
  }
  return rows;
}

/**
 * A name for the group of rows under it. Selectable, like every row, and inert. Short
 * enough to fit the title column, which is a share of the pane: a header clipped
 * mid-word says less than no header at all.
 */
function headerRow(title: string): Row {
  return { ...BLANK, id: `header:${title}`, kind: "header", title };
}

/**
 * The rows of whichever View is showing. One list region, one Selection, one filter, one
 * set of scroll keys — a second implementation per View is how they would drift apart.
 */
export function viewRows(state: AppState): Row[] {
  switch (state.view) {
    case "runs":
      return rowsOf(state.board);
    case "history":
      return (state.history ?? []).map((r) => runRow(r, state.board.now, "history"));
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
 */
export function actionsFor(row: Row | null): Action[] {
  if (!row) return [];
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
  } else if (row.fixable) {
    // Only for a run that has stopped: a fix round over a run still writing its own
    // review would build from half of it.
    actions.push({ key: "x", label: "fix what is open", command: { _tag: "FixFindings", runId } });
  }
  if (row.target) {
    actions.push({
      key: "a",
      label: "review again",
      command: { _tag: "ReviewAgain", target: row.target },
    });
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
        command: { _tag: "OpenMr", target: row.target },
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
  | { _tag: "Choice"; choice: PendingChoice }
  | { _tag: "Filter" }
  | { _tag: "Setting"; setting: { key: string; value: string } }
  | { _tag: "Board" };

/** Where the keyboard is, from what the tab has open. Pure, and the order is the point. */
export function keyboardOn(at: {
  /** A flow asking a question inline; it has handlers of its own. */
  flow: boolean;
  /** The selected run's pending question, where it has one. */
  choice: PendingChoice | null;
  /** Whether the cursor is in the filter, which outlives the text being kept. */
  filtering: boolean;
  /** A Settings row being given a new value. */
  setting: { key: string; value: string } | null;
}): Keyboarding {
  if (at.flow) return { _tag: "Flow" };
  if (at.choice) return { _tag: "Choice", choice: at.choice };
  if (at.filtering) return { _tag: "Filter" };
  if (at.setting) return { _tag: "Setting", setting: at.setting };
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
    (row, at) => hit.has(row.id) || (opensAGroup(row) && groupHasAMatch(rows, at, hit)),
  );
}

/** The two rows that have a group under them, which is what `rowsOf` puts there. */
const opensAGroup = (row: Row) => row.kind === "active" || row.kind === "header";

/** Whether an agent row under this one matched: the rows that follow it, until the next
 * row that opens a group of its own. */
function groupHasAMatch(rows: readonly Row[], at: number, hit: ReadonlySet<string>): boolean {
  for (const under of rows.slice(at + 1)) {
    if (under.kind !== "agent") return false;
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
