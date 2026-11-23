import * as Arr from "effect/Array";
// WARNING: Effect has no CPU-count or shared system-temporary-directory service.
import { availableParallelism, tmpdir } from "node:os";
import * as BunRuntime from "@effect/platform-bun/BunRuntime";
import * as BunServices from "@effect/platform-bun/BunServices";
import {
  Cause,
  Clock,
  Config,
  Console,
  Effect,
  Exit,
  FileSystem,
  Path,
  Runtime,
  Schema,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { budgetOf, type Budget, type Kind, startOnHold, STORE as store } from "./budget";
import {
  binDirectory,
  isTargeted,
  kindOf,
  prepareTimings,
  pressureAt,
  report,
  requestOf,
  timingFlags,
  turnFor,
} from "./test-run";
import { sweepEveryBase } from "../test/support/sweep";
import { LIVE_HARNESSES } from "../test/support/live-switch";

const args = Arr.drop(Bun.argv, 2);
const say = Console.error;

const suiteEnv = () => {
  const { [LIVE_HARNESSES]: _, ...rest } = process.env;
  return rest;
};

const compile = (entrypoint: string, outfile: string) =>
  Effect.promise(() =>
    Bun.build({
      entrypoints: [entrypoint],
      target: "bun",
      bytecode: true,
      format: "esm",
      compile: { outfile },
    }),
  ).pipe(Effect.map((result) => (result.success ? 0 : 1)));

const build = Effect.fn("Test.build")(function* (out: string) {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const release = spawner
    .spawn(
      ChildProcess.make(
        "bun",
        ["run", "tools/build.ts", `${process.platform}-${process.arch}`, path.join(out, "collie")],
        { stdout: "ignore", stderr: "inherit" },
      ),
    )
    .pipe(Effect.flatMap((child) => child.exitCode));
  return yield* Effect.all(
    [
      release,
      compile("test/support/forwarder.ts", path.join(out, "fake-forward")),
      compile("test/support/fake-ssh-main.ts", path.join(out, "fake-ssh")),
      compile("test/support/codex-server.ts", path.join(out, "codex-server")),
    ],
    { concurrency: "unbounded" },
  );
});

const timings = ".scratch/test-timings.json";
const TimingsJson = Schema.fromJsonString(
  Schema.Struct({
    files: Schema.Record(Schema.String, Schema.Finite),
  }),
);

const runSuite = (targeted: boolean, kind: Kind, since: bigint, budget: Budget, seed: string) => {
  const request = requestOf(args, budget, targeted, kind);
  return turnFor(
    request,
    store,
    budget,
    lock,
    (hold) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const queued = (yield* Clock.monotonicTimeNanos) - since;
        const admittedAt = yield* pressureAt();
        yield* Console.error(`test: ${hold.workers} workers of a budget of ${budget.total}`);
        if (hold.fewer !== null) yield* Console.error(`test: ${hold.fewer}`);
        const out = yield* binDirectory(targeted);
        const flags = yield* timingFlags(targeted, timings, seed);
        const starts = `${out}/starts`;
        sweepEveryBase();
        const building = yield* Clock.monotonicTimeNanos;
        if (Arr.some(yield* build(out), (code) => code !== 0)) {
          yield* Console.error("test: could not build the executables the suite runs");
          return 1;
        }
        // WARNING: these are durations, never results; Bun still discovers every test and replaces the estimates.
        yield* prepareTimings(targeted, timings, seed);
        yield* fs.writeFileString(starts, "");
        const running = yield* Clock.monotonicTimeNanos;
        const child = yield* startOnHold(
          store,
          hold.id,
          ["bun", "test", `--parallel=${hold.workers}`, ...flags, ...request.args],
          {
            kind,
            env: {
              ...suiteEnv(),
              COLLIE_TEST_BINARY: `${out}/collie`,
              COLLIE_TEST_FAKE_FORGE: `${out}/fake-forward`,
              COLLIE_TEST_FAKE_SSH: `${out}/fake-ssh`,
              COLLIE_TEST_CODEX_SERVER: `${out}/codex-server`,
              COLLIE_TEST_STARTS: starts,
            },
            inherit: true,
          },
        );
        const exit = yield* Effect.promise(() => child.exited);
        const ended = yield* Clock.monotonicTimeNanos;
        const files = targeted
          ? null
          : yield* fs.readFileString(timings).pipe(
              Effect.flatMap(Schema.decodeEffect(TimingsJson)),
              Effect.map((recorded) => recorded.files),
              Effect.orElseSucceed(() => null),
            );
        const lines = report({
          queued: Number(queued) / 1_000_000_000,
          built: Number(running - building) / 1_000_000_000,
          ran: Number(ended - running) / 1_000_000_000,
          workers: hold.workers,
          budget,
          timings: files,
          starts: yield* fs.readFileString(starts).pipe(Effect.orElseSucceed(() => "")),
          admitted: admittedAt,
          ended: yield* pressureAt(),
        });
        yield* Effect.forEach(lines, (line) => Console.error(line), { discard: true });
        return exit;
      }).pipe(Effect.scoped),
    say,
  );
};

const lock = `${tmpdir()}/collie-test-suite-${process.getuid?.() ?? "user"}.lock`;

BunRuntime.runMain(
  Effect.gen(function* () {
    const since = yield* Clock.monotonicTimeNanos;
    const configured = yield* Config.String("COLLIE_TEST_BUDGET").pipe(Config.withDefault(""));
    const budget = budgetOf(availableParallelism(), configured);
    const path = yield* Path.Path;
    const seed = path.resolve(import.meta.dir, "test-timings.json");
    const [targeted, kind] = yield* Effect.all([isTargeted(args), kindOf(args, budget)]);
    return yield* runSuite(targeted, kind, since, budget, seed);
  }).pipe(
    Effect.tapCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Console.error(Cause.pretty(cause)),
    ),
    Effect.provide(BunServices.layer),
  ),
  {
    disableErrorReporting: true,
    teardown: (exit, onExit) =>
      Exit.isSuccess(exit) ? onExit(Number(exit.value)) : Runtime.defaultTeardown(exit, onExit),
  },
);
