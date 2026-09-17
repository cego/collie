// The record drawer: one Task's whole record, over the board rather than instead of it.
//
// Five tabs over one scrollbox. The division is what each answers: Summary is where the
// work has got to, Review is what was found, Plan is what it was judged against, Cards is
// the evidence, Log is the end of the runner's own output. One at a time, because the
// panel this replaced stacked all of them and a review was five screens down.
//
// Evidence and narrative must not look alike here either: Cards draws `src/lines.ts`, so
// a claim reads as `claimed:` and `missing` is always there, exactly as the Live region
// draws them.

import { createMemo, For, Show, type JSX } from "solid-js";
import { TextAttributes, type MouseEvent, type ScrollBoxRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import type { TaskView } from "../board";
import { truncated, type Panel, type PlanPanel, type RunDetail } from "../views";
import type { Live } from "../live";
import { sinceReview, type MrDetails, type MrPanel } from "../mr";
import {
  asText,
  cardLines,
  deliveryLine,
  driftLines,
  type Line as Evidence,
  type Tone,
} from "../lines";
import {
  dispositionsFor,
  markdownLines,
  menuFor,
  type Command,
  type LineStyle,
  type MenuItem,
} from "./state";
import { C, stateGlyph, stepGlyph } from "./sections";

/** What the record is being read for. One at a time, and Summary is where it opens. */
export type Tab = "summary" | "review" | "plan" | "cards" | "log";
export const TABS: ReadonlyArray<{ tab: Tab; label: string }> = [
  { tab: "summary", label: "Summary" },
  { tab: "review", label: "Review" },
  { tab: "plan", label: "Plan" },
  { tab: "cards", label: "Cards" },
  { tab: "log", label: "Log" },
];

/** The drawer's share of the board, and what it stops growing at on a wide pane. */
const SHARE = "60%";
const MAX = 72;

/**
 * A gate's list, being cut down. Here rather than on the card because a card is one
 * sentence and its answers: the list is the record's, and this is where it is read.
 */
export interface GateCut {
  verifications: ReadonlyArray<string>;
  kept: ReadonlyArray<string>;
  toggle: (name: string) => void;
  approve: () => void;
  cancel: () => void;
}

export interface DrawerProps {
  view: TaskView;
  /** The Run's own record, once it has been read; null while it is being. */
  detail: RunDetail | null;
  live: Live | null;
  tab: Tab;
  onTab: (tab: Tab) => void;
  /** What is being said to this Run's Driver, and whether the keyboard is in it. */
  steer: {
    text: string;
    typing: boolean;
    onTypeHere: () => void;
    onSend: () => void;
  };
  /** The gate's list being edited, where someone asked to edit it. */
  cut: GateCut | null;
  ref?: (box: ScrollBoxRenderable) => void;
  onAct: (command: Command) => void;
  onClose: () => void;
}

interface Line {
  text: string;
  mark?: string;
  markFg?: string;
  right?: string;
  fg?: string;
}

export function Drawer(props: DrawerProps) {
  const glyph = () => stateGlyph(props.view.state);
  /** The step durations the record knows, which the TaskView's own steps do not carry. */
  const took = () => new Map((props.detail?.steps ?? []).map((step) => [step.id, step.took ?? ""]));

  const intent = (): Line[] => {
    const held = props.detail?.intent;
    if (!held) return [{ text: "no intent recorded for this run", fg: C.dim }];
    return [
      { text: held.goal ?? "no goal recorded", mark: "›", markFg: C.blue },
      ...held.constraints.map((text) => ({ text, mark: "¬", markFg: C.amber, fg: C.muted })),
      ...(held.constraints.length > 0
        ? []
        : [{ text: "no constraints beyond the workspace defaults", fg: C.dim }]),
    ];
  };

  const steps = (): Line[] =>
    props.view.steps.map((step) => ({
      text: step.name,
      mark: stepGlyph(step.state).glyph,
      markFg: stepGlyph(step.state).fg,
      right: took().get(step.name) ?? "",
      fg: step.state === "todo" ? C.dim : C.text,
    }));

  const agents = (): Line[] =>
    props.view.agents.length === 0
      ? [{ text: "no live agent: the Driver holds this run", fg: C.dim }]
      : props.view.agents.map((agent) => ({
          text: `${agent.name} — ${agent.now ?? agent.status}`,
          mark: "●",
          markFg: C.blue,
        }));

  const held = (): Line[] =>
    props.view.heldBy === null
      ? []
      : [
          {
            text: `${props.view.held ?? "⏸ Held."} ${props.view.heldBy.by}: ${props.view.heldBy.reason}`,
            mark: "⏸",
            markFg: C.dim,
          },
        ];

  /** What a yes on this card would name, where the record is open beside it. */
  const proposed = (): Line[] => {
    const decision = props.view.decision;
    if (decision?.kind !== "proposal") return [];
    return [
      { text: decision.text },
      ...decision.actions.map((action) => ({
        text: `${action.text} · ${action.allowed ? "allowed now" : "needs your yes"}`,
        mark: action.allowed ? "✓" : "?",
        markFg: action.allowed ? C.muted : C.amber,
      })),
      { text: `${decision.id} · ${decision.hash}`, fg: C.dim },
    ];
  };

  const branch = (): Line[] => [
    { text: props.view.branch ?? "no branch of its own", mark: "⎇", markFg: C.dim },
  ];

  /**
   * The merge request behind the work: whether it is still open, whether its pipeline
   * passed, whether anyone is still arguing in it, and whether anything moved since the
   * review. The card's own line says only which one it is.
   */
  const mr = () => props.detail?.mr ?? null;

  const card = (): Line[] => {
    const newest = props.live?.cards[0];
    return newest === undefined ? [] : cardLines(newest).map((line) => ({ text: line.text }));
  };

  /** The card's own menu, as buttons, without the one that opens what is already open. */
  const buttons = (): MenuItem[] => [
    ...menuFor(props.view).filter((item) => item.command._tag !== "OpenRecord"),
    ...dispositionsFor(props.view),
  ];
  /** Steering a Run nothing is driving would be words nobody reads. */
  const steerable = () => menuFor(props.view).some((item) => item.label === "Steer…");

  return (
    <box
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: SHARE,
        maxWidth: MAX,
        flexDirection: "column",
        backgroundColor: C.pane,
        paddingLeft: 3,
        paddingRight: 3,
        paddingTop: 1,
        paddingBottom: 1,
        zIndex: 4,
      }}
      border
      borderColor={C.strong}
    >
      <box style={{ flexDirection: "row", flexShrink: 0 }}>
        <text fg={glyph().fg} attributes={TextAttributes.BOLD}>{`${glyph().glyph} `}</text>
        <text attributes={TextAttributes.BOLD} fg={C.text}>
          {props.view.name}
        </text>
        <box style={{ flexGrow: 1 }} />
        <Button label="Close" onPress={() => props.onClose()} />
      </box>
      {/* Nothing above the scroll area may shrink: the column would otherwise take the
          blank rows back from the header to make room for a long record below it. */}
      <text
        fg={C.dim}
        style={{ flexShrink: 0 }}
      >{`${props.view.project} · ${props.view.age}`}</text>
      <text fg={C.muted} style={{ marginTop: 1, flexShrink: 0 }}>
        {props.view.sentence}
      </text>

      <box
        style={{ flexDirection: "row", flexWrap: "wrap", flexShrink: 0, marginTop: 1, rowGap: 1 }}
      >
        {/* The decision is on the card this is drawn over, where its own buttons are. */}
        <Show when={props.view.decision !== null}>
          <Button label="Answer above" onPress={() => props.onClose()} />
        </Show>
        <For each={buttons()}>
          {(item) => <Button label={item.label} onPress={() => props.onAct(item.command)} />}
        </For>
      </box>

      <Show when={props.cut}>
        <box style={{ flexDirection: "column", flexShrink: 0 }}>
          <text fg={C.dim}>What proves this run</text>
          <For each={props.cut!.verifications}>
            {(name) => (
              <text
                fg={props.cut!.kept.includes(name) ? C.text : C.dim}
                onMouseDown={(event: MouseEvent) => {
                  event.stopPropagation();
                  props.cut!.toggle(name);
                }}
              >
                {`${props.cut!.kept.includes(name) ? "✓" : "○"} ${name}`}
              </text>
            )}
          </For>
          <box style={{ flexDirection: "row" }}>
            {/* Nothing kept is Skip by another name, and the gate refuses it. */}
            <Show when={props.cut!.kept.length > 0}>
              <Button label="Approve the list" onPress={() => props.cut!.approve()} />
            </Show>
            <Button label="Cancel" onPress={() => props.cut!.cancel()} />
          </box>
        </box>
      </Show>

      <box style={{ flexDirection: "row", flexShrink: 0, marginTop: 1 }}>
        <For each={TABS}>
          {(entry) => (
            <text
              fg={props.tab === entry.tab ? C.text : C.dim}
              bg={props.tab === entry.tab ? C.selected : undefined}
              attributes={props.tab === entry.tab ? TextAttributes.BOLD : undefined}
              onMouseDown={(event: MouseEvent) => {
                event.stopPropagation();
                props.onTab(entry.tab);
              }}
            >
              {` ${entry.label} `}
            </text>
          )}
        </For>
      </box>

      <scrollbox
        ref={props.ref}
        style={{ flexGrow: 1, backgroundColor: C.pane }}
        contentOptions={{ flexDirection: "column", backgroundColor: C.pane }}
      >
        <Show when={props.tab === "summary"}>
          <Show when={held().length > 0}>
            <Section title="held" lines={held()} />
          </Show>
          <Show when={proposed().length > 0}>
            <Section title="proposal" lines={proposed()} />
          </Show>
          <Section title="intent" lines={intent()} />
          <Section title="steps" lines={steps()} />
          <Section title="agents" lines={agents()} />
          <Section title="branch" lines={branch()} />
          <MergeRequest
            url={props.view.mr}
            panel={mr()}
            reviewedAt={props.detail?.finishedAt ?? 0}
          />
          <Show when={card().length > 0}>
            <Section title="latest card" lines={card()} />
          </Show>
        </Show>

        <Show when={props.tab === "review"}>
          <Document title="review" panel={props.detail?.review ?? null} />
        </Show>

        <Show when={props.tab === "plan"}>
          <Plan plan={props.detail?.plan ?? null} />
        </Show>

        <Show when={props.tab === "cards"}>
          <Cards live={props.live} />
        </Show>

        <Show when={props.tab === "log"}>
          <Document title="log" panel={props.detail?.tail ?? null} />
        </Show>
      </scrollbox>

      <Show when={steerable()}>
        <box style={{ flexDirection: "row", flexShrink: 0, marginTop: 1 }}>
          <text
            fg={props.steer.text === "" ? C.dim : C.text}
            bg={C.line}
            style={{ flexGrow: 1 }}
            onMouseDown={(event: MouseEvent) => {
              event.stopPropagation();
              props.steer.onTypeHere();
            }}
          >
            {` ${props.steer.text === "" ? "say something about this run" : props.steer.text}${
              props.steer.typing ? "▏" : ""
            }`}
          </text>
          <Show when={props.steer.text.trim() !== ""}>
            <Button label="Send" onPress={() => props.steer.onSend()} />
          </Show>
        </box>
      </Show>
    </box>
  );
}

/** One of the drawer's buttons. The press stops here: the board behind it is not asked. */
/** Two cells of padding and two between: at one, two filled labels read as one bar. */
function Button(props: { label: string; onPress: () => void }) {
  return (
    <text
      fg={C.text}
      bg={C.strong}
      style={{ marginRight: 2 }}
      onMouseDown={(event: MouseEvent) => {
        event.stopPropagation();
        props.onPress();
      }}
    >
      {`  ${props.label}  `}
    </text>
  );
}

/**
 * Every block of the drawer: a small capital title, a blank line above and below, and the
 * content set two cells in. One shape, so the summary's sections and the other tabs'
 * documents read as the same page.
 */
function Titled(props: { title: string; flush?: boolean; children: JSX.Element }) {
  return (
    <box style={{ flexDirection: "column", paddingTop: 1, paddingBottom: 1, flexShrink: 0 }}>
      <text fg={C.dim} attributes={TextAttributes.BOLD}>
        {props.title.toUpperCase()}
      </text>
      <box style={{ flexDirection: "column", paddingLeft: props.flush ? 0 : 2 }}>
        {props.children}
      </box>
    </box>
  );
}

function Section(props: { title: string; lines: ReadonlyArray<Line> }) {
  return (
    <Titled title={props.title} flush>
      <For each={props.lines}>
        {(line) => (
          <box style={{ flexDirection: "row" }}>
            <text fg={line.markFg ?? C.dim}>{`${line.mark ?? " "} `}</text>
            <text fg={line.fg ?? C.text} style={{ flexGrow: 1 }}>
              {line.text}
            </text>
            <Show when={line.right}>
              <text fg={C.dim}>{line.right}</text>
            </Show>
          </box>
        )}
      </For>
    </Titled>
  );
}

/**
 * A read document — the review, the plan's spec, the end of the log — one styled line at
 * a time. Flat text is what makes a review unskimmable, and a review readable without
 * splitting a pane is what the record is opened for.
 */
function Document(props: { title: string; panel: Panel | null }) {
  const panel = () => props.panel;
  return (
    <Titled title={props.title}>
      <Show
        when={panel()?._tag === "Text"}
        fallback={
          <text fg={C.dim}>
            {panel() === null ? `reading the ${props.title}…` : panelLine(panel()!)}
          </text>
        }
      >
        <Markdown text={panelLine(panel()!)} />
        <Show when={truncated(panel())}>
          <text fg={C.dim}>{"… truncated; m reads more of it"}</text>
        </Show>
      </Show>
    </Titled>
  );
}

/** What a panel shows: the text it read, or the one line saying why it has none. */
function panelLine(panel: Panel): string {
  return panel._tag === "Text" ? panel.text : panel.reason;
}

/** What each markdown line style is drawn in. Exhaustive, so a new style is a type error. */
const LINE_FG = {
  heading: C.blue,
  list: C.dim,
  code: C.dim,
  plain: C.text,
} satisfies Record<LineStyle, string>;

/**
 * Two memos, so the work stops at the text rather than at the render: the bridge replaces
 * the whole state every three seconds, and `markdownLines` returns a fresh array each
 * call — which reconciled every line of a cap's worth of review on each of those.
 */
function Markdown(props: { text: string }) {
  const text = createMemo(() => props.text);
  const lines = createMemo(() => markdownLines(text()));
  return (
    <For each={lines()}>
      {(line) => (
        <text
          fg={LINE_FG[line.style]}
          attributes={line.style === "heading" ? TextAttributes.BOLD : TextAttributes.NONE}
        >
          {line.text}
        </text>
      )}
    </For>
  );
}

/**
 * The plan a run is building from: the spec it was given, and each ticket with whether its
 * boxes are all checked. Enough to judge the work against its intent without leaving the
 * tab, which is what the review beside it is here for too.
 */
function Plan(props: { plan: PlanPanel | null }) {
  return (
    <Show
      when={props.plan !== null}
      fallback={
        <Titled title="plan">
          <text fg={C.dim}>{"no plan behind this run"}</text>
        </Titled>
      }
    >
      <Document title="spec" panel={props.plan!.spec} />
      <Titled title="tickets">
        <For each={props.plan!.tickets}>
          {(ticket) => (
            <text fg={ticket.done ? C.text : C.dim}>
              {`${ticket.done ? "✓" : "·"} ${ticket.title}`}
            </text>
          )}
        </For>
      </Titled>
    </Show>
  );
}

/** What each tone of an evidence line is drawn in, in the board's own palette. */
const TONES = {
  plain: C.text,
  dim: C.dim,
  bad: C.red,
  accent: C.blue,
} satisfies Record<Tone, string>;

function Evidenced(props: { lines: ReadonlyArray<Evidence> }) {
  return (
    <For each={props.lines}>
      {(entry) => (
        <text
          fg={TONES[entry.tone]}
          attributes={entry.tone === "accent" ? TextAttributes.BOLD : undefined}
        >
          {asText(entry)}
        </text>
      )}
    </For>
  );
}

/**
 * This Run's evidence: its cards, the drift nobody has settled, and what each message sent
 * to its agents actually reached. Drawn through `src/lines.ts` like the Live region, so a
 * claim can never be read as a pass and `missing` is always on screen.
 */
function Cards(props: { live: Live | null }) {
  const cards = () => props.live?.cards ?? [];
  const drift = () => props.live?.drift ?? [];
  const deliveries = () => props.live?.deliveries ?? [];
  return (
    <box style={{ flexDirection: "column" }}>
      <Titled title="cards">
        <Show when={cards().length > 0} fallback={<text fg={C.dim}>{"no cards yet"}</text>}>
          <For each={cards()}>{(card) => <Evidenced lines={cardLines(card)} />}</For>
        </Show>
      </Titled>
      <Show when={drift().length > 0}>
        <Titled title="drift">
          <For each={drift()}>{(report) => <Evidenced lines={driftLines(report)} />}</For>
        </Titled>
      </Show>
      <Titled title="sent to its agents">
        <Show
          when={deliveries().length > 0}
          fallback={<text fg={C.dim}>{"nothing has been sent to this run"}</text>}
        >
          <Evidenced lines={deliveries().map(deliveryLine)} />
        </Show>
      </Titled>
    </box>
  );
}

/**
 * The merge request behind a review: is it still open, did its pipeline pass, is anyone
 * still arguing in it, and — the line that decides whether to look again — has anything
 * moved since this review finished.
 */
function MergeRequest(props: { url: string | null; panel: MrPanel | null; reviewedAt: number }) {
  const details = () => (props.panel?._tag === "Details" ? props.panel : null);
  /**
   * The one line there is instead of the details: no merge request yet, no glab, no login,
   * or one nobody can read. The URL alone is what a Run has before its details are read.
   */
  const instead = () => {
    if (props.panel?._tag === "Unavailable") return props.panel.reason;
    if (props.url !== null) return props.url;
    return "no merge request yet — opened by the mr step";
  };
  return (
    <Titled title="merge request">
      <Show when={details() !== null} fallback={<text fg={C.dim}>{instead()}</text>}>
        <MergeRequestDetails mr={details()!} reviewedAt={props.reviewedAt} />
      </Show>
    </Titled>
  );
}

function MergeRequestDetails(props: { mr: MrDetails; reviewedAt: number }) {
  const renderer = useRenderer();
  const moved = () => sinceReview(props.mr, props.reviewedAt);
  return (
    <box style={{ flexDirection: "column" }}>
      <text fg={C.text}>{`!${props.mr.iid} · ${props.mr.title}`}</text>
      <text fg={C.dim}>{`${props.mr.state}${props.mr.author ? ` · ${props.mr.author}` : ""}`}</text>
      <text fg={C.dim}>
        {[
          props.mr.pipeline ? `pipeline ${props.mr.pipeline}` : "",
          props.mr.approvals,
          props.mr.unresolved ? "unresolved discussion(s)" : "",
          props.mr.notes > 0 ? `${props.mr.notes} note(s)` : "",
        ]
          .filter((part) => part !== "")
          .join(" · ")}
      </text>
      <Show when={moved() !== ""}>
        <text fg={props.mr.updatedAt > props.reviewedAt ? C.blue : C.dim}>{moved()}</text>
      </Show>
      {/* The URL is on screen and the pane owns the mouse while it is focused, so copying
          it is a press rather than a drag. */}
      <Show when={props.mr.url !== ""}>
        <Button label="Copy link" onPress={() => renderer.copyToClipboardOSC52(props.mr.url)} />
        <text fg={C.dim}>{props.mr.url}</text>
      </Show>
    </box>
  );
}
