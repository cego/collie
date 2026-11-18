/* oxlint-disable effecttsgo/node-builtin-import, effecttsgo/global-console, no-restricted-globals -- an offline benchmark's driver, on its own copy of a state directory. */
// Host start to first Snapshot on this tree's copy of the snapshot
// (ADR-draft-the-board-is-a-projection-of-facts-the-host-syncs): a first host leaves its
// board's projection, and a second is timed from its spawn to the first board message.
// Fails above `LIMIT_MS`. Run `prepare.ts` first. Give it the executable a release ships,
// `bun run build`'s `bin/collie`, to time what runs; without one it runs this tree's source.
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

const spawned: Array<Bun.Subprocess> = [];
const executable = Bun.argv[2];
const host = () => {
  const command = executable === undefined ? ["bun", `${root}src/main.ts`] : [executable];
  const made = Bun.spawn([...command, "host", "--dir", state], {
    cwd: state,
    env,
    stdio: ["ignore", "ignore", "ignore"],
  });
  spawned.push(made);
  return made;
};
// A host left on the copy would answer the next run's door in place of its own.
process.on("exit", () => {
  for (const one of spawned) one.kill("SIGKILL");
});
const stop = (one: Bun.Subprocess) =>
  Effect.runPromise(
    Effect.sync(() => one.kill("SIGTERM")).pipe(
      Effect.andThen(Effect.promise(() => one.exited)),
      Effect.timeout("10 seconds"),
      Effect.catch(() =>
        Effect.sync(() => one.kill("SIGKILL")).pipe(
          Effect.andThen(Effect.promise(() => one.exited)),
        ),
      ),
    ),
  );

/** The first board message a host on the copy sends, and how long after `from` it came. */
const firstMessage = (from: number) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const door = yield* frontDoor(socketOf(state));
        return yield* Stream.runHead(door.board());
      }),
    ).pipe(
      // The socket opens on the first call, which fails until the host listens.
      Effect.retry({ times: 12_000, schedule: Schedule.spaced("10 millis") }),
      Effect.orDie,
      Effect.map(() => performance.now() - from),
      Effect.provide(platformLayer),
    ),
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
  console.error("board-reads: the first host never finished its first pass");
  process.exit(1);
}
await stop(first);
rmSync(`${state}/host.log`, { force: true });

const started = performance.now();
const second = host();
const first_snapshot_ms = Math.round(await firstMessage(started));
await stop(second);
console.log(JSON.stringify({ first_snapshot_ms, limit_ms: LIMIT_MS }));
if (first_snapshot_ms > LIMIT_MS) process.exit(1);
