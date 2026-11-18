import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import { Clock, Config, Duration, Effect, FileSystem, Option, Random, Schema } from "effect";
import type { PluginEnv } from "./env";
import { diskSaid, lowOn, readDisk } from "./disk";
import { launchDir } from "./launches";
import { machineMemory, PRESSURE_SHORT, type Memory } from "./memory";
import { machineName } from "./peers";
import { RunRecords } from "./run-records";
import { took } from "./time";

const every = Config.Duration("COLLIE_MEMORY_EVERY").pipe(
  Config.withDefault(Duration.seconds(15)),
  Effect.orElseSucceed(() => Duration.seconds(15)),
);
export const MEMORY_WAIT = "memory-wait";

const GB = 1024 ** 3;

const MemoryWaitJson = Schema.fromJsonString(
  Schema.Struct({
    what: Schema.String,
    sentence: Schema.String,
    since: Schema.Finite,
    read: Schema.Finite,
    every: Schema.Finite,
    asker: Schema.NullOr(Schema.String),
  }),
);
export type MemoryWait = typeof MemoryWaitJson.Type;

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

export const waitLine = (wait: MemoryWait) =>
  `${Str.toUpperCase(wait.sentence[0]!)}${pipe_(wait.sentence, Str.slice(1))}.`;

export const memoryWaitOf = (runId: string) =>
  Effect.map(waitsOf(runId), (waits) => waits[0] ?? null);

export const holdsBudgetOf = (runId: string, agent: string) =>
  Effect.map(waitsOf(runId), (waits) => Arr.some(waits, (one) => one.asker === agent));

export const waitForMemory = (opts: {
  readonly env: PluginEnv;
  readonly stateDir: string;
  readonly runId: string;
  readonly what: string;
  readonly checkout?: string;
  readonly memory?: boolean;
  readonly asker?: string | null;
  readonly stopped?: Effect.Effect<boolean, never, FileSystem.FileSystem>;
  readonly say?: (sentence: string) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const read = Effect.gen(function* () {
      const memory =
        opts.memory === false
          ? { memory: null, short: false }
          : yield* machineMemory(opts.env).pipe(
              Effect.orElseSucceed(() => ({ memory: null, short: false })),
            );
      if (memory.short && memory.memory !== null && memory.memory.known)
        return { on: "memory", sentence: memorySentence(memory.memory) } as const;
      const low = Arr.findFirst(
        yield* readDisk(opts.env, [opts.stateDir, ...(opts.checkout ? [opts.checkout] : [])]).pipe(
          Effect.orElseSucceed(() => []),
        ),
        lowOn,
      );
      return Option.isSome(low)
        ? ({
            on: "disk",
            sentence: `short of disk on ${machineName()}, waiting for space: ${diskSaid(low.value)}`,
          } as const)
        : null;
    });
    const first = yield* read;
    if (first === null) return "free";
    let short: { readonly on: string; readonly sentence: string } = first;
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
    const mark = (sentence: string) =>
      Effect.gen(function* () {
        yield* records.setControl(
          MEMORY_WAIT,
          opts.runId,
          yield* Schema.encodeEffect(MemoryWaitJson)({
            what: opts.what,
            sentence,
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
        if (now === null) return;
        short = now;
        yield* mark(now.sentence);
      }
    });
    const untilStopped = Effect.gen(function* () {
      while (!(yield* stopped)) yield* Effect.sleep(Duration.min(period, Duration.seconds(1)));
    });
    return yield* Effect.gen(function* () {
      const sentence = first.sentence;
      yield* mark(sentence);
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
              ? `${opts.what}: waited ${waited} for ${short.on}`
              : `${opts.what}: stopped after waiting ${waited} for ${short.on}`,
          );
        }),
      ),
    );
  });
