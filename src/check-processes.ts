// A check's processes, from spawn to gone (ADR-draft-a-check-ends-with-the-host-that-runs-it).
// Nothing is signalled that is not proved the check's: its recorded leader by pid and start
// token, or a process carrying both of its bindings.

import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import {
  Clock,
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Option,
  Random,
  Schedule,
  Schema,
  Stream,
  flow,
  Result,
} from "effect";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type { Scope } from "effect";
import { KEPT_BYTES, SUPERVISE, checkFiles } from "./check-supervisor";
import { boundProcesses, groupOf, startedOf, stillRunning } from "./processes";
import { StepPlace } from "./steps";
import { epochMs, nowIso } from "./time";
import { FailedTestSchema, VerificationSchema } from "./verify-model";

export const CHECK_INSTALLATION = "COLLIE_CHECK_INSTALLATION";
export const CHECK_ID = "COLLIE_CHECK_ID";
const KILL_AFTER = "2 seconds";
const KILL_WAIT = 1_000;

/** Which check of which Run, as its record and the host's log name it. */
export interface CheckOf {
  readonly run: string;
  readonly name: string;
  readonly pass?: { readonly pass: string; readonly round?: number };
  readonly by: "agent" | "collie";
}

/** What finishing a check's Verification takes beside its command, record and output, known before it is spawned. */
const SpecSchema = Schema.Struct({
  /** The run directory its Verification is appended to. */
  evidence: Schema.String,
  asked: Schema.String,
  start: VerificationSchema.fields.start,
  began: Schema.String,
  expect: Schema.Literals(["pass", "fail"]),
  step: Schema.NullOr(Schema.Struct({ step: Schema.String, place: Schema.NullOr(StepPlace) })),
  log: Schema.optionalKey(Schema.String),
  test: Schema.optionalKey(FailedTestSchema),
  environment: Schema.optionalKey(Schema.String),
});
type CheckSpec = typeof SpecSchema.Type;

/** A check's facts and command, written before it is spawned. */
const FinishingSchema = Schema.Struct({
  check: Schema.Struct({
    run: Schema.String,
    name: Schema.String,
    pass: Schema.optionalKey(
      Schema.Struct({ pass: Schema.String, round: Schema.optionalKey(Schema.Finite) }),
    ),
    by: Schema.Literals(["agent", "collie"]),
  }),
  command: Schema.Struct({
    executable: Schema.String,
    argv: Schema.Array(Schema.String),
    cwd: Schema.String,
    spec: SpecSchema,
  }),
});
const encodeFinishing = flow(
  Schema.encodeResult(Schema.fromJsonString(FinishingSchema)),
  Result.getOrThrow,
);
const decodeFinishing = Schema.decodeUnknownOption(Schema.fromJsonString(FinishingSchema));

export interface CheckCommand {
  readonly executable: string;
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly spec?: CheckSpec;
}

type Finishing = Schema.Schema.Type<typeof FinishingSchema>;

/** What a check that exited is finished from: its facts, and the end of each of its streams. */
export interface FinishedCheck extends Finishing {
  readonly output: { readonly stdout: string; readonly stderr: string };
}

export interface RunningCheck {
  /** Null where this host would not start it. */
  readonly id: string | null;
  /** Its command's, where it was spawned. */
  readonly pid: Effect.Effect<number | null>;
  readonly stdout: Stream.Stream<Uint8Array, PlatformError>;
  readonly stderr: Stream.Stream<Uint8Array, PlatformError>;
  readonly exit: Effect.Effect<number, PlatformError>;
  /** Whether its supervisor writes its log, so its collector does not. */
  readonly logged: boolean;
  /** What `collecting` gathers of it, never completing for a check this host ended (D4). */
  readonly collected: <A, E, R>(collecting: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

/** A process the caller spawned, recorded as a check's. */
export interface AdoptedCheck<H> {
  readonly handle: H;
  readonly collected: RunningCheck["collected"];
}

/** A check a host recorded or marked in this state directory that no host is collecting. */
export interface Leftover {
  readonly id: string;
  readonly run: string;
  /** Null where only its marked processes are left, which carry neither. */
  readonly name: string | null;
  readonly pass: string | null;
  readonly leader: { readonly pid: number; readonly started: string; readonly group: number };
  /** Whether a record names its leader, which is what proves its group. */
  readonly recorded: boolean;
  readonly host: { readonly pid: number; readonly started: string } | null;
  /** When it started, in epoch ms. */
  readonly started: number;
}

export type LeftoverEnd = "ended" | "already gone" | "still running";

/** A new check of a Run not started, because a leftover of that Run survived its end (D6). */
export class CheckRefused extends Data.TaggedError("CheckRefused")<{ readonly why: string }> {}

export interface CheckProcessesApi {
  /**
   * Starts the check in the caller's Scope, whose close ends its processes for good. `say`
   * hears of each leftover of its Run before that is ended.
   */
  readonly run: (
    check: CheckOf,
    command: CheckCommand,
    say?: (line: string) => Effect.Effect<void>,
  ) => Effect.Effect<
    RunningCheck,
    PlatformError | CheckRefused,
    Scope.Scope | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
  >;
  /** A check still recorded with what its Verification needs; null where it is not. */
  readonly finished: (id: string) => Effect.Effect<FinishedCheck | null>;
  /**
   * As `run`, for a process the caller spawns itself, with `markers` in its environment, and
   * ends in the caller's Scope. Null where this host has begun to end, and nothing spawned.
   */
  readonly adopt: <H extends { readonly pid: number }>(
    check: CheckOf,
    spawn: (markers: Readonly<Record<string, string>>) => Effect.Effect<H>,
    say?: (line: string) => Effect.Effect<void>,
  ) => Effect.Effect<AdoptedCheck<H> | null, CheckRefused, Scope.Scope>;
  /**
   * Leaves each supervised check this host is collecting to the host replacing it: this one
   * neither ends it nor collects it from now on. Gives back their ids.
   */
  readonly handOver: Effect.Effect<ReadonlyArray<string>>;
  /** The checks it took over that a step has not claimed again, by `run`, which no step will for an agent's. */
  readonly takenOver: Effect.Effect<ReadonlyArray<CheckRecord>>;
  /** A check it took over, now collected as `run` would have started it; null where it was claimed already. */
  readonly claim: (id: string) => Effect.Effect<RunningCheck | null, never, Scope.Scope>;
  /** Marks every check this host is collecting ended, then sends each, and each still being spawned, SIGTERM. */
  readonly endAll: Effect.Effect<ReadonlyArray<CheckOf>>;
  /** SIGKILL to whatever of every check is left, and to one still being spawned; its record goes once it is gone. */
  readonly killEnded: Effect.Effect<void>;
  /** The ids of the checks this host is collecting. */
  readonly collecting: Effect.Effect<ReadonlyArray<string>>;
  readonly left: Effect.Effect<ReadonlyArray<Leftover>>;
  readonly stillRuns: (leftover: Leftover) => Effect.Effect<boolean>;
  /** Ends it for good, removes its record, and says so in `host.log` and on its Run. */
  readonly endLeftover: (leftover: Leftover) => Effect.Effect<LeftoverEnd>;
}

const RecordSchema = Schema.Struct({
  id: Schema.String,
  run: Schema.String,
  name: Schema.String,
  pass: Schema.optionalKey(Schema.String),
  round: Schema.optionalKey(Schema.Finite),
  by: Schema.String,
  leader: Schema.Struct({ pid: Schema.Finite, started: Schema.String, group: Schema.Finite }),
  host: Schema.Struct({ pid: Schema.Finite, started: Schema.String }),
  started: Schema.String,
});
export type CheckRecord = Schema.Schema.Type<typeof RecordSchema>;
export const encodeCheckRecord = flow(
  Schema.encodeResult(Schema.fromJsonString(RecordSchema)),
  Result.getOrThrow,
);
const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(RecordSchema));

export const runningChecksDir = (stateDir: string) => `${stateDir}/running-checks`;
const recordPath = (stateDir: string, id: string) => `${runningChecksDir(stateDir)}/${id}.json`;
const checkOutputDir = (stateDir: string) => `${stateDir}/check-output`;
const outputsOf = (stateDir: string, id: string) => checkFiles(checkOutputDir(stateDir), id);

const finishingPath = (stateDir: string, id: string) => `${checkOutputDir(stateDir)}/${id}.json`;

const removeRecord = (fs: FileSystem.FileSystem, stateDir: string, id: string) => {
  const outputs = outputsOf(stateDir, id);
  return Effect.forEach(
    [
      recordPath(stateDir, id),
      finishingPath(stateDir, id),
      outputs.stdout,
      outputs.stderr,
      outputs.pid,
      outputs.exit,
    ],
    (path) => fs.remove(path, { force: true }).pipe(Effect.ignore),
    { discard: true },
  );
};

const writeFinishing = (
  fs: FileSystem.FileSystem,
  stateDir: string,
  id: string,
  finishing: Finishing,
) =>
  fs
    .writeFileString(`${finishingPath(stateDir, id)}.new`, encodeFinishing(finishing))
    .pipe(
      Effect.andThen(fs.rename(`${finishingPath(stateDir, id)}.new`, finishingPath(stateDir, id))),
    );

const readFinishing = (fs: FileSystem.FileSystem, stateDir: string, id: string) =>
  fs
    .readFileString(finishingPath(stateDir, id))
    .pipe(Effect.map((text) => Option.getOrNull(decodeFinishing(text))));

/** The records of the checks running in this state directory, as their hosts wrote them. */
export const recordsIn = Effect.fn("CheckProcesses.recordsIn")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const dir = runningChecksDir(stateDir);
  const found: CheckRecord[] = [];
  for (const file of yield* fs.readDirectory(dir).pipe(Effect.orElseSucceed(() => []))) {
    if (!pipe_(file, Str.endsWith(".json"))) continue;
    const text = yield* fs.readFileString(`${dir}/${file}`).pipe(Effect.orElseSucceed(() => ""));
    const read = decodeRecord(text);
    if (Option.isSome(read)) found.push(read.value);
  }
  return found;
});

const spawnCheck = (command: CheckCommand, env?: Readonly<Record<string, string>>) =>
  Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
    spawner.spawn(
      ChildProcess.make(command.executable, [...command.argv], {
        cwd: command.cwd,
        stdout: "pipe",
        stderr: "pipe",
        extendEnv: true,
        ...(env !== undefined && { env }),
        forceKillAfter: KILL_AFTER,
      }),
    ),
  );

/** The check under its supervisor, which leads its process group and alone is this host's child. */
const spawnSupervised = (
  supervisor: ReadonlyArray<string>,
  stateDir: string,
  id: string,
  command: CheckCommand,
  markers: Readonly<Record<string, string>>,
) =>
  Effect.flatMap(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
    spawner
      .spawn(
        ChildProcess.make(
          supervisor[0] ?? "collie",
          [
            ...supervisor.slice(1),
            SUPERVISE,
            checkOutputDir(stateDir),
            id,
            command.spec?.log ?? "",
            command.executable,
            ...command.argv,
          ],
          {
            cwd: command.cwd,
            stdout: "pipe",
            stderr: "pipe",
            extendEnv: true,
            env: markers,
            forceKillAfter: KILL_AFTER,
          },
        ),
      )
      // Unreferenced, so a Scope closed by a host handing it over leaves it running.
      .pipe(Effect.tap((handle) => handle.unref)),
  );

const pidIn = (fs: FileSystem.FileSystem, stateDir: string, id: string) =>
  fs.readFileString(outputsOf(stateDir, id).pid).pipe(Effect.map((text) => Number(Str.trim(text))));

/** The pid a check's supervisor runs its command as, once it says; null where it never ran it. */
const commandPid = (
  fs: FileSystem.FileSystem,
  stateDir: string,
  id: string,
  supervisor: ChildProcessSpawner.ChildProcessHandle,
) =>
  Effect.raceFirst(
    pidIn(fs, stateDir, id).pipe(Effect.retry(Schedule.spaced("10 millis"))),
    supervisor.exitCode.pipe(Effect.ignore, Effect.andThen(pidIn(fs, stateDir, id))),
  ).pipe(Effect.orElseSucceed(() => null));

/** The exit status a check's supervisor wrote. */
const exitIn = (fs: FileSystem.FileSystem, stateDir: string, id: string) =>
  fs
    .readFileString(outputsOf(stateDir, id).exit)
    .pipe(Effect.map((text) => Number(Str.trim(text))));

const checkOfRecord = (record: CheckRecord): CheckOf => ({
  run: record.run,
  name: record.name,
  ...(record.pass !== undefined && {
    pass:
      record.round === undefined
        ? { pass: record.pass }
        : { pass: record.pass, round: record.round },
  }),
  by: record.by === "agent" ? "agent" : "collie",
});

/** Whether a check taken over is the one a replayed step asks for, by what it is and what it runs. */
const sameCheck = (taken: Finishing | null, check: CheckOf, command: CheckCommand) =>
  taken !== null &&
  taken.check.run === check.run &&
  taken.check.name === check.name &&
  taken.check.by === check.by &&
  taken.check.pass?.pass === check.pass?.pass &&
  taken.check.pass?.round === check.pass?.round &&
  taken.command.executable === command.executable &&
  taken.command.cwd === command.cwd &&
  Arr.makeEquivalence<string>((one, other) => one === other)(taken.command.argv, command.argv);

/** The last `KEPT_BYTES` of each of a check's streams, as read so far. */
interface Kept {
  stdout: Uint8Array;
  stderr: Uint8Array;
}
const nothingKept = (): Kept => ({ stdout: new Uint8Array(), stderr: new Uint8Array() });
const textOf = (kept: Kept) => ({
  stdout: new TextDecoder().decode(kept.stdout),
  stderr: new TextDecoder().decode(kept.stderr),
});

/** Kept in memory as it is read, so neither the log nor the tail waits on `store`, which gets it once it ends. */
const keptOf = (
  stream: Stream.Stream<Uint8Array, PlatformError>,
  kept: Kept,
  name: keyof Kept,
  store: (name: keyof Kept, bytes: Uint8Array) => Effect.Effect<void>,
) =>
  stream.pipe(
    Stream.tap((chunk) =>
      Effect.sync(() => {
        kept[name] = Buffer.concat([kept[name], chunk]).subarray(-KEPT_BYTES);
      }),
    ),
    Stream.onEnd(Effect.suspend(() => store(name, kept[name]))),
  );

const runningOf = (
  id: string,
  handle: ChildProcessSpawner.ChildProcessHandle,
  kept: Kept,
  store: (name: keyof Kept, bytes: Uint8Array) => Effect.Effect<void>,
  collected: RunningCheck["collected"],
): RunningCheck => ({
  id,
  pid: Effect.succeed(handle.pid),
  stdout: keptOf(handle.stdout, kept, "stdout", store),
  stderr: keptOf(handle.stderr, kept, "stderr", store),
  exit: Effect.map(handle.exitCode, Number),
  logged: false,
  collected,
});

const newId = (run: string, began: string) =>
  Effect.map(
    Random.next,
    (salt) => `${run}@${epochMs(began)}-${pipe_(salt.toString(16), Str.slice(2))}`,
  );

// ponytail: in memory, as nothing outside this process could finish one.
const unrecordedChecks = new Map<string, { readonly finishing: Finishing; readonly kept: Kept }>();

/** Outside a host: its own group, and nothing of it kept past its Scope. */
const unrecorded: CheckProcessesApi = {
  run: (check, command) =>
    Effect.gen(function* () {
      const id = yield* newId(check.run, yield* nowIso);
      const kept = nothingKept();
      const handle = yield* spawnCheck(command);
      if (command.spec !== undefined) {
        const finishing = { check, command: { ...command, spec: command.spec } };
        yield* Effect.acquireRelease(
          Effect.sync(() => unrecordedChecks.set(id, { finishing, kept })),
          () => Effect.sync(() => unrecordedChecks.delete(id)),
        );
      }
      return runningOf(
        id,
        handle,
        kept,
        () => Effect.void,
        (collecting) => collecting,
      );
    }),
  finished: (id) =>
    Effect.sync(() => {
      const found = unrecordedChecks.get(id);
      return found === undefined ? null : { ...found.finishing, output: textOf(found.kept) };
    }),
  adopt: (_check, spawn) =>
    Effect.map(spawn({}), (handle) => ({ handle, collected: (collecting) => collecting })),
  handOver: Effect.succeed([]),
  takenOver: Effect.succeed([]),
  claim: () => Effect.succeed(null),
  endAll: Effect.succeed([]),
  killEnded: Effect.void,
  collecting: Effect.succeed([]),
  left: Effect.succeed([]),
  stillRuns: () => Effect.succeed(false),
  endLeftover: () => Effect.succeed("already gone"),
};

/** A check this host ended, or would not start once it began to end. */
const endedCheck: RunningCheck = {
  id: null,
  pid: Effect.succeed(null),
  stdout: Stream.empty,
  stderr: Stream.empty,
  exit: Effect.never,
  logged: false,
  collected: () => Effect.never,
};

export const CheckProcesses = Context.Reference<CheckProcessesApi>("collie/CheckProcesses", {
  defaultValue: () => unrecorded,
});

/** A process seen carrying a check's markers, by pid and start token. */
interface Marked {
  readonly pid: number;
  readonly started: string;
}

/** Every running process carrying this installation's binding, by the check id it carries. */
const markedBy = (installation: string) =>
  Effect.gen(function* () {
    const found = new Map<string, Marked[]>();
    for (const { pid, started, bound } of yield* boundProcesses([CHECK_INSTALLATION, CHECK_ID])) {
      const id = bound[CHECK_ID];
      if (pid === process.pid || bound[CHECK_INSTALLATION] !== installation || id === undefined)
        continue;
      if ((yield* groupOf(pid)) !== null)
        found.set(id, [...(found.get(id) ?? []), { pid, started }]);
    }
    return found;
  });

/** What of a check is proved still running: its group, while its leader is the recorded one, and each marked process. */
const provedIn = (
  record: Pick<CheckRecord, "id" | "leader">,
  marked: ReadonlyMap<string, ReadonlyArray<Marked>>,
) =>
  Effect.gen(function* () {
    const { leader } = record;
    const group =
      leader.started !== "" &&
      (yield* stillRunning(leader)) &&
      (yield* groupOf(leader.pid)) === leader.group
        ? leader.group
        : null;
    return { group, marked: marked.get(record.id) ?? [] };
  });
type Proved = Effect.Success<ReturnType<typeof provedIn>>;

const provedOf = (record: Pick<CheckRecord, "id" | "leader">, installation: string) =>
  Effect.flatMap(markedBy(installation), (marked) => provedIn(record, marked));

const isGone = (proved: Proved) => proved.group === null && proved.marked.length === 0;

/** Sends a signal, throwing where it cannot, as `process.kill` does. */
export type Kill = (target: number, name: NodeJS.Signals) => void;
const processKill: Kill = (target, name) => process.kill(target, name);

/** A marked process only while it is still the one seen marked. */
const signal = (
  proved: { readonly group: number | null; readonly marked: ReadonlyArray<Marked> },
  name: NodeJS.Signals,
  kill: Kill,
) =>
  Effect.gen(function* () {
    const send = (target: number) => {
      try {
        kill(target, name);
      } catch {
        // Gone already.
      }
    };
    if (proved.group !== null) send(-proved.group);
    for (const one of proved.marked) if (yield* stillRunning(one)) send(one.pid);
  });

/** Polls until nothing of it is proved running, or `within` is up; true where it is gone. */
const goneWithin = (
  record: Pick<CheckRecord, "id" | "leader">,
  installation: string,
  within: number,
) =>
  Effect.gen(function* () {
    const until = (yield* Clock.currentTimeMillis) + within;
    return yield* provedOf(record, installation).pipe(
      Effect.map(isGone),
      Effect.repeat({
        until: (gone) => gone,
        schedule: Schedule.spaced("100 millis").pipe(Schedule.while(({ now }) => now < until)),
      }),
    );
  });

/**
 * Ends one check for good: SIGTERM, up to two seconds, SIGKILL, and a last look, where a
 * zombie counts as gone. True where nothing of it is left.
 */
export const endCheck = Effect.fn("CheckProcesses.endCheck")(function* (
  record: Pick<CheckRecord, "id" | "leader">,
  installation: string,
  kill: Kill = processKill,
) {
  const proved = yield* provedOf(record, installation);
  if (isGone(proved)) return true;
  yield* signal(proved, "SIGTERM", kill);
  if (yield* goneWithin(record, installation, 2_000)) return true;
  yield* signal(yield* provedOf(record, installation), "SIGKILL", kill);
  return yield* goneWithin(record, installation, 1_000);
});

/** A check id is `<run>@<epoch ms>-<random hex>`. */
const runOfId = (id: string) =>
  pipe_(
    id,
    Str.slice(
      0,
      Option.getOrElse(pipe_(id, Str.lastIndexOf("@")), () => -1),
    ),
  );
const startOfId = (id: string) =>
  Number(
    Str.split(
      pipe_(id, Str.slice(Option.getOrElse(pipe_(id, Str.lastIndexOf("@")), () => -1) + 1)),
      "-",
    )[0],
  );

const checkNamed = (leftover: Leftover) =>
  leftover.name === null
    ? `check ${leftover.id}`
    : `check ${leftover.name}${leftover.pass === null ? "" : ` (pass ${leftover.pass})`}`;
const hostNamed = (leftover: Leftover) =>
  leftover.host === null
    ? "an earlier host"
    : `host ${leftover.host.pid} (started ${leftover.host.started})`;
const saidOf = (leftover: Leftover, outcome: LeftoverEnd) =>
  `${checkNamed(leftover)} of ${leftover.run}, left running by ${hostNamed(leftover)}: ${outcome}`;
const withPid = (leftover: Leftover) =>
  `${checkNamed(leftover)} of ${leftover.run} (pid ${leftover.leader.pid}), left running by ${hostNamed(leftover)}`;

interface Ending {
  readonly check: CheckOf;
  ended: boolean;
  /** Collected in full before its host began to end, so not among those it ended. */
  settled: boolean;
}

interface Collecting extends Ending {
  readonly record: CheckRecord;
  /** Run under a supervisor, so it can be handed over. */
  readonly supervised: boolean;
  /** Left to the host replacing this one, which alone collects it. */
  handed: boolean;
}

/** The checks a replaced host handed over, as it named itself and them. */
export interface HandedOver {
  readonly host: CheckRecord["host"];
  readonly checks: ReadonlyArray<string>;
}

/**
 * The host's adapter for the state directory `dir`, whose installation id is `installation`.
 * Building it ends every check a previous host left where `sweep` is true; where false, the
 * caller does. `onRun` is what ending one does on its Run, given the line `host.log` gets.
 */
export const hostCheckProcesses = Effect.fn("CheckProcesses.host")(function* (options: {
  readonly dir: string;
  readonly installation: string;
  readonly onRun?: (
    leftover: Leftover,
    outcome: LeftoverEnd,
    line: string,
  ) => Effect.Effect<void, never, FileSystem.FileSystem>;
  readonly kill?: Kill;
  readonly sweep: boolean;
  /** How to start `collie`, to run each check under its supervisor; absent, a check is this host's child. */
  readonly supervisor?: ReadonlyArray<string>;
  /** What the host this one replaced handed over to it, for it to collect. */
  readonly handedOver?: HandedOver;
}) {
  const { dir, installation, kill = processKill, supervisor } = options;
  const fs = yield* FileSystem.FileSystem;
  // Only these, so a check's spawn and finalizer stay in its caller's Scope.
  const services = Context.make(FileSystem.FileSystem, fs).pipe(
    Context.add(
      ChildProcessSpawner.ChildProcessSpawner,
      yield* ChildProcessSpawner.ChildProcessSpawner,
    ),
  );
  const collecting = new Map<string, Collecting>();
  const kept = new Map<string, Kept>();
  // Taken over from the host this one replaced, until a step or the host claims each.
  const unclaimed = new Map<
    string,
    { readonly entry: Collecting; readonly finishing: Finishing | null }
  >();
  let stopping = false;
  let killing = false;
  // Their processes carry their markers before their record is read.
  const spawning = new Map<string, Ending>();
  // From before its spawn, so no check of this host is ever taken for a leftover.
  const ours = new Set<string>();
  const host = { pid: process.pid, started: (yield* startedOf(process.pid)) ?? "" };

  const untrack = (id: string) => Effect.sync(() => collecting.delete(id));
  const forget = (id: string) => removeRecord(fs, dir, id).pipe(Effect.andThen(untrack(id)));
  /** As a check's Scope closes: ended for good, unless it was handed over. */
  const endOwn = (entry: Collecting) =>
    Effect.suspend(() =>
      entry.handed
        ? Effect.void
        : endCheck(entry.record, installation, kill).pipe(
            // Its record is its only proof where /proc cannot be read, so it stays until it is gone.
            Effect.flatMap((gone) => (gone ? forget(entry.record.id) : untrack(entry.record.id))),
            Effect.ignore,
          ),
    ).pipe(Effect.provideContext(services));

  /** A taken-over check's exit status, once its supervisor has written it. */
  const exitOf = (record: CheckRecord): Effect.Effect<number, PlatformError> =>
    Effect.gen(function* () {
      for (;;) {
        const running = yield* stillRunning(record.leader);
        const exit = yield* exitIn(fs, dir, record.id).pipe(Effect.option);
        if (Option.isSome(exit)) return exit.value;
        if (!running) return yield* exitIn(fs, dir, record.id);
        yield* Effect.sleep("250 millis");
      }
    }).pipe(Effect.provideContext(services));

  const left = Effect.gen(function* () {
    const found = new Map<string, Leftover>();
    for (const record of yield* recordsIn(dir).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
    )) {
      if (ours.has(record.id)) continue;
      found.set(record.id, {
        id: record.id,
        run: record.run,
        name: record.name,
        pass: record.pass ?? null,
        leader: record.leader,
        recorded: true,
        host: record.host,
        started: epochMs(record.started),
      });
    }
    for (const [id, ones] of yield* markedBy(installation)) {
      if (found.has(id) || ours.has(id)) continue;
      const first = Arr.reduce(
        Arr.drop(ones, 1),
        Option.getOrThrow(Arr.head(ones)),
        (least, one) => (one.pid < least.pid ? one : least),
      );
      found.set(id, {
        id,
        run: runOfId(id),
        name: null,
        pass: null,
        leader: {
          pid: first.pid,
          started: first.started,
          group: (yield* groupOf(first.pid)) ?? first.pid,
        },
        recorded: false,
        host: null,
        started: startOfId(id),
      });
    }
    return [...found.values()];
  }).pipe(Effect.provideContext(services));

  const proofOf = (leftover: Leftover) => ({
    id: leftover.id,
    leader: leftover.recorded ? leftover.leader : { ...leftover.leader, started: "" },
  });

  const stillRuns = (leftover: Leftover) =>
    provedOf(proofOf(leftover), installation).pipe(
      Effect.map((proved) => !isGone(proved)),
      Effect.provideContext(services),
    );

  const endLeftover = (leftover: Leftover) =>
    Effect.gen(function* () {
      const proof = proofOf(leftover);
      const outcome: LeftoverEnd = isGone(yield* provedOf(proof, installation))
        ? "already gone"
        : (yield* endCheck(proof, installation, kill))
          ? "ended"
          : "still running";
      if (outcome !== "still running") yield* removeRecord(fs, dir, leftover.id);
      const line = saidOf(leftover, outcome);
      yield* Effect.logInfo(line);
      if (options.onRun !== undefined) yield* options.onRun(leftover, outcome, line);
      return outcome;
    }).pipe(Effect.provideContext(services));

  // What the last look at /proc found of each check, so the next signal needs no look first.
  const found = new Map<string, ReadonlyArray<Marked>>();
  type Look = Effect.Success<ReturnType<typeof markedBy>>;
  // The look at /proc under way, whose answer a later signal takes too, without waiting on it alone.
  let looking: Deferred.Deferred<Look> | undefined;
  const freshLook = Effect.suspend(() => {
    const deferred = Deferred.makeUnsafe<Look>();
    looking ??= deferred;
    return markedBy(installation).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (looking === deferred) looking = undefined;
          Deferred.doneUnsafe(deferred, Exit.isSuccess(exit) ? exit : Exit.succeed(new Map()));
        }),
      ),
    );
  });
  const signalMarked = (ids: ReadonlyArray<string>, name: NodeJS.Signals) => (look: Look) =>
    Effect.forEach(ids, (id) =>
      Effect.gen(function* () {
        const ones = look.get(id) ?? [];
        yield* signal({ group: null, marked: ones }, name, kill);
        const known = new Map(Arr.map(found.get(id) ?? [], (one) => [one.pid, one]));
        for (const one of ones) known.set(one.pid, one);
        found.set(id, [...known.values()]);
      }),
    );
  /**
   * Each group, then each process found before, before the look at /proc, so a slow look holds
   * back none of them. A look already under way is signalled from as it answers, beside a fresh
   * one, which alone sees a process born since.
   */
  const signalAll = (ids: ReadonlyArray<string>, name: NodeJS.Signals) =>
    Effect.gen(function* () {
      for (const id of ids) {
        const entry = collecting.get(id);
        if (entry !== undefined)
          yield* signal(yield* provedIn(entry.record, new Map()), name, kill);
      }
      for (const id of ids) yield* signal({ group: null, marked: found.get(id) ?? [] }, name, kill);
      const earlier = looking;
      yield* Effect.all(
        [
          earlier === undefined
            ? Effect.void
            : Deferred.await(earlier).pipe(Effect.flatMap(signalMarked(ids, name))),
          freshLook.pipe(Effect.flatMap(signalMarked(ids, name))),
        ],
        { concurrency: "unbounded", discard: true },
      );
    });
  const own = () => Arr.filter([...collecting.values()], (entry) => !entry.handed);
  const unended = () => [...Arr.map(own(), (entry) => entry.record.id), ...spawning.keys()];

  /** Ends each of the Run's leftovers once, announced first, and refuses where one survives (D6). */
  const clearOf = (run: string, say: (line: string) => Effect.Effect<void>) =>
    Effect.gen(function* () {
      if (stopping) return;
      const leftovers = Arr.filter(yield* left, (leftover) => leftover.run === run);
      const surviving = yield* Effect.forEach(
        leftovers,
        (leftover) =>
          Effect.gen(function* () {
            if (yield* stillRuns(leftover))
              yield* say(`${withPid(leftover)}: ending it before this check starts`);
            return (yield* endLeftover(leftover)) === "still running" ? [leftover] : [];
          }),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((ones) => ones.flat()));
      const [first] = surviving;
      if (first !== undefined && !stopping)
        return yield* new CheckRefused({
          why: `${withPid(first)}, survived SIGTERM and SIGKILL, so this check did not start`,
        });
    });

  /** Spawns it marked, records its leader, and ends it with the caller's Scope; null where this host is ending. */
  const begin = <H extends { readonly pid: number }, E>(
    check: CheckOf,
    spawn: (
      markers: Readonly<Record<string, string>>,
      id: string,
    ) => Effect.Effect<H, E, Scope.Scope>,
    say: (line: string) => Effect.Effect<void>,
    supervised = false,
  ) =>
    Effect.gen(function* () {
      if (stopping) return null;
      const began = yield* nowIso;
      const id = yield* newId(check.run, began);
      ours.add(id);
      yield* Effect.addFinalizer(() => Effect.sync(() => ours.delete(id)));
      yield* clearOf(check.run, say);
      // From the spawn to its finalizer, so no interruption leaves it unended.
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          if (stopping) return null;
          spawning.set(id, { check, ended: false, settled: false });
          const { handle, record, entry } = yield* Effect.gen(function* () {
            const handle = yield* spawn(
              {
                [CHECK_INSTALLATION]: installation,
                [CHECK_ID]: id,
              },
              id,
            );
            const record: CheckRecord = {
              id,
              run: check.run,
              name: check.name,
              ...(check.pass !== undefined && { pass: check.pass.pass }),
              ...(check.pass?.round !== undefined && { round: check.pass.round }),
              by: check.by,
              leader: {
                pid: handle.pid,
                started: (yield* startedOf(handle.pid)) ?? "",
                group: (yield* groupOf(handle.pid)) ?? handle.pid,
              },
              host,
              started: began,
            };
            const entry: Collecting = {
              check,
              record,
              ended: stopping,
              settled: false,
              supervised,
              handed: false,
            };
            collecting.set(id, entry);
            return { handle, record, entry };
          }).pipe(
            Effect.onError(() => removeRecord(fs, dir, id)),
            Effect.ensuring(Effect.sync(() => spawning.delete(id))),
          );
          yield* Effect.addFinalizer(() => endOwn(entry));
          if (entry.ended) yield* signalAll([id], killing ? "SIGKILL" : "SIGTERM");
          yield* fs.makeDirectory(runningChecksDir(dir), { recursive: true }).pipe(Effect.ignore);
          yield* fs
            .writeFileString(`${recordPath(dir, id)}.new`, encodeCheckRecord(record))
            .pipe(
              Effect.andThen(fs.rename(`${recordPath(dir, id)}.new`, recordPath(dir, id))),
              Effect.ignore,
            );
          return { handle, entry };
        }),
      );
    }).pipe(Effect.provideContext(services));

  const collectedOf =
    (entry: Collecting): RunningCheck["collected"] =>
    (collecting) =>
      collecting.pipe(
        Effect.exit,
        Effect.flatMap((exit) => {
          if (entry.ended || entry.handed) return Effect.never;
          entry.settled = true;
          return exit;
        }),
      );

  const run: CheckProcessesApi["run"] = (check, command, say = () => Effect.void) =>
    Effect.gen(function* () {
      const taken = Arr.findFirst([...unclaimed.values()], ({ finishing }) =>
        sameCheck(finishing, check, command),
      );
      if (Option.isSome(taken)) {
        const running = yield* claim(taken.value.entry.record.id);
        if (running !== null) return running;
      }
      return yield* runAnew(check, command, say);
    });

  const runAnew: CheckProcessesApi["run"] = (check, command, say = () => Effect.void) =>
    begin(
      check,
      (markers, id) =>
        fs.makeDirectory(checkOutputDir(dir), { recursive: true }).pipe(
          Effect.ignore,
          Effect.andThen(
            command.spec === undefined
              ? Effect.void
              : writeFinishing(fs, dir, id, {
                  check,
                  command: { ...command, argv: [...command.argv], spec: command.spec },
                }),
          ),
          Effect.andThen(
            supervisor === undefined
              ? spawnCheck(command, markers)
              : spawnSupervised(supervisor, dir, id, command, markers),
          ),
          Effect.provideContext(services),
        ),
      say,
      supervisor !== undefined,
    ).pipe(
      Effect.flatMap((begun) => {
        if (begun === null) return Effect.succeed(endedCheck);
        const { handle, entry } = begun;
        const { id } = entry.record;
        const ends = nothingKept();
        const store = (name: keyof Kept, bytes: Uint8Array) => {
          const path = outputsOf(dir, id)[name];
          // A file that may be cut short is worse than none: without it, only this host finishes it.
          return fs.writeFile(path, bytes).pipe(
            Effect.catch(() => fs.remove(path, { force: true })),
            Effect.ignore,
          );
        };
        const running = runningOf(
          id,
          handle,
          ends,
          entry.supervised ? () => Effect.void : store,
          collectedOf(entry),
        );
        return Effect.acquireRelease(
          Effect.sync(() => kept.set(id, ends)),
          () => Effect.sync(() => kept.delete(id)),
        ).pipe(
          Effect.as(
            entry.supervised
              ? {
                  ...running,
                  pid: commandPid(fs, dir, id, handle),
                  exit: handle.exitCode.pipe(Effect.andThen(exitIn(fs, dir, id))),
                  logged: true,
                }
              : running,
          ),
        );
      }),
    );

  const claim: CheckProcessesApi["claim"] = (id) =>
    Effect.gen(function* () {
      const entry = unclaimed.get(id)?.entry;
      if (entry === undefined) return null;
      unclaimed.delete(id);
      yield* Effect.addFinalizer(() => endOwn(entry));
      return {
        id,
        pid: pidIn(fs, dir, id).pipe(Effect.orElseSucceed(() => entry.record.leader.pid)),
        stdout: Stream.empty,
        stderr: Stream.empty,
        exit: exitOf(entry.record),
        logged: true,
        collected: collectedOf(entry),
      } satisfies RunningCheck;
    });

  /** From what this host kept of a check it runs, or else from the files its host stored. */
  const finished: CheckProcessesApi["finished"] = (id) =>
    Effect.gen(function* () {
      const finishing = yield* readFinishing(fs, dir, id);
      if (finishing === null) return null;
      const own = kept.get(id);
      if (own !== undefined) return { ...finishing, output: textOf(own) };
      const outputs = outputsOf(dir, id);
      const [stdout, stderr] = yield* Effect.all([
        fs.readFile(outputs.stdout),
        fs.readFile(outputs.stderr),
      ]);
      return { ...finishing, output: textOf({ stdout, stderr }) };
    }).pipe(Effect.orElseSucceed(() => null));

  const adopt: CheckProcessesApi["adopt"] = (check, spawn, say = () => Effect.void) =>
    begin(check, spawn, say).pipe(
      Effect.map((begun) =>
        begun === null ? null : { handle: begun.handle, collected: collectedOf(begun.entry) },
      ),
    );

  const handOver = Effect.sync(() => {
    const handed: string[] = [];
    for (const entry of collecting.values()) {
      if (!entry.supervised || entry.ended || entry.settled) continue;
      entry.handed = true;
      handed.push(entry.record.id);
    }
    return handed;
  });

  const endAll = Effect.gen(function* () {
    stopping = true;
    const ended: CheckOf[] = [];
    for (const entry of [...own(), ...spawning.values()]) {
      if (entry.ended || entry.settled) continue;
      entry.ended = true;
      ended.push(entry.check);
    }
    yield* signalAll(unended(), "SIGTERM");
    return ended;
  }).pipe(Effect.provideContext(services));

  const killEnded = Effect.gen(function* () {
    stopping = true;
    killing = true;
    for (const entry of own()) entry.ended = true;
    yield* signalAll(unended(), "SIGKILL");
    const until = (yield* Clock.currentTimeMillis) + KILL_WAIT;
    for (;;) {
      const marked = yield* markedBy(installation);
      for (const entry of own()) {
        const proved = yield* provedIn(entry.record, marked);
        if (isGone(proved)) yield* forget(entry.record.id);
        else yield* signal(proved, "SIGKILL", kill);
      }
      for (const id of spawning.keys())
        yield* signal({ group: null, marked: marked.get(id) ?? [] }, "SIGKILL", kill);
      if (own().length === 0 && spawning.size === 0) return;
      if ((yield* Clock.currentTimeMillis) >= until) return;
      yield* Effect.sleep("100 millis");
    }
  }).pipe(Effect.provideContext(services));

  /** Collects each check handed over that is proved its supervisor's, by pid and start token (D2), as this host's. */
  const takeOver = (handed: HandedOver) =>
    Effect.gen(function* () {
      for (const record of yield* recordsIn(dir)) {
        if (
          !handed.checks.includes(record.id) ||
          record.host.pid !== handed.host.pid ||
          record.host.started !== handed.host.started
        )
          continue;
        const proved =
          (yield* stillRunning(record.leader)) &&
          (yield* groupOf(record.leader.pid)) === record.leader.group;
        const exited = yield* fs.exists(outputsOf(dir, record.id).exit);
        if (!proved && !exited) continue;
        const taken: CheckRecord = { ...record, host };
        yield* fs
          .writeFileString(`${recordPath(dir, record.id)}.new`, encodeCheckRecord(taken))
          .pipe(
            Effect.andThen(
              fs.rename(`${recordPath(dir, record.id)}.new`, recordPath(dir, record.id)),
            ),
          );
        const entry: Collecting = {
          check: checkOfRecord(record),
          record: taken,
          ended: false,
          settled: false,
          supervised: true,
          handed: false,
        };
        ours.add(record.id);
        collecting.set(record.id, entry);
        unclaimed.set(record.id, {
          entry,
          finishing: yield* readFinishing(fs, dir, record.id).pipe(
            Effect.orElseSucceed(() => null),
          ),
        });
        yield* Effect.logInfo(
          `took over check ${record.name} of ${record.run} from host ${handed.host.pid}`,
        );
      }
    }).pipe(Effect.ignore({ log: "Warn" }));

  if (options.handedOver !== undefined)
    yield* takeOver(options.handedOver).pipe(Effect.provideContext(services));
  if (options.sweep)
    yield* Effect.forEach(yield* left, endLeftover, { concurrency: "unbounded", discard: true });
  return {
    run,
    finished,
    adopt,
    handOver,
    takenOver: Effect.sync(() => Arr.map([...unclaimed.values()], ({ entry }) => entry.record)),
    claim,
    endAll,
    killEnded,
    collecting: Effect.sync(() => [...collecting.keys()]),
    left,
    stillRuns,
    endLeftover,
  } satisfies CheckProcessesApi;
});

/** How long past its grace a stop waits for its SIGKILL and the last look after it: under the host's stop slack. */
export const KILL_CEILING = Duration.seconds(3);

/**
 * SIGTERM to what `checks` is collecting at once, SIGKILL in the grace's last fifth, and done
 * when the grace is, or once that SIGKILL is done, up to `KILL_CEILING` later.
 */
export const endAllWithin = (
  checks: CheckProcessesApi,
  grace: Duration.Duration,
  onEnded: (ended: ReadonlyArray<CheckOf>) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const ending = yield* Effect.forkChild(
      Effect.all(
        [
          checks.endAll.pipe(Effect.flatMap(onEnded)),
          Effect.sleep(Duration.millis(Duration.toMillis(grace) * 0.8)).pipe(
            Effect.andThen(checks.killEnded),
          ),
        ],
        { concurrency: 2, discard: true },
      ),
    );
    yield* Effect.sleep(grace);
    yield* Fiber.await(ending).pipe(Effect.timeoutOption(KILL_CEILING));
    yield* Fiber.interrupt(ending);
  });
