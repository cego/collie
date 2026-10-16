// What a `bun run test` invocation is. One that names files or `--changed` is targeted: it
// needs few cores and, built into a directory of its own, shares nothing with a whole suite,
// so it takes no turn. Anything else is the whole suite.

import { type Duration, Effect, FileSystem, Path } from "effect";
import { inTurn } from "./suite-lock";

const exists = (path: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.exists(path)).pipe(
    Effect.orElseSucceed(() => false),
  );

// `bun test --help`'s options that require a value, which may come as the next word.
const TAKES_VALUE = new Set([
  "-t",
  "--test-name-pattern",
  "--timeout",
  "--rerun-each",
  "--retry",
  "--seed",
  "--coverage-reporter",
  "--coverage-dir",
  "--reporter",
  "--reporter-outfile",
  "--max-concurrency",
  "--path-ignore-patterns",
  "--parallel-delay",
  "--shard",
  "--timings",
  "-r",
  "--preload",
]);

export const isTargeted = (args: ReadonlyArray<string>) => {
  const operands = args.indexOf("--");
  return Effect.forEach(args, (arg, at) =>
    operands !== -1 && at > operands
      ? exists(arg)
      : arg === "--changed" || arg.startsWith("--changed=")
        ? Effect.succeed(true)
        : arg.startsWith("-") || TAKES_VALUE.has(args[at - 1] ?? "")
          ? Effect.succeed(false)
          : exists(arg),
  ).pipe(Effect.map((each) => each.includes(true)));
};

/** Runs `run` at once when targeted, and in the suite's turn otherwise. */
export const turnFor = <A, E, R>(
  targeted: boolean,
  lock: string,
  run: Effect.Effect<A, E, R>,
  say: (line: string) => Effect.Effect<void>,
  every?: Duration.Input,
) => (targeted ? run : inTurn(lock, run, say, every));

/** Where the executables are built: a targeted run's own, removed with its scope. */
export const binDirectory = (targeted: boolean) =>
  targeted
    ? Effect.flatMap(FileSystem.FileSystem, (fs) =>
        fs.makeTempDirectoryScoped({ prefix: "collie-test-bin-" }),
      )
    : Effect.map(Path.Path, (path) => path.resolve(".scratch/test-bin"));

export const timingFlags = (targeted: boolean, timings: string, seed: string) =>
  targeted
    ? Effect.map(exists(timings), (there) => [`--timings=${there ? timings : seed}`])
    : Effect.succeed([`--timings=${timings}`, "--update-timings"]);

type CpuSample = ReadonlyArray<{ readonly times: Readonly<Record<string, number>> }>;

const totals = (sample: CpuSample) =>
  sample.reduce(
    (sum, { times }) => {
      const all = Object.values(times).reduce((a, b) => a + b, 0);
      return { idle: sum.idle + times.idle!, all: sum.all + all };
    },
    { idle: 0, all: 0 },
  );

/**
 * How many workers `bun test` gets: the caller's `--parallel` before any `--`, or the cores
 * idle between two `os.cpus()` samples, rounded and held to `[2, cores]`.
 */
export const workersFor = (
  args: ReadonlyArray<string>,
  before: CpuSample,
  after: CpuSample,
  cores: number,
) => {
  const operands = args.indexOf("--");
  const given = (operands === -1 ? args : args.slice(0, operands)).find(
    (arg) => arg === "--parallel" || arg.startsWith("--parallel="),
  );
  if (given)
    return { workers: "caller" as const, line: `test: workers as the caller's ${given} says` };
  const start = totals(before);
  const end = totals(after);
  const all = end.all - start.all;
  const free = all > 0 ? (cores * (end.idle - start.idle)) / all : cores;
  const workers = Math.min(cores, Math.max(2, Math.round(free)));
  return { workers, line: `test: ${workers} workers (${free.toFixed(1)} of ${cores} cores free)` };
};

export const startsSummary = (starts: string) => {
  const lines = starts.split("\n").filter((line) => line !== "");
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  const largest = [...counts]
    .toSorted(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .slice(0, 10)
    .map(([source, count]) => `${String(count).padStart(7)}  ${source}`);
  return [`test: ${lines.length} processes started`, ...largest];
};
