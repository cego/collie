// WARNING: a pid alone is not identity: numbers are reused, so only command, start and session together prove a process.
import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Option from "effect/Option";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import { Effect, FileSystem, PlatformError, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export interface ProcessInfo {
  readonly pid: number;
  readonly command: string;
  readonly started: string;
  readonly session: number | null;
  readonly parent: number;
}

const PROC = "/proc";

// WARNING: the command may hold spaces and parens, so fields are read after its last paren.
const statFields = (pid: number) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(`${PROC}/${pid}/stat`)),
    Effect.map((stat) =>
      Str.split(
        pipe_(stat, Str.slice(Option.getOrElse(pipe_(stat, Str.lastIndexOf(")")), () => -1) + 2)),
        " ",
      ),
    ),
  );
const STARTED = 19;
const procStarted = (pid: number) =>
  statFields(pid).pipe(
    Effect.map((fields) => fields[STARTED] || null),
    Effect.orElseSucceed(() => null),
  );

const procCommand = (pid: number, proc: string) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(`${proc}/${pid}/cmdline`)),
    Effect.map((argv) => pipe_(argv, Str.replaceAll("\0", " "))),
  );

const fromProc = (pid: number) =>
  Effect.gen(function* () {
    const fields = yield* statFields(pid);
    if (fields[0] === "Z") return null;
    const command = yield* procCommand(pid, PROC);
    if (command === "") return null;
    return {
      pid,
      command,
      started: fields[STARTED] ?? "",
      session: Number(fields[3]),
      parent: Number(fields[1]),
    } satisfies ProcessInfo;
  });

const readPs = (args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const handle = yield* spawner.spawn(
      ChildProcess.make("ps", args, { stdout: "pipe", stderr: "ignore" }),
    );
    const text = yield* Stream.mkString(Stream.decodeText(handle.stdout));
    const code = yield* handle.exitCode;
    if (code !== 0)
      return yield* PlatformError.systemError({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "ps",
        description: `ps exited ${code}; its process listing is unproved`,
      });
    return text;
  }).pipe(Effect.scoped);

const ps = (args: ReadonlyArray<string>) => readPs(args).pipe(Effect.orElseSucceed(() => ""));

const PS_COLUMNS = "pid=,ppid=,stat=,lstart=,command=";

const psRows = (text: string) =>
  Arr.map(
    Arr.filter(
      Arr.map(Str.split(text, "\n"), (line) => Str.split(Str.trim(line), /\s+/)),
      (words) => words.length >= 8 && !Str.startsWith("Z")(words[2] ?? ""),
    ),
    (words) => ({
      pid: Number(words[0]),
      parent: Number(words[1]),
      started: Arr.join(words.slice(3, 8), " "),
      command: Arr.join(words.slice(8), " "),
      session: null,
    }),
  );

export const readsSessions = FileSystem.FileSystem.pipe(
  Effect.flatMap((fs) => fs.exists(`${PROC}/self/stat`)),
  Effect.orElseSucceed(() => false),
);

export const processOf = Effect.fn("Processes.processOf")(function* (pid: number) {
  if (yield* readsSessions) return yield* fromProc(pid).pipe(Effect.orElseSucceed(() => null));
  const [row] = psRows(yield* ps(["-ww", "-o", PS_COLUMNS, "-p", String(pid)]));
  return row ?? null;
});

export const commandOf = (pid: number, proc = PROC) =>
  procCommand(pid, proc).pipe(Effect.catch(() => ps(["-ww", "-o", "command=", "-p", String(pid)])));

export const startedOf = Effect.fn("Processes.startedOf")(function* (pid: number) {
  if (yield* readsSessions) return yield* procStarted(pid);
  return Str.trim(yield* ps(["-o", "lstart=", "-p", String(pid)])) || null;
});

// WARNING: where the platform cannot read a session, descendants must be taken before the root exits.
export const sessionOf = Effect.fn("Processes.sessionOf")(function* (root: number) {
  if (yield* readsSessions) {
    const fs = yield* FileSystem.FileSystem;
    const found: ProcessInfo[] = [];
    for (const name of yield* fs.readDirectory(PROC)) {
      const pid = Number(name);
      if (!Number.isInteger(pid) || pid === root) continue;
      const one = yield* Effect.gen(function* () {
        const fields = yield* statFields(pid);
        if (fields[0] === "Z" || Number(fields[3]) !== root) return null;
        return yield* fromProc(pid);
      }).pipe(
        Effect.catchTag("PlatformError", (cause) =>
          processAbsent(pid).pipe(
            Effect.flatMap((absent) => (absent ? Effect.succeed(null) : Effect.fail(cause))),
          ),
        ),
      );
      if (one !== null && one.session === root) found.push(one);
    }
    return found;
  }
  const all = psRows(yield* readPs(["-A", "-ww", "-o", PS_COLUMNS]));
  const tree = new Set([root]);
  for (let grew = true; grew;) {
    grew = false;
    for (const one of all)
      if (!tree.has(one.pid) && tree.has(one.parent)) {
        tree.add(one.pid);
        grew = true;
      }
  }
  return Arr.filter(all, (one) => one.pid !== root && tree.has(one.pid));
});

export const groupOf = Effect.fn("Processes.groupOf")(function* (pid: number) {
  const group = (yield* readsSessions)
    ? yield* statFields(pid).pipe(
        Effect.map((fields) => (fields[0] === "Z" ? "" : (fields[2] ?? ""))),
        Effect.orElseSucceed(() => ""),
      )
    : Str.trim(yield* ps(["-o", "pgid=", "-p", String(pid)]));
  return group === "" ? null : Number(group);
});

const readBindings = Effect.fnUntraced(function* (pid: number, names: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem;
  const environ = yield* fs
    .readFileString(`${PROC}/${pid}/environ`)
    .pipe(Effect.orElseSucceed(() => null));
  if (environ === null || environ === "") return null;
  const found: Record<string, string> = {};
  for (const entry of Str.split(environ, "\0")) {
    const at = Option.getOrElse(pipe_(entry, Str.indexOf("=")), () => -1);
    const name = pipe_(entry, Str.slice(0, at));
    if (at > 0 && names.includes(name)) found[name] = pipe_(entry, Str.slice(at + 1));
  }
  return found;
});

// WARNING: never read without /proc: ps -E puts the environment into the arguments.
export const bindingsOf = Effect.fn("Processes.bindingsOf")(readBindings);

// WARNING: the start is read before the bindings, so a reused pid never passes as the bound one.
export const boundProcesses = Effect.fn("Processes.boundProcesses")(function* (
  names: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* readsSessions)) return [];
  const looked = yield* Effect.forEach(
    yield* fs.readDirectory(PROC).pipe(Effect.orElseSucceed(() => [])),
    (name) =>
      Effect.gen(function* () {
        const pid = Number(name);
        if (!Number.isInteger(pid)) return null;
        const candidate = yield* readBindings(pid, names);
        if (candidate === null || Rec.keys(candidate).length === 0) return null;
        const started = yield* procStarted(pid);
        if (started === null) return null;
        const bound = yield* readBindings(pid, names);
        return bound !== null && Rec.keys(bound).length > 0 ? { pid, started, bound } : null;
      }),
    { concurrency: 32 },
  );
  return Arr.filter(looked, (one) => one !== null);
});

export const stillRunning = (one: Pick<ProcessInfo, "pid" | "started">) =>
  processOf(one.pid).pipe(Effect.map((now) => now !== null && now.started === one.started));

// WARNING: only ESRCH proves absence; a failed inspection or permission check does not.
export const processAbsent = (pid: number) =>
  Effect.sync(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (cause) {
      return cause instanceof Error && "code" in cause && cause.code === "ESRCH";
    }
  });

// WARNING: one SIGTERM, never repeated or SIGKILL: a forced end cannot be vouched for.
export const terminate = (pid: number) =>
  Effect.ignore(Effect.try(() => process.kill(pid, "SIGTERM")));
