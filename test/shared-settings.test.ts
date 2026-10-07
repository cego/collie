// Collie's settings as a Machine's host shares them: each with when it was last set, and
// written by the host for a front door with the edit's own time, so the latest edit of a
// key wins wherever it was made.

import { expect, test } from "bun:test";
import { Effect } from "effect";
import { loadDefaults, readSettingsSet, setSetting, writeConfigValue } from "../src/config";
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
          expect(shared.settings.map(({ key }) => key).sort()).toEqual(["model", "scope"]);
          expect(shared.settings.find(({ key }) => key === "model")).toEqual({
            key: "model",
            value: "sonnet",
            at: "2026-10-07T10:00:00.000Z",
          });
          const dated = shared.settings.find(({ key }) => key === "scope")!.at;
          // Dated once, so a later write to the file cannot make the old value newer.
          expect((yield* readSettingsSet(world.config)).set.scope).toBe(dated);

          const after = yield* client.setSettings({
            request: "s-1",
            settings: [
              { key: "proactive", value: false, at: "2026-10-07T11:00:00.000Z" },
              // Older than this Machine's own edit, so the Machine's stands.
              { key: "model", value: "haiku", at: "2026-10-07T09:00:00.000Z" },
              { key: "scope", value: null, at: "2026-10-07T11:00:00.000Z" },
            ],
          });
          const defaults = yield* loadDefaults(world.config);
          expect([defaults.proactive, defaults.model, defaults.scope]).toEqual([
            false,
            "sonnet",
            "local",
          ]);
          expect(after.flock).toMatchObject({ by: "desktop" });
          expect(after.settings.find(({ key }) => key === "scope")).toEqual({
            key: "scope",
            value: null,
            at: "2026-10-07T11:00:00.000Z",
          });
          expect((yield* readSettingsSet(world.config)).set.proactive).toBe(
            "2026-10-07T11:00:00.000Z",
          );

          const refused = yield* client
            .setSettings({
              request: "s-2",
              settings: [{ key: "scope", value: "everywhere", at: "2026-10-07T12:00:00.000Z" }],
            })
            .pipe(Effect.flip);
          expect(refused).toMatchObject({ _tag: "HostRefused" });
          const notOne = yield* client
            .setSettings({
              request: "s-3",
              settings: [{ key: "linear.team", value: "X", at: "2026-10-07T12:00:00.000Z" }],
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
