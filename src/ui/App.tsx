// The Collie tab. Four regions — nav rail, list, detail, footer — over one Selection.
// Everything this file reads is the plain `AppState` the bridge pushes in, and
// everything it does is a plain `Command` dispatched back out: it imports no Effect and
// holds no runtime, which is what makes it testable with `testRender` and plain data.

import { createMemo, createSignal, createEffect, untrack, For, Show } from "solid-js";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { onBlur, onFocus, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import {
  actionsFor,
  answerFor,
  clampSelection,
  detailFor,
  emptyStateOf,
  keyboardOn,
  matching,
  optionWindow,
  statusColour,
  viewRows,
  VIEWS,
  type Action,
  type AppState,
  type Asking,
  type Command,
  type Keyboarding,
  type Row,
  type ViewName,
} from "./state";
import { commitsBehind } from "../workspace";
import { Detail } from "./detail";
import { usePasteInto } from "./paste";
import { Flow } from "./Flow";
import type { Pending } from "./prompts";

/**
 * Below this the detail cannot be a column and stays out of the way as a full-width
 * overlay instead. A Collie tab split beside an editor is around 60 columns, and a
 * 30-column list next to a 30-column detail is two unreadable columns rather than one
 * readable one.
 */
const DETAIL_COLUMN_MIN = 72;

/**
 * Rows the Selection's buttons get. Two, because a finished merge-request run offers
 * five of them and they do not fit one line of the 60 columns a Collie tab beside an
 * editor has — and a button clipped in half is an action offered nowhere, since the
 * footer's key list stopped repeating them when they moved here.
 */
const ACTION_ROWS = 2;

/** Rows the key list gets: it runs to two lines at the widths a Collie tab is opened at. */
const KEY_ROWS = 2;

/**
 * The footer's own rows — its border, its buttons, its keys and what the tab last said.
 * Summed rather than stated, because a footer whose box and whose children disagree clips
 * one of them, and it is what a question is anchored above.
 */
const FOOTER_HEIGHT = 2 + ACTION_ROWS + KEY_ROWS + 1;

/** A question's border, its header and its footer: what it costs before its options. */
const QUESTION_CHROME = 4;

const DIM = "#8a8a8a";
const ACCENT = "#7aa2f7";

export interface AppProps {
  state: () => AppState;
  /**
   * A question a flow running inline is waiting on. The popup renders the same component
   * as its whole screen; here it is an overlay over the board that asked for it.
   */
  pending?: () => Pending | null;
  dispatch: (command: Command) => void;
}

export function App(props: AppProps) {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const [selected, setSelected] = createSignal<string | null>(null);
  // The filter survives leaving the keyboard in it — `/` narrows the list so a row can
  // then be acted on, so Enter stops typing and keeps the text; only Esc drops it.
  const [filter, setFilter] = createSignal("");
  const [typing, setTyping] = createSignal(false);
  const [asking, setAsking] = createSignal<Asking>({ index: 0, typed: "" });
  const [editingKey, setEditing] = createSignal<{ key: string; value: string } | null>(null);

  /**
   * Mouse reporting only while the pane has focus. herdr is a multiplexer: with mouse
   * on, clicking anywhere in the terminal is delivered here instead of starting a text
   * selection, so the human loses copy-and-paste in every other pane.
   */
  onFocus(() => {
    renderer.useMouse = true;
  });
  onBlur(() => {
    renderer.useMouse = false;
  });

  const all = createMemo(() => viewRows(props.state()));
  // `matching`, not a plain filter: the rows are nested by the time they get here, so a
  // run whose agent matched has to come with it and the board's order has to survive.
  const rows = createMemo(() => matching(all(), filter()));

  // Clamped against the list as it was, so a run finishing under the cursor leaves the
  // row that took its place selected rather than jumping to the top.
  let previous: Row[] = [];
  createEffect(() => {
    const next = rows();
    setSelected(clampSelection(untrack(selected), previous, next));
    previous = next;
  });

  // What is selected decides what the producers read, so a change in it is dispatched
  // rather than kept here: that is what fills the detail panel and fetches the one
  // merge request the Selection points at.
  let told: string | null = null;
  createEffect(() => {
    const id = selected();
    if (id === told) return;
    told = id;
    props.dispatch({ _tag: "Select", id });
  });

  const current = (): Row | null => rows().find((r) => r.id === selected()) ?? null;
  const detail = () => detailFor(props.state(), current());
  /** Whether the review on screen was cut short, which is the only thing `m` can act on. */
  const cutShort = () => {
    const review = detail()?.review;
    return review?._tag === "Text" && review.truncated;
  };
  /**
   * The detail panel's own keys. They act on the selected Run's detail, so they are
   * offered only where there is one and only where there is something in it to act on —
   * `t` on a Settings row used to arm tailing for whatever Run was selected next, and `m`
   * re-read a review that was not cut short.
   */
  const panelKeys = () => [
    ...(current()?.runId ? ["t log tail"] : []),
    ...(cutShort() ? ["m more review"] : []),
  ];
  // The question belongs to the selected run, so a second waiting run is answerable
  // by selecting it — the board used to answer only the first one asking.
  const question = () => current()?.choice ?? null;

  const move = (by: number) => {
    const list = rows();
    if (list.length === 0) return;
    const at = list.findIndex((r) => r.id === selected());
    setSelected(list[Math.min(list.length - 1, Math.max(0, at + by))]!.id);
  };

  const answer = (value: string) => {
    const row = current();
    if (row?.runId) props.dispatch({ _tag: "Answer", runId: row.runId, value });
    setAsking({ index: 0, typed: "" });
  };

  const showView = (by: number) => {
    const at = VIEWS.findIndex((v) => v.name === props.state().view);
    props.dispatch({
      _tag: "ShowView",
      view: VIEWS[(at + by + VIEWS.length) % VIEWS.length]!.name,
    });
  };

  const flow = () => props.pending?.() ?? null;

  /**
   * Everything a row or the footer asks for goes through here. `EditSetting` is the
   * app's own — it opens the editor rather than writing anything — and every other
   * command goes to the bridge. One path, so a click and a key cannot mean different
   * things: they used to, and the click unset the default it offered to set.
   */
  const act = (command: Command) => {
    if (command._tag === "EditSetting") {
      const row = rows().find((r) => r.setting?.key === command.key);
      if (row?.setting) setEditing({ key: row.setting.key, value: row.setting.value });
      return;
    }
    props.dispatch(command);
  };

  /**
   * Who has the keyboard, as one value the keys, a paste and the footer all read. They
   * each used to decide it again from the same four signals, in an order written out by
   * hand three times — and a paste that disagreed went into a field nobody was looking at.
   */
  const keyboard = createMemo<Keyboarding>(() =>
    keyboardOn({
      flow: flow() !== null,
      choice: question(),
      filtering: typing(),
      setting: editingKey(),
    }),
  );

  /** A paste is typing, so it goes to whichever field the keyboard is on. */
  usePasteInto((append) => {
    const at = keyboard();
    if (at._tag === "Choice" && at.choice.kind === "ask") {
      return setAsking((was) => ({ ...was, typed: append(was.typed) }));
    }
    if (at._tag === "Filter") return setFilter(append);
    if (at._tag === "Setting") setEditing({ ...at.setting, value: append(at.setting.value) });
  });

  useKeyboard((key) => {
    const at = keyboard();
    // A flow asking a question owns the keyboard: `Flow` has its own handler, and a key
    // that also moved the Selection underneath would act on a board nobody is looking at.
    if (at._tag === "Flow") return;
    if (at._tag === "Choice") {
      const next = answerFor(at.choice, asking(), key.sequence);
      setAsking(next.asking);
      if (next.value !== null) answer(next.value);
      return;
    }
    if (at._tag === "Filter") {
      if (key.name === "escape") {
        setFilter("");
        return setTyping(false);
      }
      if (key.name === "return") return setTyping(false);
      if (key.name === "backspace") return setFilter(filter().slice(0, -1));
      if (/^[\x20-\x7e]$/.test(key.sequence)) return setFilter(filter() + key.sequence);
      return;
    }
    // A Settings row being given a new value: every key belongs to that until it is
    // sent or abandoned, the same rule a pending question follows.
    if (at._tag === "Setting") {
      const editing = at.setting;
      if (key.name === "escape") return setEditing(null);
      if (key.name === "return") {
        props.dispatch({ _tag: "SetDefault", key: editing.key, value: editing.value });
        return setEditing(null);
      }
      if (key.name === "backspace") {
        return setEditing({ ...editing, value: editing.value.slice(0, -1) });
      }
      if (/^[\x20-\x7e]$/.test(key.sequence)) {
        return setEditing({ ...editing, value: editing.value + key.sequence });
      }
      return;
    }
    // Arrows, and not `hjkl`: `k` is the stop key the board has always had and the one
    // the footer offers, and a destructive key that sometimes means "up" instead is
    // worse than no vim binding.
    if (key.name === "up") return move(-1);
    if (key.name === "down") return move(1);
    if (key.name === "tab") return showView(key.shift ? -1 : 1);
    if (key.sequence === "/") return setTyping(true);
    // Re-reading what is on screen, and the one merge request behind it: a cached read
    // is what makes selecting cheap, so there has to be a way to say "ask again".
    if (key.sequence === "R") return props.dispatch({ _tag: "Refresh" });
    // The log, in the panel: `l` still opens it in a pane, because grepping and copying
    // belong in one.
    if (key.sequence === "t") {
      if (current()?.runId) props.dispatch({ _tag: "ToggleTail" });
      return;
    }
    // The rest of a review the panel cut short, a cap at a time: the log tail says
    // nothing about review.md, so paging it is the only way to read it here.
    if (key.sequence === "m") {
      if (cutShort()) props.dispatch({ _tag: "MoreReview" });
      return;
    }
    const mr = detail()?.mr;
    if (key.sequence === "c" && mr?._tag === "Details") {
      renderer.copyToClipboardOSC52(mr.url);
      return;
    }
    if (key.name === "q" || (key.ctrl && key.name === "c")) {
      return props.dispatch({ _tag: "Quit" });
    }
    // A digit focuses that agent wherever the Selection is: those keys are the board's
    // shortcut into a pane, not an action on a row.
    if (/^[1-9]$/.test(key.sequence)) {
      const agent = all().find((r) => r.kind === "agent" && r.key === key.sequence);
      if (agent?.agent) props.dispatch({ _tag: "FocusAgent", agent: agent.agent });
      return;
    }
    if (key.sequence === "p") return props.dispatch({ _tag: "OpenMode", mode: "pick" });
    if (key.sequence === "u") return props.dispatch({ _tag: "OpenMode", mode: "resume" });
    if (key.sequence === "f") return props.dispatch({ _tag: "OpenMode", mode: "fork" });
    // The Selection, like every other action: `s` on a row hands off that row's review.
    if (key.sequence === "s") {
      return props.dispatch({ _tag: "SendReview", runId: current()?.runId ?? null });
    }
    const action = actionsFor(current()).find(
      (a) => a.key === (key.name === "return" ? "\r" : key.sequence),
    );
    if (action) act(action.command);
  });

  const detailAsColumn = () => dimensions().width >= DETAIL_COLUMN_MIN;

  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      {/* The launch flow, inline: the same component the popup pane draws. */}
      <Show when={flow()}>
        <Flow pending={flow()!} />
      </Show>
      <Show when={flow() === null}>
        <Nav
          view={props.state().view}
          repo={props.state().board.repo}
          behind={props.state().board.behind}
          onShow={(view) => props.dispatch({ _tag: "ShowView", view })}
          onNewRun={() => props.dispatch({ _tag: "OpenMode", mode: "pick" })}
        />
      </Show>
      <box style={{ flexDirection: "row", flexGrow: 1 }}>
        <List
          title={VIEWS.find((v) => v.name === props.state().view)!.title}
          rows={rows()}
          empty={filter() === "" ? emptyStateOf(props.state().view) : "nothing matches"}
          selected={selected()}
          onSelect={setSelected}
        />
        <Show when={detailAsColumn()}>
          <Detail
            row={current()}
            detail={detail()}
            cwd={props.state().board.cwd}
            overlay={false}
            dispatch={props.dispatch}
          />
        </Show>
      </box>
      <Show when={!detailAsColumn()}>
        <Detail
          row={current()}
          detail={detail()}
          cwd={props.state().board.cwd}
          overlay
          dispatch={props.dispatch}
        />
      </Show>
      {/* Over the bottom of the list, not among its rows and not beside them: a question
          spliced between rows moved every row below the one asking, and a region that
          took rows from the list changed how much of it there was to look at. Drawn on
          top, so the list's own share of the pane is the same whether or not a Run is
          asking anything. */}
      <Show when={question()}>
        <Question choice={question()!} asking={asking()} dispatch={props.dispatch} />
      </Show>
      <Footer
        row={current()}
        dispatch={act}
        on={keyboard()}
        panel={panelKeys()}
        note={props.state().note}
        filter={filter()}
        matched={filter() === "" ? null : rows().length}
      />
    </box>
  );
}

/**
 * The nav names every View and switches between them: clicking one asks for it, and so
 * does `Tab`. The one showing is bright, the rest dim.
 */
function Nav(props: {
  view: ViewName;
  repo: string;
  /** How far behind its remote this installation is, where that is worth saying. */
  behind: number | null;
  onShow: (view: ViewName) => void;
  onNewRun: () => void;
}) {
  return (
    <box style={{ flexDirection: "row", height: 1 }}>
      <text fg={ACCENT}>{`\u{1F415} ${props.repo}  `}</text>
      <For each={VIEWS}>
        {(v) => (
          <text
            fg={v.name === props.view ? "#ffffff" : DIM}
            onMouseDown={() => props.onShow(v.name)}
          >
            {v.name === props.view ? `[${v.title}] ` : `${v.title} `}
          </text>
        )}
      </For>
      {/* The launch flow, without a popup: `p` does the same thing from the keyboard. */}
      <text fg={ACCENT} onMouseDown={() => props.onNewRun()}>
        {"  ＋ New run"}
      </text>
      {/* Shown, never sent: being a few commits behind is worth seeing here and not
          worth interrupting anyone for. */}
      <Show when={(props.behind ?? 0) > 0}>
        <text fg={DIM}>{`  ${commitsBehind(props.behind!)} · collie upgrade`}</text>
      </Show>
    </box>
  );
}

function List(props: {
  title: string;
  empty: string;
  rows: readonly Row[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const [region, setRegion] = createSignal<ScrollBoxRenderable>();
  // Arrows move the Selection, and a Selection the region has scrolled past is one the
  // human cannot see acting on keys they can still press. Each row carries its id so
  // the region can be asked to bring exactly that one back into view.
  createEffect(() => {
    const id = props.selected;
    if (id !== null && props.rows.some((r) => r.id === id)) region()?.scrollChildIntoView(id);
  });
  return (
    <scrollbox
      ref={setRegion}
      title={props.title}
      border
      borderColor={DIM}
      style={{ flexGrow: 1, flexDirection: "column" }}
    >
      {/* An empty View that says nothing is a dead end, so it says what to do. */}
      <Show when={props.rows.length > 0} fallback={<text fg={DIM}>{props.empty}</text>}>
        <For each={props.rows}>
          {(row) => (
            <RowLine row={row} selected={row.id === props.selected} onSelect={props.onSelect} />
          )}
        </For>
      </Show>
    </scrollbox>
  );
}

/**
 * One row, one line, whatever is selected. Nothing a Selection or the mouse does may
 * change a row's height: the keys it offers are in the footer and the question it is
 * waiting on is in its own region, because both of those used to be drawn under the row
 * and pushed every row below it down a line as the cursor passed.
 */
function RowLine(props: { row: Row; selected: boolean; onSelect: (id: string) => void }) {
  // Colour reinforces the glyph and never replaces it: not everyone can see it, and
  // the glyph is what the text fallback and herdr's own tab strip show.
  const marker = () => (props.selected ? "❯" : " ");
  return (
    <box
      id={props.row.id}
      style={{ flexDirection: "row", height: 1 }}
      onMouseDown={() => props.onSelect(props.row.id)}
    >
      <text style={{ width: 4 }} fg={statusColour(props.row.glyph)}>
        {`${marker()} ${props.row.key ?? props.row.glyph} `}
      </text>
      {/* A share of the row rather than a measured width, so the columns line up with
          each other at whatever width the pane is dragged to. */}
      <text
        style={{ width: "45%", height: 1 }}
        // A header names the group under it and can be acted on in no way at all, so it
        // is dim: the rows it introduces are the ones a human is aiming at.
        fg={props.row.kind === "header" ? DIM : undefined}
        attributes={props.selected ? TextAttributes.BOLD : TextAttributes.NONE}
      >
        {props.row.title}
      </text>
      <text style={{ flexGrow: 1, height: 1 }} fg={DIM}>
        {props.row.detail}
      </text>
      <text style={{ width: 9, height: 1 }} fg={DIM}>
        {props.row.ago === "" ? "" : ` ${props.row.ago}`}
      </text>
    </box>
  );
}

function ActionButton(props: { action: Action; dispatch: (command: Command) => void }) {
  const key = () => (props.action.key === "\r" ? "Enter" : props.action.key);
  return (
    <text
      style={{ height: 1 }}
      fg={ACCENT}
      onMouseDown={() => props.dispatch(props.action.command)}
    >
      {`[${key()} ${props.action.label}]  `}
    </text>
  );
}

/**
 * A question a Run is waiting on, in a region of its own. It draws that region and
 * states its own height, so what it takes up is not a second thing the board has to
 * know and keep in step — a line added here used to be a line clipped there.
 */
function Question(props: {
  choice: NonNullable<Row["choice"]>;
  asking: Asking;
  dispatch: (command: Command) => void;
}) {
  const dimensions = useTerminalDimensions();
  const send = (value: string) =>
    props.dispatch({ _tag: "Answer", runId: props.choice.run, value });
  const options = () => (props.choice.kind === "menu" ? props.choice.items : []);
  /**
   * The lines it has for options. It covers the bottom of the list rather than taking
   * rows from it, so what this bounds is how much of the list it hides: never more than
   * half the pane. One line at the least, whatever the pane — a region that cannot show
   * the cursor's own option is one nothing can be chosen from.
   */
  const room = () => Math.max(1, Math.floor(dimensions().height / 2) - QUESTION_CHROME);
  /** The options it has room for, as a window the cursor stays inside. */
  const window = () => optionWindow(options(), props.asking.index, room());
  /** What it left out, said where the keys are said rather than on a line of its own. */
  const footer = () => {
    const { hidden } = window();
    return hidden === 0 ? props.choice.footer : `${props.choice.footer} \u00b7 ${hidden} more`;
  };
  /** The option the cursor is on, which the window always contains. */
  const cursor = () => options()[props.asking.index];
  /** Its chrome and the options it shows — or the one line an answer is typed on. */
  const height = () => QUESTION_CHROME + Math.max(1, window().shown.length);
  return (
    <box
      border
      borderColor={ACCENT}
      // Opaque, because it is drawn over regions that would otherwise show through it.
      backgroundColor="default"
      // Out of the flow, over the bottom of the list and anchored above the footer, so
      // nothing else on the pane is a row shorter for it.
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: FOOTER_HEIGHT,
        height: height(),
        flexDirection: "column",
        paddingLeft: 4,
      }}
    >
      <text style={{ height: 1 }}>{props.choice.header}</text>
      <Show
        when={props.choice.kind === "menu"}
        fallback={<text style={{ height: 1 }} fg={ACCENT}>{`> ${props.asking.typed}`}</text>}
      >
        <For each={window().shown}>
          {(item) => (
            <text
              style={{ height: 1 }}
              fg={item === cursor() ? ACCENT : undefined}
              onMouseDown={() => send(item.id)}
            >
              {`${item === cursor() ? "\u276f" : " "} ${item.title}`}
            </text>
          )}
        </For>
      </Show>
      <text style={{ height: 1 }} fg={DIM}>
        {footer()}
      </text>
    </box>
  );
}

function Footer(props: {
  row: Row | null;
  dispatch: (command: Command) => void;
  /** What has the keyboard, which is what decides everything this offers. */
  on: Keyboarding;
  /** The detail panel's keys, which depend on what is in the panel rather than the row. */
  panel: ReadonlyArray<string>;
  note: string | null;
  filter: string;
  /** How many rows the filter left, so a narrowed list says how narrow it is. */
  matched: number | null;
}) {
  /** The value being edited, where a Settings row is the one taking the keys. */
  const editing = () => (props.on._tag === "Setting" ? props.on.setting : null);
  /**
   * What a field that has taken the keys says they do, and null while the board still
   * has them. It answers both questions this footer asks — which keys to print, and
   * whether the Selection's own are among them — because they have one answer.
   */
  const taken = () => {
    if (props.on._tag === "Choice")
      return "\u2191\u2193 move \u00b7 Enter choose \u00b7 Esc leave the run open";
    if (props.on._tag === "Setting") return "type a value \u00b7 Enter set it \u00b7 Esc leave it";
    // The filter has the keys too, so the board's own are as much a lie here as the
    // Selection's buttons were: `k` typed a `k` while `[k stop]` stopped the run.
    if (props.on._tag === "Filter") return "type to narrow \u00b7 Enter keep it \u00b7 Esc drop it";
    return null;
  };
  /**
   * The Selection's own keys, as buttons. This is the one place a row's actions are
   * offered: they used to be drawn under the row itself, which made selecting a row
   * push every row below it down a line. Clicking one still does what the key does.
   */
  const own = () => (taken() ? [] : actionsFor(props.row));
  // The keys the footer offers are the ones the Selection can actually be asked for,
  // plus the board's own; a key with nothing to act on is a lie.
  const keys = () =>
    taken() ??
    [
      ...props.panel,
      "Tab view",
      "1-9 agent",
      "p run",
      "u resume",
      "f fork",
      "s send review",
      "/ filter",
      "R re-read",
      "q close",
    ].join(" \u00b7 ");
  const status = () => {
    const value = editing();
    if (value) return `${value.key} = ${value.value}\u258f`;
    const filtering = props.on._tag === "Filter";
    if (props.filter !== "" || filtering) {
      const count = props.matched === null ? "" : `  ${props.matched} row(s)`;
      return `/${props.filter}${filtering ? "\u258f" : ""}${count}`;
    }
    return props.note ?? "";
  };
  // Two rows for the Selection's buttons, two for the keys and one for what the tab last
  // said, each clipped to exactly that: an unbounded wrap here used to run over the line
  // under it and render both as mojibake. Fixed, whatever the Selection is — a footer
  // that grew and shrank moved the list it belongs to.
  return (
    <box
      border
      borderColor={DIM}
      // Never squeezed either: the keys are how anything on this board is done at all.
      style={{ flexDirection: "column", height: FOOTER_HEIGHT, flexShrink: 0 }}
    >
      <box style={{ flexDirection: "row", flexWrap: "wrap", height: ACTION_ROWS }}>
        <For each={own()}>
          {(action) => <ActionButton action={action} dispatch={props.dispatch} />}
        </For>
      </box>
      <text style={{ height: KEY_ROWS }} fg={DIM}>
        {keys()}
      </text>
      <text style={{ height: 1 }} fg={props.filter !== "" || editing() ? ACCENT : undefined}>
        {status()}
      </text>
    </box>
  );
}
