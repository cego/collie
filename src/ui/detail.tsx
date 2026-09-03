// The detail panel: what the Selection actually is. A Run's own facts and — the point of
// the panel — the review it wrote, readable without splitting a pane. Everything here is
// props: the reads happened in an Effect fiber, and a component that read a file itself
// is what would make the app stutter and untestable, in that order.

import { For, Show } from "solid-js";
import { useRenderer } from "@opentui/solid";
import { sinceReview, type MrDetails, type MrPanel } from "../mr";
import type { Panel, RunDetail } from "../views";
import type { Command, Row } from "./state";

const DIM = "#8a8a8a";
const ACCENT = "#7aa2f7";
const BAD = "#f7768e";

export interface DetailProps {
  row: Row | null;
  detail: RunDetail | null;
  cwd: string;
  overlay: boolean;
  dispatch: (command: Command) => void;
}

export function Detail(props: DetailProps) {
  return (
    <scrollbox
      title="Detail"
      border
      borderColor={DIM}
      style={{
        flexDirection: "column",
        ...(props.overlay ? { height: 8, width: "100%" } : { width: "42%" }),
      }}
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

function RunFacts(props: { detail: RunDetail }) {
  const review = () => props.detail.review;
  const tail = () => props.detail.tail;
  // Narrowed here rather than at the call: a review that was cut short is the one thing
  // the `Text` panel says beyond its text.
  const cutShort = () => {
    const panel = review();
    return panel._tag === "Text" && panel.truncated;
  };
  return (
    <box style={{ flexDirection: "column" }}>
      {/* First, because it is what the panel exists for: a finished review readable
          without splitting a pane and running `less`. */}
      <text fg={ACCENT}>{"Review"}</text>
      <Show when={review()._tag === "Text"} fallback={<text fg={DIM}>{panelLine(review())}</text>}>
        <text>{panelLine(review())}</text>
        <Show when={cutShort()}>
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
            {`  ${step.id} · ${step.status}${step.note ? ` · ${step.note}` : ""}`}
          </text>
        )}
      </For>

      <Show when={props.detail.handoffs.length > 0}>
        <text fg={ACCENT}>{"Hand-offs"}</text>
        <For each={props.detail.handoffs}>{(line) => <text fg={DIM}>{`  ${line}`}</text>}</For>
      </Show>
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
