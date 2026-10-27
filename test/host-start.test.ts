// A host served in this process, through a FileSystem whose /proc is the test's to hold:
// what it answers before its start-up sweep of the checks an earlier host left.

import { expect, test } from "bun:test";
import { Config, ConfigProvider, Deferred, Effect, FileSystem, Option, Schedule } from "effect";
import {
  CHECK_ID,
  CHECK_INSTALLATION,
  encodeCheckRecord,
  runningChecksDir,
} from "../src/check-processes";
import { frontDoor, serve, socketOf } from "../src/host";
import { processOf, startedOf, stillRunning } from "../src/processes";
import { signalProcess } from "../src/lock";
import { startDetached } from "./support/command";
import { runEffect, suiteEnv } from "./support/effect";
import { until } from "./support/host";
import { writeFakeHerdrShim } from "./support/fake-herdr-core";

const held = new URL("./fixtures/checks/held.sh", import.meta.url).pathname;

/** A state directory, and serving it here through `fileSystem` until the test's scope closes. */
const hostThrough = (
  fileSystem: (fs: FileSystem.FileSystem) => FileSystem.FileSystem,
  installation?: string,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "collie-host-start-" });
    const state = `${root}/state`;
    yield* fs.makeDirectory(state);
    if (installation !== undefined)
      yield* fs.writeFileString(`${state}/installation`, `${installation}\n`);
    yield* writeFakeHerdrShim(`${root}/herdr`);
    const { COLLIE_PROC } = yield* suiteEnv;
    const env = {
      HOME: root,
      PATH: yield* Config.String("PATH"),
      HERDR_BIN_PATH: `${root}/herdr`,
      HERDR_SOCKET_PATH: `${root}/herdr.sock`,
      HERDR_PLUGIN_STATE_DIR: state,
      COLLIE_USER_DIR: `${root}/user`,
      COLLIE_RELEASES: "http://127.0.0.1:9",
      COLLIE_PROC,
    };
    // A host moves into its state directory.
    const cwd = process.cwd();
    yield* Effect.addFinalizer(() => Effect.sync(() => process.chdir(cwd)));
    const serving = Effect.forkScoped(
      serve(state).pipe(
        Effect.scoped,
        Effect.provideService(FileSystem.FileSystem, fileSystem(fs)),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
      ),
    );
    return { root, state, serving };
  });

/** Its front door's answer to a declaration, once one comes. */
const answered = (state: string) =>
  Effect.scoped(
    frontDoor(socketOf(state)).pipe(Effect.flatMap((door) => door.declare({ frontDoor: "cli" }))),
  ).pipe(
    Effect.retry(Schedule.spaced("20 millis")),
    Effect.timeoutOption("20 seconds"),
    Effect.map(Option.isSome),
  );

/** A filesystem whose listing of /proc waits for `open`, and tells `listed` it was asked. */
const holdingProc =
  (open: Deferred.Deferred<void>, listed: Deferred.Deferred<void>) =>
  (fs: FileSystem.FileSystem): FileSystem.FileSystem => ({
    ...fs,
    readDirectory: (path, options) =>
      path === "/proc"
        ? Deferred.succeed(listed, undefined).pipe(
            Effect.andThen(Deferred.await(open)),
            Effect.andThen(fs.readDirectory(path, options)),
          )
        : fs.readDirectory(path, options),
  });

test.skipIf(process.platform !== "linux")(
  "a host answers while its sweep of an earlier host's check waits on /proc, then ends that check on its Run",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const open = yield* Deferred.make<void>();
        const listed = yield* Deferred.make<void>();
        const installation = "host-start-installation";
        const { root, state, serving } = yield* hostThrough(
          holdingProc(open, listed),
          installation,
        );
        const notes = `${root}/notes`;
        yield* fs.makeDirectory(notes);
        // Before the directory goes, so the check's child sees it and exits.
        yield* Effect.addFinalizer(() =>
          fs.writeFileString(`${notes}/release`, "").pipe(
            Effect.andThen(
              until(
                () =>
                  fs.readFileString(`${notes}/children`).pipe(
                    Effect.orElseSucceed(() => ""),
                    Effect.flatMap((text) =>
                      Effect.forEach(text.split("\n").filter(Boolean), (pid) =>
                        processOf(Number(pid)),
                      ),
                    ),
                  ),
                (found) => found.every((one) => one === null),
              ),
            ),
            Effect.ignore,
          ),
        );
        const leader = yield* startDetached([
          "env",
          `${CHECK_INSTALLATION}=${installation}`,
          `${CHECK_ID}=run-four@1-left`,
          held,
          notes,
        ]);
        yield* Effect.addFinalizer(() => signalProcess(leader, "SIGKILL").pipe(Effect.ignore));
        const left = { pid: leader, started: (yield* startedOf(leader)) ?? "" };
        yield* fs.makeDirectory(runningChecksDir(state));
        yield* fs.makeDirectory(`${state}/runs/run-four`, { recursive: true });
        yield* fs.writeFileString(
          `${runningChecksDir(state)}/run-four@1-left.json`,
          encodeCheckRecord({
            id: "run-four@1-left",
            run: "run-four",
            name: "held",
            by: "collie",
            leader: { pid: leader, started: left.started, group: leader },
            host: { pid: 4242, started: "2" },
            started: "2026-10-26T00:00:00.000Z",
          }),
        );

        yield* serving;
        yield* Deferred.await(listed);
        expect(yield* answered(state)).toBe(true);
        expect(yield* stillRunning(left)).toBe(true);

        yield* Deferred.succeed(open, undefined);
        yield* until(
          () => stillRunning(left),
          (running) => !running,
        );
        expect(
          yield* until(
            () =>
              fs
                .readFileString(`${state}/runs/run-four/log.txt`)
                .pipe(Effect.orElseSucceed(() => "")),
            (log) =>
              log.includes("check held of run-four, left running by host 4242 (started 2): ended"),
          ),
        ).toContain("run-four");
      }),
    ),
  60_000,
);

test.skipIf(process.platform !== "linux")(
  "a host that has just made its installation id does not list /proc for an earlier host's checks",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const open = yield* Deferred.make<void>();
        const listed = yield* Deferred.make<void>();
        const { state, serving } = yield* hostThrough(holdingProc(open, listed));

        yield* serving;
        expect(yield* answered(state)).toBe(true);
        expect((yield* fs.readFileString(`${state}/installation`)).trim()).not.toBe("");
        // A sweep starts as the host answers, and lists /proc within a few reads.
        expect(
          Option.isNone(yield* Deferred.await(listed).pipe(Effect.timeoutOption("1 second"))),
        ).toBe(true);
      }),
    ),
  60_000,
);
