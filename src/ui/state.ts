// WARNING: nothing here imports effect or holds a runtime, so the components stay testable with plain data.
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import type { PendingChoice } from "../board";
import type { UsageReading } from "../usage-model";
import type { PickItem } from "../inputs";
import { GLYPH } from "../naming";
import { markFor, marksOf, NO_MARKS, worstOf, type Marks } from "../lines";
import { agoShort } from "../time";
import type { Mode } from "../flows";
import type { DefinitionRow, SettingsView } from "../views";
import { MAX_AGENTS, type AgentRow, type RunRow } from "../workspace";
import type { WideGroup, WideView, WorkspaceView } from "../workspace";
import type { Density } from "../settings";
import {
  type CardAction,
  cardActions,
  dispositionActions,
  primaryAction,
  type RunDetail,
  type TaskView,
} from "../board-model";
import { mrTarget } from "../mr";
import { disposeLabel, mrUrlOf, openMrLabel, readMrRef } from "../board-model";
import type { Live } from "../live";
import type { Selection } from "../selection";
import type { ArtefactCollection } from "../artefact-model";

export type ViewName = "runs" | "history" | "workflows" | "settings";
export type Filter =
  | { kind: "all" }
  | { kind: "workspace"; id: string }
  | { kind: "run"; id: string };

export function sessionLocal(filter: Filter) {
  return filter.kind !== "all";
}

export interface Focus {
  view: ViewName;
  filter: Filter;
  origin: string | null;
  previewing: string | null;
  shown: ReadonlyArray<ViewName>;
  selected: string | null;
  tail: boolean;
  artefacts?: boolean;
  reviewPages: number;
  // WARNING: a repeated focus must look new, so a repeated Refresh still reads.
  nonce: number;
}

export interface AppState {
  view: ViewName;
  filter: Filter;
  tasks: ReadonlyArray<TaskView>;
  now: number;
  density: Density;
  newer?: string | null;
  note: string | null;
  history: RunRow[] | null;
  definitions: { workflows: DefinitionRow[]; errors: string[] } | null;
  settings: SettingsView | null;
  detail: RunDetail | null;
  artefacts?: ArtefactCollection | null;
  artefactsError?: string | null;
  stopping: ReadonlyArray<string>;
  live: Live | null;
  previewing: string | null;
  usage?: ReadonlyArray<UsageReading>;
}

export type RowKind =
  | "agent"
  | "active"
  | "recent"
  | "history"
  | "definition"
  | "setting"
  | "group"
  | "header";

export interface Row {
  id: string;
  kind: RowKind;
  ago: string;
  key: string | null;
  glyph: string;
  marks: string;
  title: string;
  detail: string;
  runId: string | null;
  agent: string | null;
  target: string | null;
  fixable: boolean;
  needsYou: boolean;
  definition: DefinitionRow | null;
  setting: { key: string; value: string; writable: boolean; multiline: boolean } | null;
  choice: PendingChoice | null;
  jump: Jump | null;
  depth: number;
}

export type Jump = { label: string } & (
  | { kind: "workspace"; workspaceId: string }
  | { kind: "run"; runId: string }
  | { kind: "agent"; agent: string }
  | { kind: "none" }
);

export type Command =
  | { _tag: "FocusAgent"; agent: string }
  | { _tag: "StopRun"; runId: string }
  | { _tag: "HoldRun"; runId: string; set: boolean }
  | { _tag: "UndoStop" }
  | { _tag: "OpenLog"; runId: string }
  | { _tag: "OpenCheckOutput"; runId: string }
  // WARNING: the id makes it that Choice: a question replaced since it was drawn is a different question.
  | { _tag: "Answer"; runId: string; choiceId: string; value: string }
  | { _tag: "SendReview"; runId: string | null }
  | { _tag: "InvokeOffer"; runId: string; offer: string }
  | { _tag: "ChooseOffer"; runId: string }
  | { _tag: "PostReview"; runId: string }
  // WARNING: names the run too: glab resolves an unqualified mr:42 from the directory it runs in.
  | { _tag: "OpenMr"; target: string; runId: string | null }
  | { _tag: "ChooseMr"; copy: boolean; mrs: ReadonlyArray<MrChoice> }
  | { _tag: "CopyLink"; url: string }
  | { _tag: "RunWorkflow"; workflow: string }
  // WARNING: the hash travels with the id: consent is to this payload, not a summary of it.
  | { _tag: "ConfirmProposal"; id: string; hash: string }
  | { _tag: "DeclineProposal"; id: string; hash: string }
  // WARNING: asks for a value rather than writing one: an empty value would unset what the button was meant to set.
  | { _tag: "EditSetting"; key: string; multiline: boolean }
  | { _tag: "OpenRecord"; id: string }
  | { _tag: "OpenSteer"; id: string }
  | { _tag: "Steer"; runId: string; text: string }
  | { _tag: "ResumeRun"; runId: string }
  | { _tag: "AttachFiles"; runId: string }
  | { _tag: "FollowUp"; runId: string }
  | {
      _tag: "RecordDisposition";
      runId: string;
      kind: "merged" | "abandoned" | "superseded";
      ref: string;
    }
  | { _tag: "Acknowledge"; runId: string }
  | { _tag: "SeeArtefact"; runId: string; id: string; revision: number | null }
  | { _tag: "ToggleArtefacts" }
  | { _tag: "NextQuestion" }
  | { _tag: "SetDefault"; key: string; value: string }
  | { _tag: "OpenMode"; mode: Mode }
  | { _tag: "ShowView"; view: ViewName }
  | { _tag: "ShowOlder" }
  | { _tag: "ToggleTail" }
  | { _tag: "MoreReview" }
  | { _tag: "Select"; id: string | null; on: Selection | null }
  | { _tag: "Jump"; jump: Jump }
  | { _tag: "ToggleFilter" }
  | { _tag: "SetFilter"; filter: Filter }
  | { _tag: "Preview"; id: string | null }
  | { _tag: "Refresh" }
  | { _tag: "Quit" };

// WARNING: a command added to this list and not to the Command type goes down the wrong lane.
const FOCUS_ONLY = [
  "ShowView",
  "ShowOlder",
  "ToggleTail",
  "ToggleArtefacts",
  "MoreReview",
  "Select",
  "ToggleFilter",
  "SetFilter",
  "Preview",
  "Refresh",
  "Quit",
] as const;

export type FocusCommand = Extract<Command, { _tag: (typeof FOCUS_ONLY)[number] }>;

export function changesFocusOnly(command: Command): command is FocusCommand {
  return Arr.some(FOCUS_ONLY, (tag) => tag === command._tag);
}

export function retarget(at: Focus, command: FocusCommand) {
  switch (command._tag) {
    case "ShowView": {
      const returned: Focus = {
        ...at,
        view: command.view,
        shown: at.shown.includes(command.view) ? at.shown : [...at.shown, command.view],
      };
      return returned;
    }
    case "ToggleTail": {
      const returned: Focus = { ...at, tail: !at.tail };
      return returned;
    }
    case "ToggleArtefacts": {
      const returned: Focus = { ...at, artefacts: !at.artefacts };
      return returned;
    }
    case "ToggleFilter": {
      const returned: Focus = retarget(at, { _tag: "SetFilter", filter: widened(at) });
      return returned;
    }
    case "SetFilter": {
      const returned: Focus = { ...at, filter: command.filter, selected: null, previewing: null };
      return returned;
    }
    case "ShowOlder": {
      const returned: Focus = at.shown.includes("history")
        ? at
        : { ...at, shown: [...at.shown, "history"] };
      return returned;
    }
    case "Preview": {
      const returned: Focus = { ...at, previewing: command.id };
      return returned;
    }
    case "MoreReview": {
      const returned: Focus = { ...at, reviewPages: at.reviewPages + 1 };
      return returned;
    }
    case "Select": {
      const returned: Focus = { ...at, selected: command.id, reviewPages: 1 };
      return returned;
    }
    case "Refresh": {
      const returned: Focus = { ...at, nonce: at.nonce + 1 };
      return returned;
    }
    case "Quit": {
      const returned: Focus = at;
      return returned;
    }
  }
}

export interface Rereads {
  reuse: boolean;
  forceMr: boolean;
}

// WARNING: compared by contents: a copy of shown would turn every cursor move into a full re-read.
const sameViews = (a: ReadonlyArray<ViewName>, b: ReadonlyArray<ViewName>) =>
  a.length === b.length && Arr.every(a, (view, at) => view === b[at]);

// WARNING: a field added to Focus without a decision here re-reads every run directory on each cursor move.
export function rereads(last: Focus | null, next: Focus) {
  if (last === null) return { reuse: false, forceMr: false };
  const asked = last.nonce !== next.nonce;
  const movedOnly =
    last.view === next.view &&
    sameFilter(last.filter, next.filter) &&
    sameViews(last.shown, next.shown) &&
    last.tail === next.tail &&
    last.artefacts === next.artefacts &&
    last.reviewPages === next.reviewPages &&
    (last.selected !== next.selected || last.previewing !== next.previewing);
  return { reuse: !asked && movedOnly, forceMr: asked };
}

const sameFilter = (a: Filter, b: Filter) =>
  a.kind === b.kind && ("id" in a ? "id" in b && a.id === b.id : true);

function widened(at: Focus) {
  if (at.filter.kind !== "all" || at.origin === null) {
    const returned: Filter = { kind: "all" };
    return returned;
  }
  const returned: Filter = { kind: "workspace", id: at.origin };
  return returned;
}

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

function agentRow(a: AgentRow, connector: string, marks?: Marks) {
  const returned: Row = {
    ...BLANK,
    id: `agent:${a.agent}`,
    kind: "agent",
    marks: markFor(marks, a.run).override ? marksOf({ ...NO_MARKS, override: true }) : "",
    key: a.key === "" ? null : a.key,
    title: `${connector} ${a.name}`,
    detail: doingLine(a),
    runId: a.run,
    agent: a.agent,
    jump: { kind: "agent", agent: a.agent, label: a.name },
  };
  return returned;
}

function doingLine(a: AgentRow, ...rest: string[]) {
  return Arr.join(
    Arr.filter([a.status, a.now ?? "", ...rest], (part) => part !== ""),
    " · ",
  );
}

function orphanRow(a: AgentRow, connector: string, marks?: Marks) {
  return { ...agentRow(a, connector, marks), detail: doingLine(a, a.run) };
}

function agentGroup(
  agents: readonly AgentRow[],
  row: (a: AgentRow, connector: string, marks?: Marks) => Row,
  marks?: Marks,
) {
  return Arr.map(agents, (a, at) => row(a, at === agents.length - 1 ? "└" : "├", marks));
}

const RUN_ROW = "run:";

export function runIdOf(rowId: string | null) {
  return rowId !== null && pipe(rowId, Str.startsWith(RUN_ROW))
    ? pipe(rowId, Str.slice(RUN_ROW.length))
    : null;
}

export function runRowId(runId: string) {
  return `${RUN_ROW}${runId}`;
}

function runRow(r: RunRow, now: number, kind: "active" | "recent" | "history", marks?: Marks) {
  const returned: Row = {
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
    jump: kind === "history" ? null : { kind: "run", runId: r.id, label: r.title },
  };
  return returned;
}

function definitionRow(d: DefinitionRow) {
  const returned: Row = {
    ...BLANK,
    id: `workflow:${d.name}`,
    kind: "definition",
    glyph: d.problems.length > 0 ? GLYPH.failed : GLYPH.done,
    title: d.title || d.name,
    detail: Arr.join(
      Arr.filter(
        [`[${d.layer}]`, d.problems.length > 0 ? `${d.problems.length} problem(s)` : ""],
        (part) => part !== "",
      ),
      " · ",
    ),
    definition: d,
  };
  return returned;
}

// WARNING: id is given, not derived from the key: two rows share a key and must not share an id.
function settingRow(
  id: string,
  key: string,
  value: string,
  writable: boolean,
  shared?: string,
  multiline = false,
) {
  const shown = value === "" ? "(unset)" : value;
  const returned: Row = {
    ...BLANK,
    id: `setting:${id}`,
    kind: "setting",
    title: key,
    detail: shared === undefined ? shown : `${shown} · ${shared}`,
    setting: { key, value, writable, multiline },
  };
  return returned;
}

// WARNING: a finished Run keeps its agents: a hand-off outlives the Run it was started for.
export function rowsOf(board: WorkspaceView, marks?: Marks) {
  const rows: Row[] = [];
  const onBoard = [...board.active, ...board.recent];
  const byId = new Map(Arr.map(onBoard, (r) => [r.id, r]));
  const agentsOf = (run: RunRow) => Arr.filter(board.agents, (a) => a.run === run.id);
  const childrenOf = (run: RunRow) =>
    Arr.flatMap(run.children, (id) => Arr.ensure(byId.get(id) ?? []));
  const under: (run: RunRow, kind: "active" | "recent", depth?: number) => Row[] = (
    run: RunRow,
    kind: "active" | "recent",
    depth = 0,
  ) => [
    nested(runRow(run, board.now, kind, marks), depth),
    ...Arr.map(agentGroup(agentsOf(run), agentRow, marks), (a) => nested(a, depth)),
    ...Arr.flatMap(childrenOf(run), (child) =>
      under(child, board.active.includes(child) ? "active" : "recent", depth + 1),
    ),
  ];
  const nestedIds = new Set(Arr.flatMap(onBoard, (r) => r.children));
  const top = (runs: ReadonlyArray<RunRow>) => Arr.filter(runs, (run) => !nestedIds.has(run.id));
  const active = top(board.active);
  const waiting = Arr.filter(active, (r) => r.needsYou);
  if (waiting.length > 0) rows.push(headerRow(NEEDS_YOU));
  for (const run of [...waiting, ...Arr.filter(active, (r) => !r.needsYou)]) {
    rows.push(...under(run, "active"));
  }
  for (const run of top(board.recent)) {
    rows.push(...under(run, "recent"));
  }
  const orphans = Arr.filter(board.agents, (a) => !byId.has(a.run));
  if (orphans.length > 0) {
    rows.push(headerRow("agents with no run here"));
    rows.push(...agentGroup(orphans, orphanRow, marks));
  }
  return rows;
}

export function wideRows(wide: WideView, marks?: Marks) {
  const rows: Row[] = [];
  for (const [at, group] of wide.groups.entries()) {
    if (at > 0) rows.push(spacer(`gap:${group.workspaceId ?? ELSEWHERE}`));
    const away = group.workspaceId === null;
    const inGroup = [...group.active, ...group.recent];
    const byId = new Map(Arr.map(inGroup, (r) => [r.id, r]));
    const under: (run: RunRow, kind: "active" | "recent", depth?: number) => Row[] = (
      run: RunRow,
      kind: "active" | "recent",
      depth = 1,
    ) => {
      const row = runRow(run, wide.now, kind, marks);
      const children = Arr.getSomes(
        Arr.map(run.children, (id) => Option.fromUndefinedOr(byId.get(id))),
      );
      return [
        nested(away ? row : unqualified(row), depth),
        ...Arr.map(
          agentGroup(
            Arr.filter(group.agents, (a) => a.run === run.id),
            agentRow,
            marks,
          ),
          (agent) => nested(agent, depth + 1),
        ),
        ...Arr.flatMap(children, (child) =>
          under(child, group.active.includes(child) ? "active" : "recent", depth + 1),
        ),
      ];
    };
    const nestedIds = new Set(Arr.flatMap(inGroup, (r) => r.children));
    const top = (runs: ReadonlyArray<RunRow>) => Arr.filter(runs, (run) => !nestedIds.has(run.id));
    const atTop = top(group.active);
    const active = [
      ...Arr.filter(atTop, (r) => r.needsYou),
      ...Arr.filter(atTop, (r) => !r.needsYou),
    ];
    const inside = [
      groupRow(group, marks),
      ...Arr.flatMap(active, (r) => under(r, "active")),
      ...Arr.flatMap(top(group.recent), (r) => under(r, "recent")),
      ...Arr.map(
        agentGroup(
          Arr.filter(group.agents, (a) => !byId.has(a.run)),
          orphanRow,
          marks,
        ),
        (row) => nested(row, 1),
      ),
    ];
    rows.push(...(away ? Arr.map(inside, unreachable) : inside));
  }
  return keyedInOrder([...rows, ...quietRow(wide)]);
}

function keyedInOrder(rows: readonly Row[]) {
  let digit = 0;
  return Arr.map(rows, (row) => {
    if (row.kind !== "agent") return row;
    digit += 1;
    return { ...row, key: digit <= MAX_AGENTS ? String(digit) : null };
  });
}

const unreachable: (row: Row) => Row = (row) => ({
  ...row,
  jump: row.jump === null ? null : { kind: "none", label: row.jump.label },
});

const ELSEWHERE = "elsewhere";

const spacer: (id: string) => Row = (id) => ({ ...BLANK, id, kind: "header", title: "" });

function nested(row: Row, depth: number) {
  return { ...row, depth };
}

const unqualified = (row: Row) => ({ ...row, title: Str.split(row.title, " · ")[0]! });

// WARNING: no needsYou though counted: a workspace counted beside its own waiting run would read as two.
function groupRow(group: WideGroup, marks?: Marks) {
  const returned: Row = {
    ...BLANK,
    id: `group:${group.workspaceId ?? ELSEWHERE}`,
    kind: "group",
    glyph: group.glyph,
    marks: worstOf(Arr.map([...group.active, ...group.recent], (run) => markFor(marks, run.id))),
    title: group.label,
    detail: group.summary,
    jump: group.workspaceId
      ? { kind: "workspace", workspaceId: group.workspaceId, label: group.label }
      : { kind: "none", label: group.label },
  };
  return returned;
}

function quietRow(wide: WideView) {
  if (wide.quiet.length === 0) {
    const returned: Row[] = [];
    return returned;
  }
  const returned: Row[] = [
    spacer("gap:quiet"),
    {
      ...BLANK,
      id: "header:quiet",
      kind: "header",
      title: `${wide.quiet.length} more workspace(s)`,
      detail: `nothing of Collie's in them · ${Arr.join(wide.quiet, " · ")}`,
    },
  ];
  return returned;
}

export const NEEDS_YOU = "Needs you";

function headerRow(title: string) {
  const returned: Row = { ...BLANK, id: `header:${title}`, kind: "header", title };
  return returned;
}

export function needsYouStatus(rows: readonly Row[], selected: string | null) {
  const waiting = Arr.filter(rows, (row) => row.needsYou);
  if (waiting.length === 0 || Arr.some(waiting, (row) => row.id === selected)) return null;
  return `${waiting.length} run(s) need you`;
}

export function selectableRows(rows: readonly Row[]) {
  return Arr.filter(rows, (row) => row.kind !== "header");
}

interface RunRowsState {
  filter: Filter;
  board: WorkspaceView;
  wide: WideView | null;
  marks: Marks;
}

export function runsRows(state: RunRowsState) {
  const filter = state.filter;
  if (filter.kind === "run") return onlyRun(everyRow(state), filter.id);
  if (filter.kind === "workspace" && state.wide) {
    const group = Option.getOrUndefined(
      Arr.findFirst(state.wide.groups, (g) => g.workspaceId === filter.id),
    );
    if (!group) return rowsOf(state.board, state.marks);
    return wideRows({ ...state.wide, groups: [group], quiet: [] }, state.marks);
  }
  return everyRow(state);
}

function everyRow(state: RunRowsState) {
  return state.wide ? wideRows(state.wide, state.marks) : rowsOf(state.board, state.marks);
}

function onlyRun(rows: readonly Row[], runId: string) {
  const at = Option.getOrElse(
    Arr.findFirstIndex(rows, (row) => row.kind !== "agent" && row.runId === runId),
    () => -1,
  );
  if (at < 0) return [];
  const start = rows[at]!;
  const kept = [start];
  const mine = new Set([runId]);
  for (const row of rows.slice(at + 1)) {
    const nestedDeeper = row.depth > start.depth;
    const ofMine = row.runId !== null && mine.has(row.runId);
    if (!nestedDeeper && !(row.kind === "agent" && ofMine)) break;
    kept.push(row);
    if (row.kind !== "agent" && row.runId !== null) mine.add(row.runId);
  }
  return kept;
}

export function viewRows(state: AppState) {
  switch (state.view) {
    case "runs":
      return [];
    case "history":
      return Arr.map(state.history ?? [], (r) => runRow(r, state.now, "history"));
    case "workflows":
      return Arr.map(state.definitions?.workflows ?? [], definitionRow);
    case "settings": {
      const settings = state.settings;
      if (!settings) return [];
      return [
        ...Arr.map(settings.defaults, (d) =>
          settingRow(
            d.key,
            d.key,
            d.value,
            true,
            settings.flock === null ? undefined : `shared with the Flock by ${settings.flock}`,
            d.multiline,
          ),
        ),
        ...Arr.map(settings.remembered, (d) =>
          settingRow(`remembered:${d.key}`, d.key, d.value, false),
        ),
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

export function emptyStateOf(view: ViewName) {
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

export function clampSelection(
  selected: string | null,
  before: readonly Row[],
  after: readonly Row[],
) {
  if (after.length === 0) return null;
  if (selected !== null && Arr.some(after, (r) => r.id === selected)) return selected;
  const was =
    selected === null
      ? -1
      : Option.getOrElse(
          Arr.findFirstIndex(before, (r) => r.id === selected),
          () => -1,
        );
  return after[Math.min(Math.max(was, 0), after.length - 1)]!.id;
}

export interface Action {
  key: string;
  label: string;
  command: Command;
}

// WARNING: start, fix and review act on this workspace's checkout, so they are offered on a local board only.
export function actionsFor(row: Row | null, filter: Filter) {
  if (!row) {
    const returned: Action[] = [];
    return returned;
  }
  if (row.kind === "group") {
    const returned: Action[] = [];
    return returned;
  }
  if (row.kind === "agent") {
    const returned: Action[] =
      row.key && row.agent
        ? [{ key: row.key, label: "focus", command: { _tag: "FocusAgent", agent: row.agent } }]
        : [];
    return returned;
  }
  if (row.kind === "definition") {
    const definition = row.definition;
    if (!definition) {
      const returned: Action[] = [];
      return returned;
    }
    const returned: Action[] = [
      { key: "\r", label: "run", command: { _tag: "RunWorkflow", workflow: definition.name } },
    ];
    return returned;
  }
  if (row.kind === "setting") {
    const returned: Action[] = row.setting?.writable
      ? [
          {
            key: "\r",
            label: "set",
            command: {
              _tag: "EditSetting",
              key: row.setting.key,
              multiline: row.setting.multiline,
            },
          },
        ]
      : [];
    return returned;
  }

  const runId = row.runId;
  if (runId === null) {
    const returned: Action[] = [];
    return returned;
  }
  const actions: Action[] = [{ key: "l", label: "log", command: { _tag: "OpenLog", runId } }];
  if (row.kind === "active") {
    actions.push({ key: "k", label: "stop", command: { _tag: "StopRun", runId } });
  } else if (sessionLocal(filter)) {
    actions.push({ key: "x", label: "offers", command: { _tag: "ChooseOffer", runId } });
  }
  if (row.target) {
    if (pipe(row.target, Str.startsWith("mr:"))) {
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
  const returned: Action[] = actions;
  return returned;
}

// WARNING: the order is stated once: a flow's question, then the selected Run's, then the filter, then Settings, then the board.
export type Keyboarding =
  | { _tag: "Flow" }
  | { _tag: "Proposal"; proposal: { id: string; hash: string } }
  | { _tag: "Choice"; choice: PendingChoice }
  | { _tag: "Filter" }
  | { _tag: "Setting"; setting: { key: string; value: string } }
  | { _tag: "Board" };

export function keyboardOn(at: {
  flow: boolean;
  proposal?: { id: string; hash: string } | null;
  choice: PendingChoice | null;
  filtering: boolean;
  setting: { key: string; value: string } | null;
}) {
  if (at.flow) return { _tag: "Flow" };
  if (at.proposal) return { _tag: "Proposal", proposal: at.proposal };
  if (at.choice) return { _tag: "Choice", choice: at.choice };
  if (at.filtering) return { _tag: "Filter" };
  if (at.setting) return { _tag: "Setting", setting: at.setting };
  return { _tag: "Board" };
}

const PASTED = new TextDecoder();

export function pasteInto(value: string, bytes: Uint8Array) {
  return value + pipe(PASTED.decode(bytes), Str.replace(/\p{C}/gu, ""));
}

export function optionWindow<T>(items: readonly T[], at: number, room: number) {
  if (items.length <= room) return { shown: items, hidden: 0 };
  const end = Math.min(items.length, Math.max(room, at + 1));
  return { shown: items.slice(end - room, end), hidden: items.length - room };
}

export interface Windowed<T> {
  shown: readonly T[];
  hidden: number;
}

export interface MrChoice {
  readonly short: string;
  readonly target: string;
  readonly url: string | null;
  readonly runId: string | null;
}

export const mrChoices = (command: Extract<Command, { readonly _tag: "ChooseMr" }>) => {
  const usable = Arr.filter(command.mrs, (one) =>
    command.copy ? one.url !== null : readMrRef(one.target) !== null,
  );
  const shown = usable.length > 9 ? usable.slice(0, 8) : usable;
  const more: MenuItem[] =
    usable.length > 9
      ? [
          {
            key: "9",
            label: "More…",
            command: { _tag: "ChooseMr", copy: command.copy, mrs: usable.slice(8) },
          },
        ]
      : [];
  return [
    ...Arr.map(shown, (one, at) => {
      const key = String(at + 1);
      const ref = readMrRef(one.target);
      const returned: MenuItem =
        command.copy || ref === null
          ? {
              key,
              label: `Copy ${one.short}'s link`,
              command: { _tag: "CopyLink", url: one.url ?? "" },
            }
          : {
              key,
              label: openMrLabel(ref, false, one.short),
              command: { _tag: "OpenMr", target: one.target, runId: one.runId },
            };
      return returned;
    }),
    ...more,
  ];
};

export interface MenuItem {
  key: string;
  label: string;
  command: Command;
  disabled?: boolean;
}

function itemFor(view: TaskView, action: CardAction, primary: boolean) {
  const runId = view.run;
  switch (action.kind) {
    case "go-to-tab": {
      const returned: MenuItem = {
        key: "g",
        label: primary ? "Go to tab" : "Go to its tab",
        command: goToTab(view),
      };
      return returned;
    }
    case "steer": {
      const returned: MenuItem = {
        key: "s",
        label: "Steer…",
        command: { _tag: "OpenSteer", id: view.id },
      };
      return returned;
    }
    case "attach": {
      const returned: MenuItem = {
        key: "a",
        label: "Attach files…",
        command: { _tag: "AttachFiles", runId },
      };
      return returned;
    }
    case "open-mr": {
      const returned: MenuItem = {
        key: action.named === undefined ? "w" : "",
        label: openMrLabel(action.mr, primary, action.named),
        command: { _tag: "OpenMr", target: mrTarget(action.mr.project, action.mr.iid), runId },
      };
      return returned;
    }
    case "offer": {
      const returned: MenuItem = {
        key: primary || (view.offers?.length ?? 0) < 2 ? "i" : "",
        label: `${action.offer.title}${action.offer.unavailable === undefined ? "" : ` — ${action.offer.unavailable}`}`,
        disabled: action.offer.unavailable === undefined ? undefined : true,
        command: { _tag: "InvokeOffer", runId: action.offer.run ?? runId, offer: action.offer.id },
      };
      return returned;
    }
    case "check-output": {
      const returned: MenuItem = {
        key: "c",
        label: "Open check output",
        command: { _tag: "OpenCheckOutput", runId },
      };
      return returned;
    }
    case "offers": {
      const returned: MenuItem = {
        key: "o",
        label: "What it offers…",
        command: { _tag: "ChooseOffer", runId },
      };
      return returned;
    }
    case "resume": {
      const returned: MenuItem = {
        key: "u",
        label: primary ? "Resume" : "Resume run",
        command: { _tag: "ResumeRun", runId },
      };
      return returned;
    }
    case "follow-up": {
      const returned: MenuItem = {
        key: "x",
        label: "Follow-up run",
        command: { _tag: "FollowUp", runId },
      };
      return returned;
    }
    case "hold": {
      const returned: MenuItem = {
        key: "h",
        label: action.set ? "Hold run" : "Release hold",
        command: { _tag: "HoldRun", runId, set: action.set },
      };
      return returned;
    }
    case "stop": {
      const returned: MenuItem = {
        key: "k",
        label: "Stop run",
        command: { _tag: "StopRun", runId },
      };
      return returned;
    }
    case "dispose": {
      const returned: MenuItem = {
        key: action.named === undefined ? DISPOSITION_KEYS[action.disposition] : "",
        label: disposeLabel(action),
        command: { _tag: "RecordDisposition", runId, kind: action.disposition, ref: action.ref },
      };
      return returned;
    }
    case "acknowledge": {
      const returned: MenuItem = {
        key: "",
        label: "Acknowledge",
        command: { _tag: "Acknowledge", runId },
      };
      return returned;
    }
  }
}

const DISPOSITION_KEYS = { merged: "M", abandoned: "A", superseded: "S" } as const;

export function primaryFor(view: TaskView) {
  const action = primaryAction(view);
  return action === null ? null : itemFor(view, action, true);
}

export function menuFor(view: TaskView) {
  const actions = cardActions(view);
  const mrs = Arr.flatMap(actions, (action) =>
    action.kind === "open-mr" && action.named !== undefined
      ? [
          {
            short: action.named,
            target: mrTarget(action.mr.project, action.mr.iid),
            url: mrUrlOf(action.mr),
            runId: view.run,
          },
        ]
      : [],
  );
  const returned: MenuItem[] = [
    { key: "enter", label: "Open record", command: { _tag: "OpenRecord", id: view.id } },
    ...Arr.map(actions, (action) => itemFor(view, action, false)),
    ...(mrs.length < 2
      ? []
      : [
          {
            key: "w",
            label: "Open a merge request…",
            command: { _tag: "ChooseMr", copy: false, mrs } as const,
          },
          {
            key: "y",
            label: "Copy a merge request's link…",
            command: { _tag: "ChooseMr", copy: true, mrs } as const,
          },
        ]),
  ];
  return returned;
}

export function dispositionsFor(view: TaskView) {
  return Arr.map(dispositionActions(view), (action) => itemFor(view, action, false));
}

export interface Older {
  rows: ReadonlyArray<RunRow>;
  more: boolean;
}

const OLDER_BATCH = 10;

export function olderFinished(
  history: ReadonlyArray<RunRow> | null,
  finished: ReadonlyArray<TaskView>,
  pages: number,
  batch = OLDER_BATCH,
) {
  if (history === null) return { rows: [], more: true };
  const carded = new Set(Arr.flatMap(finished, (view) => view.runs));
  const rest = Arr.filter(history, (row) => !carded.has(row.id));
  const rows = rest.slice(0, pages * batch);
  return { rows, more: rows.length < rest.length };
}

export function goToTab(view: TaskView) {
  const returned: Command = {
    _tag: "Jump",
    jump: { kind: "run", runId: view.run, label: view.name },
  };
  return returned;
}

export const ALL_KEYS: ReadonlyArray<{ key: string; what: string }> = [
  { key: "Tab", what: "The board, the record over it, then ≡" },
  { key: "/", what: "Search, and narrow all three sections" },
  { key: "Esc", what: "Close the record, then clear the search" },
  { key: "m", what: "Read more of a cut-short review or plan" },
  { key: "r", what: "Re-read what is on screen" },
  { key: "?", what: "This list; any key closes it" },
  { key: "q", what: "Close the tab" },
  { key: "↑↓", what: "Choose a menu item" },
  { key: "enter", what: "Open record, or select the chosen menu item" },
  { key: "g", what: "Go to its tab" },
  { key: "s", what: "Steer…" },
  { key: "a", what: "Attach files…" },
  { key: "w", what: "Open merge request" },
  { key: "y", what: "Copy a merge request's link, on a card of several" },
  { key: "u", what: "Resume run" },
  { key: "o", what: "What its workflow offers next" },
  { key: "i", what: "The first of those, on a plan that is ready" },
  { key: "x", what: "Follow-up run" },
  { key: "h", what: "Hold run, or release its hold" },
  { key: "k", what: "Stop run" },
];

const globalKeys = (filter: Filter) => [
  `g ${sessionLocal(filter) ? "all" : "local"}`,
  ...(sessionLocal(filter) ? ["p run"] : []),
  "? keys",
  "q close",
];

export function footerKeys(opts: {
  panel: ReadonlyArray<string>;
  on: Keyboarding;
  filter: Filter;
}) {
  if (opts.on._tag === "Choice") return "↑↓ move · Enter choose · Esc leave the run open";
  if (opts.on._tag === "Setting") return "type a value · Enter set it · Esc leave it";
  // WARNING: the filter takes keys too, so the board's own keys would be a lie here.
  if (opts.on._tag === "Filter") return "type to narrow · Enter keep it · Esc drop it";
  if (opts.on._tag === "Proposal") return "Enter carry it out · Esc decline it";
  return Arr.join([...opts.panel, ...globalKeys(opts.filter)], " · ");
}

export interface Keypress {
  sequence: string;
  name?: string;
  shift?: boolean;
  ctrl?: boolean;
  meta?: boolean;
}

export interface KeyContext {
  view: ViewName;
  filter: Filter;
  on: Keyboarding;
  helping: boolean;
  asking: Asking;
  query: string;
  scrollable: boolean;
  row: Row | null;
  rows: readonly Row[];
  cutShort: boolean;
  mrs: ReadonlyArray<MrChoice>;
}

export type KeyIntent =
  | { _tag: "Help"; open: boolean }
  | { _tag: "Answered"; asking: Asking; value: string | null }
  | { _tag: "Filtering"; filter: string; typing: boolean }
  | { _tag: "Editing"; editing: { key: string; value: string } | null }
  | { _tag: "Submitted"; command: Command }
  | { _tag: "NextQuestion" }
  | { _tag: "Move"; by: -1 | 1 }
  | { _tag: "ShowViewBy"; by: -1 | 1 }
  | { _tag: "Scroll"; by: -1 | 1; unit: "line" | "page" }
  | { _tag: "Copy"; text: string }
  | { _tag: "Do"; command: Command };

const PRINTABLE = /^[\u0020-\u007e]$/;

const NEXT_QUESTION = "n";

function takesText(on: Keyboarding) {
  if (on._tag === "Filter" || on._tag === "Setting") return true;
  return on._tag === "Choice" && on.choice.kind === "ask";
}

export function nextQuestionId(rows: readonly Row[], selected: string | null) {
  const list = selectableRows(rows);
  const at = Option.getOrElse(
    Arr.findFirstIndex(list, (row) => row.id === selected),
    () => -1,
  );
  const from = at < 0 ? -1 : at;
  for (let step = 1; step <= list.length; step++) {
    const row = list[(from + step + list.length) % list.length]!;
    if (row.choice) return row.id;
  }
  return null;
}

const SESSION_MODES = new Map<string, Mode>([
  ["p", "pick"],
  ["C", "continue"],
  ["u", "resume"],
  ["f", "fork"],
]);

const doing: (command: Command) => KeyIntent = (command) => ({ _tag: "Do", command });

export function keyIntent(at: KeyContext, key: Keypress) {
  // WARNING: any key closes the overlay and does nothing else; first, since App draws it over the flow.
  if (at.helping) return { _tag: "Help", open: false };
  // WARNING: a flow owns the keyboard; a key that moved the Selection would act on a board nobody sees.
  if (at.on._tag === "Flow") return null;
  // WARNING: a human consenting must not stop a run by pressing k: only yes and no are answers.
  if (at.on._tag === "Proposal") {
    const { id, hash } = at.on.proposal;
    if (key.name === "return") return doing({ _tag: "ConfirmProposal", id, hash });
    if (key.name === "escape") return doing({ _tag: "DeclineProposal", id, hash });
    return null;
  }
  if (key.sequence === NEXT_QUESTION && !takesText(at.on)) return { _tag: "NextQuestion" };
  if (at.on._tag === "Choice") {
    const next = answerFor(at.on.choice, at.asking, key.sequence);
    return { _tag: "Answered", asking: next.asking, value: next.value };
  }
  if (at.on._tag === "Filter") {
    if (key.name === "escape") return { _tag: "Filtering", filter: "", typing: false };
    if (key.name === "return") return { _tag: "Filtering", filter: at.query, typing: false };
    if (key.name === "backspace") {
      return { _tag: "Filtering", filter: pipe(at.query, Str.slice(0, -1)), typing: true };
    }
    if (PRINTABLE.test(key.sequence)) {
      return { _tag: "Filtering", filter: at.query + key.sequence, typing: true };
    }
    return null;
  }
  if (at.on._tag === "Setting") {
    const editing = at.on.setting;
    if (key.name === "escape") return { _tag: "Editing", editing: null };
    if (key.name === "return") {
      const command: Command = { _tag: "SetDefault", key: editing.key, value: editing.value };
      return { _tag: "Submitted", command };
    }
    if (key.name === "backspace") {
      return {
        _tag: "Editing",
        editing: { ...editing, value: pipe(editing.value, Str.slice(0, -1)) },
      };
    }
    if (PRINTABLE.test(key.sequence)) {
      return { _tag: "Editing", editing: { ...editing, value: editing.value + key.sequence } };
    }
    return null;
  }
  if (key.name === "escape" && at.query !== "") {
    return { _tag: "Filtering", filter: "", typing: false };
  }
  if (key.name === "escape") return doing({ _tag: "SetFilter", filter: { kind: "all" } });
  // WARNING: after everything that takes text: a free-text answer must be able to contain a question mark.
  if (key.sequence === "?") return { _tag: "Help", open: true };
  if (at.scrollable) {
    if (key.name === "pageup") return { _tag: "Scroll", by: -1, unit: "page" };
    if (key.name === "pagedown") return { _tag: "Scroll", by: 1, unit: "page" };
    if (key.shift && key.name === "up") return { _tag: "Scroll", by: -1, unit: "line" };
    if (key.shift && key.name === "down") return { _tag: "Scroll", by: 1, unit: "line" };
  }
  // WARNING: arrows, not hjkl: k is the stop key, and a destructive key that sometimes means up is worse than none.
  if (key.name === "up") return { _tag: "Move", by: -1 };
  if (key.name === "down") return { _tag: "Move", by: 1 };
  if (key.name === "tab") return { _tag: "ShowViewBy", by: key.shift ? -1 : 1 };
  if (key.sequence === "/") return { _tag: "Filtering", filter: at.query, typing: true };
  if (key.sequence === "R") return doing({ _tag: "Refresh" });
  if (key.sequence === "t") return at.row?.runId ? doing({ _tag: "ToggleTail" }) : null;
  if (key.sequence === "m") return at.cutShort ? doing({ _tag: "MoreReview" }) : null;
  if (key.sequence === "c") {
    if (at.mrs.length > 1) return doing({ _tag: "ChooseMr", copy: true, mrs: at.mrs });
    const url = at.mrs[0]?.url ?? null;
    return url !== null ? { _tag: "Copy", text: url } : null;
  }
  if (key.name === "q" || (key.ctrl && key.name === "c")) return doing({ _tag: "Quit" });
  if (/^[1-9]$/.test(key.sequence)) {
    const agent = Option.getOrUndefined(
      Arr.findFirst(at.rows, (r) => r.kind === "agent" && r.key === key.sequence),
    );
    return agent?.agent ? doing({ _tag: "FocusAgent", agent: agent.agent }) : null;
  }
  if (key.sequence === "g") return at.view === "runs" ? doing({ _tag: "ToggleFilter" }) : null;
  if (sessionLocal(at.filter)) {
    const mode = SESSION_MODES.get(key.sequence);
    if (mode) return doing({ _tag: "OpenMode", mode });
    if (key.sequence === "s") return doing({ _tag: "SendReview", runId: at.row?.runId ?? null });
  }
  if (key.name === "return" && at.row?.kind === "group" && at.row.jump?.kind === "workspace") {
    return doing({ _tag: "SetFilter", filter: { kind: "workspace", id: at.row.jump.workspaceId } });
  }
  if (key.name === "return" && at.row?.jump) return doing({ _tag: "Jump", jump: at.row.jump });
  const action = Option.getOrUndefined(
    Arr.findFirst(
      actionsFor(at.row, at.filter),
      (a) => a.key === (key.name === "return" ? "\r" : key.sequence),
    ),
  );
  return action ? doing(action.command) : null;
}

export interface Asking {
  index: number;
  typed: string;
}

export interface Answered {
  asking: Asking;
  value: string | null;
}

export function answerFor(choice: PendingChoice, asking: Asking, key: string) {
  if (key === "\u001b" || key === "\u0003") return { asking, value: "" };
  if (key === "\r" || key === "\n") {
    const value = choice.kind === "ask" ? asking.typed : (choice.items[asking.index]?.id ?? null);
    return { asking: { index: 0, typed: "" }, value };
  }
  if (choice.kind === "ask") {
    if (key === "\u007f" || key === "\b") {
      return { asking: { ...asking, typed: pipe(asking.typed, Str.slice(0, -1)) }, value: null };
    }
    if (/^[\u0020-\u007e]$/.test(key)) {
      return { asking: { ...asking, typed: asking.typed + key }, value: null };
    }
    return { asking, value: null };
  }
  if (key === "\u001b[A") {
    return { asking: { ...asking, index: Math.max(0, asking.index - 1) }, value: null };
  }
  if (key === "\u001b[B") {
    const last = Math.max(0, choice.items.length - 1);
    return { asking: { ...asking, index: Math.min(last, asking.index + 1) }, value: null };
  }
  return { asking, value: null };
}

export function statusColour(glyph: string) {
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

function subsequence(needle: string, hay: string) {
  let at = 0;
  for (const character of hay) {
    if (character === needle[at]) at += 1;
    if (at === needle.length) return true;
  }
  return needle.length === 0;
}

export function filterItems<T>(items: readonly T[], query: string, hay: (item: T) => string) {
  const needle = Str.toLowerCase(Str.trim(query));
  if (needle === "") return [...items];
  const prefix: T[] = [];
  const anywhere: T[] = [];
  const fuzzy: T[] = [];
  for (const item of items) {
    const straw = Str.toLowerCase(hay(item));
    if (pipe(straw, Str.startsWith(needle))) prefix.push(item);
    else if (pipe(straw, Str.includes(needle))) anywhere.push(item);
    else if (subsequence(needle, straw)) fuzzy.push(item);
  }
  return [...prefix, ...anywhere, ...fuzzy];
}

export function matching(rows: readonly Row[], query: string) {
  if (Str.trim(query) === "") return [...rows];
  const looked = Arr.filter(rows, (row) => row.kind !== "header");
  const hit = new Set(Arr.map(filterItems(looked, query, rowHay), (row) => row.id));
  return Arr.filter(
    rows,
    (row, at) =>
      hit.has(row.id) ||
      (opensAGroup(row) && groupHasAMatch(rows, at, hit)) ||
      underAMatch(rows, at, hit),
  );
}

function underAMatch(rows: readonly Row[], at: number, hit: ReadonlySet<string>) {
  let depth = rows[at]!.depth;
  for (let above = at - 1; above >= 0 && depth > 0; above--) {
    const over = rows[above]!;
    if (over.depth >= depth) continue;
    if (hit.has(over.id)) return true;
    depth = over.depth;
  }
  return false;
}

const opensAGroup = (row: Row) =>
  row.kind === "active" || row.kind === "recent" || row.kind === "header" || row.kind === "group";

function groupHasAMatch(rows: readonly Row[], at: number, hit: ReadonlySet<string>) {
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

export function rowHay(row: Row) {
  return `${row.title} ${row.detail}`;
}

export function itemHay(item: PickItem) {
  return `${item.id} ${item.title} ${item.subtitle ?? ""}`;
}
