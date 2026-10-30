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
import { boundProcesses, groupOf, startedOf, stillRunning } from "./processes";
import { epochMs, nowIso } from "./time";

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

export interface CheckCommand {
  readonly executable: string;
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
}

export interface RunningCheck {
  /** Its leader's, where it was spawned. */
  readonly pid: number | null;
  readonly stdout: Stream.Stream<Uint8Array, PlatformError>;
  readonly stderr: Stream.Stream<Uint8Array, PlatformError>;
  readonly exit: Effect.Effect<number, PlatformError>;
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
    Scope.Scope | ChildProcessSpawner.ChildProcessSpawner
  >;
  /**
   * As `run`, for a process the caller spawns itself, with `markers` in its environment, and
   * ends in the caller's Scope. Null where this host has begun to end, and nothing spawned.
   */
  readonly adopt: <H extends { readonly pid: number }>(
    check: CheckOf,
    spawn: (markers: Readonly<Record<string, string>>) => Effect.Effect<H>,
    say?: (line: string) => Effect.Effect<void>,
  ) => Effect.Effect<AdoptedCheck<H> | null, CheckRefused, Scope.Scope>;
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

/** Outside a host: its own group, ended with its Scope, and nothing recorded. */
const unrecorded: CheckProcessesApi = {
  run: (_check, command) =>
    Effect.map(spawnCheck(command), (handle) => ({
      pid: handle.pid,
      stdout: handle.stdout,
      stderr: handle.stderr,
      exit: Effect.map(handle.exitCode, Number),
      collected: (collecting) => collecting,
    })),
  adopt: (_check, spawn) =>
    Effect.map(spawn({}), (handle) => ({ handle, collected: (collecting) => collecting })),
  endAll: Effect.succeed([]),
  killEnded: Effect.void,
  collecting: Effect.succeed([]),
  left: Effect.succeed([]),
  stillRuns: () => Effect.succeed(false),
  endLeftover: () => Effect.succeed("already gone"),
};

/** A check this host ended, or would not start once it began to end. */
const endedCheck: RunningCheck = {
  pid: null,
  stdout: Stream.empty,
  stderr: Stream.empty,
  exit: Effect.never,
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
}

/**
 * The host's adapter for the state directory `dir`, whose installation id is `installation`.
 * Building it ends every check a previous host left, unless `sweep` is false and the caller
 * does. `onRun` is what ending one does on its Run, given the line `host.log` gets.
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
  readonly sweep?: boolean;
}) {
  const { dir, installation, kill = processKill } = options;
  const fs = yield* FileSystem.FileSystem;
  // Only these, so a check's spawn and finalizer stay in its caller's Scope.
  const services = Context.make(FileSystem.FileSystem, fs).pipe(
    Context.add(
      ChildProcessSpawner.ChildProcessSpawner,
      yield* ChildProcessSpawner.ChildProcessSpawner,
    ),
  );
  const collecting = new Map<string, Collecting>();
  let stopping = false;
  let killing = false;
  // Their processes carry their markers before their record is read.
  const spawning = new Map<string, Ending>();
  // From before its spawn, so no check of this host is ever taken for a leftover.
  const ours = new Set<string>();
  const host = { pid: process.pid, started: (yield* startedOf(process.pid)) ?? "" };

  const untrack = (id: string) => Effect.sync(() => collecting.delete(id));
  const forget = (id: string) =>
    fs
      .remove(recordPath(dir, id), { force: true })
      .pipe(Effect.ignore, Effect.andThen(untrack(id)));

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
      if (outcome !== "still running")
        yield* fs.remove(recordPath(dir, leftover.id), { force: true }).pipe(Effect.ignore);
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
  const unended = () => [...collecting.keys(), ...spawning.keys()];

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
    spawn: (markers: Readonly<Record<string, string>>) => Effect.Effect<H, E, Scope.Scope>,
    say: (line: string) => Effect.Effect<void>,
  ) =>
    Effect.gen(function* () {
      if (stopping) return null;
      const began = yield* nowIso;
      const salt = pipe_((yield* Random.next).toString(16), Str.slice(2));
      const id = `${check.run}@${epochMs(began)}-${salt}`;
      ours.add(id);
      yield* Effect.addFinalizer(() => Effect.sync(() => ours.delete(id)));
      yield* clearOf(check.run, say);
      // From the spawn to its finalizer, so no interruption leaves it unended.
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          if (stopping) return null;
          spawning.set(id, { check, ended: false, settled: false });
          const { handle, record, entry } = yield* Effect.gen(function* () {
            const handle = yield* spawn({
              [CHECK_INSTALLATION]: installation,
              [CHECK_ID]: id,
            });
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
            const entry: Collecting = { check, record, ended: stopping, settled: false };
            collecting.set(id, entry);
            return { handle, record, entry };
          }).pipe(Effect.ensuring(Effect.sync(() => spawning.delete(id))));
          yield* Effect.addFinalizer(() =>
            endCheck(record, installation, kill).pipe(
              // Its record is its only proof where /proc cannot be read, so it stays until it is gone.
              Effect.flatMap((gone) => (gone ? forget(id) : untrack(id))),
              Effect.ignore,
            ),
          );
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
          if (entry.ended) return Effect.never;
          entry.settled = true;
          return exit;
        }),
      );

  const run: CheckProcessesApi["run"] = (check, command, say = () => Effect.void) =>
    begin(
      check,
      (markers) => spawnCheck(command, markers).pipe(Effect.provideContext(services)),
      say,
    ).pipe(
      Effect.map((begun): RunningCheck => {
        if (begun === null) return endedCheck;
        const { handle, entry } = begun;
        return {
          pid: handle.pid,
          stdout: handle.stdout,
          stderr: handle.stderr,
          exit: Effect.map(handle.exitCode, Number),
          collected: collectedOf(entry),
        };
      }),
    );

  const adopt: CheckProcessesApi["adopt"] = (check, spawn, say = () => Effect.void) =>
    begin(check, spawn, say).pipe(
      Effect.map((begun) =>
        begun === null ? null : { handle: begun.handle, collected: collectedOf(begun.entry) },
      ),
    );

  const endAll = Effect.gen(function* () {
    stopping = true;
    const ended: CheckOf[] = [];
    for (const entry of [...collecting.values(), ...spawning.values()]) {
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
    for (const entry of collecting.values()) entry.ended = true;
    yield* signalAll(unended(), "SIGKILL");
    const until = (yield* Clock.currentTimeMillis) + KILL_WAIT;
    for (;;) {
      const marked = yield* markedBy(installation);
      for (const entry of collecting.values()) {
        const proved = yield* provedIn(entry.record, marked);
        if (isGone(proved)) yield* forget(entry.record.id);
        else yield* signal(proved, "SIGKILL", kill);
      }
      for (const id of spawning.keys())
        yield* signal({ group: null, marked: marked.get(id) ?? [] }, "SIGKILL", kill);
      if (collecting.size === 0 && spawning.size === 0) return;
      if ((yield* Clock.currentTimeMillis) >= until) return;
      yield* Effect.sleep("100 millis");
    }
  }).pipe(Effect.provideContext(services));

  if (options.sweep !== false)
    yield* Effect.forEach(yield* left, endLeftover, { concurrency: "unbounded", discard: true });
  return {
    run,
    adopt,
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
