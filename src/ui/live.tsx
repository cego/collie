// The Live region, the Steer box and the proposal preview: what the Home board says has
// been happening, and the one place a human types back.
//
// The whole discipline of this file is that evidence and narrative must not look alike.
// A verification is what somebody ran and bound to a tree; a claim is what an agent
// wrote, and it is prefixed `claimed:` wherever it appears so it can never be read as a
// pass. `missing` is always drawn, including when there is nothing in it, because "what
// nobody checked" silently absent is exactly the reassurance a card exists to withhold.
// The narrative is last and dim: it is prose a model wrote about its own work.
//
// Nothing here focuses anything. A card, a correction and a proposal all arrive without
// moving a human off what they are doing — only a pending question does that, and that
// is the engine's call, not the board's (ADR-0008).

import { For, Show } from "solid-js";
import { TextAttributes } from "@opentui/core";
import type { Turn } from "../conversation";
import type { Live } from "../live";
import type { ProposalRecord } from "../proposals";
import {
  asText,
  cardLines,
  deliveryLine,
  describeAction,
  driftLines,
  ownershipLines,
  type Line,
  type Tone,
} from "../lines";

const DIM = "#8a8a8a";
const ACCENT = "#7aa2f7";
const BAD = "#f7768e";

/**
 * One line of the region. The tone comes with the line — `src/lines.ts` decides what a
 * card says and how much emphasis each part of it asks for — so this only maps that to a
 * colour and an indent. Colour is never the only carrier: every line reads correctly
 * without it, which is what the one-screen text view proves.
 */
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

/** Several lines, in the order they were produced. */
function Lines(props: { lines: ReadonlyArray<Line> }) {
  return <For each={props.lines}>{(entry) => <Drawn line={entry} />}</For>;
}

export function LiveRegion(props: { live: Live }) {
  const live = () => props.live;
  return (
    <box style={{ flexDirection: "column" }}>
      {/* First: an ownership question is the board saying it does not know which
          workspace is its own, and only a human can settle it. */}
      <Show when={live().ownership !== null}>
        <Lines lines={ownershipLines(live().ownership!.why, live().ownership!.candidates)} />
      </Show>
      <For each={live().cards}>{(card) => <Lines lines={cardLines(card)} />}</For>
      <For each={live().drift}>{(report) => <Lines lines={driftLines(report)} />}</For>
      <For each={live().pending}>{(report) => <Lines lines={driftLines(report, true)} />}</For>
      <For each={live().deliveries}>{(delivery) => <Drawn line={deliveryLine(delivery)} />}</For>
    </box>
  );
}

/** One line of chrome: a note, a field, a key line. Not a card's own evidence. */
function Note(props: { text: string; tone?: Tone }) {
  return (
    <text style={{ height: 1 }} fg={TONES[props.tone ?? "dim"]}>
      {props.text}
    </text>
  );
}

/** The last few turns, so the box is a conversation rather than a one-way field. */
function Turns(props: { turns: ReadonlyArray<Turn> }) {
  return (
    <For each={props.turns}>
      {(turn) => <Note text={`${turn.role === "human" ? "you" : "Collie"}: ${turn.text}`} />}
    </For>
  );
}

/**
 * Where a human says something to Collie about one Run. The target is named on the box
 * rather than taken when Enter is pressed: a steer is about a specific piece of work, and
 * a board whose filter moved between reading a row and typing about it would steer
 * another one — so with no target the box says what to select instead of guessing.
 */
export function SteerBox(props: {
  draft: string;
  target: string | null;
  turns: ReadonlyArray<Turn>;
  /** How many proposals are waiting on an answer, listed with `!` on their rows. */
  pending: number;
}) {
  // Its own height, stated: a box whose children say how tall it is draws them all on
  // one row, and a region that took its size from the pane would clip whichever of the
  // turns, the field and the key line was last.
  const height = () => 3 + props.turns.length + (props.pending > 0 ? 1 : 0);
  return (
    <box
      border
      borderColor={ACCENT}
      title="Steer"
      style={{ flexDirection: "column", height: height(), flexShrink: 0 }}
    >
      <Turns turns={props.turns} />
      <Show when={props.pending > 0}>
        <Note tone="accent" text={`! ${props.pending} proposal(s) waiting on you`} />
      </Show>
      <Show
        when={props.target !== null}
        fallback={<Note tone="bad" text="select the run this is about" />}
      >
        <Note tone="plain" text={`[${props.target}] > ${props.draft}`} />
      </Show>
      <Note text="type · Enter send · Esc leave it" />
    </box>
  );
}

/**
 * What a confirmation is consent to. Every action, whether the target's own authority
 * already grants it, and the id and hash the confirmation names — so a yes is a yes to
 * this payload rather than to a summary of it.
 */
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
