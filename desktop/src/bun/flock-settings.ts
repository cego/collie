// The Flock's settings on this computer, and each Machine synced with them through its host.

import { Effect, FileSystem, Path, Schema, Semaphore, SubscriptionRef } from "effect";
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
 * host then holds, any edit made there meanwhile among it, for the caller to take in. Asked
 * even with nothing to give, so the Machine records that a Desktop shares its settings.
 */
export const syncSettings = <E>(
  flock: FlockSettings,
  name: string,
  door: SettingsDoor<E>,
  request: string,
) =>
  Effect.gen(function* () {
    const { give } = takeFrom(flock, name, (yield* door.settings()).settings);
    return (yield* door.setSettings({ settings: give, request })).settings;
  });

/** A connected Machine, by name, and its host's door. */
export interface SettingsMachine<E> {
  readonly name: string;
  readonly door: SettingsDoor<E>;
}

/**
 * Syncs connected Machines with the Flock's settings, one at a time. What a Machine answers
 * is taken into the settings as they are by then, so an edit made meanwhile survives, and an
 * edit taken from it goes on to every other connected Machine.
 */
export const flockSync = <E, S>(options: {
  readonly flock: SubscriptionRef.SubscriptionRef<FlockSettings>;
  readonly machines: () => ReadonlyArray<SettingsMachine<E>>;
  readonly save: (flock: FlockSettings) => Effect.Effect<void, S>;
  readonly request: Effect.Effect<string>;
}) =>
  Effect.gen(function* () {
    const syncing = yield* Semaphore.make(1);
    const took = (machine: SettingsMachine<E>) =>
      syncing.withPermits(1)(
        Effect.gen(function* () {
          const has = yield* syncSettings(
            yield* SubscriptionRef.get(options.flock),
            machine.name,
            machine.door,
            yield* options.request,
          );
          const [before, after] = yield* SubscriptionRef.modify(options.flock, (now) => {
            const taken = takeFrom(now, machine.name, has).flock;
            return [[now, taken] as const, taken];
          });
          yield* options.save(after);
          return Object.entries(after.settings).some(
            ([key, { at }]) => before.settings[key]?.at !== at,
          );
        }),
      );
    const syncOn = (machine: SettingsMachine<E>): Effect.Effect<void> =>
      took(machine).pipe(
        Effect.flatMap((changed) =>
          changed
            ? Effect.forEach(
                options.machines().filter(({ name }) => name !== machine.name),
                syncOn,
                { discard: true },
              )
            : Effect.void,
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning(`Settings not synced with ${machine.name}`, cause),
        ),
      );
    const syncEvery = () =>
      Effect.forEach(options.machines(), syncOn, { concurrency: "unbounded", discard: true });
    return { syncOn, syncEvery };
  });
