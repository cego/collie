// Desktop reaches Local's host the way it reaches any Machine's: through a bridge it starts
// as `desktop`, never through Collie's own host client.

import { expect, test } from "bun:test";
import { Config, Effect, Option, Schema, Stream } from "effect";
import { readAudit } from "../src/audit";
import { runDir } from "../src/engine";
import { bridgeCommand, machineBoard, openBridge } from "../desktop/src/bun/machine";
import { watchedBy } from "./support/effect";
import { root, stopHost } from "./support/host";
import { proves } from "./support/world";

const asCommand = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

test(
  "Desktop sees Local's board through a bridge it started, and a Run appears on it live",
  () =>
    proves(
      "collie-desktop-local-",
      (world) =>
        Effect.gen(function* () {
          const binary = yield* Config.option(Config.String("COLLIE_TEST_BINARY"));
          const collie = Option.isSome(binary)
            ? [binary.value]
            : [process.execPath, `${root}src/main.ts`];
          const door = yield* openBridge(bridgeCommand(collie, "mk-pc"), {
            PATH: "/usr/bin:/bin",
            HOME: world.home,
            HERDR_PLUGIN_ROOT: world.install,
            HERDR_PLUGIN_STATE_DIR: world.state,
            COLLIE_USER_DIR: world.config,
            COLLIE_HOST: asCommand(collie),
            COLLIE_HOST_WATCH_PID: yield* watchedBy,
            HERDR_BIN_PATH: Bun.env.HERDR_BIN_PATH ?? "",
            FAKE_HERDR_LOG: Bun.env.FAKE_HERDR_LOG ?? "",
          });
          const board = yield* machineBoard("mk-pc", door).pipe(Stream.toPull);

          const first = yield* board;
          const snapshot = first[0].message;
          expect(snapshot._tag).toBe("Snapshot");
          // The Machine is its installation, which every later message carries too.
          const installation = snapshot._tag === "Snapshot" ? snapshot.installation : "";
          expect(installation).not.toBe("");
          expect(first[0].machine).toEqual({ installation, name: "mk-pc" });

          const { runId } = yield* door.start({
            project: world.project,
            id: "proof",
            request: "start-1",
            input: { note: "from Desktop" },
          });
          let seen = false;
          while (!seen) {
            const next = yield* board;
            seen = next.some(
              (item) => item.message._tag === "Upsert" && item.message.task.runs.includes(runId),
            );
          }

          const trail = yield* readAudit(runDir(world.state, runId));
          expect(trail[0]?.actor).toEqual({
            origin: "desktop",
            requestId: "start-1",
            from: { client: "mk-pc" },
          });
          yield* stopHost(world.state);
        }).pipe(Effect.orDie),
      ["proof.workflow.ts", "helper.ts", "notes.md"],
    ),
  120_000,
);

test("Desktop's main process never reaches Collie's own host client", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const reached: string[] = [];
      const built = yield* Effect.promise(() =>
        Bun.build({
          entrypoints: [`${root}desktop/src/bun/index.ts`],
          target: "bun",
          external: ["electrobun", "electrobun/*"],
          plugins: [
            {
              name: "host-client",
              setup(build) {
                build.onLoad({ filter: /\/src\/(host|lock)\.ts$/ }, (args) => {
                  reached.push(args.path);
                  return undefined;
                });
              },
            },
          ],
        }),
      );
      expect(built.logs.filter((log) => log.level === "error")).toEqual([]);
      expect(reached).toEqual([]);
    }),
  ));
