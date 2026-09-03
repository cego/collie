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
  filterItems,
  rowHay,
  statusColour,
  viewRows,
  VIEWS,
  type Action,
  type AppState,
  type Asking,
  type Command,
  type Row,
  type ViewName,
} from "./state";
import { Detail } from "./detail";
import { Flow } from "./Flow";
import type { Pending } from "./prompts";

/**
 * Below this the detail cannot be a column and stays out of the way as a full-width
 * overlay instead. A Collie tab split beside an editor is around 60 columns, and a
 * 30-column list next to a 30-column detail is two unreadable columns rather than one
 * readable one.
 */
const DETAIL_COLUMN_MIN = 72;

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
  const [hovered, setHovered] = createSignal<string | null>(null);
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
  const rows = createMemo(() => filterItems(all(), filter(), rowHay));

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

  useKeyboard((key) => {
    // A flow asking a question owns the keyboard: `Flow` has its own handler, and a key
    // that also moved the Selection underneath would act on a board nobody is looking at.
    if (flow()) return;
    const choice = question();
    if (choice) {
      const next = answerFor(choice, asking(), key.sequence);
      setAsking(next.asking);
      if (next.value !== null) answer(next.value);
      return;
    }
    if (typing()) {
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
    const editing = editingKey();
    if (editing !== null) {
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
          hovered={hovered()}
          onSelect={setSelected}
          onHover={setHovered}
          dispatch={act}
          asking={asking()}
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
      <Footer
        row={current()}
        panel={panelKeys()}
        note={props.state().note}
        filter={filter()}
        matched={filter() === "" ? null : rows().length}
        typing={typing()}
        editing={editingKey()}
        answering={question() !== null}
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
    </box>
  );
}

function List(props: {
  title: string;
  empty: string;
  rows: readonly Row[];
  selected: string | null;
  hovered: string | null;
  asking: Asking;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
  dispatch: (command: Command) => void;
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
            <RowLine
              row={row}
              selected={row.id === props.selected}
              hovered={row.id === props.hovered}
              asking={props.asking}
              onSelect={props.onSelect}
              onHover={props.onHover}
              dispatch={props.dispatch}
            />
          )}
        </For>
      </Show>
    </scrollbox>
  );
}

function RowLine(props: {
  row: Row;
  selected: boolean;
  hovered: boolean;
  asking: Asking;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
  dispatch: (command: Command) => void;
}) {
  // Colour reinforces the glyph and never replaces it: not everyone can see it, and
  // the glyph is what the text fallback and herdr's own tab strip show.
  const marker = () => (props.selected ? "❯" : " ");
  const actions = () => (props.selected || props.hovered ? actionsFor(props.row) : []);
  return (
    <box id={props.row.id} style={{ flexDirection: "column" }}>
      <box
        style={{ flexDirection: "row", height: 1 }}
        onMouseDown={() => props.onSelect(props.row.id)}
        onMouseOver={() => props.onHover(props.row.id)}
        onMouseOut={() => props.onHover(null)}
      >
        <text style={{ width: 4 }} fg={statusColour(props.row.glyph)}>
          {`${marker()} ${props.row.key ?? props.row.glyph} `}
        </text>
        {/* A share of the row rather than a measured width, so the columns line up with
            each other at whatever width the pane is dragged to. */}
        <text
          style={{ width: "45%", height: 1 }}
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
      {/* On a line of its own, not squeezed onto the row: a Selection can have four
          actions, and a row that clipped them would offer keys nobody could read. */}
      <Show when={actions().length > 0}>
        {/* Wrapped, not clipped: a Selection can carry four actions, and a button
            cut in half is one nobody can click. */}
        <box style={{ flexDirection: "row", flexWrap: "wrap", paddingLeft: 4 }}>
          <For each={actions()}>
            {(action) => <ActionButton action={action} dispatch={props.dispatch} />}
          </For>
        </box>
      </Show>
      <Show when={props.selected && props.row.choice !== null}>
        <Question choice={props.row.choice!} asking={props.asking} dispatch={props.dispatch} />
      </Show>
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

function Question(props: {
  choice: NonNullable<Row["choice"]>;
  asking: Asking;
  dispatch: (command: Command) => void;
}) {
  const send = (value: string) =>
    props.dispatch({ _tag: "Answer", runId: props.choice.run, value });
  return (
    <box style={{ flexDirection: "column", paddingLeft: 4 }}>
      <text>{props.choice.header}</text>
      <Show
        when={props.choice.kind === "menu"}
        fallback={<text fg={ACCENT}>{`> ${props.asking.typed}`}</text>}
      >
        <For each={props.choice.items}>
          {(item, i) => (
            <text
              fg={i() === props.asking.index ? ACCENT : undefined}
              onMouseDown={() => send(item.id)}
            >
              {`${i() === props.asking.index ? "❯" : " "} ${item.title}`}
            </text>
          )}
        </For>
      </Show>
      <text fg={DIM}>{props.choice.footer}</text>
    </box>
  );
}

function Footer(props: {
  row: Row | null;
  /** The detail panel's keys, which depend on what is in the panel rather than the row. */
  panel: ReadonlyArray<string>;
  note: string | null;
  filter: string;
  /** How many rows the filter left, so a narrowed list says how narrow it is. */
  matched: number | null;
  typing: boolean;
  editing: { key: string; value: string } | null;
  answering: boolean;
}) {
  // The keys the footer offers are the ones the Selection can actually be asked for,
  // plus the board's own; a key with nothing to act on is a lie.
  const keys = () => {
    if (props.answering)
      return "\u2191\u2193 move \u00b7 Enter choose \u00b7 Esc leave the run open";
    if (props.editing) return "type a value \u00b7 Enter set it \u00b7 Esc leave it";
    const own = actionsFor(props.row).map((a) => `${a.key === "\r" ? "Enter" : a.key} ${a.label}`);
    return [
      ...own,
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
  };
  const status = () => {
    if (props.editing) return `${props.editing.key} = ${props.editing.value}\u258f`;
    if (props.filter !== "" || props.typing) {
      const count = props.matched === null ? "" : `  ${props.matched} row(s)`;
      return `/${props.filter}${props.typing ? "\u258f" : ""}${count}`;
    }
    return props.note ?? "";
  };
  // Two rows for the keys and one for what the tab last said, clipped to exactly that:
  // an unbounded wrap here used to run over the line under it and render both as mojibake.
  return (
    <box border borderColor={DIM} style={{ flexDirection: "column", height: 5 }}>
      <text style={{ height: 2 }} fg={DIM}>
        {keys()}
      </text>
      <text style={{ height: 1 }} fg={props.filter !== "" || props.editing ? ACCENT : undefined}>
        {status()}
      </text>
    </box>
  );
}
