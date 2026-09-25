// User defaults from the plugin config dir. Optional; the baseline is neutral.

import { Effect, FileSystem, Option, Path, Schema } from "effect";
import { COMPACT_AT_TOKENS } from "./compaction";
import { permissionsAsWritten } from "./harness";
import { isNumber, isString } from "./schema";
import { isYamlMap, YamlMapSchema, type YamlMap, type YamlValue } from "./yaml";

/**
 * What the Control Plane's Runs view is a board of: `local` is this Session's own
 * workspace, the board as it has always been; `all` is every workspace of this herdr
 * session that Collie has work in. Here rather than in the board, because it is a
 * default a human sets and every other reader takes the type from `Defaults`.
 */
export type Scope = "local" | "all";

/** How many cards the board fits across. A Setting, and the pane's width overrules it. */
export type Density = "comfortable" | "compact";
export const DENSITIES: ReadonlyArray<Density> = ["comfortable", "compact"];
export function isDensity(value: string): value is Density {
  return DENSITIES.some((density) => density === value);
}
export const SCOPES: ReadonlyArray<Scope> = ["local", "all"];
export function isScope(value: string): value is Scope {
  return SCOPES.some((scope) => scope === value);
}

/**
 * How a Run's question reaches the human. `focus` brings the Session's Collie tab to
 * the front the moment a Choice opens — the behavior every install has had. `notify`
 * leaves the toast and the board's own `asks you` alone but takes no focus, so a
 * question arriving mid-thought does not move the human off what they are doing.
 */
export type Questions = "focus" | "notify";
export const QUESTION_MODES: ReadonlyArray<Questions> = ["focus", "notify"];
export function isQuestionMode(value: string): value is Questions {
  return QUESTION_MODES.some((mode) => mode === value);
}

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
  /**
   * How long a running run's directory may go unchanged before the board calls it quiet.
   * Separate from `quietMs`, which is what the Driver holds one step's agent to: this is
   * a whole run writing nothing, read from the outside, and the two are worth different
   * numbers.
   */
  boardQuietMs: number;
  /**
   * Current-context tokens at or above which a reused agent is asked to compact before
   * it is given its next piece of work. `0` turns the feature off. As written rather
   * than coerced: the fallback would be the default, so a value someone meant as a
   * lower limit would silently compact an agent they had tried to leave alone.
   */
  compactAtTokens: number;
  /** Extra models to accept per harness, for models the adapter table does not list. */
  models: Readonly<Record<string, ReadonlyArray<string>>>;
  /** What to do about a directory the harness has not been trusted with yet. */
  trust: "auto" | "never";
  /**
   * Whether the harness reviews an agent's tool calls itself, or asks in its pane. As
   * written, like `harness` and `model`: validation names an unknown one, and the engine
   * starts an agent it cannot resolve in `auto`, the default.
   */
  permissions: string;
  /** Which scope the Control Plane opens on. `g` changes it for that tab only. */
  scope: Scope;
  /** How many cards the board fits across, where the pane is wide enough for a choice. */
  density: Density;
  /** `notifications.<kind>: false` turns that kind of toast off; absent means on. */
  notifications: Readonly<Record<string, boolean>>;
  /** Whether a new question takes the human's focus, or only says so. */
  questions: Questions;
  /**
   * Whether Collie starts a turn of its own when something meaningful happens — a Run
   * stopping, asking, going round, or claiming to be finished without proving it. On by
   * default: a conversation you have to start every time is polling by hand.
   *
   * It changes what is *said*, never what may be *done*: a proposal from a proactive
   * turn goes through the same authority path as one you typed.
   */
  proactive: boolean;
}

export const FALLBACK_DEFAULTS: Defaults = {
  harness: "claude",
  model: "opus",
  maxIterations: 5,
  handoffTimeoutMs: 2 * 60 * 60 * 1000,
  quietMs: 10 * 60 * 1000,
  boardQuietMs: 5 * 60 * 1000,
  compactAtTokens: COMPACT_AT_TOKENS,
  models: {},
  trust: "auto",
  permissions: "auto",
  scope: "local",
  density: "comfortable",
  notifications: {},
  questions: "focus",
  proactive: true,
};

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
  value: string | number | null,
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
  };
  if (isString(raw.effort)) defaults.effort = raw.effort;
  return defaults;
});
