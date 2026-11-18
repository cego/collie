import * as Cause from "effect/Cause";

import * as Str from "effect/String";
import { pipe as pipe_ } from "effect/Function";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import { Data, Effect, FileSystem, Option, Path, Schema } from "effect";
import { isHostName } from "./gitlab-token";
import { permissionsAsWritten } from "./harness";
import { byKey, latestEdits } from "./flock-settings";
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
  WORKTREES_DIRECTORY,
} from "./settings";
import type { SharedSetting, SharedSettings } from "./board-model";
import { isReachKey, REACH_SETTING, reachKey } from "./reach";
import { isYamlMap, YamlMapSchema, type YamlMap, type YamlValue } from "./yaml";

export { type Defaults, FALLBACK_DEFAULTS } from "./settings";

const ConfigJson = Schema.fromJsonString(YamlMapSchema);
const Models = Schema.Record(Schema.String, Schema.Array(Schema.String));
const Notifications = Schema.Record(Schema.String, Schema.Boolean);

export const readConfig = Effect.fn("Config.readConfig")(function* (userDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const path = paths.join(userDir, "config.json");
  if (!(yield* fs.exists(path))) return {};
  const text = yield* fs.readFileString(path);
  return yield* Schema.decodeEffect(ConfigJson)(text).pipe(
    Effect.mapError((cause) => new Cause.UnknownError(cause, `${path}: ${String(cause)}`)),
  );
});

export function configValue(raw: YamlMap, dotted: string) {
  let node: YamlValue = raw;
  for (const key of Str.split(dotted, ".")) {
    if (!isYamlMap(node)) return undefined;
    const next: YamlValue | undefined = node[key];
    if (next === undefined) return undefined;
    node = next;
  }
  return node;
}

export const writeConfigValue = Effect.fn("Config.writeConfigValue")(function* (
  userDir: string,
  dotted: string,
  value: SettingValue | null,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const raw = yield* readConfig(userDir);
  const keys = Str.split(dotted, ".");
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
    `${yield* Schema.encodeEffect(ConfigJson)(raw).pipe(Effect.orDie)}\n`,
  );
});

export const SettingsSet = Schema.Struct({
  set: Schema.Record(Schema.String, Schema.String),
  flock: Schema.optionalKey(Schema.Struct({ by: Schema.String, at: Schema.String })),
});
export type SettingsSet = typeof SettingsSet.Type;
const SettingsSetJson = Schema.fromJsonString(SettingsSet);
const SET_FILE = "settings-set.json";

export const readSettingsSet = Effect.fn("Config.readSettingsSet")(function* (userDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  return yield* fs.readFileString(paths.join(userDir, SET_FILE)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SettingsSetJson)),
    Effect.orElseSucceed(() => {
      const returned: SettingsSet = { set: {} };
      return returned;
    }),
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
    `${yield* Schema.encodeEffect(SettingsSetJson)(stamps).pipe(Effect.orDie)}\n`,
  );
});

const settingsLocked = <A, E, R>(userDir: string, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const lock = (yield* Path.Path).join(userDir, "settings.lock");
    yield* ensureLockDir(lock);
    return yield* withLock(
      lock,
      Effect.fail(new Cause.TimeoutError(`${lock} could not be acquired; not writing unlocked`)),
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
  const shared = [
    ...Arr.map(
      Arr.filter(SETTINGS, (setting) => setting.machine !== true),
      ({ key }) => key,
    ),
    ...new Set([...reachKeysIn(raw), ...Arr.filter(Rec.keys(stamps.set), isReachKey)]),
  ];
  const settings = Arr.flatMap(shared, (key) => {
    const value = configValue(raw, key) ?? null;
    const at = stamps.set[key] ?? (value === null ? undefined : written);
    return at === undefined ? [] : [{ key, value, at }];
  });
  const unstamped = Arr.filter(settings, ({ key }) => stamps.set[key] === undefined);
  if (unstamped.length > 0)
    yield* writeSettingsSet(userDir, {
      ...stamps,
      set: {
        ...stamps.set,
        ...Rec.fromEntries(Arr.map(unstamped, ({ key, at }) => [key, at] as const)),
      },
    });
  const returned: SharedSettings = { settings, flock: stamps.flock ?? null };
  return returned;
});

function reachKeysIn(raw: YamlMap) {
  const held = raw[REACH_SETTING];
  if (held === undefined || !isYamlMap(held)) return [];
  return Arr.flatMap(Rec.toEntries(held), ([workflow, projects]) =>
    isYamlMap(projects)
      ? Arr.map(Rec.toEntries(projects), ([project]) => `${REACH_SETTING}.${workflow}.${project}`)
      : [],
  );
}

export const savedReach = (userDir: string, workflow: string, project: string) =>
  readConfig(userDir).pipe(
    Effect.map((raw) => {
      const value = configValue(raw, reachKey(workflow, project));
      return isString(value) && value !== "" ? value : null;
    }),
    Effect.orElseSucceed(() => null),
  );

export const savedReaches = (userDir: string) =>
  readConfig(userDir).pipe(
    Effect.map((raw) =>
      Arr.flatMap(reachKeysIn(raw), (key) => {
        const value = configValue(raw, key);
        const [, workflow = "", project = ""] = Str.split(key, ".");
        return isString(value) && value !== ""
          ? [{ workflow, project: decodeURIComponent(project), value }]
          : [];
      }),
    ),
    Effect.orElseSucceed(() => []),
  );

export const sharedSettings = (userDir: string) => settingsLocked(userDir, readShared(userDir));

export const standingDirectionOn = (userDir: string) =>
  sharedSettings(userDir).pipe(
    Effect.map(({ settings }) => {
      const held = Arr.findFirst(settings, ({ key }) => key === "standing_direction");
      return Option.match(held, {
        onNone: () => undefined,
        onSome: ({ value, at }) =>
          isString(value) && Str.trim(value) !== "" ? { text: value, at } : undefined,
      });
    }),
  );

export class SettingRefused extends Data.TaggedError("SettingRefused")<{
  readonly reason: string;
}> {}

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
      const before = Arr.map(Rec.toEntries((yield* readSettingsSet(userDir)).set), ([key, at]) => ({
        key,
        at,
      }));
      for (const { key, value, at } of latestEdits(before, parsed, byKey).take)
        yield* writeSetting(userDir, key, value, at);
      if (by !== null)
        yield* writeSettingsSet(userDir, {
          ...(yield* readSettingsSet(userDir)),
          flock: { by, at: now },
        });
      return yield* readShared(userDir);
    }),
  );

export const worktreesDirectory = (env: { readonly home: string; readonly userDir: string }) =>
  readConfig(env.userDir).pipe(
    Effect.map((raw) => raw.worktrees_directory),
    Effect.orElseSucceed(() => undefined),
    Effect.map((set) => {
      const dir = isString(set) && set !== "" ? set : WORKTREES_DIRECTORY;
      return pipe_(dir, Str.startsWith("~/")) ? `${env.home}/${pipe_(dir, Str.slice(2))}` : dir;
    }),
  );

export const gitlabHostOf = Effect.fn("Config.gitlabHostOf")(function* (env: {
  readonly raw: Readonly<Record<string, string | undefined>>;
  readonly userDir: string;
}) {
  const given = env.raw["GITLAB_HOST"];
  return given !== undefined && isHostName(given)
    ? given
    : (yield* loadDefaults(env.userDir)).gitlabHost;
});

export function autoCompactWindowAsWritten(value: YamlValue | undefined) {
  if (value === undefined) return FALLBACK_DEFAULTS.claudeAutoCompactWindow;
  return isNumber(value) || isString(value) ? value : JSON.stringify(value);
}

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
    idleCloseMs: isNumber(raw.idle_close_ms) ? raw.idle_close_ms : FALLBACK_DEFAULTS.idleCloseMs,
    runModel: raw.run_model !== false,
    memoryHold: isNumber(raw.memory_hold) ? raw.memory_hold : FALLBACK_DEFAULTS.memoryHold,
    compactAtTokens: isNumber(raw.compact_at_tokens)
      ? raw.compact_at_tokens
      : FALLBACK_DEFAULTS.compactAtTokens,
    claudeAutoCompactWindow: autoCompactWindowAsWritten(raw.claude_auto_compact_window),
    models: Option.getOrElse(Schema.decodeUnknownOption(Models)(raw.models), () => ({})),
    fallbacks: Option.getOrElse(
      Schema.decodeUnknownOption(Schema.Array(Schema.String))(raw.fallbacks),
      () => [],
    ),
    trust: raw.trust === "auto" || raw.trust === "never" ? raw.trust : FALLBACK_DEFAULTS.trust,
    permissions: permissionsAsWritten(raw.permissions) ?? FALLBACK_DEFAULTS.permissions,
    scope: isString(raw.scope) && isScope(raw.scope) ? raw.scope : FALLBACK_DEFAULTS.scope,
    density:
      isString(raw.density) && isDensity(raw.density) ? raw.density : FALLBACK_DEFAULTS.density,
    notifications: Option.getOrElse(
      Schema.decodeUnknownOption(Notifications)(raw.notifications),
      () => ({}),
    ),
    questions:
      isString(raw.questions) && isQuestionMode(raw.questions)
        ? raw.questions
        : FALLBACK_DEFAULTS.questions,
    proactive: raw.proactive !== false,
    gitlabHost:
      isString(raw.gitlab_host) && isHostName(raw.gitlab_host)
        ? raw.gitlab_host
        : FALLBACK_DEFAULTS.gitlabHost,
    agentProfile: isString(raw.agent_profile) ? raw.agent_profile : FALLBACK_DEFAULTS.agentProfile,
  };
  if (isString(raw.effort)) defaults.effort = raw.effort;
  return defaults;
});
