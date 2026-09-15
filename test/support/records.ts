// A Run record as the board reads one, for tests about what a Run's state *means*.
//
// Written out in full rather than asserted into shape: the fields a rule reads are the
// point of these tests, and a cast would let one silently disappear from the record
// without the test noticing.

import type { RunRecord } from "../../src/run";

export function runRecord(over: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "r1",
    seq: 1,
    slug: "add-a-picker",
    named_after: "picker",
    workflow: "implement",
    worktree: null,
    decisions: {},
    previous_review: null,
    definition: null,
    approved_verifications: [],
    outcome: null,
    evidence_gaps: [],
    obstacle: null,
    halt: null,
    blocking_seen: null,
    unreviewed: null,
    notified: [],
    fixed: 0,
    unpushed: null,
    cwd: "/project",
    session: null,
    workspace: null,
    workspace_label: null,
    workspace_worktree: null,
    activated_cwd: null,
    created_at: "2026-09-14T10:00:00Z",
    finished_at: null,
    status: "running",
    iteration: 1,
    max_iterations: 1,
    inputs: {},
    input_sources: {},
    steps: [],
    parent: null,
    children: [],
    choices: [],
    awaiting: null,
    fanout: null,
    handoffs: [],
    disputed: [],
    deferred: [],
    outstanding: [],
    target_label: null,
    synthesis: null,
    mr_url: null,
    linear_issues: [],
    summary: null,
    ...over,
  };
}
