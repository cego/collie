// The detail panel: what the Selection actually is. A Run's own facts and — the point of
// the panel — the review it wrote, readable without splitting a pane. Everything here is
// props: the reads happened in an Effect fiber, and a component that read a file itself
// is what would make the app stutter and untestable, in that order.

import { createMemo, For, Show } from "solid-js";
import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/solid";
import { sinceReview, type MrDetails, type MrPanel } from "../mr";
import { truncated, type Panel, type PlanPanel, type RunDetail } from "../views";
import { markdownLines, type Command, type LineStyle, type Row } from "./state";

const DIM = "#8a8a8a";
const ACCENT = "#7aa2f7";
const BAD = "#f7768e";

export interface DetailProps {
  row: Row | null;
  detail: RunDetail | null;
  cwd: string;
  overlay: boolean;
  /**
   * The scrollbox itself, so the keys can scroll it. The mouse wheel needs nothing —
   * a scrollbox handles the wheel over itself — but the keyboard belongs to the app,
   * which is the only place that knows the Selection is not being moved instead.
   */
  ref?: (box: ScrollBoxRenderable) => void;
  dispatch: (command: Command) => void;
}

/**
 * How the panel sits when it is a full-width region under the list rather than a column
 * beside it. It is what yields when a short pane cannot hold every region — the one thing
 * on screen that is only ever read, and the row it describes is still in the list above
 * it — down to its border and one line of that row, because a box squeezed below its own
 * border draws its title through it.
 */
// No flexDirection here: a scrollbox's root is a row of its content beside its vertical
// scrollbar, and a column stacks the bar under the content, one row short.
const AS_OVERLAY = {
  height: 8,
  minHeight: 3,
  width: "100%",
  flexShrink: 1,
} as const;

/** And beside the list: a share of the pane, so both columns follow a drag. */
const AS_COLUMN = { width: "42%" } as const;

export function Detail(props: DetailProps) {
  return (
    <scrollbox
      ref={props.ref}
      title="Detail"
      border
      borderColor={DIM}
      style={props.overlay ? AS_OVERLAY : AS_COLUMN}
    >
      <Show when={props.row !== null} fallback={<text fg={DIM}>{props.cwd}</text>}>
        <text>{props.row!.title}</text>
        <text fg={DIM}>{props.row!.detail}</text>

        {/* A Run whose target is a merge request is half a story without it. */}
        <Show when={props.detail?.mr}>
          <MergeRequest
            panel={props.detail!.mr!}
            reviewedAt={props.detail!.finishedAt}
            dispatch={props.dispatch}
          />
        </Show>

        <Show when={props.detail !== null}>
          <RunFacts detail={props.detail!} />
        </Show>

        <Show when={props.row!.definition !== null}>
          <Definition row={props.row!} />
        </Show>
      </Show>
    </scrollbox>
  );
}

/**
 * The merge request behind a review: is it still open, did its pipeline pass, is anyone
 * still arguing in it, and — the line that decides whether to look again — has anything
 * moved since this review finished.
 */
function MergeRequest(props: {
  panel: MrPanel;
  reviewedAt: number;
  dispatch: (command: Command) => void;
}) {
  // No glab, no login, a merge request nobody can read: each is one stated line, and
  // nothing else in the panel is affected by it.
  const details = () => (props.panel._tag === "Details" ? props.panel : null);
  const why = () => (props.panel._tag === "Unavailable" ? props.panel.reason : "");
  return (
    <box style={{ flexDirection: "column" }}>
      <text fg={ACCENT}>{"Merge request"}</text>
      <Show when={details() !== null} fallback={<text fg={DIM}>{why()}</text>}>
        <MergeRequestDetails
          mr={details()!}
          reviewedAt={props.reviewedAt}
          dispatch={props.dispatch}
        />
      </Show>
    </box>
  );
}

function MergeRequestDetails(props: {
  mr: MrDetails;
  reviewedAt: number;
  dispatch: (command: Command) => void;
}) {
  const renderer = useRenderer();
  const moved = () => sinceReview(props.mr, props.reviewedAt);
  return (
    <box style={{ flexDirection: "column" }}>
      <text>{`!${props.mr.iid} · ${props.mr.title}`}</text>
      <text fg={DIM}>{`${props.mr.state}${props.mr.author ? ` · ${props.mr.author}` : ""}`}</text>
      <text fg={DIM}>{`${props.mr.sourceBranch} → ${props.mr.targetBranch}`}</text>
      <text fg={DIM}>
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
        <text fg={props.mr.updatedAt > props.reviewedAt ? ACCENT : DIM}>{moved()}</text>
      </Show>
      {/* The URL is on screen and the pane owns the mouse while it is focused, so
          copying it is a key rather than a drag. */}
      <Show when={props.mr.url !== ""}>
        <text fg={ACCENT} onMouseDown={() => renderer.copyToClipboardOSC52(props.mr.url)}>
          {`  [c copy ${props.mr.url}]`}
        </text>
      </Show>
    </box>
  );
}

/** What a panel shows: the text it read, or the one line saying why it has none. */
function panelLine(panel: Panel): string {
  return panel._tag === "Text" ? panel.text : panel.reason;
}

/**
 * A read document, one styled line at a time: headings in accent and bold, list markers
 * dim, fenced code dim, everything else plain. The whole point of the panel is reading
 * something long, and one flat block of text is what makes a review unskimmable.
 *
 * ponytail: one renderable per line, and the scrollbox culls what is off screen. A cap's
 * worth of review is around a thousand of them; measure before batching.
 */
/** What each line style is drawn in. Exhaustive, so a new style is a type error here. */
const LINE_FG = {
  heading: ACCENT,
  list: DIM,
  code: DIM,
  plain: undefined,
} satisfies Record<LineStyle, string | undefined>;

function Markdown(props: { text: string }) {
  /**
   * Two memos, so the work stops at the text rather than at the render. The bridge
   * replaces the whole state every three seconds and on every filesystem event, and
   * `markdownLines` returns a fresh array each call — so `For` reconciled every line of
   * a cap's worth of review on each of those, for a review that had not changed. A memo
   * over the string is where the `===` comparison can actually stop: the array one only
   * recomputes when it says the text is new.
   */
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

function RunFacts(props: { detail: RunDetail }) {
  const review = () => props.detail.review;
  const tail = () => props.detail.tail;
  const stopped = () =>
    props.detail.attention.category === "interrupted" ? props.detail.attention : null;
  return (
    <box style={{ flexDirection: "column" }}>
      {/* Above the review, because a Run that stopped is a question about what to do
          next and the review is what you read once you have decided. The same facts
          `collie run show` prints, so the two cannot tell different stories. */}
      <Show when={stopped() !== null}>
        <text fg={BAD}>{"Stopped"}</text>
        <text fg={DIM}>{`  ${stopped()!.explanation}`}</text>
        <Show when={stopped()!.preserved.length > 0}>
          <text fg={DIM}>{`  kept: ${stopped()!.preserved.join(", ")}`}</text>
        </Show>
        <text fg={DIM}>{`  safe now: ${stopped()!.actions.join(", ")}`}</text>
      </Show>

      {/* First, because it is what the panel exists for: a finished review readable
          without splitting a pane and running `less`. */}
      <text fg={ACCENT}>{"Review"}</text>
      <Show when={review()._tag === "Text"} fallback={<text fg={DIM}>{panelLine(review())}</text>}>
        <Markdown text={panelLine(review())} />
        <Show when={truncated(review())}>
          <text fg={DIM}>{"  … truncated; m reads more of it, t tails the run's log"}</text>
        </Show>
      </Show>

      {/* The end of the log, while it is toggled on: a truncated review is unreadable
          without it, and leaving the tab for that is what the toggle exists to avoid. */}
      <Show when={tail() !== null}>
        <text fg={ACCENT}>{"Log"}</text>
        <text fg={DIM}>{panelLine(tail()!)}</text>
      </Show>

      <Show when={props.detail.outputs.length > 0}>
        <text fg={ACCENT}>{"Outputs"}</text>
        <For each={props.detail.outputs}>
          {(output) => (
            <box style={{ flexDirection: "column" }}>
              <text fg={output.state === "recorded" ? DIM : BAD}>
                {`  ${output.step} · ${output.where} · ${output.state}`}
              </text>
              <text fg={DIM}>{`    ${output.text}`}</text>
            </box>
          )}
        </For>
      </Show>

      <text fg={ACCENT}>{"Inputs"}</text>
      <For each={props.detail.inputs}>
        {(input) => (
          <text fg={DIM}>
            {`  ${input.name} = ${input.value}${input.source ? ` (${input.source})` : ""}`}
          </text>
        )}
      </For>

      <text fg={ACCENT}>{"Steps"}</text>
      <For each={props.detail.steps}>
        {(step) => (
          <text fg={step.status === "failed" ? BAD : DIM}>
            {`  ${[step.id, step.status, step.took, step.note].filter((part) => part).join(" · ")}`}
          </text>
        )}
      </For>

      {/* After the review, because a review is what the panel is opened for; the plan
          is what it is judged against. */}
      <Show when={props.detail.plan !== null}>
        <Plan plan={props.detail.plan!} />
      </Show>

      <Show when={props.detail.handoffs.length > 0}>
        <text fg={ACCENT}>{"Hand-offs"}</text>
        <For each={props.detail.handoffs}>{(line) => <text fg={DIM}>{`  ${line}`}</text>}</For>
      </Show>
    </box>
  );
}

/**
 * The plan a run is building from: the spec it was given, and each ticket with whether
 * its boxes are all checked. Enough to judge the work against its intent without
 * leaving the tab, which is the whole reason the review is in here too.
 */
function Plan(props: { plan: PlanPanel }) {
  const spec = () => props.plan.spec;
  return (
    <box style={{ flexDirection: "column" }}>
      <text fg={ACCENT}>{"Plan"}</text>
      <Show when={spec()._tag === "Text"} fallback={<text fg={DIM}>{panelLine(spec())}</text>}>
        <Markdown text={panelLine(spec())} />
        <Show when={truncated(spec())}>
          <text fg={DIM}>{"  … truncated; m reads more of it"}</text>
        </Show>
      </Show>
      <For each={props.plan.tickets}>
        {(ticket) => <text fg={DIM}>{`  ${ticket.done ? "✓" : "·"} ${ticket.title}`}</text>}
      </For>
    </box>
  );
}

/** A Workflow or Persona: where it came from, what it needs, and what is wrong with it. */
function Definition(props: { row: Row }) {
  const definition = () => props.row.definition!;
  return (
    <box style={{ flexDirection: "column" }}>
      <text fg={DIM}>{definition().path}</text>
      {/* Before the rest of it: a definition that will not run is what the row is being
          looked at for, and the steps below would otherwise push it off the panel. */}
      <Show when={definition().problems.length > 0}>
        <text fg={BAD}>{"Will not run"}</text>
        <For each={definition().problems}>{(why) => <text fg={BAD}>{`  ${why}`}</text>}</For>
      </Show>
      <Show when={definition().steps.length > 0}>
        <text fg={ACCENT}>{"Steps"}</text>
        <For each={definition().steps}>{(line) => <text fg={DIM}>{`  ${line}`}</text>}</For>
      </Show>
      <Show when={definition().inputs.length > 0}>
        <text fg={ACCENT}>{"Inputs"}</text>
        <For each={definition().inputs}>{(name) => <text fg={DIM}>{`  ${name}`}</text>}</For>
      </Show>
      <Show when={definition().decisions.length > 0}>
        <text fg={ACCENT}>{"Decisions"}</text>
        <For each={definition().decisions}>
          {(decision) => (
            <text fg={DIM}>{`  ${decision.step}: ${decision.titles.join(" · ")}`}</text>
          )}
        </For>
      </Show>
    </box>
  );
}
