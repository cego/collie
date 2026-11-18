import * as Str from "effect/String";
import { Effect, FileSystem } from "effect";
import type { ChildProcessSpawner } from "effect/process";
import { loadDefaults } from "./config";
import type { PluginEnv } from "./env";
import { shell, type Runner } from "./mr";

export type Memory =
  | {
      readonly known: true;
      readonly available: number;
      readonly total: number;
      readonly pressure: number | null;
    }
  | { readonly known: false; readonly from: string };

export const PROC_ENV = "COLLIE_PROC";

export const PRESSURE_SHORT = 10;

export const shortOfMemory = (memory: Memory, hold: number) =>
  hold > 0 &&
  memory.known &&
  (memory.available < (memory.total * hold) / 100 ||
    (memory.pressure !== null && memory.pressure >= PRESSURE_SHORT));

const unknown: (from: string) => Memory = (from) => ({ known: false, from });

const kB = (meminfo: string, field: string) => {
  const found = new RegExp(`^${field}:\\s+(\\d+) kB$`, "m").exec(meminfo);
  return found === null ? null : Number(found[1]) * 1024;
};

export const linuxMemory = Effect.fn("Memory.linux")(function* (proc: string) {
  const fs = yield* FileSystem.FileSystem;
  const meminfo = `${proc}/meminfo`;
  const text = yield* fs.readFileString(meminfo).pipe(Effect.orElseSucceed(() => ""));
  const available = kB(text, "MemAvailable");
  const total = kB(text, "MemTotal");
  if (available === null || total === null || total === 0) return unknown(meminfo);
  const pressureFile = `${proc}/pressure/memory`;
  if (!(yield* fs.exists(pressureFile).pipe(Effect.orElseSucceed(() => false))))
    return { known: true, available, total, pressure: null } satisfies Memory;
  const pressure = /^full avg10=(\d+(?:\.\d+)?)\b/m.exec(
    yield* fs.readFileString(pressureFile).pipe(Effect.orElseSucceed(() => "")),
  );
  if (pressure === null) return unknown(pressureFile);
  return { known: true, available, total, pressure: Number(pressure[1]) } satisfies Memory;
});

export const macMemory = Effect.fn("Memory.mac")(function* <R>(run: Runner<R>) {
  const value = (name: string) =>
    run("sysctl", ["-n", name], "/").pipe(
      Effect.map((ran) => {
        const said = Str.trim(ran.stdout);
        return ran.code === 0 && /^\d+$/.test(said) ? Number(said) : null;
      }),
    );
  const level = yield* value("kern.memorystatus_level");
  const total = yield* value("hw.memsize");
  if (level === null || total === null || total === 0 || level > 100) return unknown("sysctl");
  return { known: true, available: (total * level) / 100, total, pressure: null } satisfies Memory;
});

export const readMemory = (
  env: PluginEnv,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner> = shell,
) => {
  const proc = env.raw[PROC_ENV];
  if (proc) return linuxMemory(proc);
  return process.platform === "darwin"
    ? macMemory(run)
    : process.platform === "linux"
      ? linuxMemory("/proc")
      : Effect.succeed(unknown(process.platform));
};

export const machineMemory = Effect.fn("Memory.machine")(function* (
  env: PluginEnv,
  run: Runner<ChildProcessSpawner.ChildProcessSpawner> = shell,
) {
  const memory = yield* readMemory(env, run);
  const { memoryHold } = yield* loadDefaults(env.userDir);
  return { memory, short: shortOfMemory(memory, memoryHold) };
});

const GB = 1024 ** 3;

export const memorySaid = (memory: Memory & { known: true }) =>
  `${(memory.available / GB).toFixed(1)} of ${(memory.total / GB).toFixed(1)} GB available (${Math.floor((memory.available / memory.total) * 100)}%)${memory.pressure === null ? "" : `, pressure ${memory.pressure.toFixed(1)}`}`;
