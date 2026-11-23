// WARNING: the state directory is at the same short path every time, so a kept fixture's paths hold.
import { tmpdir } from "node:os";
import { Effect, FileSystem } from "effect";
import { GIT_QUIET } from "../../test/support/git-quiet";
import { testBunfig } from "../../test/support/packages";
import { stringifyJson } from "../../src/json";

export const root = new URL("../../", import.meta.url).pathname;
const tag = Bun.hash(root).toString(16).slice(0, 8);
// WARNING: the host's socket is in its state directory, so the path must stay short.
export const live = `${tmpdir()}/cro-${tag}`;
export const kept = `${root}.scratch/record-open`;
export const world = {
  install: `${live}/install`,
  user: `${live}/install/user/workflows`,
  config: `${live}/install/user`,
  state: `${live}/state`,
  home: `${live}/home`,
  project: `${live}/project`,
  bin: `${live}/bin`,
  desktop: `${live}/desktop`,
};
export const socket = `${world.state}/host.sock`;
export const recordMarksFile = `${live}/record-marks.log`;

export const userEnv = { ...Bun.env };

export const enterWorld = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  for (const dir of [world.user, world.state, world.home, world.project, world.bin])
    yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(`${world.home}/.bunfig.toml`, testBunfig);
  yield* fs.writeFileString(
    `${world.bin}/claude`,
    `#!/bin/sh\n[ "$1" = --help ] && echo "  --autocompact <auto|tokens>" && exit 0\nexit 1\n`,
    { mode: 0o755 },
  );
  // WARNING: Desktop takes its login shell's environment; this one hands back the world's.
  yield* fs.writeFileString(
    `${world.bin}/login-shell`,
    `#!/bin/sh\n[ "$1" = -lc ] && shift && exec /bin/sh -c "$@"\nexec /bin/sh "$@"\n`,
    { mode: 0o755 },
  );
  Object.assign(Bun.env, {
    ...GIT_QUIET,
    TMPDIR: live,
    HOME: world.home,
    SHELL: `${world.bin}/login-shell`,
    COLLIE_ROOT: world.install,
    COLLIE_STATE_DIR: world.state,
    COLLIE_USER_DIR: world.config,
    COLLIE_CWD: world.project,
    COLLIE_HOST: stringifyJson([process.execPath, `${root}src/main.ts`]),
    COLLIE_HOST_WATCH_PID: String(process.pid),
    COLLIE_RECORD_MARKS: recordMarksFile,
    // WARNING: never the user's core and its Machines.
    HC_SOCKET: `${live}/absent-core.sock`,
    PATH: `${world.bin}:${Bun.env.PATH ?? ""}`,
  });
});
