/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/global-console, no-restricted-globals -- an offline benchmark's driver, on its own copy of a state directory. */
// Host start to first Snapshot on this tree's copy of the snapshot
// (ADR-draft-the-board-is-a-projection-of-facts-the-host-syncs): a first host leaves its
// board's projection, and a second is timed from its spawn to the first board message.
// Fails above `LIMIT_MS`. Run `prepare.ts` first.
import { Effect, Schedule, Stream } from "effect";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { frontDoor, socketOf } from "../../src/host";
import { platformLayer } from "../../src/platform";

const LIMIT_MS = 1_000;
const root = new URL("../../", import.meta.url).pathname;
const work = `${root}.scratch/board-reads`;
const state = `${work}/state`;
if (!existsSync(state)) {
  console.error("board-reads: no copy; run bench/board-reads/prepare.ts first");
  process.exit(2);
}
const env = {
  ...Bun.env,
  PATH: `${work}/bin:${Bun.env.PATH}`,
  HOME: `${work}/home`,
  COLLIE_ROOT: root,
  COLLIE_STATE_DIR: state,
  COLLIE_USER_DIR: `${work}/home/.collie/user`,
  COLLIE_HOST: "/bin/false",
  COLLIE_HOST_REFUSES: "true",
  HC_SOCKET: `${work}/no-core.sock`,
};

const host = () =>
  Bun.spawn(["bun", `${root}src/main.ts`, "host", "--dir", state], {
    cwd: state,
    env,
    stdio: ["ignore", "ignore", "ignore"],
  });

/** The first board message a host on the copy sends, and how long after `from` it came. */
const firstMessage = (from: number) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const door = yield* frontDoor(socketOf(state)).pipe(
          Effect.retry({ times: 2_000, schedule: Schedule.spaced("10 millis") }),
          Effect.orDie,
        );
        yield* Stream.runHead(door.board());
        return performance.now() - from;
      }),
    ).pipe(Effect.provide(platformLayer)),
  );

const log = () =>
  existsSync(`${state}/host.log`) ? readFileSync(`${state}/host.log`, "utf8") : "";

// The first host fills the projection; its pass is done once it says how many it confirmed.
const first = host();
const filled = await Effect.runPromise(
  Effect.suspend(() =>
    /cards the last host left were confirmed unchanged/.test(log())
      ? Effect.succeed(true)
      : Effect.fail("not yet"),
  ).pipe(
    Effect.retry(Schedule.spaced("500 millis")),
    Effect.timeout("10 minutes"),
    Effect.orElseSucceed(() => false),
  ),
);
if (!filled) {
  first.kill("SIGKILL");
  console.error("board-reads: the first host never finished its first pass");
  process.exit(1);
}
first.kill("SIGTERM");
await first.exited;
rmSync(`${state}/host.log`, { force: true });

const started = performance.now();
const second = host();
const first_snapshot_ms = Math.round(await firstMessage(started));
second.kill("SIGTERM");
await second.exited;
console.log(JSON.stringify({ first_snapshot_ms, limit_ms: LIMIT_MS }));
if (first_snapshot_ms > LIMIT_MS) process.exit(1);
