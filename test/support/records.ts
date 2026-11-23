// WARNING: Written out in full rather than cast, so a field a rule reads cannot silently disappear.
import * as Arr from "effect/Array";
import { Data, Effect, FileSystem, Layer, Option } from "effect";
import type { RunFacts } from "../../src/runs";
import { readLaunches, runAgents } from "../../src/launches";
import { recordsAt, recordsReadLayer } from "../../src/records";
import type { Records } from "../../src/records";
import { everyRegistered } from "../../src/registry";
import { deliveriesOf, readLedger } from "../../src/steering";
import { RunRecords } from "../../src/run-records";
import type { RunRecordsApi } from "../../src/run-records";
import { platformLayer } from "../../src/platform";

export function runFacts(over: Partial<RunFacts> = {}) {
  const id = over.id ?? "r1";
  const returned: RunFacts = {
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
  return returned;
}

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

// WARNING: A read fails until the host has made and migrated host.db; the poll retries.
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

export const registeredAt = (stateDir: string) =>
  hostRecords(stateDir, everyRegistered).pipe(Effect.orElseSucceed(() => []));

export const launchesAt = (stateDir: string, run: string) =>
  readLaunches(run).pipe(Effect.provide(recordsAt(stateDir)));

export const agentsAt = (stateDir: string, run: string) =>
  runAgents(run).pipe(Effect.provide(recordsAt(stateDir)));

export const launchOf = (stateDir: string, run: string, operation: string) =>
  hostRecords(stateDir, readLaunches(run)).pipe(
    Effect.map((launches) =>
      Option.getOrUndefined(Arr.findFirst(launches, (one) => one.operation === operation)),
    ),
    Effect.orElseSucceed(() => undefined),
  );

export const launchedAt = (stateDir: string, run: string, operation: string) =>
  launchesAt(stateDir, run).pipe(
    Effect.map((launches) =>
      Option.getOrThrow(Arr.findFirst(launches, (one) => one.operation === operation)),
    ),
  );

// WARNING: Reads and writes must meet the host's records, not runEffect's empty ones.
export const hostRunRecords: (stateDir: () => string) => RunRecordsApi = (stateDir) => {
  const at = <A, E, R>(use: (records: RunRecordsApi) => Effect.Effect<A, E, R>) =>
    FileSystem.FileSystem.pipe(
      Effect.flatMap((fs) => fs.makeDirectory(stateDir(), { recursive: true })),
      Effect.orDie,
      Effect.andThen(
        Effect.suspend(() =>
          RunRecords.use(use).pipe(Effect.provide(Layer.orDie(recordsAt(stateDir())))),
        ),
      ),
      Effect.provide(platformLayer),
    );
  return {
    lines: (run, journal) => at((records) => records.lines(run, journal)),
    linesOf: (runs, journal) => at((records) => records.linesOf(runs, journal)),
    briefsOf: (runs, journal) => at((records) => records.briefsOf(runs, journal)),
    lastOf: (runs, journal, kinds) => at((records) => records.lastOf(runs, journal, kinds)),
    append: (run, journal, lines) => at((records) => records.append(run, journal, lines)),
    fact: (run, name) => at((records) => records.fact(run, name)),
    factsOf: (runs, name) => at((records) => records.factsOf(runs, name)),
    factsUnder: (run, prefix) => at((records) => records.factsUnder(run, prefix)),
    put: (run, name, value) => at((records) => records.put(run, name, value)),
    update: (run, name, change) => at((records) => records.update(run, name, change)),
    activity: (runs) => at((records) => records.activity(runs)),
    stepSamples: at((records) => records.stepSamples),
    touch: (run) => at((records) => records.touch(run)),
    control: (control, run, key) => at((records) => records.control(control, run, key)),
    controlsOf: (control, run) => at((records) => records.controlsOf(control, run)),
    everyControl: (control) => at((records) => records.everyControl(control)),
    controlsIn: (runs) => at((records) => records.controlsIn(runs)),
    setControl: (control, run, data, key) =>
      at((records) => records.setControl(control, run, data, key)),
  };
};

export const overHost =
  (stateDir: () => string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, RunRecords, hostRunRecords(stateDir));
