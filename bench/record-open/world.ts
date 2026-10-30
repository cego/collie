// Where the benchmark's host, fake herdr and Desktop live: a state directory of its own,
// never the user's, at the same short path every time so a kept fixture's paths hold.

import { tmpdir } from "node:os";
import { Effect, FileSystem } from "effect";
import { writeFakeHerdrShim } from "../../test/support/fake-herdr-core";
import { GIT_QUIET } from "../../test/support/git-quiet";
import { testBunfig } from "../../test/support/packages";

/** The tree under test: the one this harness was copied into. */
export const root = new URL("../../", import.meta.url).pathname;
const tag = Bun.hash(root).toString(16).slice(0, 8);
/** The host's socket is in its state directory, so it needs a short path. */
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

/** What the user's shell gave this process, before the world's own replaced it. */
export const userEnv = { ...Bun.env };

/** Sets the world's environment on this process, which every child it starts inherits. */
export const enterWorld = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  for (const dir of [world.user, world.state, world.home, world.project, world.bin])
    yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(`${world.home}/.bunfig.toml`, testBunfig);
  // Never the user's claude, nor their herdr and its Machines.
  yield* fs.writeFileString(
    `${world.bin}/claude`,
    `#!/bin/sh\n[ "$1" = --help ] && echo "  --autocompact <auto|tokens>" && exit 0\nexit 1\n`,
    { mode: 0o755 },
  );
  yield* writeFakeHerdrShim(`${world.bin}/herdr`);
  // Desktop takes its login shell's environment; this one hands back the world's.
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
    HERDR_PLUGIN_ROOT: world.install,
    HERDR_PLUGIN_STATE_DIR: world.state,
    HERDR_SOCKET_PATH: `${world.state}/herd.sock`,
    COLLIE_USER_DIR: world.config,
    COLLIE_CWD: world.project,
    COLLIE_HOST: JSON.stringify([process.execPath, `${root}src/main.ts`]),
    COLLIE_HOST_WATCH_PID: String(process.pid),
    HERDR_BIN_PATH: `${world.bin}/herdr`,
    FAKE_HERDR_LOG: `${live}/herdr-calls.jsonl`,
    PATH: `${world.bin}:${Bun.env.PATH ?? ""}`,
  });
});
