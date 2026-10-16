// What Collie may know about a process before it signals one: its command line, when it
// started and which session it is in. A pid alone is not an identity — numbers come round
// again — so nothing is signalled that these do not prove.

import { Effect, FileSystem, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export interface ProcessInfo {
  readonly pid: number;
  readonly command: string;
  /** When it started, in a form only ever compared with itself on the same machine. */
  readonly started: string;
  /** Its session id, where the platform says; null on one without `/proc`. */
  readonly session: number | null;
  readonly parent: number;
}

const PROC = "/proc";

/** `/proc/<pid>/stat`'s fields after the command, which may itself hold spaces and parens. */
const statFields = (pid: number) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(`${PROC}/${pid}/stat`)),
    Effect.map((stat) => stat.slice(stat.lastIndexOf(")") + 2).split(" ")),
  );
const STARTED = 19;

/** NUL-separated argv, which is not a string until the separators are. */
const procCommand = (pid: number, proc: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(`${proc}/${pid}/cmdline`)),
    Effect.map((argv) => argv.replaceAll("\0", " ")),
  );

const fromProc = (pid: number) =>
  Effect.gen(function* () {
    const fields = yield* statFields(pid);
    // A zombie has exited: nothing of it can run or be stopped.
    if (fields[0] === "Z") return null;
    const command = yield* procCommand(pid, PROC);
    // Exiting: its memory, and with it its command line, is already gone.
    if (command === "") return null;
    return {
      pid,
      command,
      started: fields[STARTED] ?? "",
      session: Number(fields[3]),
      parent: Number(fields[1]),
    } satisfies ProcessInfo;
  });

const ps = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make("ps", args, { stdout: "pipe", stderr: "ignore" }),
    );
    return yield* Stream.mkString(Stream.decodeText(handle.stdout));
  }).pipe(
    Effect.scoped,
    Effect.catch(() => Effect.succeed("")),
  );

/** `pid ppid lstart…` rows, where `lstart` is five words. */
const psRows = (text: string): ProcessInfo[] =>
  text
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((words) => words.length >= 7)
    .map((words) => ({
      pid: Number(words[0]),
      parent: Number(words[1]),
      started: words.slice(2, 7).join(" "),
      command: words.slice(7).join(" "),
      session: null,
    }));

/** Whether this platform says which session a process is in, so it can be read after its leader exits. */
export const readsSessions = FileSystem.FileSystem.pipe(
  Effect.flatMap((fs) => fs.exists(`${PROC}/self/stat`)),
  Effect.orElseSucceed(() => false),
);

/** This process as it is now, or null where no such process is running. */
export const processOf = Effect.fn("Processes.processOf")(function* (pid: number) {
  if (yield* readsSessions) return yield* fromProc(pid).pipe(Effect.orElseSucceed(() => null));
  const [row] = psRows(yield* ps(["-ww", "-o", "pid=,ppid=,lstart=,command=", "-p", String(pid)]));
  return row ?? null;
});

/** Its command line, from `proc` or else `ps`; "" where neither can say. */
export const commandOf = (pid: number, proc = PROC) =>
  procCommand(pid, proc).pipe(Effect.catch(() => ps(["-ww", "-o", "command=", "-p", String(pid)])));

/** When it started, as a token only compared with itself; null where that cannot be read. */
export const startedOf = Effect.fn("Processes.startedOf")(function* (pid: number) {
  const proc = yield* statFields(pid).pipe(
    Effect.map((fields) => fields[STARTED] || null),
    Effect.catchTag("PlatformError", () => Effect.succeed(null)),
  );
  return proc ?? ((yield* ps(["-o", "lstart=", "-p", String(pid)])).trim() || null);
});

/**
 * Every other process of `root`'s session, which is how a detached server's tool processes
 * are found after it has exited. Where the platform cannot read a session, `root`'s
 * descendants now, which have to be taken before it exits.
 */
export const sessionOf = Effect.fn("Processes.sessionOf")(function* (root: number) {
  if (yield* readsSessions) {
    const fs = yield* FileSystem.FileSystem;
    const found: ProcessInfo[] = [];
    for (const name of yield* fs.readDirectory(PROC).pipe(Effect.orElseSucceed(() => []))) {
      const pid = Number(name);
      if (!Number.isInteger(pid) || pid === root) continue;
      const one = yield* fromProc(pid).pipe(Effect.orElseSucceed(() => null));
      if (one !== null && one.session === root) found.push(one);
    }
    return found;
  }
  const all = psRows(yield* ps(["-A", "-ww", "-o", "pid=,ppid=,lstart=,command="]));
  const tree = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const one of all)
      if (!tree.has(one.pid) && tree.has(one.parent)) {
        tree.add(one.pid);
        grew = true;
      }
  }
  return all.filter((one) => one.pid !== root && tree.has(one.pid));
});

/** Whether this process is still the one that was looked at. */
export const stillRunning = (one: Pick<ProcessInfo, "pid" | "started">) =>
  processOf(one.pid).pipe(Effect.map((now) => now !== null && now.started === one.started));

/** One SIGTERM. Never repeated and never SIGKILL: a forced end is not a stop anyone can vouch for. */
export const terminate = (pid: number) =>
  Effect.ignore(Effect.try(() => process.kill(pid, "SIGTERM")));
