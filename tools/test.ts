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
// One whole suite runs at a time on a machine; the next waits for its turn. Several Runs each
// running the whole suite at once loaded vm-mk past 50 on 16 cores, and every one of them
// took longer than it would have in a queue. A targeted run — one naming an existing path, or
// `--changed` — takes no turn: it needs few cores, builds into a directory of its own that it
// removes, and reads the shared timings without updating them (`tools/test-run.ts`).
//
// Workers are the cores left idle over a one-second sample taken after the builds and once
// the turn is granted, at least 2 and at most one per core; a caller's `--parallel` stands
// (`workersFor`). Load averages, which #110 dropped, lag and count this suite's previous run
// and IO waits; a fresh idle-CPU sample counts neither, and still leaves room for the other
// work on the Machine.

import { availableParallelism, cpus, tmpdir } from "node:os";
import { resolve } from "node:path";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import solidPlugin from "@opentui/solid/bun-plugin";
import { Effect } from "effect";
import {
  binDirectory,
  isTargeted,
  startsSummary,
  timingFlags,
  turnFor,
  workersFor,
} from "./test-run";
import { sweepDeadRoots } from "../test/support/sweep";
import { LIVE_HARNESSES } from "../test/support/live-switch";

const args = Bun.argv.slice(2);

/** This environment, less the switch for live-harness tests, which only `test:live` sets. */
const suiteEnv = () => {
  const { [LIVE_HARNESSES]: _, ...rest } = process.env;
  return rest;
};

const run = (targeted: boolean, out: string, flags: ReadonlyArray<string>) => async () => {
  const collie = `${out}/collie`;
  const herdr = `${out}/fake-herdr`;
  const forge = `${out}/fake-forge`;
  const starts = `${out}/starts`;
  const started = performance.now();
  sweepDeadRoots(tmpdir());
  const built = await Promise.all([
    Bun.spawn(["bun", "run", "tools/build.ts", `${process.platform}-${process.arch}`, collie], {
      stdout: "ignore",
      stderr: "inherit",
    }).exited,
    Bun.build({
      entrypoints: ["test/support/fake-herdr.ts"],
      target: "bun",
      plugins: [solidPlugin],
      bytecode: true,
      format: "esm",
      compile: { outfile: herdr },
    }).then((result) => (result.success ? 0 : 1)),
    Bun.build({
      entrypoints: ["test/support/forge-bin.ts"],
      target: "bun",
      bytecode: true,
      format: "esm",
      compile: { outfile: forge },
    }).then((result) => (result.success ? 0 : 1)),
  ]);
  if (built.some((code) => code !== 0)) {
    console.error("test: could not build the executables the suite runs");
    return 1;
  }
  // A fresh checkout must start its longest files first too. These are durations, never
  // results: Bun still discovers every test, and replaces the estimates after this run.
  if (!targeted && !(await Bun.file(timings).exists())) await Bun.write(timings, Bun.file(seed));
  const before = cpus();
  await Bun.sleep(1_000);
  const { workers, line } = workersFor(args, before, cpus(), availableParallelism());
  console.error(line);
  const parallel = workers === "caller" ? [] : [`--parallel=${workers}`];
  await Bun.write(starts, "");
  const exit = await Bun.spawn(["bun", "test", ...parallel, "--timeout=30000", ...flags, ...args], {
    env: {
      ...suiteEnv(),
      COLLIE_TEST_BINARY: collie,
      COLLIE_TEST_FAKE_HERDR: herdr,
      COLLIE_TEST_FAKE_FORGE: forge,
      COLLIE_TEST_STARTS: starts,
    },
    stdio: ["inherit", "inherit", "inherit"],
  }).exited;
  for (const line of startsSummary(await Bun.file(starts).text())) console.error(line);
  console.error(`test: ${((performance.now() - started) / 1_000).toFixed(2)} s including builds`);
  return exit;
};

const timings = ".scratch/test-timings.json";
const seed = resolve(import.meta.dir, "test-timings.json");

const suite = (targeted: boolean) =>
  Effect.gen(function* () {
    const out = yield* binDirectory(targeted);
    const flags = yield* timingFlags(targeted, timings, seed);
    return yield* Effect.promise(run(targeted, out, flags));
  }).pipe(Effect.scoped);

// Per user, so one user's suite never waits on a lock it cannot break.
const lock = `${tmpdir()}/collie-test-suite-${process.getuid?.() ?? "user"}.lock`;

BunRuntime.runMain(
  isTargeted(args).pipe(
    Effect.flatMap((targeted) =>
      turnFor(targeted, lock, suite(targeted), (line) => Effect.sync(() => console.error(line))),
    ),
    Effect.flatMap((code) => Effect.sync(() => process.exit(code))),
    Effect.provide(BunServices.layer),
  ),
);
