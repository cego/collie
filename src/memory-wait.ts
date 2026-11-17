// The one wait an agent's launch, a Check pass and `collie verify` make while their Machine
// is Short of memory (ADR-draft-new-work-waits-while-its-machine-is-short-of-memory, D2–D7).
// Each wait is a control row over its Run, so every door reads it the one way.

import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import { Clock, Config, Duration, Effect, FileSystem, Option, Path, Random, Schema } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import type { PluginEnv } from "./env";
import { launchDir } from "./launches";
import { machineMemory, PRESSURE_SHORT, type Memory } from "./memory";
import { machineName } from "./peers";
import { RunRecords } from "./run-records";
import { took } from "./time";

/** How often a wait reads again; a test of the shipped host names a shorter one. */
const every = Config.Duration("COLLIE_MEMORY_EVERY").pipe(
  Config.withDefault(Duration.seconds(15)),
  Effect.orElseSucceed(() => Duration.seconds(15)),
);
/** A wait for memory, keyed by its start and a random number (`memory-waits/<key>`). */
export const MEMORY_WAIT = "memory-wait";

const GB = 1024 ** 3;

const MemoryWaitJson = Schema.fromJsonString(
  Schema.Struct({
    what: Schema.String,
    sentence: Schema.String,
    since: Schema.Finite,
    /** When the wait last read its Machine, and how often it reads: an older read is a dead host's. */
    read: Schema.Finite,
    every: Schema.Finite,
    /** The agent whose Output budget this wait pauses: the one that asked for it. */
    asker: Schema.NullOr(Schema.String),
  }),
);
export type MemoryWait = typeof MemoryWaitJson.Type;

/** `waiting for memory on vm-mk: 2.1 of 62.0 GB available`, naming pressure where it is high. */
export const memorySentence = (memory: Memory & { known: true }) =>
  `waiting for memory on ${machineName()}: ${(memory.available / GB).toFixed(1)} of ${(memory.total / GB).toFixed(1)} GB available${memory.pressure !== null && memory.pressure >= PRESSURE_SHORT ? `, pressure ${memory.pressure.toFixed(1)}` : ""}`;

const waitsOf = (runId: string) =>
  Effect.gen(function* () {
    const rows = yield* RunRecords.use((records) => records.controlsOf(MEMORY_WAIT, runId));
    const now = yield* Clock.currentTimeMillis;
    const waits: MemoryWait[] = [];
    for (const row of rows) {
      const decoded = Schema.decodeOption(MemoryWaitJson)(row.data);
      if (Option.isSome(decoded) && now - decoded.value.read <= 3 * decoded.value.every)
        waits.push(decoded.value);
    }
    return waits.sort((a, b) => a.since - b.since);
  });

/** A wait as every door says it: `Waiting for memory on vm-mk: 2.1 of 62.0 GB available.` */
export const waitLine = (wait: MemoryWait) =>
  `${Str.toUpperCase(wait.sentence[0]!)}${pipe_(wait.sentence, Str.slice(1))}.`;

/** What of this Run waits for memory longest, or null where nothing does. */
export const memoryWaitOf = (runId: string) =>
  Effect.map(waitsOf(runId), (waits) => waits[0] ?? null);

/** Whether a `collie verify` `agent` asked for waits for memory, which pauses its Output budget. */
export const holdsBudgetOf = (runId: string, agent: string) =>
  Effect.map(waitsOf(runId), (waits) => Arr.some(waits, (one) => one.asker === agent));

/**
 * Returns once this Machine is not short of memory, reading it and `memory_hold` again every
 * 15 seconds: `free` where it never was, `waited` where it was, and `stopped` where `stopped`
 * came true during the wait or as it ended, so nothing starts for a stopped Run. Never fails
 * and reserves nothing.
 */
export const waitForMemory = (opts: {
  readonly env: PluginEnv;
  readonly stateDir: string;
  readonly runId: string;
  readonly what: string;
  readonly asker?: string | null;
  readonly stopped?: Effect.Effect<boolean, never, FileSystem.FileSystem>;
  /** Told the sentence once, as the wait begins. */
  readonly say?: (sentence: string) => Effect.Effect<void>;
}): Effect.Effect<
  "free" | "waited" | "stopped",
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | RunRecords
> =>
  Effect.gen(function* () {
    const read = machineMemory(opts.env).pipe(
      Effect.orElseSucceed(() => ({ memory: null, short: false })),
    );
    const first = yield* read;
    if (!first.short || first.memory === null || !first.memory.known) return "free";
    const reading = first.memory;
    const stopped = opts.stopped ?? Effect.succeed(false);
    const fs = yield* FileSystem.FileSystem;
    const records = yield* RunRecords;
    const since = yield* Clock.currentTimeMillis;
    const key = `${since}-${yield* Random.nextInt}.json`;
    const runLog = launchDir(opts.stateDir, opts.runId);
    const log = (line: string) =>
      fs
        .makeDirectory(runLog, { recursive: true })
        .pipe(
          Effect.andThen(fs.writeFileString(`${runLog}/agents.log`, `${line}\n`, { flag: "a" })),
          Effect.ignore({ log: "Warn" }),
        );
    const period = yield* every;
    const mark = (memory: Memory & { known: true }) =>
      Effect.gen(function* () {
        yield* records.setControl(
          MEMORY_WAIT,
          opts.runId,
          yield* Schema.encodeEffect(MemoryWaitJson)({
            what: opts.what,
            sentence: memorySentence(memory),
            since,
            read: yield* Clock.currentTimeMillis,
            every: Duration.toMillis(period),
            asker: opts.asker ?? null,
          }).pipe(Effect.orDie),
          key,
        );
      }).pipe(Effect.ignore({ log: "Warn" }));
    const freed = Effect.gen(function* () {
      for (;;) {
        yield* Effect.sleep(period);
        const now = yield* read;
        if (!now.short || now.memory === null || !now.memory.known) return;
        yield* mark(now.memory);
      }
    });
    const untilStopped = Effect.gen(function* () {
      while (!(yield* stopped)) yield* Effect.sleep(Duration.min(period, Duration.seconds(1)));
    });
    return yield* Effect.gen(function* () {
      const sentence = memorySentence(reading);
      yield* mark(reading);
      yield* log(`${opts.what}: ${sentence}`);
      if (opts.say !== undefined) yield* opts.say(sentence);
      const ended = yield* Effect.raceFirst(
        freed.pipe(Effect.as("waited" as const)),
        untilStopped.pipe(Effect.as("stopped" as const)),
      );
      return ended === "waited" && (yield* stopped) ? "stopped" : ended;
    }).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          yield* records.setControl(MEMORY_WAIT, opts.runId, null, key);
          const waited = took((yield* Clock.currentTimeMillis) - since);
          yield* log(
            exit._tag === "Success" && exit.value === "waited"
              ? `${opts.what}: waited ${waited} for memory`
              : `${opts.what}: stopped after waiting ${waited} for memory`,
          );
        }),
      ),
    );
  });
