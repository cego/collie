import { expect, test } from "bun:test";
import { Clock, ConfigProvider, Effect, Fiber, FileSystem, SubscriptionRef } from "effect";
import { readAudit } from "../src/audit";
import { BUILD, connectPeer, frontDoor, ownerOf, socketOf } from "../src/host";
import { readSettingsSet, setSetting, sharedSettings, takeShared } from "../src/config";
import {
  flockSync,
  readFlockSettings,
  writeFlockSettings,
} from "../desktop/src/bun/flock-settings";
import { editSetting, NO_FLOCK_SETTINGS } from "../desktop/src/shared/flock-settings";
import { levelPeer, peersOf, runShell, type Link } from "../src/peers";
import { runEffect } from "./support/effect";
import { until } from "./support/host";
import { releaseBinary, twoMachines } from "./support/peers";
import { collieCommand } from "./support/world";
import type { PlatformServices } from "../src/platform";
import { TestClock } from "effect/testing";

test(
  "a Machine's shell returns its exit and both streams, takes stdin and records its Actor",
  () =>
    runEffect(
      twoMachines(
        "collie-shell-",
        (first) =>
          Effect.gen(function* () {
            yield* first.cli(["machine", "list"]);
            const door = yield* frontDoor(socketOf(first.world.state));
            yield* door.declare({ frontDoor: "desktop", from: { client: "test-desktop" } });
            const result = yield* door.shell({
              request: "shell-1",
              script: 'read value; printf "answer:%s" "$value"; printf warning >&2; exit 3',
              stdin: "from stdin\n",
            });
            expect(result).toMatchObject({ code: 3, stdout: "answer:from stdin" });
            expect(result.stderr).toContain("warning");
            expect((yield* readAudit(`${first.world.state}/shell`))[0]?.actor).toMatchObject({
              origin: "desktop",
              from: { client: "test-desktop" },
            });
          }),
        [],
      ),
    ),
  180_000,
);

test(
  "paired hosts share the latest settings without Desktop, keep edit times and leave gitlab_host local",
  () =>
    runEffect(
      twoMachines(
        "collie-level-",
        (first, second) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            yield* setSetting(first.world.config, "model", "sonnet", "2099-10-12T10:00:00.000Z");
            yield* setSetting(
              first.world.config,
              "gitlab_host",
              "gitlab.example.com",
              "2099-10-12T10:00:00.000Z",
            );
            yield* first.lists([second]);
            expect((yield* first.cli(["--machine", "second", "board"])).envelope.ok).toBe(true);
            const [laptop] = yield* peersOf(second.world.state);
            // The timestamp and sender are separate writes. Wait for the whole update,
            // and assert that snapshot rather than reading during the next write.
            const received = yield* until(
              () => readSettingsSet(second.world.config),
              (has) =>
                has.set.model === "2099-10-12T10:00:00.000Z" && has.flock?.by === laptop!.name,
            );
            expect(received.flock?.by).toBe(laptop!.name);
            const there = yield* frontDoor(socketOf(second.world.state));
            expect(
              (yield* there.settings()).settings.find((one) => one.key === "gitlab_host"),
            ).toBeUndefined();
            yield* setSetting(second.world.config, "model", "haiku", "2099-10-12T11:00:00.000Z");
            yield* until(
              () => readSettingsSet(first.world.config),
              (has) => has.set.model === "2099-10-12T11:00:00.000Z",
            );
            expect(yield* fs.readFileString(`${first.world.config}/config.json`)).toContain(
              "haiku",
            );
            yield* setSetting(first.world.config, "model", "opus", "2099-10-12T12:00:00.000Z");
            yield* until(
              () => there.settings(),
              (has) => has.settings.some((one) => one.key === "model" && one.value === "opus"),
            );
            expect((yield* readSettingsSet(second.world.config)).set.model).toBe(
              "2099-10-12T12:00:00.000Z",
            );
            yield* Effect.all(
              [
                setSetting(first.world.config, "model", "haiku", "2099-10-12T13:00:00.000Z"),
                setSetting(second.world.config, "model", "sonnet", "2099-10-12T14:00:00.000Z"),
              ],
              { concurrency: "unbounded" },
            );
            yield* until(
              () =>
                Effect.all([
                  readSettingsSet(first.world.config),
                  readSettingsSet(second.world.config),
                ]),
              (both) => both.every((has) => has.set.model === "2099-10-12T14:00:00.000Z"),
            );
            expect(yield* fs.readFileString(`${first.world.config}/config.json`)).toContain(
              "sonnet",
            );
            const desktop = `${first.world.home}/desktop`;
            const services = yield* Effect.context<PlatformServices>();
            const flock = yield* SubscriptionRef.make(NO_FLOCK_SETTINGS);
            const machines = [first, second].map((side) => ({
              name: side.name,
              door: {
                settings: () =>
                  sharedSettings(side.world.config).pipe(Effect.provideContext(services)),
                setSettings: ({ settings }: { settings: Parameters<typeof takeShared>[1] }) =>
                  takeShared(
                    side.world.config,
                    settings,
                    "Desktop",
                    "2099-10-12T15:00:00.000Z",
                  ).pipe(
                    Effect.andThen(sharedSettings(side.world.config)),
                    Effect.provideContext(services),
                  ),
              },
            }));
            const sync = yield* flockSync({
              flock,
              machines: () => machines,
              save: (value) =>
                writeFlockSettings(desktop, value).pipe(Effect.provideContext(services)),
              request: Effect.succeed("desktop-sync"),
              told: () => Effect.void,
            });
            yield* sync.syncOn(machines[0]!);
            expect((yield* readFlockSettings(desktop)).settings.model?.at).toBe(
              "2099-10-12T14:00:00.000Z",
            );
            const edited = editSetting(
              yield* SubscriptionRef.get(flock),
              "model",
              "opus",
              "2099-10-12T16:00:00.000Z",
            );
            if ("refused" in edited) throw new Error(edited.refused);
            yield* SubscriptionRef.set(flock, edited);
            yield* sync.syncOn(machines[0]!);
            yield* until(
              () => readSettingsSet(second.world.config),
              (has) => has.set.model === "2099-10-12T16:00:00.000Z",
            );
            yield* sync.syncOn(machines[1]!);
            expect((yield* readFlockSettings(desktop)).settings.model).toMatchObject({
              value: "opus",
              at: "2099-10-12T16:00:00.000Z",
            });
          }),
        [],
      ),
    ),
  180_000,
);

test("a noisy shell is refused and its process is stopped", () =>
  runEffect(
    runShell("yes output").pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() =>
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { reason: "the shell produced more than 1 MiB of output" },
          }),
        ),
      ),
      Effect.asVoid,
    ),
  ));

test(
  "the newer paired release upgrades the older one, replaces its host and restores the link",
  () =>
    runEffect(
      twoMachines(
        "collie-release-",
        (first, second) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const older = `${first.world.home}/older-collie`;
            const newer = (yield* collieCommand)[0]!;
            yield* releaseBinary(older, "0.0.1");
            const bin = first.env.PATH!.split(":")[0]!;
            const log = `${first.world.home}/upgrades`;
            yield* fs.writeFileString(
              `${bin}/collie`,
              `#!/bin/sh\nif [ "$1 $2 $3" = "--json upgrade --to" ]; then\n echo "$4" >> '${log}'\n cp '${newer}' '${older}.new' && chmod +x '${older}.new' && mv '${older}.new' '${older}'\n exit $?\nfi\nexec '${older}' "$@"\n`,
              { mode: 0o755 },
            );
            const onOlder = (args: ReadonlyArray<string>) =>
              first
                .cli(args, { COLLIE_HOST: JSON.stringify([older]) })
                .pipe(
                  Effect.provide(
                    ConfigProvider.layerAdd(
                      ConfigProvider.fromUnknown({ COLLIE_TEST_BINARY: older }),
                      { asPrimary: true },
                    ),
                  ),
                );
            yield* onOlder(["machine", "list"]);
            const before = yield* ownerOf(first.world.state);
            yield* first.lists([second]);
            yield* onOlder(["--machine", "second", "board"]);
            yield* until(
              () => fs.exists(log),
              (exists) => exists,
            );
            expect((yield* fs.readFileString(log)).trim()).toBe(BUILD);
            yield* until(
              () => ownerOf(first.world.state),
              (owner) => owner !== null && owner.pid !== before?.pid,
            );
            const [laptop] = yield* peersOf(second.world.state);
            const board = yield* until(
              () => second.cli(["--machine", laptop!.name, "board"]),
              (read) => read.envelope.ok,
            );
            expect(board.envelope.ok).toBe(true);
            const connected = yield* connectPeer(second.world.state, laptop!.name, {
              as: "cli",
              client: "test",
            });
            expect((yield* connected.identity()).build).toBe(BUILD);
          }),
        [],
      ),
    ),
  180_000,
);

test(
  "the shell's ten-minute bound stops its process group",
  () =>
    runEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "collie-shell-bound-" });
        const clock = yield* TestClock.make();
        const running = yield* Effect.forkScoped(
          runShell(`trap '' TERM; touch '${dir}/started'; exec sleep 6000`).pipe(
            Effect.provideService(Clock.Clock, clock),
            Effect.result,
          ),
        );
        yield* until(
          () => fs.exists(`${dir}/started`),
          (started) => started,
        );
        yield* clock.adjust("10 minutes");
        const ended = yield* Fiber.join(running);
        expect(ended).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "HostRefused", reason: "the shell did not finish within 10 minutes" },
        });
      }),
    ),
  30_000,
);

test(
  "a development checkout on either side neither upgrades nor is upgraded",
  () =>
    runEffect(
      Effect.gen(function* () {
        const builds: ReadonlyArray<{
          own: Pick<Link, "build" | "development">;
          far: { build: string; development?: string };
        }> = [
          { own: { build: "1.2.0", development: "1.2.0+checkout" }, far: { build: "1.1.0" } },
          { own: { build: "1.2.0" }, far: { build: "1.1.0", development: "1.1.0+checkout" } },
        ];
        for (const { own, far } of builds) {
          const calls: string[] = [];
          const client: Effect.Success<ReturnType<Link["connect"]>> = {
            identity: () => Effect.succeed(far),
            shell: ({ script }) =>
              Effect.sync(() => {
                calls.push(script);
                return { code: 0, stdout: "", stderr: "" };
              }),
            refresh: () =>
              Effect.sync(() => {
                calls.push("refresh");
                return true;
              }),
            settings: () => Effect.succeed({ settings: [], flock: null }),
            setSettings: ({ settings }) => Effect.succeed({ settings, flock: null }),
            sharedDefinitions: () => Effect.succeed([]),
            setSharedDefinitions: ({ definitions }) => Effect.succeed(definitions),
          };
          const link: Link = {
            ...own,
            dir: "test",
            userDir: "test",
            installation: "own",
            stamp: "test",
            socket: "test",
            connect: () => Effect.succeed(client),
            tell: () => Effect.void,
            machines: Effect.succeed([]),
          };
          yield* levelPeer(link, {
            installation: "other",
            name: "other",
            dials: "out",
            secret: "test",
          });
          expect(calls).toEqual([]);
        }
      }),
    ),
  30_000,
);
