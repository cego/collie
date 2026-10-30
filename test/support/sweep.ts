// What a test file's root leaves behind, and how a killed suite's roots are removed.
//
// Every process a test starts carries `COLLIE_TEST_ROOT` naming its file's root, which is
// how a leftover is proved to be the suite's. Read from /proc, so Linux only.

import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Str from "effect/String";
import * as Option from "effect/Option";
// Called by a process exit listener; Effect FileSystem cannot finish asynchronous cleanup there.
import {
  accessSync,
  chmodSync,
  constants,
  readdirSync,
  readFileSync,
  rmSync,
  statfsSync,
} from "node:fs"; // oxlint-disable-line effecttsgo/node-builtin-import
import { tmpdir } from "node:os";
import { Config, ConfigProvider, Console, Effect, Path } from "effect";
import * as Rec from "effect/Record";
const { join } = Effect.runSync(Path.Path.pipe(Effect.provide(Path.layer)));

export const MARKER = "COLLIE_TEST_ROOT";
/** Where a fixture whose control socket must bind keeps its directory, whatever `TMPDIR` says. */
export const SOCKET_BASE = "/tmp";

/** A memory filesystem, where a test's database commits and git writes never wait on a disk. */
export const MEMORY_BASE = Effect.runSync(
  Config.String("COLLIE_TEST_MEMORY").pipe(
    Config.withDefault("/dev/shm"),
    // The preload has not set the test environment yet; leave Effect's default provider uninitialized.
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv()),
  ),
);
/** What a memory filesystem must have free to hold a test file's root. */
export const MEMORY_FREE_BYTES = 2 * 1024 ** 3;

const freeBytes = (dir: string) => {
  const stat = statfsSync(dir);
  return stat.bavail * stat.bsize;
};

export const rootBase = (memory = MEMORY_BASE, fallback = tmpdir(), free = freeBytes) => {
  try {
    accessSync(memory, constants.W_OK);
    return free(memory) >= MEMORY_FREE_BYTES ? memory : fallback;
  } catch {
    return fallback;
  }
};

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export const kill = (pid: number) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Gone already, which is what this is for.
  }
};

const PF_KTHREAD = 0x200000;

/**
 * Between execve's switch to the new program's memory and its writing the environment there:
 * environ reads empty, and proc(5)'s field 51, env_end, is 0 as for no memory at all.
 */
const execing = (stat: string) => {
  const fields = Str.split(
    pipe(stat, Str.slice(Option.getOrElse(pipe(stat, Str.lastIndexOf(")")), () => -1) + 2)),
    " ",
  );
  return fields[0] !== "Z" && (Number(fields[6]) & PF_KTHREAD) === 0 && fields[48] === "0";
};

/** Every live process whose marker is `root` and whose environment has the given bindings. */
export const marked = (
  root: string,
  bindings: Readonly<Record<string, string>> = {},
  proc = "/proc",
): ReadonlyArray<{ pid: number; command: string }> => {
  let pids: Array<string>;
  try {
    pids = Arr.filter(readdirSync(proc), (name) => /^\d+$/.test(name));
  } catch {
    return [];
  }
  // Match whole NUL-delimited bindings without allocating every unrelated process's
  // environment fields on every fixture cleanup.
  const want = [
    `\0${MARKER}=${root}\0`,
    ...Arr.map(Rec.toEntries(bindings), ([key, value]) => `\0${key}=${value}\0`),
  ];
  return Arr.flatMap(pids, (name) => {
    const pid = Number(name);
    if (pid === process.pid) return [];
    try {
      const environ = () => readFileSync(`${proc}/${name}/environ`, "utf8");
      let read = environ();
      while (read === "" && execing(readFileSync(`${proc}/${name}/stat`, "utf8"))) {
        // The exit listener must wait for execve synchronously before it can identify a leftover.
        // oxlint-disable-next-line no-restricted-properties
        Bun.sleepSync(1);
        read = environ();
      }
      // The exec may have finished between the empty read and the stat read.
      if (read === "") read = environ();
      const env = `\0${read}\0`;
      if (!Arr.every(want, (binding) => pipe(env, Str.includes(binding)))) return [];
      const command = Str.trim(
        Arr.join(Str.split(readFileSync(`${proc}/${name}/cmdline`, "utf8"), "\0"), " "),
      );
      return [
        {
          pid,
          command,
        },
      ];
    } catch {
      return [];
    }
  });
};

/**
 * Removes every `collie-test-<pid>-*` root in `dir` whose pid is dead, and kills what still
 * carries its marker. A live pid's root is another suite's and is left alone.
 */
export const sweepDeadRoots = (dir: string): ReadonlyArray<string> =>
  Arr.flatMap(readdirSync(dir), (name) => {
    const pid = Number(
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(/^collie-test-(\d+)-/.exec(name)), (present) => present[1]),
      ) ?? 0,
    );
    if (pid <= 0 || alive(pid)) return [];
    const root = join(dir, name);
    for (const one of marked(root)) kill(one.pid);
    return removed(root) ? [root] : [];
  });

export const sweepEveryBase = (memory = MEMORY_BASE) =>
  Arr.flatMap([...new Set([tmpdir(), SOCKET_BASE, memory])], (dir) => {
    try {
      return sweepDeadRoots(dir);
    } catch {
      return [];
    }
  });

/**
 * Removes `root`, giving its owner back write access first where a test took it away (a Go
 * module cache is read-only). A root that still will not go is reported, never thrown: one
 * leftover is no reason not to run the suite.
 */
/** `dir` and every directory under it, writable by its owner again. */
const writable = (dir: string): void => {
  try {
    chmodSync(dir, 0o700);
    for (const entry of readdirSync(dir, { withFileTypes: true }))
      if (entry.isDirectory()) writable(join(dir, entry.name));
  } catch {
    // What cannot be reached stays, and the removal says so.
  }
};

const removed = (root: string) => {
  try {
    rmSync(root, { recursive: true, force: true });
    return true;
  } catch {
    writable(root);
  }
  try {
    rmSync(root, { recursive: true, force: true });
    return true;
  } catch (cause) {
    Effect.runSync(Console.error(`test: could not remove ${root}: ${String(cause)}`));
    return false;
  }
};
