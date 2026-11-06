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
  options: { app: { type: "string" } },
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
const app = flags.app ?? built();
if (app === undefined) {
  console.error(
    "no built Desktop under desktop/build; run `bun run --cwd desktop build`, or pass --app",
  );
  process.exit(2);
}

/**
 * On Linux a build's launcher only installs Desktop under `$HOME`, which here is the world's,
 * and Desktop runs only from there.
 */
const installed = (build: string) =>
  Effect.gen(function* () {
    if (Bun.env.HOME !== world.home)
      return yield* Effect.die(
        new Error(`HOME is not the world's; not installing over the user's`),
      );
    yield* say(`installing ${build} under ${world.home}`);
    // The world's HOME reaches a child only when its env is given.
    const ran = Bun.spawnSync([build], {
      env: { ...Bun.env },
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (ran.exitCode !== 0) return yield* Effect.die(new Error(`installing ${build} failed`));
    return `${world.home}/.local/share/dk.cego.collie.desktop/stable/app/bin/launcher`;
  });

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
      const launcher = process.platform === "linux" ? yield* installed(app) : app;
      yield* say(`launching ${launcher}`);
      return yield* measureStart({
        argv: [launcher],
        env: {
          ...Bun.env,
          COLLIE_DESKTOP_COLLIE: JSON.stringify([process.execPath, `${root}src/main.ts`]),
        },
        desktopState: `${world.desktop}/state`,
        idle: "60 seconds",
      });
    }).pipe(Effect.scoped, Effect.orDie),
  ),
);
console.log(line);
