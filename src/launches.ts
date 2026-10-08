// What a Run's agents were launched on, as each launch recorded it. Apart from the agents
// layer so the board and the CLI can read it without loading it.

import { DateTime, Effect, FileSystem, Schema } from "effect";
import { RanOn, type RunAgent } from "./board-model";

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
  /** When it was given this work, on the clock its harness's telemetry is stamped with. */
  at: Schema.optionalKey(Schema.Number),
  /** Which agent of this work it is: past 1, one that took over from an agent that ran out. */
  sequence: Schema.optionalKey(Schema.Number),
  /** What this work fell back from, and why, where it did. */
  from: Schema.optionalKey(RanOn),
  why: Schema.optionalKey(Schema.String),
  /** herdr's id for the process given this work: the name alone is reused by the next one. */
  terminalId: Schema.optionalKey(Schema.String),
});
export type Launched = typeof Launched.Type;

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
  const order = (yield* fs
    .readFileString(`${dir}/${LAUNCH_ORDER}`)
    .pipe(Effect.orElseSucceed(() => ""))).split("\n");
  // A launch from before the order was kept sorts first, by name.
  const rank = (name: string) => order.lastIndexOf(name.slice(0, -LAUNCH_SUFFIX.length));
  const launches: Launched[] = [];
  const launched = names
    .filter((one) => one.endsWith(LAUNCH_SUFFIX))
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
      launches.map((one): RunAgent => ({
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
