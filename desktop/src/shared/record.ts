import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { mrWords, readMrRef, type RecordPart, type RunDetail } from "../../../src/board-model";
import { mrTab } from "./links";
import type { Target } from "./board-clicks";
import { parkLine } from "../../../src/park-cause";
import { stringifyJson } from "../../../src/json";

export const recoveryOf = (facts: Pick<RunDetail, "park" | "recovery">, limit = 20) => ({
  park: facts.park == null ? null : parkLine(facts.park),
  history: (facts.recovery ?? []).slice(-limit),
});

export interface TabFacts {
  readonly flow?: boolean;
  readonly loaded: boolean;
  readonly plan: boolean;
  readonly reviewText: boolean;
  readonly findings: boolean;
  readonly target: boolean;
  readonly diff: boolean;
  readonly terminal: boolean;
  readonly mr: string | null;
  readonly mrs?: ReadonlyArray<Tab>;
  readonly pending?: ReadonlyArray<RecordPart>;
}

export interface Tab {
  readonly label: string;
  readonly value: string;
  readonly loading?: true;
}

export const recordTabs = (facts: TabFacts) => {
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

export const mrTabsOf = (mrs: RunDetail["mrs"]) =>
  mrs === undefined || mrs.length < 2
    ? []
    : Arr.map(mrs, ({ id, mr }) => {
        const ref = readMrRef(mr) ?? readMrRef(`mr:${id}`);
        return {
          label: ref === null ? mrTab(mr) : `${mrTab(mr)} ${mrWords(ref).short}`,
          value: `mr:${id}`,
        };
      });

export const tabShown = (tabs: ReadonlyArray<Tab>, chosen: string | undefined) =>
  (Option.getOrUndefined(Arr.findFirst(tabs, ({ value }) => value === chosen)) ?? tabs[0]!).value;

export type ScrollMemory = ReadonlyMap<string, number>;

const UNSCROLLED = "terminal";

export const rememberScroll = (memory: ScrollMemory, tab: string, position: number) =>
  tab === UNSCROLLED ? memory : new Map(memory).set(tab, position);

export const scrollToRestore = (memory: ScrollMemory, tab: string) =>
  tab === UNSCROLLED ? null : (memory.get(tab) ?? 0);

// WARNING: visited tabs stay mounted, so what was opened in them is there on return.
export const tabsKept = (kept: ReadonlySet<string>, shown: string) =>
  shown === UNSCROLLED || shown === "log" || kept.has(shown) ? kept : new Set(kept).add(shown);

export const videoPlays = (tab: string | undefined) => tab === "evidence" || tab === "artefacts";

export interface LogPlace {
  readonly top: number;
  readonly following: boolean;
}

export const FOLLOWING_LOG: LogPlace = { top: 0, following: true };

export const logPlaceOf = ({
  scrollTop,
  clientHeight,
  scrollHeight,
}: {
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly scrollHeight: number;
}) => ({ top: scrollTop, following: scrollTop + clientHeight >= scrollHeight - 2 });

export const logScrollTop = (place: LogPlace, scrollHeight: number) =>
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

export const landingOf = (
  { file, line }: { readonly file: string; readonly line: number | null },
  diff: ReadonlyArray<string> | null,
) => {
  if (diff === null) return { tab: "review", at: "source", file, line };
  if (!diff.includes(file)) return { tab: "diff", at: "source", file, line };
  return line === null
    ? { tab: "diff", at: "file", file }
    : { tab: "diff", at: "line", file, line };
};

// WARNING: skips Terminal, whose pane keeps the keys.
export const tabBeside = (tabs: ReadonlyArray<Tab>, shown: string, step: 1 | -1) => {
  const stops = Arr.filter(tabs, ({ value }) => value !== UNSCROLLED || value === shown);
  const at = Option.getOrElse(
    Arr.findFirstIndex(stops, ({ value }) => value === shown),
    () => -1,
  );
  return at === -1 ? null : (stops[at + step]?.value ?? null);
};

export interface KeyFacts {
  readonly key: string;
  readonly ctrlOrMeta: boolean;
  readonly inField: boolean;
  readonly overlay: boolean;
  readonly tab: string;
  readonly inRecord: boolean;
}

export type KeyAction = "previous-tab" | "next-tab" | "next-file" | "previous-file";

export const keyAction = (facts: KeyFacts) => {
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

// WARNING: inside a shadow root the event target is only its host, so read the composed path.
export const typedIn = (composedPath: ReadonlyArray<Target>) => composedPath[0] ?? null;

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

export const summaryOf = (detail: SummaryFacts) => {
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

export const timingLine = (
  settings: { readonly recordTiming?: boolean | undefined },
  mark: { readonly name: string; readonly at: number; readonly card: string },
) => (settings.recordTiming === true ? `${stringifyJson(mark)}\n` : null);

const SCROLL_SETTLED_MS = 150;

// WARNING: a frame's callbacks run before its paint, so `then` must wait for the next frame.
export const afterPaint = (frame: (callback: () => void) => void, then: () => void) =>
  frame(() => frame(then));

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
    scrolled: (view: string, at: number) => {
      if (scroll !== null) {
        scroll.last = at;
        return false;
      }
      scroll = { card: `${view}:${++scrolls}`, last: at };
      return true;
    },
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
