// Compaction between pieces of work: one absolute threshold, one policy, and the
// per-agent controls a harness's official interface installs when Collie launches it.
//
// The policy lives here once because every work-dispatch path shares it — a Workflow's
// next step, a fix round, a hand-off from another Run — and a threshold repeated per
// harness is a threshold that disagrees with itself.

import { Clock, Data, Effect, FileSystem, Path, PlatformError, Schema } from "effect";
import type { BunServices } from "@effect/platform-bun/BunServices";
import type { Herdr } from "./herdr";
import { reason } from "./naming";

/**
 * The user-wide threshold in current-context tokens, and the value that turns the
 * feature off. Absolute rather than a percentage of a window: the four harnesses
 * measure different windows, and one number is what a human can reason about.
 */
export const COMPACT_AT_TOKENS = 372_000;
export const COMPACTION_OFF = 0;

/**
 * How long Collie waits for a compaction request to resolve before it pauses the Run.
 * Fixed: no workflow, step or harness shortens it. A Run that waited less would send
 * the next piece of work into a context whose size nobody has established.
 */
export const COMPACTION_WAIT_MS = 5 * 60 * 1000;

/** Where an agent's controls live, for as long as the agent does. */
export const CONTROL_DIR = "compaction";
const CONTROL_FILE = "control.json";

/**
 * The configured threshold, resolved. `bad` is kept as a message rather than coerced:
 * the fallback would be the default, so a `-1` or a `3.5` someone meant as a limit
 * would silently become 372,000 and compact an agent they had tried to leave alone.
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

/** Whether a configured value is one a Run can use, for the writers that refuse it. */
export function validThreshold(configured: number): boolean {
  return !("bad" in threshold(configured));
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
}

export interface AgentContext extends LaunchContext {
  /** The human's channel, which is how a harness with no RPC is asked to compact. */
  herdr: Pick<Herdr, "agentPrompt">;
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
  /** Submits a native compaction request. Acknowledgement only, never completion. */
  request(ctx: AgentContext, requestId: string): Effect.Effect<void, PortError, PortServices>;
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
  attempt: Schema.NullOr(AttemptSchema),
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
  herdr: Pick<Herdr, "agentPrompt" | "agentList">;
  /** The run's audit trail, for everything the transcript has to be able to explain. */
  log: (line: string) => Effect.Effect<void, PortError, PortServices>;
  /** The Run's own channel, so a warning reaches the CLI and the board, not just a log. */
  warn: (line: string) => Effect.Effect<void, PortError, PortServices>;
  waitMs: number;
  pollMs: number;
}

/**
 * Whether the waiting work may be sent. `dispatch: false` is the pause: the Run stops
 * where it is, with the reason a human reads, and no prompt goes to the agent.
 */
export type Boundary =
  | { readonly dispatch: true }
  | { readonly dispatch: false; readonly reason: string };

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
 * is installed when the feature is off or the harness is one Collie does not manage;
 * a harness it manages but cannot talk to fails here, before the agent starts.
 */
export const installControls = Effect.fn("Compaction.installControls")(function* (
  deps: Pick<CompactionDeps, "ports" | "stateDir" | "configured" | "log" | "herdr">,
  agent: { agent: string; harness: string; cwd: string },
) {
  const limit = yield* enabled(deps.configured);
  if (!limit) return [];
  const port = deps.ports[agent.harness];
  if (!port) {
    yield* deps.log(`${agent.agent}: ${agent.harness} has no compaction controls in Collie`);
    return [];
  }
  // Before this agent's own controls exist: every launch puts down what the last ones
  // left behind. Controls live as long as their agent, which is longer than the Run
  // that started it — but not for ever, and an endpoint nothing will connect to again
  // is a process and a directory leaking. First, because the agent being launched is
  // not in `agent list` yet, and a tidy-up after the install would put down its own.
  yield* Effect.ignore(putDownStaleControls(deps, agent.agent));
  const dir = yield* controlDir(deps.stateDir, agent.agent);
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(dir, { recursive: true });
  const installed = yield* port.install({ ...agent, dir });
  yield* writeControl(deps.stateDir, {
    ...agent,
    dir,
    endpoint: installed.endpoint ?? null,
    pid: installed.pid ?? null,
    command: installed.command ?? null,
    attempt: null,
  });
  yield* deps.log(`${agent.agent}: compaction controls installed in ${dir}`);
  return installed.args;
});

/**
 * Removes the controls of every agent herdr no longer has, and stops the endpoint each
 * was holding open. Best-effort by design: a tidy-up that failed must never stop a
 * launch, and an agent this Session cannot see is not necessarily gone — so only the
 * ones herdr does not list at all are put down.
 */
const putDownStaleControls = Effect.fn("Compaction.putDownStaleControls")(function* (
  deps: Pick<CompactionDeps, "stateDir" | "herdr" | "log">,
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
    const pid = yield* endpointPid(yield* readControl(deps.stateDir, name));
    if (pid !== null) {
      yield* Effect.ignore(Effect.sync(() => process.kill(pid, "SIGTERM")));
      yield* deps.log(`${name}: stopped its compaction endpoint (pid ${pid})`);
    }
    yield* Effect.ignore(fs.remove(path.join(root, name), { recursive: true }));
  }
});

/**
 * The pid to signal, where this record still describes a server of Collie's — and null
 * everywhere else. A control record outlives the process it names: a machine reboots, a
 * server is killed, and the pid comes round again, so a launch that signalled a
 * recorded number on trust would eventually SIGTERM something the human was using. The
 * process's own command line is the check, and a `/proc` entry that cannot be read is
 * treated as already gone.
 *
 * A record from before this was written carries no command, and so is never signalled:
 * its directory is removed and its endpoint, if it is still up, is left alone.
 */
const endpointPid = Effect.fn("Compaction.endpointPid")(function* (record: ControlRecord | null) {
  if (!record?.pid || !record.command) return null;
  const fs = yield* FileSystem.FileSystem;
  const cmdline = yield* fs
    .readFileString(`/proc/${record.pid}/cmdline`)
    .pipe(Effect.catch(() => Effect.succeed("")));
  // NUL-separated argv, which is not a string until the separators are.
  return cmdline.replaceAll("\0", " ").includes(record.command) ? record.pid : null;
});

/**
 * Refuses a step whose agents would launch on a harness Collie cannot manage, before
 * any tab opens. Only the harnesses about to be started fresh: a reused agent already
 * has the controls it was launched with.
 */
export const gateHarnesses = Effect.fn("Compaction.gateHarnesses")(function* (
  deps: Pick<CompactionDeps, "ports" | "configured">,
  harnesses: ReadonlyArray<string>,
) {
  const limit = yield* enabled(deps.configured);
  if (!limit) return;
  for (const harness of new Set(harnesses)) {
    const port = deps.ports[harness];
    if (port) yield* port.gate();
  }
});

/**
 * The work boundary: immediately before a reused agent that has finished its previous
 * work is given the next piece. Never a liveness nudge, a mid-step recovery message or
 * a human typing in the pane — those are not boundaries, and this is not called on them.
 */
export const atBoundary = Effect.fn("Compaction.atBoundary")(function* (
  deps: CompactionDeps,
  at: { agent: string; run: string; step: string },
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
    harness: record.harness,
    cwd: record.cwd,
    dir: record.dir,
    endpoint: record.endpoint,
    herdr: deps.herdr,
  };

  // An attempt an earlier boundary left unresolved outranks a fresh reading. It is the
  // rule a recovery cannot break: no new work reaches an agent whose last compaction
  // is still in the air, whichever process asked for it.
  if (record.attempt) {
    yield* deps.log(
      `${at.agent}: compaction ${record.attempt.id} from ${record.attempt.step} is still unresolved`,
    );
    return yield* settle(deps, ctx, record, record.attempt);
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
  const failure = yield* port.request(ctx, attempt.id).pipe(
    Effect.as(null),
    Effect.catch((cause) => Effect.succeed(cause)),
  );
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
  return yield* settle(deps, ctx, record, attempt);
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
) {
  const port = deps.ports[ctx.harness]!;
  const clear = writeControl(deps.stateDir, { ...record, attempt: null });
  for (;;) {
    const outcome = yield* port.poll(ctx, attempt.id).pipe(
      Effect.catch((cause) =>
        // Logged, not warned, and above all not resolved: a read that failed says
        // nothing about the compaction, and the budget is still running.
        deps
          .log(`${ctx.agent}: reading compaction ${attempt.id} failed (${reason(cause)})`)
          .pipe(Effect.as(null)),
      ),
    );
    if (outcome?.kind === "success") {
      yield* clear;
      yield* deps.log(`${ctx.agent}: native compaction ${attempt.id} completed`);
      return DISPATCH;
    }
    if (outcome?.kind === "failure") {
      yield* clear;
      yield* deps.warn(
        `  ⚠ ${ctx.agent}: native compaction failed (${outcome.reason}) — sending the work anyway`,
      );
      return DISPATCH;
    }
    const now = yield* Clock.currentTimeMillis;
    if (now >= attempt.deadline) {
      // The attempt is kept, not cleared: it is unresolved, not over. A timeout is not
      // proof that the agent stopped compacting, so nothing here retries, kills the
      // agent or replays the work — and the next boundary refuses to dispatch too.
      return {
        dispatch: false,
        reason:
          deps.waitMs === 0
            ? `${ctx.agent}: compaction ${attempt.id} is still in the air — no work sent; try again once it has finished`
            : `${ctx.agent}: compaction ${attempt.id} neither completed nor failed within ` +
              `${Math.round(deps.waitMs / 60_000)} minutes — no work sent; check its pane`,
      };
    }
    yield* Effect.sleep(Math.min(deps.pollMs, attempt.deadline - now));
  }
});
