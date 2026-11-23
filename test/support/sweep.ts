// WARNING: Reads /proc, so Linux only.
import * as Arr from "effect/Array";
import { pipe } from "effect/Function";
import * as Str from "effect/String";
import * as Option from "effect/Option";
// WARNING: Called by a process exit listener, which cannot finish Effect FileSystem's asynchronous cleanup.
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
// WARNING: /tmp, not TMPDIR, so a control socket path stays short enough to bind.
export const SOCKET_BASE = "/tmp";

export const MEMORY_BASE = Effect.runSync(
  Config.String("COLLIE_TEST_MEMORY").pipe(
    Config.withDefault("/dev/shm"),
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv()),
  ),
);
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
  } catch {}
};

const PF_KTHREAD = 0x20_00_00;

// WARNING: Between execve's switch and its environment write, environ reads empty, so read it again.
const execing = (stat: string) => {
  const fields = Str.split(
    pipe(stat, Str.slice(Option.getOrElse(pipe(stat, Str.lastIndexOf(")")), () => -1) + 2)),
    " ",
  );
  return fields[0] !== "Z" && (Number(fields[6]) & PF_KTHREAD) === 0 && fields[48] === "0";
};

export const marked = (
  root: string,
  bindings: Readonly<Record<string, string>> = {},
  proc = "/proc",
) => {
  let pids: Array<string>;
  try {
    pids = Arr.filter(readdirSync(proc), (name) => /^\d+$/.test(name));
  } catch {
    return [];
  }
  const want = [
    `\0${MARKER}=${root}\0`,
    ...Arr.map(Rec.toEntries(bindings), ([key, value]) => `\0${key}=${value}\0`),
  ];
  return Arr.flatMap(pids, (name) => {
    const pid = Number(name);
    if (pid === process.pid) {
      return [];
    }
    try {
      const environ = () => readFileSync(`${proc}/${name}/environ`, "utf8");
      let read = environ();
      while (read === "" && execing(readFileSync(`${proc}/${name}/stat`, "utf8"))) {
        // oxlint-disable-next-line no-restricted-properties -- The exit listener must wait for execve synchronously before it can identify a leftover.
        Bun.sleepSync(1);
        read = environ();
      }
      // WARNING: The exec may finish between the empty read and the stat read.
      if (read === "") {
        read = environ();
      }
      const env = `\0${read}\0`;
      if (!Arr.every(want, (binding) => pipe(env, Str.includes(binding)))) {
        return [];
      }
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

export const sweepDeadRoots = (dir: string) =>
  Arr.flatMap(readdirSync(dir), (name) => {
    const pid = Number(
      Option.getOrUndefined(
        Option.map(Option.fromNullishOr(/^collie-test-(\d+)-/.exec(name)), (present) => present[1]),
      ) ?? 0,
    );
    if (pid <= 0 || alive(pid)) {
      return [];
    }
    const root = join(dir, name);
    for (const one of marked(root)) {
      kill(one.pid);
    }
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

// WARNING: A Go module cache is read-only, so give write back before removing; a root that will not go is reported, never thrown.
const writable = (dir: string) => {
  try {
    chmodSync(dir, 0o700);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        writable(join(dir, entry.name));
      }
    }
  } catch {}
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
