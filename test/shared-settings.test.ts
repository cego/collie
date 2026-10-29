// Collie's settings as a Machine's host shares them: each with when it was last set, and
// written by the host for a front door with the edit's own time, so the latest edit of a
// key wins wherever it was made.

import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { expect, test } from "bun:test";
import { Effect, FileSystem } from "effect";
import {
  loadDefaults,
  readSettingsSet,
  setSetting,
  takeShared,
  writeConfigValue,
} from "../src/config";
import { runEffect } from "./support/effect";
import { connect } from "../src/host";
import { stopHost } from "./support/host";
import { collie, proves } from "./support/world";

test(
  "a host shares its settings with when each was set, and keeps the latest edit of each",
  () =>
    proves(
      "collie-shared-settings-",
      (world) =>
        Effect.gen(function* () {
          // Set before anything recorded when: the file's own time stands in for it.
          yield* writeConfigValue(world.config, "scope", "all");
          yield* setSetting(world.config, "model", "sonnet", "2026-10-07T10:00:00.000Z");
          // A remembered answer is this Machine's own and is never shared.
          yield* writeConfigValue(world.config, "linear.team", "CEG");
          const client = yield* connect(world.state);
          yield* client.declare({ frontDoor: "desktop" });

          const shared = yield* client.settings();
          expect(shared.flock).toBeNull();
          expect(Arr.map(shared.settings, ({ key }) => key).sort()).toEqual(["model", "scope"]);
          expect(
            Option.getOrUndefined(Arr.findFirst(shared.settings, ({ key }) => key === "model")),
          ).toEqual({
            key: "model",
            value: "sonnet",
            at: "2026-10-07T10:00:00.000Z",
          });
          const dated = Option.getOrUndefined(
            Arr.findFirst(shared.settings, ({ key }) => key === "scope"),
          )!.at;
          // Dated once, so a later write to the file cannot make the old value newer.
          expect((yield* readSettingsSet(world.config)).set.scope).toBe(dated);

          const after = yield* client.setSettings({
            request: "s-1",
            settings: [
              // Later than the clock, so these outlast the scope dated as it was read.
              { key: "proactive", value: false, at: "2099-10-07T11:00:00.000Z" },
              // Older than this Machine's own edit, so the Machine's stands.
              { key: "model", value: "haiku", at: "2026-10-07T09:00:00.000Z" },
              { key: "scope", value: null, at: "2099-10-07T11:00:00.000Z" },
            ],
          });
          const defaults = yield* loadDefaults(world.config);
          expect([defaults.proactive, defaults.model, defaults.scope]).toEqual([
            false,
            "sonnet",
            "local",
          ]);
          expect(after.flock).toMatchObject({ by: "desktop" });
          expect(
            Option.getOrUndefined(Arr.findFirst(after.settings, ({ key }) => key === "scope")),
          ).toEqual({
            key: "scope",
            value: null,
            at: "2099-10-07T11:00:00.000Z",
          });
          expect((yield* readSettingsSet(world.config)).set.proactive).toBe(
            "2099-10-07T11:00:00.000Z",
          );

          const refused = yield* client
            .setSettings({
              request: "s-2",
              settings: [{ key: "scope", value: "everywhere", at: "2099-10-07T12:00:00.000Z" }],
            })
            .pipe(Effect.flip);
          expect(refused).toMatchObject({ _tag: "HostRefused" });
          const notOne = yield* client
            .setSettings({
              request: "s-3",
              settings: [{ key: "linear.team", value: "X", at: "2099-10-07T12:00:00.000Z" }],
            })
            .pipe(Effect.flip);
          expect(notOne).toMatchObject({ _tag: "HostRefused" });

          // An agent sets one as a human would, through the host.
          const said = yield* collie(world, ["settings", "set", "max_iterations", "9"]);
          expect(said.envelope).toMatchObject({ ok: true });
          expect((yield* loadDefaults(world.config)).maxIterations).toBe(9);
          // Only a Desktop marks the settings shared with the Flock.
          expect((yield* readSettingsSet(world.config)).flock).toEqual(after.flock!);
          const nine = yield* collie(world, ["settings", "set", "max_iterations", "nine"]);
          expect(nine.envelope).toMatchObject({ ok: false });
          yield* stopHost(world.state);
        }),
      [],
    ),
  120_000,
);

test("a Flock's auto-compact window is taken when it is the latest edit, and refused whole when Claude Code would not take it", () =>
  runEffect(
    Effect.gen(function* () {
      const userDir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      const now = "2026-10-12T12:00:00.000Z";
      const refused = yield* takeShared(
        userDir,
        [
          { key: "model", value: "sonnet", at: "2026-10-12T10:00:00.000Z" },
          { key: "claude_auto_compact_window", value: "500k", at: "2026-10-12T10:00:00.000Z" },
        ],
        "desktop",
        now,
      ).pipe(Effect.flip);
      expect(refused).toMatchObject({
        _tag: "SettingRefused",
        reason: expect.stringContaining("from 100000 to 1000000, or auto"),
      });
      expect((yield* loadDefaults(userDir)).model).toBe("opus");

      yield* takeShared(
        userDir,
        [{ key: "claude_auto_compact_window", value: 500000, at: "2026-10-12T10:00:00.000Z" }],
        "desktop",
        now,
      );
      expect((yield* loadDefaults(userDir)).claudeAutoCompactWindow).toBe(500000);
    }).pipe(Effect.scoped),
  ));
