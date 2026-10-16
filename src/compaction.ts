// Compaction between pieces of work: one absolute threshold, one policy, and the
// per-agent controls a harness's official interface installs when Collie launches it.
//
// The policy lives here once because every work-dispatch path shares it — a Workflow's
// next step, a fix round, a hand-off from another Run — and a threshold repeated per
// harness is a threshold that disagrees with itself.

import { Clock, Data, Effect, FileSystem, Path, PlatformError, Result, Schema } from "effect";
import type { BunServices } from "@effect/platform-bun/BunServices";
import type { Channel } from "./dispatcher";
import type { Herdr, Submission } from "./herdr";
import { LOCK_CLAIM_SPACING_MS, ensureLockDir, withLock } from "./lock";
import { reason } from "./naming";
import { COMPACTION_OFF } from "./settings";
import { commandOf, processOf, stillRunning, terminate } from "./processes";

/**
 * How long Collie waits for a compaction request to resolve before it pauses the Run.
 * Fixed: no workflow, step or harness shortens it. A Run that waited less would send
 * the next piece of work into a context whose size nobody has established.
 */
export const COMPACTION_WAIT_MS = 5 * 60 * 1000;

/**
 * How long a stop waits for an agent to be Quiet: sized like upstream's own drain tests.
 * Fixed, so a stop never hangs a door.
 */
export const STOP_WAIT_MS = 30_000;

/** Where an agent's controls live, for as long as the agent does. */
export const CONTROL_DIR = "compaction";
const CONTROL_FILE = "control.json";

/**
 * The configured threshold, resolved. `bad` is kept as a message rather than coerced:
 * the fallback would be the default, so a `-1` or a `3.5` someone meant as a limit
 * would silently become the default and compact an agent they had tried to leave alone.
 */
export type Threshold =
  | { readonly tokens: number }
  | { readonly off: true }
  | { readonly bad: string };

export function threshold(configured: number): Threshold {
  if (configured === COMPACTION_OFF) return { off: true };
  if (!Number.isSafeInteger(configured) || configured < 0) {
    return {
      bad:
        `compact_at_tokens has to be a whole number of tokens above zero, ` +
        `or ${COMPACTION_OFF} to turn compaction off — not ${configured}`,
    };
  }
  return { tokens: configured };
}

/**
 * A request that provably never left: the channel refused it, the endpoint was not
 * recorded, the thread could not be bound. Only the adapter knows this — everything up
 * to the submitting call is `Unsubmitted`, and the submitting call's own failure is not,
 * because a socket that closed or an HTTP call that timed out may have been accepted
 * first. It is the one request failure that may release the waiting work.
 */
export class Unsubmitted extends Data.TaggedError("Unsubmitted")<{
  readonly message: string;
}> {}

/**
 * What a harness's official interface establishes about one request. There is no
 * third member on purpose: an absent completion is not a failure, so an unresolved
 * request is `null` from `poll` and stays unresolved until the budget runs out.
 */
export type CompactionOutcome =
  | { readonly kind: "success" }
  | { readonly kind: "failure"; readonly reason: string };

/** The agent a port is acting on, and the directory its controls were installed in. */
export interface LaunchContext {
  agent: string;
  harness: string;
  cwd: string;
  /** This agent's own control directory. Collie creates it before `install`. */
  dir: string;
  /** Shell lines setting the operator's environment, for a server the port starts. */
  env?: ReadonlyArray<string>;
}

export interface AgentContext extends LaunchContext {
  /** The Run this agent belongs to. A delivery's ledger line names the Run, not the agent. */
  run: string;
  /**
   * The one channel to this agent. A request's is owned by the Dispatcher transaction
   * opened for it: a compaction is a delivery like any other — it is recorded, it is
   * ordered against whatever else is due, and it goes out under the same lock — so an
   * adapter is handed a channel rather than herdr itself. A reading's or a poll's sends nothing.
   */
  channel: Channel;
  /** The local endpoint this agent's controls talk to, where it has one. */
  endpoint: string | null;
}

/**
 * Everything an adapter may need: the filesystem for the telemetry its controls write,
 * and the platform services herdr's own channel and a version probe run on.
 */
type PortServices = FileSystem.FileSystem | Path.Path | BunServices;
/** What reading a file or talking to a harness fails with, in one name. */
type PortError = Error | PlatformError.PlatformError;

/**
 * One harness's official compaction interface. Four methods, because the shared policy
 * owns everything else: `poll` says what the harness has established so far and never
 * how long to keep asking, and `request` submits without claiming completion.
 */
/** What `install` gives back: the extra launch arguments, and what it left running. */
export interface Installed {
  args: ReadonlyArray<string>;
  /** The local endpoint the controls talk to, for a harness that needs one. */
  endpoint?: string;
  /** The process holding that endpoint open, so a later launch can put it down. */
  pid?: number;
  /**
   * What that process's command line contains. Recorded with the pid because a pid on
   * its own is not an identity: the endpoint may have died months ago and the machine
   * handed its number to something the human is using.
   */
  command?: string;
}

/** What a port reads to say its harness is up: the controls a launch installed. */
export interface ReadyContext extends LaunchContext {
  endpoint: string | null;
}

/** How far a stop got. Only `quiet` is stopped. */
export const StopStates = ["submitted", "acknowledged", "quiet", "failed"] as const;
export type StopStateName = (typeof StopStates)[number];

const StoppedTurn = Schema.Struct({
  thread: Schema.String,
  turn: Schema.String,
  transcript: Schema.NullOr(Schema.String),
});

/** A process as a stop saw it: a pid is not an identity without its start. */
const SeenProcess = Schema.Struct({ pid: Schema.Number, started: Schema.String });
export type SeenProcess = typeof SeenProcess.Type;

/** What a stop reached, and why it got no further where it is not `quiet`. */
export interface Stopped {
  readonly state: StopStateName;
  /** Null where the stop never read them. */
  readonly turns: ReadonlyArray<typeof StoppedTurn.Type> | null;
  readonly reason: string | null;
  /** Every process sent its one SIGTERM, by this stop or an earlier one. */
  readonly signalled: ReadonlyArray<SeenProcess>;
  /** What was still running when it gave up: whatever may still write in the checkout. */
  readonly left: ReadonlyArray<SeenProcess>;
  /** The server's session as noted before a drain: the only processes a stop may signal. */
  readonly noted: ReadonlyArray<SeenProcess>;
}

/** The server a stop acts on, as its control record names it. */
export interface StopTarget {
  readonly agent: string;
  readonly cwd: string;
  readonly endpoint: string;
  readonly pid: number;
  readonly command: string;
  /** Null on a record from a build that did not keep it. */
  readonly started: string | null;
  /** What an earlier stop already signalled, which never gets a second. */
  readonly signalled: ReadonlyArray<SeenProcess>;
  /** What an earlier stop noted of its session, still proof after the server has gone. */
  readonly noted: ReadonlyArray<SeenProcess>;
}

export interface CompactionPort {
  /**
   * Refuses when the installed harness cannot be managed through the interface Collie
   * verified. Run before a tab opens: a harness Collie cannot manage stops the step
   * rather than quietly becoming an unmanaged agent, which is how a partial-harness
   * feature would ship.
   */
  gate(): Effect.Effect<void, PortError, PortServices>;
  /** Installs this agent's controls and returns the extra `agent start` arguments. */
  install(ctx: LaunchContext): Effect.Effect<Installed, PortError, PortServices>;
  /** The harness's own current-context total. `null` where no usable sample exists. */
  usage(ctx: AgentContext): Effect.Effect<number | null, PortError, PortServices>;
  /**
   * Submits a native compaction request. Acknowledgement only, never completion — and
   * `unobserved` where the channel it went through could not confirm even that much.
   * `null` from an adapter whose channel has no such notion.
   */
  request(
    ctx: AgentContext,
    requestId: string,
  ): Effect.Effect<Submission | null, PortError, PortServices>;
  /**
   * Whether the harness has shown, through these controls, that it can take a prompt.
   * Absent where its controls give no such sign before the first prompt. A failure is why
   * it cannot tell yet.
   */
  readonly ready?: (ctx: ReadyContext) => Effect.Effect<boolean, PortError, PortServices>;
  /**
   * Stops the work this agent runs outside its pane, for a harness that runs it there.
   * `note` records each step as it is taken. Never fails: what it could not do is the
   * state it reached and the reason.
   */
  readonly stop?: (
    target: StopTarget,
    note: (line: string) => Effect.Effect<void>,
    budgetMs: number,
  ) => Effect.Effect<Stopped, never, PortServices>;
  /** What this request has established, or `null` while it is still unresolved. */
  poll(
    ctx: AgentContext,
    requestId: string,
  ): Effect.Effect<CompactionOutcome | null, PortError, PortServices>;
}

export interface CompactionPorts {
  readonly [harness: string]: CompactionPort;
}

/**
 * What a caller already knows, for one that reaches the policy without a Run's
 * `Defaults` in hand. `configured` is the Run's own threshold, which is not always the
 * config file's — a Run keeps the defaults it was launched with. `ports` and `waitMs`
 * are the test seam: a scripted harness interface, and the fixed five-minute budget
 * shortened so a test does not have to wait it out for real.
 */
export interface CompactionSettings {
  configured?: number;
  ports?: CompactionPorts;
  /**
   * How long to wait for the request to resolve. The five-minute budget is fixed for a
   * Run's own boundaries; `0` is for an interactive caller with a human in front of it,
   * which asks, says the compaction is in the air, and lets them press the key again
   * rather than holding the Control Plane's one action fiber for five minutes.
   */
  waitMs?: number;
}

/**
 * The controls of one agent, which outlive the Run that launched it: a hand-off gives
 * another Run's Driver the same agent, and that process has to find the same endpoint
 * and the same in-flight attempt.
 */
const AttemptSchema = Schema.Struct({
  id: Schema.String,
  run: Schema.String,
  step: Schema.String,
  /** When the five-minute budget runs out, in epoch ms, so a resumed Run inherits it. */
  deadline: Schema.Number,
});
const ControlSchema = Schema.Struct({
  agent: Schema.String,
  harness: Schema.String,
  cwd: Schema.String,
  dir: Schema.String,
  /**
   * The local endpoint this agent's controls talk to, where the harness needs one, and
   * the process holding it open. Recorded so a later process can reach the same
   * endpoint after a hand-off, and so a launch can put down the endpoint of an agent
   * herdr no longer has — a server nothing will connect to again is a leak.
   */
  endpoint: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  pid: Schema.NullOr(Schema.Number).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /** What `pid`'s command line has to contain before anything signals it. */
  command: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /** When `pid` started, so a number that came round again is not taken for it. */
  started: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  attempt: Schema.NullOr(AttemptSchema),
  /** The agents log of the Run that launched it, where any later stop of it is told. */
  runLog: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /** The furthest a stop that did not reach Quiet got. */
  stop: Schema.NullOr(
    Schema.Struct({
      state: Schema.Literals(StopStates),
      at: Schema.Number,
      turns: Schema.NullOr(Schema.Array(StoppedTurn)),
      reason: Schema.NullOr(Schema.String),
      signalled: Schema.Array(SeenProcess).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
      left: Schema.Array(SeenProcess).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
      noted: Schema.Array(SeenProcess).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
    }),
  ).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
});
export interface ControlRecord extends Schema.Schema.Type<typeof ControlSchema> {}
const ControlJson = Schema.fromJsonString(ControlSchema);
const encodeControl = Schema.encodeSync(ControlJson);
const decodeControl = Schema.decodeUnknownEffect(ControlJson);

export const controlDir = Effect.fn("Compaction.controlDir")(function* (
  stateDir: string,
  agent: string,
) {
  const path = yield* Path.Path;
  return path.join(stateDir, CONTROL_DIR, agent);
});

/** Protect installation through agent startup, and use the same claim when pruning. */
export const withControlLock = <A, E, R>(
  stateDir: string,
  agent: string,
  effect: Effect.Effect<A, E, R>,
  /** How long to wait for the lock, for a caller that can; a moment where left out. */
  waitMs?: number,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    // Outside the directory being pruned: removing controls must not remove the lock.
    const lock = path.join(stateDir, "compaction-locks", `${agent}.lock`);
    yield* ensureLockDir(lock);
    return yield* withLock(
      lock,
      Effect.fail(new Error(`${agent}: compaction controls are in use`)),
      effect,
      waitMs === undefined ? undefined : Math.ceil(waitMs / LOCK_CLAIM_SPACING_MS),
    );
  });

/**
 * This agent's controls, or null where it has none — an agent launched before the
 * feature existed, one on a harness Collie does not manage, or one launched while
 * compaction was off. A record half-written or edited by hand reads as none: the
 * fallback is dispatching work as Collie always did, not failing a Run over a cache.
 */
export const readControl = Effect.fn("Compaction.readControl")(function* (
  stateDir: string,
  agent: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(yield* controlDir(stateDir, agent), CONTROL_FILE);
  if (!(yield* fs.exists(file))) return null;
  return yield* fs.readFileString(file).pipe(
    Effect.flatMap(decodeControl),
    Effect.catch(() => Effect.succeed(null)),
  );
});

const writeControl = Effect.fn("Compaction.writeControl")(function* (
  stateDir: string,
  record: ControlRecord,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* controlDir(stateDir, record.agent);
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(path.join(dir, CONTROL_FILE), `${encodeControl(record)}\n`);
});

export interface CompactionDeps {
  ports: CompactionPorts;
  stateDir: string;
  /** The user-wide threshold as configured, unvalidated. */
  configured: number;
  herdr: Pick<Herdr, "agentList">;
  /** The run's audit trail, for everything the transcript has to be able to explain. */
  log: (line: string) => Effect.Effect<void, PortError, PortServices>;
  /** The Run's own channel, so a warning reaches the CLI and the board, not just a log. */
  warn: (line: string) => Effect.Effect<void, PortError, PortServices>;
  /**
   * Every usable context sample, as it is read. What the Run's metrics journal is fed
   * from; a hand-off has no Run of its own and leaves it out. The policy itself keeps no
   * record of samples, so this is the only place a number the harness reported survives.
   */
  sample?: (
    at: { readonly agent: string; readonly run: string; readonly step: string },
    tokens: number,
  ) => Effect.Effect<void, PortError, PortServices>;
  waitMs: number;
  pollMs: number;
  /** How long a stop may wait for Quiet; the fixed budget where left out. */
  stopMs?: number;
}

/**
 * Whether the waiting work may be sent. `dispatch: false` is the pause: the Run stops
 * where it is, with the reason a human reads, and no prompt goes to the agent. `waiting`
 * is a compaction past its budget that `pollCompaction` goes on asking about, outside
 * the Dispatcher's transaction, while the reason is shown.
 */
export type Boundary =
  | { readonly dispatch: true }
  | { readonly dispatch: false; readonly reason: string; readonly waiting?: true };

const DISPATCH: Boundary = { dispatch: true };

/**
 * The threshold to work to, or `null` where compaction is off. All three entry points
 * ask the same question first, and all three answer a value nobody can use the same
 * way — by failing rather than coercing, because the fallback would be the shipped
 * default and that is not what someone who wrote a lower number asked for.
 */
const enabled = Effect.fn("Compaction.enabled")(function* (configured: number) {
  const limit = threshold(configured);
  if ("off" in limit) return null;
  if ("bad" in limit) return yield* Effect.fail(new Error(limit.bad));
  return limit;
});

/**
 * The controls for a newly launched agent, as extra `agent start` arguments. Nothing
 * is installed when the feature is off or the harness is unsupported. Native compaction
 * remains available; missing Collie controls do not block the work.
 */
export const installControls = Effect.fn("Compaction.installControls")(function* (
  deps: Pick<CompactionDeps, "ports" | "stateDir" | "configured" | "log" | "herdr" | "stopMs">,
  agent: { agent: string; harness: string; cwd: string; runLog: string },
  env: ReadonlyArray<string> = [],
) {
  const limit = yield* enabled(deps.configured);
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* controlDir(deps.stateDir, agent.agent);
  // This is a new process, not a reused agent. Even a native-compaction fallback
  // must discard its predecessor's controls and unresolved attempt — once that
  // predecessor is Quiet, and never while it may still write.
  const prior = yield* readControl(deps.stateDir, agent.agent);
  const reached =
    prior === null ? null : yield* stopRecord(deps, prior, deps.stopMs ?? STOP_WAIT_MS);
  if (reached !== null && reached.state !== "quiet")
    return yield* new NotQuiet({ message: notStopped(agent.agent, reached, reached.target) });
  if (reached === null) yield* putDownServer(deps, prior);
  yield* fs.remove(dir, { recursive: true, force: true });
  if (!limit) return [];
  const port = deps.ports[agent.harness];
  if (!port) {
    yield* deps.log(`${agent.agent}: ${agent.harness} has no compaction controls in Collie`);
    return [];
  }
  const supported = yield* port.gate().pipe(
    Effect.as(true),
    Effect.catch((cause) =>
      deps
        .log(`${agent.agent}: running without Collie compaction controls (${reason(cause)})`)
        .pipe(Effect.as(false)),
    ),
  );
  if (!supported) return [];
  // The engine holds withControlLock through installation and agent startup. A parallel
  // launch must not prune these controls before herdr can list their agent.
  yield* Effect.ignore(putDownStaleControls(deps, agent.agent));
  yield* fs.makeDirectory(dir, { recursive: true });
  const installed = yield* port.install({
    agent: agent.agent,
    harness: agent.harness,
    cwd: agent.cwd,
    dir,
    env,
  });
  const started =
    installed.pid === undefined ? null : ((yield* processOf(installed.pid))?.started ?? null);
  yield* writeControl(deps.stateDir, {
    ...agent,
    dir,
    endpoint: installed.endpoint ?? null,
    pid: installed.pid ?? null,
    command: installed.command ?? null,
    started,
    attempt: null,
    stop: null,
  });
  yield* deps.log(`${agent.agent}: compaction controls installed in ${dir}`);
  return installed.args;
});

/** Each turn a stop covered, by its full ids, with the server and where the transcript is. */
const stopFacts = (target: StopTarget, turns: Stopped["turns"]) => {
  const covered = (turns ?? []).map(
    (one) =>
      `thread ${one.thread} turn ${one.turn}${one.transcript === null ? "" : ` (transcript ${one.transcript})`}`,
  );
  const said =
    turns === null
      ? "its turns were never read"
      : covered.length === 0
        ? "no turn running"
        : covered.join(", ");
  return `${said}; server ${target.endpoint} pid ${target.pid}`;
};

/** What a stop that did not reach Quiet says, in the agents log and in what the stop reports. */
export const notStopped = (agent: string, reached: Stopped, target: StopTarget) =>
  `${agent} is not stopped: ${reached.state}, ${reached.reason ?? "no reason given"} — ${stopFacts(target, reached.turns)}`;

/** What a stop reached, with the server it acted on. */
export interface StopReached extends Stopped {
  readonly target: StopTarget;
}

/**
 * A predecessor that is not Quiet, refusing whatever would take its work or its record:
 * a second writer in its checkout is the thing a stop exists to prevent.
 */
export class NotQuiet extends Data.TaggedError("NotQuiet")<{ readonly message: string }> {}

/**
 * Stops the server this record names, for a harness whose work runs there, and records
 * the state reached: the record is removed only once its agent is Quiet. Null where
 * nothing of Collie's runs outside the pane. The caller holds the agent's control lock.
 */
const stopRecord = Effect.fn("Compaction.stopRecord")(function* (
  deps: Pick<CompactionDeps, "ports" | "stateDir" | "log">,
  record: ControlRecord,
  budgetMs: number,
) {
  const stop = deps.ports[record.harness]?.stop;
  const target = targetOf(record);
  if (stop === undefined || target === null) return null;
  const services = yield* Effect.context<PortServices>();
  // Told to the Run that launched it, whichever path stops it.
  const told = record.runLog === null ? deps.log : appendTo(record.runLog);
  const note = (line: string) => Effect.ignore(Effect.provideContext(told(line), services));
  const now = yield* stop(target, note, budgetMs);
  // A server gone before this stop read anything ran the turns an earlier one covered.
  const reached = now.turns === null ? { ...now, turns: record.stop?.turns ?? null } : now;
  if (reached.state === "quiet") {
    yield* note(`${record.agent}: quiet — ${stopFacts(target, reached.turns)}`);
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(record.dir, { recursive: true, force: true });
  } else {
    yield* note(notStopped(record.agent, reached, target));
    const at = yield* Clock.currentTimeMillis;
    yield* writeControl(deps.stateDir, { ...record, stop: { ...reached, at } });
  }
  return { ...reached, target } satisfies StopReached;
});

const targetOf = (record: ControlRecord): StopTarget | null => {
  const { endpoint, pid, command } = record;
  if (endpoint === null || pid === null || command === null) return null;
  return {
    ...record,
    endpoint,
    pid,
    command,
    signalled: record.stop?.signalled ?? [],
    noted: record.stop?.noted ?? [],
  };
};

const appendTo = (file: string) => (line: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, `${line}\n`, { flag: "a" });
  });

/**
 * Whether anything this record names may still write in its directory: its server, or
 * what an earlier stop left running.
 */
export const mayWrite = Effect.fn("Compaction.mayWrite")(function* (record: ControlRecord) {
  if (record.pid === null) return false;
  const server = yield* processOf(record.pid);
  if (
    server !== null &&
    (record.started === null || server.started === record.started) &&
    (record.command === null || server.command.includes(record.command))
  )
    return true;
  for (const one of record.stop?.left ?? []) if (yield* stillRunning(one)) return true;
  return false;
});

/** Why a record that did not reach Quiet is kept, where it may still write; null otherwise. */
export const keptFor = Effect.fn("Compaction.keptFor")(function* (record: ControlRecord) {
  const target = targetOf(record);
  if (record.stop === null || target === null || !(yield* mayWrite(record))) return null;
  return `its Codex turn has not stopped: ${notStopped(record.agent, record.stop, target)}`;
});

/**
 * Stops the work an agent runs outside its pane, under its control lock. Null where
 * nothing of Collie's runs there: no record, a harness whose work is in its pane, or no
 * server recorded. A failure is the lock being held.
 */
export const stopAgent = Effect.fn("Compaction.stopAgent")(function* (
  deps: Pick<CompactionDeps, "ports" | "stateDir" | "log">,
  agent: string,
  budgetMs: number = STOP_WAIT_MS,
) {
  const first = yield* readControl(deps.stateDir, agent);
  // A harness whose work is in its pane has nothing to stop here, and does not wait on the lock.
  if (first === null || deps.ports[first.harness]?.stop === undefined) return null;
  return yield* withControlLock(
    deps.stateDir,
    agent,
    Effect.gen(function* () {
      const record = yield* readControl(deps.stateDir, agent);
      return record === null ? null : yield* stopRecord(deps, record, budgetMs);
    }),
    // Another stop of the same agent may hold it for its whole budget.
    budgetMs + STOP_WAIT_MS,
  );
});

/**
 * The records of agents no session lists whose server still runs: an agent is working in
 * each one's directory until its server is Quiet, whatever its pane did. Null where a
 * session would not list its agents.
 */
export const unlistedServers = Effect.fn("Compaction.unlistedServers")(function* (
  stateDir: string,
  sessions: ReadonlyArray<Pick<Herdr, "agentList">>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const listed = new Set<string>();
  for (const session of sessions) {
    const agents = yield* Effect.result(session.agentList());
    if (agents._tag === "Failure") return null;
    for (const agent of agents.success) listed.add(agent.name);
  }
  const found: ControlRecord[] = [];
  const root = path.join(stateDir, CONTROL_DIR);
  for (const name of yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []))) {
    if (listed.has(name)) continue;
    const record = yield* readControl(stateDir, name).pipe(Effect.orElseSucceed(() => null));
    if (record !== null && (yield* mayWrite(record))) found.push(record);
  }
  return found;
});

/**
 * Waits for a new agent's harness to show, through its own controls, that it can take a
 * prompt: herdr answers `agent start` before a harness has drawn the prompt a typed
 * pointer lands in, and text typed earlier sits unsent or is lost. Null once it has, or
 * where nothing can show it; otherwise why it did not.
 */
export const awaitReady = Effect.fn("Compaction.awaitReady")(function* (
  deps: Pick<CompactionDeps, "ports" | "stateDir" | "log" | "pollMs">,
  agent: string,
  budgetMs: number,
) {
  const record = yield* readControl(deps.stateDir, agent);
  const ready = record === null ? undefined : deps.ports[record.harness]?.ready;
  if (record === null || ready === undefined) {
    yield* deps.log(`${agent}: nothing of Collie's can say its harness is up; herdr's word stands`);
    return null;
  }
  const deadline = (yield* Clock.currentTimeMillis) + budgetMs;
  let why = "";
  for (;;) {
    const up = yield* ready(record).pipe(
      Effect.tap(() => Effect.sync(() => (why = ""))),
      Effect.catch((cause) => {
        why = reason(cause);
        return Effect.succeed(false);
      }),
    );
    if (up) return null;
    if ((yield* Clock.currentTimeMillis) >= deadline)
      return `${record.harness} gave no sign it was up within ${Math.round(budgetMs / 1000)}s${why === "" ? "" : ` (${why})`}`;
    yield* Effect.sleep(deps.pollMs);
  }
});

/**
 * Removes the controls of every agent herdr no longer has, and stops the endpoint each
 * was holding open. Best-effort by design: a tidy-up that failed must never stop a
 * launch, and an agent this Session cannot see is not necessarily gone — so only the
 * ones herdr does not list at all are put down.
 */
const putDownStaleControls = Effect.fn("Compaction.putDownStaleControls")(function* (
  deps: Pick<CompactionDeps, "ports" | "stateDir" | "herdr" | "log" | "stopMs">,
  /** The agent being launched, which herdr does not have yet. */
  launching: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(deps.stateDir, CONTROL_DIR);
  if (!(yield* fs.exists(root))) return;
  const live = new Set((yield* deps.herdr.agentList()).map((agent) => agent.name));
  for (const name of yield* fs.readDirectory(root)) {
    if (name === launching || live.has(name)) continue;
    const listed = deps.herdr.agentList().pipe(
      Effect.map((agents) => agents.some((agent) => agent.name === name)),
      Effect.orElseSucceed(() => true),
    );
    yield* putDownControl(deps, name, listed).pipe(Effect.ignore);
  }
});

/**
 * Stops the server of one agent herdr does not list and removes its controls, under its
 * control lock: null once they are gone, otherwise why they stay — herdr lists it after
 * all, or its server is not Quiet. A failure is the lock being held.
 */
export const putDownControl = Effect.fn("Compaction.putDownControl")(function* <R>(
  deps: Pick<CompactionDeps, "ports" | "stateDir" | "log" | "stopMs">,
  name: string,
  /** Whether herdr lists this agent now; true where it cannot tell. */
  listed: Effect.Effect<boolean, never, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* withControlLock(
    deps.stateDir,
    name,
    Effect.gen(function* () {
      // A launch may have finished while we waited for its lock. The earlier list
      // cannot prove this agent is still absent.
      if (yield* listed) return "herdr lists its agent again";
      const record = yield* readControl(deps.stateDir, name);
      // A server an earlier stop already signalled is only looked at again, so no launch
      // waits out its budget.
      const signalled = record?.stop?.signalled.some((one) => one.pid === record.pid) ?? false;
      const budget = signalled ? 0 : (deps.stopMs ?? STOP_WAIT_MS);
      const reached = record === null ? null : yield* stopRecord(deps, record, budget);
      if (reached !== null && reached.state !== "quiet")
        return `its Codex turn has not stopped: ${notStopped(name, reached, reached.target)}`;
      if (reached === null) yield* putDownServer(deps, record);
      yield* fs.remove(path.join(deps.stateDir, CONTROL_DIR, name), {
        recursive: true,
        force: true,
      });
      return null;
    }),
  );
});

/** Signals the endpoint of a record no stop applies to, where it still runs the recorded command. */
const putDownServer = Effect.fn("Compaction.putDownServer")(function* (
  deps: Pick<CompactionDeps, "log">,
  record: ControlRecord | null,
) {
  const pid = yield* endpointPid(record);
  if (record === null || pid === null) return;
  yield* terminate(pid);
  yield* deps.log(`${record.agent}: stopped its compaction endpoint (pid ${pid})`);
});

/**
 * The pid to signal, where this record still describes a server of Collie's — and null
 * everywhere else. A control record outlives the process it names: a machine reboots, a
 * server is killed, and the pid comes round again, so a launch that signalled a
 * recorded number on trust would eventually SIGTERM something the human was using. The
 * process's own command line is the check, read from `/proc` or else `ps`, and one that
 * cannot be read is treated as already gone.
 *
 * A record from before this was written carries no command, and so is never signalled:
 * its directory is removed and its endpoint, if it is still up, is left alone.
 */
export const endpointPid = Effect.fn("Compaction.endpointPid")(function* (
  record: Pick<ControlRecord, "pid" | "command"> | null,
  proc = "/proc",
) {
  const { pid, command } = record ?? {};
  if (!pid || !command) return null;
  return (yield* commandOf(pid, proc)).includes(command) ? pid : null;
});

/**
 * The work boundary: immediately before a reused agent that has finished its previous
 * work is given the next piece. Never a liveness nudge, a mid-step recovery message or
 * a human typing in the pane — those are not boundaries, and this is not called on them.
 */
export const atBoundary = Effect.fn("Compaction.atBoundary")(function* (
  deps: CompactionDeps,
  at: { agent: string; run: string; step: string },
  /**
   * Opens the Dispatcher's transaction for the request alone, failing `Unsubmitted` where
   * it could not: the ports never take a lock of their own, and nothing else here holds one.
   */
  submitting: <A, E, R>(
    body: (channel: Channel) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | Unsubmitted | Error, R | PortServices>,
) {
  const limit = yield* enabled(deps.configured);
  if (!limit) return DISPATCH;

  const record = yield* readControl(deps.stateDir, at.agent);
  const port = record ? deps.ports[record.harness] : undefined;
  // Nothing installed and nothing to ask: an agent from before the feature, or on a
  // harness Collie does not manage, is given its work exactly as it always was.
  if (!record || !port) return DISPATCH;
  const ctx: AgentContext = {
    agent: record.agent,
    run: at.run,
    harness: record.harness,
    cwd: record.cwd,
    dir: record.dir,
    endpoint: record.endpoint,
    channel: sendsNothing(record.agent),
  };

  // An attempt an earlier boundary left unresolved outranks a fresh reading. It is the
  // rule a recovery cannot break: no new work reaches an agent whose last compaction
  // is still in the air, whichever process asked for it.
  if (record.attempt) {
    yield* deps.log(
      `${at.agent}: compaction ${record.attempt.id} from ${record.attempt.step} is still unresolved`,
    );
    return yield* settle(deps, ctx, record, record.attempt, at.step);
  }

  const sample = yield* port
    .usage(ctx)
    .pipe(
      Effect.catch((cause) =>
        deps
          .warn(
            `  ⚠ ${at.agent}: could not read its context usage (${reason(cause)}) — sending the work without compacting`,
          )
          .pipe(Effect.as(null)),
      ),
    );
  // Unavailable is not zero and not the last high reading: the harness has not
  // measured this context yet, so there is nothing to compare and nothing to compact
  // from. Rechecked at the next eligible boundary.
  if (sample === null) {
    yield* deps.log(`${at.agent}: no usable context sample; sending the work`);
    return DISPATCH;
  }
  if (deps.sample) yield* deps.sample(at, sample);
  if (sample < limit.tokens) {
    yield* deps.log(`${at.agent}: ${sample} tokens in context, under ${limit.tokens}`);
    return DISPATCH;
  }

  const now = yield* Clock.currentTimeMillis;
  const attempt = {
    id: `${at.agent}-${now}`,
    run: at.run,
    step: at.step,
    deadline: now + deps.waitMs,
  };
  // Written before the request is sent, not after: a process that dies between the two
  // must leave the attempt visible, or the next boundary would read a stale high sample
  // and ask for a second compaction on top of one that may still be running.
  yield* writeControl(deps.stateDir, { ...record, attempt });
  yield* deps.warn(
    `  ⇣ ${at.agent}: ${sample} tokens in context — asking it to compact before ${at.step}`,
  );
  const submitted = yield* submitting((channel) =>
    port.request({ ...ctx, channel }, attempt.id),
  ).pipe(Effect.result);
  const failure = Result.isFailure(submitted) ? submitted.failure : null;
  // Written but unconfirmed: what tells a request that never arrived from one ignored.
  if (Result.isSuccess(submitted) && submitted.success === "unobserved") {
    yield* deps.log(`${at.agent}: compaction request written, no turn observed`);
  }
  if (failure instanceof Unsubmitted) {
    // It never left, so nothing is in flight to wait for. A channel that refused a
    // submission is a temporary failure, which warns and continues; it is not the
    // unconfirmed outcome that pauses a Run.
    yield* writeControl(deps.stateDir, { ...record, attempt: null });
    yield* deps.warn(
      `  ⚠ ${at.agent}: could not ask it to compact (${failure.message}) — sending the work anyway`,
    );
    return DISPATCH;
  }
  if (failure !== null) {
    // Submitting broke, which says nothing about whether the harness took the request
    // first: a socket closes and an HTTP call times out after the frame has gone. So
    // the attempt stands and its budget runs, because the agent may be compacting
    // right now and work sent into that is the thing this feature exists to prevent.
    yield* deps.log(
      `${at.agent}: asking it to compact failed (${reason(failure)}), but the request may already have reached it — waiting on ${attempt.id}`,
    );
  }
  return yield* settle(deps, ctx, record, attempt, at.step);
});

/**
 * The channel a reading or a poll is given: it runs in no transaction, so a steer is never
 * refused behind it, and it may send nothing.
 */
const sendsNothing = (agent: string): Channel => ({
  agent,
  submit: () =>
    Effect.succeed({
      ok: false,
      id: null,
      reason: "blocked",
      detail: "a compaction's reading or poll sends nothing",
    }),
});

/**
 * One more look at an attempt past its budget. `null` while it is still unresolved; an attempt no longer recorded, as a
 * deleted control directory leaves it, is over.
 */
export const pollCompaction = Effect.fn("Compaction.pollCompaction")(function* (
  deps: CompactionDeps,
  agent: string,
) {
  const record = yield* readControl(deps.stateDir, agent);
  const port = record ? deps.ports[record.harness] : undefined;
  if (!record?.attempt || !port) return DISPATCH;
  const ctx: AgentContext = {
    agent: record.agent,
    run: record.attempt.run,
    harness: record.harness,
    cwd: record.cwd,
    dir: record.dir,
    endpoint: record.endpoint,
    channel: sendsNothing(record.agent),
  };
  return yield* resolved(deps, ctx, record, record.attempt);
});

/** What the harness has established about one request: the boundary it ends, or `null`. */
const resolved = Effect.fn("Compaction.resolved")(function* (
  deps: CompactionDeps,
  ctx: AgentContext,
  record: ControlRecord,
  attempt: Schema.Schema.Type<typeof AttemptSchema>,
) {
  const port = deps.ports[ctx.harness]!;
  const outcome = yield* port.poll(ctx, attempt.id).pipe(
    Effect.catch((cause) =>
      // Logged, not warned, and above all not resolved: a read that failed says
      // nothing about the compaction, and the budget is still running.
      deps
        .log(`${ctx.agent}: reading compaction ${attempt.id} failed (${reason(cause)})`)
        .pipe(Effect.as(null)),
    ),
  );
  if (outcome === null) return null;
  yield* writeControl(deps.stateDir, { ...record, attempt: null });
  if (outcome.kind === "success") {
    yield* deps.log(`${ctx.agent}: native compaction ${attempt.id} completed`);
  } else {
    yield* deps.warn(
      `  ⚠ ${ctx.agent}: native compaction failed (${outcome.reason}) — sending the work anyway`,
    );
  }
  return DISPATCH;
});

/**
 * Waits out one request against its own budget. Only the harness's own correlated
 * evidence ends it: an acknowledgement, an old idle state, an unrelated compaction or
 * a transport error establishes nothing, so the loop keeps asking until the harness
 * says which it was or the budget runs out.
 */
const settle = Effect.fn("Compaction.settle")(function* (
  deps: CompactionDeps,
  ctx: AgentContext,
  record: ControlRecord,
  attempt: Schema.Schema.Type<typeof AttemptSchema>,
  step: string,
) {
  for (;;) {
    const done = yield* resolved(deps, ctx, record, attempt);
    if (done !== null) return done;
    const now = yield* Clock.currentTimeMillis;
    if (now >= attempt.deadline) {
      // The attempt is kept, not cleared: it is unresolved, not over. A timeout is not
      // proof that the agent stopped compacting, so nothing here retries, kills the
      // agent or replays the work.
      if (deps.waitMs === 0)
        return {
          dispatch: false,
          reason: `${ctx.agent}: compaction ${attempt.id} is still in the air — no work sent; try again once it has finished`,
        } satisfies Boundary;
      return {
        dispatch: false,
        waiting: true,
        reason: `${ctx.agent}: compaction ${attempt.id} has not finished after ${Math.round(deps.waitMs / 60_000)} minutes; Collie keeps waiting and sends ${step} once it does. Check its pane.`,
      } satisfies Boundary;
    }
    yield* Effect.sleep(Math.min(deps.pollMs, attempt.deadline - now));
  }
});
