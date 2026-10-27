// A Task's record: its tabs, the one shown, each tab's place and the Log's, where a jump lands,
// its keys, and what its Summary says.

import type { RunDetail } from "../../../src/board-model";
import type { Target } from "./board-clicks";

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
}

export interface Tab {
  readonly label: string;
  readonly value: string;
}

export const recordTabs = (facts: TabFacts): Array<Tab> => {
  const loaded = facts.loaded;
  const present: ReadonlyArray<readonly [boolean, Tab]> = [
    [loaded && facts.flow === true, { label: "Flow", value: "flow" }],
    [loaded, { label: "Summary", value: "summary" }],
    [loaded && facts.plan, { label: "Plan", value: "plan" }],
    [
      loaded && (facts.reviewText || facts.findings || facts.target),
      { label: "Review", value: "review" },
    ],
    [loaded && facts.diff, { label: "Diff", value: "diff" }],
    [loaded, { label: "Evidence", value: "evidence" }],
    [true, { label: "Log", value: "log" }],
    [facts.terminal, { label: "Terminal", value: "terminal" }],
    [loaded && facts.mr !== null, { label: facts.mr ?? "", value: "mr" }],
    [true, { label: "Facts", value: "facts" }],
  ];
  return present.flatMap(([shown, tab]) => (shown ? [tab] : []));
};

/** The chosen tab while it is present, else the first. */
export const tabShown = (tabs: ReadonlyArray<Tab>, chosen: string | undefined): string =>
  (tabs.find(({ value }) => value === chosen) ?? tabs[0]!).value;

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

/** An Evidence video plays only where it can be seen. */
export const videoPlays = (tab: string | undefined): boolean => tab === "evidence";

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
  const stops = tabs.filter(({ value }) => value !== UNSCROLLED || value === shown);
  const at = stops.findIndex(({ value }) => value === shown);
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

const saysSomething = ({ kind, gaps, obstacle, next, delivered }: Outcome) =>
  gaps.length > 0 || [kind, obstacle, next, delivered].some((said) => said !== null);

/** In order, each left out when it has nothing to say; the status always says something. */
export const summaryOf = (detail: SummaryFacts): ReadonlyArray<SummarySection> => {
  const { kind, gaps, obstacle, next, delivered } = detail.outcome;
  const { category, explanation } = detail.attention;
  return [
    { section: "status", status: detail.status },
    ...(category === "none" ? [] : [{ section: "attention", category, explanation } as const]),
    ...(saysSomething(detail.outcome)
      ? [{ section: "outcome", kind, gaps, obstacle, next, delivered } as const]
      : []),
    ...(detail.inputs.length === 0 ? [] : [{ section: "inputs", inputs: detail.inputs } as const]),
    ...(detail.replies === undefined || detail.replies.length === 0
      ? []
      : [{ section: "replies", replies: detail.replies } as const]),
  ];
};
