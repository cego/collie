// `bun run test`: the suite, against executables built from this tree.
//
// A test that starts a host, runs a command or answers as herdr starts a process, and the
// suite starts well over a thousand. From the sources each one spends most of a second
// loading modules; compiled to bytecode it is a fraction of that. So this builds `collie`
// the way a release does and the fakes' forwarder the same way, then runs the suite with
// `COLLIE_TEST_BINARY`, and `COLLIE_TEST_FAKE_HERDR` and `COLLIE_TEST_FAKE_FORGE` both
// naming the forwarder.
// `bun test <file>` on its own still runs the sources, which is the quicker loop for one file.
//
// A suite that was killed left its files' roots, and maybe processes carrying their marker:
// those whose pid is dead are removed before this one starts.
//
// Every run takes its workers from one budget of test processes per user per Machine
// (`tools/budget.ts`): two thirds of the cores, a quarter of it kept for targeted runs of a few
// files, and a run admitted as soon as its share has the workers free. A whole suite asks for
// all the rest, so whole suites run one at a time and a targeted run never waits behind one. A whole suite also
// takes the old suite lock, so a checkout from before the budget still takes turns with it.
// A caller's `--parallel=N` asks for N, and gets no more than its kind's share.
// `COLLIE_TEST_BUDGET` sets the budget's size. The run ends with a report of where its time
// went (`report` in `tools/test-run.ts`).

import * as Arr from "effect/Array";
// Effect has no CPU-count or shared system-temporary-directory service.
// oxlint-disable-next-line effecttsgo/node-builtin-import
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

/** This environment, less the switch for live-harness tests, which only `test:live` sets. */
const suiteEnv = () => {
  // Replay the actual subprocess environment; Config exposes named settings, not this record.
  // oxlint-disable-next-line effecttsgo/process-env
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

const suite = (targeted: boolean, kind: Kind, since: bigint, budget: Budget, seed: string) => {
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
        // A fresh checkout must start its longest files first too. These are durations, never
        // results: Bun still discovers every test, and replaces the estimates after this run.
        yield* prepareTimings(targeted, timings, seed);
        yield* fs.writeFileString(starts, "");
        const running = yield* Clock.monotonicTimeNanos;
        const child = yield* startOnHold(
          store,
          hold.id,
          [
            "bun",
            "test",
            `--parallel=${hold.workers}`,
            "--timeout=30000",
            ...flags,
            ...request.args,
          ],
          {
            env: {
              ...suiteEnv(),
              COLLIE_TEST_BINARY: `${out}/collie`,
              COLLIE_TEST_FAKE_HERDR: `${out}/fake-forward`,
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

// Per user, so one user's suite never waits on a lock it cannot break.
const lock = `${tmpdir()}/collie-test-suite-${process.getuid?.() ?? "user"}.lock`;

BunRuntime.runMain(
  Effect.gen(function* () {
    const since = yield* Clock.monotonicTimeNanos;
    const configured = yield* Config.String("COLLIE_TEST_BUDGET").pipe(Config.withDefault(""));
    const budget = budgetOf(availableParallelism(), configured);
    const path = yield* Path.Path;
    const seed = path.resolve(import.meta.dir, "test-timings.json");
    const [targeted, kind] = yield* Effect.all([isTargeted(args), kindOf(args, budget)]);
    return yield* suite(targeted, kind, since, budget, seed);
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
