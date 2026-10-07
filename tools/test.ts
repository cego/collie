// `bun run test`: the suite, against executables built from this tree.
//
// A test that starts a host, runs a command or answers as herdr starts a process, and the
// suite starts well over a thousand. From the sources each one spends most of a second
// loading modules; compiled to bytecode it is a fraction of that. So this builds `collie`
// the way a release does and the fake herdr the same way, then runs the suite with
// `COLLIE_TEST_BINARY` and `COLLIE_TEST_FAKE_HERDR` naming them. `bun test <file>` on its
// own still runs the sources, which is the quicker loop for one file.
//
// One suite runs at a time on a machine; the next waits for its turn. Several Runs each
// running the whole suite at once loaded vm-mk past 50 on 16 cores, and every one of them
// took longer than it would have in a queue.
//
// Workers: one for each core nothing else is using once this suite's turn comes. Never
// fewer than four; a test's timeout is a hang's, not a busy machine's, so a slower worker
// is never a failing one.

import { availableParallelism, loadavg, tmpdir } from "node:os";
import { resolve } from "node:path";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import solidPlugin from "@opentui/solid/bun-plugin";
import { Effect } from "effect";
import { lockHolder, withLock } from "../src/lock";

const out = resolve(".scratch/test-bin");
const collie = `${out}/collie`;
const herdr = `${out}/fake-herdr`;

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
]);
if (built.some((code) => code !== 0)) {
  console.error("test: could not build the executables the suite runs");
  process.exit(1);
}

const suite = Effect.promise(() => {
  const cores = availableParallelism();
  const idle = Math.round(Math.max(0, cores - loadavg()[0]));
  const workers = Math.min(cores, Math.max(4, idle));
  return Bun.spawn(
    [
      "bun",
      "test",
      `--parallel=${workers}`,
      "--timeout=30000",
      "--timings=.scratch/test-timings.json",
      "--update-timings",
      ...Bun.argv.slice(2),
    ],
    {
      env: { ...process.env, COLLIE_TEST_BINARY: collie, COLLIE_TEST_FAKE_HERDR: herdr },
      stdio: ["inherit", "inherit", "inherit"],
    },
  ).exited;
});

// Per user, so one user's suite never waits on a lock it cannot break.
const lock = `${tmpdir()}/collie-test-suite-${process.getuid?.() ?? "user"}.lock`;
const turn = (claims: number) => withLock(lock, Effect.succeed(null), suite, claims);

BunRuntime.runMain(
  Effect.gen(function* () {
    const now = yield* turn(1);
    if (now !== null) return now;
    const holder = yield* lockHolder(lock);
    console.error(`test: waiting for the suite in process ${holder?.pid ?? "?"} to finish`);
    return (yield* turn(Number.MAX_SAFE_INTEGER)) ?? 1;
  }).pipe(
    Effect.flatMap((code) => Effect.sync(() => process.exit(code))),
    Effect.provide(BunServices.layer),
  ),
);
