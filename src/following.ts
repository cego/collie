// What `collie run wait` stops at, and what `--follow` says changed, read from the Run's
// view and its progress. Pure, so the wait and its tests decide the same way.

import * as Arr from "effect/Array";
import type { ForgeChecks, ReadyToRelease, RunProgress } from "./board-model";
import type { RunView } from "./engine";

export const UNTILS = ["terminal", "attention", "ready", "needs-human"] as const;
export type Until = (typeof UNTILS)[number];

/** Waiting on someone: a question, a hold or a stop, or a park its status may not show. */
export const atAttention = (view: RunView): boolean =>
  view.status.status === "suspended" || view.parked !== null;

/** Whether the wait is over, or can only be over once a human acts (`stuck`). */
export type Reached = "waiting" | "reached" | "stuck";

export function reached(
  until: Until,
  view: RunView,
  progress: RunProgress | null,
  settled: boolean,
): Reached {
  if (until === "terminal") return settled ? "reached" : "waiting";
  if (until === "attention") return settled || atAttention(view) ? "reached" : "waiting";
  if (progress === null) return "waiting";
  const ready = progress.ready.ready;
  const human =
    atAttention(view) || (settled && Arr.every(progress.ready.missing, (one) => !one.settling));
  if (until === "ready") return ready ? "reached" : human ? "stuck" : "waiting";
  return ready || human ? "reached" : "waiting";
}

export type FollowEvent =
  | { readonly type: "agent"; readonly agent: string; readonly operation: string }
  | {
      readonly type: "operation";
      readonly operation: string;
      readonly agent: string;
      readonly state: "started" | "finished";
    }
  | { readonly type: "parked"; readonly reason: string }
  | { readonly type: "awaiting"; readonly on: string; readonly who: string | null }
  | { readonly type: "mr"; readonly mr: string }
  | { readonly type: "ci"; readonly ci: ForgeChecks };

export interface Followed {
  readonly view: RunView | null;
  readonly progress: RunProgress | null;
}

const ciSaid = (ci: ForgeChecks) => (ci.state === "failed" ? `failed: ${ci.name}` : ci.state);

/** What happened between two looks at a Run, oldest first. */
export function followEvents(before: Followed, after: Followed): ReadonlyArray<FollowEvent> {
  const events: FollowEvent[] = [];
  if (after.progress !== null) {
    const was = new Map(Arr.map(before.progress?.steps ?? [], (step) => [step.operation, step]));
    const agents = new Set(Arr.map(before.progress?.steps ?? [], (step) => step.agent));
    for (const step of after.progress.steps) {
      const prior = was.get(step.operation);
      if (!agents.has(step.agent)) {
        agents.add(step.agent);
        events.push({ type: "agent", agent: step.agent, operation: step.operation });
      }
      if (prior === undefined)
        events.push({
          type: "operation",
          operation: step.operation,
          agent: step.agent,
          state: "started",
        });
      if (step.done && prior?.done !== true)
        events.push({
          type: "operation",
          operation: step.operation,
          agent: step.agent,
          state: "finished",
        });
    }
    const ci = after.progress.ci;
    const prior = before.progress?.ci ?? null;
    if (ci !== null && (prior === null ? ci.state !== "none" : ciSaid(prior) !== ciSaid(ci)))
      events.push({ type: "ci", ci });
  }
  const parked = after.view?.parked ?? null;
  if (parked !== null && parked !== (before.view?.parked ?? null))
    events.push({ type: "parked", reason: parked });
  const awaiting = after.view?.awaiting ?? null;
  if (awaiting !== null && awaiting.on !== before.view?.awaiting?.on)
    events.push({ type: "awaiting", on: awaiting.on, who: awaiting.who });
  const mr = after.view?.mr ?? null;
  if (mr !== null && mr !== (before.view?.mr ?? null)) events.push({ type: "mr", mr });
  return events;
}

/** One event as `--follow` prints it without `--json`. */
export function followLine(runId: string, event: FollowEvent): string {
  switch (event.type) {
    case "agent":
      return `${runId}: agent ${event.agent} launched for ${event.operation}`;
    case "operation":
      return `${runId}: operation ${event.operation} ${event.state}`;
    case "parked":
      return `${runId}: parked: ${event.reason}`;
    case "awaiting":
      return `${runId}: Waiting for ${event.on}.`;
    case "mr":
      return `${runId}: merge request ${event.mr} opened`;
    case "ci":
      return `${runId}: CI ${ciSaid(event.ci)}`;
  }
}

/** Ready to release as a human reads it: yes, or each missing fact and whether it may still come. */
export const readyLines = (ready: ReadyToRelease): ReadonlyArray<string> =>
  ready.ready
    ? ["Ready to release."]
    : [
        "Not ready to release:",
        ...Arr.map(
          ready.missing,
          (one) => `- ${one.said}${one.settling ? " (may come by itself)" : ""}`,
        ),
      ];
