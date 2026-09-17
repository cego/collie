// The card board: a header sentence over three sections of cards. One card per Task, and
// everything on it is a fact the TaskView already carries — this file decides colour and
// placement and nothing else.

import { For, Show, type JSX } from "solid-js";
import { TextAttributes, type MouseEvent } from "@opentui/core";
import {
  agentCount,
  finishedLabel,
  type Decision,
  type Gate,
  type HeaderSentence,
  type Proposal,
  type Question,
  whereItIs,
  workingLabel,
  type Sections,
  type TaskView,
  foldWaiting,
  sectionOf,
  waitingLabel,
} from "../board";
import { ALL_KEYS, goToTab, type Command, type MenuItem, type Older, primaryFor } from "./state";
import { C, cardEdge, sentenceColour, stateGlyph, stepGlyph } from "./sections";

/**
 * What a card's decision buttons do, and where a half-typed answer is kept. A draft
 * belongs to the tab for as long as it is open; only sending one reaches a run.
 */
export interface Decide {
  answer: (question: Question, value: string) => void;
  confirm: (proposal: Proposal) => void;
  decline: (proposal: Proposal) => void;
  /** A gate: the list as it stands, or `null` for the whole of it. */
  approve: (gate: Gate, verifications: ReadonlyArray<string> | null) => void;
  skip: (gate: Gate) => void;
  /** Opens the record on the list, which is the only place it can be cut down. */
  edit: (gate: Gate) => void;
  /** What has been typed into this question and not sent. */
  draft: (question: Question) => string;
  /** Whether the keyboard is in this question's field. */
  typing: (question: Question) => boolean;
  typeHere: (question: Question) => void;
}

export interface BoardProps {
  sections: Sections;
  columns: number;
  header: HeaderSentence;
  query: string;
  /** Whether the search field has the keyboard, so the board says where typing goes. */
  searching: boolean;
  onSearch: () => void;
  finishedOpen: boolean;
  /** The finished runs of this checkout from before the board's own cards, once asked for. */
  older: Older;
  onOlder: () => void;
  /** Workflows and Settings, from the one button that still leads off the board. */
  onOverflow: (at: Where) => void;
  /** The Task whose record is open, drawn as the one the board is pointing at. */
  open: string | null;
  onOpen: (view: TaskView) => void;
  /** The menu for this Task, opened where the pointer is. */
  onMenu: (view: TaskView, at: Where) => void;
  /** Everything a card offers that is not opening its record. */
  onAct: (command: Command) => void;
  decide: Decide;
  batch: Batch;
  onToggleFinished: () => void;
  /** Whether the week-old part of Waiting on you is unfolded. */
  waitingOlderOpen: boolean;
  onToggleWaitingOlder: () => void;
  /** The clock the fold is measured against. */
  now: number;
  /** The pane's width in cells, which is what a card's name has to fit. */
  width: number;
  /** The brand mark's file, or null where there is none to draw. */
  logo: string | null;
  onNewRun: () => void;
  onClearQuery: () => void;
}

/**
 * What a card is besides open: on its way out, or picked for the bar that stops several
 * at once. One prop rather than three, because it travels the same three layers `decide`
 * does and each of them only passes it on.
 */
export interface Batch {
  /** Marked to stop, and still inside the grace in which it can be taken back. */
  stopping: (view: TaskView) => boolean;
  picked: (view: TaskView) => boolean;
  /** Shift and the left button: picks this card, or drops it again. */
  onPick: (view: TaskView) => void;
}

/** Where on the pane something was pressed, which is where its menu belongs. */
export interface Where {
  x: number;
  y: number;
}

/** What the search field says before anything has been typed into it. */
const PLACEHOLDER = "find a task or agent";
/** The board's side margin, in cells: the header and the cards share it. */
const SIDE = 2;
/** The header's height, which is the buttons' and the mark's. */
const HEADER_ROWS = 3;
/**
 * The light signature is 3.2 times as wide as it is tall, and a cell is about twice as
 * tall as it is wide: three rows of it want about twenty cells. `fit` keeps the aspect.
 */
const LOGO_COLS = 21;

// No ground of the board's own: the cards carry the colour, and the pane's own background
// showing between them is what makes them read as cards rather than as cells of a table.
export function Board(props: BoardProps) {
  const empty = () =>
    props.sections.needs.length +
      props.sections.working.length +
      props.sections.waiting.length +
      props.sections.finished.length ===
    0;
  const waiting = () => foldWaiting(props.sections.waiting, props.now);
  // What is behind the Finished line: today's cards, and this checkout's earlier runs —
  // the ones already read as much as the ones still to ask for.
  const earlier = () =>
    props.sections.finished.length > 0 || props.older.more || props.older.rows.length > 0;

  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <Header
        header={props.header}
        logo={props.logo}
        width={props.width}
        query={props.query}
        searching={props.searching}
        onSearch={props.onSearch}
        onNewRun={props.onNewRun}
        onOverflow={props.onOverflow}
      />
      {/* Nothing in this column may shrink: yoga would otherwise fit a tall board into the
          viewport by compressing every card, which drew sentences over names and folds
          over borders the moment the content outgrew the pane. The scroll area is what
          gives; the side padding is the board's own margin. */}
      <scrollbox
        style={{ flexGrow: 1 }}
        contentOptions={{ flexDirection: "column", paddingLeft: SIDE, paddingRight: SIDE }}
      >
        <Show when={props.sections.needs.length > 0}>
          <Section label="Needs you" fg={C.amber}>
            <Grid
              views={props.sections.needs}
              columns={props.columns}
              width={props.width - 2 * SIDE}
              open={props.open}
              onOpen={props.onOpen}
              onMenu={props.onMenu}
              onAct={props.onAct}
              decide={props.decide}
              batch={props.batch}
            />
          </Section>
        </Show>

        <Show when={props.sections.working.length > 0}>
          <Section label={workingLabel(props.sections.working)}>
            <Grid
              views={props.sections.working}
              columns={props.columns}
              width={props.width - 2 * SIDE}
              open={props.open}
              onOpen={props.onOpen}
              onMenu={props.onMenu}
              onAct={props.onAct}
              decide={props.decide}
              batch={props.batch}
            />
          </Section>
        </Show>

        {/* Work that ended without landing, and that nobody has asked you about. A week
            open; the rest behind one counted line, never hidden from the header's count. */}
        <Show when={props.sections.waiting.length > 0}>
          <Section label={waitingLabel(props.sections.waiting)}>
            <Grid
              views={waiting().recent}
              columns={props.columns}
              width={props.width - 2 * SIDE}
              open={props.open}
              onOpen={props.onOpen}
              onMenu={props.onMenu}
              onAct={props.onAct}
              decide={props.decide}
              batch={props.batch}
            />
            <Show when={waiting().older.length > 0}>
              <text
                fg={C.dim}
                attributes={TextAttributes.BOLD}
                onMouseDown={() => props.onToggleWaitingOlder()}
              >
                {`${props.waitingOlderOpen ? "▾" : "▸"} ${waiting().older.length} older than a week`}
              </text>
              <Show when={props.waitingOlderOpen}>
                <Grid
                  views={waiting().older}
                  columns={props.columns}
                  width={props.width - 2 * SIDE}
                  open={props.open}
                  onOpen={props.onOpen}
                  onMenu={props.onMenu}
                  onAct={props.onAct}
                  decide={props.decide}
                  batch={props.batch}
                />
              </Show>
            </Show>
          </Section>
        </Show>

        {/* One line until it is asked for: yesterday's success must not compete with
            today's problems for the top of the board. */}
        <Show when={earlier()}>
          <box style={{ flexDirection: "column", paddingTop: 1, flexShrink: 0 }}>
            <text
              fg={C.dim}
              attributes={TextAttributes.BOLD}
              onMouseDown={() => props.onToggleFinished()}
            >
              {`${props.finishedOpen ? "▾" : "▸"} ${finishedLabel(
                props.sections.finished,
                props.finishedOpen,
                props.now,
              )}`}
            </text>
            <Show when={props.finishedOpen}>
              <Grid
                views={props.sections.finished}
                columns={props.columns}
                width={props.width - 2 * SIDE}
                open={props.open}
                onOpen={props.onOpen}
                onMenu={props.onMenu}
                onAct={props.onAct}
                decide={props.decide}
                batch={props.batch}
              />
              {/* What the History view was: this checkout's earlier runs, a page at a
                  time, as lines — they are a record rather than work in hand. */}
              <For each={props.older.rows}>
                {(row) => (
                  <box style={{ flexDirection: "row" }}>
                    <text fg={C.dim}>{`${row.glyph} `}</text>
                    <text fg={C.muted} style={{ flexGrow: 1 }}>
                      {row.title}
                    </text>
                    <text fg={C.dim}>{row.detail}</text>
                  </box>
                )}
              </For>
              <Show when={props.older.more}>
                <text fg={C.blue} onMouseDown={() => props.onOlder()}>
                  Older…
                </text>
              </Show>
            </Show>
          </box>
        </Show>

        <Show when={empty()}>
          <text fg={C.dim} onMouseDown={() => props.onClearQuery()}>
            {props.query.trim() === ""
              ? "Nothing on the board yet."
              : "Nothing matches. Show everything"}
          </text>
        </Show>
      </scrollbox>
    </box>
  );
}

function Header(props: {
  header: HeaderSentence;
  logo: string | null;
  width: number;
  query: string;
  searching: boolean;
  onSearch: () => void;
  onNewRun: () => void;
  onOverflow: (at: Where) => void;
}) {
  return (
    <box
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingLeft: SIDE,
        paddingRight: SIDE,
        height: HEADER_ROWS,
        flexShrink: 0,
      }}
    >
      {/* The signature carries the lettering, so the wordmark is for the terminals that
          cannot show a picture. */}
      <Show
        when={props.logo !== null}
        fallback={
          <text
            fg={C.blue}
            attributes={TextAttributes.BOLD}
            wrapMode="none"
            style={{ flexShrink: 0 }}
          >
            collie
          </text>
        }
      >
        <Logo file={props.logo!} />
      </Show>
      {/* One line, whatever the width: a sentence wrapped under the mark reads as two. */}
      <text fg={props.header.urgent ? C.amber : C.muted} wrapMode="none" style={{ flexShrink: 0 }}>
        {`  ${props.header.text}`}
      </text>
      <box style={{ flexGrow: 1 }} />
      {/* A field, not a word: three rows like the buttons beside it, lit while it has
          the keys. */}
      <box
        backgroundColor={props.searching ? C.selected : C.card}
        style={{
          // The one thing in the header that gives way on a narrow pane: the sentence and
          // the buttons say what the board is for, the field only has to stay clickable.
          width: props.width < 150 ? 18 : 34,
          flexShrink: 0,
          height: 3,
          marginRight: 1,
          justifyContent: "center",
          overflow: "hidden",
        }}
        onMouseDown={() => props.onSearch()}
      >
        <text fg={props.searching || props.query !== "" ? C.text : C.dim} wrapMode="none">
          {` ⌕ ${props.query === "" ? (props.width < 150 ? "find" : PLACEHOLDER) : props.query}${props.searching ? "▏" : ""}`}
        </text>
      </box>
      <HeaderButton label="+ New run" primary onPress={() => props.onNewRun()} />
      {/* Everything that is not the board, behind one button: the nav rail's whole job. */}
      <HeaderButton label="≡" onPress={(at) => props.onOverflow(at)} />
    </box>
  );
}

function Section(props: { label: string; fg?: string; children: JSX.Element }) {
  return (
    <box style={{ flexDirection: "column", paddingTop: 1, flexShrink: 0 }}>
      <text fg={props.fg ?? C.dim} attributes={TextAttributes.BOLD}>
        {props.label}
      </text>
      {props.children}
    </box>
  );
}

/** The cards, `columns` across. A row of them, so every card in it is the same width. */
function Grid(props: {
  views: ReadonlyArray<TaskView>;
  columns: number;
  width: number;
  open: string | null;
  onOpen: (view: TaskView) => void;
  onMenu: (view: TaskView, at: Where) => void;
  onAct: (command: Command) => void;
  decide: Decide;
  batch: Batch;
}) {
  const rows = () => {
    const out: Array<ReadonlyArray<TaskView>> = [];
    for (let at = 0; at < props.views.length; at += props.columns) {
      out.push(props.views.slice(at, at + props.columns));
    }
    return out;
  };
  return (
    <box style={{ flexDirection: "column", flexShrink: 0 }}>
      <For each={rows()}>
        {(row) => (
          <box style={{ flexDirection: "row", flexShrink: 0 }}>
            <For each={row}>
              {(view) => (
                <Card
                  view={view}
                  width={props.width - 2 * SIDE}
                  columns={props.columns}
                  open={props.open === view.id}
                  onOpen={() => props.onOpen(view)}
                  onMenu={props.onMenu}
                  onAct={props.onAct}
                  decide={props.decide}
                  batch={props.batch}
                />
              )}
            </For>
          </box>
        )}
      </For>
    </box>
  );
}

/**
 * One Task. Its border carries the edge colour the design puts down the left of a card:
 * in cells a card's border is its edge, and a state worth interrupting someone for is
 * what earns one.
 */
/** `…` at the end of what will not fit, so a name never pushes the age off its card. */
function clipped(text: string, room: number): string {
  return text.length <= room ? text : `${text.slice(0, Math.max(0, room - 1))}…`;
}

function Card(props: {
  view: TaskView;
  width: number;
  columns: number;
  open: boolean;
  onOpen: () => void;
  onMenu: (view: TaskView, at: Where) => void;
  onAct: (command: Command) => void;
  decide: Decide;
  batch: Batch;
}) {
  const state = () => stateGlyph(props.view.state);
  /** The header row less its border, glyph, project and age: what is left for the name. */
  const nameRoom = () =>
    Math.max(
      6,
      Math.floor(props.width / props.columns) -
        4 -
        2 -
        (props.view.project.length + 2) -
        (props.view.age.length + 1),
    );
  const menu = (event: MouseEvent) => {
    event.stopPropagation();
    props.onMenu(props.view, { x: event.x, y: event.y });
  };
  return (
    <box
      border
      borderColor={props.batch.picked(props.view) ? C.blue : (cardEdge(props.view) ?? C.strong)}
      backgroundColor={props.batch.picked(props.view) ? C.selected : props.open ? C.hover : C.card}
      style={{ flexGrow: 1, flexBasis: 0, flexDirection: "column", minWidth: 0 }}
      onMouseDown={(event: MouseEvent) => {
        if (event.button === RIGHT_BUTTON) return menu(event);
        // Shift picks this card for the bar; a plain click is about this one card, and
        // ends the selection rather than adding to it.
        if (event.modifiers.shift) return props.batch.onPick(props.view);
        props.onOpen();
      }}
    >
      <box style={{ flexDirection: "row" }}>
        <text fg={state().fg} attributes={TextAttributes.BOLD}>{`${state().glyph} `}</text>
        {/* The name gives way, clipped rather than wrapped: a card is the same height
            whatever it is called, and the project and the age keep their place. */}
        <box style={{ flexShrink: 1, minWidth: 0, overflow: "hidden" }}>
          <text attributes={TextAttributes.BOLD} fg={C.text} wrapMode="none">
            {clipped(props.view.name, nameRoom())}
          </text>
        </box>
        <text fg={C.dim} style={{ flexShrink: 0 }}>{`  ${props.view.project}`}</text>
        <box style={{ flexGrow: 1 }} />
        <text fg={C.dim} style={{ flexShrink: 0 }}>
          {props.view.age}
        </text>
      </box>

      <text fg={sentenceColour(props.view)}>{props.view.sentence}</text>

      <Show when={props.view.decision}>
        <Deciding decision={props.view.decision!} decide={props.decide} />
      </Show>

      {/* One amber line, in words: drift a human has to look up is drift nobody reads. */}
      <Show when={props.view.drift !== null}>
        <text fg={C.amber}>{`↯ ${props.view.drift}`}</text>
      </Show>

      <Show when={props.view.held !== null}>
        <text fg={C.dim}>{props.view.held}</text>
      </Show>

      <Show when={props.batch.stopping(props.view)}>
        <text fg={C.dim}>■ stopping…</text>
      </Show>

      <box style={{ flexDirection: "row" }}>
        <For each={props.view.steps}>
          {(step) => <text fg={stepGlyph(step.state).fg}>{stepGlyph(step.state).glyph}</text>}
        </For>
        <text fg={C.dim}>{`  ${whereItIs(props.view)}`}</text>
        <text fg={C.dim}>{agentCount(props.view) === "" ? "" : `  ${agentCount(props.view)}`}</text>
      </box>
      {/* Always drawn, on a row of their own: a button that appears under the pointer moves
          the card under the pointer, and a terminal does not promise a hover anyway. */}
      <box style={{ flexDirection: "row", marginTop: 1 }}>
        <Show when={primaryFor(props.view)} keyed>
          {(primary: MenuItem) => (
            <Button
              label={primary.label}
              primary={sectionOf(props.view) === "waiting"}
              onPress={() => props.onAct(primary.command)}
            />
          )}
        </Show>
        <text fg={C.text} bg={C.strong} onMouseDown={menu}>
          {" ⋯ "}
        </text>
      </box>
    </box>
  );
}

/** The decision, answered where it is: nothing to select first and no key to learn. */
function Deciding(props: { decision: Decision; decide: Decide }) {
  const question = () => (props.decision.kind === "question" ? props.decision : null);
  const proposal = () => (props.decision.kind === "proposal" ? props.decision : null);
  const gate = () => (props.decision.kind === "gate" ? props.decision : null);
  return (
    <box style={{ flexDirection: "column" }}>
      <Show when={question() !== null}>
        <Asked question={question()!} decide={props.decide} />
      </Show>
      <Show when={proposal() !== null}>
        <Proposed proposal={proposal()!} decide={props.decide} />
      </Show>
      <Show when={gate() !== null}>
        <Gated gate={gate()!} decide={props.decide} />
      </Show>
    </box>
  );
}

function Gated(props: { gate: Gate; decide: Decide }) {
  return (
    <box style={{ flexDirection: "column" }}>
      <text fg={C.text}>{props.gate.verifications.join(" · ")}</text>
      <box style={{ flexDirection: "row", flexWrap: "wrap" }}>
        <Button label="Approve" primary onPress={() => props.decide.approve(props.gate, null)} />
        <Button label="Edit the list" onPress={() => props.decide.edit(props.gate)} />
        <Button label="Skip" onPress={() => props.decide.skip(props.gate)} />
      </box>
    </box>
  );
}

function Asked(props: { question: Question; decide: Decide }) {
  const draft = () => props.decide.draft(props.question);
  const send = () => props.decide.answer(props.question, draft().trim());
  return (
    <box style={{ flexDirection: "column" }}>
      <text fg={C.text}>{props.question.text}</text>
      <Show when={props.question.options.length > 0}>
        <box style={{ flexDirection: "row", flexWrap: "wrap" }}>
          <For each={props.question.options}>
            {(option, at) => (
              <Button
                label={option.title}
                primary={at() === 0}
                onPress={() => props.decide.answer(props.question, option.id)}
              />
            )}
          </For>
        </box>
      </Show>
      <Show when={props.question.options.length === 0}>
        <box style={{ flexDirection: "row" }}>
          <text
            fg={draft() === "" ? C.dim : C.text}
            bg={C.line}
            style={{ flexGrow: 1 }}
            onMouseDown={(event: MouseEvent) => {
              event.stopPropagation();
              props.decide.typeHere(props.question);
            }}
          >
            {` ${draft() === "" ? "type your answer" : draft()}${
              props.decide.typing(props.question) ? "▏" : ""
            }`}
          </text>
          <Show when={draft().trim() !== ""}>
            <Button label="Send" primary onPress={send} />
          </Show>
        </box>
      </Show>
    </box>
  );
}

function Proposed(props: { proposal: Proposal; decide: Decide }) {
  return (
    <box style={{ flexDirection: "column" }}>
      <text fg={C.text}>{props.proposal.text}</text>
      <For each={props.proposal.actions}>
        {(action) => (
          <text fg={action.allowed ? C.muted : C.amber}>
            {`  ${action.allowed ? "✓" : "?"} ${action.text} · ${
              action.allowed ? "allowed now" : "needs your yes"
            }`}
          </text>
        )}
      </For>
      <box style={{ flexDirection: "row" }}>
        <Button label="Confirm" primary onPress={() => props.decide.confirm(props.proposal)} />
        <Button label="Decline" onPress={() => props.decide.decline(props.proposal)} />
        {/* Cells have no tooltip, so what a yes names is beside the button that gives it. */}
        <text fg={C.dim}>{`  ${props.proposal.id} · ${props.proposal.hash}`}</text>
      </box>
    </box>
  );
}

/**
 * One Task's menu, where it was asked for. The scrim under it is what makes a click
 * anywhere else a way out rather than an action on whatever happens to be there.
 */
export function CardMenu(props: {
  items: ReadonlyArray<MenuItem>;
  at: Where;
  pane: { width: number; height: number };
  onAct: (command: Command) => void;
  onClose: () => void;
}) {
  const left = () => Math.max(0, Math.min(props.at.x, props.pane.width - MENU_WIDTH));
  const top = () => Math.max(0, Math.min(props.at.y, props.pane.height - props.items.length - 2));
  return (
    <>
      <box
        style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, zIndex: 8 }}
        onMouseDown={(event: MouseEvent) => {
          event.stopPropagation();
          props.onClose();
        }}
      />
      <box
        border
        borderColor={C.strong}
        backgroundColor={C.pane}
        style={{
          position: "absolute",
          left: left(),
          top: top(),
          width: MENU_WIDTH,
          flexDirection: "column",
          zIndex: 9,
        }}
      >
        <For each={props.items}>
          {(item) => (
            <box
              style={{ flexDirection: "row" }}
              onMouseDown={(event: MouseEvent) => {
                event.stopPropagation();
                props.onAct(item.command);
              }}
            >
              <text fg={C.text} style={{ flexGrow: 1 }}>
                {item.label}
              </text>
              <text fg={C.dim}>{` ${item.key}`}</text>
            </box>
          )}
        </For>
      </box>
    </>
  );
}

/**
 * Every key the board takes, over the whole pane, from the one list `docs/using.md`
 * restates. Any key closes it, which is why nothing in here is a target.
 */
export function KeyHelp(props: { onClose: () => void }) {
  return (
    <box
      backgroundColor={C.pane}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        zIndex: 10,
        flexDirection: "column",
        paddingLeft: 2,
        paddingTop: 1,
      }}
      onMouseDown={() => props.onClose()}
    >
      <text fg={C.blue} attributes={TextAttributes.BOLD}>
        Keys
      </text>
      <For each={ALL_KEYS}>
        {(entry) => (
          <box style={{ flexDirection: "row" }}>
            <text fg={C.amber} style={{ width: 8 }}>
              {entry.key}
            </text>
            <text fg={C.text}>{entry.what}</text>
          </box>
        )}
      </For>
    </box>
  );
}

/** Wide enough for the longest label and its key, and narrow enough for a 1-column pane. */
const MENU_WIDTH = 26;
const RIGHT_BUTTON = 2;

/** One button. The press stops here: the card under it opens the record, which a human
    aiming at Confirm is not asking for. */
/** The header's buttons: three rows, the height of the field beside them. */
/**
 * The brand signature — Luma and the lettering, the light version for dark ground — where
 * there is one to draw: the bitmap itself over the Kitty graphics protocol, three rows
 * tall like the controls beside it. The caller decides whether
 * every human looking at this pane can see a picture (`outer.ts`); a board that cannot
 * be sure draws no mark at all rather than a blank where one should be.
 */
function Logo(props: { file: string }) {
  return (
    <image
      source={props.file}
      fit="fit"
      protocol="kitty"
      style={{ width: LOGO_COLS, height: HEADER_ROWS, flexShrink: 0, marginRight: 1 }}
    />
  );
}

function HeaderButton(props: { label: string; primary?: boolean; onPress: (at: Where) => void }) {
  return (
    <box
      backgroundColor={props.primary ? C.blue : C.strong}
      style={{ height: 3, flexShrink: 0, justifyContent: "center", marginLeft: 1 }}
      onMouseDown={(event: MouseEvent) => {
        event.stopPropagation();
        props.onPress({ x: event.x, y: event.y });
      }}
    >
      <text
        fg={props.primary ? C.ground : C.text}
        attributes={props.primary ? TextAttributes.BOLD : undefined}
      >
        {`  ${props.label}  `}
      </text>
    </box>
  );
}

export function Button(props: { label: string; primary?: boolean; onPress: () => void }) {
  return (
    <text
      fg={props.primary ? C.ground : C.text}
      bg={props.primary ? C.blue : C.strong}
      attributes={props.primary ? TextAttributes.BOLD : undefined}
      style={{ marginRight: 1 }}
      onMouseDown={(event: MouseEvent) => {
        event.stopPropagation();
        props.onPress();
      }}
    >
      {` ${props.label} `}
    </text>
  );
}
