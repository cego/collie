import type { Source } from "./usage-ledger-model";
import * as Option from "effect/Option";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import type { PlatformError } from "effect";
import {
  Clock,
  Cause,
  Data,
  Duration,
  Effect,
  FileSystem,
  Path,
  Result,
  Schedule,
  Schema,
  flow,
} from "effect";
import type { PlatformServices } from "./platform";
import type { Channel } from "./dispatcher";
import type { Herdr, HerdrError, Submission } from "./herdr";
import type { CodexError } from "./codex";
import type { OpenCodeError } from "./opencode";
import type { Records } from "./records";
import type {
  AgentQuestion,
  HarnessVersionError,
  Submitting,
  TelemetryUnwritten,
} from "./compactors";
import { TURNS, recordCancelled } from "./compactors";
import { LOCK_CLAIM_SPACING_MS, ensureLockDir, withLock } from "./lock";
import { reason } from "./naming";
import type { ParkCause } from "./park-cause";
import { COMPACTION_OFF } from "./settings";
import {
  commandOf,
  processAbsent,
  processOf,
  startedOf,
  stillRunning,
  terminate,
} from "./processes";

// WARNING: fixed; a shorter wait sends the next work into a context nobody has established.
export const COMPACTION_WAIT_MS = 5 * 60 * 1000;

export const RECONCILE_AFTER_MS = 2 * COMPACTION_WAIT_MS;

export const STOP_WAIT_MS = 30_000;

export const CONTROL_DIR = "compaction";
const CONTROL_FILE = "control.json";

// WARNING: a bad value is kept as a message, not coerced; the default would silently compact an agent someone meant to leave alone.
export type Threshold =
  | { readonly tokens: number }
  | { readonly off: true }
  | { readonly bad: string };

export function threshold(configured: number) {
  if (configured === COMPACTION_OFF) {
    return { off: true };
  }
  if (!Number.isSafeInteger(configured) || configured < 0) {
    return {
      bad:
        `compact_at_tokens has to be a whole number of tokens above zero, ` +
        `or ${COMPACTION_OFF} to turn compaction off — not ${configured}`,
    };
  }
  return { tokens: configured };
}

// WARNING: only a request that provably never left is Unsubmitted; a socket that closed may already have been accepted.
export class Unsubmitted extends Data.TaggedError("Unsubmitted")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

// WARNING: no third member: an absent completion is not a failure, so the request stays unresolved until the harness says.
export type CompactionOutcome =
  | { readonly kind: "success" }
  | { readonly kind: "failure"; readonly reason: string };

export interface LaunchContext {
  agent: string;
  harness: string;
  cwd: string;
  dir: string;
  env?: ReadonlyArray<string>;
  mcp?: ReadonlyArray<string>;
  session?: string;
}

// WARNING: the request, its incarnation and its own transcript are what settles it; time alone proves nothing.
export interface Marked {
  readonly id: string;
  readonly session: string | null;
  // WARNING: a session id is reused by a relaunch, so the launch is what tells two incarnations apart.
  readonly launch: string | null;
  readonly transcript: string | null;
}

export interface AgentContext extends LaunchContext {
  run: string;
  // WARNING: a request's sends run in the Dispatcher's transaction; a reading or poll sends nothing.
  channel: Channel;
  endpoint: string | null;
}

type PortServices = FileSystem.FileSystem | Path.Path | PlatformServices;
type PortError =
  | PlatformError.PlatformError
  | Cause.TimeoutError
  | Cause.NoSuchElementError
  | Cause.UnknownError
  | Schema.SchemaError
  | CodexError
  | OpenCodeError
  | HerdrError
  | HarnessVersionError
  | TelemetryUnwritten
  | Submitting
  | Unsubmitted;

export interface Installed {
  args: ReadonlyArray<string>;
  endpoint?: string;
  pid?: number;
  // WARNING: a pid alone is not an identity; the command line shows it is still the endpoint's process.
  command?: string;
}

export interface ReadyContext extends LaunchContext {
  endpoint: string | null;
  // WARNING: a relaunch's events outlive the last incarnation, so what is ready is the launch that asked.
  readonly launch?: string | null;
}

export const StopStates = ["submitted", "acknowledged", "quiet", "failed"] as const;
export type StopStateName = (typeof StopStates)[number];

const StoppedTurn = Schema.Struct({
  thread: Schema.String,
  turn: Schema.String,
  transcript: Schema.NullOr(Schema.String),
});

const SeenProcess = Schema.Struct({ pid: Schema.Finite, started: Schema.String });
export type SeenProcess = typeof SeenProcess.Type;

export interface Stopped {
  readonly state: StopStateName;
  readonly turns: ReadonlyArray<typeof StoppedTurn.Type> | null;
  readonly reason: string | null;
  readonly signalled: ReadonlyArray<SeenProcess>;
  readonly left: ReadonlyArray<SeenProcess>;
  readonly noted: ReadonlyArray<SeenProcess>;
}

export interface StopTarget {
  readonly agent: string;
  readonly cwd: string;
  readonly endpoint: string;
  readonly pid: number;
  readonly command: string;
  readonly started: string | null;
  readonly signalled: ReadonlyArray<SeenProcess>;
  readonly noted: ReadonlyArray<SeenProcess>;
}

export interface CompactionPort {
  // WARNING: refuses an unmanaged harness; a silently unmanaged agent is the partial-harness failure.
  readonly gate: Effect.Effect<void, PortError, PortServices>;
  install(ctx: LaunchContext): Effect.Effect<Installed, PortError, PortServices>;
  usage(ctx: AgentContext): Effect.Effect<number | null, PortError, PortServices>;
  readonly records?: (
    ctx: AgentContext,
  ) => Effect.Effect<ReadonlyArray<Source>, PortError, PortServices>;
  // WARNING: acknowledgement only, never completion; `unobserved` where the channel could not confirm even that, null where it has no such notion.
  request(
    ctx: AgentContext,
    requestId: string,
  ): Effect.Effect<Submission | null, PortError, PortServices | Records>;
  readonly ready?: (ctx: ReadyContext) => Effect.Effect<boolean, PortError, PortServices>;
  // WARNING: the harness's own words for why its last turn ended, since only they say a conversation was refused.
  readonly exitOf?: (ctx: ReadyContext) => Effect.Effect<string | null, PortError, PortServices>;
  readonly stop?: (
    target: StopTarget,
    note: (line: string) => Effect.Effect<void>,
    budgetMs: number,
  ) => Effect.Effect<Stopped, never, PortServices>;
  readonly questions?: (
    ctx: ReadyContext,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly id: string; readonly questions: ReadonlyArray<AgentQuestion> }>,
    PortError,
    PortServices
  >;
  poll(
    ctx: AgentContext,
    mark: Marked,
  ): Effect.Effect<CompactionOutcome | null, PortError, PortServices | Records>;
  // WARNING: null is "not proven either way", which keeps the request unresolved rather than failing it.
  readonly reconcile?: (
    ctx: AgentContext,
    mark: Marked,
    since: number,
  ) => Effect.Effect<CompactionOutcome | null, PortError, PortServices>;
  readonly mark?: (ctx: AgentContext) => Effect.Effect<
    {
      readonly session: string | null;
      readonly launch: string | null;
      readonly transcript: string | null;
    },
    PortError,
    PortServices
  >;
  readonly cancel?: (
    ctx: AgentContext,
    mark: Marked,
    why: string,
  ) => Effect.Effect<void, PortError, PortServices>;
}

export interface CompactionPorts {
  readonly [harness: string]: CompactionPort;
}

// WARNING: configured is the Run's own threshold, which is not always the config file's.
export interface CompactionSettings {
  configured?: number;
  ports?: CompactionPorts;
  // WARNING: 0 is for an interactive caller, so the Control Plane's one action fiber is not held for five minutes.
  waitMs?: number;
}

const AttemptSchema = Schema.Struct({
  id: Schema.String,
  run: Schema.String,
  step: Schema.String,
  deadline: Schema.Finite,
  asked: Schema.optionalKey(Schema.Finite),
  session: Schema.optionalKey(Schema.NullOr(Schema.String)),
  launch: Schema.optionalKey(Schema.NullOr(Schema.String)),
  transcript: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const ControlSchema = Schema.Struct({
  agent: Schema.String,
  harness: Schema.String,
  cwd: Schema.String,
  dir: Schema.String,
  endpoint: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  pid: Schema.NullOr(Schema.Finite).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  command: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  started: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  attempt: Schema.NullOr(AttemptSchema),
  runLog: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  stop: Schema.NullOr(
    Schema.Struct({
      state: Schema.Literals(StopStates),
      at: Schema.Finite,
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
const encodeControl = flow(Schema.encodeResult(ControlJson), Result.getOrThrow);
const decodeControl = Schema.decodeUnknownEffect(ControlJson);

export const controlDir = Effect.fn("Compaction.controlDir")(function* (
  stateDir: string,
  agent: string,
) {
  const path = yield* Path.Path;
  return path.join(stateDir, CONTROL_DIR, agent);
});

export class ControlsInUse extends Data.TaggedError("ControlsInUse")<{
  readonly message: string;
}> {}

export const withControlLock = <A, E, R>(
  stateDir: string,
  agent: string,
  effect: Effect.Effect<A, E, R>,
  waitMs?: number,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    // WARNING: outside the directory being pruned, so removing controls never removes the lock.
    const lock = path.join(stateDir, "compaction-locks", `${agent}.lock`);
    yield* ensureLockDir(lock);
    return yield* withLock(
      lock,
      Effect.fail(new ControlsInUse({ message: `${agent}: compaction controls are in use` })),
      effect,
      waitMs === undefined ? undefined : Math.ceil(waitMs / LOCK_CLAIM_SPACING_MS),
    );
  });

// WARNING: a half-written or hand-edited record reads as none; the fallback is dispatching work as before.
export const readControl = Effect.fn("Compaction.readControl")(function* (
  stateDir: string,
  agent: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(yield* controlDir(stateDir, agent), CONTROL_FILE);
  if (!(yield* fs.exists(file))) {
    return null;
  }
  return yield* fs.readFileString(file).pipe(
    Effect.flatMap(decodeControl),
    Effect.orElseSucceed(() => null),
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
  configured: number;
  herdr: Pick<Herdr, "agentList">;
  log: (line: string) => Effect.Effect<void, PortError, PortServices>;
  warn: (line: string) => Effect.Effect<void, PortError, PortServices>;
  sample?: (
    at: { readonly agent: string; readonly run: string; readonly step: string },
    tokens: number,
  ) => Effect.Effect<void, PortError, PortServices | Records>;
  account?: (agent: string) => Effect.Effect<void, never, PortServices | Records>;
  waitMs: number;
  pollMs: number;
  room?: (cwd: string) => Effect.Effect<"free" | "waited" | "stopped">;
  stopMs?: number;
}

export type Boundary =
  | { readonly dispatch: true }
  | {
      readonly dispatch: false;
      readonly reason: string;
      readonly waiting?: true;
      readonly cause?: ParkCause;
    };

const DISPATCH: Boundary = { dispatch: true };

const enabled = Effect.fn("Compaction.enabled")(function* (configured: number) {
  const limit = threshold(configured);
  if ("off" in limit) {
    return null;
  }
  if ("bad" in limit) {
    return yield* new Cause.IllegalArgumentError(limit.bad);
  }
  return limit;
});

export const installControls = Effect.fn("Compaction.installControls")(function* (
  deps: Pick<CompactionDeps, "ports" | "stateDir" | "configured" | "log" | "herdr" | "stopMs">,
  agent: { agent: string; harness: string; cwd: string; runLog: string },
  env: ReadonlyArray<string> = [],
  mcp: ReadonlyArray<string> = [],
  resumed?: { readonly session: string; readonly keep: ReadonlyArray<string> },
) {
  const limit = yield* enabled(deps.configured);
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* controlDir(deps.stateDir, agent.agent);
  // WARNING: a new process, not a reused agent: even a native fallback discards its predecessor's controls, once it is Quiet and never while it may still write.
  const prior = yield* readControl(deps.stateDir, agent.agent);
  const reached =
    prior === null ? null : yield* stopRecord(deps, prior, deps.stopMs ?? STOP_WAIT_MS);
  if (reached !== null && reached.state !== "quiet") {
    return yield* new NotQuiet({
      message: notStopped(agent.agent, reached, reached.target),
      left: reached.left,
    });
  }
  if (reached === null) {
    yield* putDownServer(deps, prior);
  }
  const kept = yield* Effect.forEach(resumed?.keep ?? [], (name) =>
    fs.readFileString(`${dir}/${name}`).pipe(
      Effect.map((text) => ({ name, text })),
      Effect.option,
    ),
  );
  yield* fs.remove(dir, { recursive: true, force: true });
  for (const { name, text } of Arr.getSomes(kept)) {
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(`${dir}/${name}`, text);
  }
  // WARNING: resuming the conversation is what says it has one, so the turn record outlives the evidence it was read from.
  if (resumed !== undefined) {
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(`${dir}/${TURNS}`, `${resumed.session}\n`, { flag: "a" });
  }
  const port = deps.ports[agent.harness];
  if (!limit && port?.questions === undefined) {
    return [];
  }
  if (!port) {
    yield* deps.log(`${agent.agent}: ${agent.harness} has no compaction controls in Collie`);
    return [];
  }
  const supported = yield* port.gate.pipe(
    Effect.as(true),
    Effect.catch((cause) =>
      deps
        .log(`${agent.agent}: running without Collie compaction controls (${reason(cause)})`)
        .pipe(Effect.as(false)),
    ),
  );
  if (!supported) {
    return [];
  }
  // WARNING: the engine holds the control lock through install and start; a parallel launch must not prune before herdr lists the agent.
  yield* Effect.ignore(putDownStaleControls(deps, agent.agent));
  yield* fs.makeDirectory(dir, { recursive: true });
  const ctx: LaunchContext = {
    agent: agent.agent,
    harness: agent.harness,
    cwd: agent.cwd,
    dir,
    env,
    mcp,
  };
  if (resumed !== undefined) {
    ctx.session = resumed.session;
  }
  const installed = yield* port.install(ctx);
  const started = installed.pid === undefined ? null : yield* startedOf(installed.pid);
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

const stopFacts = (target: StopTarget, turns: Stopped["turns"]) => {
  const covered = Arr.map(
    turns ?? [],
    (one) =>
      `thread ${one.thread} turn ${one.turn}${one.transcript === null ? "" : ` (transcript ${one.transcript})`}`,
  );
  const said =
    turns === null
      ? "its turns were never read"
      : covered.length === 0
        ? "no turn running"
        : Arr.join(covered, ", ");
  return `${said}; server ${target.endpoint} pid ${target.pid}`;
};

export const notStopped = (agent: string, reached: Stopped, target: StopTarget) =>
  `${agent} is not stopped: ${reached.state}, ${reached.reason ?? "no reason given"} — ${stopFacts(target, reached.turns)}`;

export interface StopReached extends Stopped {
  readonly target: StopTarget;
}

export class NotQuiet extends Data.TaggedError("NotQuiet")<{
  readonly message: string;
  readonly left: ReadonlyArray<SeenProcess>;
}> {}

// WARNING: the record goes only once its agent is Quiet.
const stopRecord = Effect.fn("Compaction.stopRecord")(function* (
  deps: Pick<CompactionDeps, "ports" | "stateDir" | "log">,
  record: ControlRecord,
  budgetMs: number,
) {
  const stop = deps.ports[record.harness]?.stop;
  const target = targetOf(record);
  if (stop === undefined || target === null) {
    return null;
  }
  const services = yield* Effect.context<PortServices>();
  const told = record.runLog === null ? deps.log : appendTo(record.runLog);
  const note = (line: string) => Effect.ignore(Effect.provideContext(told(line), services));
  const now = yield* stop(target, note, budgetMs);
  // WARNING: a server gone before this stop read anything ran the turns an earlier stop covered.
  const reached = now.turns === null ? { ...now, turns: record.stop?.turns ?? null } : now;
  if (reached.state === "quiet") {
    yield* note(`${record.agent}: quiet — ${stopFacts(target, reached.turns)}`);
    // WARNING: the disposition is written before the controls go, or a stopped agent's attempt is left as if it may finish.
    const give = deps.ports[record.harness]?.cancel;
    if (record.attempt !== null && give !== undefined) {
      yield* give(
        readingContext(record, record.attempt.run),
        {
          id: record.attempt.id,
          session: record.attempt.session ?? null,
          launch: record.attempt.launch ?? null,
          transcript: record.attempt.transcript ?? null,
        },
        `${record.agent} was stopped`,
      ).pipe(Effect.orElseSucceed(() => void 0));
    }
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(record.dir, { recursive: true, force: true });
  } else {
    yield* note(notStopped(record.agent, reached, target));
    const at = yield* Clock.currentTimeMillis;
    yield* writeControl(deps.stateDir, { ...record, stop: { ...reached, at } });
  }
  return { ...reached, target } satisfies StopReached;
});

const targetOf = (record: ControlRecord) => {
  const { endpoint, pid, command } = record;
  if (endpoint === null || pid === null || command === null) {
    return null;
  }
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

export const mayWrite = Effect.fn("Compaction.mayWrite")(function* (record: ControlRecord) {
  if (record.pid === null) {
    return false;
  }
  const server = yield* processOf(record.pid);
  if (
    server !== null &&
    (record.started === null || server.started === record.started) &&
    (record.command === null || pipe_(server.command, Str.includes(record.command)))
  ) {
    return true;
  }
  for (const one of record.stop?.left ?? []) {
    if (yield* stillRunning(one)) {
      return true;
    }
  }
  return false;
});

export const keptFor = Effect.fn("Compaction.keptFor")(function* (record: ControlRecord) {
  const target = targetOf(record);
  if (record.stop === null || target === null || !(yield* mayWrite(record))) {
    return null;
  }
  return `its Codex turn has not stopped: ${notStopped(record.agent, record.stop, target)}`;
});

export const stopAgent = Effect.fn("Compaction.stopAgent")(function* (
  deps: Pick<CompactionDeps, "ports" | "stateDir" | "log">,
  agent: string,
  budgetMs: number = STOP_WAIT_MS,
) {
  const first = yield* readControl(deps.stateDir, agent);
  if (first === null || deps.ports[first.harness]?.stop === undefined) {
    return null;
  }
  return yield* withControlLock(
    deps.stateDir,
    agent,
    Effect.gen(function* () {
      const record = yield* readControl(deps.stateDir, agent);
      return record === null ? null : yield* stopRecord(deps, record, budgetMs);
    }),
    budgetMs + STOP_WAIT_MS,
  );
});

export const serversOfRun = Effect.fn("Compaction.serversOfRun")(function* (
  stateDir: string,
  runLog: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const servers: Array<string> = [];
  const unread: Array<string> = [];
  const root = path.join(stateDir, CONTROL_DIR);
  const names = yield* fs.readDirectory(root).pipe(
    Effect.map((found) => found),
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "NotFound" ? Effect.succeed([]) : Effect.fail(error),
    ),
  );
  for (const name of names) {
    const text = yield* fs.readFileString(path.join(root, name, CONTROL_FILE)).pipe(Effect.result);
    if (text._tag === "Failure") {
      // WARNING: a start writes its record last, under its lock.
      if (text.failure.reason._tag !== "NotFound") {
        unread.push(`${name}'s control record cannot be read (${reason(text.failure)})`);
      }
      continue;
    }
    const record = yield* decodeControl(text.success).pipe(Effect.option);
    if (record._tag === "None") {
      if (pipe_(text.success, Str.includes(runLog))) {
        unread.push(`${name}'s control record does not parse`);
      }
    } else if (record.value.runLog === runLog && targetOf(record.value) !== null) {
      servers.push(name);
    }
  }
  return { servers, unread };
});

// WARNING: stops without waiting for the control lock, which a start in flight holds.
export const stopUnlaunched = Effect.fn("Compaction.stopUnlaunched")(function* (
  deps: Pick<CompactionDeps, "ports" | "stateDir" | "log">,
  agent: string,
  budgetMs: number = STOP_WAIT_MS,
) {
  return yield* withControlLock(
    deps.stateDir,
    agent,
    Effect.gen(function* () {
      const record = yield* readControl(deps.stateDir, agent);
      return record === null ? null : yield* stopRecord(deps, record, budgetMs);
    }),
  );
});

// WARNING: an agent works in each record's directory until its server is Quiet, whatever its pane did.
export const unlistedServers = Effect.fn("Compaction.unlistedServers")(function* (
  stateDir: string,
  sessions: ReadonlyArray<Pick<Herdr, "agentList">>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const listed = new Set<string>();
  for (const session of sessions) {
    const agents = yield* Effect.result(session.agentList());
    if (agents._tag === "Failure") {
      return null;
    }
    for (const agent of agents.success) {
      listed.add(agent.name);
    }
  }
  const found: Array<ControlRecord> = [];
  const root = path.join(stateDir, CONTROL_DIR);
  for (const name of yield* fs.readDirectory(root).pipe(Effect.orElseSucceed(() => []))) {
    if (listed.has(name)) {
      continue;
    }
    const record = yield* readControl(stateDir, name).pipe(Effect.orElseSucceed(() => null));
    if (record !== null && (yield* mayWrite(record))) {
      found.push(record);
    }
  }
  return found;
});

export const lostServer = Effect.fn("Compaction.lostServer")(function* (
  deps: Pick<CompactionDeps, "ports" | "stateDir">,
  agent: string,
) {
  const record = yield* readControl(deps.stateDir, agent).pipe(Effect.orElseSucceed(() => null));
  if (
    record === null ||
    record.agent !== agent ||
    record.pid === null ||
    Str.trim(record.started ?? "") === "" ||
    Str.trim(record.command ?? "") === "" ||
    !record.endpoint
  ) {
    return null;
  }
  const port = deps.ports[record.harness];
  if (port?.ready === undefined || port.stop === undefined) {
    return null;
  }
  if (!(yield* processAbsent(record.pid))) {
    return null;
  }
  const ready = yield* port.ready(record).pipe(
    Effect.orElseSucceed(() => false),
    Effect.timeoutOption(2000),
  );
  if (Option.isNone(ready) || ready.value) {
    return null;
  }
  return `${record.harness} server pid ${record.pid} has exited and ${record.endpoint} is unavailable`;
});

// WARNING: herdr answers agent start before the harness draws its prompt, so text typed early is lost.
export const awaitReady = Effect.fn("Compaction.awaitReady")(function* (
  deps: Pick<CompactionDeps, "ports" | "stateDir" | "log" | "pollMs" | "herdr">,
  agent: string,
  budgetMs: number,
  options?: { readonly mustStayListed?: boolean; readonly launch?: string | null },
) {
  // WARNING: a relaunch is asked to stay listed, since a harness that exits at once is gone from core before it is ready.
  const listed = () =>
    options?.mustStayListed !== true
      ? Effect.succeed(true)
      : deps.herdr.agentList().pipe(
          Effect.map((agents) => Arr.some(agents, (one) => one.name === agent)),
          Effect.orElseSucceed(() => true),
        );
  const record = yield* readControl(deps.stateDir, agent);
  const ready = record === null ? undefined : deps.ports[record.harness]?.ready;
  if (record === null || ready === undefined) {
    yield* deps.log(`${agent}: nothing of Collie's can say its harness is up; core's word stands`);
    return (yield* listed()) ? null : "core no longer lists it";
  }
  const deadline = (yield* Clock.currentTimeMillis) + budgetMs;
  let why = "";
  const asked = yield* Effect.gen(function* () {
    if (!(yield* listed())) {
      return { _tag: "Gone" } as const;
    }
    const up = yield* ready({ ...record, launch: options?.launch ?? null }).pipe(
      Effect.tap(() => Effect.sync(() => (why = ""))),
      Effect.catch((cause) => {
        why = reason(cause);
        return Effect.succeed(false);
      }),
    );
    return up ? ({ _tag: "Up" } as const) : ({ _tag: "NotYet" } as const);
  }).pipe(
    Effect.repeat({
      until: (one) => one._tag !== "NotYet",
      schedule: Schedule.spaced(deps.pollMs).pipe(Schedule.while(({ now }) => now < deadline)),
    }),
  );
  const gone = yield* record.pid === null
    ? Effect.succeed(false)
    : processOf(record.pid).pipe(
        Effect.map(
          (one) => one === null || (record.started !== null && one.started !== record.started),
        ),
        Effect.orElseSucceed(() => false),
      );
  const saidOf = () =>
    (deps.ports[record.harness]?.exitOf?.(record) ?? Effect.succeed(null)).pipe(
      Effect.orElseSucceed(() => null),
    );
  const lost = (fallback: string) =>
    gone ? `${record.harness} exited before it was up` : fallback;
  // WARNING: core lists a terminal only while it runs, so one of ours that is absent has exited.
  if (asked._tag === "Gone") {
    return (yield* saidOf()) ?? `${record.harness} exited before it was up`;
  }
  if (asked._tag === "Up") {
    return null;
  }
  // WARNING: the harness's own words are the exit; the elapsed budget hides which failure it was.
  return why === ""
    ? lost(`${record.harness} gave no sign it was up within ${Math.round(budgetMs / 1000)}s`)
    : why;
});

// WARNING: best-effort; an agent this Session cannot see is not necessarily gone, so only the ones herdr does not list are put down.
const putDownStaleControls = Effect.fn("Compaction.putDownStaleControls")(function* (
  deps: Pick<CompactionDeps, "ports" | "stateDir" | "herdr" | "log" | "stopMs">,
  launching: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(deps.stateDir, CONTROL_DIR);
  if (!(yield* fs.exists(root))) {
    return;
  }
  const live = new Set(Arr.map(yield* deps.herdr.agentList(), (agent) => agent.name));
  for (const name of yield* fs.readDirectory(root)) {
    if (name === launching || live.has(name)) {
      continue;
    }
    const listed = deps.herdr.agentList().pipe(
      Effect.map((agents) => Arr.some(agents, (agent) => agent.name === name)),
      Effect.orElseSucceed(() => true),
    );
    yield* putDownControl(deps, name, listed).pipe(Effect.ignore);
  }
});

export const putDownControl = Effect.fn("Compaction.putDownControl")(function* <R>(
  deps: Pick<CompactionDeps, "ports" | "stateDir" | "log" | "stopMs">,
  name: string,
  listed: Effect.Effect<boolean, never, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* withControlLock(
    deps.stateDir,
    name,
    Effect.gen(function* () {
      // WARNING: a launch may finish while we wait for its lock; the earlier list cannot prove this agent is still absent.
      if (yield* listed) {
        return "core lists its agent again";
      }
      const record = yield* readControl(deps.stateDir, name);
      // WARNING: a server already signalled is only looked at again, so no launch waits out its budget.
      const signalled =
        Option.getOrUndefined(
          Option.flatMap(Option.fromNullishOr(record), (present) =>
            Option.map(Option.fromNullishOr(present.stop), (present_) =>
              Arr.some(present_.signalled, (one) => one.pid === present.pid),
            ),
          ),
        ) ?? false;
      const budget = signalled ? 0 : (deps.stopMs ?? STOP_WAIT_MS);
      const reached = record === null ? null : yield* stopRecord(deps, record, budget);
      if (reached !== null && reached.state !== "quiet") {
        return `its Codex turn has not stopped: ${notStopped(name, reached, reached.target)}`;
      }
      if (reached === null) {
        yield* putDownServer(deps, record);
      }
      yield* fs.remove(path.join(deps.stateDir, CONTROL_DIR, name), {
        recursive: true,
        force: true,
      });
      return null;
    }),
  );
});

const putDownServer = Effect.fn("Compaction.putDownServer")(function* (
  deps: Pick<CompactionDeps, "log">,
  record: ControlRecord | null,
) {
  const pid = yield* endpointPid(record);
  if (record === null || pid === null) {
    return;
  }
  yield* terminate(pid);
  yield* deps.log(`${record.agent}: stopped its compaction endpoint (pid ${pid})`);
});

// WARNING: a pid is signalled only if its command line still matches, since pids are reused; a record with no command is never signalled.
export const endpointPid = Effect.fn("Compaction.endpointPid")(function* (
  record: Pick<ControlRecord, "pid" | "command"> | null,
  proc = "/proc",
) {
  const { pid, command } = record ?? {};
  if (!pid || !command) {
    return null;
  }
  return pipe_(yield* commandOf(pid, proc), Str.includes(command)) ? pid : null;
});

// WARNING: never a liveness nudge, a mid-step recovery message or a human typing in the pane; those are not boundaries.
export const atBoundary = Effect.fn("Compaction.atBoundary")(function* <SubmissionError>(
  deps: CompactionDeps,
  at: { agent: string; run: string; step: string },
  submitting: <A, E, R>(
    body: (channel: Channel) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | Unsubmitted | SubmissionError, R | PortServices | Records>,
) {
  const limit = yield* enabled(deps.configured);
  if (!limit) {
    return DISPATCH;
  }

  const record = yield* readControl(deps.stateDir, at.agent);
  const port = record ? deps.ports[record.harness] : undefined;
  if (!record || !port) {
    return DISPATCH;
  }
  const ctx: AgentContext = {
    agent: record.agent,
    run: at.run,
    harness: record.harness,
    cwd: record.cwd,
    dir: record.dir,
    endpoint: record.endpoint,
    channel: sendsNothing(record.agent),
  };

  // WARNING: an attempt left unresolved outranks a fresh reading: no new work reaches an agent whose compaction is still in the air.
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
  // WARNING: unavailable is not zero and not the last high reading; recheck at the next eligible boundary.
  if (sample === null) {
    yield* deps.log(`${at.agent}: no usable context sample; sending the work`);
    return DISPATCH;
  }
  if (deps.sample) {
    yield* deps.sample(at, sample);
  }
  if (sample < limit.tokens) {
    yield* deps.log(`${at.agent}: ${sample} tokens in context, under ${limit.tokens}`);
    return DISPATCH;
  }

  if (deps.room !== undefined && (yield* deps.room(record.cwd)) === "stopped") {
    return {
      dispatch: false,
      reason: `${at.agent}: the Run was stopped while its compaction waited for disk`,
    } satisfies Boundary;
  }
  const now = yield* Clock.currentTimeMillis;
  const marked =
    port.mark === undefined ? null : yield* port.mark(ctx).pipe(Effect.orElseSucceed(() => null));
  const attempt = {
    id: `${at.agent}-${now}`,
    run: at.run,
    step: at.step,
    deadline: now + deps.waitMs,
    asked: now,
    ...(marked === null
      ? null
      : { session: marked.session, launch: marked.launch, transcript: marked.transcript }),
  };
  // WARNING: written before the request is sent, so a crash leaves the attempt visible.
  yield* writeControl(deps.stateDir, { ...record, attempt });
  yield* deps.warn(
    `  ⇣ ${at.agent}: ${sample} tokens in context — asking it to compact before ${at.step}`,
  );
  const submitted = yield* submitting((channel) =>
    port.request({ ...ctx, channel }, attempt.id),
  ).pipe(Effect.result);
  const failure = Result.isFailure(submitted) ? submitted.failure : null;
  if (Result.isSuccess(submitted) && submitted.success !== "observed") {
    yield* deps.log(`${at.agent}: compaction request written, no turn observed`);
  }
  if (failure instanceof Unsubmitted) {
    // WARNING: a channel that refused a submission is temporary and does not pause the Run; only an unconfirmed outcome does.
    yield* writeControl(deps.stateDir, { ...record, attempt: null });
    yield* deps.warn(
      `  ⚠ ${at.agent}: could not ask it to compact (${failure.message}) — sending the work anyway`,
    );
    return DISPATCH;
  }
  if (failure !== null) {
    yield* deps.log(
      `${at.agent}: asking it to compact failed (${reason(failure)}), but the request may already have reached it — waiting on ${attempt.id}`,
    );
  }
  return yield* settle(deps, ctx, record, attempt, at.step);
});

// WARNING: runs in no transaction, so a steer is never refused behind it; it may send nothing.
const sendsNothing: (agent: string) => Channel = (agent) => ({
  agent,
  submit: () =>
    Effect.succeed({
      ok: false,
      id: null,
      reason: "blocked",
      detail: "a compaction's reading or poll sends nothing",
    }),
});

export const readingContext: (record: ControlRecord, run: string) => AgentContext = (
  record,
  run,
) => ({
  agent: record.agent,
  run,
  harness: record.harness,
  cwd: record.cwd,
  dir: record.dir,
  endpoint: record.endpoint,
  channel: sendsNothing(record.agent),
});

// WARNING: a stop ends the incarnation that asked, so its compaction can never complete; it is cancelled, never settled by a later boundary.
export const cancelCompaction = Effect.fn("Compaction.cancelCompaction")(function* (
  deps: Pick<CompactionDeps, "ports" | "stateDir" | "log">,
  agent: string,
  why: string,
) {
  const record = yield* readControl(deps.stateDir, agent);
  const attempt = record?.attempt;
  if (record === null || !attempt) {
    return false;
  }
  const port = deps.ports[record.harness];
  const cancelling = port === undefined ? undefined : port.cancel;
  if (cancelling === undefined) {
    yield* recordCancelled(
      record.dir,
      { id: attempt.id, session: attempt.session ?? null, launch: attempt.launch ?? null },
      why,
    );
  } else {
    const ctx = readingContext(record, attempt.run);
    // WARNING: an attempt marked before Collie knew the incarnation is still bound to the session it asks of now.
    const session =
      attempt.session ??
      (port?.mark === undefined
        ? null
        : ((yield* port.mark(ctx).pipe(Effect.orElseSucceed(() => null)))?.session ?? null));
    yield* cancelling(
      ctx,
      {
        id: attempt.id,
        session,
        launch: attempt.launch ?? null,
        transcript: attempt.transcript ?? null,
      },
      why,
    ).pipe(Effect.orElseSucceed(() => void 0));
  }
  yield* writeControl(deps.stateDir, { ...record, attempt: null });
  yield* deps.log(`${agent}: compaction ${attempt.id} was cancelled (${why})`);
  return true;
});

// WARNING: an attempt no longer recorded, as a deleted control directory leaves it, is over.
export const pollCompaction = Effect.fn("Compaction.pollCompaction")(function* (
  deps: CompactionDeps,
  agent: string,
) {
  const record = yield* readControl(deps.stateDir, agent);
  const port = record ? deps.ports[record.harness] : undefined;
  if (!record?.attempt || !port) {
    return DISPATCH;
  }
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

const resolved = Effect.fn("Compaction.resolved")(function* (
  deps: CompactionDeps,
  ctx: AgentContext,
  record: ControlRecord,
  attempt: Schema.Schema.Type<typeof AttemptSchema>,
) {
  const port = deps.ports[ctx.harness]!;
  const mark: Marked = {
    id: attempt.id,
    session: attempt.session ?? null,
    launch: attempt.launch ?? null,
    transcript: attempt.transcript ?? null,
  };
  const outcome = yield* port
    .poll(ctx, mark)
    .pipe(
      Effect.catch((cause) =>
        deps
          .log(`${ctx.agent}: reading compaction ${attempt.id} failed (${reason(cause)})`)
          .pipe(Effect.as(null)),
      ),
    );
  const since = attempt.asked ?? attempt.deadline;
  const settled =
    outcome === null &&
    port.reconcile !== undefined &&
    (yield* Clock.currentTimeMillis) >= since + RECONCILE_AFTER_MS
      ? yield* port.reconcile(ctx, mark, since).pipe(Effect.orElseSucceed(() => null))
      : outcome;
  if (settled === null) {
    return null;
  }
  yield* writeControl(deps.stateDir, { ...record, attempt: null });
  if (settled.kind === "success") {
    yield* deps.log(`${ctx.agent}: native compaction ${attempt.id} completed`);
  } else {
    yield* deps.warn(
      `  ⚠ ${ctx.agent}: native compaction failed (${settled.reason}) — sending the work anyway`,
    );
  }
  return DISPATCH;
});

// WARNING: only the harness's own correlated evidence ends a request; an ack, an old idle state or a transport error establishes nothing.
const settle = Effect.fn("Compaction.settle")(function* (
  deps: CompactionDeps,
  ctx: AgentContext,
  record: ControlRecord,
  attempt: Schema.Schema.Type<typeof AttemptSchema>,
  step: string,
) {
  const done = yield* resolved(deps, ctx, record, attempt).pipe(
    Effect.repeat({
      until: (done) => done !== null,
      schedule: Schedule.spaced(deps.pollMs).pipe(
        Schedule.while(({ now }) => now < attempt.deadline),
        Schedule.modifyDelay(({ duration, now }) =>
          Effect.succeed(Duration.min(duration, Duration.millis(attempt.deadline - now))),
        ),
      ),
    }),
  );
  if (done !== null) {
    return done;
  }
  // WARNING: the attempt is kept, not cleared: a timeout is not proof the agent stopped compacting, so nothing retries or replays the work.
  if (deps.waitMs === 0) {
    return {
      dispatch: false,
      reason: `${ctx.agent}: compaction ${attempt.id} is still in the air — no work sent; try again once it has finished`,
    } satisfies Boundary;
  }
  return {
    dispatch: false,
    waiting: true,
    cause: "compaction-unsettled",
    reason: `${ctx.agent}: compaction ${attempt.id} has not finished after ${Math.round(deps.waitMs / 60_000)} minutes; Collie keeps waiting for its completion and resumes ${step} once it arrives. Check its pane.`,
  } satisfies Boundary;
});
