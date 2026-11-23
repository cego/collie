import { For } from "solid-js";
import { TextAttributes } from "@opentui/core";
import type { Live } from "../live";
import type { ProposalRecord } from "../proposals";

import { asText, cardLines, deliveryLine, describeAction, driftLines, newsLines } from "../lines";
import type { Line, Tone } from "../lines";

const DIM = "#8a8a8a";
const ACCENT = "#7aa2f7";
const BAD = "#f7768e";

function Drawn(props: { line: Line }) {
  const colour = () => TONES[props.line.tone];
  return (
    <text
      style={{ height: 1 }}
      fg={colour()}
      attributes={props.line.tone === "accent" ? TextAttributes.BOLD : undefined}
    >
      {asText(props.line)}
    </text>
  );
}

const TONES = {
  plain: undefined,
  dim: DIM,
  bad: BAD,
  accent: ACCENT,
} satisfies Record<Tone, string | undefined>;

function Lines(props: { lines: ReadonlyArray<Line> }) {
  return <For each={props.lines}>{(entry) => <Drawn line={entry} />}</For>;
}

export function LiveRegion(props: { live: Live }) {
  const live = () => props.live;
  return (
    <box style={{ flexDirection: "column" }}>
      <Lines lines={newsLines(live().news)} />
      <For each={live().cards}>{(card) => <Lines lines={cardLines(card)} />}</For>
      <For each={live().drift}>{(report) => <Lines lines={driftLines(report)} />}</For>
      <For each={live().pending}>{(report) => <Lines lines={driftLines(report, true)} />}</For>
      <For each={live().deliveries}>{(delivery) => <Drawn line={deliveryLine(delivery)} />}</For>
    </box>
  );
}

function Note(props: { text: string; tone?: Tone }) {
  return (
    <text style={{ height: 1 }} fg={TONES[props.tone ?? "dim"]}>
      {props.text}
    </text>
  );
}

export function ProposalPreview(props: { proposal: ProposalRecord }) {
  const proposal = () => props.proposal;
  const allowed = () => new Set(proposal().allowed_now);
  const height = () => 5 + proposal().actions.length;
  return (
    <box
      border
      borderColor={ACCENT}
      title="Proposal"
      style={{ flexDirection: "column", height: height(), flexShrink: 0 }}
    >
      <Note tone="plain" text={proposal().interpretation} />
      <For each={proposal().actions}>
        {(action, at) => {
          const granted = () => allowed().has(at());
          return (
            <Note
              tone={granted() ? "plain" : "accent"}
              text={`  ${granted() ? "→" : "?"} ${describeAction(action)} · ${
                granted() ? "allowed now" : "needs your yes"
              }`}
            />
          );
        }}
      </For>
      <Note text={`${proposal().id} · ${proposal().content_hash}`} />
      <Note text="Enter carry it out · Esc decline it" />
    </box>
  );
}
