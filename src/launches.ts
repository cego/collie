import * as Arr from "effect/Array";
import {
  Clock,
  Context,
  DateTime,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Result,
  Schema,
  flow,
} from "effect";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as SqlClient from "effect/sql/SqlClient";
import { ensureLockDir, withLock } from "./lock";
import { RanOn, type RunStep } from "./board-model";
import { StepPlace } from "./steps";
import { ClaudeSubagents } from "./subagents";
import { StoreWrites } from "./store-writes";
import { markWorked } from "./run-records";

export const LaunchedIn = Schema.Struct({
  step: Schema.String,
  place: Schema.NullOr(StepPlace),
  key: Schema.String,
});
export const AgentSession = Schema.Struct({ kind: Schema.String, value: Schema.String });
export type AgentSession = typeof AgentSession.Type;

export const sameSession = (
  one: AgentSession | null | undefined,
  other: AgentSession | null | undefined,
) => one != null && other != null && one.kind === other.kind && one.value === other.value;

export const Launched = Schema.Struct({
  agent: Schema.String,
  output: Schema.String,
  reused: Schema.Boolean,
  runId: Schema.String,
  operation: Schema.String,
  role: Schema.String,
  workflow: Schema.String,
  harness: Schema.String,
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Schema.NullOr(Schema.String)),
  claudeSubagents: Schema.optionalKey(ClaudeSubagents),
  at: Schema.optionalKey(Schema.Finite),
  sequence: Schema.optionalKey(Schema.Finite),
  from: Schema.optionalKey(RanOn),
  why: Schema.optionalKey(Schema.String),
  terminalId: Schema.optionalKey(Schema.String),
  agentSession: Schema.optionalKey(AgentSession),
  step: Schema.optionalKey(LaunchedIn),
});
export type Launched = typeof Launched.Type;

export const StartedWith = Schema.Struct({
  runId: Schema.String,
  operation: Schema.String,
  role: Schema.String,
  persona: Schema.optionalKey(Schema.NullOr(Schema.String)),
  agent: Schema.NullOr(Schema.String),
  workflow: Schema.String,
  task: Schema.NullOr(Schema.String),
  cwd: Schema.String,
  output: Schema.String,
  skill: Schema.NullOr(Schema.String),
  harness: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  effort: Schema.NullOr(Schema.String),
  permissions: Schema.NullOr(Schema.String),
  claudeSubagents: Schema.optionalKey(ClaudeSubagents),
  sequence: Schema.optionalKey(Schema.Finite),
});

export const startedDir = (stateDir: string, runId: string) => `${stateDir}/relaunch/${runId}`;

const RELAUNCH_LOCK_BUDGET = Duration.minutes(2);

export const withRelaunchLock = <A, E, R, A2, E2, R2>(
  stateDir: string,
  runId: string,
  contended: Effect.Effect<A2, E2, R2>,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const lock = `${startedDir(stateDir, runId)}.lock`;
    yield* ensureLockDir(lock);
    return yield* withLock(lock, contended, effect, RELAUNCH_LOCK_BUDGET);
  });

export const LAUNCH_SUFFIX = ".launch.json";
export const LAUNCH_ORDER = "launches";

export const stemOf = (one: { readonly operation: string; readonly sequence?: number }) =>
  (one.sequence ?? 1) > 1 ? `${one.operation}.r${one.sequence}` : one.operation;

export const launchDir = (stateDir: string, runId: string) => `${stateDir}/agents/${runId}`;

const LaunchedJson = Schema.fromJsonString(Launched);
const decodeLaunched = Schema.decodeOption(LaunchedJson);
const encodeLaunched = flow(Schema.encodeResult(LaunchedJson), Result.getOrThrow);
export const decodeLaunchOption = decodeLaunched;

export const LAUNCHES = "collie/launches";

export interface LaunchesApi {
  readonly of: (
    runs: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<Launched>>>;
  readonly recordsOf: (
    runs: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<string>>>;
  readonly byAgent: (agents: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Launched>>;
  readonly sessions: Effect.Effect<ReadonlyArray<AgentSession>>;
  readonly record: (launched: Launched) => Effect.Effect<void>;
  readonly order: (launched: Launch) => Effect.Effect<void>;
  readonly lastOrderedOf: (
    runs: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, { readonly stem: string; readonly at: number }>>;
  readonly lastOrdered: (
    run: string,
  ) => Effect.Effect<{ readonly stem: string; readonly at: number } | null>;
  readonly ordered: (launched: Launch) => Effect.Effect<boolean>;
  readonly session: (launched: Launched, session: AgentSession) => Effect.Effect<void>;
}

type Launch = { readonly runId: string; readonly operation: string; readonly sequence?: number };

export class Launches extends Context.Service<Launches, LaunchesApi>()("collie/Launches") {}

const decoded = (rows: ReadonlyArray<{ readonly record: string }>) =>
  Arr.flatMap(rows, (row) => Option.toArray(decodeLaunched(row.record)));

export const launchesLayer = Layer.effect(Launches)(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const reactivity = yield* Reactivity.Reactivity;
    const told = Option.getOrUndefined(yield* Effect.serviceOption(StoreWrites));
    const moved = (run: string) =>
      Effect.andThen(
        Effect.sync(() => told?.([run])),
        reactivity.invalidate([LAUNCHES]),
      );
    const inOrder = sql`ORDER BY run, ordered, stem || '.launch.json'`;
    return {
      of: (runs) =>
        runs.length === 0
          ? Effect.succeed(new Map())
          : sql<{ readonly run: string; readonly record: string }>`
              SELECT run, record FROM collie_launches WHERE run IN ${sql.in(runs)} ${inOrder}
            `.pipe(
              Effect.map((rows) => {
                const byRun = new Map<string, Launched[]>();
                for (const row of rows)
                  for (const one of decoded([row]))
                    byRun.set(row.run, [...(byRun.get(row.run) ?? []), one]);
                return byRun;
              }),
              Effect.orDie,
            ),
      recordsOf: (runs) =>
        runs.length === 0
          ? Effect.succeed(new Map())
          : sql<{ readonly run: string; readonly record: string }>`
              SELECT run, record FROM collie_launches WHERE run IN ${sql.in(runs)} ${inOrder}
            `.pipe(
              Effect.map((rows) => {
                const byRun = new Map<string, string[]>();
                for (const row of rows)
                  byRun.set(row.run, [...(byRun.get(row.run) ?? []), row.record]);
                return byRun;
              }),
              Effect.orDie,
            ),
      byAgent: (agents) =>
        agents.length === 0
          ? Effect.succeed([])
          : sql<{ readonly record: string }>`
              SELECT record FROM collie_launches WHERE agent IN ${sql.in(agents)} ${inOrder}
            `.pipe(Effect.map(decoded), Effect.orDie),
      sessions: sql<{ readonly record: string }>`
        SELECT record FROM collie_launches WHERE json_extract(record, '$.agentSession') IS NOT NULL
      `.pipe(
        Effect.map((rows) =>
          Arr.flatMap(decoded(rows), (one) => Arr.ensure(one.agentSession ?? [])),
        ),
        Effect.orDie,
      ),
      record: (launched) =>
        sql`
          INSERT INTO collie_launches (run, stem, record) VALUES (${launched.runId}, ${stemOf(launched)}, ${encodeLaunched(launched)})
          ON CONFLICT (run, stem) DO UPDATE SET record = excluded.record
        `.pipe(
          Effect.andThen(markWorked(launched.runId)),
          sql.withTransaction,
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.andThen(moved(launched.runId)),
          Effect.orDie,
        ),
      order: (launched) =>
        Effect.flatMap(
          Clock.currentTimeMillis,
          (now) => sql`
            UPDATE collie_launches
            SET ordered = (SELECT coalesce(max(ordered), -1) + 1 FROM collie_launches WHERE run = ${launched.runId}),
              ordered_at = ${now}
            WHERE run = ${launched.runId} AND stem = ${stemOf(launched)}
          `,
        ).pipe(
          Effect.andThen(markWorked(launched.runId)),
          sql.withTransaction,
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.andThen(moved(launched.runId)),
          Effect.orDie,
        ),
      lastOrderedOf: (runs) =>
        runs.length === 0
          ? Effect.succeed(new Map())
          : sql<{ readonly run: string; readonly stem: string; readonly at: number | null }>`
              SELECT run, stem, ordered_at AS at FROM (
                SELECT run, stem, ordered_at,
                  row_number() OVER (PARTITION BY run ORDER BY ordered DESC) AS nth
                FROM collie_launches WHERE run IN ${sql.in(runs)} AND ordered IS NOT NULL
              ) WHERE nth = 1
            `.pipe(
              Effect.map(
                (rows) =>
                  new Map(Arr.map(rows, (row) => [row.run, { stem: row.stem, at: row.at ?? 0 }])),
              ),
              Effect.orDie,
            ),
      lastOrdered: (run) =>
        sql<{ readonly stem: string; readonly at: number | null }>`
          SELECT stem, ordered_at AS at FROM collie_launches
          WHERE run = ${run} AND ordered IS NOT NULL ORDER BY ordered DESC LIMIT 1
        `.pipe(
          Effect.map(([last]) =>
            last === undefined ? null : { stem: last.stem, at: last.at ?? 0 },
          ),
          Effect.orDie,
        ),
      ordered: (launched) =>
        sql<{ readonly one: number }>`
          SELECT 1 AS one FROM collie_launches
          WHERE run = ${launched.runId} AND stem = ${stemOf(launched)} AND ordered IS NOT NULL
        `.pipe(
          Effect.map((rows) => rows.length > 0),
          Effect.orDie,
        ),
      session: (launched, session) =>
        Effect.gen(function* () {
          const [now] = decoded(
            yield* sql<{ readonly record: string }>`
              SELECT record FROM collie_launches
              WHERE run = ${launched.runId} AND stem = ${stemOf(launched)}
            `,
          );
          if (now === undefined || now.terminalId !== launched.terminalId) return;
          yield* sql`
            UPDATE collie_launches SET record = ${encodeLaunched({ ...now, agentSession: session })}
            WHERE run = ${launched.runId} AND stem = ${stemOf(launched)}
          `;
          yield* moved(launched.runId);
        }).pipe(sql.withTransaction, Effect.orDie),
    } satisfies LaunchesApi;
  }),
);

export const launchesAhead = Effect.fn("Launches.ahead")(function* (
  launches: LaunchesApi,
  runs: ReadonlyArray<string>,
  ordering: ReadonlyArray<string>,
) {
  const ids = new Set(runs);
  const ordered = new Set(ordering);
  const all = yield* Effect.cached(launches.recordsOf(runs));
  const last = yield* Effect.cached(launches.lastOrderedOf(ordering));
  return {
    ...launches,
    of: (some) =>
      Arr.every(some, (run) => ids.has(run))
        ? Effect.map(
            all,
            (got) =>
              new Map(
                Arr.flatMap(some, (run) => {
                  const launched = decoded(Arr.map(got.get(run) ?? [], (record) => ({ record })));
                  return launched.length === 0 ? [] : [[run, launched]];
                }),
              ),
          )
        : launches.of(some),
    lastOrdered: (run) =>
      ordered.has(run)
        ? Effect.map(last, (got) => got.get(run) ?? null)
        : launches.lastOrdered(run),
  } satisfies LaunchesApi;
});

export const readLaunches = Effect.fn("Launches.read")(function* (runId: string) {
  return (yield* (yield* Launches).of([runId])).get(runId) ?? [];
});

export const launchesOf = (runs: ReadonlyArray<string>) =>
  Launches.use((launches) => launches.of(runs));

export const launchesOfAgents = (agents: ReadonlyArray<string>) =>
  Launches.use((launches) => launches.byAgent(agents));

export const recordLaunch = (launched: Launched) =>
  Launches.use((launches) => launches.record(launched));

export const orderLaunch = (launched: Launch) =>
  Launches.use((launches) => launches.order(launched));

export const lastOrdered = (run: string) => Launches.use((launches) => launches.lastOrdered(run));

export const wasOrdered = (launched: Launch) =>
  Launches.use((launches) => launches.ordered(launched));

export const recordSession = (launched: Launched, session: AgentSession) =>
  Launches.use((launches) => launches.session(launched, session));

export const agentOfLaunch = (one: Launched) => ({
  operation: one.operation,
  agent: one.agent,
  harness: one.harness,
  model: one.model ?? null,
  effort: one.effort ?? null,
  from: one.from ?? null,
  why: one.why ?? null,
  at: one.at === undefined ? null : DateTime.formatIso(DateTime.makeUnsafe(one.at)),
});

export const runAgents = (runId: string) =>
  readLaunches(runId).pipe(Effect.map(Arr.map(agentOfLaunch)));

export const operationsOf = Effect.fn("Launches.operations")(function* (runId: string) {
  const fs = yield* FileSystem.FileSystem;
  const steps = new Map<string, RunStep>();
  for (const one of yield* readLaunches(runId)) {
    const done = yield* fs.exists(one.output).pipe(Effect.orElseSucceed(() => false));
    steps.set(one.operation, { operation: one.operation, agent: one.agent, done });
  }
  return [...steps.values()];
});
