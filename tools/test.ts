// `bun run test`: the suite, against executables built from this tree.
//
// A test that starts a host, runs a command or answers as herdr starts a process, and the
// suite starts well over a thousand. From the sources each one spends most of a second
// loading modules; compiled to bytecode it is a fraction of that. So this builds `collie`
// the way a release does and the fake herdr the same way, then runs the suite with
// `COLLIE_TEST_BINARY` and `COLLIE_TEST_FAKE_HERDR` naming them. `bun test <file>` on its
// own still runs the sources, which is the quicker loop for one file.
//
// A suite that was killed left its files' roots, and maybe processes carrying their marker:
// those whose pid is dead are removed before this one starts.
//
// Workers: one for each core nothing else is using, so a suite on an idle machine uses all
// of it and several Runs each running this suite share what is left. Never fewer than
// four, which is what an idle machine used to get; a test's timeout is a hang's, not a
// busy machine's, so a slower worker is never a failing one.

import { availableParallelism, loadavg, tmpdir } from "node:os";
import { resolve } from "node:path";
import solidPlugin from "@opentui/solid/bun-plugin";
import { sweepDeadRoots } from "../test/support/sweep";

sweepDeadRoots(tmpdir());

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

const cores = availableParallelism();
const idle = Math.round(Math.max(0, cores - loadavg()[0]));
const workers = Math.min(cores, Math.max(4, idle));

const suite = Bun.spawn(
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
);
process.exit(await suite.exited);
