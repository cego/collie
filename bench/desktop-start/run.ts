// Desktop's start, built: exec to the board usable, and its tree's RSS a minute after
// (desktop/README.md, Measuring Desktop's start). Prints, as its last line, one JSON object
// of numbers for `collie measure`.

import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import { Effect } from "effect";
import { connect } from "../../src/host";
import { runEffect } from "../../test/support/effect";
import { stopHost } from "../../test/support/host";
import { COUNTS, prepare } from "../record-open/fixture";
import { measuring, refusal, userStateDir } from "../record-open/guards";
import { enterWorld, live, root, socket, userEnv, world } from "../record-open/world";
import { measureStart } from "./start";

const { values: flags } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    app: { type: "string" },
    install: { type: "boolean", default: false },
    home: { type: "string", default: `${root}.scratch/desktop-start/home` },
  },
});
const say = (line: string) => Effect.sync(() => console.error(line));

const refused = await runEffect(
  refusal({ state: world.state, socket }, { home: homedir(), env: userEnv }),
);
if (refused !== null) {
  console.error(refused);
  process.exit(2);
}

/** The launcher `bun run --cwd desktop build` made for this platform. */
const built = () =>
  [
    ...new Bun.Glob("desktop/build/*/*.app/Contents/MacOS/launcher").scanSync(root),
    ...new Bun.Glob("desktop/build/*/*/bin/launcher").scanSync(root),
  ].map((path) => `${root}${path}`)[0];
const app = () => {
  const found = flags.app ?? built();
  if (found !== undefined) return found;
  console.error(
    "no built Desktop under desktop/build; run `bun run --cwd desktop build`, or pass --app",
  );
  process.exit(2);
};

// On Linux a build's launcher only installs Desktop under its data home, from where alone it
// runs. Installing warms the page cache, so it is a step of its own and never part of a sample.
const linux = process.platform === "linux";
const dataHome = `${flags.home}/.local/share`;
const installed = `${dataHome}/dk.cego.collie.desktop/stable/app/bin/launcher`;
if (linux && flags.install) {
  const build = app();
  console.error(`installing ${build} under ${flags.home}`);
  const ran = Bun.spawnSync([build], {
    env: { ...userEnv, HOME: flags.home, XDG_DATA_HOME: dataHome },
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (ran.exitCode !== 0 || !(await Bun.file(installed).exists())) {
    console.error(`installing ${build} left no ${installed}`);
    process.exit(2);
  }
  process.exit(0);
}
if (linux && !(await Bun.file(installed).exists())) {
  console.error(
    `no Desktop installed under ${flags.home}; run \`bun bench/desktop-start/run.ts --install\` first`,
  );
  process.exit(2);
}
const launcher = linux ? installed : app();

const line = await runEffect(
  measuring(
    `${userStateDir(homedir(), userEnv)}/measurements/machine.lock`,
    say,
    Effect.gen(function* () {
      rmSync(live, { recursive: true, force: true });
      yield* enterWorld;
      yield* Effect.addFinalizer(() => stopHost(world.state));
      yield* say("preparing the board: 50 Runs, one of 40 Steps");
      yield* prepare({ ...COUNTS, runs: 50, large: 1, old: 10, live: 0, largeSteps: 40 });
      // Running before Desktop starts, so the host is not in Desktop's tree.
      yield* Effect.scoped(connect(world.state));
      yield* say(`launching ${launcher}`);
      return yield* measureStart({
        argv: [launcher],
        env: {
          ...Bun.env,
          XDG_DATA_HOME: dataHome,
          COLLIE_DESKTOP_COLLIE: JSON.stringify([process.execPath, `${root}src/main.ts`]),
        },
        desktopState: `${world.desktop}/state`,
        idle: "60 seconds",
      });
    }).pipe(Effect.scoped, Effect.orDie),
  ),
);
console.log(line);
