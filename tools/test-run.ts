// What a `bun run test` invocation is, and what it holds from the Machine's budget. One that
// names files or `--changed` is targeted: it builds into a directory of its own, shares nothing
// with a whole suite, and takes its workers from the budget's reserve. One naming a directory,
// or more files than the reserve has workers, is the size of a suite: it still builds and times
// as a targeted run, but takes its workers and the suite lock as a whole suite does. Anything
// else is the whole suite.

import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import * as Num from "effect/Number";
import * as Rec from "effect/Record";
import { loadavg } from "node:os";
import { type Duration, Effect, FileSystem, Option, Path, Schema, flow, Result } from "effect";
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

const isChanged = (arg: string) => arg === "--changed" || pipe(arg, Str.startsWith("--changed="));

/** The existing files and directories a run names, and whether it passes `--changed`. */
const namedBy = (args: ReadonlyArray<string>) => {
  const operands = args.indexOf("--");
  const option = (arg: string, at: number) =>
    (operands === -1 || at < operands) &&
    (pipe(arg, Str.startsWith("-")) || TAKES_VALUE.has(args[at - 1] ?? ""));
  return Effect.forEach(args, (arg, at) =>
    option(arg, at) ? Effect.succeed(false) : exists(arg),
  ).pipe(
    Effect.map((named) => ({
      paths: Arr.filter(args, (_, at) => Boolean(named[at])),
      changed: Arr.some(args, (arg, at) => option(arg, at) && isChanged(arg)),
    })),
  );
};

export const isTargeted = (args: ReadonlyArray<string>) =>
  Effect.map(namedBy(args), ({ paths, changed }) => changed || paths.length > 0);

/** A targeted run the size of a suite, naming a directory or more files than small runs share, is whole. */
export const kindOf = (args: ReadonlyArray<string>, budget: Budget) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const { paths, changed } = yield* namedBy(args);
    if (paths.length === 0) return changed ? "small" : "whole";
    const directories = yield* Effect.filter(paths, (path) =>
      fs.stat(path).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false),
      ),
    );
    return directories.length > 0 || paths.length > shareOf(budget, "small") ? "whole" : "small";
  });

/** What a run asks of the budget, and its arguments less the `--parallel` it is given instead. */
export const requestOf = (
  args: ReadonlyArray<string>,
  budget: Budget,
  targeted: boolean,
  kind: Kind = targeted ? "small" : "whole",
) => {
  const operands = args.indexOf("--");
  const isWorkers = (arg: string, at: number) =>
    (operands === -1 || at < operands) &&
    !TAKES_VALUE.has(args[at - 1] ?? "") &&
    (arg === "--parallel" || pipe(arg, Str.startsWith("--parallel=")));
  const given = Option.getOrUndefined(Arr.findLast(args, isWorkers));
  const asked =
    given === undefined
      ? targeted
        ? 2
        : shareOf(budget, kind)
      : given === "--parallel"
        ? shareOf(budget, kind)
        : Number(pipe(given, Str.slice("--parallel=".length)));
  return { kind, asked, args: Arr.filter(args, (arg, at) => !isWorkers(arg, at)) };
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
  Schema.Struct({ version: Schema.Finite, files: Schema.Record(Schema.String, Schema.Finite) }),
  { space: 2 },
);
const decodeTimings = Schema.decodeUnknownOption(TimingsJson);
const encodeTimings = flow(Schema.encodeResult(TimingsJson), Result.getOrThrow);

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
  for (const [file, duration] of Rec.toEntries(recorded.value.files))
    if (yield* exists(file)) files[file] = duration;
  yield* fs.makeDirectory(path.dirname(timings), { recursive: true });
  yield* fs.writeFileString(timings, `${encodeTimings({ ...recorded.value, files })}\n`);
});

const byDurationDescending = ([, a]: readonly [string, number], [, b]: readonly [string, number]) =>
  Num.Order(b, a);

/** Each file's mean duration over the timings records that name it, longest first. */
export const averageTimings = (records: ReadonlyArray<Readonly<Record<string, number>>>) => {
  const seen = new Map<string, number[]>();
  for (const files of records)
    for (const [file, duration] of Rec.toEntries(files))
      seen.set(file, [...(seen.get(file) ?? []), duration]);
  return Rec.fromEntries(
    Arr.sort(
      Arr.map(
        [...seen],
        ([file, durations]) =>
          [
            file,
            Math.round(Arr.reduce(durations, 0, (sum, one) => sum + one) / durations.length),
          ] as const,
      ),
      byDurationDescending,
    ),
  );
};

/** Writes `seed` from the timings files `records`, each test file at its mean over them. */
export const seedFrom = Effect.fn("seedFrom")(function* (
  records: ReadonlyArray<string>,
  seed: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const read = yield* Effect.forEach(records, (record) =>
    fs.readFileString(record).pipe(Effect.flatMap(Schema.decodeUnknownEffect(TimingsJson))),
  );
  const files = averageTimings(Arr.map(read, (one) => one.files));
  yield* fs.writeFileString(seed, `${encodeTimings({ version: 1, files })}\n`);
});

const ranked = (lines: ReadonlyArray<string>, top: number, indent = 0) => {
  const counts = new Map<string, number>();
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1);
  return Arr.map(
    Arr.take(
      Arr.sort([...counts], ([a, x], [b, y]) => Num.Order(y, x) || Str.localeCompare(b)(a)),
      top,
    ),
    ([line, count]) => ({
      line,
      text: `${Str.repeat(indent)(" ")}${pipe(String(count), Str.padStart(7))}  ${line}`,
    }),
  );
};

export const startsSummary = (starts: string) => {
  const lines = Arr.map(
    Arr.filter(Str.split(starts, "\n"), (line) => line !== ""),
    (line): [string, string?] => {
      const [source, file] = Str.split(line, "\t");
      return [source, file];
    },
  );
  const byFile = Map.groupBy(lines, ([, file]) => file);
  const files = Arr.flatMap(
    ranked(
      Arr.flatMap(lines, ([, file]) => Arr.ensure(file ?? [])),
      10,
    ),
    ({ line, text }) => [
      text,
      ...Arr.map(
        ranked(
          Arr.map(byFile.get(line)!, ([source]) => source),
          3,
          5,
        ),
        ({ text }) => text,
      ),
    ],
  );
  return [
    `test: ${lines.length} processes started`,
    ...Arr.map(
      ranked(
        Arr.map(lines, ([source]) => source),
        10,
      ),
      ({ text }) => text,
    ),
    ...(files.length === 0 ? [] : ["test: processes started by file", ...files]),
  ];
};

export interface Pressure {
  /** `/proc/pressure/cpu`'s `some avg60`, or null where the Machine has no such file. */
  readonly psi: number | null;
  readonly load: number;
}

export const pressureAt = (path = "/proc/pressure/cpu") =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path)).pipe(
    Effect.map((text) => {
      const avg60 = Option.getOrNull(pipe(text, Str.match(/^some .*avg60=([0-9.]+)/m)))?.[1];
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
  const files = Arr.sort(Rec.toEntries(run.timings ?? {}), byDurationDescending);
  const longest = files[0];
  const summed = Arr.reduce(files, 0, (sum, [, ms]) => sum + ms) / 1_000;
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
