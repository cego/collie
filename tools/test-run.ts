// What a `bun run test` invocation is, and what it holds from the Machine's budget. One that
// names files or `--changed` is targeted: it builds into a directory of its own, shares nothing
// with a whole suite, and takes its workers from the budget's reserve. Anything else is the
// whole suite.

import { loadavg } from "node:os";
import { type Duration, Effect, FileSystem, Option, Path, Schema } from "effect";
import { admitted, type Budget, type Kind, shareOf } from "./budget";
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

/** What a run asks of the budget, and its arguments less the `--parallel` it is given instead. */
export const requestOf = (args: ReadonlyArray<string>, budget: Budget, targeted: boolean) => {
  const kind: Kind = targeted ? "small" : "whole";
  const operands = args.indexOf("--");
  const isWorkers = (arg: string, at: number) =>
    (operands === -1 || at < operands) &&
    !TAKES_VALUE.has(args[at - 1] ?? "") &&
    (arg === "--parallel" || arg.startsWith("--parallel="));
  const given = args.findLast(isWorkers);
  const asked =
    given === undefined
      ? targeted
        ? 2
        : shareOf(budget, kind)
      : given === "--parallel"
        ? shareOf(budget, kind)
        : Number(given.slice("--parallel=".length));
  return { kind, asked, args: args.filter((arg, at) => !isWorkers(arg, at)) };
};

/**
 * Runs `run` on a hold from the budget. A whole suite then also takes the old suite lock, so
 * a whole suite from a checkout without the budget still waits for it, and it for that one.
 */
export const turnFor = <A, E, R>(
  request: { readonly kind: Kind; readonly asked: number },
  dir: string,
  budget: Budget,
  lock: string,
  run: (hold: Effect.Success<ReturnType<typeof admitted>>) => Effect.Effect<A, E, R>,
  say: (line: string) => Effect.Effect<void>,
  every?: Duration.Input,
) =>
  Effect.gen(function* () {
    const hold = yield* admitted(dir, budget, request.kind, request.asked, say, every);
    return yield* request.kind === "small" ? run(hold) : inTurn(lock, run(hold), say, every);
  }).pipe(Effect.scoped);

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

const TimingsJson = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Number, files: Schema.Record(Schema.String, Schema.Number) }),
  { space: 2 },
);
const decodeTimings = Schema.decodeUnknownOption(TimingsJson);
const encodeTimings = Schema.encodeSync(TimingsJson);

/**
 * Seeds a whole suite's timings and drops files that no longer exist, which Bun's own merge
 * keeps forever. A targeted run reads the timings without updating them, so it leaves them be.
 * Timings that do not decode are left for Bun.
 */
export const prepareTimings = Effect.fn("prepareTimings")(function* (
  targeted: boolean,
  timings: string,
  seed: string,
) {
  if (targeted) return;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const text = yield* fs.readFileString((yield* exists(timings)) ? timings : seed);
  const recorded = decodeTimings(text);
  if (Option.isNone(recorded)) return;
  const files: Record<string, number> = {};
  for (const [file, duration] of Object.entries(recorded.value.files))
    if (yield* exists(file)) files[file] = duration;
  yield* fs.makeDirectory(path.dirname(timings), { recursive: true });
  yield* fs.writeFileString(timings, `${encodeTimings({ ...recorded.value, files })}\n`);
});

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

export interface Pressure {
  /** `/proc/pressure/cpu`'s `some avg60`, or null where the Machine has no such file. */
  readonly psi: number | null;
  readonly load: number;
}

export const pressureAt = (path = "/proc/pressure/cpu") =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path)).pipe(
    Effect.map((text) => {
      const avg60 = text.match(/^some .*avg60=([0-9.]+)/m)?.[1];
      return avg60 === undefined ? null : Number(avg60);
    }),
    Effect.orElseSucceed(() => null),
    Effect.map((psi): Pressure => ({ psi, load: loadavg()[0]! })),
  );

const seconds = (value: number) => `${value.toFixed(2)} s`;
const psiOf = (pressure: Pressure) =>
  pressure.psi === null ? "not available" : `${pressure.psi.toFixed(2)} %`;

export const report = (run: {
  readonly queued: number;
  readonly built: number;
  readonly ran: number;
  readonly workers: number;
  readonly budget: Budget;
  /** A whole suite's per-file milliseconds, from the timings it updated. */
  readonly timings: Readonly<Record<string, number>> | null;
  readonly starts: string;
  readonly admitted: Pressure;
  readonly ended: Pressure;
}) => {
  const { budget } = run;
  const files = Object.entries(run.timings ?? {}).toSorted(([, a], [, b]) => b - a);
  const longest = files[0];
  const summed = files.reduce((sum, [, ms]) => sum + ms, 0) / 1_000;
  const kept =
    shareOf(budget, "small") === budget.total
      ? "shared by every run"
      : `${budget.reserve} of it kept for small runs`;
  return [
    `test: queued ${seconds(run.queued)}, built ${seconds(run.built)}, ran ${seconds(run.ran)}`,
    `test: ${run.workers} workers of a budget of ${budget.total}, ${kept}`,
    ...(longest === undefined
      ? []
      : [
          `test: longest file ${longest[0]} at ${seconds(longest[1] / 1_000)}, ${Math.round(
            (100 * longest[1]) / 1_000 / run.ran,
          )} % of the run; per-file time summed ${seconds(summed)}`,
        ]),
    ...startsSummary(run.starts),
    `test: CPU pressure (some avg60) ${psiOf(run.admitted)} at admission, ${psiOf(run.ended)} at the end`,
    `test: 1-minute load ${run.admitted.load.toFixed(2)} at admission, ${run.ended.load.toFixed(2)} at the end`,
    `test: ${seconds(run.built + run.ran)} including builds`,
  ];
};
