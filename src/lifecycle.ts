import type { Launched } from "./launches";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import { awaitingLine } from "./awaiting";
import { cursorToken, newerFirst, pageToken, restarted } from "./run-list";
import type { RunListAsked } from "./run-list";
import { redactedField, withNotice } from "./redact";
import type { SettingValue } from "./settings";
import { reportOf, resultText } from "./report";
import type { Recorded } from "./report";
import { metricsOf } from "./metrics";
import { descendantsOf, usageOf, withChildren } from "./usage-ledger-model";
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
  Result,
  Schedule,
  Schema,
  Stream,
} from "effect";
import type { Scope } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type * as RpcClientError from "effect/rpc/RpcClientError";
import type { PluginEnv } from "./env";
import type { Prepare } from "./verify-model";
import { savedModules } from "./discovery";
import type { Fault, Found } from "./discovery";
import { LAUNCH_DOORS, reachKey, reachOf } from "./reach";
import {
  connect,
  connectPeer,
  followVerify,
  frontDoor,
  restartHost,
  restartSaid,
  socketOf,
} from "./host";
import type { HostClient, RunPageAnswer, HostUnavailable, HostVersionMismatch } from "./host";
import { Herdr, herdrFailureReason } from "./herdr";
import type { HerdrError } from "./herdr";
import { viaCommand } from "./ssh-argv";
import { machineName, pairWith, peersOf } from "./peers";
import { artefactOwner, awayFrom, searchDoorOf, searchFlock } from "./artefact-search";
import type { FlockSearch } from "./artefact-search";
import { openConnection } from "./ssh-connection";
import { MachineUnreachable } from "./peers-model";
import type { HerdrMachine, RelayHeader } from "./peers-model";
import {
  sortBoard,
  leftSaid,
  FrontDoor,
  HostRefused,
  recordIn,
  givenOfferInput,
  holdPath,
  holdReason,
  solutionTitle,
} from "./board-model";
import type {
  BoardMessage,
  BoardSnapshot,
  RunDetail,
  Controlled,
  Disposition,
  Seen,
  ProposalCarried,
  ProposalRefused,
  RequestConflict,
  ActionResult,
  SteerOutcome,
  TaskView,
  NewsReceipt,
  Metrics,
} from "./board-model";
import type { Action } from "./actions";
import { HOLD, NEEDS_INPUT, REFUSED_INPUT, runDir, terminalStatus } from "./engine";
import type { Given, OpenDecision, RunView } from "./engine";
import type { OfferView, Declaration, StaleAct } from "./board-model";
import { err, ExpectedError, HostUnread, newRequestId, taskFor } from "./operations";
import type { Failure, OpResult } from "./operations";
import { nowIso } from "./time";
import { voiceOf } from "./proposals";
import type { Asker, ProposalLine } from "./proposals";
import type { TaskChoice, TaskRecord } from "./task";
import { encodeApprovedFile, rememberedFile, renderApproved } from "./verify-spec";
import type { VerifySpec } from "./verify-spec";
import { projectHere, shell } from "./mr";
import { defaultsPath, readDefaults, readIntent } from "./intent";
import type { Change, IntentSeed } from "./intent";
import { scopeFor, scopeKey } from "./registry";
import type { AgentEntry } from "./registry";
import { PROJECTS_ROOT_OPTION, projectsRoot } from "./projects";
import { reason } from "./naming";
import { attachmentRefusal } from "./attachments";
import { isUnanswered } from "./store";
import type { ScheduleChange } from "./schedule-model";
import type { ScheduleDoor } from "./schedule-move";

export { savedModules } from "./discovery";

export const neededInputs: (entry: Found, given: Given) => Failure | null = (entry, given) => {
  const missing = Arr.filter(
    entry.inputs,
    (field) =>
      field.required &&
      given.text[field.name] === undefined &&
      given.json[field.name] === undefined,
  );
  if (missing.length === 0) {
    return null;
  }
  return err(
    "needs_input",
    `${entry.id} needs ${Arr.join(
      Arr.map(missing, (field) => `"${field.name}"`),
      ", ",
    )}.`,
    {
      workflow: entry.id,
      path: entry.path,
      inputs: Arr.map(missing, (field) => ({
        name: field.name,
        question: `${entry.title} — ${field.name}?`,
        schema: field.schema,
        limits: [...field.limits],
      })),
    },
  );
};

export const moduleFor: (
  env: PluginEnv,
  id: string,
) => Effect.Effect<Found | Fault | null, never, FileSystem.FileSystem> = (env, id) =>
  savedModules(env).pipe(
    Effect.map(
      (found) =>
        Option.getOrUndefined(Arr.findFirst(found.entries, (entry) => entry.id === id)) ??
        Option.getOrUndefined(Arr.findFirst(found.problems, (problem) => problem.id === id)) ??
        null,
    ),
  );

// WARNING: Reads the database, not a host: a machine with no Runs must not start one to be told so.
export const anyRuns: (env: PluginEnv) => Effect.Effect<boolean, never, FileSystem.FileSystem> = (
  env,
) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.exists(`${env.stateDir}/host.db`)),
    Effect.orElseSucceed(() => false),
  );

type HostFailure =
  | HostRefused
  | StaleAct
  | ProposalRefused
  | RequestConflict
  | HostUnavailable
  | HostVersionMismatch
  | MachineUnreachable
  | RpcClientError.RpcClientError;

type Client = FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner;

export const refusal: (cause: HostFailure) => Failure = (cause) => {
  const failure = refused(cause);
  return cause._tag === "HostUnavailable" ||
    cause._tag === "MachineUnreachable" ||
    cause._tag === "RpcClientError"
    ? { ...failure, unreached: true }
    : failure;
};

const refused: (cause: HostFailure) => Failure = (cause) => {
  switch (cause._tag) {
    case "HostRefused":
      // WARNING: Input refusals are exit 2, not exit 1.
      if (pipe_(cause.reason, Str.startsWith(`${REFUSED_INPUT}:`))) {
        return err(
          "invalid_input",
          Str.trim(pipe_(cause.reason, Str.slice(REFUSED_INPUT.length + 1))),
        );
      }
      if (pipe_(cause.reason, Str.startsWith(`${NEEDS_INPUT}:`))) {
        return err("needs_input", Str.trim(pipe_(cause.reason, Str.slice(NEEDS_INPUT.length + 1))));
      }
      return pipe_(cause.reason, Str.startsWith("invalid_state:"))
        ? err("invalid_state", Str.trim(pipe_(cause.reason, Str.slice("invalid_state:".length))))
        : err("operation_failed", cause.reason);
    case "ProposalRefused":
      return err("invalid_input", cause.detail, { reason: cause.refused });
    case "StaleAct":
      return err("invalid_state", cause.reason, { run: cause.run, step: cause.step });
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

export type Door = FrontDoor | Asker;

const isFrontDoor = Schema.is(FrontDoor);

const declaring: (door: Door, stamp?: string) => Declaration = (door, stamp?) => {
  if (isFrontDoor(door)) {
    return { frontDoor: door };
  }
  let declared: Declaration = { frontDoor: door.origin, ...voiceOf(door) };
  if (door.from !== undefined) {
    declared = { ...declared, from: door.from };
  }
  if (stamp !== undefined) {
    declared = { ...declared, stamp };
  }
  return declared;
};

const toStderr = (text: string) => Effect.sync(() => void process.stderr.write(text));

// WARNING: A host's own jobs never pair.
export const ensurePaired = Effect.fn("Lifecycle.ensurePaired")(function* (
  env: PluginEnv,
  name: string,
) {
  if (Arr.some(yield* peersOf(env.stateDir), (peer) => peer.name === name)) {
    return;
  }
  const machine = Option.getOrUndefined(
    Arr.findFirst(yield* herdrMachines(env), (one) => one.label === name),
  );
  if (machine === undefined) {
    return yield* notListed(name);
  }
  if (env.pairs !== true) {
    return yield* new HostRefused({
      reason: `invalid_state: ${name} is not paired yet; a command in a terminal pairs it`,
    });
  }
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
    reason: `${REFUSED_INPUT}: no Machine "${name}": this Machine's list names none by that name`,
  });

const coreRoster = (env: PluginEnv) =>
  new Herdr(env).machineList().pipe(Effect.provide(Path.layer));

const herdrMachines = (env: PluginEnv) =>
  coreRoster(env).pipe(
    Effect.orElseSucceed(() => {
      const returned: ReadonlyArray<HerdrMachine> = [];
      return returned;
    }),
  );

const named = (machines: ReadonlyArray<HerdrMachine>, name: string) =>
  Option.getOrUndefined(Arr.findFirst(machines, (one) => one.label === name));

const coreRefused = (name: string) => (cause: HerdrError) =>
  new HostRefused({ reason: `core did not take ${name}: ${cause.detail || cause.message}` });

const addToCore = (env: PluginEnv, name: string, target: string, path: string) =>
  new Herdr(env)
    .machineAdd(name, viaCommand(path, target))
    .pipe(Effect.mapError(coreRefused(name)), Effect.provide(Path.layer));

const openAndWake = (
  env: PluginEnv,
  name: string,
  said: (text: string) => Effect.Effect<void>,
  target?: string,
) =>
  Effect.gen(function* () {
    const listed = named(yield* herdrMachines(env), name);
    const paired =
      listed === undefined && Arr.some(yield* peersOf(env.stateDir), (peer) => peer.name === name);
    // WARNING: A pairing core does not keep has no saved target: ssh resolves its name.
    const machine =
      listed ??
      (target !== undefined || paired ? { label: name, target: target ?? name } : undefined);
    if (machine === undefined) {
      return yield* notListed(name);
    }
    const opened = yield* openConnection(env.stateDir, machine, { said });
    let added = false;
    if (listed !== undefined) {
      yield* new Herdr(env)
        .machineDial(name)
        .pipe(Effect.mapError(coreRefused(name)), Effect.provide(Path.layer));
    } else if (paired) {
      yield* addToCore(env, name, machine.target, opened.path);
      added = true;
    }
    yield* asks({ ...env, machine: undefined }, (client) => client.wake({ machine: name }));
    return { ...opened, added };
  }).pipe(Effect.provide(Path.layer));

export const riding: <A, E, R>(
  env: PluginEnv,
  name: string,
  reaching: Effect.Effect<A, E | MachineUnreachable, R>,
) => Effect.Effect<A, E | MachineUnreachable | HostRefused, R | Client> = <A, E, R>(
  env: PluginEnv,
  name: string,
  reaching: Effect.Effect<A, E | MachineUnreachable, R>,
) =>
  reaching.pipe(
    Effect.catchIf(
      (cause): cause is MachineUnreachable =>
        env.pairs === true &&
        Schema.is(MachineUnreachable)(cause) &&
        cause.waits === "ssh_connection",
      () => openAndWake(env, name, toStderr).pipe(Effect.andThen(reaching)),
    ),
  );

const relayHeader: (door: Door | undefined, stamp?: string) => RelayHeader = (door, stamp?) => {
  let header: RelayHeader = {
    as: door === undefined ? "cli" : isFrontDoor(door) ? door : door.origin,
    client: machineName(),
  };
  if (
    door !== undefined &&
    !isFrontDoor(door) &&
    door.from?.run !== undefined &&
    door.from.agent !== undefined
  ) {
    header = { ...header, sender: { run: door.from.run, agent: door.from.agent } };
  }
  if (header.as === "host" && stamp !== undefined) {
    header = { ...header, stamp };
  }
  return header;
};

const reach: (
  env: PluginEnv,
  machine: string | null,
  door?: Door,
) => Effect.Effect<HostClient, HostFailure, Client | Scope.Scope> = (env, machine, door?) =>
  machine === null
    ? connect(env.stateDir).pipe(
        Effect.tap((client) =>
          door === undefined ? Effect.void : client.declare(declaring(door, env.hostStamp)),
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

type Answered<A> = { readonly ok: true; readonly value: A; readonly machine: string | null };

export const asks: <A>(
  env: PluginEnv,
  question: (client: HostClient) => Effect.Effect<A, HostFailure>,
  door?: Door,
) => Effect.Effect<Answered<A> | Failure, never, Client> = <A>(
  env: PluginEnv,
  question: (client: HostClient) => Effect.Effect<A, HostFailure>,
  door?: Door,
) =>
  Effect.scoped(
    reach(env, env.machine ?? null, door).pipe(
      Effect.flatMap(question),
      Effect.map((value) => ({ ok: true as const, value, machine: env.machine ?? null })),
      Effect.catch((cause: HostFailure) => Effect.succeed(refusal(cause))),
    ),
  );

const hostRead: <A>(
  env: PluginEnv,
  question: (client: HostClient) => Effect.Effect<A, HostFailure>,
) => Effect.Effect<A, HostUnread, Client> = <A>(
  env: PluginEnv,
  question: (client: HostClient) => Effect.Effect<A, HostFailure>,
) =>
  asks({ ...env, machine: undefined }, question).pipe(
    Effect.flatMap((answered) =>
      answered.ok
        ? Effect.succeed(answered.value)
        : Effect.fail(new HostUnread({ error: answered.error, message: answered.error.message })),
    ),
  );

export const hostTasks: (
  env: PluginEnv,
) => Effect.Effect<ReadonlyArray<TaskRecord>, HostUnread, Client> = (env) =>
  hostRead(env, (client) => client.tasks());

export const hostRegistered: (
  env: PluginEnv,
) => Effect.Effect<ReadonlyArray<AgentEntry>, HostUnread, Client> = (env) =>
  hostRead(env, (client) => client.registered());

export const hostLaunches: (
  env: PluginEnv,
  run: string,
) => Effect.Effect<ReadonlyArray<Launched>, HostUnread, Client> = (env, run) =>
  hostRead(env, (client) => client.launches({ run }));

export const hostProposals: (
  env: PluginEnv,
  herd: string,
) => Effect.Effect<ReadonlyArray<ProposalLine>, HostUnread, Client> = (env, herd) =>
  hostRead(env, (client) => client.proposals({ herd }));

export const hostRunProposals: (
  env: PluginEnv,
  run: string,
) => Effect.Effect<ReadonlyArray<ProposalLine>, HostUnread, Client> = (env, run) =>
  hostRead(env, (client) => client.runProposals({ run }));

export const hostTaskOf = (env: PluginEnv, workspace: string | null) =>
  workspace === null
    ? Effect.succeed(null)
    : Effect.map(hostTasks(env), (tasks) =>
        Option.getOrNull(Arr.findFirst(tasks, (task) => task.workspace === workspace)),
      );

export const asksRun: <A>(
  env: PluginEnv,
  runId: string,
  question: (client: HostClient) => Effect.Effect<A, HostFailure>,
  door?: Door,
) => Effect.Effect<Answered<A> | Failure, never, Client> = <A>(
  env: PluginEnv,
  runId: string,
  question: (client: HostClient) => Effect.Effect<A, HostFailure>,
  door?: Door,
) =>
  Effect.gen(function* () {
    if (env.machine !== undefined) {
      return yield* asks(env, question, door);
    }
    const asked: Array<string> = [];
    const away: Array<string> = [];
    const tryOn = (machine: string | null) =>
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* reach(env, machine, door);
          asked.push(machine ?? machineName());
          if ((yield* client.run({ runId })) === null) {
            return null;
          }
          return yield* question(client).pipe(
            Effect.map((value) => ({ ok: true as const, value, machine })),
            Effect.catch((cause: HostFailure) => Effect.succeed(refusal(cause))),
          );
        }),
      ).pipe(
        Effect.catch((cause: HostFailure) => {
          if (machine === null) {
            return Effect.succeed(refusal(cause));
          }
          away.push(`${machine} (${refusal(cause).error.message})`);
          return Effect.succeed(null);
        }),
      );
    if (yield* anyRuns(env)) {
      const here = yield* tryOn(null);
      if (here !== null) {
        return here;
      }
    } else {
      asked.push(machineName());
    }
    const peers = Arr.map(yield* peersOf(env.stateDir), (peer) => peer.name);
    const unpaired =
      env.pairs === true
        ? Arr.filter(
            Arr.map(yield* herdrMachines(env), (machine) => machine.label),
            (label) => !peers.includes(label),
          )
        : [];
    for (const name of [...peers, ...unpaired]) {
      const there = yield* tryOn(name);
      if (there !== null) {
        return there;
      }
    }
    return err(
      "run_not_found",
      `Run "${runId}" was not found on ${Arr.join(asked, " or ")}${away.length === 0 ? "" : `, and ${Arr.join(away, ", ")} did not answer`}.`,
      { run: runId, machines: asked, away },
    );
  });

// WARNING: Same request, same Run; the Task is chosen first, so agents open in its workspace.
export const startRun = Effect.fn("Lifecycle.startRun")(function* (
  env: PluginEnv,
  options: {
    readonly door: Door;
    readonly id: string;
    readonly request: string;
    readonly input: Given;
    readonly options?: Readonly<Record<string, string>>;
    readonly task: TaskChoice;
    readonly parent?: string | null;
    readonly intent?: Pick<IntentSeed, "goal" | "constraints">;
    readonly title?: string | undefined;
    readonly verify?: ReadonlyArray<VerifySpec> | undefined;
    readonly attachments?: ReadonlyArray<string> | undefined;
  },
) {
  // WARNING: Refused before a Task is opened for it, as the host would refuse it before the claim.
  const unattachable = yield* attachmentRefusal(options.attachments ?? []).pipe(
    Effect.orElseSucceed(() => null),
  );
  if (unattachable !== null) {
    return err("invalid_input", unattachable);
  }
  // WARNING: A start on another Machine opens its own Task and reads no defaults here.
  const elsewhere = env.machine !== undefined;
  if (elsewhere && options.task.mode !== "new") {
    return err(
      "invalid_input",
      `A Run started on ${env.machine} opens a Task there; --task names this Machine's.`,
    );
  }
  const defaults = elsewhere
    ? null
    : yield* readDefaults(yield* defaultsPath(env.stateDir, scopeKey(scopeFor(env.cwd)))).pipe(
        Effect.orElseSucceed(() => null),
      );
  const placed = yield* taskFor(env, options.task, {
    workflow: options.id,
    inputs: { ...options.input.json, ...options.input.text },
    goal: options.intent?.goal,
    title: options.title,
  });
  const root =
    options.options?.workspace === PROJECTS_ROOT_OPTION && !elsewhere
      ? (yield* projectsRoot(env)).path
      : undefined;
  const started = yield* asks(
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
            followed: answered.value.followed,
            redacted: answered.value.redacted ?? [],
          }
        : answered,
    ),
  );
  if (started.ok && !elsewhere) {
    yield* rememberReach(env, options.door, options.id, options.input.text, options.options);
  }
  return started;
});

export const launchProject = (cwd: string, workspace: string | undefined) =>
  workspace === PROJECTS_ROOT_OPTION
    ? Effect.succeed(PROJECTS_ROOT_OPTION)
    : projectHere(cwd, shell).pipe(
        Effect.map((project) => project ?? cwd),
        Effect.orElseSucceed(() => cwd),
      );

const rememberReach = Effect.fn("Lifecycle.rememberReach")(function* (
  env: PluginEnv,
  door: Door,
  workflow: string,
  text: Readonly<Record<string, string>>,
  launch: Readonly<Record<string, string>> | undefined,
) {
  if (!LAUNCH_DOORS.includes(isFrontDoor(door) ? door : door.origin)) {
    return;
  }
  const module = yield* moduleFor(env, workflow);
  const reach = module === null || !("inputs" in module) ? null : reachOf(module.inputs);
  const value = reach === null ? undefined : text[reach.name];
  if (reach === null || value === undefined) {
    return;
  }
  if (!Arr.some(reach.choices, (choice) => choice.value === value)) {
    return;
  }
  yield* setSharedSetting(env, {
    door,
    key: reachKey(workflow, yield* launchProject(env.cwd, launch?.workspace)),
    value: value === "" ? null : value,
    at: yield* nowIso,
    request: yield* newRequestId(),
  });
});

export interface RunListing {
  readonly runs: ReadonlyArray<RunView>;
  readonly unreadable: string | null;
}

export const runView: (
  env: PluginEnv,
  runId: string,
) => Effect.Effect<RunView | Failure | null, never, Client> = (env, runId) =>
  anyRuns(env).pipe(
    Effect.flatMap((any) =>
      any || env.machine !== undefined
        ? asks(env, (client) => client.run({ runId })).pipe(
            Effect.map((answered) => (answered.ok ? answered.value : answered)),
          )
        : Effect.succeed(null),
    ),
  );

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

export const runProgress = (env: PluginEnv, runId: string) =>
  asksRun(env, runId, (client) => client.progress({ runId }));

// WARNING: Verifications bind to the checkout the host placed; one collected elsewhere binds to a tree nobody looked at.
export const treeOf: (view: RunView) => string = (view) => view.cwd;

// WARNING: A host that will not start costs the caller those Runs, never the whole listing.
export const runViews: (
  env: PluginEnv,
  task: string | null,
) => Effect.Effect<RunListing, never, Client> = (env, task) =>
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

// WARNING: A token from a host that has started again is refused as stale_cursor, never guessed across.
export const flockRunPage = Effect.fn("Lifecycle.flockRunPage")(function* (
  env: PluginEnv,
  asked: RunListAsked,
) {
  const here = env.machine ?? machineName();
  const pageAsked = (machine: string) => ({
    task: machine === here ? asked.task : null,
    states: asked.states,
    limit: asked.limit,
    full: asked.full,
    after: asked.after,
    since: asked.since === null ? null : (asked.since[machine]?.seq ?? null),
  });
  const answers: Array<{ readonly machine: string; readonly page: typeof RunPageAnswer.Type }> = [];
  const machines: Array<{
    readonly machine: string;
    readonly state: "away";
    readonly note: string;
  }> = [];
  let unreadable: string | null = null;
  if ((yield* anyRuns(env)) || env.machine !== undefined) {
    const local = yield* asks(env, (client) => client.runPage(pageAsked(here)));
    if (local.ok) {
      answers.push({ machine: here, page: local.value });
    } else {
      unreadable = local.error.message;
    }
  }
  if (env.machine === undefined) {
    for (const peer of yield* peersOf(env.stateDir)) {
      const read = yield* Effect.scoped(
        connectPeer(env.stateDir, peer.name, { as: "cli", client: machineName() }).pipe(
          Effect.flatMap((client) => client.runPage(pageAsked(peer.name))),
          Effect.result,
        ),
      );
      if (read._tag === "Success") {
        answers.push({ machine: peer.name, page: read.success });
      } else {
        machines.push({
          machine: peer.name,
          state: "away",
          note: refusal(read.failure).error.message,
        });
      }
    }
  }
  const epochs = Rec.fromEntries(Arr.map(answers, ({ machine, page }) => [machine, page.epoch]));
  const stale = restarted(
    { ...asked.epochs, ...Rec.map(asked.since ?? {}, (mark) => mark.epoch) },
    epochs,
  );
  if (stale.length > 0) {
    return err(
      "stale_cursor",
      `The host on ${Arr.join(stale, ", ")} has started again since that token was given; list again from the first page or a fresh cursor.`,
      { machines: [...stale] },
    );
  }
  const merged = Arr.flatMap(answers, ({ machine, page }) => {
    const views = new Map(Arr.map(page.views ?? [], (view) => [view.runId, view]));
    return Arr.map(page.runs, (summary) => ({
      machine,
      summary,
      view: views.get(summary.runId) ?? null,
    }));
  }).sort((a, b) => newerFirst(a.summary, b.summary));
  const taken = asked.limit === null ? merged : merged.slice(0, asked.limit);
  const omitted =
    merged.length - taken.length + Arr.reduce(answers, 0, (sum, { page }) => sum + page.omitted);
  const last = taken.at(-1)?.summary;
  const next =
    omitted === 0 || last === undefined
      ? null
      : pageToken({
          task: asked.task,
          states: asked.states,
          limit: asked.limit,
          full: asked.full,
          since: asked.since,
          after: { created: last.created, runId: last.runId },
          epochs: { ...asked.epochs, ...epochs },
        });
  return {
    ok: true as const,
    runs: taken,
    omitted,
    next,
    complete: omitted === 0 && machines.length === 0 && unreadable === null,
    cursor: cursorToken(
      Rec.fromEntries(
        Arr.map(answers, ({ machine, page }) => [machine, { epoch: page.epoch, seq: page.cursor }]),
      ),
    ),
    machines,
    unreadable,
  };
});

export const flockArtefacts = (env: PluginEnv, asked: FlockSearch) =>
  Effect.scoped(
    Effect.gen(function* () {
      const here = env.machine ?? machineName();
      const paired =
        env.machine === undefined ? Arr.map(yield* peersOf(env.stateDir), (peer) => peer.name) : [];
      const peers =
        env.machine !== undefined
          ? []
          : [
              ...new Set([
                ...paired,
                ...(env.pairs === true
                  ? Arr.map(yield* herdrMachines(env), (machine) => machine.label)
                  : []),
              ]),
            ];
      return yield* searchFlock(
        [
          {
            machine: here,
            reach: awayFrom(reach(env, env.machine ?? null)).pipe(Effect.flatMap(searchDoorOf)),
          },
          ...Arr.map(peers, (machine) => ({
            machine,
            reach: awayFrom(reach(env, machine)).pipe(Effect.flatMap(searchDoorOf)),
          })),
        ],
        asked,
      );
    }),
  );

export const asksArtefactRun = <A>(
  env: PluginEnv,
  named: string,
  question: (client: HostClient, run: string) => Effect.Effect<A, HostFailure>,
  door?: Door,
) =>
  flockArtefacts(env, { run: named, limit: 1 }).pipe(
    Effect.flatMap((page) => artefactOwner(page, named)),
    Effect.flatMap(({ machine, run }) =>
      asks(
        { ...env, machine: machine === machineName() ? undefined : machine },
        (client) => question(client, run),
        door,
      ),
    ),
    Effect.catch((error) =>
      Effect.succeed(
        err("invalid_input", error._tag === "AmbiguousRun" ? error.message : error.reason),
      ),
    ),
  );

// WARNING: The first state is the current one, not a replay of what changed.
export const watchRun: <R>(
  env: PluginEnv,
  runId: string,
  each: (view: RunView) => Effect.Effect<boolean, never, R>,
) => Effect.Effect<Failure | null, never, R | Client | Scope.Scope> = <R>(
  env: PluginEnv,
  runId: string,
  each: (view: RunView) => Effect.Effect<boolean, never, R>,
) =>
  Effect.gen(function* () {
    const found = yield* asksRun(env, runId, () => Effect.void);
    const opened = yield* reach(env, found.ok ? found.machine : (env.machine ?? null)).pipe(
      Effect.result,
    );
    if (opened._tag === "Failure") {
      return refusal(opened.failure);
    }
    let known = false;
    return yield* Stream.runForEachWhile(opened.success.watch({ runId }), (view) => {
      if (view === null) {
        return Effect.succeed(false);
      }
      known = true;
      return each(view).pipe(Effect.map((enough) => !enough));
    }).pipe(
      Effect.map(() =>
        known ? null : err("run_not_found", `Run "${runId}" was not found.`, { run: runId }),
      ),
      Effect.catchTag("RpcClientError", (cause) => Effect.succeed(refusal(cause))),
    );
  });

const boardStream = (env: PluginEnv) =>
  Effect.gen(function* () {
    if (env.machine !== undefined) {
      return (yield* reach(env, env.machine)).board();
    }
    yield* connect(env.stateDir);
    return (yield* frontDoor(socketOf(env.stateDir))).board();
  });

export const boardSnapshot: (
  env: PluginEnv,
) => Effect.Effect<
  { readonly ok: true; readonly value: BoardSnapshot } | Failure,
  never,
  Client
> = (env) =>
  Effect.scoped(
    Effect.gen(function* () {
      const first = yield* Stream.runHead(yield* boardStream(env));
      if (first._tag === "Some" && first.value._tag === "Snapshot") {
        return { ok: true as const, value: first.value };
      }
      return err("operation_failed", "The workflow host sent no board.");
    }).pipe(Effect.catch((cause: HostFailure) => Effect.succeed(refusal(cause)))),
  );

export interface BoardRead {
  readonly tasks: ReadonlyArray<TaskView>;
  readonly unreadable: string | null;
}

const FIRST_BOARD_WAIT = "10 seconds";

export const followBoard = Effect.fn("Lifecycle.followBoard")(function* (
  env: PluginEnv,
  changed?: () => void,
) {
  const tasks = new Map<string, TaskView>();
  const first = yield* Deferred.make<void>();
  let waited = false;
  let live = false;
  let lost: string | null = null;
  const notice = Effect.sync(() => changed?.());
  const apply = (message: BoardMessage) =>
    Effect.suspend(() => {
      switch (message._tag) {
        case "Snapshot":
          tasks.clear();
          for (const task of message.tasks) {
            tasks.set(task.id, task);
          }
          live = true;
          lost = null;
          return Deferred.succeed(first, undefined).pipe(Effect.andThen(notice));
        case "Upsert":
          tasks.set(message.task.id, message.task);
          return notice;
        case "Remove":
          tasks.delete(message.id);
          return notice;
        default:
          return Effect.void;
      }
    });
  const follow = Effect.scoped(
    Effect.flatMap(boardStream(env), (stream) => Stream.runForEach(stream, apply)),
  ).pipe(
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        const next = Cause.hasInterruptsOnly(cause)
          ? null
          : Str.split(reason(Cause.squash(cause)), "\n")[0];
        if (lost !== next) {
          lost = next;
          changed?.();
        }
      }),
    ),
    Effect.ensuring(
      Effect.sync(() => {
        if (live) {
          live = false;
          changed?.();
        }
      }),
    ),
  );
  yield* Effect.forkScoped(follow.pipe(Effect.repeat(Schedule.spaced("1 second"))));
  return () => {
    const returned: Effect.Effect<BoardRead> = Deferred.await(first).pipe(
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
    return returned;
  };
});

export interface DetailKey {
  readonly runId: string;
  readonly tail: boolean;
  readonly pages: number;
  readonly refreshMr: boolean;
}

const detailStream = (env: PluginEnv, key: DetailKey) =>
  Effect.gen(function* () {
    if (env.machine !== undefined) {
      return (yield* reach(env, env.machine)).runDetail({ ...key }).pipe(Stream.map(recordIn));
    }
    yield* connect(env.stateDir);
    return (yield* frontDoor(socketOf(env.stateDir)))
      .runDetail({ ...key })
      .pipe(Stream.map(recordIn));
  });

export const runDetailNow: (
  env: PluginEnv,
  key: DetailKey,
) => Effect.Effect<RunDetail | null, never, Client> = (env, key) =>
  Effect.scoped(
    Effect.flatMap(detailStream(env, key), Stream.runHead).pipe(
      Effect.map(Option.getOrNull),
      Effect.orElseSucceed(() => null),
    ),
  );

const FIRST_DETAIL_WAIT = "5 seconds";

export const followRunDetail = Effect.fn("Lifecycle.followRunDetail")(function* (
  env: PluginEnv,
  changed?: () => void,
) {
  const scope = yield* Effect.scope;
  const services = yield* Effect.context<Client>();
  let open: {
    readonly key: string;
    readonly first: Deferred.Deferred<void>;
    readonly fiber: Fiber.Fiber<unknown>;
    latest: RunDetail | null;
  } | null = null;
  return (key: DetailKey | null) => {
    const returned: Effect.Effect<RunDetail | null> = Effect.gen(function* () {
      if (key === null) {
        if (open !== null) {
          yield* Fiber.interrupt(open.fiber);
        }
        open = null;
        return null;
      }
      const showingKey = `${key.runId}|${key.tail}|${key.pages}`;
      if (open === null || open.key !== showingKey || key.refreshMr) {
        if (open !== null) {
          yield* Fiber.interrupt(open.fiber);
        }
        const first = yield* Deferred.make<void>();
        let refreshMr = key.refreshMr;
        const follow = Effect.scoped(
          Effect.flatMap(
            Effect.suspend(() => detailStream(env, { ...key, refreshMr })),
            (stream) =>
              Stream.runForEach(stream, (detail) =>
                Effect.sync(() => {
                  refreshMr = false;
                  if (open?.key === showingKey) {
                    open.latest = detail;
                    changed?.();
                  }
                }).pipe(Effect.andThen(Deferred.succeed(first, undefined))),
              ),
          ),
        ).pipe(
          // WARNING: A host going away ends the stream interrupted, which the retry answers.
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError(cause),
          ),
          Effect.repeat(Schedule.spaced("1 second")),
        );
        const fiber = yield* Effect.forkIn(follow, scope);
        open = { key: showingKey, first, fiber, latest: null };
      }
      const showing = open;
      yield* Deferred.await(showing.first).pipe(Effect.timeoutOption(FIRST_DETAIL_WAIT));
      return showing.latest;
    }).pipe(Effect.provideContext(services));
    return returned;
  };
});

// WARNING: A file put back is picked up here, not by restarting the host.
export const recoverRun: (
  env: PluginEnv,
  runId: string,
) => Effect.Effect<OpResult, never, Client> = (env, runId) =>
  asksRun(env, runId, (client) =>
    client.recover().pipe(Effect.andThen(client.run({ runId }))),
  ).pipe(Effect.map(shown(runId)));

const shown =
  (runId: string) =>
  (answered: { readonly ok: true; readonly value: RunView | null } | Failure) => {
    if (!answered.ok) {
      const returned: OpResult = answered;
      return returned;
    }
    const view = answered.value;
    if (view === null) {
      const returned: OpResult = err("run_not_found", `Run "${runId}" was not found.`, {
        run: runId,
      });
      return returned;
    }
    const returned: OpResult = {
      ok: true as const,
      data: { run: view },
      human: Arr.join(describeRun(view), "\n"),
    };
    return returned;
  };

// WARNING: Null means the one it waits on; refused where that is not exactly one.
export const answerRun: (
  env: PluginEnv,
  options: {
    readonly door: Door;
    readonly runId: string;
    readonly decision: string | null;
    readonly value: string;
    readonly request: string;
  },
) => Effect.Effect<OpResult, never, Client> = (env, options) =>
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

// WARNING: Work no host runs is held in intent: a control it could not apply is not done.
export const controlRun: (
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
) => Effect.Effect<OpResult, never, Client> = (env, options) =>
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

export const controlled: (
  answered: { readonly ok: true; readonly value: typeof Controlled.Type } | Failure,
) => OpResult = (answered) => {
  if (!answered.ok) {
    return answered;
  }
  const done = answered.value;
  const left = leftSaid(done);
  if (left !== null) {
    return err("operation_failed", left, { run: done.runId, left: [...done.left] });
  }
  if (done.closed !== undefined) {
    return {
      ok: true as const,
      data: { run: done.runId, ...done },
      human:
        done.closed.length === 0
          ? `Nothing of ${done.runId} was running.`
          : `Closed ${Arr.join(done.closed, ", ")}; ${done.runId} keeps the status it finished with.`,
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

export const publishRun = (
  env: PluginEnv,
  options: {
    readonly door: Door;
    readonly runId: string;
    readonly title: string;
    readonly file: string;
    readonly onto?: string | undefined;
    readonly pushOnly?: boolean | undefined;
    readonly skipCi?: boolean | undefined;
    readonly request: string;
  },
) =>
  asksRun(
    env,
    options.runId,
    (client) =>
      client.publish({
        runId: options.runId,
        title: options.title,
        file: options.file,
        onto: options.onto,
        pushOnly: options.pushOnly,
        skipCi: options.skipCi,
        request: options.request,
      }),
    options.door,
  ).pipe(
    Effect.map((answer) => {
      const returned: OpResult = answer.ok
        ? {
            ok: true,
            data: options.pushOnly ? { pushed: true } : { mr_url: answer.value.url, pushed: true },
            human: options.pushOnly ? "Branch pushed." : answer.value.url,
          }
        : answer;
      return returned;
    }),
  );

export const resumeRun: (
  env: PluginEnv,
  options: { readonly door: Door; readonly runId: string; readonly request: string },
) => Effect.Effect<OpResult, never, Client> = (env, options) =>
  asksRun(
    env,
    options.runId,
    (client) =>
      Effect.gen(function* () {
        const done = yield* client.resume({ runId: options.runId, request: options.request });
        if (!done.applied) {
          return yield* new HostRefused({ reason: done.detail });
        }
        return yield* client.run({ runId: options.runId });
      }),
    options.door,
  ).pipe(Effect.map(shown(options.runId)));

export const changeIntentRun = (
  env: PluginEnv,
  options: {
    readonly runId: string;
    readonly change: Change;
    readonly request: string;
    readonly door: Door;
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

export const grantRun: (
  env: PluginEnv,
  options: {
    readonly runId: string;
    readonly name: string;
    readonly command: Omit<VerifySpec, "name"> | null;
    readonly request: string;
    readonly door: Door;
  },
) => Effect.Effect<OpResult, never, Client> = (env, options) =>
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
            human: Arr.join([`${options.runId}'s checks:`, renderApproved(answered.value)], "\n"),
          }
        : answered,
    ),
  );

export const rememberChecks = Effect.fn("lifecycle.rememberChecks")(function* (
  env: PluginEnv,
  options: {
    readonly runId: string;
    // WARNING: A settled Run's worktree is gone: fall back to the checkout it was started for.
    readonly checkouts: ReadonlyArray<string>;
    readonly replace: boolean;
  },
) {
  const { runId } = options;
  const intent = yield* readIntent(runDir(env.stateDir, runId));
  if (intent === null) {
    return err("invalid_state", `Run ${runId} has no Intent`);
  }
  const fs = yield* FileSystem.FileSystem;
  const present: Array<string> = [];
  for (const dir of options.checkouts) {
    if (yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false))) {
      present.push(dir);
    }
  }
  if (present.length === 0) {
    return err("invalid_state", `Run ${runId}'s checkout is gone, so its remote cannot be read`);
  }
  const project = yield* projectHere(present[0]!, shell);
  if (project === null) {
    return err("invalid_state", `Run ${runId}'s checkout has no remote to remember its checks by`);
  }
  const specs = intent.authority.run_verification;
  if (specs.length === 0) {
    return err("invalid_state", `Run ${runId} has no checks to remember`);
  }
  const file = rememberedFile(env.userDir, project);
  if (file === null) {
    return err("invalid_state", `${project} is not a remote a file can be named by`);
  }
  if (!options.replace && (yield* fs.exists(file))) {
    return err(
      "invalid_state",
      `${file} already holds this repository's checks; overwrite it with replace (--replace)`,
    );
  }
  yield* fs.makeDirectory(
    pipe_(
      file,
      Str.slice(
        0,
        Option.getOrElse(pipe_(file, Str.lastIndexOf("/")), () => -1),
      ),
    ),
    { recursive: true },
  );
  yield* fs.writeFileString(file, `${encodeApprovedFile(specs)}\n`);
  const result: OpResult = {
    ok: true,
    data: { file, project, remembered: specs },
    human: Arr.join(
      [`Runs started in ${project} will begin with:`, renderApproved(specs), `(${file})`],
      "\n",
    ),
  };
  return result;
});

export const withdrawNoteRun: (
  env: PluginEnv,
  options: { runId: string; note: string; request: string; door: Door },
) => Effect.Effect<OpResult, never, Client> = (env, options) =>
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

export const steerRun: (
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
) => Effect.Effect<OpResult, never, Client> = (env, options) =>
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
        // WARNING: Only a gone agent is carried on elsewhere: a refused send to a live one may still be working the text.
        const route =
          sent.gone === true && sent.finished === true
            ? yield* followUpRoute(client, options)
            : null;
        return { sent, route };
      }),
    options.door,
  ).pipe(
    Effect.map((answered) => {
      if (!answered.ok) {
        return answered;
      }
      const { sent, route } = answered.value;
      const data = { run: options.runId, ...sent };
      if (sent.delivered || sent.queued === true) {
        return {
          ok: true as const,
          data,
          human: withNotice(
            Arr.join(
              Arr.filter(
                [
                  sent.queued === true
                    ? sent.detail
                    : sent.note === undefined
                      ? deliveredLine(sent)
                      : `Note ${sent.note} kept for Step ${options.step}.`,
                  sent.kept,
                  sent.workflowNotice,
                ],
                (line) => line !== undefined,
              ),
              " ",
            ),
            sent.redacted,
          ),
        };
      }
      // WARNING: Never read as delivered when nothing was sent.
      const why = Arr.join(
        Arr.filter(
          [`Nothing was delivered: ${sent.detail || "no agent to tell"}.`, sent.workflowNotice],
          (line) => line !== undefined,
        ),
        " ",
      );
      return err(
        "operation_failed",
        withNotice(route === null ? why : `${why} ${route}`, sent.redacted, " "),
        data,
      );
    }),
  );

export const deliveredLine: (sent: {
  readonly agent: string;
  readonly observed?: boolean;
  readonly how?: string;
  readonly pane?: string;
}) => string = (sent) =>
  sent.observed === true
    ? `Delivered to ${sent.agent} (observed: ${sent.how ?? "taken"}).`
    : `Sent to ${sent.agent}, not observed. Go to pane: \`hc attach ${sent.pane ?? sent.agent}\`.`;

const followUpRoute: (
  client: HostClient,
  options: { readonly runId: string; readonly text: string },
) => Effect.Effect<string | null> = (client, options) =>
  Effect.gen(function* () {
    const view = yield* client.run({ runId: options.runId });
    if (view === null) {
      return null;
    }
    const offers = yield* client.offers({ runId: options.runId }).pipe(
      Effect.orElseSucceed(() => {
        const returned: ReadonlyArray<OfferView> = [];
        return returned;
      }),
    );
    const offered = Option.getOrUndefined(
      Arr.findFirst(offers, (one) => one.kind === "follow-up" && one.run === undefined),
    );
    if (offered !== undefined) {
      return `${options.runId} has finished and its agent is gone: carry this on with its follow-up offer "${offered.id}", giving the message as its input.`;
    }
    return `${options.runId} has finished and its agent is gone, and it offers no follow-up: start a new Run on ${view.branch === null ? "its branch" : `its branch ${view.branch}`}.`;
  }).pipe(Effect.orElseSucceed(() => null));

export const carriedResult: ({ proposal, results }: ProposalCarried) => OpResult = ({
  proposal,
  results,
}) => {
  const message = Arr.join(
    Arr.map(results, (r) => `${r.index} ${r.kind}: ${r.state}${r.note ? ` — ${r.note}` : ""}`),
    "\n",
  );
  if (Arr.some(results, (r) => r.state !== "applied")) {
    const changed = Arr.some(results, (r) => r.state === "applied" && r.kind !== "none");
    // WARNING: needs_input is retryable without a receipt only when nothing has happened yet.
    const code =
      results.at(-1)?.kind === "ask_human" && !changed ? "needs_input" : "operation_failed";
    return err(code, message, { proposal, results: Arr.map(results, (r) => ({ ...r })) });
  }
  return { ok: true as const, data: { proposal, results }, human: message };
};

const capitalised = (text: string) =>
  Str.toUpperCase(Option.getOrElse(Str.charAt(text, 0), () => "")) + pipe_(text, Str.slice(1));

export const describeRun: (view: RunView) => ReadonlyArray<string> = (view) => [
  `${view.runId}\t${statusOf(view)}\t${view.workflow}`,
  view.entry,
  `proves ${view.outcome}${view.measurement ? `; ${view.measurement}` : ""}`,
  ...(view.parent === null ? [] : [`part of ${view.parent}`]),
  ...(view.controls.length === 0 ? [] : [`under ${Arr.join(view.controls, ", ")}`]),
  ...describeWaiting(view),
  ...(view.diagnostic === null ? [] : [view.diagnostic]),
  ...(view.parked === null ? [] : [view.parked]),
  ...(view.awaiting === null ? [] : [awaitingLine(view.awaiting)]),
];

export const describeWaiting: (view: RunView) => ReadonlyArray<string> = (view) =>
  Arr.flatMap(Arr.filter(view.waiting, isUnanswered), (one: OpenDecision) => {
    const hold = holdPath(one, view.controls.includes(HOLD));
    return [
      `waiting on "${one.name}": ${one.prompt}${one.options.length === 0 ? "" : ` (${Arr.join(Arr.map(one.options, solutionTitle), " | ")})`}`,
      ...Arr.flatMap(one.options, (option) =>
        option.detail === undefined ? [] : [`  ${solutionTitle(option)}: ${option.detail}`],
      ),
      ...(hold === undefined
        ? []
        : [
            hold.offered
              ? `  Hold the Run: collie run hold ${view.runId} --reason "${holdReason(one.name)}"`
              : `  Hold the Run: unavailable, ${hold.why}`,
          ]),
      ...(one.shortfall == null ? [] : [`  ⚠ ${one.shortfall}`]),
    ];
  });

export const nextAction: (view: RunView) => string | null = (view) =>
  Option.getOrNull(Arr.findFirst(view.waiting, isUnanswered))?.name ?? null;

export const statusOf: (view: RunView) => string = (view) => {
  switch (view.status.status) {
    case "ended":
      return `ended at ${view.status.at}; outcome unavailable`;
    case "complete":
      return `complete: ${resultText(view.status.value)}`;
    case "failed":
      return `failed: ${view.status.reason}`;
    default:
      return view.diagnostic === null ? view.status.status : "waiting for its module";
  }
};

export { resultText } from "./report";

export const isSettled: (view: RunView) => boolean = (view) => terminalStatus(view.status);

export const showOffers: (
  env: PluginEnv,
  runId: string,
) => Effect.Effect<OpResult, never, Client> = (env, runId) =>
  asksRun(env, runId, (client) => client.offers({ runId })).pipe(
    Effect.map((answered) =>
      answered.ok
        ? {
            ok: true as const,
            data: { run: runId, offers: Arr.map(answered.value, (offer) => ({ ...offer })) },
            human:
              answered.value.length === 0 ? "Nothing is offered." : describeOffers(answered.value),
          }
        : answered,
    ),
  );

export const offersOf: (
  env: PluginEnv,
  runId: string,
) => Effect.Effect<ReadonlyArray<OfferView> | Failure, never, Client> = (env, runId) =>
  asksRun(env, runId, (client) => client.offers({ runId })).pipe(
    Effect.map((answered) => (answered.ok ? answered.value : answered)),
  );

export const describeOffers: (offers: ReadonlyArray<OfferView>) => string = (offers) =>
  Arr.join(
    Arr.map(offers, (offer) => {
      const why = offer.unavailable === null ? "" : ` — unavailable: ${offer.unavailable}`;
      const on = offer.run === undefined ? "" : ` on ${offer.run}`;
      return `${offer.primary ? "▸" : " "} ${offer.id}  ${offer.title} (${offer.workflow})${on}${why}`;
    }),
    "\n",
  );

export const invokeOffer: (
  env: PluginEnv,
  options: {
    readonly door: Door;
    readonly runId: string;
    readonly offer: string;
    readonly input: Readonly<Record<string, Schema.Json>>;
    readonly request: string;
    readonly attachments?: ReadonlyArray<string> | undefined;
  },
) => Effect.Effect<OpResult, never, Client> = (env, options) =>
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

export const invokeTypedOffer: (
  env: PluginEnv,
  options: Omit<Parameters<typeof invokeOffer>[1], "input"> & {
    readonly input: Readonly<Record<string, string>>;
  },
) => Effect.Effect<OpResult, never, Client> = (env, options) =>
  Effect.flatMap(offersOf(env, options.runId), (listed) => {
    const offer =
      "ok" in listed
        ? undefined
        : Option.getOrUndefined(
            Arr.findFirst(listed, (one) => one.id === options.offer && one.run === undefined),
          );
    return invokeOffer(env, {
      ...options,
      input: givenOfferInput(offer?.arguments ?? null, options.input),
    });
  });

export const confirmProposed: (
  env: PluginEnv,
  options: {
    readonly door: Door;
    readonly proposal: string;
    readonly hash: string;
    readonly request: string;
  },
) => Effect.Effect<OpResult, never, Client> = (env, options) =>
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

export const declineProposed: (
  env: PluginEnv,
  options: {
    readonly door: Door;
    readonly proposal: string;
    readonly hash: string;
    readonly request: string;
  },
) => Effect.Effect<OpResult, never, Client> = (env, options) =>
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

export const disposeRun: (
  env: PluginEnv,
  options: {
    readonly door: Door;
    readonly runId: string;
    readonly kind: Disposition["kind"];
    readonly ref: string;
    readonly note: string | null;
    readonly request: string;
  },
) => Effect.Effect<{ readonly ok: true; readonly value: Disposition } | Failure, never, Client> = (
  env,
  options,
) =>
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

export const seeRun: (
  env: PluginEnv,
  options: { readonly door: Door; readonly runId: string; readonly request: string },
) => Effect.Effect<{ readonly ok: true; readonly value: Seen } | Failure, never, Client> = (
  env,
  options,
) =>
  asksRun(
    env,
    options.runId,
    (client) => client.seen({ runId: options.runId, request: options.request }),
    options.door,
  );

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

export const catalogueReadings = (env: PluginEnv, door: Door) =>
  asks(env, (client) => client.models(), door);

export const connectionReadings = (env: PluginEnv, door: Door) =>
  asks(env, (client) => client.connections(), door);

export const machineShell = (env: PluginEnv, script: string, request: string, door: Door) =>
  asks(env, (client) => client.shell({ script, request }), door);

export const usageReadings = (env: PluginEnv, door: Door) =>
  asks(env, (client) => client.usage(), door);

export const usageFallbacks = (env: PluginEnv, door: Door) =>
  asks(env, (client) => client.fallbacks(), door);

export const cleanupListing = (env: PluginEnv, door: Door) =>
  asks(env, (client) => client.cleanup(), door);

export const scheduleListing = (env: PluginEnv, door: Door) =>
  asks(env, (client) => client.schedules(), door);

export const flockSchedules = Effect.fn("Lifecycle.flockSchedules")(function* (
  env: PluginEnv,
  door: Door,
) {
  const local = yield* scheduleListing(env, door);
  if (!local.ok) {
    return local;
  }
  const schedules = [...local.value.schedules];
  const machines: Array<{
    readonly machine: string;
    readonly state: "away";
    readonly note: string;
  }> = [];
  if (env.machine === undefined) {
    for (const peer of yield* peersOf(env.stateDir)) {
      const read = yield* Effect.scoped(
        reach(env, peer.name, door).pipe(
          Effect.flatMap((client) => client.schedules()),
          Effect.result,
        ),
      );
      if (read._tag === "Success") {
        schedules.push(...read.success.schedules);
      } else {
        machines.push({
          machine: peer.name,
          state: "away",
          note: refusal(read.failure).error.message,
        });
      }
    }
  }
  return { ok: true as const, value: { machine: local.value.machine, schedules, machines } };
});

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
  const returned: ScheduleDoor = {
    name: machine ?? machineName(),
    schedules: ask((client) => client.schedules()),
    changeSchedule: (asked: { readonly change: ScheduleChange; readonly request: string }) =>
      ask((client) => client.changeSchedule(asked)),
  };
  return returned;
});

export const changeSchedule = (
  env: PluginEnv,
  options: { readonly door: Door; readonly change: ScheduleChange; readonly request: string },
) =>
  asks(
    env,
    (client) => client.changeSchedule({ change: options.change, request: options.request }),
    options.door,
  );

export const sweepNow = (
  env: PluginEnv,
  options: { readonly door: Door; readonly request: string },
) => asks(env, (client) => client.sweep({ request: options.request }), options.door);

export const steerAbout: (
  env: PluginEnv,
  options: {
    readonly door: Door;
    readonly runId: string;
    readonly text: string;
    readonly from: string | null;
    readonly dryRun: boolean;
    readonly request: string;
  },
) => Effect.Effect<OpResult, never, Client> = (env, options) =>
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

const opResultOf: (said: SteerOutcome) => OpResult = (said) => {
  if (said.ok) {
    return {
      ok: true,
      data: Predicate.isObject(said.data) ? said.data : { said: said.data },
      human: said.human,
    };
  }
  const failed = Schema.decodeUnknownOption(ExpectedError)({
    code: said.code,
    message: said.human,
    details: said.data,
  });
  return failed._tag === "Some"
    ? { ok: false, error: failed.value }
    : err("operation_failed", said.human);
};

export const proposeActions: (
  env: PluginEnv,
  options: {
    readonly door: Door;
    readonly herd: string | null;
    readonly interpretation: string;
    readonly actions: ReadonlyArray<Action>;
    readonly request: string;
  },
) => Effect.Effect<OpResult, never, Client> = (env, options) =>
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

export const actAsked: (
  env: PluginEnv,
  options: {
    readonly door: Door;
    readonly actions: ReadonlyArray<Action>;
    readonly request: string;
  },
) => Effect.Effect<ReadonlyArray<ActionResult>, never, Client> = (env, options) =>
  (options.actions.length === 1 &&
  options.actions[0]!.kind === "start" &&
  options.actions[0].machine !== undefined
    ? asks(
        { ...env, machine: options.actions[0].machine },
        (client) => client.act({ actions: options.actions, request: options.request }),
        options.door,
      )
    : options.actions.length === 1 && "run" in options.actions[0]!
      ? asksRun(
          env,
          options.actions[0].run,
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
        : Arr.map(options.actions.slice(0, 1), (action) => ({
            kind: action.kind,
            state: "failed",
            note: answered.error.message,
          })),
    ),
  );

export const reconcileProposed: (
  env: PluginEnv,
  options: {
    readonly door: Door;
    readonly proposal: string;
    readonly index: number;
    readonly as: "applied" | "not-applied";
    readonly request: string;
  },
) => Effect.Effect<OpResult, never, Client> = (env, options) =>
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
    Effect.map((answered) => {
      const returned: OpResult = answered.ok
        ? {
            ok: true,
            data: { proposal: options.proposal, index: options.index, as: options.as },
            human: `Settled action ${options.index} as ${options.as}.`,
          }
        : answered;
      return returned;
    }),
  );

export const reconcileDelivered: (
  env: PluginEnv,
  options: {
    readonly door: Door;
    readonly runId: string;
    readonly delivery: string;
    readonly as: "sent" | "not-sent";
    readonly request: string;
  },
) => Effect.Effect<OpResult, never, Client> = (env, options) =>
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
    Effect.map((answered) => {
      const returned: OpResult = answered.ok
        ? {
            ok: true,
            data: { delivery: answered.value },
            human: `Reconciled ${options.delivery} as ${options.as}.`,
          }
        : answered;
      return returned;
    }),
  );

export const followUpRun: (
  env: PluginEnv,
  options: {
    readonly door: Door;
    readonly runId: string;
    readonly text: string;
    readonly request: string;
    readonly attachments?: ReadonlyArray<string> | undefined;
  },
) => Effect.Effect<OpResult, never, Client> = (env, options) =>
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

export const restartHostAt: (dir: string) => Effect.Effect<OpResult, never, Client> = (dir) =>
  restartHost(dir).pipe(
    Effect.map((restarted) => {
      const returned: OpResult = {
        ok: true,
        data: { dir, ...restarted },
        human: restartSaid(dir, restarted),
      };
      return returned;
    }),
    Effect.catch((cause) => Effect.succeed(refusal(cause))),
  );

export const machineList = (env: PluginEnv) => asks(env, (client) => client.peers());

export const machinesListed = (env: PluginEnv) =>
  Effect.gen(function* () {
    const read = yield* asks(env, (client) => client.peers());
    if (!read.ok) {
      return read;
    }
    const backend = "core" as const;
    const roster = yield* coreRoster(env).pipe(Effect.result);
    const machines = Result.isSuccess(roster) ? roster.success : null;
    const listed = new Set(Arr.map(machines ?? [], (machine) => machine.label));
    return {
      ...read,
      value: {
        backend,
        roster: machines,
        rosterFailure: Result.isFailure(roster) ? herdrFailureReason(roster.failure) : null,
        peers: Arr.map(read.value, (peer) => ({
          ...peer,
          added: peer.dials !== "out" ? null : machines === null ? null : listed.has(peer.name),
        })),
      },
    };
  }).pipe(Effect.provide(Path.layer));

const answered = <A>(effect: Effect.Effect<A, HostFailure, Client | FileSystem.FileSystem>) =>
  effect.pipe(
    Effect.map((value) => {
      const returned: Answered<A> = { ok: true as const, value, machine: null };
      return returned;
    }),
    Effect.catch((cause: HostFailure) => Effect.succeed(refusal(cause))),
  );

export const machineConnect = (
  env: PluginEnv,
  name: string,
  said: (text: string) => Effect.Effect<void>,
  target?: string,
) =>
  answered(
    Effect.map(openAndWake(env, name, said, target), (opened) => ({ machine: name, ...opened })),
  );

// WARNING: Core never logs in by itself: its via rides this computer's SSH connection.
export const machineAdd = (
  env: PluginEnv,
  name: string,
  target: string,
  said: (text: string) => Effect.Effect<void>,
) =>
  answered(
    Effect.gen(function* () {
      const opened = yield* openConnection(env.stateDir, { label: name, target }, { said });
      yield* addToCore(env, name, target, opened.path);
      return { machine: name, ...opened };
    }).pipe(Effect.provide(Path.layer)),
  );

export const machineForget = (env: PluginEnv, name: string) =>
  answered(
    Effect.gen(function* () {
      const unpaired = yield* asks({ ...env, machine: undefined }, (client) =>
        client.unpair({ machine: name }),
      );
      if (!unpaired.ok) {
        return yield* new HostRefused({ reason: unpaired.error.message });
      }
      yield* new Herdr(env).machineRemove(name).pipe(
        Effect.catchIf(
          (cause) => cause.code === "machine_unknown",
          () => Effect.void,
        ),
        Effect.mapError(coreRefused(name)),
        Effect.provide(Path.layer),
      );
      return { machine: name };
    }).pipe(Effect.provide(Path.layer)),
  );

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
    again?: boolean;
    isolated?: boolean;
    prepare?: Prepare;
  },
  door: Door,
) {
  const found = yield* asksRun(env, request.runId, () => Effect.void, door);
  if (!found.ok) {
    return found;
  }
  const client = yield* reach(env, found.machine, door);
  const events = client.verify(request);
  if (found.machine !== null) {
    return { ok: true as const, events };
  }
  return {
    ok: true as const,
    events: followVerify(env.stateDir, events, (again) =>
      door === undefined ? Effect.void : again.declare(declaring(door, env.hostStamp)),
    ),
  };
});

export const measureRun = Effect.fn("Lifecycle.measureRun")(function* (
  env: PluginEnv,
  request: {
    runId: string;
    base: string;
    cwd?: string;
    plan: Schema.Json;
    pass: string;
    reason?: string;
  },
  door: Door,
) {
  const found = yield* asksRun(env, request.runId, () => Effect.void, door);
  if (!found.ok) {
    return found;
  }
  const client = yield* reach(env, found.machine, door);
  return { ok: true as const, events: client.measure(request) };
});

// WARNING: a child whose records cannot be read is listed as unreadable, not failed.
export const usageFor = Effect.fn("Usage.for")(function* (
  env: PluginEnv,
  runId: string,
  door?: Door,
) {
  const read = (id: string) =>
    asksRun(
      env,
      id,
      (client) =>
        Effect.all({
          entries: client.runUsage({ runId: id }),
          lines: client.runMetrics({ runId: id }),
        }),
      door,
    );
  const own = yield* read(runId);
  if (!own.ok) {
    return own;
  }
  const views = (yield* runViews(env, null)).runs;
  const children = yield* Effect.forEach(descendantsOf(views, runId), (child) =>
    read(child).pipe(
      Effect.map((got) => ({
        runId: child,
        usage: got.ok ? usageOf(got.value.entries, got.value.lines) : null,
      })),
    ),
  );
  return {
    ok: true as const,
    value: withChildren(usageOf(own.value.entries, own.value.lines), children),
  };
});

// WARNING: a Run whose metrics cannot be read fails the report; one with unreadable records is measured without them.
export const reportFor = Effect.fn("Report.for")(function* (env: PluginEnv, since: string | null) {
  const hosted = yield* runViews(env, null);
  const metrics = new Map<string, Metrics>();
  const recorded = new Map<string, Recorded>();
  for (const view of hosted.runs) {
    const asked = yield* asksRun(env, view.runId, (client) =>
      Effect.all({
        metrics: client.runMetrics({ runId: view.runId }),
        records: client.runOutcomes({ runId: view.runId }).pipe(
          Effect.orElseSucceed(() => {
            const returned: OutcomeRecords | null = null;
            return returned;
          }),
        ),
      }),
    );
    if (!asked.ok) {
      return asked;
    }
    metrics.set(view.runId, metricsOf(asked.value.metrics, view.created));
    recorded.set(view.runId, asked.value);
  }
  return {
    ok: true as const,
    report: reportOf(hosted.runs, metrics, since, recorded),
    unreadable: hosted.unreadable,
  };
});
