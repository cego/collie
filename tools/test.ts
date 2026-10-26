// `bun run test`: the suite, against executables built from this tree.
//
// A test that starts a host, runs a command or answers as herdr starts a process, and the
// suite starts well over a thousand. From the sources each one spends most of a second
// loading modules; compiled to bytecode it is a fraction of that. So this builds `collie`
// the way a release does and both CLI fakes the same way, then runs the suite with
// `COLLIE_TEST_BINARY`, `COLLIE_TEST_FAKE_HERDR` and `COLLIE_TEST_FAKE_FORGE` naming them.
// `bun test <file>` on its own still runs the sources, which is the quicker loop for one file.
//
// A suite that was killed left its files' roots, and maybe processes carrying their marker:
// those whose pid is dead are removed before this one starts.
//
// Every run takes its workers from one budget of test processes per user per Machine
// (`tools/budget.ts`): two thirds of the cores, a quarter of it kept for targeted runs, and
// waiters admitted in the order they arrived. A whole suite asks for all the rest, so whole
// suites run one at a time and a targeted run never waits behind one. A whole suite also
// takes the old suite lock, so a checkout from before the budget still takes turns with it.
// A caller's `--parallel=N` asks for N, and gets no more than its kind's share.
// `COLLIE_TEST_BUDGET` sets the budget's size. The run ends with a report of where its time
// went (`report` in `tools/test-run.ts`).

import { availableParallelism, tmpdir } from "node:os";
import { resolve } from "node:path";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import solidPlugin from "@opentui/solid/bun-plugin";
import { Effect, FileSystem } from "effect";
import { budgetOf, startOnHold, STORE as store } from "./budget";
import {
  binDirectory,
  isTargeted,
  pressureAt,
  report,
  requestOf,
  timingFlags,
  turnFor,
} from "./test-run";
import { sweepEveryBase } from "../test/support/sweep";
import { LIVE_HARNESSES } from "../test/support/live-switch";

const args = Bun.argv.slice(2);
const budget = budgetOf(availableParallelism(), process.env.COLLIE_TEST_BUDGET);
const say = (line: string) => Effect.sync(() => console.error(line));

/** This environment, less the switch for live-harness tests, which only `test:live` sets. */
const suiteEnv = () => {
  const { [LIVE_HARNESSES]: _, ...rest } = process.env;
  return rest;
};

const build = (out: string) =>
  Promise.all([
    Bun.spawn(
      ["bun", "run", "tools/build.ts", `${process.platform}-${process.arch}`, `${out}/collie`],
      {
        stdout: "ignore",
        stderr: "inherit",
      },
    ).exited,
    Bun.build({
      entrypoints: ["test/support/fake-herdr.ts"],
      target: "bun",
      plugins: [solidPlugin],
      bytecode: true,
      format: "esm",
      compile: { outfile: `${out}/fake-herdr` },
    }).then((result) => (result.success ? 0 : 1)),
    Bun.build({
      entrypoints: ["test/support/forge-bin.ts"],
      target: "bun",
      bytecode: true,
      format: "esm",
      compile: { outfile: `${out}/fake-forge` },
    }).then((result) => (result.success ? 0 : 1)),
  ]);

const timings = ".scratch/test-timings.json";
const seed = resolve(import.meta.dir, "test-timings.json");

const suite = (targeted: boolean, since: number) => {
  const request = requestOf(args, budget, targeted);
  return turnFor(
    request,
    store,
    budget,
    lock,
    (hold) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const queued = performance.now() - since;
        const admittedAt = yield* pressureAt();
        console.error(`test: ${hold.workers} workers of a budget of ${budget.total}`);
        if (hold.fewer !== null) console.error(`test: ${hold.fewer}`);
        const out = yield* binDirectory(targeted);
        const flags = yield* timingFlags(targeted, timings, seed);
        const starts = `${out}/starts`;
        sweepEveryBase();
        const building = performance.now();
        if ((yield* Effect.promise(() => build(out))).some((code) => code !== 0)) {
          console.error("test: could not build the executables the suite runs");
          return 1;
        }
        // A fresh checkout must start its longest files first too. These are durations, never
        // results: Bun still discovers every test, and replaces the estimates after this run.
        if (!targeted && !(yield* fs.exists(timings)))
          yield* Effect.promise(() => Bun.write(timings, Bun.file(seed)));
        yield* fs.writeFileString(starts, "");
        const running = performance.now();
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
              COLLIE_TEST_FAKE_HERDR: `${out}/fake-herdr`,
              COLLIE_TEST_FAKE_FORGE: `${out}/fake-forge`,
              COLLIE_TEST_STARTS: starts,
            },
            inherit: true,
          },
        );
        const exit = yield* Effect.promise(() => child.exited);
        const ended = performance.now();
        const files = targeted
          ? null
          : yield* fs.readFileString(timings).pipe(
              Effect.map((text) => (JSON.parse(text) as { files: Record<string, number> }).files),
              Effect.orElseSucceed(() => null),
            );
        const lines = report({
          queued: queued / 1_000,
          built: (running - building) / 1_000,
          ran: (ended - running) / 1_000,
          workers: hold.workers,
          budget,
          timings: files,
          starts: yield* fs.readFileString(starts).pipe(Effect.orElseSucceed(() => "")),
          admitted: admittedAt,
          ended: yield* pressureAt(),
        });
        for (const line of lines) console.error(line);
        return exit;
      }).pipe(Effect.scoped),
    say,
  );
};

// Per user, so one user's suite never waits on a lock it cannot break.
const lock = `${tmpdir()}/collie-test-suite-${process.getuid?.() ?? "user"}.lock`;

BunRuntime.runMain(
  Effect.sync(() => performance.now()).pipe(
    Effect.flatMap((since) =>
      isTargeted(args).pipe(Effect.flatMap((targeted) => suite(targeted, since))),
    ),
    Effect.flatMap((code) => Effect.sync(() => process.exit(code))),
    Effect.provide(BunServices.layer),
  ),
);
