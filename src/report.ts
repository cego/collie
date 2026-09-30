// Where Runs end, across all of them: the numbers a change to Collie is judged by.
// Data only: nothing here is a threshold, and nothing refuses anything.

import { STOP, type RunView } from "./engine";
import { resultText } from "./lifecycle";
import type { Metrics } from "./metrics";

export interface WorkflowTally {
  readonly workflow: string;
  readonly total: number;
  readonly complete: number;
  readonly failed: number;
  readonly suspended: number;
  readonly pending: number;
  /** Carries a `stop` control: a human stopped it. */
  readonly stopped: number;
  /** Recorded a merge request (`RunView.mr`). */
  readonly withMr: number;
  readonly answered: number;
  readonly open: number;
  readonly rework: number;
  readonly verifications: {
    readonly pass: number;
    readonly fail: number;
    readonly unstable: number;
  };
}

export interface Report {
  readonly since: string | null;
  readonly total: number;
  readonly workflows: ReadonlyArray<WorkflowTally>;
  readonly failed: ReadonlyArray<{ runId: string; workflow: string; reason: string }>;
  readonly completed: ReadonlyArray<{
    runId: string;
    workflow: string;
    value: string;
    mr: string | null;
  }>;
  readonly stopped: ReadonlyArray<{ runId: string; workflow: string }>;
}

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };

export function reportOf(
  views: ReadonlyArray<RunView>,
  metrics: ReadonlyMap<string, Metrics>,
  since: string | null,
): Report {
  const from = since === null ? -Infinity : Date.parse(since);
  const kept = views
    .filter((view) => Date.parse(view.created) >= from)
    .toSorted((a, b) => Date.parse(a.created) - Date.parse(b.created));
  const tallies = new Map<string, Mutable<WorkflowTally>>();
  const failed: Mutable<Report["failed"]> = [];
  const completed: Mutable<Report["completed"]> = [];
  const stopped: Mutable<Report["stopped"]> = [];
  for (const view of kept) {
    const { runId, workflow, status } = view;
    let tally = tallies.get(workflow);
    if (tally === undefined) {
      tally = {
        workflow,
        total: 0,
        complete: 0,
        failed: 0,
        suspended: 0,
        pending: 0,
        stopped: 0,
        withMr: 0,
        answered: 0,
        open: 0,
        rework: 0,
        verifications: { pass: 0, fail: 0, unstable: 0 },
      };
      tallies.set(workflow, tally);
    }
    tally.total++;
    tally[status.status]++;
    if (status.status === "failed") failed.push({ runId, workflow, reason: status.reason });
    if (status.status === "complete")
      completed.push({
        runId,
        workflow,
        value: resultText(status.value),
        mr: view.mr,
      });
    if (view.controls.includes(STOP)) {
      tally.stopped++;
      stopped.push({ runId, workflow });
    }
    if (view.mr !== null) tally.withMr++;
    const answered = view.waiting.filter((decision) => decision.answer !== null).length;
    tally.answered += answered;
    tally.open += view.waiting.length - answered;
    const recorded = metrics.get(runId);
    if (recorded !== undefined) {
      tally.rework += recorded.rework;
      tally.verifications.pass += recorded.verifications.pass;
      tally.verifications.fail += recorded.verifications.fail;
      tally.verifications.unstable += recorded.verifications.unstable;
    }
  }
  const workflows = [...tallies.values()].toSorted(
    (a, b) => b.total - a.total || a.workflow.localeCompare(b.workflow),
  );
  return { since, total: kept.length, workflows, failed, completed, stopped };
}
