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
import { RUNNING_CHECK, RunRecords } from "./run-records";
import type { RunRecordsApi } from "./run-records";
import { epochMs, nowIso } from "./time";
import { FailedTestSchema, VerificationSchema } from "./verify-model";

export const CHECK_INSTALLATION = "COLLIE_CHECK_INSTALLATION";
export const CHECK_ID = "COLLIE_CHECK_ID";
const KILL_AFTER = "2 seconds";
const KILL_WAIT = 1000;

export interface CheckOf {
  readonly run: string;
  readonly name: string;
  readonly pass?: { readonly pass: string; readonly round?: number };
  readonly by: "agent" | "collie";
}

const SpecSchema = Schema.Struct({
  evidence: Schema.String,
  asked: Schema.String,
  start: VerificationSchema.fields.start,
  began: Schema.String,
  expect: Schema.Literals(["pass", "fail"]),
  step: Schema.NullOr(Schema.Struct({ step: Schema.String, place: Schema.NullOr(StepPlace) })),
  log: Schema.optionalKey(Schema.String),
  test: Schema.optionalKey(FailedTestSchema),
  own: VerificationSchema.fields.own,
  environment: Schema.optionalKey(Schema.String),
});
type CheckSpec = typeof SpecSchema.Type;

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

export interface FinishedCheck extends Finishing {
  readonly output: { readonly stdout: string; readonly stderr: string };
}

export interface RunningCheck {
  readonly id: string | null;
  readonly pid: Effect.Effect<number | null>;
  readonly stdout: Stream.Stream<Uint8Array, PlatformError>;
  readonly stderr: Stream.Stream<Uint8Array, PlatformError>;
  readonly exit: Effect.Effect<number, PlatformError>;
  readonly logged: boolean;
  // WARNING: never completes for a check this host ended (D4).
  readonly collected: <A, E, R>(collecting: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

export interface AdoptedCheck<H> {
  readonly handle: H;
  readonly collected: RunningCheck["collected"];
}

export interface Leftover {
  readonly id: string;
  readonly run: string;
  readonly name: string | null;
  readonly pass: string | null;
  readonly leader: { readonly pid: number; readonly started: string; readonly group: number };
  readonly recorded: boolean;
  readonly host: { readonly pid: number; readonly started: string } | null;
  readonly started: number;
}

export type LeftoverEnd = "ended" | "already gone" | "still running";

export class CheckRefused extends Data.TaggedError("CheckRefused")<{ readonly why: string }> {}

export interface CheckProcessesApi {
  readonly run: (
    check: CheckOf,
    command: CheckCommand,
    say?: (line: string) => Effect.Effect<void>,
  ) => Effect.Effect<
    RunningCheck,
    PlatformError | CheckRefused,
    Scope.Scope | ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
  >;
  readonly finished: (id: string) => Effect.Effect<FinishedCheck | null, PlatformError>;
  readonly adopt: <H extends { readonly pid: number }>(
    check: CheckOf,
    spawn: (markers: Readonly<Record<string, string>>) => Effect.Effect<H>,
    say?: (line: string) => Effect.Effect<void>,
  ) => Effect.Effect<AdoptedCheck<H> | null, CheckRefused, Scope.Scope>;
  // WARNING: a handed-over check is neither ended nor collected by this host from now on.
  readonly handOver: Effect.Effect<ReadonlyArray<string>>;
  readonly takenOver: Effect.Effect<ReadonlyArray<CheckRecord>>;
  readonly claim: (id: string) => Effect.Effect<RunningCheck | null, never, Scope.Scope>;
  readonly endAll: Effect.Effect<ReadonlyArray<CheckOf>>;
  // WARNING: includes a check still being spawned; its record goes only once it is gone.
  readonly killEnded: Effect.Effect<void>;
  readonly collecting: Effect.Effect<ReadonlyArray<string>>;
  readonly left: Effect.Effect<ReadonlyArray<Leftover>>;
  readonly stillRuns: (leftover: Leftover) => Effect.Effect<boolean>;
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

const checkOutputDir = (stateDir: string) => `${stateDir}/check-output`;
const outputsOf = (stateDir: string, id: string) => checkFiles(checkOutputDir(stateDir), id);

const finishingPath = (stateDir: string, id: string) => `${checkOutputDir(stateDir)}/${id}.json`;

const removeRecord = (
  fs: FileSystem.FileSystem,
  records: RunRecordsApi,
  stateDir: string,
  id: string,
) => {
  const outputs = outputsOf(stateDir, id);
  return Effect.andThen(
    records.setControl(RUNNING_CHECK, "", null, id),
    Effect.forEach(
      [finishingPath(stateDir, id), outputs.stdout, outputs.stderr, outputs.pid, outputs.exit],
      (path) => fs.remove(path, { force: true }).pipe(Effect.ignore),
      { discard: true },
    ),
  );
};

const writeWhole = (fs: FileSystem.FileSystem, path: string, text: string) =>
  fs.writeFileString(`${path}.new`, text).pipe(
    Effect.andThen(fs.rename(`${path}.new`, path)),
    Effect.tapError(() => fs.remove(`${path}.new`, { force: true }).pipe(Effect.ignore)),
  );

const writeFinishing = (
  fs: FileSystem.FileSystem,
  stateDir: string,
  id: string,
  finishing: Finishing,
) => writeWhole(fs, finishingPath(stateDir, id), encodeFinishing(finishing));

const readFinishing = (fs: FileSystem.FileSystem, stateDir: string, id: string) =>
  fs
    .readFileString(finishingPath(stateDir, id))
    .pipe(Effect.map((text) => Option.getOrNull(decodeFinishing(text))));

export const runningChecks = RunRecords.use((records) => records.everyControl(RUNNING_CHECK)).pipe(
  Effect.map((rows) => Arr.getSomes(Arr.map(rows, (row) => decodeRecord(row.data)))),
);

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
      // WARNING: unref'd so a host handing over leaves the supervisor running.
      .pipe(Effect.tap((handle) => handle.unref)),
  );

const pidIn = (fs: FileSystem.FileSystem, stateDir: string, id: string) =>
  fs.readFileString(outputsOf(stateDir, id).pid).pipe(Effect.map((text) => Number(Str.trim(text))));

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

const exitIn = (fs: FileSystem.FileSystem, stateDir: string, id: string) =>
  fs
    .readFileString(outputsOf(stateDir, id).exit)
    .pipe(Effect.map((text) => Number(Str.trim(text))));

const checkOfRecord: (record: CheckRecord) => CheckOf = (record) => ({
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

interface Kept {
  stdout: Uint8Array;
  stderr: Uint8Array;
}
const nothingKept = () => ({ stdout: new Uint8Array(), stderr: new Uint8Array() });
const textOf = (kept: Kept) => ({
  stdout: new TextDecoder().decode(kept.stdout),
  stderr: new TextDecoder().decode(kept.stderr),
});

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
) => ({
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

// WARNING: in memory only; nothing outside this process could finish an unrecorded check.
const unrecordedChecks = new Map<string, { readonly finishing: Finishing; readonly kept: Kept }>();

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

interface Marked {
  readonly pid: number;
  readonly started: string;
}

const markedBy = (installation: string) =>
  Effect.gen(function* () {
    const found = new Map<string, Array<Marked>>();
    for (const { pid, started, bound } of yield* boundProcesses([CHECK_INSTALLATION, CHECK_ID])) {
      const id = bound[CHECK_ID];
      if (pid === process.pid || bound[CHECK_INSTALLATION] !== installation || id === undefined) {
        continue;
      }
      if ((yield* groupOf(pid)) !== null) {
        found.set(id, [...(found.get(id) ?? []), { pid, started }]);
      }
    }
    return found;
  });

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

export type Kill = (target: number, name: NodeJS.Signals) => void;
const processKill: Kill = (target, name) => process.kill(target, name);

// WARNING: signals nothing not proved to be the check's: its pid and start token must still match.
const signal = (
  proved: { readonly group: number | null; readonly marked: ReadonlyArray<Marked> },
  name: NodeJS.Signals,
  kill: Kill,
) =>
  Effect.gen(function* () {
    const send = (target: number) => {
      try {
        kill(target, name);
      } catch {}
    };
    if (proved.group !== null) {
      send(-proved.group);
    }
    for (const one of proved.marked) {
      if (yield* stillRunning(one)) {
        send(one.pid);
      }
    }
  });

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

// WARNING: a zombie counts as gone.
export const endCheck = Effect.fn("CheckProcesses.endCheck")(function* (
  record: Pick<CheckRecord, "id" | "leader">,
  installation: string,
  kill: Kill = processKill,
) {
  const proved = yield* provedOf(record, installation);
  if (isGone(proved)) {
    return true;
  }
  yield* signal(proved, "SIGTERM", kill);
  if (yield* goneWithin(record, installation, 2000)) {
    return true;
  }
  yield* signal(yield* provedOf(record, installation), "SIGKILL", kill);
  return yield* goneWithin(record, installation, 1000);
});

// WARNING: ids are <run>@<epoch ms>-<hex>; runOfId parses that shape.
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
  settled: boolean;
}

interface Collecting extends Ending {
  readonly record: CheckRecord;
  readonly supervised: boolean;
  handed: boolean;
}

export interface HandedOver {
  readonly host: CheckRecord["host"];
  readonly checks: ReadonlyArray<string>;
}

// WARNING: building it ends the checks a previous host left, where sweep is true.
export const hostCheckProcesses = Effect.fn("CheckProcesses.host")(function* (options: {
  readonly dir: string;
  readonly installation: string;
  readonly onRun?: (
    leftover: Leftover,
    outcome: LeftoverEnd,
    line: string,
  ) => Effect.Effect<void, never, FileSystem.FileSystem | RunRecords>;
  readonly kill?: Kill;
  readonly sweep: boolean;
  readonly supervisor?: ReadonlyArray<string>;
  readonly handedOver?: HandedOver;
}) {
  const { dir, installation, kill = processKill, supervisor } = options;
  const fs = yield* FileSystem.FileSystem;
  const records = yield* RunRecords;
  // WARNING: only these services, so a check's spawn and finalizer stay in its caller's Scope.
  const services = Context.make(FileSystem.FileSystem, fs).pipe(
    Context.add(
      ChildProcessSpawner.ChildProcessSpawner,
      yield* ChildProcessSpawner.ChildProcessSpawner,
    ),
  );
  const collecting = new Map<string, Collecting>();
  const kept = new Map<string, Kept>();
  const unclaimed = new Map<
    string,
    { readonly entry: Collecting; readonly finishing: Finishing | null }
  >();
  let stopping = false;
  let killing = false;
  // WARNING: a spawning check's processes carry their markers before its record is read.
  const spawning = new Map<string, Ending>();
  // WARNING: added before the spawn, so no check of this host is ever taken for a leftover.
  const ours = new Set<string>();
  const host = { pid: process.pid, started: (yield* startedOf(process.pid)) ?? "" };

  const untrack = (id: string) => Effect.sync(() => collecting.delete(id));
  const forget = (id: string) =>
    removeRecord(fs, records, dir, id).pipe(Effect.andThen(untrack(id)));
  const endOwn = (entry: Collecting) =>
    Effect.suspend(() =>
      entry.handed
        ? Effect.void
        : endCheck(entry.record, installation, kill).pipe(
            // WARNING: where /proc cannot be read the record is the only proof, so it stays until the check is gone.
            Effect.flatMap((gone) => (gone ? forget(entry.record.id) : untrack(entry.record.id))),
            Effect.ignore,
          ),
    ).pipe(Effect.provideContext(services));

  const exitOf = (record: CheckRecord) =>
    Effect.gen(function* () {
      for (;;) {
        const running = yield* stillRunning(record.leader);
        const exit = yield* exitIn(fs, dir, record.id).pipe(Effect.option);
        if (Option.isSome(exit)) {
          return exit.value;
        }
        if (!running) {
          return yield* exitIn(fs, dir, record.id);
        }
        yield* Effect.sleep("250 millis");
      }
    }).pipe(Effect.provideContext(services));

  const left = Effect.gen(function* () {
    const found = new Map<string, Leftover>();
    for (const record of yield* runningChecks.pipe(Effect.provideService(RunRecords, records))) {
      if (ours.has(record.id)) {
        continue;
      }
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
      if (found.has(id) || ours.has(id)) {
        continue;
      }
      const first = Arr.reduce(Arr.drop(ones, 1), Option.getOrThrow(Arr.head(ones)), (least, one) =>
        one.pid < least.pid ? one : least,
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
      if (outcome !== "still running") {
        yield* removeRecord(fs, records, dir, leftover.id);
      }
      const line = saidOf(leftover, outcome);
      yield* Effect.logInfo(line);
      if (options.onRun !== undefined) {
        yield* options
          .onRun(leftover, outcome, line)
          .pipe(Effect.provideService(RunRecords, records));
      }
      return outcome;
    }).pipe(Effect.provideContext(services));

  const found = new Map<string, ReadonlyArray<Marked>>();
  type Look = Effect.Success<ReturnType<typeof markedBy>>;
  let looking: Deferred.Deferred<Look> | undefined;
  const freshLook = Effect.suspend(() => {
    const deferred = Deferred.makeUnsafe<Look>();
    looking ??= deferred;
    return markedBy(installation).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (looking === deferred) {
            looking = undefined;
          }
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
        for (const one of ones) {
          known.set(one.pid, one);
        }
        found.set(id, [...known.values()]);
      }),
    );
  // WARNING: a look already under way is not enough: a fresh one alone sees a process born since.
  const signalAll = (ids: ReadonlyArray<string>, name: NodeJS.Signals) =>
    Effect.gen(function* () {
      for (const id of ids) {
        const entry = collecting.get(id);
        if (entry !== undefined) {
          yield* signal(yield* provedIn(entry.record, new Map()), name, kill);
        }
      }
      for (const id of ids) {
        yield* signal({ group: null, marked: found.get(id) ?? [] }, name, kill);
      }
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

  const clearOf = (run: string, say: (line: string) => Effect.Effect<void>) =>
    Effect.gen(function* () {
      if (stopping) {
        return;
      }
      const leftovers = Arr.filter(yield* left, (leftover) => leftover.run === run);
      const surviving = yield* Effect.forEach(
        leftovers,
        (leftover) =>
          Effect.gen(function* () {
            if (yield* stillRuns(leftover)) {
              yield* say(`${withPid(leftover)}: ending it before this check starts`);
            }
            return (yield* endLeftover(leftover)) === "still running" ? [leftover] : [];
          }),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((ones) => ones.flat()));
      const [first] = surviving;
      if (first !== undefined && !stopping) {
        return yield* new CheckRefused({
          why: `${withPid(first)}, survived SIGTERM and SIGKILL, so this check did not start`,
        });
      }
    });

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
      if (stopping) {
        return null;
      }
      const began = yield* nowIso;
      const id = yield* newId(check.run, began);
      ours.add(id);
      yield* Effect.addFinalizer(() => Effect.sync(() => ours.delete(id)));
      yield* clearOf(check.run, say);
      // WARNING: uninterruptible from spawn to finalizer, so no interruption leaves a check unended.
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          if (stopping) {
            return null;
          }
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
            Effect.onError(() => removeRecord(fs, records, dir, id)),
            Effect.ensuring(Effect.sync(() => spawning.delete(id))),
          );
          yield* Effect.addFinalizer(() => endOwn(entry));
          if (entry.ended) {
            yield* signalAll([id], killing ? "SIGKILL" : "SIGTERM");
          }
          yield* records.setControl(RUNNING_CHECK, "", encodeCheckRecord(record), id);
          return { handle, entry };
        }),
      );
    }).pipe(Effect.provideContext(services));

  const collectedOf: (entry: Collecting) => RunningCheck["collected"] = (entry) => (collecting) =>
    collecting.pipe(
      Effect.exit,
      Effect.flatMap((exit) => {
        if (entry.ended || entry.handed) {
          return Effect.never;
        }
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
        if (running !== null) {
          return running;
        }
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
        if (begun === null) {
          return Effect.succeed(endedCheck);
        }
        const { handle, entry } = begun;
        const { id } = entry.record;
        const ends = nothingKept();
        const store = (name: keyof Kept, bytes: Uint8Array) => {
          const path = outputsOf(dir, id)[name];
          // WARNING: a file cut short is worse than none; without it only this host finishes the check.
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
        // WARNING: a supervised check is finished from its supervisor's files, which may not exist yet.
        if (entry.supervised) {
          return Effect.succeed({
            ...running,
            pid: commandPid(fs, dir, id, handle),
            exit: handle.exitCode.pipe(Effect.andThen(exitIn(fs, dir, id))),
            logged: true,
          });
        }
        return Effect.acquireRelease(
          Effect.sync(() => kept.set(id, ends)),
          () => Effect.sync(() => kept.delete(id)),
        ).pipe(Effect.as(running));
      }),
    );

  const claim: CheckProcessesApi["claim"] = (id) =>
    Effect.gen(function* () {
      const entry = unclaimed.get(id)?.entry;
      if (entry === undefined) {
        return null;
      }
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

  const finished: CheckProcessesApi["finished"] = (id) =>
    Effect.gen(function* () {
      const finishing = yield* readFinishing(fs, dir, id).pipe(Effect.orElseSucceed(() => null));
      if (finishing === null) {
        return null;
      }
      const own = kept.get(id);
      if (own !== undefined) {
        return { ...finishing, output: textOf(own) };
      }
      const outputs = outputsOf(dir, id);
      const [stdout, stderr] = yield* Effect.all([
        fs.readFile(outputs.stdout),
        fs.readFile(outputs.stderr),
      ]);
      return { ...finishing, output: textOf({ stdout, stderr }) };
    });

  const adopt: CheckProcessesApi["adopt"] = (check, spawn, say = () => Effect.void) =>
    begin(check, spawn, say).pipe(
      Effect.map((begun) =>
        begun === null ? null : { handle: begun.handle, collected: collectedOf(begun.entry) },
      ),
    );

  const handOver = Effect.sync(() => {
    const handed: Array<string> = [];
    for (const entry of collecting.values()) {
      if (!entry.supervised || entry.ended || entry.settled) {
        continue;
      }
      entry.handed = true;
      handed.push(entry.record.id);
    }
    return handed;
  });

  const endAll = Effect.gen(function* () {
    stopping = true;
    const ended: Array<CheckOf> = [];
    for (const entry of [...own(), ...spawning.values()]) {
      if (entry.ended || entry.settled) {
        continue;
      }
      entry.ended = true;
      ended.push(entry.check);
    }
    yield* signalAll(unended(), "SIGTERM");
    return ended;
  }).pipe(Effect.provideContext(services));

  const killEnded = Effect.gen(function* () {
    stopping = true;
    killing = true;
    for (const entry of own()) {
      entry.ended = true;
    }
    yield* signalAll(unended(), "SIGKILL");
    const until = (yield* Clock.currentTimeMillis) + KILL_WAIT;
    for (;;) {
      const marked = yield* markedBy(installation);
      for (const entry of own()) {
        const proved = yield* provedIn(entry.record, marked);
        if (isGone(proved)) {
          yield* forget(entry.record.id);
        } else {
          yield* signal(proved, "SIGKILL", kill);
        }
      }
      for (const id of spawning.keys()) {
        yield* signal({ group: null, marked: marked.get(id) ?? [] }, "SIGKILL", kill);
      }
      if (own().length === 0 && spawning.size === 0) {
        return;
      }
      if ((yield* Clock.currentTimeMillis) >= until) {
        return;
      }
      yield* Effect.sleep("100 millis");
    }
  }).pipe(Effect.provideContext(services));

  const takeOver = (handed: HandedOver) =>
    Effect.gen(function* () {
      for (const record of yield* runningChecks.pipe(Effect.provideService(RunRecords, records))) {
        if (
          !handed.checks.includes(record.id) ||
          record.host.pid !== handed.host.pid ||
          record.host.started !== handed.host.started
        ) {
          continue;
        }
        const proved =
          (yield* stillRunning(record.leader)) &&
          (yield* groupOf(record.leader.pid)) === record.leader.group;
        const exited = yield* fs.exists(outputsOf(dir, record.id).exit);
        if (!proved && !exited) {
          continue;
        }
        const taken: CheckRecord = { ...record, host };
        yield* records.setControl(RUNNING_CHECK, "", encodeCheckRecord(taken), record.id);
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

  if (options.handedOver !== undefined) {
    yield* takeOver(options.handedOver).pipe(Effect.provideContext(services));
  }
  if (options.sweep) {
    yield* Effect.forEach(yield* left, endLeftover, { concurrency: "unbounded", discard: true });
  }
  const returned: CheckProcessesApi = {
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
  };
  return returned;
});

// WARNING: must stay under the host's stop slack.
export const KILL_CEILING = Duration.seconds(3);

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
