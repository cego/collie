// The Flock's settings and shared definitions on this computer, and each Machine synced with
// them through its host.

import {
  Cause,
  Effect,
  FileSystem,
  Option,
  Path,
  Schema,
  Semaphore,
  SubscriptionRef,
} from "effect";
import type { SharedSetting, SharedSettings } from "../../../src/board-model";
import type { SharedDefinition } from "../../../src/definitions-model";
import { latestEdits } from "../../../src/flock-settings";
import { FlockSettings, NO_FLOCK_SETTINGS, takeFrom } from "../shared/flock-settings";

const FlockSettingsFile = Schema.fromJsonString(FlockSettings);
const FILE = "flock-settings.json";

/** The Flock's settings, empty only where no file exists. */
export const readFlockSettings = Effect.fn("FlockSettings.read")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString((yield* Path.Path).join(dir, FILE)).pipe(
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(error),
    ),
    Effect.flatMap((text) =>
      text === null
        ? Effect.succeed(NO_FLOCK_SETTINGS)
        : Schema.decodeUnknownEffect(FlockSettingsFile)(text),
    ),
  );
});

export const writeFlockSettings = Effect.fn("FlockSettings.write")(function* (
  dir: string,
  flock: FlockSettings,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* readFlockSettings(dir);
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(
    (yield* Path.Path).join(dir, FILE),
    Schema.encodeSync(FlockSettingsFile)(flock),
  );
});

/** The Flock's shared definitions by path in the user directory, each its latest edit. */
export const FlockDefinitions = Schema.Record(
  Schema.String,
  Schema.Struct({
    /** Its bytes in base64, or null where the edit removed it. */
    base64: Schema.NullOr(Schema.String),
    at: Schema.String,
    /** The Machine whose edit it is. */
    from: Schema.String,
  }),
);
export type FlockDefinitions = typeof FlockDefinitions.Type;

const FlockDefinitionsFile = Schema.fromJsonString(FlockDefinitions);
const DEFINITIONS_FILE = "flock-definitions.json";

/** The Flock's shared definitions, or none where nothing is saved or it cannot be read. */
export const readFlockDefinitions = Effect.fn("FlockDefinitions.read")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString((yield* Path.Path).join(dir, DEFINITIONS_FILE)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(FlockDefinitionsFile)),
    Effect.orElseSucceed((): FlockDefinitions => ({})),
  );
});

export const writeFlockDefinitions = Effect.fn("FlockDefinitions.write")(function* (
  dir: string,
  flock: FlockDefinitions,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(
    (yield* Path.Path).join(dir, DEFINITIONS_FILE),
    Schema.encodeSync(FlockDefinitionsFile)(flock),
  );
});

const heldDefinitions = (flock: FlockDefinitions) =>
  Object.entries(flock).map(([path, { base64, at }]): SharedDefinition => ({ path, base64, at }));
const byPath = (definition: { readonly path: string }) => definition.path;

/** What a Machine has taken in where it is the later edit, and what it should then be given. */
export const takeDefinitions = (
  flock: FlockDefinitions,
  machine: string,
  has: ReadonlyArray<SharedDefinition>,
) => {
  const taken = { ...flock };
  for (const { path, base64, at } of latestEdits(heldDefinitions(flock), has, byPath).take)
    taken[path] = { base64, at, from: machine };
  return { flock: taken, give: latestEdits(heldDefinitions(taken), has, byPath).give };
};

/** What a Machine's host answers about its shared definitions. */
export interface DefinitionsDoor<E> {
  readonly sharedDefinitions: () => Effect.Effect<ReadonlyArray<SharedDefinition>, E>;
  readonly setSharedDefinitions: (asked: {
    readonly definitions: ReadonlyArray<SharedDefinition>;
    readonly request: string;
  }) => Effect.Effect<ReadonlyArray<SharedDefinition>, E>;
}

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

const Refusal = Schema.Struct({ reason: Schema.String });

/** Why a sync failed, in its host's words where it gave some. */
const reasonOf = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);
  const said = Option.match(Schema.decodeUnknownOption(Refusal)(error), {
    onSome: ({ reason }) => reason,
    onNone: () => (error instanceof Error ? error.message : String(error)),
  });
  return said.startsWith("Unknown request tag")
    ? "its Collie is too old for this; upgrade it"
    : said;
};

interface Synced<T, M> {
  readonly flock: SubscriptionRef.SubscriptionRef<T>;
  readonly machines: () => ReadonlyArray<M>;
  readonly save: (flock: T) => Effect.Effect<void, unknown>;
  readonly request: Effect.Effect<string>;
  readonly told: (machine: M, failed: string | null) => Effect.Effect<void>;
}

/**
 * Syncs connected Machines with what the Flock holds, one at a time. What a Machine answers
 * is taken into it as it is by then, so an edit made meanwhile survives, and an edit taken
 * from it goes on to every other connected Machine. Each sync tells how it ended.
 */
const latestSync = <T, Has, M extends { readonly name: string }>(
  options: Synced<T, M> & {
    readonly what: string;
    readonly exchange: (held: T, machine: M, request: string) => Effect.Effect<Has, unknown>;
    readonly take: (now: T, machine: string, has: Has) => T;
    readonly edits: (held: T) => Readonly<Record<string, { readonly at: string }>>;
  },
) =>
  Effect.gen(function* () {
    const syncing = yield* Semaphore.make(1);
    const took = (machine: M) =>
      syncing.withPermits(1)(
        Effect.gen(function* () {
          const has = yield* options.exchange(
            yield* SubscriptionRef.get(options.flock),
            machine,
            yield* options.request,
          );
          const [before, after] = yield* SubscriptionRef.modify(options.flock, (now) => {
            const taken = options.take(now, machine.name, has);
            return [[now, taken] as const, taken];
          });
          yield* options.save(after);
          const was = options.edits(before);
          return Object.entries(options.edits(after)).some(([key, { at }]) => was[key]?.at !== at);
        }),
      );
    /** Why the sync with `machine` failed, or null. */
    const syncOn = (machine: M): Effect.Effect<string | null> =>
      took(machine).pipe(
        Effect.tap(() => options.told(machine, null)),
        Effect.flatMap((changed) =>
          changed
            ? Effect.forEach(
                options.machines().filter(({ name }) => name !== machine.name),
                syncOn,
                { discard: true },
              )
            : Effect.void,
        ),
        Effect.as(null),
        Effect.catchCause((cause) => {
          const failed = reasonOf(cause);
          return Effect.logWarning(`${options.what} not synced with ${machine.name}`, cause).pipe(
            Effect.andThen(options.told(machine, failed)),
            Effect.as(failed),
          );
        }),
      );
    const syncEvery = () =>
      Effect.forEach(options.machines(), syncOn, { concurrency: "unbounded", discard: true });
    return { syncOn, syncEvery };
  });

/** Syncs connected Machines with the Flock's settings. */
export const flockSync = <E, M extends SettingsMachine<E>>(options: Synced<FlockSettings, M>) =>
  latestSync({
    ...options,
    what: "Settings",
    exchange: (flock, { name, door }, request) => syncSettings(flock, name, door, request),
    take: (now, name, has: ReadonlyArray<SharedSetting>) => takeFrom(now, name, has).flock,
    edits: (flock) => flock.settings,
  });

/** Syncs connected Machines with the Flock's shared definitions, giving only what one lacks. */
export const definitionsSync = <
  E,
  M extends { readonly name: string; readonly door: DefinitionsDoor<E> },
>(
  options: Synced<FlockDefinitions, M>,
) =>
  latestSync({
    ...options,
    what: "Definitions",
    exchange: (flock, { name, door }, request) =>
      Effect.gen(function* () {
        const has = yield* door.sharedDefinitions();
        const { give } = takeDefinitions(flock, name, has);
        return give.length === 0
          ? has
          : yield* door.setSharedDefinitions({ definitions: give, request });
      }),
    take: (now, name, has: ReadonlyArray<SharedDefinition>) =>
      takeDefinitions(now, name, has).flock,
    edits: (flock) => flock,
  });
