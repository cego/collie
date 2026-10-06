// What the human set in Desktop, kept on this computer beside the Flock chat's session.

import { Effect, FileSystem, Path, Schema } from "effect";
import { DesktopSettings } from "../shared/flock";

const SettingsFile = Schema.fromJsonString(DesktopSettings);
const FILE = "settings.json";

/** The saved settings, or the defaults where nothing is saved or it cannot be read. */
export const readSettings = Effect.fn("Settings.read")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString((yield* Path.Path).join(dir, FILE)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SettingsFile)),
    Effect.orElseSucceed(() => Schema.decodeUnknownSync(DesktopSettings)({})),
  );
});

export const writeSettings = Effect.fn("Settings.write")(function* (
  dir: string,
  settings: DesktopSettings,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(
    (yield* Path.Path).join(dir, FILE),
    Schema.encodeSync(SettingsFile)(settings),
  );
});
