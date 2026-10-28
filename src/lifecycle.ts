// A Run from both front doors: start it, watch it, and pick it up again.
//
// The CLI and the picker do the same things to a workflow saved as a module, so they do
// them here rather than each their own way: which id is a module's, the claim that makes a
// retry one Run, and the read model show, list and wait are drawn from. Execution belongs
// to the host — this is the client side of it, and it holds no state of its own.
//
// What a Run is and what became of it stays Collie's; what a workflow has done stays
// Effect's. Nothing here copies the second into the first.

import { awaitingLine } from "./awaiting";
import { redactedField, withNotice } from "./redact";
import type { SettingValue } from "./settings";
import { reportOf, resultText, type Recorded } from "./report";
import { metricsOf } from "./metrics";
import type { OutcomeRecords } from "./outcomes";
import {
  Cause,
  Deferred,
  Effect,
  Fiber,
  FileSystem,
  Option,
  Path,
  Predicate,
  Schedule,
  Schema,
  Stream,
} from "effect";
import type { Scope } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type * as RpcClientError from "effect/rpc/RpcClientError";
import type { PluginEnv } from "./env";
import { savedModules, type Fault, type Found } from "./discovery";
import {
  connect,
  connectPeer,
  frontDoor,
  restartHost,
  restartSaid,
  socketOf,
  type HostClient,
  type HostUnavailable,
  type HostVersionMismatch,
} from "./host";
import { Herdr } from "./herdr";
import { machineName, pairWith, peersOf } from "./peers";
import { openConnection } from "./ssh-connection";
import { type HerdrMachine, MachineUnreachable, type RelayHeader } from "./peers-model";
import {
  sortBoard,
  type BoardMessage,
  type BoardSnapshot,
  type RunDetail,
  type Controlled,
  leftSaid,
  FrontDoor,
  Declaration,
  HostRefused,
  type Disposition,
  type Seen,
  type ProposalCarried,
  type ProposalRefused,
  type RequestConflict,
  type ActionResult,
  type SteerOutcome,
  type TaskView,
  type NewsReceipt,
  type Metrics,
  givenOfferInput,
} from "./board-model";
import type { Action } from "./actions";
import { NEEDS_INPUT, REFUSED_INPUT, runDir, type Given, type RunView } from "./engine";
import type { OfferView } from "./board-model";
import { err, ExpectedError, taskFor, type Failure, type OpResult } from "./operations";
import { voiceOf, type Asker } from "./proposals";
import type { TaskChoice } from "./task";
import { encodeApprovedFile, rememberedFile, renderApproved, type VerifySpec } from "./verify-spec";
import { projectHere, shell } from "./mr";
import { defaultsPath, readDefaults, readIntent, type Change, type IntentSeed } from "./intent";
import { scopeFor, scopeKey } from "./registry";
import { PROJECTS_ROOT_OPTION, projectsRoot } from "./projects";
import { reason } from "./naming";
import { attachmentRefusal } from "./attachments";
import type { ScheduleChange } from "./schedule-model";
import type { ScheduleDoor } from "./schedule-move";

export { savedModules } from "./discovery";

/**
 * The inputs this module needs that nobody gave it, as the refusal an agent can fill in
 * and retry with the same request id. Each carries what it will take, so a caller that
 * has never seen the module can still answer it.
 */
export const neededInputs = (entry: Found, given: Given): Failure | null => {
  const missing = entry.inputs.filter(
    (field) =>
      field.required &&
      given.text[field.name] === undefined &&
      given.json[field.name] === undefined,
  );
  if (missing.length === 0) return null;
  return err(
    "needs_input",
    `${entry.id} needs ${missing.map((field) => `"${field.name}"`).join(", ")}.`,
    {
      workflow: entry.id,
      // The file this is about, so a caller told to fill something in can read what it
      // is filling in for — the same path `workflow show` and the definitions tool name.
      path: entry.path,
      inputs: missing.map((field) => ({
        name: field.name,
        question: `${entry.title} — ${field.name}?`,
        schema: field.schema,
        limits: [...field.limits],
      })),
    },
  );
};

/**
 * The saved module this id names: the entry where one loads, the fault where the file
 * will not, and null where no module claims it. A broken module is a file to fix rather
 * than nothing.
 */
export const moduleFor = (
  env: PluginEnv,
  id: string,
): Effect.Effect<Found | Fault | null, never, FileSystem.FileSystem> =>
  savedModules(env).pipe(
    Effect.map(
      (found) =>
        found.entries.find((entry) => entry.id === id) ??
        found.problems.find((problem) => problem.id === id) ??
        null,
    ),
  );

/**
 * Whether anything has ever run in this state directory. A machine that has never
 * started a module does not start a host to be told it has none.
 */
/**
 * Whether this installation has any Runs the host is holding. The database is the whole
 * of it: no rows, no host worth starting, and a caller that asked is told so rather than
 * waiting on one that has nothing to say.
 */
export const anyRuns = (env: PluginEnv): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.exists(`${env.stateDir}/host.db`)),
    Effect.orElseSucceed(() => false),
  );

type HostFailure =
  | HostRefused
  | ProposalRefused
  | RequestConflict
  | HostUnavailable
  | HostVersionMismatch
  | MachineUnreachable
  | RpcClientError.RpcClientError;

type Client = FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner;

/** A refusal as the front doors say one, with the host's own sentence inside it. */
export const refusal = (cause: HostFailure): Failure => {
  switch (cause._tag) {
    case "HostRefused":
      // The host says so first where the input is why, and that is exit 2, not exit 1.
      if (cause.reason.startsWith(`${REFUSED_INPUT}:`))
        return err("invalid_input", cause.reason.slice(REFUSED_INPUT.length + 1).trim());
      if (cause.reason.startsWith(`${NEEDS_INPUT}:`))
        return err("needs_input", cause.reason.slice(NEEDS_INPUT.length + 1).trim());
      return cause.reason.startsWith("invalid_state:")
        ? err("invalid_state", cause.reason.slice("invalid_state:".length).trim())
        : err("operation_failed", cause.reason);
    case "ProposalRefused":
      return err("invalid_input", cause.detail, { reason: cause.refused });
    case "RequestConflict":
      return err("invalid_input", cause.reason, { request: cause.request });
    case "HostVersionMismatch":
      return err("operation_failed", cause.restart, { host: cause.host, pid: cause.pid });
    case "HostUnavailable":
      return err("operation_failed", `No workflow host for ${cause.dir}: ${cause.reason}.`);
    case "MachineUnreachable":
      return cause.waits === undefined
        ? err("machine_unreachable", `${cause.machine} did not answer: ${cause.seen}.`, {
            machine: cause.machine,
            seen: cause.seen,
          })
        : err(
            "machine_unreachable",
            `${cause.machine} did not answer: its link waits on an SSH connection, and none is open; collie machine connect ${cause.machine} opens one.`,
            { machine: cause.machine, seen: cause.seen, waits: cause.waits },
          );
    default:
      return err("operation_failed", `The workflow host did not answer: ${String(cause)}.`);
  }
};

/** Who is asking: a front door, or an Actor whose voice a nested operation carries on. */
export type Door = FrontDoor | Asker;

const isFrontDoor = Schema.is(FrontDoor);

const declaring = (door: Door, session: string | null, stamp?: string): typeof Declaration.Type => {
  if (isFrontDoor(door)) return { frontDoor: door, session };
  let declared: typeof Declaration.Type = { frontDoor: door.origin, session, ...voiceOf(door) };
  if (door.from !== undefined) declared = { ...declared, from: door.from };
  if (stamp !== undefined) declared = { ...declared, stamp };
  return declared;
};

/** What ssh says while a front door opens a connection: to the person who answers its login. */
const toStderr = (text: string) => Effect.sync(() => void process.stderr.write(text));

/**
 * A paired Machine by herdr's name for it: kept as it is, or paired now through its SSH
 * connection, opened by a front door that can show its login. A host's own jobs never pair.
 */
export const ensurePaired = Effect.fn("Lifecycle.ensurePaired")(function* (
  env: PluginEnv,
  name: string,
) {
  if ((yield* peersOf(env.stateDir)).some((peer) => peer.name === name)) return;
  const machine = (yield* herdrMachines(env)).find((one) => one.label === name);
  if (machine === undefined) return yield* notListed(name);
  if (env.pairs !== true)
    return yield* new HostRefused({
      reason: `invalid_state: ${name} is not paired yet; a command in a terminal pairs it`,
    });
  yield* Effect.scoped(
    Effect.gen(function* () {
      const local = yield* connect(env.stateDir);
      const { installation } = yield* local.identity();
      const { path } = yield* openConnection(env.stateDir, machine, { said: toStderr });
      const peer = yield* pairWith(machine, {
        installation: installation ?? "",
        name: machineName(),
        control: path,
      });
      yield* local.pair({ peer });
    }),
  );
});

const notListed = (name: string) =>
  new HostRefused({
    reason: `${REFUSED_INPUT}: no Machine "${name}": herdr lists no machine by that name`,
  });

/** herdr's saved machines, or none where herdr could not say. */
const herdrMachines = (env: PluginEnv) =>
  new Herdr(env).machineList().pipe(
    Effect.orElseSucceed((): ReadonlyArray<HerdrMachine> => []),
    Effect.provide(Path.layer),
  );

/**
 * Opens this computer's SSH connection to herdr's machine `name`, where none is open, and
 * wakes this host's link to it.
 */
const openAndWake = (env: PluginEnv, name: string, said: (text: string) => Effect.Effect<void>) =>
  Effect.gen(function* () {
    const machine = (yield* herdrMachines(env)).find((one) => one.label === name);
    if (machine === undefined) return yield* notListed(name);
    const opened = yield* openConnection(env.stateDir, machine, { said });
    yield* asks({ ...env, machine: undefined }, (client) => client.wake({ machine: name }));
    return opened;
  });

/**
 * `reaching` the Machine `name`, and where its link waits on an SSH connection, the same
 * once more after opening one: only for a front door that can show its login.
 */
export const riding = <A, E, R>(
  env: PluginEnv,
  name: string,
  reaching: Effect.Effect<A, E | MachineUnreachable, R>,
): Effect.Effect<A, E | MachineUnreachable | HostRefused, R | Client> =>
  reaching.pipe(
    Effect.catchIf(
      (cause): cause is MachineUnreachable =>
        env.pairs === true &&
        Schema.is(MachineUnreachable)(cause) &&
        cause.waits === "ssh_connection",
      () => openAndWake(env, name, toStderr).pipe(Effect.andThen(reaching)),
    ),
  );

/** The front door a relay header names, for a door a channel would declare. */
const relayHeader = (door: Door | undefined, stamp?: string): RelayHeader => {
  let header: RelayHeader = {
    as: door === undefined ? "cli" : isFrontDoor(door) ? door : door.origin,
    client: machineName(),
  };
  if (
    door !== undefined &&
    !isFrontDoor(door) &&
    door.from?.run !== undefined &&
    door.from.agent !== undefined
  )
    header = { ...header, sender: { run: door.from.run, agent: door.from.agent } };
  if (header.as === "host" && stamp !== undefined) header = { ...header, stamp };
  return header;
};

/**
 * This Machine's host, or the named peer's over its relay, opened as `door`: a relay's
 * header names it, so nothing is declared over one.
 */
const reach = (
  env: PluginEnv,
  machine: string | null,
  door?: Door,
): Effect.Effect<HostClient, HostFailure, Client | Scope.Scope> =>
  machine === null
    ? connect(env.stateDir).pipe(
        Effect.tap((client) =>
          door === undefined
            ? Effect.void
            : client.declare(declaring(door, env.socketPath, env.hostStamp)),
        ),
      )
    : ensurePaired(env, machine).pipe(
        Effect.andThen(
          riding(
            env,
            machine,
            connectPeer(env.stateDir, machine, relayHeader(door, env.hostStamp)),
          ),
        ),
      );

/** An answer, and the Machine it came from: null for this one. */
type Answered<A> = { readonly ok: true; readonly value: A; readonly machine: string | null };

/**
 * One question to the host this command reaches — this Machine's, or the one `--machine`
 * names — asked on its own connection. An operation names the front door asking, which the
 * channel declares before anything else.
 */
const asks = <A>(
  env: PluginEnv,
  question: (client: HostClient) => Effect.Effect<A, HostFailure>,
  door?: Door,
): Effect.Effect<Answered<A> | Failure, never, Client> =>
  Effect.scoped(
    reach(env, env.machine ?? null, door).pipe(
      Effect.flatMap(question),
      Effect.map((value) => ({ ok: true as const, value, machine: env.machine ?? null })),
      Effect.catch((cause: HostFailure) => Effect.succeed(refusal(cause))),
    ),
  );

/**
 * One question about a Run, asked of the Machine that has it: this host first, then each
 * peer, then each machine herdr lists that is not paired yet, paired on the way. A Run id
 * names one Run, so where it is is never asked of the caller.
 */
export const asksRun = <A>(
  env: PluginEnv,
  runId: string,
  question: (client: HostClient) => Effect.Effect<A, HostFailure>,
  door?: Door,
): Effect.Effect<Answered<A> | Failure, never, Client> =>
  Effect.gen(function* () {
    if (env.machine !== undefined) return yield* asks(env, question, door);
    const asked: Array<string> = [];
    const away: Array<string> = [];
    /** The answer from `machine` where it has the Run; null where it has none. */
    const tryOn = (machine: string | null) =>
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* reach(env, machine, door);
          asked.push(machine ?? machineName());
          if ((yield* client.run({ runId })) === null) return null;
          return yield* question(client).pipe(
            Effect.map((value) => ({ ok: true as const, value, machine })),
            Effect.catch((cause: HostFailure) => Effect.succeed(refusal(cause))),
          );
        }),
      ).pipe(
        Effect.catch((cause: HostFailure) => {
          if (machine === null) return Effect.succeed(refusal(cause));
          away.push(`${machine} (${refusal(cause).error.message})`);
          return Effect.succeed(null);
        }),
      );
    if (yield* anyRuns(env)) {
      const here = yield* tryOn(null);
      if (here !== null) return here;
    } else asked.push(machineName());
    const peers = (yield* peersOf(env.stateDir)).map((peer) => peer.name);
    const unpaired =
      env.pairs === true
        ? (yield* herdrMachines(env))
            .map((machine) => machine.label)
            .filter((label) => !peers.includes(label))
        : [];
    for (const name of [...peers, ...unpaired]) {
      const there = yield* tryOn(name);
      if (there !== null) return there;
    }
    return err(
      "run_not_found",
      `Run "${runId}" was not found on ${asked.join(" or ")}${away.length === 0 ? "" : `, and ${away.join(", ")} did not answer`}.`,
      { run: runId, machines: asked, away },
    );
  });

/**
 * Starts the module this id names, under the caller's own claim on the work. The same
 * request twice is the same Run — which is what makes a retried command, a re-clicked
 * row and a replayed receipt one piece of work rather than three.
 *
 * The Task is chosen first, so the Run's agents open in its workspace rather than in
 * whichever one the host happened to be started from. A fresh one is only named here:
 * the host opens it once it knows the checkout it is rooted at.
 */
export const startRun = Effect.fn("Lifecycle.startRun")(function* (
  env: PluginEnv,
  options: {
    readonly door: Door;
    readonly id: string;
    readonly request: string;
    /** What the caller said, in the two halves the author's schemas settle differently. */
    readonly input: Given;
    /** The host's own launch options, kept out of the author's payload. */
    readonly options?: Readonly<Record<string, string>>;
    readonly task: TaskChoice;
    readonly parent?: string | null;
    /** The goal and constraints named at launch, beside the workspace's own defaults. */
    readonly intent?: Pick<IntentSeed, "goal" | "constraints">;
    /** What a fresh Task is to be called, where the human said. */
    readonly title?: string | undefined;
    /** The checks given with the start, over the project's and the user's files. */
    readonly verify?: ReadonlyArray<VerifySpec> | undefined;
    /** Paths on this Machine, which the host copies into the Run. */
    readonly attachments?: ReadonlyArray<string> | undefined;
  },
) {
  // Refused before a Task is opened for it, as the host would refuse it before the claim.
  const unattachable = yield* attachmentRefusal(options.attachments ?? []).pipe(
    Effect.orElseSucceed(() => null),
  );
  if (unattachable !== null) return err("invalid_input", unattachable);
  // A Task and a workspace's defaults are this Machine's, and a start on another opens its own.
  const elsewhere = env.machine !== undefined;
  if (elsewhere && options.task.mode !== "new")
    return err(
      "invalid_input",
      `A Run started on ${env.machine} opens a Task there; --task, --continue-task and --here name this Machine's.`,
    );
  // The defaults of the workspace this was started from, which only a front door knows.
  const defaults = elsewhere
    ? null
    : yield* readDefaults(yield* defaultsPath(env.stateDir, scopeKey(scopeFor(env, env.cwd)))).pipe(
        Effect.orElseSucceed(() => null),
      );
  const placed = yield* taskFor(env, options.task, {
    workflow: options.id,
    inputs: { ...options.input.json, ...options.input.text },
    goal: options.intent?.goal,
    title: options.title,
  });
  if (placed._tag === "Rejected") return placed.result;
  // Resolved here, once: what this front door listed and offered is where the host roots it.
  const root =
    options.options?.workspace === PROJECTS_ROOT_OPTION && !elsewhere
      ? (yield* projectsRoot(env)).path
      : undefined;
  return yield* asks(
    env,
    (client) =>
      client.start({
        project: env.cwd,
        id: options.id,
        request: options.request,
        input: options.input.json,
        text: options.input.text,
        inferred: options.input.inferred,
        root,
        options: options.options,
        task: placed.task?.id,
        taskLabel: placed.label ?? undefined,
        parent: options.parent ?? undefined,
        intent: defaults === null ? { ...options.intent } : { ...options.intent, defaults },
        verify: options.verify,
        attachments: options.attachments,
      }),
    options.door,
  ).pipe(
    Effect.map((answered) =>
      answered.ok
        ? {
            ok: true as const,
            runId: answered.value.runId,
            registration: answered.value.registration,
            fresh: answered.value.fresh,
            redacted: answered.value.redacted ?? [],
          }
        : answered,
    ),
  );
});

/** Every Run a listing can show, and why the rest could not be read. */
export interface RunListing {
  readonly runs: ReadonlyArray<RunView>;
  readonly unreadable: string | null;
}

/** One Run as a front door shows it, or null where the host has none by that id. */
export const runView = (
  env: PluginEnv,
  runId: string,
): Effect.Effect<RunView | Failure | null, never, Client> =>
  anyRuns(env).pipe(
    Effect.flatMap((any) =>
      any || env.machine !== undefined
        ? asks(env, (client) => client.run({ runId })).pipe(
            Effect.map((answered) => (answered.ok ? answered.value : answered)),
          )
        : Effect.succeed(null),
    ),
  );

/** What `run show` prints of a Run, from the Machine that has it, and which one that is. */
export const runShown = (env: PluginEnv, runId: string) =>
  asksRun(env, runId, (client) => client.shown({ runId })).pipe(
    Effect.map((answered) =>
      !answered.ok
        ? answered
        : answered.value === null
          ? err("run_not_found", `Run "${runId}" was not found.`, { run: runId })
          : { ok: true as const, ...answered.value, machine: answered.machine },
    ),
  );

/** Where a Run has got to: Ready to release, its steps and its CI, from the host that has it. */
export const runProgress = (env: PluginEnv, runId: string) =>
  asksRun(env, runId, (client) => client.progress({ runId }));

/**
 * The checkout a Run's verifications are about: the one the host placed it on. A
 * verification collected anywhere else would bind a real result to a tree nobody is
 * looking at.
 */
export const treeOf = (view: RunView): string => view.cwd;

/**
 * Every Run this state directory has rows for, and why they could not be read
 * where they could not be: a host that will not start costs the caller those Runs,
 * never the listing it asked for.
 */
export const runViews = (
  env: PluginEnv,
  task: string | null,
): Effect.Effect<RunListing, never, Client> =>
  anyRuns(env).pipe(
    Effect.flatMap((any) =>
      any || env.machine !== undefined
        ? asks(env, (client) => client.runs({ task })).pipe(
            Effect.map((answered) =>
              answered.ok
                ? { runs: answered.value, unreadable: null }
                : { runs: [], unreadable: answered.error.message },
            ),
          )
        : Effect.succeed({ runs: [], unreadable: null }),
    ),
  );

export const flockRuns = Effect.fn("Lifecycle.flockRuns")(function* (
  env: PluginEnv,
  task: string | null,
) {
  const local = yield* runViews(env, task);
  const runs: Array<RunView & { readonly machine: string }> = local.runs.map((view) => ({
    ...view,
    machine: env.machine ?? machineName(),
  }));
  const machines: Array<{
    readonly machine: string;
    readonly state: "away";
    readonly note: string;
  }> = [];
  if (env.machine !== undefined) return { ...local, runs, machines };
  for (const peer of yield* peersOf(env.stateDir)) {
    const read = yield* Effect.scoped(
      connectPeer(env.stateDir, peer.name, { as: "cli", client: machineName() }).pipe(
        Effect.flatMap((client) => client.runs({ task: null })),
        Effect.result,
      ),
    );
    if (read._tag === "Success")
      runs.push(...read.success.map((view) => ({ ...view, machine: peer.name })));
    else
      machines.push({
        machine: peer.name,
        state: "away",
        note: refusal(read.failure).error.message,
      });
  }
  return { ...local, runs, machines };
});

/**
 * Every state this Run reaches, until `each` says the caller has what it came for. The
 * first one is where the work is now rather than what changed, so a client that has been
 * away — a board that was closed, a wait that was interrupted — reads the truth instead
 * of waiting for an update that has already been and gone.
 */
export const watchRun = <R>(
  env: PluginEnv,
  runId: string,
  each: (view: RunView) => Effect.Effect<boolean, never, R>,
): Effect.Effect<Failure | null, never, R | Client | Scope.Scope> =>
  Effect.gen(function* () {
    // Where the Run is, which a Run on no Machine leaves here, to be said not found.
    const found = yield* asksRun(env, runId, () => Effect.void);
    const opened = yield* reach(env, found.ok ? found.machine : (env.machine ?? null)).pipe(
      Effect.result,
    );
    if (opened._tag === "Failure") return refusal(opened.failure);
    let known = false;
    return yield* Stream.runForEachWhile(opened.success.watch({ runId }), (view) => {
      // Nothing was admitted under that id, so there is nothing to wait for.
      if (view === null) return Effect.succeed(false);
      known = true;
      return each(view).pipe(Effect.map((enough) => !enough));
    }).pipe(
      Effect.map(() =>
        known ? null : err("run_not_found", `Run "${runId}" was not found.`, { run: runId }),
      ),
      Effect.catchTag("RpcClientError", (cause) => Effect.succeed(refusal(cause))),
    );
  });

/** The host's board stream, from a host started here if none is running, or `--machine`'s. */
const boardStream = (env: PluginEnv) =>
  Effect.gen(function* () {
    if (env.machine !== undefined) return (yield* reach(env, env.machine)).board();
    yield* connect(env.stateDir);
    return (yield* frontDoor(socketOf(env.stateDir))).board();
  });

/** The board as the host serves it now: the first message of its stream. */
export const boardSnapshot = (
  env: PluginEnv,
): Effect.Effect<{ readonly ok: true; readonly value: BoardSnapshot } | Failure, never, Client> =>
  Effect.scoped(
    Effect.gen(function* () {
      const first = yield* Stream.runHead(yield* boardStream(env));
      if (first._tag === "Some" && first.value._tag === "Snapshot")
        return { ok: true as const, value: first.value };
      return err("operation_failed", "The workflow host sent no board.");
    }).pipe(Effect.catch((cause: HostFailure) => Effect.succeed(refusal(cause)))),
  );

/** The board's Tasks, and why there are none where the host could not be read. */
export interface BoardRead {
  readonly tasks: ReadonlyArray<TaskView>;
  readonly unreadable: string | null;
}

/** How long the first read waits for the host's board; later reads take what there is. */
const FIRST_BOARD_WAIT = "10 seconds";

/**
 * The board the host serves, followed for as long as the caller's scope: each read is the
 * latest the stream has said. A dropped stream reconnects and starts from a fresh snapshot.
 */
export const followBoard = Effect.fn("Lifecycle.followBoard")(function* (env: PluginEnv) {
  const tasks = new Map<string, TaskView>();
  const first = yield* Deferred.make<void>();
  let waited = false;
  /** False between a dropped stream and the fresh snapshot after it. */
  let live = false;
  let lost: string | null = null;
  const apply = (message: BoardMessage) =>
    Effect.suspend(() => {
      switch (message._tag) {
        case "Snapshot":
          tasks.clear();
          for (const task of message.tasks) tasks.set(task.id, task);
          live = true;
          lost = null;
          return Deferred.succeed(first, undefined);
        case "Upsert":
          tasks.set(message.task.id, message.task);
          return Effect.void;
        case "Remove":
          tasks.delete(message.id);
          return Effect.void;
        default:
          return Effect.void;
      }
    });
  const follow = Effect.scoped(
    Effect.flatMap(boardStream(env), (stream) => Stream.runForEach(stream, apply)),
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        lost = Cause.hasInterruptsOnly(cause) ? null : reason(Cause.squash(cause)).split("\n")[0]!;
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        live = false;
      }),
    ),
  );
  yield* Effect.forkScoped(follow.pipe(Effect.repeat(Schedule.spaced("1 second"))));
  return (): Effect.Effect<BoardRead> =>
    Deferred.await(first).pipe(
      Effect.timeoutOption(waited ? 0 : FIRST_BOARD_WAIT),
      Effect.map((arrived) => {
        waited = true;
        const why = lost === null ? "" : ` (${lost})`;
        return {
          tasks: sortBoard([...tasks.values()]),
          unreadable:
            arrived._tag === "None"
              ? `the workflow host has not sent its board${why}`
              : live
                ? null
                : `reconnecting to the workflow host${why}; these cards may be out of date`,
        };
      }),
    );
});

/** Which of a Run's details a drawer is showing. */
export interface DetailKey {
  readonly runId: string;
  readonly tail: boolean;
  readonly pages: number;
  /** Ask the host's merge watch again rather than take what it last read. */
  readonly refreshMr: boolean;
}

/** One Run's details from the host, from a host started here if none is running. */
const detailStream = (env: PluginEnv, key: DetailKey) =>
  Effect.gen(function* () {
    if (env.machine !== undefined) return (yield* reach(env, env.machine)).runDetail({ ...key });
    yield* connect(env.stateDir);
    return (yield* frontDoor(socketOf(env.stateDir))).runDetail({ ...key });
  });

/** A Run's details as the host has them now, for a caller that follows nothing. */
export const runDetailNow = (
  env: PluginEnv,
  key: DetailKey,
): Effect.Effect<RunDetail | null, never, Client> =>
  Effect.scoped(
    Effect.flatMap(detailStream(env, key), Stream.runHead).pipe(
      Effect.map(Option.getOrNull),
      Effect.orElseSucceed(() => null),
    ),
  );

/** How long a newly opened drawer waits for its first details; later reads take what there is. */
const FIRST_DETAIL_WAIT = "5 seconds";

/**
 * The open drawer's details, followed for as long as the caller's scope. A read for
 * another Run, or the same one shown differently, follows that instead.
 */
export const followRunDetail = Effect.fn("Lifecycle.followRunDetail")(function* (env: PluginEnv) {
  const scope = yield* Effect.scope;
  const services = yield* Effect.context<Client>();
  let open: {
    readonly key: string;
    readonly first: Deferred.Deferred<void>;
    readonly fiber: Fiber.Fiber<unknown>;
    latest: RunDetail | null;
  } | null = null;
  return (key: DetailKey | null): Effect.Effect<RunDetail | null> =>
    Effect.gen(function* () {
      if (key === null) {
        if (open !== null) yield* Fiber.interrupt(open.fiber);
        open = null;
        return null;
      }
      const showingKey = `${key.runId}|${key.tail}|${key.pages}`;
      if (open === null || open.key !== showingKey || key.refreshMr) {
        if (open !== null) yield* Fiber.interrupt(open.fiber);
        const first = yield* Deferred.make<void>();
        let refreshMr = key.refreshMr;
        const follow = Effect.scoped(
          Effect.flatMap(
            Effect.suspend(() => detailStream(env, { ...key, refreshMr })),
            (stream) =>
              Stream.runForEach(stream, (detail) =>
                Effect.sync(() => {
                  refreshMr = false;
                  if (open?.key === showingKey) open.latest = detail;
                }).pipe(Effect.andThen(Deferred.succeed(first, undefined))),
              ),
          ),
        ).pipe(
          Effect.catchCause(() => Effect.void),
          Effect.repeat(Schedule.spaced("1 second")),
        );
        const fiber = yield* Effect.forkIn(follow, scope);
        open = { key: showingKey, first, fiber, latest: null };
      }
      const showing = open;
      yield* Deferred.await(showing.first).pipe(Effect.timeoutOption(FIRST_DETAIL_WAIT));
      return showing.latest;
    }).pipe(Effect.provideContext(services));
});

/**
 * Registers what the modules as they are now allow and hands over what is outstanding,
 * then says where this Run is. A file that was missing and has been put back is picked up
 * by this rather than by restarting the host.
 */
export const recoverRun = (env: PluginEnv, runId: string): Effect.Effect<OpResult, never, Client> =>
  asksRun(env, runId, (client) =>
    client.recover().pipe(Effect.andThen(client.run({ runId }))),
  ).pipe(Effect.map(shown(runId)));

const shown =
  (runId: string) =>
  (answered: { readonly ok: true; readonly value: RunView | null } | Failure): OpResult => {
    if (!answered.ok) return answered;
    const view = answered.value;
    if (view === null) return err("run_not_found", `Run "${runId}" was not found.`, { run: runId });
    return {
      ok: true as const,
      data: { run: view },
      human: describeRun(view).join("\n"),
    };
  };

/**
 * Settles the question a Run is waiting on. The decision is named where the caller
 * knows which one, and null where it means "the one it is waiting on" — the host refuses
 * that where it is not exactly one, rather than choosing for anybody.
 */
export const answerRun = (
  env: PluginEnv,
  options: {
    readonly door: Door;
    readonly runId: string;
    readonly decision: string | null;
    readonly value: string;
    readonly request: string;
  },
): Effect.Effect<OpResult, never, Client> =>
  asksRun(
    env,
    options.runId,
    (client) =>
      client.answer({
        runId: options.runId,
        decision: options.decision,
        value: options.value,
        request: options.request,
      }),
    options.door,
  ).pipe(
    Effect.map((answered) =>
      answered.ok
        ? {
            ok: true as const,
            data: { run: options.runId, ...answered.value },
            human: withNotice(
              answered.value.fresh
                ? `Answered ${options.runId}: ${answered.value.decision} = ${answered.value.value}.`
                : `${options.runId} already had that answer to ${answered.value.decision}.`,
              answered.value.redacted,
            ),
          }
        : answered,
    ),
  );

/**
 * Sets or clears one control over one Run. A control the host recorded but could
 * not apply says so: work no host is running is held in intent, and calling that done
 * would be a confirmation nobody can stand behind.
 */
export const controlRun = (
  env: PluginEnv,
  options: {
    readonly door: Door;
    readonly runId: string;
    readonly control: "hold" | "stop";
    readonly set: boolean;
    readonly request: string;
    readonly reason?: string | undefined;
    readonly before?: string | undefined;
  },
): Effect.Effect<OpResult, never, Client> =>
  asksRun(
    env,
    options.runId,
    (client) =>
      client.control({
        runId: options.runId,
        control: options.control,
        set: options.set,
        request: options.request,
        reason: options.reason,
        before: options.before,
      }),
    options.door,
  ).pipe(Effect.map(controlled));

/** What a control's answer is, at the CLI, in chat and on the TUI board. */
export const controlled = (
  answered: { readonly ok: true; readonly value: typeof Controlled.Type } | Failure,
): OpResult => {
  if (!answered.ok) return answered;
  const done = answered.value;
  const left = leftSaid(done);
  if (left !== null)
    return err("operation_failed", left, { run: done.runId, left: [...done.left] });
  if (done.closed !== undefined) {
    return {
      ok: true as const,
      data: { run: done.runId, ...done },
      human:
        done.closed.length === 0
          ? `Nothing of ${done.runId} was running.`
          : `Closed ${done.closed.join(", ")}; ${done.runId} keeps the status it finished with.`,
    };
  }
  const what = `${done.set ? done.control : `un${done.control}`} ${done.runId}`;
  return {
    ok: true as const,
    data: { run: done.runId, ...done },
    human: done.applied
      ? `${capitalised(what)}.`
      : `Recorded ${what}, but nothing here is running it: ${done.detail}`,
  };
};

/** Picks a Run up again from any door: recovered first, then its stop cleared, so what wakes can run. */
export const resumeRun = (
  env: PluginEnv,
  options: { readonly door: Door; readonly runId: string; readonly request: string },
): Effect.Effect<OpResult, never, Client> =>
  asksRun(
    env,
    options.runId,
    (client) =>
      Effect.gen(function* () {
        const done = yield* client.resume({ runId: options.runId, request: options.request });
        if (!done.applied) return yield* new HostRefused({ reason: done.detail });
        return yield* client.run({ runId: options.runId });
      }),
    options.door,
  ).pipe(Effect.map(shown(options.runId)));

/** Amends a Run's Intent through the host, which refuses a change the Run cannot be held to. */
export const changeIntentRun = (
  env: PluginEnv,
  options: {
    readonly runId: string;
    readonly change: Change;
    readonly request: string;
    readonly door: Door;
    /** The Intent version the change was made on; the host refuses it on any other. */
    readonly expected?: number;
  },
) =>
  asksRun(
    env,
    options.runId,
    (client) =>
      client.changeIntent({
        runId: options.runId,
        change: options.change,
        propagate: false,
        request: options.request,
        ...(options.expected !== undefined && { expected: options.expected }),
      }),
    options.door,
  );

/** Names one of a Run's checks, or withdraws it, through the host. */
export const grantRun = (
  env: PluginEnv,
  options: {
    readonly runId: string;
    readonly name: string;
    readonly command: Omit<VerifySpec, "name"> | null;
    readonly request: string;
    readonly door: Door;
  },
): Effect.Effect<OpResult, never, Client> =>
  asksRun(
    env,
    options.runId,
    (client) =>
      client.grant({
        runId: options.runId,
        name: options.name,
        command: options.command,
        request: options.request,
      }),
    options.door,
  ).pipe(
    Effect.map((answered) =>
      answered.ok
        ? {
            ok: true as const,
            data: { run: options.runId, approved: answered.value },
            human: [`${options.runId}'s checks:`, renderApproved(answered.value)].join("\n"),
          }
        : answered,
    ),
  );

/**
 * Saves a Run's checks as its repository's own, by its checkout's remote, so
 * every Run started there later begins with them. The CLI and chat both come here.
 */
export const rememberChecks = Effect.fn("lifecycle.rememberChecks")(function* (
  env: PluginEnv,
  options: {
    readonly runId: string;
    /** Its worktree, then the checkout it was started for: a settled Run's worktree is gone. */
    readonly checkouts: ReadonlyArray<string>;
    readonly replace: boolean;
  },
) {
  const { runId } = options;
  const intent = yield* readIntent(runDir(env.stateDir, runId));
  if (intent === null) return err("invalid_state", `Run ${runId} has no Intent`);
  const fs = yield* FileSystem.FileSystem;
  const present: string[] = [];
  for (const dir of options.checkouts)
    if (yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false))) present.push(dir);
  if (present.length === 0)
    return err("invalid_state", `Run ${runId}'s checkout is gone, so its remote cannot be read`);
  const project = yield* projectHere(present[0]!, shell);
  if (project === null)
    return err("invalid_state", `Run ${runId}'s checkout has no remote to remember its checks by`);
  const specs = intent.authority.run_verification;
  if (specs.length === 0) return err("invalid_state", `Run ${runId} has no checks to remember`);
  const file = rememberedFile(env.userDir, project);
  if (file === null)
    return err("invalid_state", `${project} is not a remote a file can be named by`);
  if (!options.replace && (yield* fs.exists(file)))
    return err(
      "invalid_state",
      `${file} already holds this repository's checks; overwrite it with replace (--replace)`,
    );
  yield* fs.makeDirectory(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  yield* fs.writeFileString(file, `${encodeApprovedFile(specs)}\n`);
  const result: OpResult = {
    ok: true,
    data: { file, project, remembered: specs },
    human: [`Runs started in ${project} will begin with:`, renderApproved(specs), `(${file})`].join(
      "\n",
    ),
  };
  return result;
});

export const withdrawNoteRun = (
  env: PluginEnv,
  options: { runId: string; note: string; request: string; door: Door },
): Effect.Effect<OpResult, never, Client> =>
  asksRun(
    env,
    options.runId,
    (client) =>
      client.withdrawNote({ runId: options.runId, note: options.note, request: options.request }),
    options.door,
  ).pipe(
    Effect.map((done) =>
      done.ok
        ? { ok: true as const, data: { removed: true }, human: `Removed note ${options.note}.` }
        : done,
    ),
  );

/** Says something of a human's to the agent a Run has, through the host. */
export const steerRun = (
  env: PluginEnv,
  options: {
    readonly runId: string;
    readonly text: string;
    readonly request: string;
    readonly step?: string;
    readonly to?: string;
    readonly operation?: string;
    readonly agent?: string;
    readonly mode?: "boundary" | "now" | "interrupt";
    readonly attachments?: ReadonlyArray<string> | undefined;
    readonly door: Door;
  },
): Effect.Effect<OpResult, never, Client> =>
  asksRun(
    env,
    options.runId,
    (client) =>
      Effect.gen(function* () {
        const sent = yield* client.steer({
          step: options.step,
          runId: options.runId,
          text: options.text,
          request: options.request,
          to: options.to,
          operation: options.operation,
          agent: options.agent,
          mode: options.mode,
          attachments: options.attachments,
        });
        // Only an agent that is gone is carried on elsewhere: a refused send to a live one may
        // still be working the text, and a follow-up beside it would be a second copy.
        const route =
          sent.gone === true && sent.finished === true
            ? yield* followUpRoute(client, options)
            : null;
        return { sent, route };
      }),
    options.door,
  ).pipe(
    Effect.map((answered) => {
      if (!answered.ok) return answered;
      const { sent, route } = answered.value;
      const data = { run: options.runId, ...sent };
      if (sent.delivered)
        return {
          ok: true as const,
          data,
          human: withNotice(
            [
              sent.note === undefined
                ? deliveredLine(sent)
                : `Note ${sent.note} kept for Step ${options.step}.`,
              sent.kept,
            ]
              .filter((line) => line !== undefined)
              .join(" "),
            sent.redacted,
          ),
        };
      // A receipt that read as delivered when nothing was sent is the failure ADR-0041 ends.
      const why = `Nothing was delivered: ${sent.detail || "no agent to tell"}.`;
      return err(
        "operation_failed",
        withNotice(route === null ? why : `${why} ${route}`, sent.redacted, " "),
        data,
      );
    }),
  );

/**
 * A delivery as a front door says it: observed and how, or sent and not seen taken, with
 * where to look. Never "told" on the strength of a send alone.
 */
export const deliveredLine = (sent: {
  readonly agent: string;
  readonly observed?: boolean;
  readonly how?: string;
  readonly pane?: string;
}): string =>
  sent.observed === true
    ? `Delivered to ${sent.agent} (observed: ${sent.how ?? "taken"}).`
    : `Sent to ${sent.agent}, not observed. Go to pane: herdr agent focus ${sent.agent}${sent.pane === undefined ? "" : ` (pane ${sent.pane})`}.`;

/**
 * What carries a request on to a finished Run whose agent is gone: its follow-up offer
 * with the message as its input, else a new Run on its branch. Collie starts neither.
 */
const followUpRoute = (
  client: HostClient,
  options: { readonly runId: string; readonly text: string },
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    const view = yield* client.run({ runId: options.runId });
    if (view === null) return null;
    const offers = yield* client
      .offers({ runId: options.runId })
      .pipe(Effect.orElseSucceed((): ReadonlyArray<OfferView> => []));
    const offered = offers.find((one) => one.kind === "follow-up");
    if (offered !== undefined)
      return `${options.runId} has finished and its agent is gone: carry this on with its follow-up offer "${offered.id}", giving the message as its input.`;
    return `${options.runId} has finished and its agent is gone, and it offers no follow-up: start a new Run on ${view.branch === null ? "its branch" : `its branch ${view.branch}`}.`;
  }).pipe(Effect.orElseSucceed(() => null));

/** A carried-out proposal as a front door prints it: one line per action, failing on the first that did not apply. */
export const carriedResult = ({ proposal, results }: ProposalCarried): OpResult => {
  const message = results
    .map((r) => `${r.index} ${r.kind}: ${r.state}${r.note ? ` — ${r.note}` : ""}`)
    .join("\n");
  if (results.some((r) => r.state !== "applied")) {
    const changed = results.some((r) => r.state === "applied" && r.kind !== "none");
    // needs_input is retryable without a receipt only when nothing has happened yet.
    const code =
      results.at(-1)?.kind === "ask_human" && !changed ? "needs_input" : "operation_failed";
    return err(code, message, { proposal, results: results.map((r) => ({ ...r })) });
  }
  return { ok: true as const, data: { proposal, results }, human: message };
};

const capitalised = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** A Run as a human reads one: what it is, where its module is, and what is wrong. */
export const describeRun = (view: RunView): ReadonlyArray<string> => [
  `${view.runId}\t${statusOf(view)}\t${view.workflow}`,
  view.entry,
  `proves ${view.outcome}`,
  ...(view.parent === null ? [] : [`part of ${view.parent}`]),
  ...(view.controls.length === 0 ? [] : [`under ${view.controls.join(", ")}`]),
  ...describeWaiting(view),
  ...(view.diagnostic === null ? [] : [view.diagnostic]),
  ...(view.parked === null ? [] : [view.parked]),
  ...(view.awaiting === null ? [] : [awaitingLine(view.awaiting)]),
];

/** The questions a Run is still waiting on, with what each will take. */
export const describeWaiting = (view: RunView): ReadonlyArray<string> =>
  view.waiting
    .filter((one) => one.answer === null)
    .map(
      (one) =>
        `waiting on "${one.name}": ${one.prompt}${one.options.length === 0 ? "" : ` (${one.options.join(" | ")})`}`,
    );

/** The one word a listing gives a Run, and the sentence behind it where there is one. */
export const statusOf = (view: RunView): string => {
  switch (view.status.status) {
    case "complete":
      return `complete: ${resultText(view.status.value)}`;
    case "failed":
      return `failed: ${view.status.reason}`;
    default:
      return view.diagnostic === null ? view.status.status : "waiting for its module";
  }
};

export { resultText } from "./report";

/** Whether the engine can still change this Run's state. */
export const isSettled = (view: RunView): boolean =>
  view.status.status === "complete" || view.status.status === "failed";

/**
 * What a Run offers to do next. The host answers, because only it holds the module
 * that declared them: an offer is the author's own eligibility asked of the facts as they
 * are now, and a Run whose module has gone is readable with its offers refused by name.
 */
export const showOffers = (env: PluginEnv, runId: string): Effect.Effect<OpResult, never, Client> =>
  asksRun(env, runId, (client) => client.offers({ runId })).pipe(
    Effect.map((answered) =>
      answered.ok
        ? {
            ok: true as const,
            data: { run: runId, offers: answered.value.map((offer) => ({ ...offer })) },
            human:
              answered.value.length === 0 ? "Nothing is offered." : describeOffers(answered.value),
          }
        : answered,
    ),
  );

/** The offers themselves, for a caller that has to choose one rather than print them. */
export const offersOf = (
  env: PluginEnv,
  runId: string,
): Effect.Effect<ReadonlyArray<OfferView> | Failure, never, Client> =>
  asksRun(env, runId, (client) => client.offers({ runId })).pipe(
    Effect.map((answered) => (answered.ok ? answered.value : answered)),
  );

const describeOffers = (offers: ReadonlyArray<OfferView>): string =>
  offers
    .map((offer) => {
      const why = offer.unavailable === null ? "" : ` — unavailable: ${offer.unavailable}`;
      return `${offer.primary ? "▸" : " "} ${offer.id}  ${offer.title} (${offer.workflow})${why}`;
    })
    .join("\n");

/** Carries out one of them, under the caller's own claim so a retry is one Run. */
export const invokeOffer = (
  env: PluginEnv,
  options: {
    readonly door: Door;
    readonly runId: string;
    readonly offer: string;
    readonly input: Readonly<Record<string, Schema.Json>>;
    readonly request: string;
    readonly attachments?: ReadonlyArray<string> | undefined;
  },
): Effect.Effect<OpResult, never, Client> =>
  asksRun(
    env,
    options.runId,
    (client) =>
      client.invoke({
        runId: options.runId,
        offer: options.offer,
        input: options.input,
        request: options.request,
        attachments: options.attachments,
      }),
    options.door,
  ).pipe(
    Effect.map((answered) =>
      answered.ok
        ? {
            ok: true as const,
            data: {
              run: answered.value.runId,
              from: options.runId,
              offer: options.offer,
              ...redactedField(answered.value.redacted),
            },
            human: withNotice(
              `Started run ${answered.value.runId} from ${options.runId}'s "${options.offer}".`,
              answered.value.redacted,
            ),
          }
        : answered,
    ),
  );

/** An offer taken with its arguments as text, each read as the offer declares it. */
export const invokeTypedOffer = (
  env: PluginEnv,
  options: Omit<Parameters<typeof invokeOffer>[1], "input"> & {
    readonly input: Readonly<Record<string, string>>;
  },
): Effect.Effect<OpResult, never, Client> =>
  Effect.flatMap(offersOf(env, options.runId), (listed) => {
    const offer = "ok" in listed ? undefined : listed.find((one) => one.id === options.offer);
    return invokeOffer(env, {
      ...options,
      input: givenOfferInput(offer?.arguments ?? null, options.input),
    });
  });

/** A yes to a proposal, carried out by the host under the front door asking. */
export const confirmProposed = (
  env: PluginEnv,
  options: {
    readonly door: Door;
    readonly proposal: string;
    readonly hash: string;
    readonly request: string;
  },
): Effect.Effect<OpResult, never, Client> =>
  asks(
    env,
    (client) =>
      client.confirm({
        proposal: options.proposal,
        hash: options.hash,
        request: options.request,
      }),
    options.door,
  ).pipe(Effect.map((answered) => (answered.ok ? carriedResult(answered.value) : answered)));

export const declineProposed = (
  env: PluginEnv,
  options: {
    readonly door: Door;
    readonly proposal: string;
    readonly hash: string;
    readonly request: string;
  },
): Effect.Effect<OpResult, never, Client> =>
  asks(
    env,
    (client) =>
      client.decline({ proposal: options.proposal, hash: options.hash, request: options.request }),
    options.door,
  ).pipe(
    Effect.map((answered) =>
      answered.ok
        ? {
            ok: true as const,
            data: { declined: options.proposal },
            human: `Declined ${options.proposal}.`,
          }
        : answered,
    ),
  );

/** What became of a Run's work, written by the host; the line it wrote, or why not. */
export const disposeRun = (
  env: PluginEnv,
  options: {
    readonly door: Door;
    readonly runId: string;
    readonly kind: Disposition["kind"];
    readonly ref: string;
    readonly note: string | null;
    readonly request: string;
  },
): Effect.Effect<{ readonly ok: true; readonly value: Disposition } | Failure, never, Client> =>
  asksRun(
    env,
    options.runId,
    (client) =>
      client.dispose({
        runId: options.runId,
        kind: options.kind,
        ref: options.ref,
        note: options.note,
        request: options.request,
      }),
    options.door,
  );

/** A finished Run opened or acknowledged, recorded once by its host; the first line, or why not. */
export const seeRun = (
  env: PluginEnv,
  options: { readonly door: Door; readonly runId: string; readonly request: string },
): Effect.Effect<{ readonly ok: true; readonly value: Seen } | Failure, never, Client> =>
  asksRun(
    env,
    options.runId,
    (client) => client.seen({ runId: options.runId, request: options.request }),
    options.door,
  );

/** One of Collie's settings, set on this Machine through its host as an edit made now. */
export const setSharedSetting = (
  env: PluginEnv,
  options: {
    readonly door: Door;
    readonly key: string;
    readonly value: SettingValue | null;
    readonly at: string;
    readonly request: string;
  },
) =>
  asks(
    env,
    (client) =>
      client.setSettings({
        settings: [{ key: options.key, value: options.value, at: options.at }],
        request: options.request,
      }),
    options.door,
  );

/** This Machine's Usage readings, as its host last read them. */
export const usageReadings = (env: PluginEnv, door: Door) =>
  asks(env, (client) => client.usage(), door);

/** What a cleanup sweep would remove now, and what is kept and why. */
export const cleanupListing = (env: PluginEnv, door: Door) =>
  asks(env, (client) => client.cleanup(), door);

/** This Machine's Schedules, as its host keeps them. */
export const scheduleListing = (env: PluginEnv, door: Door) =>
  asks(env, (client) => client.schedules(), door);

/**
 * The Schedules of the Machine `--machine` names, or of this Machine and every paired one,
 * with each peer that did not answer named as away, as `flockRuns` lists Runs.
 */
export const flockSchedules = Effect.fn("Lifecycle.flockSchedules")(function* (
  env: PluginEnv,
  door: Door,
) {
  const local = yield* scheduleListing(env, door);
  if (!local.ok) return local;
  const schedules = [...local.value.schedules];
  const machines: Array<{
    readonly machine: string;
    readonly state: "away";
    readonly note: string;
  }> = [];
  if (env.machine === undefined)
    for (const peer of yield* peersOf(env.stateDir)) {
      const read = yield* Effect.scoped(
        reach(env, peer.name, door).pipe(
          Effect.flatMap((client) => client.schedules()),
          Effect.result,
        ),
      );
      if (read._tag === "Success") schedules.push(...read.success.schedules);
      else
        machines.push({
          machine: peer.name,
          state: "away",
          note: refusal(read.failure).error.message,
        });
    }
  return { ok: true as const, value: { machine: local.value.machine, schedules, machines } };
});

/**
 * One Machine's Schedule operations for the shared move sequence: this Machine's host
 * where `machine` is null, a peer's through its relay otherwise. Each refusal is also
 * handed to `refused`, so the caller can say it as the front doors do.
 */
export const scheduleDoorOn = Effect.fn("Lifecycle.scheduleDoorOn")(function* (
  env: PluginEnv,
  machine: string | null,
  door: Door,
  refused: (failure: Failure) => void,
) {
  const context = yield* Effect.context<Client>();
  const ask = <A>(question: (client: HostClient) => Effect.Effect<A, HostFailure>) =>
    Effect.scoped(reach(env, machine, door).pipe(Effect.flatMap(question))).pipe(
      Effect.mapError((cause) => refusal(cause)),
      Effect.tapError((failure) => Effect.sync(() => refused(failure))),
      Effect.mapError((failure) => ({ reason: failure.error.message })),
      Effect.provideContext(context),
    );
  return {
    name: machine ?? machineName(),
    schedules: () => ask((client) => client.schedules()),
    changeSchedule: (asked: { readonly change: ScheduleChange; readonly request: string }) =>
      ask((client) => client.changeSchedule(asked)),
  } satisfies ScheduleDoor;
});

/** Adds, pauses, resumes or removes one of this Machine's Schedules, under the caller's request. */
export const changeSchedule = (
  env: PluginEnv,
  options: { readonly door: Door; readonly change: ScheduleChange; readonly request: string },
) =>
  asks(
    env,
    (client) => client.changeSchedule({ change: options.change, request: options.request }),
    options.door,
  );

/** Sweeps now, through the host, under the caller's request. */
export const sweepNow = (
  env: PluginEnv,
  options: { readonly door: Door; readonly request: string },
) => asks(env, (client) => client.sweep({ request: options.request }), options.door);

/** Free words about one Run, which the host has the evaluator turn into what to do. */
export const steerAbout = (
  env: PluginEnv,
  options: {
    readonly door: Door;
    readonly runId: string;
    readonly text: string;
    readonly from: string | null;
    readonly dryRun: boolean;
    readonly request: string;
  },
): Effect.Effect<OpResult, never, Client> =>
  asksRun(
    env,
    options.runId,
    (client) =>
      client.steerAbout({
        runId: options.runId,
        text: options.text,
        from: options.from,
        dryRun: options.dryRun,
        request: options.request,
      }),
    options.door,
  ).pipe(Effect.map((answered) => (answered.ok ? opResultOf(answered.value) : answered)));

/** An outcome the host sent back, as the result every front door prints. */
const opResultOf = (said: SteerOutcome): OpResult => {
  if (said.ok)
    return {
      ok: true,
      data: Predicate.isObject(said.data) ? said.data : { said: said.data },
      human: said.human,
    };
  const failed = Schema.decodeUnknownOption(ExpectedError)({
    code: said.code,
    message: said.human,
    details: said.data,
  });
  return failed._tag === "Some"
    ? { ok: false, error: failed.value }
    : err("operation_failed", said.human);
};

/** Actions chat was asked for, which the host records as a proposal and carries out. */
export const proposeActions = (
  env: PluginEnv,
  options: {
    readonly door: Door;
    readonly herd: string | null;
    readonly interpretation: string;
    readonly actions: ReadonlyArray<Action>;
    readonly request: string;
  },
): Effect.Effect<OpResult, never, Client> =>
  asks(
    env,
    (client) =>
      client.propose({
        herd: options.herd,
        interpretation: options.interpretation,
        actions: options.actions,
        request: options.request,
      }),
    options.door,
  ).pipe(Effect.map((answered) => (answered.ok ? opResultOf(answered.value) : answered)));

/** A conversation's pending News, settled for it by the host. */
export const settleNewsFor = (
  env: PluginEnv,
  options: {
    readonly door: Door;
    readonly herd: string | null;
    readonly conversation: string;
    readonly as: typeof NewsReceipt.Type;
    readonly request: string;
  },
) =>
  asks(
    env,
    (client) =>
      client.news({
        herd: options.herd,
        conversation: options.conversation,
        as: options.as,
        request: options.request,
      }),
    options.door,
  );

/** The board's own actions, asked for by name and carried out by the host. */
export const actAsked = (
  env: PluginEnv,
  options: {
    readonly door: Door;
    readonly actions: ReadonlyArray<Action>;
    readonly request: string;
  },
): Effect.Effect<ReadonlyArray<ActionResult>, never, Client> =>
  (options.actions.length === 1 &&
  options.actions[0]!.kind === "start" &&
  options.actions[0]!.machine !== undefined
    ? asks(
        { ...env, machine: options.actions[0]!.machine },
        (client) => client.act({ actions: options.actions, request: options.request }),
        options.door,
      )
    : options.actions.length === 1 && "run" in options.actions[0]!
      ? asksRun(
          env,
          options.actions[0]!.run,
          (client) => client.act({ actions: options.actions, request: options.request }),
          options.door,
        )
      : asks(
          env,
          (client) => client.act({ actions: options.actions, request: options.request }),
          options.door,
        )
  ).pipe(
    Effect.map((answered) =>
      answered.ok
        ? answered.value
        : options.actions.slice(0, 1).map((action) => ({
            kind: action.kind,
            state: "failed",
            note: answered.error.message,
          })),
    ),
  );

/** A proposal step nobody can account for, settled as what actually happened. */
export const reconcileProposed = (
  env: PluginEnv,
  options: {
    readonly door: Door;
    readonly proposal: string;
    readonly index: number;
    readonly as: "applied" | "not-applied";
    readonly request: string;
  },
): Effect.Effect<OpResult, never, Client> =>
  asks(
    env,
    (client) =>
      client.reconcile({
        proposal: options.proposal,
        index: options.index,
        as: options.as,
        request: options.request,
      }),
    options.door,
  ).pipe(
    Effect.map((answered): OpResult =>
      answered.ok
        ? {
            ok: true,
            data: { proposal: options.proposal, index: options.index, as: options.as },
            human: `Settled action ${options.index} as ${options.as}.`,
          }
        : answered,
    ),
  );

/** A message nobody knows reached its agent, settled as what actually happened. */
export const reconcileDelivered = (
  env: PluginEnv,
  options: {
    readonly door: Door;
    readonly runId: string;
    readonly delivery: string;
    readonly as: "sent" | "not-sent";
    readonly request: string;
  },
): Effect.Effect<OpResult, never, Client> =>
  asksRun(
    env,
    options.runId,
    (client) =>
      client.settleDelivery({
        runId: options.runId,
        delivery: options.delivery,
        as: options.as,
        request: options.request,
      }),
    options.door,
  ).pipe(
    Effect.map((answered): OpResult =>
      answered.ok
        ? {
            ok: true,
            data: { delivery: answered.value },
            human: `Reconciled ${options.delivery} as ${options.as}.`,
          }
        : answered,
    ),
  );

/** A child Run on a finished one, carrying on with what is left in these words. */
export const followUpRun = (
  env: PluginEnv,
  options: {
    readonly door: Door;
    readonly runId: string;
    readonly text: string;
    readonly request: string;
    readonly attachments?: ReadonlyArray<string> | undefined;
  },
): Effect.Effect<OpResult, never, Client> =>
  asksRun(
    env,
    options.runId,
    (client) =>
      client.followUp({
        runId: options.runId,
        text: options.text,
        request: options.request,
        attachments: options.attachments,
      }),
    options.door,
  ).pipe(
    Effect.map((answered) =>
      answered.ok
        ? {
            ok: true as const,
            data: {
              run: answered.value.runId,
              from: options.runId,
              ...redactedField(answered.value.redacted),
            },
            human: withNotice(
              `Started run ${answered.value.runId} to follow up ${options.runId}.`,
              answered.value.redacted,
            ),
          }
        : answered,
    ),
  );

/** Replaces the host that owns `dir` with this install's, as `collie host restart` and the herdr action do. */
export const restartHostAt = (dir: string): Effect.Effect<OpResult, never, Client> =>
  restartHost(dir).pipe(
    Effect.map((restarted): OpResult => ({
      ok: true,
      data: { dir, ...restarted },
      human: restartSaid(dir, restarted),
    })),
    Effect.catch((cause) => Effect.succeed(refusal(cause))),
  );

/** This Machine's peers, with the standings its host keeps. */
export const machineList = (env: PluginEnv) => asks(env, (client) => client.peers());

/**
 * Opens this computer's SSH connection to herdr's machine `name`, where none is open, and
 * wakes this host's link to it. What ssh says goes to `said`, where the person who has to
 * answer a login is.
 */
export const machineConnect = (
  env: PluginEnv,
  name: string,
  said: (text: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const opened = yield* openAndWake(env, name, said).pipe(Effect.result);
    if (opened._tag === "Failure") return refusal(opened.failure);
    return {
      ok: true as const,
      value: { machine: name, ...opened.success },
      machine: null,
    } satisfies Answered<unknown>;
  });

/** Pairs this Machine with the installation asking, which `pairWith` runs over SSH. */
export const inviteFrom = (
  env: PluginEnv,
  asker: { readonly installation: string; readonly name: string; readonly address: string | null },
) =>
  asks(env, (client) =>
    client.invite({ for: asker.installation, name: asker.name, address: asker.address }),
  );

export const followCheckLog = Effect.fn("Lifecycle.followCheckLog")(function* (
  env: PluginEnv,
  runId: string,
) {
  const found = yield* asksRun(env, runId, () => Effect.void);
  const client = yield* reach(env, found.ok ? found.machine : (env.machine ?? null));
  return client.checkLog({ runId });
});

export const verifyRun = Effect.fn("Lifecycle.verifyRun")(function* (
  env: PluginEnv,
  request: {
    runId: string;
    name: string;
    executable: string;
    argv: ReadonlyArray<string>;
    cwd?: string;
    expect: "pass" | "fail";
  },
  door: Door,
) {
  const found = yield* asksRun(env, request.runId, () => Effect.void, door);
  if (!found.ok) return found;
  const client = yield* reach(env, found.machine, door);
  return { ok: true as const, events: client.verify(request) };
});

/**
 * The report over every Run this Machine's host has, for whichever door asks: a Run
 * whose metrics cannot be read fails it, and one whose records cannot be read is
 * measured without them.
 */
export const reportFor = Effect.fn("Report.for")(function* (env: PluginEnv, since: string | null) {
  const hosted = yield* runViews(env, null);
  const metrics = new Map<string, Metrics>();
  const recorded = new Map<string, Recorded>();
  for (const view of hosted.runs) {
    const asked = yield* asksRun(env, view.runId, (client) =>
      Effect.all({
        metrics: client.runMetrics({ runId: view.runId }),
        records: client
          .runOutcomes({ runId: view.runId })
          .pipe(Effect.orElseSucceed((): OutcomeRecords | null => null)),
      }),
    );
    if (!asked.ok) return asked;
    metrics.set(view.runId, metricsOf(asked.value.metrics, view.created));
    recorded.set(view.runId, asked.value);
  }
  return {
    ok: true as const,
    report: reportOf(hosted.runs, metrics, since, recorded),
    unreadable: hosted.unreadable,
  };
});
