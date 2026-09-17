// The Collie tab. A header sentence, three sections of cards, and one Task's record over
// them. Everything this file reads is the plain `AppState` the bridge pushes in, and
// everything it does is a plain `Command` dispatched back out: it imports no Effect and
// holds no runtime, which is what makes it testable with `testRender` and plain data.

import { createEffect, createMemo, createSignal, untrack, Show } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import { onBlur, onFocus, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import {
  actionsFor,
  emptyStateOf,
  menuFor,
  olderFinished,
  runRowId,
  viewRows,
  type AppState,
  type Command,
  type Keypress,
  type MenuItem,
  type Row,
  type ViewName,
} from "./state";
import { headerSentence, sectionsOf, type Question, type TaskView } from "../board";
import { truncated } from "../views";
import { columnsFor, C } from "./sections";
import { Board, Button, CardMenu, KeyHelp, type Batch, type Decide, type Where } from "./Board";
import { Pane } from "./Pane";
import { Drawer, type GateCut, type Tab } from "./Drawer";
import { ProposalPreview } from "./live";
import { usePasteInto } from "./paste";
import { Flow } from "./Flow";
import type { Pending } from "./prompts";

const PRINTABLE = /^[\x20-\x7e]$/;
/** How far in from the right the header's own menu opens, so it sits under its button. */
const MENU_GAP = 28;

export interface AppProps {
  state: () => AppState;
  /**
   * A question a flow running inline is waiting on. The popup renders the same component
   * as its whole screen; here it is an overlay over the board that asked for it.
   */
  pending?: () => Pending | null;
  dispatch: (command: Command) => void;
  /** The brand mark's file, for a terminal that can draw one. Absent in a test. */
  logo?: string;
}

export function App(props: AppProps) {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const [query, setQuery] = createSignal("");
  const [searching, setSearching] = createSignal(false);
  /** The Task whose record is open, by its own id: a Run finishing must not close it. */
  const [openId, setOpenId] = createSignal<string | null>(null);
  /** Which part of that record is being read. A new record opens on Summary. */
  const [tab, setTab] = createSignal<Tab>("summary");
  /** Remembered for this tab's life only: which day's finished work someone opened is
      not a Run's business. */
  const [finishedOpen, setFinishedOpen] = createSignal(false);
  const [waitingOlderOpen, setWaitingOlderOpen] = createSignal(false);
  const [drawer, setDrawer] = createSignal<ScrollBoxRenderable>();
  /** Answers being composed, by run and question: the tab's, until someone sends one. */
  const [drafts, setDrafts] = createSignal<Readonly<Record<string, string>>>({});
  const [typingTo, setTypingTo] = createSignal<string | null>(null);
  /** What the open menu offers and where it was asked for: a card's, or the header's. */
  const [menuOn, setMenuOn] = createSignal<{ items: ReadonlyArray<MenuItem>; at: Where } | null>(
    null,
  );
  /** How many pages of this checkout's earlier finished runs someone has asked for. */
  const [olderPages, setOlderPages] = createSignal(0);
  /** The setting being typed into, and what has been typed at it. */
  const [editing, setEditing] = createSignal<{ key: string; typed: string } | null>(null);
  /** The cards picked with shift, by Task: what the bar at the foot acts on. */
  const [picked, setPicked] = createSignal<ReadonlySet<string>>(new Set());
  /** A gate's list being cut down, by the gate's own id: the tab's, until it is sent. */
  const [cutting, setCutting] = createSignal<{
    id: string;
    kept: ReadonlyArray<string>;
  } | null>(null);
  /** What is being steered, and what has been typed at it so far. */
  const [steering, setSteering] = createSignal(false);
  const [steers, setSteers] = createSignal<Readonly<Record<string, string>>>({});
  const [toast, setToast] = createSignal<string | null>(null);
  const [helping, setHelping] = createSignal(false);

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

  const tasks = () => props.state().tasks;
  const sections = createMemo(() => sectionsOf(tasks(), query()));
  // Over every Task rather than what the search left: a decision a query is hiding is
  // still waiting on the human.
  const header = createMemo(() => headerSentence(tasks(), props.state().now));
  const columns = () => columnsFor(dimensions().width, props.state().density);
  const open = () => tasks().find((view) => view.id === openId()) ?? null;

  // What is open decides what the producers read, so it is dispatched rather than kept
  // here: that is what fills the drawer's record.
  let told: string | null = null;
  createEffect(() => {
    const view = open();
    const id = view === null ? null : runRowId(view.run);
    if (id === told) return;
    told = id;
    props.dispatch({
      _tag: "Select",
      id,
      on: view === null ? null : { task: view.id, run: view.run, name: view.name },
    });
  });

  // A new record opens on Summary with the keyboard back on the board: which tab the last
  // one was left on says nothing about this one.
  createEffect(() => {
    openId();
    setSteering(false);
    setTab("summary");
  });

  // And from the top, for a new record or a new tab: how far the last one had been
  // scrolled says nothing about what is in the box now.
  createEffect(() => {
    openId();
    tab();
    drawer()?.scrollTo(0);
  });

  /**
   * The run's log is read only while the Log tab is showing it. What was asked for is
   * remembered rather than read back off the record: the read lands a tick after the
   * dispatch, and asking again in between would switch it off.
   */
  let tailing = false;
  createEffect(() => {
    const wanted = openId() !== null && tab() === "log";
    if (wanted === tailing) return;
    tailing = wanted;
    props.dispatch({ _tag: "ToggleTail" });
  });

  const flow = () => props.pending?.() ?? null;

  /**
   * Everything a card, its menu or the drawer asks for. The two that open the drawer are
   * answered here: which record is on screen is the tab's own business, not the bridge's.
   */
  /**
   * Closed on the next tick, not in the press: a terminal that reports a press twice — two
   * mouse protocols, or a press and a release both read as one — sends the second while
   * the menu is still on screen, where the menu's backdrop takes it instead of the card
   * that was under the item.
   */
  const closeMenu = () => {
    queueMicrotask(() => setMenuOn(null));
  };
  const act = (command: Command) => {
    closeMenu();
    setToast(null);
    if (command._tag === "EditSetting") return setEditing({ key: command.key, typed: "" });
    if (command._tag === "OpenRecord") return setOpenId(command.id);
    if (command._tag === "OpenSteer") {
      setOpenId(command.id);
      return focusSteer();
    }
    props.dispatch(command);
  };

  /**
   * What the last command said it did. It goes when the human does anything else rather
   * than on a clock: a line that vanishes while it is being read says nothing, and this
   * file holds no runtime to time one with.
   */
  createEffect(() => setToast(props.state().note));

  const OVERFLOW: ReadonlyArray<MenuItem> = [
    { key: "", label: "Workflows", command: { _tag: "ShowView", view: "workflows" } },
    { key: "", label: "Settings", command: { _tag: "ShowView", view: "settings" } },
  ];
  const openOverflow = (at: Where = { x: dimensions().width - MENU_GAP, y: 1 }) =>
    setMenuOn({ items: OVERFLOW, at });

  const older = () => olderFinished(props.state().history, sections().finished, olderPages());
  const askForOlder = () => {
    setOlderPages((pages) => pages + 1);
    props.dispatch({ _tag: "ShowOlder" });
  };

  /** Which of Workflows and Settings is filling the pane, or null for the board. */
  const pane = (): ViewName | null => {
    const view = props.state().view;
    return view === "runs" ? null : view;
  };
  const toBoard = () => {
    setEditing(null);
    props.dispatch({ _tag: "ShowView", view: "runs" });
  };
  const press = (row: Row) => {
    const action = actionsFor(row, props.state().filter)[0];
    if (action !== undefined) act(action.command);
  };

  /**
   * Tab moves the keyboard on, through whatever is on screen: the board, the record over
   * it, and the one menu that leads off the board. It used to move between views, and
   * there are no views left to move between.
   */
  const onwards = () => {
    if (menuOn() !== null) return setMenuOn(null);
    if (openId() !== null && !steering()) return setSteering(true);
    setSteering(false);
    openOverflow();
  };

  /** Whether the document on screen was cut short, which is the one thing `m` acts on. */
  const cutShort = () => {
    const detail = props.state().detail;
    if (tab() === "review") return truncated(detail?.review);
    return tab() === "plan" && truncated(detail?.plan?.spec);
  };

  /** The keyboard is in one field at a time: taking it is taking it off the last one. */
  const focusSearch = () => {
    setTypingTo(null);
    setSteering(false);
    setSearching(true);
  };
  const focusAnswer = (question: Question) => {
    setSearching(false);
    setSteering(false);
    setTypingTo(draftKey(question));
  };
  const focusSteer = () => {
    setSearching(false);
    setTypingTo(null);
    setSteering(true);
  };

  const steerDraft = () => (openId() === null ? "" : (steers()[openId()!] ?? ""));
  const editSteer = (edit: (was: string) => string) => {
    const id = openId();
    if (id !== null) setSteers((was) => ({ ...was, [id]: edit(was[id] ?? "") }));
  };
  const sendSteer = () => {
    const view = open();
    const text = steerDraft().trim();
    if (view === null || text === "") return;
    setSteering(false);
    setSteers((was) => ({ ...was, [view.id]: "" }));
    props.dispatch({ _tag: "Steer", runId: view.run, text });
  };

  const draftKey = (question: Question) => `${question.run}:${question.id}`;
  const editDraft = (question: Question, edit: (was: string) => string) =>
    setDrafts((was) => ({ ...was, [draftKey(question)]: edit(was[draftKey(question)] ?? "") }));

  const decide: Decide = {
    answer: (question, value) => {
      if (value === "") return;
      setTypingTo(null);
      props.dispatch({ _tag: "Answer", runId: question.run, choiceId: question.id, value });
    },
    confirm: (proposal) =>
      props.dispatch({ _tag: "ConfirmProposal", id: proposal.id, hash: proposal.hash }),
    decline: (proposal) => props.dispatch({ _tag: "DeclineProposal", id: proposal.id }),
    approve: (gate, verifications) => {
      setCutting(null);
      props.dispatch({
        _tag: "Answer",
        runId: gate.run,
        choiceId: gate.id,
        value: verifications === null ? "approve" : `approve:${verifications.join(",")}`,
      });
    },
    skip: (gate) => {
      setCutting(null);
      props.dispatch({ _tag: "Answer", runId: gate.run, choiceId: gate.id, value: "skip" });
    },
    edit: (gate) => {
      const holding = tasks().find(
        (view) => view.decision?.kind === "gate" && view.decision.id === gate.id,
      );
      if (holding !== undefined) setOpenId(holding.id);
      setCutting({ id: gate.id, kept: gate.verifications });
    },
    draft: (question) => drafts()[draftKey(question)] ?? "",
    typing: (question) => typingTo() === draftKey(question),
    typeHere: focusAnswer,
  };

  /**
   * The stops the board is holding, as the one line they are worth. Until the grace is
   * up nothing has been sent, so this is what Undo takes back — and when it runs out the
   * bridge clears the marks and the command's own note takes this line's place.
   */
  const goingNote = () => {
    const going = props.state().stopping;
    if (going.length === 0) return null;
    if (going.length > 1) return `Stopped ${going.length} runs`;
    return `Stopped ${tasks().find((view) => view.run === going[0])?.name ?? going[0]}`;
  };

  const batch: Batch = {
    stopping: (view) => props.state().stopping.includes(view.run),
    picked: (view) => picked().has(view.id),
    onPick: (view) =>
      setPicked((was) => {
        const next = new Set(was);
        if (!next.delete(view.id)) next.add(view.id);
        return next;
      }),
  };

  /** What is picked, in the board's own order, and whether there is anything to stop. */
  const stoppable = (view: TaskView) =>
    menuFor(view).some((item) => item.command._tag === "StopRun");
  const pickedViews = () => tasks().filter((view) => picked().has(view.id));
  const stopPicked = () => {
    for (const view of pickedViews())
      if (stoppable(view)) props.dispatch({ _tag: "StopRun", runId: view.run });
    setPicked(new Set<string>());
  };

  /** The list the open record's gate is having cut down, where that is what is going on. */
  const cut = (): GateCut | null => {
    const gate = open()?.decision;
    const on = cutting();
    if (gate?.kind !== "gate" || on === null || on.id !== gate.id) return null;
    return {
      verifications: gate.verifications,
      kept: on.kept,
      // Rebuilt from the gate's own order, so the list reads as the gate wrote it.
      toggle: (name) =>
        setCutting((was) =>
          was === null
            ? was
            : {
                id: was.id,
                kept: was.kept.includes(name)
                  ? was.kept.filter((kept) => kept !== name)
                  : gate.verifications.filter((one) => was.kept.includes(one) || one === name),
              },
        ),
      approve: () => decide.approve(gate, on.kept),
      cancel: () => setCutting(null),
    };
  };

  /** The question the keyboard is in, while the board is still asking it. */
  const typingInto = (): Question | null => {
    const at = typingTo();
    if (at === null) return null;
    for (const view of tasks()) {
      const asked = view.decision;
      if (asked?.kind === "question" && draftKey(asked) === at) return asked;
    }
    return null;
  };

  /** The proposals a card carries: those are answered on the card, not over the board. */
  const carded = () =>
    new Set(
      tasks().flatMap((view) => (view.decision?.kind === "proposal" ? [view.decision.id] : [])),
    );

  /**
   * The proposal on screen, resolved from what is pending rather than from what was
   * drawn: a confirmation names an id and a hash, and one cached when the overlay opened
   * would consent to a payload that has since been superseded.
   */
  const previewing = () => {
    const id = props.state().previewing;
    if (id === null || carded().has(id)) return null;
    return props.state().live?.proposals.find((p) => p.id === id) ?? null;
  };
  /**
   * A proposal that has just appeared is put on screen. It is the one thing the board
   * does about a proposal on its own, and it takes no pane focus: nothing but a pending
   * question does.
   */
  let answered = new Set<string>();
  createEffect(() => {
    const onCards = carded();
    const pending = (props.state().live?.proposals ?? []).filter((p) => !onCards.has(p.id));
    const fresh = pending.find((p) => !answered.has(p.id));
    answered = new Set(pending.map((p) => p.id));
    if (fresh && untrack(() => props.state().previewing) === null) {
      props.dispatch({ _tag: "Preview", id: fresh.id });
    }
  });

  /** A paste is typing, so it goes to whichever field the keyboard is on. */
  usePasteInto((append) => {
    if (flow() !== null) return;
    const setting = editing();
    if (pane() !== null)
      return setting === null
        ? undefined
        : setEditing({ ...setting, typed: append(setting.typed) });
    if (steering()) return editSteer(append);
    const asked = typingInto();
    if (asked !== null) return editDraft(asked, append);
    if (searching()) setQuery(append);
  });

  useKeyboard((key: Keypress) => {
    // The inline launch flow is a question over the whole board: while it is asking,
    // `q` is a letter of the goal rather than the key that closes the tab.
    if (flow() !== null) return;
    setToast(null);
    if (helping()) return setHelping(false);
    if (key.name === "tab") return onwards();
    // A pane fills the board, so the board's own keys are not what is on screen.
    if (pane() !== null) return typeIntoSetting(key);
    // Above everything: a human answering a confirmation is answering it, and the keys
    // behind it act on cards they cannot see.
    const proposal = previewing();
    if (proposal !== null) {
      if (key.name === "return") {
        return props.dispatch({
          _tag: "ConfirmProposal",
          id: proposal.id,
          hash: proposal.content_hash,
        });
      }
      if (key.name === "escape")
        return props.dispatch({ _tag: "DeclineProposal", id: proposal.id });
      return;
    }
    // A menu is a question about what to do next: the keys beside its items are the
    // only ones it takes, and Esc is how it is left.
    const menu = menuOn();
    if (menu !== null) {
      if (key.name === "escape") return setMenuOn(null);
      const pressed = key.name === "return" ? "enter" : key.sequence;
      const item = menu.items.find((one) => one.key !== "" && one.key === pressed);
      return item === undefined ? undefined : act(item.command);
    }
    if (steering()) return typeIntoSteer(key);
    // Before the board's own keys: while a card is being typed into, `q` is a letter of
    // the answer and `/` is not the search.
    const asked = typingInto();
    if (asked !== null) return typeIntoAnswer(asked, key);
    if (searching()) return typeIntoSearch(key);
    if (key.name === "escape") {
      if (openId() !== null) return setOpenId(null);
      return setQuery("");
    }
    // The rest of a document the record cut short, a cap at a time.
    if (key.sequence === "m" && cutShort()) return props.dispatch({ _tag: "MoreReview" });
    if (key.sequence === "/") return focusSearch();
    if (key.sequence === "?") return setHelping(true);
    if (key.name === "q") return props.dispatch({ _tag: "Quit" });
    if (key.name === "r") return props.dispatch({ _tag: "Refresh" });
  });

  /**
   * A pane's keys. A setting is typed into from empty rather than amended: these are
   * short values, and Enter on an empty field is what unsets one.
   */
  const typeIntoSetting = (key: Keypress) => {
    const at = editing();
    if (at === null) return key.name === "escape" ? toBoard() : undefined;
    if (key.name === "escape") return setEditing(null);
    if (key.name === "return") {
      setEditing(null);
      return props.dispatch({ _tag: "SetDefault", key: at.key, value: at.typed });
    }
    if (key.name === "backspace") return setEditing({ ...at, typed: at.typed.slice(0, -1) });
    if (PRINTABLE.test(key.sequence)) setEditing({ ...at, typed: at.typed + key.sequence });
  };

  /** The same as an answer's field: Esc leaves it and keeps what was typed. */
  const typeIntoSteer = (key: Keypress) => {
    const id = openId();
    if (id === null) return setSteering(false);
    if (key.name === "escape") return setSteering(false);
    if (key.name === "return") return sendSteer();
    if (key.name === "backspace") return editSteer((was) => was.slice(0, -1));
    if (PRINTABLE.test(key.sequence)) editSteer((was) => was + key.sequence);
  };

  /** Esc leaves the field and keeps the draft; only sending it empties the card. */
  const typeIntoAnswer = (question: Question, key: Keypress) => {
    if (key.name === "escape") return setTypingTo(null);
    if (key.name === "return") return decide.answer(question, decide.draft(question).trim());
    if (key.name === "backspace") return editDraft(question, (was) => was.slice(0, -1));
    if (PRINTABLE.test(key.sequence)) editDraft(question, (was) => was + key.sequence);
  };

  /**
   * The search keeps what was typed when the keyboard leaves it: `/` narrows the board so
   * a card can then be clicked, so Enter stops typing and keeps the text; only Esc drops
   * it.
   */
  const typeIntoSearch = (key: Keypress) => {
    if (key.name === "escape") {
      setQuery("");
      return setSearching(false);
    }
    if (key.name === "return") return setSearching(false);
    if (key.name === "backspace") return setQuery((was) => was.slice(0, -1));
    if (PRINTABLE.test(key.sequence)) setQuery((was) => was + key.sequence);
  };

  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
      {/* The launch flow, inline: the same component the popup pane draws. */}
      <Show when={flow()}>
        <Flow pending={flow()!} />
      </Show>
      <Show when={flow() === null && pane() !== null}>
        <Pane
          title={pane() === "workflows" ? "Workflows" : "Settings"}
          rows={viewRows(props.state())}
          empty={emptyStateOf(pane()!)}
          editing={editing()}
          onPress={press}
          onClose={toBoard}
        />
      </Show>
      <Show when={flow() === null && pane() === null}>
        <box style={{ flexDirection: "row", flexGrow: 1 }}>
          <Board
            sections={sections()}
            columns={columns()}
            header={header()}
            logo={props.logo ?? null}
            query={query()}
            searching={searching()}
            onSearch={focusSearch}
            finishedOpen={finishedOpen()}
            open={openId()}
            onOpen={(view) => {
              setPicked(new Set<string>());
              setOpenId((was) => (was === view.id ? null : view.id));
            }}
            onMenu={(view, at) => setMenuOn({ items: menuFor(view), at })}
            onAct={act}
            older={older()}
            onOlder={askForOlder}
            onOverflow={openOverflow}
            decide={decide}
            batch={batch}
            onToggleFinished={() => setFinishedOpen((was) => !was)}
            waitingOlderOpen={waitingOlderOpen()}
            onToggleWaitingOlder={() => setWaitingOlderOpen((was) => !was)}
            now={props.state().now}
            width={dimensions().width}
            onNewRun={() => props.dispatch({ _tag: "OpenMode", mode: "pick" })}
            onClearQuery={() => setQuery("")}
          />
          {/* Over the board, never instead of it: reading one Task must not cost the
              overview of every other one. */}
          <Show when={open()}>
            <Drawer
              ref={setDrawer}
              view={open()!}
              detail={props.state().detail}
              live={props.state().live}
              tab={tab()}
              onTab={setTab}
              cut={cut()}
              onAct={act}
              steer={{
                text: steerDraft(),
                typing: steering(),
                onTypeHere: focusSteer,
                onSend: sendSteer,
              }}
              onClose={() => setOpenId(null)}
            />
          </Show>
        </box>
      </Show>
      {/* What a confirmation is consent to, over everything: a human answering one is
          answering it, and the keys behind it act on cards they cannot see. */}
      <Show when={previewing()}>
        <ProposalPreview proposal={previewing()!} />
      </Show>
      {/* What a selection can do that a card cannot: the same stop, once, for all of it. */}
      <Show when={picked().size > 1}>
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0, backgroundColor: C.line }}>
          <text fg={C.text}>{` ${picked().size} selected `}</text>
          {/* Absent where nothing picked can be stopped: a button that would do nothing
              is worse than no button. */}
          <Show when={pickedViews().some(stoppable)}>
            <text
              fg={C.amber}
              bg={C.strong}
              style={{ marginRight: 1 }}
              onMouseDown={() => stopPicked()}
            >
              {" Stop all "}
            </text>
          </Show>
          <Button label="Clear" onPress={() => setPicked(new Set())} />
        </box>
      </Show>
      <Show when={goingNote() ?? toast()}>
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0 }}>
          <text fg={C.text} bg={C.selected} style={{ flexGrow: 1 }}>
            {` ${goingNote() ?? toast()} `}
          </text>
          {/* Only while nothing has been sent: an undo offered after the fact would be
              a button that cannot do what it says. */}
          <Show when={goingNote() !== null}>
            <text
              fg={C.ground}
              bg={C.blue}
              onMouseDown={() => props.dispatch({ _tag: "UndoStop" })}
            >
              {" Undo "}
            </text>
          </Show>
        </box>
      </Show>
      <Show when={helping()}>
        <KeyHelp onClose={() => setHelping(false)} />
      </Show>
      <Show when={menuOn()}>
        <CardMenu
          items={menuOn()!.items}
          at={menuOn()!.at}
          pane={dimensions()}
          onAct={act}
          onClose={closeMenu}
        />
      </Show>
    </box>
  );
}
