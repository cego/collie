import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import type {
  Flow,
  FlowAction,
  FlowLane,
  FlowLaneAction,
  FlowRun,
  Proposal,
  Question,
} from "../../../src/board-model";
import type { DesktopAction } from "./flock";

export type FlowEffect =
  | { readonly kind: "write"; readonly installation: string; readonly write: DesktopAction }
  | {
      readonly kind: "text";
      readonly installation: string;
      readonly write: Extract<DesktopAction, { _tag: "Deliver" | "FollowUp" }>;
      readonly initial?: string;
      readonly retry?: string;
      readonly withdraw?: string;
    }
  | {
      readonly kind: "answer";
      readonly installation: string;
      readonly question: Question;
      readonly write: Extract<DesktopAction, { _tag: "Answer" }>;
    }
  | {
      readonly kind: "proposal";
      readonly installation: string;
      readonly proposal: Proposal;
      readonly confirm: Extract<DesktopAction, { _tag: "Confirm" }>;
      readonly decline: Extract<DesktopAction, { _tag: "Decline" }>;
    }
  | { readonly kind: "terminal"; readonly run: string; readonly agent: string }
  | { readonly kind: "part"; readonly run: string; readonly part: "log" | "evidence" }
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "run"; readonly run: string; readonly machine: string | null }
  | { readonly kind: "offer"; readonly run: string; readonly offer: string };
export interface FlowActionView {
  readonly label: string;
  readonly icon: string;
  readonly color: "neutral" | "warning" | "error";
  readonly caption?: string;
  readonly effect: FlowEffect;
}
const shown = (
  label: string,
  icon: string,
  effect: FlowEffect,
  color: FlowActionView["color"] = "neutral",
  caption?: string,
): FlowActionView => ({ label, icon, effect, color, caption });

export const retryCaption = (lane: FlowLane, node: FlowRun): string => {
  const kept = Arr.map(
    Arr.filter(lane.nodes, (one) => one.state === "done" && one.id !== node.id),
    (one) => one.title,
  );
  if (kept.length === 0) return `Runs ${node.title} again.`;
  const names =
    kept.length > 3 ? `${kept[0]} and ${kept.length - 1} more` : Arr.join(kept, " and ");
  return `Keeps ${names} and runs ${node.title} again.`;
};

export const desktopFlowAction = (
  kind: FlowAction,
  node: FlowRun,
  lane: FlowLane,
  installation: string,
  live: boolean,
): FlowActionView | null => {
  if (!live || (node.primary !== kind && !node.actions?.includes(kind))) return null;
  const runId = lane.run;
  const stepId =
    Option.getOrUndefined(
      Arr.findFirst(
        lane.nodes,
        (one) => one.id === node.id || Arr.some(one.runs, (run) => run.id === node.id),
      ),
    )?.id ?? node.id;
  const role = node.role ?? "agent";
  switch (kind) {
    case "pause": {
      const target =
        Option.getOrUndefined(
          Arr.findFirst(
            lane.nodes,
            (one) =>
              one.id === (node.pauseTarget ?? stepId) ||
              Arr.some(one.runs, (run) => run.id === node.pauseTarget),
          ),
        ) ?? node;
      return shown(
        target.pause == null ? `Pause before ${target.title}` : "Don't pause",
        "i-lucide-pause",
        {
          kind: "write",
          installation,
          write: {
            _tag: "Control",
            runId,
            control: "hold",
            set: target.pause == null,
            before: target.id,
          },
        },
      );
    }
    case "note":
    case "retry-noted":
      return shown(
        kind === "note" ? `Note for ${node.title}…` : "Retry with a note…",
        "i-lucide-message-square-plus",
        {
          kind: "text",
          installation,
          write: { _tag: "Deliver", runId, step: stepId, text: "" },
          initial: kind === "retry-noted" ? (node.why ?? "") : undefined,
          retry: kind === "retry-noted" ? runId : undefined,
        },
      );
    case "log":
      return shown("Log", "i-lucide-scroll-text", { kind: "part", run: runId, part: "log" });
    case "evidence":
      return shown("Evidence", "i-lucide-file-check", {
        kind: "part",
        run: runId,
        part: "evidence",
      });
    case "retry":
      return shown(
        `Retry ${node.title}`,
        "i-lucide-rotate-ccw",
        { kind: "write", installation, write: { _tag: "Resume", runId: node.link?.run ?? runId } },
        "error",
        retryCaption(lane, node),
      );
    case "continue":
      return shown("Continue", "i-lucide-play", {
        kind: "write",
        installation,
        write: { _tag: "Control", runId, control: "hold", set: false },
      });
    case "tell":
      return node.agent == null
        ? null
        : shown(`Tell the ${role}…`, "i-lucide-message-square", {
            kind: "text",
            installation,
            write: { _tag: "Deliver", runId, agent: node.agent, text: "" },
          });
    case "terminal":
      return node.agent == null
        ? null
        : shown(`Watch the ${role}`, "i-lucide-terminal", {
            kind: "terminal",
            run: runId,
            agent: node.agent,
          });
    case "answer": {
      const asked = Option.getOrUndefined(
        Arr.findFirst(
          node.questions,
          (one) => one.id !== undefined && (one.open ?? one.answered === null),
        ),
      );
      if (asked?.id === undefined) return null;
      const question: Question = {
        kind: "question",
        run: runId,
        id: asked.id,
        step: node.title,
        topic: asked.name,
        text: asked.text ?? asked.name,
        options: asked.options ?? [],
      };
      return shown(
        "Answer",
        "i-lucide-message-circle-question",
        {
          kind: "answer",
          installation,
          question,
          write: { _tag: "Answer", runId, decision: asked.id, value: "" },
        },
        "warning",
      );
    }
    case "proposal": {
      const proposal = node.proposal;
      return proposal === undefined
        ? null
        : shown(
            "Review",
            "i-lucide-check",
            {
              kind: "proposal",
              installation,
              proposal,
              confirm: { _tag: "Confirm", proposal: proposal.id, hash: proposal.hash },
              decline: { _tag: "Decline", proposal: proposal.id, hash: proposal.hash },
            },
            "warning",
          );
    }
    case "open": {
      if (node.link?.run != null)
        return shown(`Open ${node.title}`, "i-lucide-arrow-up-right", {
          kind: "run",
          run: node.link.run,
          machine: node.link.machine,
        });
      return node.url === undefined
        ? null
        : shown(node.id === "ci" ? "Open pipeline" : "Open MR", "i-lucide-external-link", {
            kind: "url",
            url: node.url,
          });
    }
    case "start":
      return shown(node.title, "i-lucide-play", {
        kind: "offer",
        run: runId,
        offer: pipe(node.id, Str.replace(/^offer:/, "")),
      });
  }
};

export const desktopLaneAction = (
  kind: FlowLaneAction,
  lane: FlowLane,
  installation: string,
  live: boolean,
): FlowActionView | null => {
  if (!live || !lane.actions?.includes(kind)) return null;
  const runId = lane.run;
  switch (kind) {
    case "hold":
      return shown("Hold run", "i-lucide-pause", {
        kind: "write",
        installation,
        write: { _tag: "Control", runId, control: "hold", set: true },
      });
    case "release":
      return shown("Release hold", "i-lucide-play", {
        kind: "write",
        installation,
        write: { _tag: "Control", runId, control: "hold", set: false },
      });
    case "stop":
      return shown("Stop run", "i-lucide-square", {
        kind: "write",
        installation,
        write: { _tag: "Control", runId, control: "stop", set: true },
      });
    case "resume":
      return shown("Resume", "i-lucide-rotate-ccw", {
        kind: "write",
        installation,
        write: { _tag: "Resume", runId },
      });
    case "follow-up":
      return shown("Follow-up run", "i-lucide-message-square-plus", {
        kind: "text",
        installation,
        write: { _tag: "FollowUp", runId, text: "" },
      });
  }
};

export const nextMove = (flow: Flow) => {
  if (flow.current === null) return null;
  const lane = Option.getOrUndefined(
    Arr.findFirst(flow.lanes, (one) => one.run === flow.current!.run),
  );
  const node = Option.getOrUndefined(
    Option.map(Option.fromNullishOr(lane), (present) =>
      Option.getOrUndefined(Arr.findFirst(present.nodes, (one) => one.id === flow.current!.node)),
    ),
  );
  return node?.primary == null || lane === undefined
    ? null
    : { run: lane.run, lane, node, action: node.primary, notice: flow.notice ?? null };
};
