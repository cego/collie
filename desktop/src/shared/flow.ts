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
  const row = flow.lanes.find((one) => one.run === run);
  if (row?.requestedBy != null)
    return { run: row.requestedBy.run, machine: row.requestedBy.machine.name };
  if (row?.startedBy !== undefined) return { run: row.startedBy.run, machine: row.machine };
  return null;
};
export const nodeName = (
  node: FlowRun,
  options: { missing?: boolean; notLive?: boolean; action?: string } = {},
): string =>
  [
    node.title,
    node.state.replaceAll("-", " "),
    node.state === "expected" ? null : node.said,
    options.missing ? "not on the board" : null,
    options.notLive && node.link?.asOf != null ? `as of ${node.link.asOf}` : null,
    options.action,
  ]
    .filter(Boolean)
    .join(", ");

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
  const rows = flowRows(flow).filter((row) => row.nodes.length > 0);
  let row = rows.findIndex((one) => one.run === focus.run);
  let at = rows[row]?.nodes.findIndex((one) => one.id === focus.node) ?? -1;
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
  Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(ms)
      .map((part) => [part.type, part.value]),
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
  const node = all.find((one) => one.id === selection.item) ?? parent;
  const lines: string[] = [];
  if (node.agent != null) lines.push(`Agent ${node.agent}`);
  if (node.ranOn !== null) lines.push([node.role, node.ranOn].filter(Boolean).join(" · "));
  if (node.started !== null) {
    lines.push(`Started ${when(node.started)}`);
  }
  const timing = stepTiming(node, now);
  if (timing !== null) lines.push(timing);
  if (node.ended !== null) lines.push(`Ended ${when(node.ended)}`);
  node.attempts
    .slice(1)
    .forEach((attempt, i) =>
      lines.push(`Attempt ${i + 2} · ${attempt.cause ?? "retried"} · ${when(attempt.at)}`),
    );
  for (const question of node.questions)
    if (question.answered !== null)
      lines.push(
        `Answered ${when(question.answered)}${question.by === null ? "" : ` by ${question.by}`}`,
      );
  const waves = [
    ...new Set(all.flatMap((one) => (one.wave === undefined ? [] : [one.wave]))),
  ].toSorted((one, other) => one - other);
  const entries: FlowEntry[] = waves.map((wave) => ({
    title: `Wave ${wave}`,
    nodes: all.filter((one) => one.wave === wave),
    folded: false,
    wave,
  }));
  const ungrouped = all.filter((one) => one.wave === undefined);
  const first = ungrouped.findIndex((one) => one.state !== "done");
  const count = first === -1 ? ungrouped.length : first;
  if (count > 1)
    entries.push({ title: `${count} done`, nodes: ungrouped.slice(0, count), folded: true });
  for (const one of ungrouped.slice(count > 1 ? count : 0))
    entries.push({ title: one.title, nodes: [one], folded: false });
  return {
    title: node.title,
    timing,
    state: node.state,
    said: node.said,
    description: node.description,
    lines,
    entries,
    node,
    open: openIn(node, owningRun(flow, selection)),
  };
};
export const flowRows = (flow: Flow) => [
  ...flow.lanes.map((lane) => ({
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
  flowRows(flow)
    .find((row) => row.run === spot.run)
    ?.nodes.find((node) => node.id === spot.node) ?? null;
export const owningRun = (flow: Flow, spot: FlowSpot) =>
  spot.run === "release" ? (flow.lanes.at(-1)?.run ?? spot.run) : spot.run;
const sameSpot = (one: FlowSpot | null, other: FlowSpot | null) =>
  one?.run === other?.run && one?.node === other?.node;
export const cardForLink = (node: FlowRun, cards: ReadonlyArray<FlowCard>) =>
  cards.find(
    (card) =>
      node.link?.run !== null &&
      node.link?.run !== undefined &&
      card.runs.includes(node.link.run) &&
      (node.link.machine === null || node.link.machine === card.machine),
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
  const node = [...parent.runs, ...(parent.links ?? [])].find((one) => one.id === item);
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
    return { kind: "offer", run: owningRun(flow, spot), offer: node.id.replace(/^offer:/, "") };
  return sameSpot(spot, selected)
    ? { kind: "close" }
    : { kind: "inspect", run: owningRun(flow, spot), selection: { ...spot, item: null } };
};
