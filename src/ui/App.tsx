import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import { createEffect, createMemo, createSignal, untrack, Show } from "solid-js";
import type { ScrollBoxRenderable } from "@opentui/core";
import { onBlur, onFocus, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/solid";
import {
  actionsFor,
  emptyStateOf,
  menuFor,
  mrChoices,
  olderFinished,
  runRowId,
  viewRows,
  type AppState,
  type Command,
  type Keypress,
  type MenuItem,
  type Row,
} from "./state";
import { usagePhrase } from "../usage-model";
import { headerSentence, sectionsOf, type Question, type TaskView } from "../board-model";
import { truncated } from "../views";
import { columnsFor, C } from "./sections";
import { Board, Button, CardMenu, KeyHelp, type Batch, type Decide, type Where } from "./Board";
import { Pane } from "./Pane";
import { Drawer, type Tab } from "./Drawer";
import { ProposalPreview } from "./live";
import { usePasteInto } from "./paste";
import { Flow } from "./Flow";
import type { Pending } from "./prompts";

const PRINTABLE = /^[\x20-\x7e]$/;
const MENU_GAP = 28;

export interface AppProps {
  state: () => AppState;
  pending?: () => Pending | null;
  dispatch: (command: Command) => void;
  logo?: string;
}

export function App(props: AppProps) {
  const renderer = useRenderer();
  const dimensions = useTerminalDimensions();
  const [query, setQuery] = createSignal("");
  const [searching, setSearching] = createSignal(false);
  const [openId, setOpenId] = createSignal<string | null>(null);
  const [tab, setTab] = createSignal<Tab>("summary");
  const [finishedOpen, setFinishedOpen] = createSignal(false);
  const [waitingOlderOpen, setWaitingOlderOpen] = createSignal(false);
  const [drawer, setDrawer] = createSignal<ScrollBoxRenderable>();
  const [drafts, setDrafts] = createSignal<Readonly<Record<string, string>>>({});
  const [typingTo, setTypingTo] = createSignal<string | null>(null);
  const [menuOn, setMenuOn] = createSignal<{
    items: ReadonlyArray<MenuItem>;
    at: Where;
    cursor?: number;
  } | null>(null);
  const [olderPages, setOlderPages] = createSignal(0);
  const [editing, setEditing] = createSignal<{
    key: string;
    typed: string;
    multiline: boolean;
  } | null>(null);
  const [picked, setPicked] = createSignal<ReadonlySet<string>>(new Set());
  const [steering, setSteering] = createSignal(false);
  const [steers, setSteers] = createSignal<Readonly<Record<string, string>>>({});
  const [toast, setToast] = createSignal<string | null>(null);
  const [helping, setHelping] = createSignal(false);

  // WARNING: mouse reporting only while focused: otherwise clicks in every other herdr pane lose copy and paste.
  onFocus(() => {
    renderer.useMouse = true;
  });
  onBlur(() => {
    renderer.useMouse = false;
  });

  const tasks = () => props.state().tasks;
  const sections = createMemo(() => sectionsOf(tasks(), query()));
  // WARNING: over every Task, not the search's results: a decision a query hides still waits on the human.
  const header = createMemo(() => headerSentence(tasks(), props.state().now));
  const usage = createMemo(() => usagePhrase(props.state().usage ?? [], props.state().now));
  const columns = () => columnsFor(dimensions().width, props.state().density);
  const open = () =>
    Option.getOrUndefined(Arr.findFirst(tasks(), (view) => view.id === openId())) ?? null;

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
    if (view?.unseen === true) props.dispatch({ _tag: "Acknowledge", runId: view.run });
  });

  createEffect(() => {
    openId();
    setSteering(false);
    setTab("summary");
  });

  createEffect(() => {
    openId();
    tab();
    drawer()?.scrollTo(0);
  });

  // WARNING: remembered rather than read back: the read lands a tick after the dispatch.
  let tailing = false;
  let showingArtefacts = false;
  createEffect(() => {
    const wanted = openId() !== null && tab() === "artefacts";
    if (wanted === showingArtefacts) return;
    showingArtefacts = wanted;
    props.dispatch({ _tag: "ToggleArtefacts" });
  });
  createEffect(() => {
    const wanted = openId() !== null && tab() === "log";
    if (wanted === tailing) return;
    tailing = wanted;
    props.dispatch({ _tag: "ToggleTail" });
  });

  const flow = () => props.pending?.() ?? null;

  // WARNING: closed on the next tick: a terminal reporting a press twice would hit the menu's backdrop instead.
  const closeMenu = () => {
    queueMicrotask(() => setMenuOn(null));
  };
  const act = (command: Command) => {
    const at = menuOn()?.at;
    closeMenu();
    setToast(null);
    if (command._tag === "ChooseMr")
      return queueMicrotask(() =>
        setMenuOn({ items: mrChoices(command), at: at ?? { x: MENU_GAP, y: 1 } }),
      );
    if (command._tag === "CopyLink") {
      renderer.copyToClipboardOSC52(command.url);
      return setToast(`copied ${command.url}`);
    }
    if (command._tag === "EditSetting")
      return setEditing({ key: command.key, typed: "", multiline: command.multiline });
    if (command._tag === "OpenRecord") return setOpenId(command.id);
    if (command._tag === "OpenSteer") {
      setOpenId(command.id);
      return focusSteer();
    }
    props.dispatch(command);
  };

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

  const pane = () => {
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

  const onwards = () => {
    if (menuOn() !== null) return setMenuOn(null);
    if (openId() !== null && !steering()) return setSteering(true);
    setSteering(false);
    openOverflow();
  };

  const cutShort = () => {
    const detail = props.state().detail;
    if (tab() === "review") return truncated(detail?.review);
    return tab() === "plan" && truncated(detail?.plan?.spec);
  };

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
    const text = Str.trim(steerDraft());
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
    decline: (proposal) =>
      props.dispatch({ _tag: "DeclineProposal", id: proposal.id, hash: proposal.hash }),
    draft: (question) => drafts()[draftKey(question)] ?? "",
    typing: (question) => typingTo() === draftKey(question),
    typeHere: focusAnswer,
  };

  const goingNote = () => {
    const going = props.state().stopping;
    if (going.length === 0) return null;
    if (going.length > 1) return `Stopped ${going.length} runs`;
    return `Stopped ${Option.getOrUndefined(Arr.findFirst(tasks(), (view) => view.run === going[0]))?.name ?? going[0]}`;
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

  const stoppable = (view: TaskView) =>
    Arr.some(menuFor(view), (item) => item.command._tag === "StopRun");
  const pickedViews = () => Arr.filter(tasks(), (view) => picked().has(view.id));
  const stopPicked = () => {
    for (const view of pickedViews())
      if (stoppable(view)) props.dispatch({ _tag: "StopRun", runId: view.run });
    setPicked(new Set<string>());
  };

  const typingInto = () => {
    const at = typingTo();
    if (at === null) return null;
    for (const view of tasks()) {
      const asked = view.decision;
      if (asked?.kind === "question" && draftKey(asked) === at) return asked;
    }
    return null;
  };

  const carded = () =>
    new Set(
      Arr.flatMap(tasks(), (view) =>
        view.decision?.kind === "proposal" ? [view.decision.id] : [],
      ),
    );

  // WARNING: resolved from what is pending, not what was drawn: a cached id and hash would consent to a superseded payload.
  const previewing = () => {
    const id = props.state().previewing;
    if (id === null || carded().has(id)) return null;
    return (
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(props.state().live), (present) =>
          Option.getOrUndefined(Arr.findFirst(present.proposals, (p) => p.id === id)),
        ),
      ) ?? null
    );
  };
  let answered = new Set<string>();
  createEffect(() => {
    const onCards = carded();
    const pending = Arr.filter(props.state().live?.proposals ?? [], (p) => !onCards.has(p.id));
    const fresh = Option.getOrUndefined(Arr.findFirst(pending, (p) => !answered.has(p.id)));
    answered = new Set(Arr.map(pending, (p) => p.id));
    if (fresh && untrack(() => props.state().previewing) === null) {
      props.dispatch({ _tag: "Preview", id: fresh.id });
    }
  });

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
    // WARNING: while a flow asks, q is a letter of the goal, not the close key.
    if (flow() !== null) return;
    setToast(null);
    if (helping()) return setHelping(false);
    if (key.name === "tab") return onwards();
    if (pane() !== null) return typeIntoSetting(key);
    // WARNING: above everything: a confirmation's keys must not act on cards the human cannot see.
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
        return props.dispatch({
          _tag: "DeclineProposal",
          id: proposal.id,
          hash: proposal.content_hash,
        });
      return;
    }
    const menu = menuOn();
    if (menu !== null) {
      if (key.name === "escape") return setMenuOn(null);
      if ((key.name === "up" || key.name === "down") && menu.items.length > 0) {
        const step = key.name === "down" ? 1 : -1;
        const cursor = menu.cursor ?? (step === 1 ? -1 : 0);
        return setMenuOn({
          ...menu,
          cursor: (cursor + step + menu.items.length) % menu.items.length,
        });
      }
      const pressed = key.name === "return" ? "enter" : key.sequence;
      const item =
        key.name === "return" && menu.cursor !== undefined
          ? menu.items[menu.cursor]
          : Option.getOrUndefined(
              Arr.findFirst(menu.items, (one) => one.key !== "" && one.key === pressed),
            );
      return item === undefined || item.disabled === true ? undefined : act(item.command);
    }
    if (steering()) return typeIntoSteer(key);
    // WARNING: before the board's keys: while typing, q is a letter and / is not the search.
    const asked = typingInto();
    if (asked !== null) return typeIntoAnswer(asked, key);
    if (searching()) return typeIntoSearch(key);
    if (key.name === "escape") {
      if (openId() !== null) return setOpenId(null);
      return setQuery("");
    }
    if (key.sequence === "m" && cutShort()) return props.dispatch({ _tag: "MoreReview" });
    if (key.sequence === "/") return focusSearch();
    if (key.sequence === "?") return setHelping(true);
    if (key.name === "q") return props.dispatch({ _tag: "Quit" });
    if (key.name === "r") return props.dispatch({ _tag: "Refresh" });
  });

  const typeIntoSetting = (key: Keypress) => {
    const at = editing();
    if (at === null) return key.name === "escape" ? toBoard() : undefined;
    if (key.name === "escape") return setEditing(null);
    if (key.name === "return" && key.meta === true && at.multiline)
      return setEditing({ ...at, typed: `${at.typed}\n` });
    if (key.name === "return") {
      setEditing(null);
      return props.dispatch({ _tag: "SetDefault", key: at.key, value: at.typed });
    }
    if (key.name === "backspace")
      return setEditing({ ...at, typed: pipe(at.typed, Str.slice(0, -1)) });
    if (PRINTABLE.test(key.sequence)) setEditing({ ...at, typed: at.typed + key.sequence });
  };

  const typeIntoSteer = (key: Keypress) => {
    const id = openId();
    if (id === null) return setSteering(false);
    if (key.name === "escape") return setSteering(false);
    if (key.name === "return") return sendSteer();
    if (key.name === "backspace") return editSteer((was) => pipe(was, Str.slice(0, -1)));
    if (PRINTABLE.test(key.sequence)) editSteer((was) => was + key.sequence);
  };

  const typeIntoAnswer = (question: Question, key: Keypress) => {
    if (key.name === "escape") return setTypingTo(null);
    if (key.name === "return") return decide.answer(question, Str.trim(decide.draft(question)));
    if (key.name === "backspace") return editDraft(question, (was) => pipe(was, Str.slice(0, -1)));
    if (PRINTABLE.test(key.sequence)) editDraft(question, (was) => was + key.sequence);
  };

  const typeIntoSearch = (key: Keypress) => {
    if (key.name === "escape") {
      setQuery("");
      return setSearching(false);
    }
    if (key.name === "return") return setSearching(false);
    if (key.name === "backspace") return setQuery((was) => pipe(was, Str.slice(0, -1)));
    if (PRINTABLE.test(key.sequence)) setQuery((was) => was + key.sequence);
  };

  return (
    <box style={{ flexDirection: "column", width: "100%", height: "100%" }}>
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
            usage={usage()}
            newer={props.state().newer ?? null}
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
          <Show when={open()}>
            <Drawer
              ref={setDrawer}
              view={open()!}
              detail={props.state().detail}
              artefacts={props.state().artefacts ?? null}
              artefactsError={props.state().artefactsError ?? null}
              live={props.state().live}
              tab={tab()}
              onTab={setTab}
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
      <Show when={previewing()}>
        <ProposalPreview proposal={previewing()!} />
      </Show>
      <Show when={picked().size > 1}>
        <box style={{ flexDirection: "row", height: 1, flexShrink: 0, backgroundColor: C.line }}>
          <text fg={C.text}>{` ${picked().size} selected `}</text>
          <Show when={Arr.some(pickedViews(), stoppable)}>
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
          cursor={menuOn()!.cursor ?? null}
          at={menuOn()!.at}
          pane={dimensions()}
          onAct={act}
          onClose={closeMenu}
        />
      </Show>
    </box>
  );
}
