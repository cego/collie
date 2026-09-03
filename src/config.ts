// User defaults from the plugin config dir. Optional; the baseline is neutral.

import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { isNumber, isString } from "./schema";
import { isYamlMap, YamlMapSchema, type YamlMap, type YamlValue } from "./yaml";

export interface Defaults {
  harness: string;
  model: string;
  /** Reasoning effort for every step that does not name its own; unset means the harness decides. */
  effort?: string;
  maxIterations: number;
  /** How long a Step may wait for the human after the agent hands off. */
  handoffTimeoutMs: number;
  /**
   * How long an agent may produce nothing before it is nudged. Nudged again at
   * double, given up on at triple. `0` waits for as long as it takes.
   */
  quietMs: number;
  /** Extra models to accept per harness, for models the adapter table does not list. */
  models: Readonly<Record<string, ReadonlyArray<string>>>;
  /** What to do about a directory the harness has not been trusted with yet. */
  trust: "ask" | "auto" | "never";
  /** `notifications.<kind>: false` turns that kind of toast off; absent means on. */
  notifications: Readonly<Record<string, boolean>>;
}

export const FALLBACK_DEFAULTS: Defaults = {
  harness: "claude",
  model: "opus",
  maxIterations: 5,
  handoffTimeoutMs: 2 * 60 * 60 * 1000,
  quietMs: 10 * 60 * 1000,
  models: {},
  trust: "ask",
  notifications: {},
};

const ConfigJson = Schema.fromJsonString(YamlMapSchema);
const Models = Schema.Record(Schema.String, Schema.Array(Schema.String));
const Notifications = Schema.Record(Schema.String, Schema.Boolean);

/** The whole config file, for values only a prompt cares about (e.g. linear.team). */
export const readConfig = Effect.fn("Config.readConfig")(function* (configDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const path = paths.join(configDir, "config.json");
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
  configDir: string,
  dotted: string,
  value: string | number | null,
) {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const raw = yield* readConfig(configDir);
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
  yield* fs.makeDirectory(configDir, { recursive: true });
  yield* fs.writeFileString(
    paths.join(configDir, "config.json"),
    `${Schema.encodeSync(ConfigJson)(raw)}\n`,
  );
});

export const loadDefaults = Effect.fn("Config.loadDefaults")(function* (configDir: string) {
  const raw = yield* readConfig(configDir);
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
    models: Option.getOrElse(Schema.decodeUnknownOption(Models)(raw.models), () => ({})),
    trust: raw.trust === "auto" || raw.trust === "never" ? raw.trust : FALLBACK_DEFAULTS.trust,
    notifications: Option.getOrElse(
      Schema.decodeUnknownOption(Notifications)(raw.notifications),
      () => ({}),
    ),
  };
  if (isString(raw.effort)) defaults.effort = raw.effort;
  return defaults;
});
