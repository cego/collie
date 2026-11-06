// One Desktop start: launched with Record timing on, timed to its board usable, then its
// whole process tree's RSS read once it has idled.

import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { type Duration, Effect, FileSystem, Option, Schedule, Schema } from "effect";

interface Process {
  readonly pid: number;
  readonly ppid: number;
  readonly rssKib: number;
  readonly args: string;
}

/** `pid ppid rss args` rows, as `ps -A -o pid=,ppid=,rss=,args=` prints them on Linux and macOS. */
const processesIn = (ps: string): ReadonlyArray<Process> =>
  Arr.flatMap(Str.split(ps, "\n"), (line) => {
    const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return row === null
      ? []
      : [{ pid: Number(row[1]), ppid: Number(row[2]), rssKib: Number(row[3]), args: row[4]! }];
  });

const PS = ["ps", "-A", "-o", "pid=,ppid=,rss=,args="];
const snapshot = () => Bun.spawnSync(PS).stdout.toString();

/** Collie's bridge or host: Desktop starts them, but they are not Desktop. */
const isCollie = ({ args }: Process) =>
  /(?:^|[\s/])(?:collie|main\.ts)\s+(?:bridge|host)(?:\s|$)/.test(args);

/** `root` and every process under it, but for any `left` and everything under that. */
const treeOf = (ps: string, root: number, left: (process: Process) => boolean) => {
  const all = processesIn(ps);
  const tree: Array<Process> = [];
  for (const queue = [root]; queue.length > 0;) {
    const pid = queue.shift()!;
    const found = all.find((one) => one.pid === pid);
    if (found === undefined || left(found)) continue;
    tree.push(found);
    for (const child of all) if (child.ppid === pid) queue.push(child.pid);
  }
  return tree;
};

/** The RSS of Desktop's process tree under `root`, in MiB to one decimal. */
export const treeRssMib = (ps: string, root: number) =>
  Math.round(Arr.reduce(treeOf(ps, root, isCollie), 0, (sum, one) => sum + one.rssKib) / 102.4) /
  10;

/** A process of the tree may have ended with its parent. */
const signal = (pid: number, name: NodeJS.Signals) => {
  try {
    process.kill(pid, name);
  } catch {}
};

const BoardUsable = Schema.fromJsonString(
  Schema.Struct({ name: Schema.Literal("board-usable"), at: Schema.Finite }),
);

/** How long a start may take to draw its board before it is given up on. */
const BOARD_LIMIT = "2 minutes";

/**
 * Launches `argv` with its state in `desktopState` and Record timing on, waits for its board,
 * idles, reads its tree's RSS and ends the whole tree. Answers the line `collie measure` reads.
 */
export const measureStart = (start: {
  readonly argv: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly desktopState: string;
  readonly idle: Duration.Input;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const own = `${start.desktopState}/collie-desktop`;
    const log = `${own}/record-timing.log`;
    yield* fs.makeDirectory(own, { recursive: true });
    yield* fs.remove(log, { force: true });
    yield* fs.writeFileString(`${own}/settings.json`, JSON.stringify({ recordTiming: true }));
    const launchedAt = Date.now();
    const app = yield* Effect.acquireRelease(
      Effect.sync(() =>
        Bun.spawn([...start.argv], {
          env: { ...start.env, XDG_STATE_HOME: start.desktopState },
          stdio: ["ignore", "ignore", "inherit"],
        }),
      ),
      (app) =>
        Effect.gen(function* () {
          const tree = treeOf(snapshot(), app.pid, () => false);
          for (const { pid } of tree) signal(pid, "SIGTERM");
          const ended = yield* Effect.promise(() => app.exited).pipe(
            Effect.timeoutOption("10 seconds"),
          );
          if (Option.isNone(ended)) for (const { pid } of tree) signal(pid, "SIGKILL");
        }).pipe(Effect.ignore),
    );
    const usableAt = yield* fs.readFileString(log).pipe(
      Effect.orElseSucceed(() => ""),
      Effect.flatMap((text) => {
        if (app.exitCode !== null)
          return Effect.die(new Error(`Desktop exited ${app.exitCode} before its board`));
        const marked = Arr.findFirst(Str.split(text, "\n"), (line) =>
          Schema.decodeOption(BoardUsable)(line),
        );
        return Option.match(marked, {
          onNone: () => Effect.fail("no board yet" as const),
          onSome: ({ at }) => Effect.succeed(at),
        });
      }),
      Effect.retry(Schedule.spaced("100 millis")),
      Effect.timeoutOrElse({
        duration: BOARD_LIMIT,
        orElse: () => Effect.die(new Error(`no board-usable mark in ${log}`)),
      }),
    );
    yield* Effect.sleep(start.idle);
    return JSON.stringify({
      board_usable_ms: Math.round(usableAt - launchedAt),
      idle_rss_mib: treeRssMib(snapshot(), app.pid),
    });
  }).pipe(Effect.scoped);
