import * as Num from "effect/Number";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Rec from "effect/Record";
import type { Flow, FlowNode, FlowRun } from "../../../src/board-model";
import { epochMs } from "../../../src/time";
import { stepTiming } from "./step-timing";
export interface FlowSpot {
  readonly run: string;
  readonly node: string;
}
export interface FlowSelection extends FlowSpot {
  readonly item: string | null;
}
export interface FlowCard {
  readonly key: string;
  readonly machine: string;
  readonly runs: ReadonlyArray<string>;
}
export const rowOrigin = (flow: Flow, run: string) => {
  const row = Option.getOrUndefined(Arr.findFirst(flow.lanes, (one) => one.run === run));
  if (row?.requestedBy != null)
    return { run: row.requestedBy.run, machine: row.requestedBy.machine.name };
  if (row?.startedBy !== undefined) return { run: row.startedBy.run, machine: row.machine };
  return null;
};
export const nodeName = (
  node: FlowRun,
  options: { missing?: boolean; notLive?: boolean; action?: string } = {},
): string =>
  Arr.join(
    Arr.map(
      Arr.filter(
        [
          node.title,
          pipe(node.state, Str.replaceAll("-", " ")),
          node.state === "expected" ? null : node.said,
          options.missing ? "not on the board" : null,
          options.notLive && node.link?.asOf != null ? `as of ${node.link.asOf}` : null,
          options.action,
        ],
        Boolean,
      ),
      (part) => (part === null || part === undefined ? "" : globalThis.String(part)),
    ),
    ", ",
  );

export const flowAnnouncements = (before: Flow | null, after: Flow): string[] => {
  if (before === null) return [];
  const messages = new Set<string>();
  if (!sameSpot(before.current, after.current) && after.current !== null) {
    const current = nodeAt(after, after.current);
    if (current !== null) messages.add(nodeName(current));
  }
  for (const row of flowRows(after))
    for (const node of row.nodes) {
      if (
        node.state === "needs-you" &&
        nodeAt(before, { run: row.run, node: node.id })?.state !== "needs-you"
      )
        messages.add(nodeName(node));
    }
  return [...messages];
};

export const flowKey = (
  flow: Flow,
  focus: FlowSpot,
  key: string,
  open: boolean,
  shift = false,
): {
  focus: FlowSpot;
  close: boolean;
  select: boolean;
  primary?: boolean;
  menu?: boolean;
} | null => {
  if (isFlowMenuKey(key, shift)) return { focus, close: false, select: false, menu: true };
  if (key === "Enter" && shift) return { focus, close: false, select: false, primary: true };
  const rows = Arr.filter(flowRows(flow), (row) => row.nodes.length > 0);
  let row = Option.getOrElse(
    Arr.findFirstIndex(rows, (one) => one.run === focus.run),
    () => -1,
  );
  let at =
    Option.getOrUndefined(
      Option.map(Option.fromNullishOr(rows[row]), (present) =>
        Option.getOrElse(
          Arr.findFirstIndex(present.nodes, (one) => one.id === focus.node),
          () => -1,
        ),
      ),
    ) ?? -1;
  if (row < 0 || at < 0) return null;
  switch (key) {
    case "ArrowLeft":
      at--;
      break;
    case "ArrowRight":
      at++;
      break;
    case "Home":
      at = 0;
      break;
    case "End":
      at = rows[row]!.nodes.length - 1;
      break;
    case "ArrowUp":
      row--;
      break;
    case "ArrowDown":
      row++;
      break;
    case "Enter":
      return { focus, close: false, select: true };
    case "Escape":
      return open ? { focus, close: true, select: false } : null;
    default:
      return null;
  }
  row = Math.max(0, Math.min(row, rows.length - 1));
  const target = rows[row]!;
  at = Math.max(0, Math.min(at, target.nodes.length - 1));
  return { focus: { run: target.run, node: target.nodes[at]!.id }, close: false, select: false };
};
export const isFlowMenuKey = (key: string, shift: boolean) =>
  key === "ContextMenu" || (key === "F10" && shift);
export interface FlowOpen {
  readonly run: string;
  readonly tab: "plan" | "review" | "evidence" | "mr" | "terminal" | "log";
}
export const openIn = (node: FlowRun, run: string): FlowOpen => {
  if (node.produces === "plan" || node.produces === "review") return { run, tab: node.produces };
  if (node.kind === "check" || node.produces === "evidence") return { run, tab: "evidence" };
  if (node.kind === "release" || node.produces === "merge-request") return { run, tab: "mr" };
  if (node.kind === "agent" && node.state === "running") return { run, tab: "terminal" };
  return { run, tab: "log" };
};

export type FlowEntry = {
  readonly title: string;
  readonly nodes: ReadonlyArray<FlowRun>;
  readonly folded: boolean;
  readonly wave?: number;
};
const dateParts = (ms: number, timeZone: string | undefined) =>
  Rec.fromEntries(
    Arr.map(
      new Intl.DateTimeFormat("en-GB", {
        timeZone,
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).formatToParts(ms),
      (part) => [part.type, part.value] as const,
    ),
  );

/** An instant on this Machine's clock: `11:22` today, `24 Oct, 11:22` on another day. */
export const whenOf = (iso: string, now: number, timeZone?: string): string => {
  const ms = epochMs(iso);
  if (Number.isNaN(ms)) return iso;
  const at = dateParts(ms, timeZone);
  const today = dateParts(now, timeZone);
  const time = `${at.hour}:${at.minute}`;
  if (at.year !== today.year) return `${at.day} ${at.month} ${at.year}, ${time}`;
  return at.month === today.month && at.day === today.day ? time : `${at.day} ${at.month}, ${time}`;
};

export interface StepFact {
  readonly label: string;
  readonly value: string;
}
const DURATION = /^(under a minute|\d+ min|\d+ h( \d+ min)?)$/;
/** The host's words for a Step, less what its timing and warning already say. */
const statusOf = (node: FlowRun, timing: string | null) =>
  Arr.join(
    [
      ...Arr.filter(
        Str.split(node.said ?? "", " · "),
        (part) =>
          part !== "" && !DURATION.test(part) && !(node.long && part === "Longer than usual"),
      ),
      ...(timing === null ? [] : [timing]),
    ],
    " · ",
  ) || null;
const factOf = (label: string, value: string | null | undefined): StepFact[] =>
  Option.match(Option.fromNullishOr(value), {
    onNone: () => [],
    onSome: (raw) => {
      const text = Str.trim(raw);
      return text === "" ? [] : [{ label, value: text }];
    },
  });
const factsOf = (node: FlowRun, when: (iso: string) => string): StepFact[] => [
  ...factOf("Role", node.role),
  ...factOf("Agent", node.agent),
  ...factOf("Model", node.ranOn),
  ...(node.started === null ? [] : [{ label: "Started", value: when(node.started) }]),
  ...(node.ended === null ? [] : [{ label: "Ended", value: when(node.ended) }]),
  ...Arr.map(node.attempts.slice(1), (attempt, i) => ({
    label: `Attempt ${i + 2}`,
    value: `${attempt.cause ?? "retried"} · ${when(attempt.at)}`,
  })),
  ...Arr.flatMap(node.questions, (question) =>
    question.answered === null
      ? []
      : [
          {
            label: "Answered",
            value: `${when(question.answered)}${question.by === null ? "" : ` by ${question.by}`}`,
          },
        ],
  ),
];

export const inspectorOf = (
  flow: Flow,
  selection: FlowSelection,
  now: number,
  timeZone?: string,
) => {
  const when = (iso: string) => whenOf(iso, now, timeZone);
  const parent = nodeAt(flow, selection);
  if (parent === null) return null;
  const all = [...parent.runs, ...(parent.links ?? [])];
  const node =
    Option.getOrUndefined(Arr.findFirst(all, (one) => one.id === selection.item)) ?? parent;
  const lines: string[] = [];
  if (node.agent != null) lines.push(`Agent ${node.agent}`);
  if (node.ranOn !== null)
    lines.push(
      Arr.join(
        Arr.map(Arr.filter([node.role, node.ranOn], Boolean), (part) =>
          part === null || part === undefined ? "" : globalThis.String(part),
        ),
        " · ",
      ),
    );
  if (node.started !== null) {
    lines.push(`Started ${when(node.started)}`);
  }
  const timing = stepTiming(node, now);
  if (timing !== null) lines.push(timing);
  if (node.ended !== null) lines.push(`Ended ${when(node.ended)}`);
  Arr.forEach(node.attempts.slice(1), (attempt, i) =>
    lines.push(`Attempt ${i + 2} · ${attempt.cause ?? "retried"} · ${when(attempt.at)}`),
  );
  for (const question of node.questions)
    if (question.answered !== null)
      lines.push(
        `Answered ${when(question.answered)}${question.by === null ? "" : ` by ${question.by}`}`,
      );
  const waves = Arr.sortWith(
    [...new Set(Arr.flatMap(all, (one) => (one.wave === undefined ? [] : [one.wave])))],
    (value) => value,
    (one, other) => Num.sign(one - other),
  );
  const entries: FlowEntry[] = Arr.map(waves, (wave) => ({
    title: `Wave ${wave}`,
    nodes: Arr.filter(all, (one) => one.wave === wave),
    folded: false,
    wave,
  }));
  const ungrouped = Arr.filter(all, (one) => one.wave === undefined);
  const first = Option.getOrElse(
    Arr.findFirstIndex(ungrouped, (one) => one.state !== "done"),
    () => -1,
  );
  const count = first === -1 ? ungrouped.length : first;
  if (count > 1)
    entries.push({ title: `${count} done`, nodes: ungrouped.slice(0, count), folded: true });
  for (const one of ungrouped.slice(count > 1 ? count : 0))
    entries.push({ title: one.title, nodes: [one], folded: false });
  return {
    title: node.title,
    state: node.state,
    said: node.said,
    status: statusOf(node, timing),
    purpose: Str.trim(node.description) || null,
    facts: factsOf(node, when),
    lines,
    entries,
    node,
    open: openIn(node, owningRun(flow, selection)),
  };
};
export const flowRows = (flow: Flow) => [
  ...Arr.map(flow.lanes, (lane) => ({
    ...lane,
    name: `${lane.title}, ${lane.run}, on ${lane.machine}, ${lane.execution}`,
  })),
  ...(flow.release === null
    ? []
    : [
        {
          run: "release",
          title: "Release",
          machine: flow.lanes.at(-1)?.machine ?? "",
          execution: "",
          requestedBy: null,
          startedBy: undefined,
          name: "Release",
          nodes: flow.release,
        },
      ]),
];
export const nodeAt = (flow: Flow, spot: FlowSpot): FlowNode | null =>
  Option.getOrUndefined(
    Option.map(
      Option.fromNullishOr(
        Option.getOrUndefined(Arr.findFirst(flowRows(flow), (row) => row.run === spot.run)),
      ),
      (present_) =>
        Option.getOrUndefined(Arr.findFirst(present_.nodes, (node) => node.id === spot.node)),
    ),
  ) ?? null;
export const owningRun = (flow: Flow, spot: FlowSpot) =>
  spot.run === "release" ? (flow.lanes.at(-1)?.run ?? spot.run) : spot.run;
const sameSpot = (one: FlowSpot | null, other: FlowSpot | null) =>
  one?.run === other?.run && one?.node === other?.node;
export const cardForLink = (node: FlowRun, cards: ReadonlyArray<FlowCard>) =>
  Option.getOrUndefined(
    Arr.findFirst(
      cards,
      (card) =>
        node.link?.run !== null &&
        node.link?.run !== undefined &&
        card.runs.includes(node.link.run) &&
        (node.link.machine === null || node.link.machine === card.machine),
    ),
  );

export type FlowPick =
  | { readonly kind: "none" | "close" }
  | { readonly kind: "inspect"; readonly run: string; readonly selection: FlowSelection }
  | { readonly kind: "open"; readonly card: string; readonly run: string }
  | { readonly kind: "offer"; readonly run: string; readonly offer: string };

export const selectEntry = (
  flow: Flow,
  selection: FlowSelection,
  item: string | null,
  cards: ReadonlyArray<FlowCard>,
): FlowPick => {
  const parent = nodeAt(flow, selection);
  if (parent === null) return { kind: "none" };
  const node = Option.getOrUndefined(
    Arr.findFirst([...parent.runs, ...(parent.links ?? [])], (one) => one.id === item),
  );
  if (node?.link !== undefined) {
    const card = cardForLink(node, cards);
    return card === undefined || node.link.run === null
      ? { kind: "none" }
      : { kind: "open", card: card.key, run: node.link.run };
  }
  return { kind: "inspect", run: owningRun(flow, selection), selection: { ...selection, item } };
};

export const selectNode = (
  flow: Flow,
  spot: FlowSpot,
  selected: FlowSelection | null,
  cards: ReadonlyArray<FlowCard>,
): FlowPick => {
  const node = nodeAt(flow, spot);
  if (node === null) return { kind: "none" };
  if (node.link !== undefined) {
    const card = cardForLink(node, cards);
    return card === undefined || node.link.run === null
      ? { kind: "none" }
      : { kind: "open", card: card.key, run: node.link.run };
  }
  if (node.kind === "offer")
    return {
      kind: "offer",
      run: owningRun(flow, spot),
      offer: pipe(node.id, Str.replace(/^offer:/, "")),
    };
  return sameSpot(spot, selected)
    ? { kind: "close" }
    : { kind: "inspect", run: owningRun(flow, spot), selection: { ...spot, item: null } };
};
