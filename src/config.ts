// User defaults from the plugin config dir. Optional; the baseline is neutral.

import { Data, Effect, FileSystem, Option, Path, Schema } from "effect";
import { isHostName } from "./gitlab-token";
import { permissionsAsWritten } from "./harness";
import { ensureLockDir, withLock } from "./lock";
import { isNumber, isString } from "./schema";
import {
  type Defaults,
  FALLBACK_DEFAULTS,
  isDensity,
  isQuestionMode,
  isScope,
  parseShared,
  SETTINGS,
  type SettingValue,
} from "./settings";
import type { SharedSetting, SharedSettings } from "./board-model";
import { epochMs } from "./time";
import { isYamlMap, YamlMapSchema, type YamlMap, type YamlValue } from "./yaml";

export { type Defaults, FALLBACK_DEFAULTS } from "./settings";

const ConfigJson = Schema.fromJsonString(YamlMapSchema);
const Models = Schema.Record(Schema.String, Schema.Array(Schema.String));
const Notifications = Schema.Record(Schema.String, Schema.Boolean);

/** The whole config file, for values only a prompt cares about (e.g. linear.team). */
export const readConfig = Effect.fn("Config.readConfig")(function* (userDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const path = paths.join(userDir, "config.json");
  if (!(yield* fs.exists(path))) return {};
  const text = yield* fs.readFileString(path);
  return yield* Schema.decodeUnknownEffect(ConfigJson)(text).pipe(
    Effect.mapError((cause) => new Error(`${path}: ${String(cause)}`)),
  );
});

export function configValue(raw: YamlMap, dotted: string): YamlValue | undefined {
  let node: YamlValue = raw;
  for (const key of dotted.split(".")) {
    if (!isYamlMap(node)) return undefined;
    const next: YamlValue | undefined = node[key];
    if (next === undefined) return undefined;
    node = next;
  }
  return node;
}

/**
 * Remembers an answer the human gave once, e.g. which Linear team is theirs. A number
 * has to arrive as one: `loadDefaults` reads `max_iterations` and `quiet_ms` with
 * `isNumber`, so a string there is silently ignored and the default stays where it was.
 *
 * `null` removes the key, which is the only way to say "unset": an empty string is a
 * configured value, and an empty `harness` is one every Run then fails validation on.
 */
export const writeConfigValue = Effect.fn("Config.writeConfigValue")(function* (
  userDir: string,
  dotted: string,
  value: SettingValue | null,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const raw = yield* readConfig(userDir);
  const keys = dotted.split(".");
  let node = raw;
  for (const key of keys.slice(0, -1)) {
    const next = node[key];
    const child: YamlMap = next !== undefined && isYamlMap(next) ? next : {};
    node[key] = child;
    node = child;
  }
  const last = keys.at(-1);
  if (last === undefined) return;
  if (value === null) delete node[last];
  else node[last] = value;
  yield* fs.makeDirectory(userDir, { recursive: true });
  yield* fs.writeFileString(
    paths.join(userDir, "config.json"),
    `${Schema.encodeSync(ConfigJson)(raw)}\n`,
  );
});

/** When each setting was last set, beside config.json, and which Desktop shares them. */
export const SettingsSet = Schema.Struct({
  set: Schema.Record(Schema.String, Schema.String),
  /** The Desktop that last gave this Machine the Flock's settings. */
  flock: Schema.optionalKey(Schema.Struct({ by: Schema.String, at: Schema.String })),
});
export type SettingsSet = typeof SettingsSet.Type;
const SettingsSetJson = Schema.fromJsonString(SettingsSet);
const SET_FILE = "settings-set.json";

/** What `settings-set.json` holds, or nothing set where there is none or it cannot be read. */
export const readSettingsSet = Effect.fn("Config.readSettingsSet")(function* (userDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  return yield* fs.readFileString(paths.join(userDir, SET_FILE)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SettingsSetJson)),
    Effect.orElseSucceed((): SettingsSet => ({ set: {} })),
  );
});

export const writeSettingsSet = Effect.fn("Config.writeSettingsSet")(function* (
  userDir: string,
  stamps: SettingsSet,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  yield* fs.makeDirectory(userDir, { recursive: true });
  yield* fs.writeFileString(
    paths.join(userDir, SET_FILE),
    `${Schema.encodeSync(SettingsSetJson)(stamps)}\n`,
  );
});

/** Held while config.json and its stamps are read and written, which the TUI and the host both do. */
const settingsLocked = <A, E, R>(userDir: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const lock = (yield* Path.Path).join(userDir, "settings.lock");
    yield* ensureLockDir(lock);
    return yield* withLock(
      lock,
      Effect.fail(new Error(`${lock} could not be acquired; not writing unlocked`)),
      effect,
    );
  });

const writeSetting = Effect.fn("Config.writeSetting")(function* (
  userDir: string,
  key: string,
  value: SettingValue | null,
  at: string,
) {
  yield* writeConfigValue(userDir, key, value);
  const stamps = yield* readSettingsSet(userDir);
  yield* writeSettingsSet(userDir, { ...stamps, set: { ...stamps.set, [key]: at } });
});

/**
 * Writes one of Collie's settings and records `at` as when it was set, which is what
 * decides it across a Flock: the latest edit of a key wins.
 */
export const setSetting = (userDir: string, key: string, value: SettingValue | null, at: string) =>
  settingsLocked(userDir, writeSetting(userDir, key, value, at));

const readShared = Effect.fn("Config.sharedSettings")(function* (userDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const raw = yield* readConfig(userDir);
  const stamps = yield* readSettingsSet(userDir);
  const written = yield* fs.stat(paths.join(userDir, "config.json")).pipe(
    Effect.map((info) => Option.getOrUndefined(info.mtime)?.toISOString()),
    Effect.orElseSucceed(() => undefined),
  );
  const settings = SETTINGS.flatMap(({ key }): ReadonlyArray<SharedSetting> => {
    const value = configValue(raw, key) ?? null;
    const at = stamps.set[key] ?? (value === null ? undefined : written);
    return at === undefined ? [] : [{ key, value, at }];
  });
  // Recorded the first time, so a later write to the file does not make them newer.
  const unstamped = settings.filter(({ key }) => stamps.set[key] === undefined);
  if (unstamped.length > 0)
    yield* writeSettingsSet(userDir, {
      ...stamps,
      set: { ...stamps.set, ...Object.fromEntries(unstamped.map(({ key, at }) => [key, at])) },
    });
  return { settings, flock: stamps.flock ?? null } satisfies SharedSettings;
});

/** This Machine's settings a Flock shares: each ever set, and when, the file's time where unrecorded. */
export const sharedSettings = (userDir: string) => settingsLocked(userDir, readShared(userDir));

/** A shared value refused as one its setting does not take. */
export class SettingRefused extends Data.TaggedError("SettingRefused")<{
  readonly reason: string;
}> {}

/**
 * The Flock's settings, each written where its edit is newer than this Machine's last edit
 * of it. Refused whole, with why, where any one is not a value its setting takes. `by` is
 * the Desktop giving them, recorded so the TUI says they are shared; null for any other door.
 */
export const takeShared = (
  userDir: string,
  given: ReadonlyArray<SharedSetting>,
  by: string | null,
  now: string,
) =>
  settingsLocked(
    userDir,
    Effect.gen(function* () {
      const parsed = [];
      for (const { key, value, at } of given) {
        const one = parseShared(key, value);
        if ("refused" in one) return yield* new SettingRefused({ reason: one.refused });
        parsed.push({ key, value: one.value, at });
      }
      const before = (yield* readSettingsSet(userDir)).set;
      for (const { key, value, at } of parsed) {
        const last = before[key];
        if (last === undefined || epochMs(at) > epochMs(last))
          yield* writeSetting(userDir, key, value, at);
      }
      if (by !== null)
        yield* writeSettingsSet(userDir, {
          ...(yield* readSettingsSet(userDir)),
          flock: { by, at: now },
        });
      return yield* readShared(userDir);
    }),
  );

/** The GitLab this run works against: `GITLAB_HOST` where it names a host, else the setting. */
export const gitlabHostOf = Effect.fn("Config.gitlabHostOf")(function* (env: {
  readonly raw: Readonly<Record<string, string | undefined>>;
  readonly userDir: string;
}) {
  const given = env.raw["GITLAB_HOST"];
  return given !== undefined && isHostName(given)
    ? given
    : (yield* loadDefaults(env.userDir)).gitlabHost;
});

export const loadDefaults = Effect.fn("Config.loadDefaults")(function* (userDir: string) {
  const raw = yield* readConfig(userDir);
  const defaults: Defaults = {
    harness: isString(raw.harness) ? raw.harness : FALLBACK_DEFAULTS.harness,
    model: isString(raw.model) ? raw.model : FALLBACK_DEFAULTS.model,
    maxIterations: isNumber(raw.max_iterations)
      ? raw.max_iterations
      : FALLBACK_DEFAULTS.maxIterations,
    handoffTimeoutMs: isNumber(raw.handoff_timeout_ms)
      ? raw.handoff_timeout_ms
      : FALLBACK_DEFAULTS.handoffTimeoutMs,
    quietMs: isNumber(raw.quiet_ms) ? raw.quiet_ms : FALLBACK_DEFAULTS.quietMs,
    boardQuietMs: isNumber(raw.board_quiet_ms)
      ? raw.board_quiet_ms
      : FALLBACK_DEFAULTS.boardQuietMs,
    compactAtTokens: isNumber(raw.compact_at_tokens)
      ? raw.compact_at_tokens
      : FALLBACK_DEFAULTS.compactAtTokens,
    models: Option.getOrElse(Schema.decodeUnknownOption(Models)(raw.models), () => ({})),
    fallbacks: Option.getOrElse(
      Schema.decodeUnknownOption(Schema.Array(Schema.String))(raw.fallbacks),
      () => [],
    ),
    trust: raw.trust === "auto" || raw.trust === "never" ? raw.trust : FALLBACK_DEFAULTS.trust,
    // As written rather than coerced: `loadDefaults` is read by the Settings and
    // Workflows views and by Doctor, so a file hand-edited into nonsense still has to
    // return — and coercing it would hide it. Validation names it.
    permissions: permissionsAsWritten(raw.permissions) ?? FALLBACK_DEFAULTS.permissions,
    // Coerced rather than kept as written: the board has to open on one of the two
    // whatever the file says. A value that is neither is refused where it is written.
    scope: isString(raw.scope) && isScope(raw.scope) ? raw.scope : FALLBACK_DEFAULTS.scope,
    // Coerced like `scope`: the board has to draw at one of the two whatever the file
    // says. A value that is neither is refused where it is written.
    density:
      isString(raw.density) && isDensity(raw.density) ? raw.density : FALLBACK_DEFAULTS.density,
    notifications: Option.getOrElse(
      Schema.decodeUnknownOption(Notifications)(raw.notifications),
      () => ({}),
    ),
    // Coerced like `scope`: a Driver has to do one of the two whatever the file says,
    // and the backward-compatible one is the focus every install already had. A value
    // that is neither is refused where it is written.
    questions:
      isString(raw.questions) && isQuestionMode(raw.questions)
        ? raw.questions
        : FALLBACK_DEFAULTS.questions,
    // Only an explicit `false` turns it off: anything else, including a value nobody
    // meant, leaves a human being told what happened.
    proactive: raw.proactive !== false,
    // Coerced like `scope`; a value that is not a host name is refused where it is written.
    gitlabHost:
      isString(raw.gitlab_host) && isHostName(raw.gitlab_host)
        ? raw.gitlab_host
        : FALLBACK_DEFAULTS.gitlabHost,
  };
  if (isString(raw.effort)) defaults.effort = raw.effort;
  return defaults;
});
