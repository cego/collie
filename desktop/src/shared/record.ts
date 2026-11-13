// A Task's record: its tabs, the one shown, each tab's place and the Log's, where a jump lands,
// its keys, and what its Summary says.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { mrWords, readMrRef, type RecordPart, type RunDetail } from "../../../src/board-model";
import { mrTab } from "./links";
import type { Target } from "./board-clicks";
import { parkLine } from "../../../src/park-cause";

export const recoveryOf = (facts: Pick<RunDetail, "park" | "recovery">, limit = 20) => ({
  park: facts.park == null ? null : parkLine(facts.park),
  history: (facts.recovery ?? []).slice(-limit),
});

export interface TabFacts {
  readonly flow?: boolean;
  /** Whether the Run's details are loaded; every tab but Log, Terminal and Facts needs them. */
  readonly loaded: boolean;
  readonly plan: boolean;
  readonly reviewText: boolean;
  readonly findings: boolean;
  /** A followed location, which Review shows read-only where there is no diff. */
  readonly target: boolean;
  readonly diff: boolean;
  readonly terminal: boolean;
  /** The merge request's tab label, where there is one. */
  readonly mr: string | null;
  /** A tab for each of several merge requests, in place of `mr`'s. */
  readonly mrs?: ReadonlyArray<Tab>;
  /** The parts the host is still sending: each one's tab is shown loading until it comes. */
  readonly pending?: ReadonlyArray<RecordPart>;
}

export interface Tab {
  readonly label: string;
  readonly value: string;
  readonly loading?: true;
}

export const recordTabs = (facts: TabFacts): Array<Tab> => {
  const loaded = facts.loaded;
  const coming = (part: RecordPart) => loaded && (facts.pending ?? []).includes(part);
  const present: ReadonlyArray<readonly [boolean, Tab, RecordPart?]> = [
    [loaded && facts.flow === true, { label: "Flow", value: "flow" }],
    [loaded, { label: "Summary", value: "summary" }],
    [loaded && facts.plan, { label: "Plan", value: "plan" }, "texts"],
    [
      loaded && (facts.reviewText || facts.findings || facts.target),
      { label: "Review", value: "review" },
      "texts",
    ],
    [loaded && facts.diff, { label: "Diff", value: "diff" }, "diff"],
    [loaded, { label: "Evidence", value: "evidence" }],
    [loaded, { label: "Artefacts", value: "artefacts" }],
    [true, { label: "Log", value: "log" }, "tail"],
    [facts.terminal, { label: "Terminal", value: "terminal" }],
    ...(facts.mrs !== undefined && facts.mrs.length > 0
      ? Arr.map(facts.mrs, (tab) => [loaded, tab] as const)
      : [[loaded && facts.mr !== null, { label: facts.mr ?? "", value: "mr" }, "mr"] as const]),
    [true, { label: "Facts", value: "facts" }],
  ];
  return Arr.flatMap(present, ([shown, tab, part]) =>
    part !== undefined && coming(part) ? [{ ...tab, loading: true as const }] : shown ? [tab] : [],
  );
};

/** A tab per merge request where the record has several, by its MR id; none otherwise. */
export const mrTabsOf = (mrs: RunDetail["mrs"]): ReadonlyArray<Tab> =>
  mrs === undefined || mrs.length < 2
    ? []
    : Arr.map(mrs, ({ id, mr }) => {
        const ref = readMrRef(mr) ?? readMrRef(`mr:${id}`);
        return {
          label: ref === null ? mrTab(mr) : `${mrTab(mr)} ${mrWords(ref).short}`,
          value: `mr:${id}`,
        };
      });

/** The chosen tab while it is present, else the first. */
export const tabShown = (tabs: ReadonlyArray<Tab>, chosen: string | undefined): string =>
  (Option.getOrUndefined(Arr.findFirst(tabs, ({ value }) => value === chosen)) ?? tabs[0]!).value;

/** Each tab's scroll position, by the tab's value, while the record is open. */
export type ScrollMemory = ReadonlyMap<string, number>;

/** Terminal fills the record and has no position of its own. */
const UNSCROLLED = "terminal";

export const rememberScroll = (
  memory: ScrollMemory,
  tab: string,
  position: number,
): ScrollMemory => (tab === UNSCROLLED ? memory : new Map(memory).set(tab, position));

/** The position to show a tab at, 0 on its first visit; null for Terminal. */
export const scrollToRestore = (memory: ScrollMemory, tab: string): number | null =>
  tab === UNSCROLLED ? null : (memory.get(tab) ?? 0);

/** Every tab visited, kept mounted so what was opened in it is there on return. */
export const tabsKept = (kept: ReadonlySet<string>, shown: string): ReadonlySet<string> =>
  shown === UNSCROLLED || shown === "log" || kept.has(shown) ? kept : new Set(kept).add(shown);

export const videoPlays = (tab: string | undefined): boolean =>
  tab === "evidence" || tab === "artefacts";

/** Where the Log's own lines are scrolled, kept while the record is open. */
export interface LogPlace {
  readonly top: number;
  readonly following: boolean;
}

export const FOLLOWING_LOG: LogPlace = { top: 0, following: true };

/** Followed to its end unless the human scrolled up to read. */
export const logPlaceOf = ({
  scrollTop,
  clientHeight,
  scrollHeight,
}: {
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
}): LogPlace => ({ top: scrollTop, following: scrollTop + clientHeight >= scrollHeight - 2 });

export const logScrollTop = (place: LogPlace, scrollHeight: number): number =>
  place.following ? scrollHeight : place.top;

export type Landing =
  | { readonly tab: "diff"; readonly at: "line"; readonly file: string; readonly line: number }
  | { readonly tab: "diff"; readonly at: "file"; readonly file: string }
  | {
      readonly tab: "diff" | "review";
      readonly at: "source";
      readonly file: string;
      readonly line: number | null;
    };

/** `diff` is the paths of the diff's files, or null where the Run has no diff. */
export const landingOf = (
  { file, line }: { readonly file: string; readonly line: number | null },
  diff: ReadonlyArray<string> | null,
): Landing => {
  if (diff === null) return { tab: "review", at: "source", file, line };
  if (!diff.includes(file)) return { tab: "diff", at: "source", file, line };
  return line === null
    ? { tab: "diff", at: "file", file }
    : { tab: "diff", at: "line", file, line };
};

/** The tab one step from the one shown, skipping Terminal, whose pane keeps the keys. */
export const tabBeside = (tabs: ReadonlyArray<Tab>, shown: string, step: 1 | -1): string | null => {
  const stops = Arr.filter(tabs, ({ value }) => value !== UNSCROLLED || value === shown);
  const at = Option.getOrElse(
    Arr.findFirstIndex(stops, ({ value }) => value === shown),
    () => -1,
  );
  return at === -1 ? null : (stops[at + step]?.value ?? null);
};

export interface KeyFacts {
  /** The character typed, which Alt or AltGr may have made. */
  readonly key: string;
  readonly ctrlOrMeta: boolean;
  readonly inField: boolean;
  readonly overlay: boolean;
  readonly tab: string;
  /** Whether focus is in the record, or on nothing. */
  readonly inRecord: boolean;
}

export type KeyAction = "previous-tab" | "next-tab" | "next-file" | "previous-file";

export const keyAction = (facts: KeyFacts): KeyAction | null => {
  if (facts.ctrlOrMeta || facts.inField || facts.overlay || !facts.inRecord) return null;
  if (facts.tab === UNSCROLLED) return null;
  const onDiff = facts.tab === "diff";
  switch (facts.key) {
    case "[":
      return "previous-tab";
    case "]":
      return "next-tab";
    case "j":
      return onDiff ? "next-file" : null;
    case "k":
      return onDiff ? "previous-file" : null;
    default:
      return null;
  }
};

/**
 * The element a key was typed in, from the event's composed path with each entry that is not an
 * element as null: inside a shadow root the event's target is only its host.
 */
export const typedIn = (composedPath: ReadonlyArray<Target>): Target => composedPath[0] ?? null;

export type SummaryFacts = Pick<
  RunDetail,
  "status" | "attention" | "steps" | "inputs" | "replies"
> & {
  readonly outcome: Omit<RunDetail["outcome"], "metrics">;
};

type Outcome = SummaryFacts["outcome"];

export type SummarySection =
  | { readonly section: "status"; readonly status: string }
  | {
      readonly section: "attention";
      readonly category: RunDetail["attention"]["category"];
      readonly explanation: string;
    }
  | ({ readonly section: "outcome" } & Outcome)
  | { readonly section: "inputs"; readonly inputs: RunDetail["inputs"] }
  | { readonly section: "replies"; readonly replies: NonNullable<RunDetail["replies"]> };

const saysSomething = ({ kind, gaps, obstacle, next, delivered, measurement }: Outcome) =>
  gaps.length > 0 ||
  Arr.some([kind, obstacle, next, delivered, measurement ?? null], (said) => said !== null);

/** In order, each left out when it has nothing to say; the status always says something. */
export const summaryOf = (detail: SummaryFacts): ReadonlyArray<SummarySection> => {
  const { kind, gaps, obstacle, next, delivered } = detail.outcome;
  const measurement = detail.outcome.measurement ?? null;
  const { category, explanation } = detail.attention;
  return [
    { section: "status", status: detail.status },
    ...(category === "none" ? [] : [{ section: "attention", category, explanation } as const]),
    ...(saysSomething(detail.outcome)
      ? [{ section: "outcome", kind, gaps, obstacle, next, delivered, measurement } as const]
      : []),
    ...(detail.inputs.length === 0 ? [] : [{ section: "inputs", inputs: detail.inputs } as const]),
    ...(detail.replies === undefined || detail.replies.length === 0
      ? []
      : [{ section: "replies", replies: detail.replies } as const]),
  ];
};

export type RecordMark = "record:click" | "record:mounted" | "record:frame" | "record:usable";

/**
 * Marks each step of opening a card's record, from its click to a usable Flow, in order and
 * once each. A card no longer the one last clicked marks nothing more.
 */
export const recordTiming = (mark: (name: RecordMark, at: number, card: string) => void) => {
  let clicked: string | null = null;
  let reached: RecordMark | null = null;
  const after = (previous: RecordMark, next: RecordMark) => (card: string, at: number) => {
    if (card !== clicked || reached !== previous) return;
    reached = next;
    mark(next, at, card);
  };
  return {
    click: (card: string, at: number) => {
      clicked = card;
      reached = "record:click";
      mark("record:click", at, card);
    },
    mounted: after("record:click", "record:mounted"),
    frame: after("record:mounted", "record:frame"),
    usable: after("record:frame", "record:usable"),
  };
};

export type DesktopMark =
  | "launch"
  | "board-usable"
  | "terminal-key"
  | "terminal-drawn"
  | "chat-chunk"
  | "chat-drawn"
  | "frame";

/** The line a mark adds to record-timing.log, or null while Record timing is off. */
export const timingLine = (
  settings: { readonly recordTiming?: boolean | undefined },
  mark: { readonly name: string; readonly at: number; readonly card: string },
) => (settings.recordTiming === true ? `${JSON.stringify(mark)}\n` : null);

/** A scroll with no other this long after it has ended. */
const SCROLL_SETTLED_MS = 150;

/** Runs `then` once the change just made is painted; a frame's callbacks run before its paint. */
export const afterPaint = (frame: (callback: () => void) => void, then: () => void) =>
  frame(() => frame(then));

/**
 * Marks the board's first draw; a key or chat chunk and the first draw after it, with no
 * other start marked before that draw; and each frame of a scroll, named once per scroll.
 */
export const desktopTiming = (mark: (name: DesktopMark, at: number, card: string) => void) => {
  const answered = (start: DesktopMark, end: DesktopMark) => {
    let waiting: string | null = null;
    return {
      start: (card: string, at: number) => {
        if (waiting !== null) return;
        waiting = card;
        mark(start, at, card);
      },
      end: (at: number) => {
        if (waiting === null) return;
        mark(end, at, waiting);
        waiting = null;
      },
    };
  };
  const terminal = answered("terminal-key", "terminal-drawn");
  const chat = answered("chat-chunk", "chat-drawn");
  let boardDrawn = false;
  let scroll: { readonly card: string; last: number } | null = null;
  let scrolls = 0;
  return {
    boardUsable: (at: number) => {
      if (boardDrawn) return;
      boardDrawn = true;
      mark("board-usable", at, "");
    },
    key: terminal.start,
    echoed: terminal.end,
    chunk: chat.start,
    chatDrawn: chat.end,
    /** Whether this starts a scroll, whose frames are then to be watched. */
    scrolled: (view: string, at: number) => {
      if (scroll !== null) {
        scroll.last = at;
        return false;
      }
      scroll = { card: `${view}:${++scrolls}`, last: at };
      return true;
    },
    /** Whether the scroll goes on, so the next frame is watched too. */
    frame: (at: number) => {
      if (scroll === null) return false;
      if (at - scroll.last > SCROLL_SETTLED_MS) {
        scroll = null;
        return false;
      }
      mark("frame", at, scroll.card);
      return true;
    },
  };
};
