// A Run as every reader sees one, for tests about what a Run's state *means*.
//
// Written out in full rather than asserted into shape: the fields a rule reads are the
// point of these tests, and a cast would let one silently disappear without the test
// noticing.

import { Effect, FileSystem } from "effect";
import type { RunFacts } from "../../src/runs";

export function runFacts(over: Partial<RunFacts> = {}): RunFacts {
  const id = over.id ?? "r1";
  return {
    id,
    workflow: "implement",
    project: "/project",
    cwd: "/project",
    task: null,
    parent: null,
    outcome: "unspecified",
    created: "2026-09-14T10:00:00Z",
    finished: null,
    state: "running",
    settled: { inputs: {}, strategies: {}, sources: {} },
    branch: null,
    mr: null,
    workspace: null,
    worktree: null,
    dir: `/state/runs/${id}`,
    evidence: `/state/evidence/${id}`,
    asking: [],
    held: false,
    note: null,
    summary: null,
    ...over,
  };
}

/** A Run whose directories exist under this state directory, for readers of its files. */
export const madeRun = Effect.fn("test.madeRun")(function* (
  stateDir: string,
  over: Partial<RunFacts> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const id = over.id ?? "r1";
  const run = runFacts({
    dir: `${stateDir}/runs/${id}`,
    evidence: `${stateDir}/evidence/${id}`,
    ...over,
  });
  yield* fs.makeDirectory(run.dir, { recursive: true }).pipe(Effect.orDie);
  yield* fs.makeDirectory(run.evidence, { recursive: true }).pipe(Effect.orDie);
  return run;
});
