// How to start each supported agent CLI, pass it a model, and inject a Persona.
// Personas are injected, never installed as harness-native config (CONTEXT.md, Persona).

import { Effect, FileSystem, Option, Schema } from "effect";
import type { PluginEnv } from "./env";
import { isString } from "./schema";
import { PERMISSION_MODES } from "./settings";
import { claudeTrust, type Trust } from "./trust";
import type { YamlValue } from "./yaml";

/**
 * The harness adapter's pinned default model. Adapters without one still omit the flag.
 */
export const DEFAULT_MODEL = "default";

export type PermissionMode = (typeof PERMISSION_MODES)[number];

const PERMISSION_MODE_SET: ReadonlySet<string> = new Set(PERMISSION_MODES);

export function isPermissionMode(value: string | undefined): value is PermissionMode {
  return value !== undefined && PERMISSION_MODE_SET.has(value);
}

/**
 * A `permissions` value from a config file or a definition's frontmatter, as written —
 * kept even when it is not a string. Every neighbouring key drops a non-string and falls
 * back, which is harmless when the fallback is the default harness or model. Here the
 * fallback is `auto`, so a dropped `permissions: false` would start an agent that
 * approves its own calls; kept as text, validation names it instead.
 */
export function permissionsAsWritten(value: YamlValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  return isString(value) ? value : JSON.stringify(value);
}

const ManagedSettingsJson = Schema.fromJsonString(
  Schema.Struct({
    permissions: Schema.optional(
      Schema.Struct({ disableBypassPermissionsMode: Schema.optional(Schema.String) }),
    ),
  }),
);

/**
 * Whether Claude Code's managed settings — an organisation's, which no flag overrides —
 * disable its bypass mode, in the file itself or any file in its drop-in directory.
 */
export const claudeForbidsBypass = Effect.fn("Harness.claudeForbidsBypass")(function* (
  dir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const dropIns = yield* fs
    .readDirectory(`${dir}/managed-settings.d`)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const files = [
    `${dir}/managed-settings.json`,
    ...dropIns
      .filter((name) => name.endsWith(".json"))
      .map((name) => `${dir}/managed-settings.d/${name}`),
  ];
  for (const file of files) {
    const text = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
    const settings = Schema.decodeUnknownOption(ManagedSettingsJson)(text);
    if (
      Option.isSome(settings) &&
      settings.value.permissions?.disableBypassPermissionsMode === "disable"
    )
      return true;
  }
  return false;
});

export interface HarnessAdapter {
  id: string;
  /** herdr agent kind, i.e. the canonical executable. */
  kind: string;
  modelArgs(model: string): string[];
  /** Pinned model used when a Definition says `default`; absent keeps the harness native default. */
  defaultModel?: string;
  /**
   * Present when the harness takes a persona file as a flag. herdr rejects agent
   * arguments it cannot encode for the shell, so this takes a path, not the text.
   */
  personaArgs?(personaFile: string): string[];
  /** Present when the harness lets a Step ask for a reasoning effort level. */
  effortArgs?(effort: string): string[];
  /**
   * How this harness is told to review its own tool calls rather than ask (`auto`), or to
   * run them unasked (`bypass`). A mode left out starts it as `harness` does.
   */
  permissionArgs?: {
    readonly auto?: ReadonlyArray<string>;
    readonly bypass?: ReadonlyArray<string>;
  };
  /**
   * Present where an organisation's managed settings can forbid the bypass switch, which
   * no flag overrides. A bypass they forbid is started in auto mode instead.
   */
  bypassForbidden?(env: PluginEnv): Effect.Effect<boolean, never, FileSystem.FileSystem>;
  /** Present when the harness asks before it will work in a directory. */
  trust?(home: string, backupDir: string): Trust;
  /**
   * What the human channel types to *start* a skill in this harness. The skills
   * themselves are shared — `~/.agents/skills`, installed by skills.sh — so only the
   * syntax differs, and a harness with no slash form is asked for it in words. This
   * is not for mentioning a skill inside a prompt: nothing expands a slash command in
   * a file a model is handed. `skillMention` is the mention.
   */
  skillCommand(name: string): string;
  /**
   * What to check first when this harness stops producing output. Unset where nobody
   * has seen one hang: an invented hint is worse than none.
   */
  stuckHint?: string;
  models: string[];
  modelPattern?: RegExp;
  efforts?: string[];
}

export interface Harnesses {
  readonly [name: string]: HarnessAdapter;
}

export const HARNESSES: Harnesses = {
  claude: {
    id: "claude",
    kind: "claude",
    skillCommand: (name) => `/${name}`,
    stuckHint:
      "check your background shells with `/bashes`, read or kill any that will not finish (`BashOutput`, `KillShell`), and continue from there.",
    modelArgs: (model) => ["--model", model],
    defaultModel: "opus",
    personaArgs: (file) => ["--append-system-prompt-file", file],
    effortArgs: (effort) => ["--effort", effort],
    permissionArgs: {
      auto: ["--permission-mode", "auto"],
      bypass: ["--permission-mode", "bypassPermissions"],
    },
    bypassForbidden: (env) => claudeForbidsBypass(env.claudeManagedDir),
    trust: claudeTrust,
    models: ["fable", "opus", "sonnet", "haiku", "opusplan"],
    modelPattern: /^claude-[a-z0-9.-]+$/,
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  codex: {
    id: "codex",
    kind: "codex",
    skillCommand: (name) => `the ${JSON.stringify(name)} skill`,
    modelArgs: (model) => ["-m", model],
    permissionArgs: {
      auto: ["--approve-for-me"],
      bypass: ["--dangerously-bypass-approvals-and-sandbox"],
    },
    models: ["gpt-5-codex", "gpt-5", "gpt-5-mini"],
    modelPattern: /^(?:gpt|o)[0-9][a-z0-9.-]*$/,
  },
  pi: {
    id: "pi",
    kind: "pi",
    skillCommand: (name) => `/skill:${name}`,
    modelArgs: (model) => ["--model", model],
    // pi reads a path here as file contents, so the persona file can be passed directly.
    personaArgs: (file) => ["--append-system-prompt", file],
    effortArgs: (effort) => ["--thinking", effort],
    // No permissionArgs: pi has no tool-approval prompt, and its `--approve` only
    // trusts project-local files (`pi --help`, checked 2026-09-03).
    // pi models are provider-qualified (`openai-codex/gpt-5.6-sol`), so the shape is the check.
    models: [],
    modelPattern: /^[a-z0-9-]+\/[A-Za-z0-9._:-]+$/,
    efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  },
  opencode: {
    id: "opencode",
    kind: "opencode",
    skillCommand: (name) => `the ${JSON.stringify(name)} skill`,
    modelArgs: (model) => ["--model", model],
    // No auto mode: its `--auto` approves every call rather than reviewing it.
    permissionArgs: { bypass: ["--auto"] },
    // opencode models are provider-qualified, so the shape is the check.
    models: [],
    modelPattern: /^[a-z0-9-]+\/[A-Za-z0-9._:-]+$/,
  },
};

export function harnessNames(): string[] {
  return Object.keys(HARNESSES).sort();
}

export function knownModel(
  harness: HarnessAdapter,
  model: string,
  extra: ReadonlyArray<string> = [],
): boolean {
  if (model === DEFAULT_MODEL) return true;
  if (harness.models.includes(model) || extra.includes(model)) return true;
  return harness.modelPattern?.test(model) ?? false;
}

export function modelHint(harness: HarnessAdapter, extra: ReadonlyArray<string> = []): string {
  const known = [DEFAULT_MODEL, ...harness.models, ...extra];
  const parts: string[] = [];
  if (known.length > 0) parts.push(known.join(", "));
  if (harness.modelPattern) parts.push(`or anything matching ${harness.modelPattern.source}`);
  return parts.join(" ");
}

/** Args for `herdr agent start ... -- <args>`. */
export function startArgs(
  harness: HarnessAdapter,
  model: string,
  personaFile: string,
  effort?: string,
  permissions: PermissionMode = "auto",
): string[] {
  const selectedModel = model === DEFAULT_MODEL ? harness.defaultModel : model;
  return [
    ...(selectedModel ? harness.modelArgs(selectedModel) : []),
    ...(effort ? (harness.effortArgs?.(effort) ?? []) : []),
    ...(harness.personaArgs?.(personaFile) ?? []),
    ...(permissions === "harness" ? [] : (harness.permissionArgs?.[permissions] ?? [])),
  ];
}

/** Persona text to prepend to the first prompt when the harness has no flag for it. */
export function personaPrefix(harness: HarnessAdapter, persona: string): string {
  return harness.personaArgs ? "" : persona;
}

/** What a layer of configuration or code says about the agent; each field it leaves out is inherited. */
export interface Preferences {
  readonly harness?: string;
  readonly model?: string;
  readonly effort?: string;
  /** Past this share of its busiest window, 1–100, this agent is not chosen for new work. */
  readonly upTo?: number;
  /** What to try past `upTo` or once Exhausted, in order, before the human's chain. */
  readonly otherwise?: ReadonlyArray<Preferences>;
}

/** The harness, model and effort a set of options names, and nothing else of it. */
export const preferencesIn = (options: {
  readonly harness?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
}): Preferences =>
  Object.fromEntries(
    Object.entries({
      harness: options.harness,
      model: options.model,
      effort: options.effort,
    }).filter(([, value]) => value !== undefined),
  );

/** A preference as code gives it: `preferencesIn`'s fields, with its ceiling where it has one. */
export const ceilingIn = (options: Preferences): Preferences => {
  const ceiling: { -readonly [K in keyof Preferences]: Preferences[K] } = preferencesIn(options);
  if (options.upTo !== undefined) ceiling.upTo = options.upTo;
  if (options.otherwise !== undefined) ceiling.otherwise = options.otherwise;
  return ceiling;
};

/** The agent a piece of work is given, decided before anything starts it. */
export interface AgentChoice {
  readonly harness: string;
  /** `default` is the harness's own pinned or native default. */
  readonly model: string;
  readonly effort: string | null;
}

/**
 * Layers of preferences as one, lowest first. A layer that switches harness keeps nothing
 * chosen below it: a model and an effort are for the harness they were chosen with.
 */
export function foldPreferences(
  layers: ReadonlyArray<Preferences | undefined>,
): Pick<Preferences, "harness" | "model" | "effort"> {
  let harness: string | undefined;
  let model: string | undefined;
  let effort: string | undefined;
  for (const layer of layers) {
    if (layer === undefined) continue;
    if (layer.harness !== undefined && layer.harness !== harness) {
      harness = layer.harness;
      model = undefined;
      effort = undefined;
    }
    model = layer.model ?? model;
    effort = layer.effort ?? effort;
  }
  return Object.fromEntries(
    Object.entries({ harness, model, effort }).filter(([, value]) => value !== undefined),
  );
}

/**
 * Harness, model and effort decided together, lowest layer first, and checked as one.
 * What is left open is the harness's own default; a combination the harness does not take
 * is refused with what it would take, never quietly replaced.
 */
export function resolveChoice(
  layers: ReadonlyArray<Preferences | undefined>,
  extraModels: Readonly<Record<string, ReadonlyArray<string>>> = {},
):
  | { readonly ok: true; readonly choice: AgentChoice }
  | { readonly ok: false; readonly problem: string } {
  const { harness = "", model = DEFAULT_MODEL, effort } = foldPreferences(layers);
  const adapter = HARNESSES[harness];
  if (adapter === undefined) {
    return { ok: false, problem: `no harness called "${harness}" (${harnessNames().join(", ")})` };
  }
  const extra = extraModels[harness] ?? [];
  if (!knownModel(adapter, model, extra)) {
    return {
      ok: false,
      problem: `"${model}" is not a model ${harness} takes (${modelHint(adapter, extra)}): name one of those, or the harness it belongs to`,
    };
  }
  if (effort !== undefined && adapter.efforts === undefined) {
    return {
      ok: false,
      problem: `${harness} takes no effort, so "${effort}" cannot be asked of it`,
    };
  }
  if (effort !== undefined && !adapter.efforts?.includes(effort)) {
    return {
      ok: false,
      problem: `"${effort}" is not an effort ${harness} takes (${adapter.efforts?.join(", ")})`,
    };
  }
  return { ok: true, choice: { harness, model, effort: effort ?? null } };
}

/**
 * The ceiling layers set, lowest first: the nearest layer that names `upTo` or `otherwise`
 * sets both, and a layer that switches harness clears both.
 */
export function foldCeiling(layers: ReadonlyArray<Preferences | undefined>): Preferences {
  let harness: string | undefined;
  let ceiling: Preferences = {};
  for (const layer of layers) {
    if (layer === undefined) continue;
    if (layer.harness !== undefined && layer.harness !== harness) {
      harness = layer.harness;
      ceiling = {};
    }
    if (layer.upTo !== undefined || layer.otherwise !== undefined) {
      const { upTo, otherwise } = layer;
      ceiling =
        upTo === undefined
          ? { otherwise }
          : otherwise === undefined
            ? { upTo }
            : { upTo, otherwise };
    }
  }
  return ceiling;
}

/** A `fallbacks` entry: `harness`, or `harness/model` split at the first `/`. */
export function chainEntry(text: string): Preferences {
  const at = text.indexOf("/");
  return at === -1 ? { harness: text } : { harness: text.slice(0, at), model: text.slice(at + 1) };
}

/** Whether a choice has room under a ceiling, and why not where it has none. */
export type Room = (
  choice: AgentChoice,
  upTo: number | undefined,
) => { readonly room: true } | { readonly room: false; readonly why: string };

export const said = (choice: AgentChoice) =>
  `${choice.harness}/${choice.model}${choice.effort === null ? "" : ` ${choice.effort}`}`;

export interface Chosen {
  readonly choice: AgentChoice;
  /** The folded choice this fell back from, where it did. */
  readonly from: AgentChoice | null;
  readonly why: string | null;
  /** Chain entries that do not resolve, each with why. */
  readonly skipped: ReadonlyArray<string>;
}

/**
 * The folded choice, else the first of its `otherwise` entries, else the first of the
 * chain, that has room (ADR-0049 D7). A bad folded or `otherwise` choice is refused; a bad
 * chain entry is skipped. Where nothing has room, the folded choice, saying why.
 */
export function resolveWithRoom(
  layers: ReadonlyArray<Preferences | undefined>,
  chain: ReadonlyArray<string>,
  room: Room,
  extraModels: Readonly<Record<string, ReadonlyArray<string>>> = {},
):
  | { readonly ok: true; readonly chosen: Chosen }
  | { readonly ok: false; readonly problem: string } {
  const primary = resolveChoice(layers, extraModels);
  if (!primary.ok) return primary;
  const folded = primary.choice;
  const ceiling = foldCeiling(layers);
  const outOfRange = [ceiling.upTo, ...(ceiling.otherwise ?? []).map(({ upTo }) => upTo)].find(
    (upTo) => upTo !== undefined && !(upTo >= 1 && upTo <= 100),
  );
  if (outOfRange !== undefined)
    return { ok: false, problem: `upTo is a percentage from 1 to 100, not ${outOfRange}` };
  const base = { harness: folded.harness, model: folded.model, effort: folded.effort ?? undefined };
  const candidates: Array<{ readonly choice: AgentChoice; readonly upTo?: number }> = [
    { choice: folded, upTo: ceiling.upTo },
  ];
  for (const [at, entry] of (ceiling.otherwise ?? []).entries()) {
    const next = resolveChoice([base, preferencesIn(entry)], extraModels);
    if (!next.ok) return { ok: false, problem: `otherwise entry ${at + 1}: ${next.problem}` };
    candidates.push({ choice: next.choice, upTo: entry.upTo });
  }
  const skipped: string[] = [];
  for (const text of chain) {
    const entry = chainEntry(text);
    const takes = HARNESSES[entry.harness ?? ""]?.efforts?.includes(folded.effort ?? "") ?? false;
    const next = resolveChoice(
      [entry, takes && folded.effort !== null ? { effort: folded.effort } : undefined],
      extraModels,
    );
    if (next.ok) candidates.push({ choice: next.choice });
    else skipped.push(`fallback ${text} skipped: ${next.problem}`);
  }
  const whys: string[] = [];
  let first: string | null = null;
  for (const { choice, upTo } of candidates) {
    const judged = room(pinned(choice), upTo);
    if (judged.room) {
      const fell = choice !== folded;
      return {
        ok: true,
        chosen: { choice, from: fell ? folded : null, why: fell ? first : null, skipped },
      };
    }
    first ??= judged.why;
    whys.push(`${said(choice)}: ${judged.why}`);
  }
  return {
    ok: true,
    chosen: {
      choice: folded,
      from: null,
      why: `nothing has room; ${[...new Set(whys)].join("; ")}`,
      skipped,
    },
  };
}

/** The model a choice runs, so `default` is judged as the model it pins. */
export const pinned = (choice: AgentChoice): AgentChoice =>
  choice.model === DEFAULT_MODEL
    ? { ...choice, model: HARNESSES[choice.harness]?.defaultModel ?? DEFAULT_MODEL }
    : choice;
