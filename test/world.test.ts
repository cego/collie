import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Option from "effect/Option";
import { expect, test } from "bun:test";
import { Effect, FileSystem, Path } from "effect";
import { runEffect } from "./support/effect";
import { collie, proves } from "./support/world";
import { stopHost, until } from "./support/host";

test("an isolated world runs the suite's executable and carries its process lifetime and stop grace", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-world-command-" });
      const binary = `${dir}/collie`;
      yield* fs.writeFileString(
        binary,
        `#!/bin/sh
printf '{"ok":true,"data":{"root":"%s","pid":"%s","grace":"%s","forge":"%s"}}\\n' "$COLLIE_TEST_ROOT" "$COLLIE_HOST_WATCH_PID" "$COLLIE_HOST_STOP_GRACE" "$COLLIE_TEST_FAKE_FORGE"
`,
        { mode: 0o755 },
      );
      const before = Bun.env.COLLIE_TEST_BINARY;
      Bun.env.COLLIE_TEST_BINARY = binary;
      try {
        yield* Effect.promise(() =>
          proves(
            "collie-world-",
            (world) =>
              Effect.gen(function* () {
                const ran = yield* collie(world, ["test-fixture"]);
                expect(ran.exit).toBe(0);
                expect(ran.envelope).toEqual({
                  ok: true,
                  data: {
                    root: Bun.env.COLLIE_TEST_ROOT,
                    pid: Bun.env.COLLIE_HOST_WATCH_PID,
                    grace: Bun.env.COLLIE_HOST_STOP_GRACE,
                    forge: Bun.env.COLLIE_TEST_FAKE_FORGE ?? "",
                  },
                });
              }),
            [],
          ),
        );
      } finally {
        if (before === undefined) delete Bun.env.COLLIE_TEST_BINARY;
        else Bun.env.COLLIE_TEST_BINARY = before;
      }
    }).pipe(Effect.scoped),
  ));

test("world cleanup waits for a host to exit after it gives back its lock", () =>
  runEffect(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-world-stop-" });
      const lock = `${dir}/host.lock`;
      const last = `${dir}/last-write`;
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `process.on("SIGTERM", async () => {
            await Bun.file(Bun.argv[1]).delete();
            await Bun.sleep(100);
            await Bun.write(Bun.argv[2], "finished");
            process.exit(0);
          });
          await Bun.write(Bun.argv[1], JSON.stringify({ pid: process.pid, start: null }));
          setInterval(() => {}, 1000);`,
          lock,
          last,
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* Effect.try(() => child.kill()).pipe(Effect.ignore);
          yield* Effect.promise(() => child.exited);
        }),
      );
      yield* until(() => fs.exists(lock).pipe(Effect.orDie), Boolean);
      yield* stopHost(dir);
      expect(yield* fs.exists(last)).toBe(true);
      expect(yield* Effect.promise(() => child.exited)).toBe(0);
    }).pipe(Effect.scoped),
  ));

// The preload's process markers use Linux /proc; the rest of the world proofs are portable.
test.skipIf(process.platform !== "linux")(
  "world cleanup waits for its surviving command before removing the directory",
  () => {
    let child: Bun.Subprocess<"ignore", "ignore", "ignore"> | undefined;
    let other: Bun.Subprocess<"ignore", "ignore", "ignore"> | undefined;
    return runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const state = yield* Effect.promise(() =>
          proves(
            "collie-world-child-",
            (world) =>
              Effect.sync(() => {
                child = Bun.spawn(
                  [
                    process.execPath,
                    "-e",
                    'await Bun.sleep(100); await Bun.write(Bun.argv[1], "finished");',
                    `${world.state}/last-write`,
                  ],
                  {
                    env: { ...process.env, HERDR_PLUGIN_STATE_DIR: undefined },
                    stdin: "ignore",
                    stdout: "ignore",
                    stderr: "ignore",
                  },
                );
                other = Bun.spawn([process.execPath, "-e", "await Bun.sleep(60_000);"], {
                  env: {
                    ...process.env,
                    FAKE_HERDR_LOG: `${path.dirname(world.state)}/herdr-calls.jsonl-other`,
                  },
                  stdin: "ignore",
                  stdout: "ignore",
                  stderr: "ignore",
                });
                return world.state;
              }),
            [],
          ),
        );
        const finished = child;
        expect(yield* Effect.promise(() => finished?.exited ?? Promise.resolve(null))).toBe(0);
        expect(other?.exitCode).toBeNull();
        expect(
          yield* fs.exists(
            pipe_(
              state,
              Str.slice(
                0,
                Option.getOrElse(pipe_(state, Str.lastIndexOf("/")), () => -1),
              ),
            ),
          ),
        ).toBe(false);
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            for (const pending of [child, other]) {
              if (pending === undefined) continue;
              yield* Effect.try(() => pending.kill()).pipe(Effect.ignore);
              yield* Effect.promise(() => pending.exited);
            }
          }),
        ),
      ),
    );
  },
);
