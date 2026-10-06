// Desktop reaches Local's host the way it reaches any Machine's: through a bridge it starts
// as `desktop`, never through Collie's own host client.

import { expect, test } from "bun:test";
import { Config, Deferred, Effect, Option, Schedule, Schema, Stream } from "effect";
import type { BoardMessage } from "../src/board-model";
import { readAudit } from "../src/audit";
import { runDir } from "../src/engine";
import {
  act,
  bridgeCommand,
  flockStream,
  machineBoard,
  openBridge,
} from "../desktop/src/bun/machine";
import { watchedBy } from "./support/effect";
import { root, stopHost } from "./support/host";
import { proves } from "./support/world";

const asCommand = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

test(
  "Desktop sees Local's board through a bridge it started, a Run appears on it live, and what Desktop does there is recorded as Desktop's",
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
          const board = yield* machineBoard({ name: "mk-pc" }, door).pipe(Stream.toPull);

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

          expect(
            yield* act(door, "hold-1", { _tag: "Control", runId, control: "hold", set: true }),
          ).not.toBe("");
          // Tried again under the same request, it is the one hold.
          yield* act(door, "hold-1", { _tag: "Control", runId, control: "hold", set: true });
          const refused = yield* act(door, "resume-x", { _tag: "Resume", runId: "r-nobody" }).pipe(
            Effect.flip,
          );
          expect(refused.reason).toBe("no Run r-nobody");

          const trail = yield* readAudit(runDir(world.state, runId));
          expect(trail.map((line) => line.actor)).toEqual([
            { origin: "desktop", requestId: "start-1", from: { client: "mk-pc" } },
            { origin: "desktop", requestId: "hold-1", from: { client: "mk-pc" } },
          ]);
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
          // Desktop's own dependencies, which the root suite does not install.
          external: [
            "electrobun",
            "electrobun/*",
            "@anthropic-ai/claude-agent-sdk",
            "@modelcontextprotocol/sdk/*",
          ],
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

test("a Machine reached by two routes is shown through the first, and the other's bridge closes at once", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const closed: string[] = [];
      const snapshot = (installation: string): BoardMessage => ({
        _tag: "Snapshot",
        installation,
        build: "0.31.0",
        protocol: 1,
        herds: [],
        tasks: [],
        seq: 0,
      });
      interface Fake {
        readonly name: string;
        readonly board: () => Stream.Stream<BoardMessage>;
      }
      const route = (name: string, board: Stream.Stream<BoardMessage>) => ({
        machine: { name, target: `mk@${name}` },
        open: Effect.acquireRelease(Effect.succeed<Fake>({ name, board: () => board }), () =>
          Effect.sync(() => closed.push(name)),
        ),
      });
      const preferredAnswers = yield* Deferred.make<void>();
      const after = (go: Deferred.Deferred<void>, message: BoardMessage) =>
        Stream.fromEffect(Deferred.await(go).pipe(Effect.as(message)));
      const told: string[] = [];
      const doors = new Map<string, Fake>();
      yield* flockStream(
        [
          route(
            "preferred",
            after(preferredAnswers, snapshot("vm")).pipe(Stream.concat(Stream.never)),
          ),
          route("other", Stream.make(snapshot("vm")).pipe(Stream.concat(Stream.never))),
        ],
        doors,
      ).pipe(
        Stream.runForEach((item) =>
          Effect.sync(() =>
            told.push(`${item.machine.name} ${"_tag" in item ? item._tag : item.message._tag}`),
          ),
        ),
        Effect.forkScoped,
      );
      const until = (what: () => boolean) =>
        Effect.suspend(() => (what() ? Effect.void : Effect.fail("not yet"))).pipe(
          Effect.retry(Schedule.spaced("5 millis")),
        );

      yield* until(() => told.length === 1);
      yield* Deferred.succeed(preferredAnswers, undefined);
      yield* until(() => told.length === 2 && closed.includes("other"));
      expect(told).toEqual(["other Snapshot", "preferred Snapshot"]);
      expect(closed).toEqual(["other"]);
      // Actions on the Machine go through the route it is shown through.
      expect(doors.get("vm")?.name).toBe("preferred");
    }).pipe(Effect.scoped),
  ));
