// What a Run's agents were launched on, as each launch recorded it. Apart from the agents
// layer so the board and the CLI can read it without loading it.

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
import { RanOn, type RunAgent, type RunStep } from "./board-model";
import { StepPlace } from "./steps";
import { ClaudeSubagents } from "./subagents";
import { StoreWrites } from "./store-writes";

/** The Step run an agent's work was given in. */
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

/**
 * The agent this work is on. Recorded by the launch Activity, so every later attempt
 * reattaches to this agent rather than starting another.
 */
export const Launched = Schema.Struct({
  agent: Schema.String,
  output: Schema.String,
  /** True where the agent was already there and this launch reconciled onto it. */
  reused: Schema.Boolean,
  /**
   * What a repair needs to reach this same agent about this same work. Kept here because
   * this is the durable record: a host that restarts between the collection and the
   * repair reads the agent and the operation back rather than deriving them again.
   */
  runId: Schema.String,
  operation: Schema.String,
  role: Schema.String,
  workflow: Schema.String,
  harness: Schema.String,
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Schema.NullOr(Schema.String)),
  claudeSubagents: Schema.optionalKey(ClaudeSubagents),
  /** When it was given this work, on the clock its harness's telemetry is stamped with. */
  at: Schema.optionalKey(Schema.Finite),
  /** Which agent of this work it is: past 1, one that took over from an agent that ran out. */
  sequence: Schema.optionalKey(Schema.Finite),
  /** What this work fell back from, and why, where it did. */
  from: Schema.optionalKey(RanOn),
  why: Schema.optionalKey(Schema.String),
  /** herdr's id for the process given this work: the name alone is reused by the next one. */
  terminalId: Schema.optionalKey(Schema.String),
  /** The harness session herdr reported for it, which a pane herdr restores resumes. */
  agentSession: Schema.optionalKey(AgentSession),
  step: Schema.optionalKey(LaunchedIn),
});
export type Launched = typeof Launched.Type;

/**
 * What an agent on core was started with, for the host to start it again once core has
 * lost it. Nothing here is a credential: the profile's environment and the Run's authority
 * are read again when it is.
 */
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

/** Where a Run's agents on core keep what they were started with, until one is ended. */
export const startedDir = (stateDir: string, runId: string) => `${stateDir}/relaunch/${runId}`;

/** Longer than an end's stop and close, or a start on core, each of which it may wait out. */
const RELAUNCH_LOCK_BUDGET = Duration.minutes(2);

/**
 * Held to start one of the Run's agents again after core lost it, and to end one: an end
 * then sees the agent recovery started, and recovery never starts one an end has retired.
 */
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
/** One operation a line, in the order its agent was launched. */
export const LAUNCH_ORDER = "launches";

/** What a launch's files are named by: its operation, and its sequence past the first. */
export const stemOf = (one: { readonly operation: string; readonly sequence?: number }) =>
  (one.sequence ?? 1) > 1 ? `${one.operation}.r${one.sequence}` : one.operation;

/** Where a Run's agents keep their launch records, prompts and outputs. */
export const launchDir = (stateDir: string, runId: string) => `${stateDir}/agents/${runId}`;

const LaunchedJson = Schema.fromJsonString(Launched);
const decodeLaunched = Schema.decodeOption(LaunchedJson);
const encodeLaunched = flow(Schema.encodeResult(LaunchedJson), Result.getOrThrow);
/** A launch file as an older build wrote it, for the import. */
export const decodeLaunchOption = decodeLaunched;

/** What a write to the launch records invalidates. */
export const LAUNCHES = "collie/launches";

/** The launch records, in the host's database (ADR-draft-collies-own-records-live-in-the-hosts-database). */
export interface LaunchesApi {
  /** Each of these Runs' launches, oldest first; a Run with none is absent. */
  readonly of: (
    runs: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<Launched>>>;
  /** Every launch of these agents, whichever Run. */
  readonly byAgent: (agents: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<Launched>>;
  /** Every harness session a launch recorded. */
  readonly sessions: Effect.Effect<ReadonlyArray<AgentSession>>;
  /** Records the launch, in place of the one with its operation and sequence. */
  readonly record: (launched: Launched) => Effect.Effect<void>;
  /** Puts the launch last in its Run's order: its agent was given the work. */
  readonly order: (launched: Launch) => Effect.Effect<void>;
  /** The launch its Run ordered last, and when. */
  readonly lastOrdered: (
    run: string,
  ) => Effect.Effect<{ readonly stem: string; readonly at: number } | null>;
  /** Whether the launch is in its Run's order: this same work, replayed. */
  readonly ordered: (launched: Launch) => Effect.Effect<boolean>;
  /** The session herdr reports, recorded while the launch is still on the terminal it names. */
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
    // An unordered launch, one from before the order was kept, sorts first, by its old file's name.
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
        `.pipe(Effect.andThen(moved(launched.runId)), Effect.orDie),
      order: (launched) =>
        Effect.flatMap(
          Clock.currentTimeMillis,
          (now) => sql`
            UPDATE collie_launches
            SET ordered = (SELECT coalesce(max(ordered), -1) + 1 FROM collie_launches WHERE run = ${launched.runId}),
              ordered_at = ${now}
            WHERE run = ${launched.runId} AND stem = ${stemOf(launched)}
          `,
        ).pipe(Effect.andThen(moved(launched.runId)), Effect.orDie),
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

/** Every agent this Run has launched, oldest first, in the order they were launched. */
export const readLaunches = Effect.fn("Launches.read")(function* (runId: string) {
  return (yield* (yield* Launches).of([runId])).get(runId) ?? [];
});

/** Each of these Runs' launches, in one read. */
export const launchesOf = (runs: ReadonlyArray<string>) =>
  Launches.use((launches) => launches.of(runs));

export const recordLaunch = (launched: Launched) =>
  Launches.use((launches) => launches.record(launched));

export const orderLaunch = (launched: Launch) =>
  Launches.use((launches) => launches.order(launched));

/** The launch the Run ordered last, and when; null before any. */
export const lastOrdered = (run: string) => Launches.use((launches) => launches.lastOrdered(run));

export const wasOrdered = (launched: Launch) =>
  Launches.use((launches) => launches.ordered(launched));

export const recordSession = (launched: Launched, session: AgentSession) =>
  Launches.use((launches) => launches.session(launched, session));

/** A Run's agent as its launch recorded it, with what it ran on. */
export const agentOfLaunch = (one: Launched): RunAgent => ({
  operation: one.operation,
  agent: one.agent,
  harness: one.harness,
  model: one.model ?? null,
  effort: one.effort ?? null,
  from: one.from ?? null,
  why: one.why ?? null,
  at: one.at === undefined ? null : DateTime.formatIso(DateTime.makeUnsafe(one.at)),
});

/** A Run's agents in launch order, with what each ran on. */
export const runAgents = (runId: string) =>
  readLaunches(runId).pipe(Effect.map(Arr.map(agentOfLaunch)));

/** Each operation the Run launched, in launch order, with its latest agent and whether its Output is in. */
export const operationsOf = Effect.fn("Launches.operations")(function* (runId: string) {
  const fs = yield* FileSystem.FileSystem;
  const steps = new Map<string, RunStep>();
  for (const one of yield* readLaunches(runId)) {
    const done = yield* fs.exists(one.output).pipe(Effect.orElseSucceed(() => false));
    steps.set(one.operation, { operation: one.operation, agent: one.agent, done });
  }
  return [...steps.values()];
});
