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
    // A bundle's launcher (desktop/README.md), which needs no install.
    rune: { type: "string" },
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

const launcher = flags.rune;
if (launcher === undefined) {
  console.error(
    "pass --rune <bundle>/bin/launcher; `bun run desktop/scripts/bundle.ts` builds one",
  );
  process.exit(2);
}
const dataHome = `${flags.home}/.local/share`;

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
