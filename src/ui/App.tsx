// The Collie tab. Four regions — nav rail, list, detail, footer — over one Selection.
// Everything this file reads is the plain `AppState` the bridge pushes in, and
// everything it does is a plain `Command` dispatched back out: it imports no Effect and
// holds no runtime, which is what makes it testable with `testRender` and plain data.

import { createMemo, createSignal, createEffect, untrack, For, Show } from "solid-js";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { onBlur, onFocus, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import {
  footerActions,
  ALL_KEYS,
  clampSelection,
  nextQuestionId,
  runsRows,
  detailFor,
  emptyStateOf,
  footerKeys,
  keyboardOn,
  keyIntent,
  matching,
  needsYouStatus,
  optionWindow,
  selectableRows,
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
import type { Scope } from "../config";
import { truncated } from "../views";
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

/**
 * Rows the key list gets. One: the line is the panel's own keys and three globals, and
 * every other key lives behind `?` — which is what made the important ones readable.
 */
const KEY_ROWS = 1;

/**
 * The footer's own rows — its border, its buttons, its keys and what the tab last said.
 * Summed rather than stated, because a footer whose box and whose children disagree clips
 * one of them, and it is what a question is anchored above.
 */
const FOOTER_HEIGHT = 2 + ACTION_ROWS + KEY_ROWS + 1;

/** A question's border, its header and its footer: what it costs before its options. */
const QUESTION_CHROME = 4;

/**
 * A row's columns, as fixed widths rather than shares of the pane. A Collie tab on an
 * ultrawide pane is 320 columns: a title at 45%, a flexing detail and a right-pinned age
 * put a canyon of whitespace between the three things being compared, and the tree's
 * indent left the glyphs in one column and the text in three.
 *
 * So: a gutter that carries the marker, the indent and the glyph, then three columns
 * that start in the same place on every row whatever its depth. Their widths are what
 * caps a row, so a wide pane gives the list air rather than a canyon.
 */
const GUTTER = 4;
const TITLE = 48;
const DOING = 62;
const AGE = 8;
/**
 * What the title keeps on a pane too narrow for the fixed widths — a Collie tab beside
 * the detail panel at 100 columns has 68 for the list, and the three columns want 122.
 * The title shrinks to this, less its own indent, and the detail takes whatever is left,
 * so the columns still line up with each other at every width and every depth.
 */
const TITLE_FLOOR = 30;
/** Two columns of indent per level of the tree, drawn inside the gutter. */
const INDENT = 2;

const DIM = "#8a8a8a";
const ACCENT = "#7aa2f7";
/** The wide scope, in the nav: the board is showing more than this workspace. */
const WIDE = "#e0af68";
/** An opaque ground for anything drawn over the list. Named colours and "default" are
 * not colours opentui parses: it falls through to magenta. */
const GROUND = "#1a1b26";

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
  /**
   * Unsent answers, per Run and Choice. One shared `asking` used to follow the cursor:
   * moving to a second waiting Run showed the text typed at the first, and answering
   * either sent whatever was on screen. Keyed by the Choice's own id, so a question
   * replaced under the human gets a blank field rather than the old question's draft.
   * For this board's lifetime only — an unsent answer is not a Run's business.
   */
  const [drafts, setDrafts] = createSignal<Record<string, Asking>>({});
  const [editingKey, setEditing] = createSignal<{ key: string; value: string } | null>(null);
  const [helping, setHelping] = createSignal(false);
  /** What this board itself has to say, over whatever the last command said. */
  const [ownNote, setOwnNote] = createSignal<string | null>(null);
  /**
   * Everything this board sends out goes through here, so that what the board itself
   * last said cannot outlive it: "no unanswered question" must not sit over the result
   * of the next refresh, answer, view change or Selection.
   */
  const tell = (command: Command) => {
    setOwnNote(null);
    props.dispatch(command);
  };
  const [panel, setPanel] = createSignal<ScrollBoxRenderable>();

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
  /** The board's rows, whatever View is showing: what `n` reaches a question through. */
  const board = createMemo(() => runsRows(props.state()));
  // `matching`, not a plain filter: the rows are nested by the time they get here, so a
  // run whose agent matched has to come with it and the board's order has to survive.
  const rows = createMemo(() => matching(all(), filter()));
  // What the cursor may rest on, which is every row but the group headers.
  const selectable = createMemo(() => selectableRows(rows()));

  // Clamped against the list as it was, so a run finishing under the cursor leaves the
  // row that took its place selected rather than jumping to the top.
  let previous: Row[] = [];
  createEffect(() => {
    const next = selectable();
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
    tell({ _tag: "Select", id });
  });

  const current = (): Row | null => selectable().find((r) => r.id === selected()) ?? null;

  // From the top for a new Selection: how far the last one had been scrolled says
  // nothing about this one, and a long review left the next row's panel opened halfway
  // down somebody else's.
  createEffect(() => {
    selected();
    panel()?.scrollTo(0);
  });
  const detail = () => detailFor(props.state(), current());
  /**
   * Whether anything on screen was cut short, which is the only thing `m` can act on.
   * The review and the plan's spec are read at the same cap and paged by the same key,
   * so either being short is what makes the key worth offering.
   */
  const cutShort = () => [detail()?.review, detail()?.plan?.spec].some(truncated);
  /**
   * The detail panel's own keys. They act on the selected Run's detail, so they are
   * offered only where there is one and only where there is something in it to act on —
   * `t` on a Settings row used to arm tailing for whatever Run was selected next, and `m`
   * re-read a review that was not cut short.
   */
  const panelKeys = () => [
    // Enter is not one of the row's buttons: it is the same key on every row that
    // points at anything, and a sixth button did not fit the two rows they get.
    ...(current()?.jump ? ["Enter go to it"] : []),
    ...(current()?.runId ? ["t log tail"] : []),
    ...(cutShort() ? ["m read more"] : []),
  ];
  // The question belongs to the selected run, so a second waiting run is answerable
  // by selecting it — the board used to answer only the first one asking.
  const question = () => current()?.choice ?? null;
  const draftKey = () => {
    const asked = question();
    const runId = current()?.runId;
    return asked && runId ? `${runId}\u0000${asked.id}` : null;
  };
  const asking = (): Asking => {
    const key = draftKey();
    return (key === null ? null : drafts()[key]) ?? { index: 0, typed: "" };
  };
  const setAsking = (next: Asking) => {
    const key = draftKey();
    if (key !== null) setDrafts((was) => ({ ...was, [key]: next }));
  };
  /** The merge request URL on screen, which is the only thing `c` can copy. */
  const mrUrl = () => {
    const mr = detail()?.mr;
    return mr?._tag === "Details" ? mr.url : null;
  };

  const move = (by: number) => {
    const list = selectable();
    if (list.length === 0) return;
    const at = list.findIndex((r) => r.id === selected());
    setSelected(list[Math.min(list.length - 1, Math.max(0, at + by))]!.id);
  };

  const answer = (value: string) => {
    const key = draftKey();
    const asked = question();
    const runId = current()?.runId;
    // The same three facts the draft key is made of, so there is one condition rather
    // than two spellings of it.
    if (key === null || !asked || !runId) return;
    tell({ _tag: "Answer", runId, choiceId: asked.id, value });
    // The draft dies with the Choice it was for, and only that one: a Run answered
    // here must not clear what is half-typed against another Run's question.
    setDrafts((was) => {
      const { [key]: _sent, ...rest } = was;
      return rest;
    });
  };

  /**
   * The next unanswered question, selected where it is. Over every row of this Scope
   * rather than what the filter left — a hidden question is still unanswered — so the
   * filter is dropped when it is what stands between the human and the row.
   *
   * Over the board's rows rather than the showing View's, and it switches to the Runs
   * View to get there: "no unanswered question" from Settings while a Run is asking is
   * false, and a key that answers by naming the View the human should have been on
   * instead is a key that could have taken them there. The Selection is set after the
   * View is asked for, which is the order the clamp allows — it only re-decides when the
   * rows change, and by then the row this names is among them.
   */
  const goToQuestion = () => {
    const target = nextQuestionId(board(), selected());
    if (target === null) return setOwnNote("no unanswered question");
    setOwnNote(null);
    if (props.state().view !== "runs") tell({ _tag: "ShowView", view: "runs" });
    if (!selectable().some((row) => row.id === target)) {
      setFilter("");
      setTyping(false);
    }
    setSelected(target);
  };

  const showView = (by: number) => {
    const at = VIEWS.findIndex((v) => v.name === props.state().view);
    tell({ _tag: "ShowView", view: VIEWS[(at + by + VIEWS.length) % VIEWS.length]!.name });
  };

  const flow = () => props.pending?.() ?? null;

  /**
   * Everything a row or the footer asks for goes through here. `EditSetting` is the
   * app's own — it opens the editor rather than writing anything — and every other
   * command goes to the bridge. One path, so a click and a key cannot mean different
   * things: they used to, and the click unset the default it offered to set.
   */
  const act = (command: Command) => {
    if (command._tag === "NextQuestion") return goToQuestion();
    if (command._tag === "EditSetting") {
      const row = rows().find((r) => r.setting?.key === command.key);
      if (row?.setting) setEditing({ key: row.setting.key, value: row.setting.value });
      return;
    }
    tell(command);
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
      const was = asking();
      return setAsking({ ...was, typed: append(was.typed) });
    }
    if (at._tag === "Filter") return setFilter(append);
    if (at._tag === "Setting") setEditing({ ...at.setting, value: append(at.setting.value) });
  });

  /**
   * One keypress, as one decision made elsewhere. `keyboardOn` above says who has the
   * keyboard; `keyIntent` says what this key means to them; this performs it. Which key
   * does what is a unit test over there rather than the order of early returns in here,
   * and the two intents that are genuinely a renderer's job — scrolling the panel,
   * putting a URL on the clipboard — are the only reason it returns intents at all.
   */
  useKeyboard((key) => {
    const intent = keyIntent(
      {
        on: keyboard(),
        view: props.state().view,
        scope: props.state().scope,
        helping: helping(),
        asking: asking(),
        filter: filter(),
        scrollable: panel() !== undefined,
        row: current(),
        rows: all(),
        cutShort: cutShort(),
        mrUrl: mrUrl(),
      },
      key,
    );
    if (intent === null) return;
    switch (intent._tag) {
      case "Help":
        return setHelping(intent.open);
      case "Answered":
        setAsking(intent.asking);
        if (intent.value !== null) answer(intent.value);
        return;
      case "Filtering":
        setFilter(intent.filter);
        return setTyping(intent.typing);
      case "Editing":
        return setEditing(intent.editing);
      case "Submitted":
        act(intent.command);
        return setEditing(null);
      case "NextQuestion":
        return goToQuestion();
      case "Move":
        return move(intent.by);
      case "ShowViewBy":
        return showView(intent.by);
      case "Scroll":
        return panel()?.scrollBy(intent.by, intent.unit === "page" ? "viewport" : "absolute");
      case "Copy":
        return renderer.copyToClipboardOSC52(intent.text);
      case "Do":
        return act(intent.command);
    }
  });

  const detailAsColumn = () => dimensions().width >= DETAIL_COLUMN_MIN;

  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      {/* Every key, over everything: the footer offers the Selection's own and three
          globals, and this is where the rest of them are findable. */}
      <Show when={helping()}>
        <Help />
      </Show>
      {/* The launch flow, inline: the same component the popup pane draws. */}
      <Show when={flow() && !helping()}>
        <Flow pending={flow()!} />
      </Show>
      <Show when={flow() === null && !helping()}>
        <Nav
          view={props.state().view}
          scope={props.state().scope}
          groups={props.state().wide?.groups.length ?? 0}
          repo={props.state().board.repo}
          behind={props.state().board.behind}
          onShow={(view) => props.dispatch({ _tag: "ShowView", view })}
          onNewRun={() => props.dispatch({ _tag: "OpenMode", mode: "pick" })}
        />
      </Show>
      <Show when={!helping()}>
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
              ref={setPanel}
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
            ref={setPanel}
            row={current()}
            detail={detail()}
            cwd={props.state().board.cwd}
            overlay
            dispatch={props.dispatch}
          />
        </Show>
      </Show>
      {/* Over the bottom of the list, not among its rows and not beside them: a question
          spliced between rows moved every row below the one asking, and a region that
          took rows from the list changed how much of it there was to look at. Drawn on
          top, so the list's own share of the pane is the same whether or not a Run is
          asking anything. */}
      <Show when={question() && !helping()}>
        <Question choice={question()!} asking={asking()} dispatch={props.dispatch} />
      </Show>
      <Show when={!helping()}>
        <Footer
          row={current()}
          dispatch={act}
          on={keyboard()}
          scope={props.state().scope}
          panel={panelKeys()}
          note={ownNote() ?? props.state().note}
          needsYou={needsYouStatus(rows(), selected())}
          questions={board().some((row) => row.choice)}
          filter={filter()}
          matched={filter() === "" ? null : rows().length}
        />
      </Show>
    </box>
  );
}

/**
 * Every key, over the whole pane. A full screen rather than a corner, because the point
 * is to be readable: the footer can only ever offer what the Selection can be asked for,
 * and this is where a key that is not on that line is findable.
 */
/**
 * How wide the key column is: two spaces of indent, then `PgUp/PgDn` — the longest of
 * them — and one space before the meaning, so no key ever runs into its own text.
 */
const KEY_WIDTH = 12;

/**
 * One column of the help overlay. The meaning is given an explicit width rather than
 * left to flex: a `text` only clips at a width it was told, so relying on the column to
 * shrink had the two of them overdrawing each other at a narrow pane.
 */
function HelpColumn(props: { keys: ReadonlyArray<{ key: string; what: string }>; width: number }) {
  return (
    <box style={{ flexDirection: "column", width: props.width }}>
      <For each={props.keys}>
        {(entry) => (
          <box style={{ flexDirection: "row", height: 1 }}>
            <text style={{ width: KEY_WIDTH }} fg={ACCENT}>
              {`  ${entry.key}`}
            </text>
            <text style={{ width: Math.max(0, props.width - KEY_WIDTH), height: 1 }} fg={DIM}>
              {entry.what}
            </text>
          </box>
        )}
      </For>
    </box>
  );
}

function Help() {
  const dimensions = useTerminalDimensions();
  const half = Math.ceil(ALL_KEYS.length / 2);
  /** Inside the border, and halved: the two columns share whatever the pane gives. */
  const column = () => Math.floor((dimensions().width - 2) / 2);
  return (
    <box border borderColor={ACCENT} title="Keys" style={{ flexDirection: "column", flexGrow: 1 }}>
      {/* An explicit height, because the columns are the only thing that says how tall
          this is, and the hint below has to sit under them rather than beside them. */}
      <box style={{ flexDirection: "row", height: half }}>
        <HelpColumn keys={ALL_KEYS.slice(0, half)} width={column()} />
        <HelpColumn keys={ALL_KEYS.slice(half)} width={column()} />
      </box>
      <text fg={DIM}>{"  any key closes this"}</text>
    </box>
  );
}

/**
 * The nav names every View and switches between them: clicking one asks for it, and so
 * does `Tab`. The one showing is bright, the rest dim.
 */
function Nav(props: {
  view: ViewName;
  /** Which scope the Runs view is showing, and how many groups are in a wide one. */
  scope: Scope;
  groups: number;
  repo: string;
  /** How far behind its remote this installation is, where that is worth saying. */
  behind: number | null;
  onShow: (view: ViewName) => void;
  onNewRun: () => void;
}) {
  /** Which scope, with the count of what is in it once that board has been read. */
  const scope = () => {
    if (props.scope !== "all") return "  local";
    return props.groups > 0 ? `  all · ${props.groups} workspace(s)` : "  all";
  };
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
      {/* The launch flow, without a popup: `p` does the same thing from the keyboard,
          and like `p` it belongs to the board of this workspace — a run starts in this
          checkout, which is not what a board of every workspace is about. */}
      <Show when={props.scope === "local"}>
        <text fg={ACCENT} onMouseDown={() => props.onNewRun()}>
          {"  ＋ New run"}
        </text>
      </Show>
      {/* The scope is the one thing about this board that is not obvious from what is
          on it, so it says which one this is and which key changes it. */}
      <text fg={props.scope === "all" ? WIDE : DIM}>{scope()}</text>
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
  /**
   * Arrows move the Selection, and a Selection the region has scrolled past is one the
   * human cannot see acting on keys they can still press. Each row carries its id so
   * the region can be asked to bring exactly that one back into view.
   *
   * Only when the Selection actually moved. The bridge replaces the state every three
   * seconds and on every filesystem event, and this effect reads the rows too — so it
   * used to re-scroll on each of those, taking the list back to the Selection while
   * the human was reading somewhere else with the wheel. The id is recorded only once
   * it has been scrolled to, so a Selection whose row has not been read yet is still
   * brought into view when it arrives.
   */
  let shown: string | null = null;
  createEffect(() => {
    const id = props.selected;
    if (id === shown) return;
    if (id !== null && props.rows.some((r) => r.id === id)) {
      shown = id;
      region()?.scrollChildIntoView(id);
    }
  });
  return (
    <scrollbox ref={setRegion} title={props.title} border borderColor={DIM} style={{ flexGrow: 1 }}>
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
  /** How far into the gutter this row's text starts: the tree's own depth. */
  const indent = () => props.row.depth * INDENT;
  // A header names the group under it and can be acted on in no way at all, so it is
  // dim: the rows it introduces are the ones a human is aiming at. A workspace is the
  // opposite — its own line is where the eye stops, so it is bold and never dim.
  const quiet = () => props.row.kind === "header";
  const heading = () => props.row.kind === "group";
  return (
    <box
      id={props.row.id}
      style={{ flexDirection: "row", height: 1 }}
      onMouseDown={() => props.onSelect(props.row.id)}
    >
      {/* The gutter: the marker, the indent, and the glyph or the row's own digit. */}
      <text style={{ width: GUTTER + indent(), flexShrink: 0 }} fg={statusColour(props.row.glyph)}>
        {`${marker()} ${" ".repeat(indent())}${props.row.key ?? props.row.glyph}`}
      </text>
      <text
        style={{
          width: TITLE - indent(),
          // Less the indent, like the width: a floor that ignored it would put the
          // detail column of a nested row two further along than its parent's.
          minWidth: TITLE_FLOOR - indent(),
          height: 1,
          flexShrink: 1,
        }}
        fg={quiet() ? DIM : undefined}
        attributes={props.selected || heading() ? TextAttributes.BOLD : TextAttributes.NONE}
      >
        {props.row.title}
      </text>
      <text style={{ width: DOING, height: 1, flexShrink: 1 }} fg={heading() ? undefined : DIM}>
        {props.row.detail}
      </text>
      <text style={{ width: AGE, height: 1, flexShrink: 0 }} fg={DIM}>
        {props.row.ago}
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
    props.dispatch({ _tag: "Answer", runId: props.choice.run, choiceId: props.choice.id, value });
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
      backgroundColor={GROUND}
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
  /** "2 run(s) need you", where any are and the Selection is not on one. */
  needsYou: string | null;
  filter: string;
  /** How many rows the filter left, so a narrowed list says how narrow it is. */
  matched: number | null;
  /** Which scope is showing, so `g` can offer the other one by name. */
  scope: Scope;
  /** Whether anything on this board is asking, which is what `n` can act on. */
  questions: boolean;
}) {
  /** The value being edited, where a Settings row is the one taking the keys. */
  const editing = () => (props.on._tag === "Setting" ? props.on.setting : null);
  /**
   * The Selection's own keys, as buttons. This is the one place a row's actions are
   * offered: they used to be drawn under the row itself, which made selecting a row
   * push every row below it down a line. Clicking one still does what the key does.
   */
  const own = () =>
    footerActions({
      row: props.row,
      scope: props.scope,
      questions: props.questions,
      on: props.on,
    });
  // The keys the footer offers are the ones the Selection can actually be asked for,
  // plus the globals; a key with nothing to act on is a lie, and the rest of them
  // live behind `?`.
  const keys = () => footerKeys({ panel: props.panel, on: props.on, scope: props.scope });
  const status = () => {
    const value = editing();
    if (value) return `${value.key} = ${value.value}\u258f`;
    const filtering = props.on._tag === "Filter";
    if (props.filter !== "" || filtering) {
      const count = props.matched === null ? "" : `  ${props.matched} row(s)`;
      return `/${props.filter}${filtering ? "\u258f" : ""}${count}`;
    }
    // Before the note, not after it: a run stopped waiting on an answer is costing the
    // whole run's wall-clock, and the note is whatever the last command happened to say.
    return props.needsYou ?? props.note ?? "";
  };
  // Two rows for the Selection's buttons, one for the keys and one for what the tab last
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
