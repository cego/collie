// The Flock's settings on this computer, and each Machine synced with them through its host.

import { Effect, FileSystem, Path, Schema } from "effect";
import type { SharedSetting, SharedSettings } from "../../../src/board-model";
import { FlockSettings, NO_FLOCK_SETTINGS, takeFrom } from "../shared/flock-settings";

const FlockSettingsFile = Schema.fromJsonString(FlockSettings);
const FILE = "flock-settings.json";

/** The Flock's settings, or none where nothing is saved or it cannot be read. */
export const readFlockSettings = Effect.fn("FlockSettings.read")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString((yield* Path.Path).join(dir, FILE)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(FlockSettingsFile)),
    Effect.orElseSucceed(() => NO_FLOCK_SETTINGS),
  );
});

export const writeFlockSettings = Effect.fn("FlockSettings.write")(function* (
  dir: string,
  flock: FlockSettings,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(
    (yield* Path.Path).join(dir, FILE),
    Schema.encodeSync(FlockSettingsFile)(flock),
  );
});

/** What a Machine's host answers about its settings. */
export interface SettingsDoor<E> {
  readonly settings: () => Effect.Effect<SharedSettings, E>;
  readonly setSettings: (asked: {
    readonly settings: ReadonlyArray<SharedSetting>;
    readonly request: string;
  }) => Effect.Effect<SharedSettings, E>;
}

/**
 * Gives the Machine `name` what it lacks of the Flock's settings, and answers with what its
 * host then holds, any edit made there meanwhile among it, for the caller to take in.
 */
export const syncSettings = <E>(
  flock: FlockSettings,
  name: string,
  door: SettingsDoor<E>,
  request: string,
) =>
  Effect.gen(function* () {
    const has = (yield* door.settings()).settings;
    const { give } = takeFrom(flock, name, has);
    return give.length === 0
      ? has
      : (yield* door.setSettings({ settings: give, request })).settings;
  });
