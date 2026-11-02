// What a Run's agents were launched on, as each launch recorded it. Apart from the agents
// layer so the board and the CLI can read it without loading it.

import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import { DateTime, Duration, Effect, FileSystem, Schema } from "effect";
import { ensureLockDir, withLock } from "./lock";
import { RanOn, type RunAgent, type RunStep } from "./board-model";
import { StepPlace } from "./steps";
import { ClaudeSubagents } from "./subagents";

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

const decodeLaunched = Schema.decodeUnknownResult(Schema.fromJsonString(Launched));

/** Every agent this run has launched, oldest first, in the order they were launched. */
export const readLaunches = Effect.fn("Launches.read")(function* (stateDir: string, runId: string) {
  const fs = yield* FileSystem.FileSystem;
  const dir = launchDir(stateDir, runId);
  const names = yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
  const order = Str.split(
    yield* fs.readFileString(`${dir}/${LAUNCH_ORDER}`).pipe(Effect.orElseSucceed(() => "")),
    "\n",
  );
  // A launch from before the order was kept sorts first, by name.
  const rank = (name: string) =>
    order.lastIndexOf(pipe_(name, Str.slice(0, -LAUNCH_SUFFIX.length)));
  const launches: Launched[] = [];
  const launched = Arr.filter(names, (one) => pipe_(one, Str.endsWith(LAUNCH_SUFFIX)))
    .sort()
    .sort((one, other) => rank(one) - rank(other));
  for (const name of launched) {
    const text = yield* fs.readFileString(`${dir}/${name}`).pipe(Effect.orElseSucceed(() => ""));
    const read = decodeLaunched(text);
    if (read._tag === "Success") launches.push(read.success);
  }
  return launches;
});

/** A Run's agents in launch order, with what each ran on. */
export const runAgents = (stateDir: string, runId: string) =>
  readLaunches(stateDir, runId).pipe(
    Effect.map((launches) =>
      Arr.map(launches, (one): RunAgent => ({
        operation: one.operation,
        agent: one.agent,
        harness: one.harness,
        model: one.model ?? null,
        effort: one.effort ?? null,
        from: one.from ?? null,
        why: one.why ?? null,
        at: one.at === undefined ? null : DateTime.formatIso(DateTime.makeUnsafe(one.at)),
      })),
    ),
  );

/** Each operation the Run launched, in launch order, with its latest agent and whether its Output is in. */
export const operationsOf = Effect.fn("Launches.operations")(function* (
  stateDir: string,
  runId: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const steps = new Map<string, RunStep>();
  for (const one of yield* readLaunches(stateDir, runId)) {
    const done = yield* fs.exists(one.output).pipe(Effect.orElseSucceed(() => false));
    steps.set(one.operation, { operation: one.operation, agent: one.agent, done });
  }
  return [...steps.values()];
});
