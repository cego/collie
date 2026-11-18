import * as Arr from "effect/Array";
import {
  mrReadiness,
  type ForgeChecks,
  type ReadyToRelease,
  type RunProgress,
  type TaskMr,
} from "./board-model";
import type { RunView } from "./engine";
import { HOLD, STOP } from "./controls";
import { isSetAside, isUnanswered } from "./store";

export const UNTILS = ["terminal", "attention", "ready", "needs-human"] as const;
export type Until = (typeof UNTILS)[number];

export const atAttention: (view: RunView) => boolean = (view) =>
  view.parked !== null ||
  (view.status.status === "suspended" &&
    (!Arr.some(view.waiting, (one) => isSetAside(view.waiting, one)) ||
      Arr.some(view.waiting, isUnanswered) ||
      view.controls.includes(HOLD) ||
      view.controls.includes(STOP)));

export type Reached = "waiting" | "reached" | "stuck";

export function reached(
  until: Until,
  view: RunView,
  progress: RunProgress | null,
  settled: boolean,
) {
  if (until === "terminal") {
    const returned: Reached = settled ? "reached" : "waiting";
    return returned;
  }
  if (until === "attention") {
    const returned: Reached = settled || atAttention(view) ? "reached" : "waiting";
    return returned;
  }
  if (progress === null) {
    const returned: Reached = "waiting";
    return returned;
  }
  const ready = progress.ready.ready;
  const human =
    atAttention(view) || (settled && Arr.every(progress.ready.missing, (one) => !one.settling));
  if (until === "ready") {
    const returned: Reached = ready ? "reached" : human ? "stuck" : "waiting";
    return returned;
  }
  const returned: Reached = ready || human ? "reached" : "waiting";
  return returned;
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
  | { readonly type: "mr"; readonly mr: string; readonly state?: "merged" | "closed" }
  | { readonly type: "ci"; readonly ci: ForgeChecks };

export interface Followed {
  readonly view: RunView | null;
  readonly progress: RunProgress | null;
}

const ciSaid = (ci: ForgeChecks) => (ci.state === "failed" ? `failed: ${ci.name}` : ci.state);

export function followEvents(before: Followed, after: Followed) {
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
  const mrs = after.progress?.mrs;
  if (mrs !== undefined) events.push(...mrEvents(before.progress?.mrs ?? [], mrs));
  else {
    const mr = after.view?.mr ?? null;
    if (mr !== null && mr !== (before.view?.mr ?? null)) events.push({ type: "mr", mr });
  }
  const returned: ReadonlyArray<FollowEvent> = events;
  return returned;
}

const MERGED: ReadonlySet<string> = new Set(["merged", "on-stage", "in-prod"]);

const endOf = (state: TaskMr["state"]) =>
  state === null ? null : MERGED.has(state) ? "merged" : state === "closed" ? "closed" : null;

const mrEvents: (
  before: ReadonlyArray<TaskMr>,
  after: ReadonlyArray<TaskMr>,
) => ReadonlyArray<FollowEvent> = (before, after) => {
  const was = new Map(Arr.map(before, (one) => [one.id, one]));
  return Arr.flatMap(after, (one) => {
    const prior = was.get(one.id);
    if (prior === undefined) {
      const returned: ReadonlyArray<FollowEvent> = [{ type: "mr", mr: one.mr }];
      return returned;
    }
    const end = endOf(one.state);
    const returned: ReadonlyArray<FollowEvent> =
      end !== null && end !== endOf(prior.state) ? [{ type: "mr", mr: one.mr, state: end }] : [];
    return returned;
  });
};

export function followLine(runId: string, event: FollowEvent) {
  switch (event.type) {
    case "agent": {
      const returned: string = `${runId}: agent ${event.agent} launched for ${event.operation}`;
      return returned;
    }
    case "operation": {
      const returned: string = `${runId}: operation ${event.operation} ${event.state}`;
      return returned;
    }
    case "parked": {
      const returned: string = `${runId}: parked: ${event.reason}`;
      return returned;
    }
    case "awaiting": {
      const returned: string = `${runId}: Waiting for ${event.on}.`;
      return returned;
    }
    case "mr": {
      const returned: string = `${runId}: merge request ${event.mr} ${event.state ?? "opened"}`;
      return returned;
    }
    case "ci": {
      const returned: string = `${runId}: CI ${ciSaid(event.ci)}`;
      return returned;
    }
  }
}

export const readyLines: (ready: ReadyToRelease) => ReadonlyArray<string> = (ready) =>
  ready.ready
    ? ["Ready to release."]
    : [
        "Not ready to release:",
        ...Arr.map(
          ready.missing,
          (one) => `- ${one.said}${one.settling ? " (may come by itself)" : ""}`,
        ),
      ];

export const progressReadyLines: (progress: RunProgress) => ReadonlyArray<string> = (progress) =>
  progress.mrs !== undefined && progress.mrs.length > 1
    ? Arr.map(progress.mrs, (one) => `- ${one.short}: ${mrReadiness(one, progress.mrs!)}`)
    : readyLines(progress.ready);
