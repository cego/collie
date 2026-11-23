import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as Option from "effect/Option";
import { createEffect, createMemo, createResource, For, Show } from "solid-js";
import type { JSX } from "solid-js";
import { TextAttributes } from "@opentui/core";
import type { MouseEvent, ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/solid";
import { ranOn, requestedByLine, mrReadiness, mrTarget, mrWords, readMrRef } from "../board-model";
import type { MrDetails, MrPanel, Panel, PlanPanel, RunDetail, TaskView } from "../board-model";
import { truncated } from "../views";
import type { Live } from "../live";
import { sinceReview } from "../mr";
import { asText, cardLines, deliveryLine, driftLines } from "../lines";
import type { Line as Evidence, Tone } from "../lines";
import { dispositionsFor, menuFor } from "./state";
import type { Command } from "./state";
import { styledMarkdown } from "./markdown";
import { C, stateGlyph, stepGlyph } from "./sections";
import { handoffsDir } from "../handoffs";
import { replyLine } from "../replies";
import { PARK_CAUSES, parkLine } from "../park-cause";
import { artefactLines } from "../artefact-model";
import type { ArtefactCollection } from "../artefact-model";

const DRAWER_LINES = 8;

export type Tab = "summary" | "review" | "plan" | "cards" | "artefacts" | "log";
export const TABS: ReadonlyArray<{ tab: Tab; label: string }> = [
  { tab: "summary", label: "Summary" },
  { tab: "review", label: "Review" },
  { tab: "plan", label: "Plan" },
  { tab: "cards", label: "Cards" },
  { tab: "artefacts", label: "Artefacts" },
  { tab: "log", label: "Log" },
];

const SHARE = 0.6;
const MAX = 72;

export interface DrawerProps {
  view: TaskView;
  detail: RunDetail | null;
  artefacts?: ArtefactCollection | null;
  artefactsError?: string | null;
  live: Live | null;
  tab: Tab;
  onTab: (tab: Tab) => void;
  steer: {
    text: string;
    typing: boolean;
    onTypeHere: () => void;
    onSend: () => void;
  };
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
  const took = () =>
    new Map(Arr.map(props.detail?.steps ?? [], (step) => [step.id, step.took ?? ""]));

  const intent = () => {
    const held = props.detail?.intent;
    if (!held) return [{ text: "no intent recorded for this run", fg: C.dim }];
    return [
      { text: held.goal ?? "no goal recorded", mark: "›", markFg: C.blue },
      ...Arr.map(held.constraints, (text) => ({ text, mark: "¬", markFg: C.amber, fg: C.muted })),
      ...(held.constraints.length > 0
        ? []
        : [{ text: "no constraints beyond the workspace defaults", fg: C.dim }]),
    ];
  };

  const steps = () =>
    Arr.map(props.view.steps, (step) => ({
      text: step.name,
      mark: stepGlyph(step.state).glyph,
      markFg: stepGlyph(step.state).fg,
      right: took().get(step.name) ?? "",
      fg: step.state === "todo" ? C.dim : C.text,
    }));

  const requester = () => {
    const who = props.detail?.requestedBy;
    const started = props.detail?.startedBy;
    return [
      ...(started === undefined ? [] : [{ text: started }]),
      ...(who === undefined ? [] : [{ text: requestedByLine(who) }]),
    ];
  };
  const report = () => {
    const report = props.detail?.report;
    return report === undefined
      ? []
      : [{ text: `${report.state}: ${report.note}` }, { text: report.closure ?? "" }];
  };

  const agents = () =>
    props.view.agents.length === 0
      ? [{ text: "no live agent: the host holds this run", fg: C.dim }]
      : Arr.map(props.view.agents, (agent) => ({
          text: `${agent.name} — ${agent.now ?? agent.status}`,
          mark: "●",
          markFg: C.blue,
        }));

  const ranOnLines = () =>
    Arr.map(props.detail?.agents ?? [], (agent) => ({
      text: `${agent.operation}  ${ranOn(agent)}`,
      right: agent.agent,
      fg: C.muted,
    }));

  const held = () =>
    props.view.heldBy === null
      ? []
      : [
          {
            text: `${props.view.held ?? "⏸ Held."} ${props.view.heldBy.by}${props.view.heldBy.reason === "" ? "" : `: ${props.view.heldBy.reason}`}`,
            mark: "⏸",
            markFg: C.dim,
          },
        ];

  const parked = () => {
    const park = props.view.park;
    if (park == null) return [];
    const entry = PARK_CAUSES[park.cause];
    return [
      { text: parkLine(park), mark: "◆", markFg: C.amber },
      ...("reason" in entry ? [{ text: `Needs you: ${entry.reason}.`, fg: C.muted }] : []),
    ];
  };

  const proposed = () => {
    const decision = props.view.decision;
    if (decision?.kind !== "proposal") return [];
    return [
      { text: decision.text },
      ...Arr.map(decision.actions, (action) => ({
        text: `${action.text} · ${action.allowed ? "allowed now" : "needs your yes"}`,
        mark: action.allowed ? "✓" : "?",
        markFg: action.allowed ? C.muted : C.amber,
      })),
      { text: `${decision.id} · ${decision.hash}`, fg: C.dim },
    ];
  };

  const attached = () =>
    Arr.map(props.detail?.attachments ?? [], (file) => ({
      text: `${props.detail!.dir}/attachments/${file.name}`,
      mark: "•",
      right: `${file.size} bytes`,
    }));

  const handedOn = () =>
    Arr.map(props.detail?.handoffFiles ?? [], (file) => ({
      text: `${handoffsDir(props.detail!.dir)}/${file.name}`,
      mark: "•",
      right: `${file.bytes} bytes`,
    }));

  const replied = () =>
    Arr.flatMap(props.detail?.replies ?? [], (reply) => [
      { text: replyLine(reply), mark: reply.kind === "disputed" ? "!" : "•" },
      ...Arr.map(Str.split(reply.body, "\n"), (text) => ({
        text: `  ${text}`,
        mark: " ",
        fg: C.muted,
      })),
    ]);

  const branch = () => [
    { text: props.view.branch ?? "no branch of its own", mark: "⎇", markFg: C.dim },
  ];

  const mr = () => props.detail?.mr ?? null;
  const readinessOf = (id: string) => {
    const mrs = props.view.mrs ?? [];
    const one = Option.getOrUndefined(Arr.findFirst(mrs, (entry) => entry.id === id));
    return one === undefined ? null : mrReadiness(one, mrs);
  };

  const findings = () =>
    Arr.map(props.detail?.findings ?? [], (finding) => ({
      text: finding.title,
      mark: "•",
      right:
        finding.file === null
          ? finding.severity
          : `${finding.file}${finding.line === null ? "" : `:${finding.line}`}`,
    }));

  const changed = () =>
    Arr.map(props.detail?.diff?.files ?? [], (file) => ({
      text: file.path,
      mark: file.status === "added" ? "+" : file.status === "deleted" ? "-" : "~",
      right: file.added === null ? "binary" : `+${file.added} -${file.removed}`,
    }));

  const verified = () =>
    Arr.map(props.detail?.verifications ?? [], (one) => {
      const held = one.result === one.expect;
      return { text: one.name, mark: held ? "✓" : "✗", markFg: held ? C.green : C.red };
    });

  const card = () => {
    const newest = props.live?.cards[0];
    return newest === undefined ? [] : Arr.map(cardLines(newest), (line) => ({ text: line.text }));
  };

  const buttons = () => [
    ...Arr.filter(menuFor(props.view), (item) => item.command._tag !== "OpenRecord"),
    ...dispositionsFor(props.view),
  ];
  const steerable = () => Arr.some(menuFor(props.view), (item) => item.label === "Steer…");

  return (
    <box
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: `${SHARE * 100}%`,
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
      <text
        fg={C.dim}
        style={{ flexShrink: 0 }}
      >{`${props.view.project} · ${props.view.age}`}</text>
      <text fg={C.muted} style={{ marginTop: 1, flexShrink: 0 }}>
        {props.view.sentence}
      </text>
      <Show when={(props.view.check?.lastLines.length ?? 0) > 0}>
        <box style={{ flexDirection: "column", flexShrink: 0, marginTop: 1 }}>
          <For each={props.view.check!.lastLines.slice(-DRAWER_LINES)}>
            {(line) => <text fg={C.dim}>{line}</text>}
          </For>
        </box>
      </Show>

      <box
        style={{ flexDirection: "row", flexWrap: "wrap", flexShrink: 0, marginTop: 1, rowGap: 1 }}
      >
        <Show when={props.view.decision !== null}>
          <Button label="Answer above" onPress={() => props.onClose()} />
        </Show>
        <For each={buttons()}>
          {(item) => (
            <Button
              label={item.label}
              onPress={() => {
                if (item.disabled !== true) props.onAct(item.command);
              }}
            />
          )}
        </For>
      </box>

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
          <Show when={parked().length > 0}>
            <Section title="parked" lines={parked()} />
          </Show>
          <Show when={(props.view.recovery?.length ?? 0) > 0}>
            <Section
              title="recovery"
              lines={Arr.map(props.view.recovery ?? [], (text) => ({ text, fg: C.muted }))}
            />
          </Show>
          <Show when={proposed().length > 0}>
            <Section title="proposal" lines={proposed()} />
          </Show>
          <Show when={requester().length > 0}>
            <Section title="requester" lines={requester()} />
          </Show>
          <Show when={report().length > 0}>
            <Section title="report" lines={report()} />
          </Show>
          <Section title="intent" lines={intent()} />
          <Show when={attached().length > 0}>
            <Section title="attachments" lines={attached()} />
          </Show>
          <Show when={handedOn().length > 0}>
            <Section title="handoffs" lines={handedOn()} />
          </Show>
          <Show when={replied().length > 0}>
            <Section title="replies" lines={replied()} />
          </Show>
          <Section title="steps" lines={steps()} />
          <Section title="agents" lines={agents()} />
          <Show when={ranOnLines().length > 0}>
            <Section title="ran on" lines={ranOnLines()} />
          </Show>
          <Section title="branch" lines={branch()} />
          <Show
            when={(props.detail?.mrs ?? []).length > 1}
            fallback={
              <MergeRequest
                url={props.view.mr}
                panel={mr()}
                reviewedAt={props.detail?.finishedAt ?? 0}
              />
            }
          >
            <For each={props.detail?.mrs ?? []}>
              {(one) => (
                <MergeRequest
                  url={one.mr}
                  panel={one.panel}
                  readiness={readinessOf(one.id)}
                  reviewedAt={props.detail?.finishedAt ?? 0}
                  onOpen={(target) =>
                    props.onAct({ _tag: "OpenMr", target, runId: props.view.run })
                  }
                />
              )}
            </For>
          </Show>
          <Show when={card().length > 0}>
            <Section title="latest card" lines={card()} />
          </Show>
        </Show>

        <Show when={props.tab === "review"}>
          <Document title="review" panel={props.detail?.review ?? null} markdown />
          <Show when={findings().length > 0}>
            <Section title="findings" lines={findings()} />
          </Show>
          <Show when={changed().length > 0}>
            <Section title={props.detail?.diff?.live ? "changing" : "changed"} lines={changed()} />
          </Show>
          <Show when={verified().length > 0}>
            <Section title="verifications" lines={verified()} />
          </Show>
        </Show>

        <Show when={props.tab === "plan"}>
          <Plan plan={props.detail?.plan ?? null} />
        </Show>

        <Show when={props.tab === "cards"}>
          <Cards live={props.live} />
        </Show>
        <Show when={props.tab === "artefacts"}>
          <box style={{ flexDirection: "column", gap: 1 }}>
            <Show when={props.artefactsError}>
              <text fg={C.amber}>{props.artefactsError}</text>
            </Show>
            <Show when={props.artefacts === null && !props.artefactsError}>
              <text fg={C.dim}>Reading artefacts…</text>
            </Show>
            <For each={props.artefacts?.items ?? []}>
              {(item) => (
                <box style={{ flexDirection: "column" }}>
                  <For each={artefactLines(props.view.run, item).slice(0, 3)}>
                    {(line, index) =>
                      index() === 0 ? <text>{line}</text> : <text fg={C.dim}>{line}</text>
                    }
                  </For>
                  <box style={{ flexDirection: "row", gap: 1 }}>
                    <Button
                      label="Mark seen"
                      onPress={() =>
                        props.onAct({
                          _tag: "SeeArtefact",
                          runId: props.view.run,
                          id: item.id,
                          revision: item.revision,
                        })
                      }
                    />
                    <Button
                      label="Mark unseen"
                      onPress={() =>
                        props.onAct({
                          _tag: "SeeArtefact",
                          runId: props.view.run,
                          id: item.id,
                          revision: null,
                        })
                      }
                    />
                  </box>
                  <text fg={C.dim}>{artefactLines(props.view.run, item)[3]}</text>
                </box>
              )}
            </For>
          </box>
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
          <Show when={Str.trim(props.steer.text) !== ""}>
            <Button label="Send" onPress={() => props.steer.onSend()} />
          </Show>
        </box>
      </Show>
    </box>
  );
}

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

function Titled(props: { title: string; flush?: boolean; children: JSX.Element }) {
  return (
    <box style={{ flexDirection: "column", paddingTop: 1, paddingBottom: 1, flexShrink: 0 }}>
      <text fg={C.dim} attributes={TextAttributes.BOLD}>
        {Str.toUpperCase(props.title)}
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

function Document(props: { title: string; panel: Panel | null; markdown?: boolean }) {
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
        <Show when={props.markdown} fallback={<text fg={C.text}>{panelLine(panel()!)}</text>}>
          <Markdown text={panelLine(panel()!)} />
        </Show>
        <Show when={truncated(panel())}>
          <text fg={C.dim}>{"… truncated; m reads more of it"}</text>
        </Show>
      </Show>
    </Titled>
  );
}

function panelLine(panel: Panel) {
  return panel._tag === "Text" ? panel.text : panel.reason;
}

const INSET = 8;

function Markdown(props: { text: string }) {
  const terminal = useTerminalDimensions();
  const text = createMemo(() => props.text);
  const width = createMemo(() => Math.min(Math.floor(terminal().width * SHARE), MAX) - INSET);
  const [styled] = createResource(
    () => ({ text: text(), width: width() }),
    (to) => styledMarkdown(to.text, to.width),
  );
  let node: TextRenderable | undefined;
  createEffect(() => {
    if (node) node.content = (styled.state === "ready" && styled()) || text();
  });
  return (
    <text
      ref={(renderable) => {
        node = renderable;
      }}
      fg={C.text}
    />
  );
}

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
      <Document title="spec" panel={props.plan!.spec} markdown />
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
          <Evidenced lines={Arr.map(deliveries(), deliveryLine)} />
        </Show>
      </Titled>
    </box>
  );
}

function MergeRequest(props: {
  url: string | null;
  panel: MrPanel | null;
  reviewedAt: number;
  readiness?: string | null;
  onOpen?: (target: string) => void;
}) {
  const details = () => (props.panel?._tag === "Details" ? props.panel : null);
  const instead = () => {
    if (props.panel?._tag === "Unavailable") return props.panel.reason;
    if (props.url !== null) return props.url;
    return "no merge request yet — opened by the mr step";
  };
  const ref = () => (props.url === null ? null : readMrRef(props.url));
  return (
    <Titled title={ref() === null ? "merge request" : mrWords(ref()!).noun}>
      <Show when={props.readiness}>
        <text fg={C.muted}>{props.readiness}</text>
      </Show>
      <Show when={details() !== null} fallback={<text fg={C.dim}>{instead()}</text>}>
        <MergeRequestDetails mr={details()!} reviewedAt={props.reviewedAt} onOpen={props.onOpen} />
      </Show>
    </Titled>
  );
}

function MergeRequestDetails(props: {
  mr: MrDetails;
  reviewedAt: number;
  onOpen?: ((target: string) => void) | undefined;
}) {
  const renderer = useRenderer();
  const moved = () => sinceReview(props.mr, props.reviewedAt);
  const words = () => mrWords(props.mr);
  return (
    <box style={{ flexDirection: "column" }}>
      <text fg={C.text}>{`${words().sign}${props.mr.iid} · ${props.mr.title}`}</text>
      <text fg={C.dim}>{`${props.mr.state}${props.mr.author ? ` · ${props.mr.author}` : ""}`}</text>
      <text fg={C.dim}>
        {Arr.join(
          Arr.filter(
            [
              props.mr.pipeline ? `${words().checks} ${props.mr.pipeline}` : "",
              props.mr.approvals,
              props.mr.unresolved ? "unresolved discussion(s)" : "",
              props.mr.notes > 0 ? `${props.mr.notes} note(s)` : "",
            ],
            (part) => part !== "",
          ),
          " · ",
        )}
      </text>
      <Show when={moved() !== ""}>
        <text fg={props.mr.updatedAt > props.reviewedAt ? C.blue : C.dim}>{moved()}</text>
      </Show>
      <Show when={props.onOpen !== undefined}>
        <Button
          label={`Open ${words().sign}${props.mr.iid}`}
          onPress={() => props.onOpen?.(mrTarget(props.mr.project, props.mr.iid))}
        />
      </Show>
      <Show when={props.mr.url !== ""}>
        <Button label="Copy link" onPress={() => renderer.copyToClipboardOSC52(props.mr.url)} />
        <text fg={C.dim}>{props.mr.url}</text>
      </Show>
    </box>
  );
}
