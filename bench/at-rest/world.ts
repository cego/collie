/* oxlint-disable effecttsgo/async-function, effecttsgo/global-console, effecttsgo/global-console-in-effect, effecttsgo/global-date, effecttsgo/global-date-in-effect, effecttsgo/node-builtin-import, effecttsgo/prefer-effect-array, effecttsgo/prefer-effect-record, effecttsgo/prefer-effect-string, effecttsgo/prefer-schema-over-json, no-restricted-globals, no-restricted-properties -- the benchmark's drivers speak to processes, files and /proc on their own terms, as record-open's do. */

// WARNING: host.db keeps absolute paths, so each builder uses its own sample's paths.
import { tmpdir } from "node:os";
import { Effect, FileSystem } from "effect";
import { GIT_QUIET } from "../../test/support/git-quiet";
import { testBunfig } from "../../test/support/packages";
import { stringifyJson } from "../../src/json";

export const root = new URL("../../", import.meta.url).pathname;
export const tree = Bun.env.BENCH_AT_REST_TREE ?? root;
// WARNING: the host's socket is in its state directory, so the path must stay short.
export const live = `${tmpdir()}/car-${Bun.hash(tree).toString(16).slice(0, 8)}`;
export const keptFixture = `${tree}.scratch/at-rest/fixture`;
export const manifestPath = `${tree}.scratch/at-rest/fixture.json`;
export const world = {
  install: `${live}/install`,
  user: `${live}/install/user/workflows`,
  config: `${live}/install/user`,
  state: `${live}/state`,
  home: `${live}/home`,
  project: `${live}/project`,
  bin: `${live}/bin`,
};
export const socket = `${world.state}/host.sock`;

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
  delete Bun.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete Bun.env.HC_SESSION;
  delete Bun.env.XDG_CONFIG_HOME;
  Object.assign(Bun.env, {
    ...GIT_QUIET,
    TMPDIR: live,
    HOME: world.home,
    COLLIE_ROOT: world.install,
    COLLIE_STATE_DIR: world.state,
    COLLIE_USER_DIR: world.config,
    COLLIE_CWD: world.project,
    COLLIE_HOST: stringifyJson([process.execPath, `${root}src/main.ts`]),
    COLLIE_HOST_WATCH_PID: String(process.pid),
    HC_SOCKET: `${live}/absent-core.sock`,
    COLLIE_RELEASES: "http://127.0.0.1:9",
    PATH: `${world.bin}:${Bun.env.PATH ?? ""}`,
  });
});
