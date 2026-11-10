// A Run as every reader sees one, for tests about what a Run's state *means*.
//
// Written out in full rather than asserted into shape: the fields a rule reads are the
// point of these tests, and a cast would let one silently disappear without the test
// noticing.

import * as Arr from "effect/Array";
import { Data, Effect, FileSystem, Option } from "effect";
import type { RunFacts } from "../../src/runs";
import { readLaunches, runAgents } from "../../src/launches";
import { recordsAt, recordsReadLayer, type Records } from "../../src/records";
import { everyRegistered } from "../../src/registry";
import { deliveriesOf, readLedger } from "../../src/steering";

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
    landing: null,
    workspace: null,
    worktree: null,
    dir: `/state/runs/${id}`,
    evidence: `/state/evidence/${id}`,
    asking: [],
    answered: [],
    held: false,
    repo: null,
    parked: null,
    awaiting: null,
    undriven: false,
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

export { recordsAt };

export class NoHostDb extends Data.TaggedError("NoHostDb")<{ readonly stateDir: string }> {}

/**
 * What a host on `stateDir` recorded, read over a connection of the test's own; a failure,
 * which a poll retries, until that host has made and migrated `host.db`.
 */
export const hostRecords = <A, E>(stateDir: string, read: Effect.Effect<A, E, Records>) =>
  Effect.gen(function* () {
    if (!(yield* (yield* FileSystem.FileSystem).exists(`${stateDir}/host.db`).pipe(Effect.orDie)))
      return yield* new NoHostDb({ stateDir });
    return yield* read.pipe(
      Effect.provide(recordsReadLayer(stateDir)),
      Effect.catchCause(() => Effect.fail(new NoHostDb({ stateDir }))),
    );
  });

export const deliveredTo = (stateDir: string, run: string) =>
  hostRecords(stateDir, deliveriesOf(run));

export const ledgerOf = (stateDir: string, terminalId: string) =>
  hostRecords(stateDir, readLedger(terminalId));

/** The agents a host on `stateDir` registered; none before it has made `host.db`. */
export const registeredAt = (stateDir: string) =>
  hostRecords(stateDir, everyRegistered).pipe(Effect.orElseSucceed(() => []));

/** A Run's launches as the host on `stateDir` recorded them. */
export const launchesAt = (stateDir: string, run: string) =>
  readLaunches(run).pipe(Effect.provide(recordsAt(stateDir)));

/** A Run's agents as the host on `stateDir` recorded their launches. */
export const agentsAt = (stateDir: string, run: string) =>
  runAgents(run).pipe(Effect.provide(recordsAt(stateDir)));

/** The launch of `operation` the host on `stateDir` recorded for the Run; none before it has. */
export const launchOf = (stateDir: string, run: string, operation: string) =>
  hostRecords(stateDir, readLaunches(run)).pipe(
    Effect.map((launches) =>
      Option.getOrUndefined(Arr.findFirst(launches, (one) => one.operation === operation)),
    ),
    Effect.orElseSucceed(() => undefined),
  );

/** The Run's launch of `operation`, as the host on `stateDir` recorded it. */
export const launchedAt = (stateDir: string, run: string, operation: string) =>
  launchesAt(stateDir, run).pipe(
    Effect.map((launches) =>
      Option.getOrThrow(Arr.findFirst(launches, (one) => one.operation === operation)),
    ),
  );
