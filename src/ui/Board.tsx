import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { For, Index, Show } from "solid-js";
import type { JSX } from "solid-js";
import { TextAttributes } from "@opentui/core";
import type { MouseEvent } from "@opentui/core";
import { agentCount, finishedLabel, whereItIs, workingLabel, waitingLabel } from "../board";
import { foldFinished, foldWaiting, sectionOf, solutionTitle, SECTIONS } from "../board-model";
import type {
  Decision,
  HeaderSentence,
  Proposal,
  Question,
  Sections,
  TaskView,
  Section as SectionId,
} from "../board-model";
import type { UsagePhrase } from "../usage-model";
import { newerLine } from "../workspace";
import { parkLine } from "../park-cause";
import { ALL_KEYS, primaryFor } from "./state";
import type { Command, MenuItem, Older } from "./state";
import { C, cardEdge, sentenceColour, stateGlyph, stepGlyph } from "./sections";

export interface Decide {
  answer: (question: Question, value: string) => void;
  confirm: (proposal: Proposal) => void;
  decline: (proposal: Proposal) => void;
  draft: (question: Question) => string;
  typing: (question: Question) => boolean;
  typeHere: (question: Question) => void;
}

export interface BoardProps {
  sections: Sections;
  columns: number;
  header: HeaderSentence;
  usage: UsagePhrase;
  newer: string | null;
  query: string;
  searching: boolean;
  onSearch: () => void;
  finishedOpen: boolean;
  older: Older;
  onOlder: () => void;
  onOverflow: (at: Where) => void;
  open: string | null;
  onOpen: (view: TaskView) => void;
  onMenu: (view: TaskView, at: Where) => void;
  onAct: (command: Command) => void;
  decide: Decide;
  batch: Batch;
  onToggleFinished: () => void;
  waitingOlderOpen: boolean;
  onToggleWaitingOlder: () => void;
  now: number;
  width: number;
  logo: string | null;
  onNewRun: () => void;
  onClearQuery: () => void;
}

export interface Batch {
  stopping: (view: TaskView) => boolean;
  picked: (view: TaskView) => boolean;
  onPick: (view: TaskView) => void;
}

export interface Where {
  x: number;
  y: number;
}

const PLACEHOLDER = "find a task or agent";
const SIDE = 2;
const CARD_PAD = 1;
const HEADER_ROWS = 3;
const LOGO_COLS = 21;

export function Board(props: BoardProps) {
  const empty = () =>
    props.sections.needs.length +
      props.sections.ready.length +
      props.sections.working.length +
      props.sections.waiting.length +
      props.sections.finished.length ===
    0;
  const waiting = () => foldWaiting(props.sections.waiting, props.now);
  const finished = () => foldFinished(props.sections.finished);
  const earlier = () =>
    props.sections.finished.length > 0 || props.older.more || props.older.rows.length > 0;

  const drawn: Record<SectionId, () => JSX.Element> = {
    "ready-to-ship": () => (
      <Show when={props.sections.ready.length > 0}>
        <Section label={`Ready to ship · ${props.sections.ready.length}`}>
          <Grid
            views={props.sections.ready}
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
    ),
    "needs-you": () => (
      <>
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
      </>
    ),
    waiting: () => (
      <>
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
      </>
    ),
    working: () => (
      <>
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
      </>
    ),
    finished: () => (
      <>
        <Show when={earlier()}>
          <box style={{ flexDirection: "column", paddingTop: 1, flexShrink: 0 }}>
            <Show when={finished().unseen.length > 0}>
              <Grid
                views={finished().unseen}
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
                views={finished().seen}
                columns={props.columns}
                width={props.width - 2 * SIDE}
                open={props.open}
                onOpen={props.onOpen}
                onMenu={props.onMenu}
                onAct={props.onAct}
                decide={props.decide}
                batch={props.batch}
              />
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
      </>
    ),
  };

  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <Header
        header={props.header}
        usage={props.usage}
        logo={props.logo}
        width={props.width}
        query={props.query}
        searching={props.searching}
        onSearch={props.onSearch}
        onNewRun={props.onNewRun}
        onOverflow={props.onOverflow}
      />
      <Show when={props.newer !== null}>
        <text fg={C.amber} wrapMode="none" style={{ paddingLeft: SIDE, flexShrink: 0 }}>
          {newerLine(props.newer ?? "")}
        </text>
      </Show>
      <scrollbox
        style={{ flexGrow: 1 }}
        contentOptions={{ flexDirection: "column", paddingLeft: SIDE, paddingRight: SIDE }}
      >
        <For each={SECTIONS}>{([section]) => drawn[section]()}</For>

        <Show when={empty()}>
          <text fg={C.dim} onMouseDown={() => props.onClearQuery()}>
            {Str.trim(props.query) === ""
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
  usage: UsagePhrase;
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
      <text fg={props.header.urgent ? C.amber : C.muted} wrapMode="none" style={{ flexShrink: 0 }}>
        {`  ${props.header.text}`}
      </text>
      <Show when={props.usage.text !== ""}>
        <box style={{ flexShrink: 1, overflow: "hidden" }}>
          <text fg={props.usage.warn ? C.amber : C.dim} wrapMode="none">
            {`  ${props.usage.text}`}
          </text>
        </box>
      </Show>
      <box style={{ flexGrow: 1 }} />
      <box
        backgroundColor={props.searching ? C.selected : C.card}
        style={{
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

// WARNING: cells are reused by position: a fresh snapshot updates the cell rather than recreating its text.
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
      <Index each={rows()}>
        {(row) => (
          <box style={{ flexDirection: "row", flexShrink: 0 }}>
            <Index each={row()}>
              {(view) => (
                <Card
                  view={view()}
                  width={props.width - 2 * SIDE}
                  columns={props.columns}
                  open={props.open === view().id}
                  onOpen={() => props.onOpen(view())}
                  onMenu={props.onMenu}
                  onAct={props.onAct}
                  decide={props.decide}
                  batch={props.batch}
                />
              )}
            </Index>
          </box>
        )}
      </Index>
    </box>
  );
}

function clipped(text: string, room: number) {
  return text.length <= room ? text : `${pipe(text, Str.slice(0, Math.max(0, room - 1)))}…`;
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
  const nameRoom = () =>
    Math.max(
      6,
      Math.floor(props.width / props.columns) -
        4 -
        2 * CARD_PAD -
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
      style={{
        flexGrow: 1,
        flexBasis: 0,
        flexDirection: "column",
        minWidth: 0,
        paddingLeft: CARD_PAD,
        paddingRight: CARD_PAD,
      }}
      onMouseDown={(event: MouseEvent) => {
        if (event.button === RIGHT_BUTTON) {
          return menu(event);
        }
        if (event.modifiers.shift) {
          return props.batch.onPick(props.view);
        }
        props.onOpen();
      }}
    >
      <box style={{ flexDirection: "row" }}>
        <text fg={state().fg} attributes={TextAttributes.BOLD}>{`${state().glyph} `}</text>
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

      <Show when={props.view.unseen === true}>
        <text fg={C.blue}>● unseen</text>
      </Show>

      <Show when={props.view.decision}>
        <Deciding decision={props.view.decision!} decide={props.decide} />
      </Show>

      <Show when={props.view.moved != null}>
        <text fg={C.dim}>{`⤴ ${props.view.moved}`}</text>
      </Show>

      <For each={props.view.offers ?? []}>
        {(offer) => <text fg={C.dim}>{`↪ ${offer.title}`}</text>}
      </For>

      <Show when={props.view.drift !== null}>
        <text fg={C.amber}>{`↯ ${props.view.drift}`}</text>
      </Show>

      <Show when={props.view.held !== null}>
        <text fg={C.dim}>{props.view.held}</text>
      </Show>

      <Show when={props.view.park != null}>
        <text fg={C.dim}>{parkLine(props.view.park!)}</text>
      </Show>
      <For each={(props.view.recovery ?? []).slice(-2)}>
        {(line) => <text fg={C.dim}>{line}</text>}
      </For>

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

function Deciding(props: { decision: Decision; decide: Decide }) {
  const question = () => (props.decision.kind === "question" ? props.decision : null);
  const proposal = () => (props.decision.kind === "proposal" ? props.decision : null);
  return (
    <box style={{ flexDirection: "column" }}>
      <Show when={question() !== null}>
        <Asked question={question()!} decide={props.decide} />
      </Show>
      <Show when={proposal() !== null}>
        <Proposed proposal={proposal()!} decide={props.decide} />
      </Show>
    </box>
  );
}

function Asked(props: { question: Question; decide: Decide }) {
  const draft = () => props.decide.draft(props.question);
  const send = () => props.decide.answer(props.question, Str.trim(draft()));
  return (
    <box style={{ flexDirection: "column" }}>
      <text fg={C.text}>{props.question.text}</text>
      <Show when={props.question.options.length > 0}>
        <box style={{ flexDirection: "row", flexWrap: "wrap" }}>
          <For each={props.question.options}>
            {(option, at) => (
              <Button
                label={solutionTitle(option)}
                primary={at() === 0}
                onPress={() => props.decide.answer(props.question, option.id)}
              />
            )}
          </For>
        </box>
        <For each={props.question.options}>
          {(option) => (
            <Show when={option.detail !== undefined}>
              <text fg={C.dim}>{`${option.title}: ${option.detail}`}</text>
            </Show>
          )}
        </For>
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
          <Show when={Str.trim(draft()) !== ""}>
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
        <text fg={C.dim}>{`  ${props.proposal.id} · ${props.proposal.hash}`}</text>
      </box>
    </box>
  );
}

export function CardMenu(props: {
  items: ReadonlyArray<MenuItem>;
  cursor: number | null;
  at: Where;
  pane: { width: number; height: number };
  onAct: (command: Command) => void;
  onClose: () => void;
}) {
  const left = () => Math.max(0, Math.min(props.at.x, props.pane.width - MENU_WIDTH));
  const top = () => Math.max(0, Math.min(props.at.y, props.pane.height - props.items.length - 3));
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
                if (item.disabled !== true) {
                  props.onAct(item.command);
                }
              }}
            >
              <text fg={C.text} style={{ flexGrow: 1 }}>
                {props.cursor !== null && props.items[props.cursor] === item ? "› " : "  "}
                {item.label}
              </text>
              <text fg={C.dim}>{` ${item.key}`}</text>
            </box>
          )}
        </For>
        <text fg={C.dim}>↑↓ choose · Enter select</text>
      </box>
    </>
  );
}

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

const MENU_WIDTH = 26;
const RIGHT_BUTTON = 2;

// WARNING: drawn only where every human looking at the pane can see a picture; otherwise no mark at all.
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
