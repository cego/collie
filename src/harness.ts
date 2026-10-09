// How to start each supported agent CLI, pass it a model, and inject a Persona.
// Personas are injected, never installed as harness-native config (CONTEXT.md, Persona).

import { Effect, FileSystem, Option, Schema } from "effect";
import type { PluginEnv } from "./env";
import { isString } from "./schema";
import { PERMISSION_MODES } from "./settings";
import { claudeTrust, type Trust } from "./trust";
import { DEFAULT_MODEL, HARNESS_MODELS, type HarnessModels } from "./harness-choice";
import type { YamlValue } from "./yaml";

export {
  DEFAULT_MODEL,
  harnessNames,
  knownModel,
  modelHint,
  preferencesIn,
  ceilingIn,
  foldPreferences,
  resolveChoice,
  foldCeiling,
  chainEntry,
  said,
  resolveWithRoom,
  pinned,
  type Preferences,
  type AgentChoice,
  type Room,
  type Chosen,
} from "./harness-choice";

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

export interface HarnessAdapter extends HarnessModels {
  id: string;
  /** herdr agent kind, i.e. the canonical executable. */
  kind: string;
  modelArgs(model: string): string[];
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
    personaArgs: (file) => ["--append-system-prompt-file", file],
    effortArgs: (effort) => ["--effort", effort],
    permissionArgs: {
      auto: ["--permission-mode", "auto"],
      bypass: ["--permission-mode", "bypassPermissions"],
    },
    bypassForbidden: (env) => claudeForbidsBypass(env.claudeManagedDir),
    trust: claudeTrust,
    ...HARNESS_MODELS.claude!,
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
    ...HARNESS_MODELS.codex!,
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
    ...HARNESS_MODELS.pi!,
  },
  opencode: {
    id: "opencode",
    kind: "opencode",
    skillCommand: (name) => `the ${JSON.stringify(name)} skill`,
    modelArgs: (model) => ["--model", model],
    // No auto mode: its `--auto` approves every call rather than reviewing it.
    permissionArgs: { bypass: ["--auto"] },
    ...HARNESS_MODELS.opencode!,
  },
};

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
