// How to start each supported agent CLI, pass it a model, and inject a Persona.
// Personas are injected, never installed as harness-native config (CONTEXT.md, Persona).

import { isString } from "./schema";
import { claudeTrust, type Trust } from "./trust";
import type { YamlValue } from "./yaml";

/**
 * The harness adapter's pinned default model. Adapters without one still omit the flag.
 */
export const DEFAULT_MODEL = "default";

/**
 * Who decides whether a tool call runs: Collie up front (`bypass`), or the harness in
 * the agent's own pane (`harness`). `bypass` is the default because a prompt nobody is
 * watching stops the Run instead of protecting it. What backs that up is narrower than
 * it looks: only a mutating Run gets a checkout of its own (`worktree.ts`, MUTATING), so
 * a `plan` or `review` agent works in the checkout the human started it from.
 */
export const PERMISSION_MODES = ["bypass", "harness"] as const;

export type PermissionMode = (typeof PERMISSION_MODES)[number];

const PERMISSION_MODE_SET: ReadonlySet<string> = new Set(PERMISSION_MODES);

export function isPermissionMode(value: string | undefined): value is PermissionMode {
  return value !== undefined && PERMISSION_MODE_SET.has(value);
}

/**
 * A `permissions` value from a config file or a definition's frontmatter, as written —
 * kept even when it is not a string. Every neighbouring key drops a non-string and falls
 * back, which is harmless when the fallback is the default harness or model. Here the
 * fallback is `bypass`, so a dropped `permissions: false` would start an agent
 * unattended; kept as text, validation names it instead.
 */
export function permissionsAsWritten(value: YamlValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  return isString(value) ? value : JSON.stringify(value);
}

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
   * How this harness is told to stop asking before each tool call. Absent where the
   * harness never asks, so `bypass` and `harness` start it identically.
   */
  permissionArgs?(): string[];
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
    permissionArgs: () => ["--permission-mode", "bypassPermissions"],
    trust: claudeTrust,
    models: ["opus", "sonnet", "haiku", "opusplan"],
    modelPattern: /^claude-[a-z0-9.-]+$/,
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  codex: {
    id: "codex",
    kind: "codex",
    skillCommand: (name) => `the ${JSON.stringify(name)} skill`,
    modelArgs: (model) => ["-m", model],
    permissionArgs: () => ["--dangerously-bypass-approvals-and-sandbox"],
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
    permissionArgs: () => ["--auto"],
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
  permissions: PermissionMode = "bypass",
): string[] {
  const selectedModel = model === DEFAULT_MODEL ? harness.defaultModel : model;
  return [
    ...(selectedModel ? harness.modelArgs(selectedModel) : []),
    ...(effort ? (harness.effortArgs?.(effort) ?? []) : []),
    ...(harness.personaArgs?.(personaFile) ?? []),
    ...(permissions === "bypass" ? (harness.permissionArgs?.() ?? []) : []),
  ];
}

/** Persona text to prepend to the first prompt when the harness has no flag for it. */
export function personaPrefix(harness: HarnessAdapter, persona: string): string {
  return harness.personaArgs ? "" : persona;
}
