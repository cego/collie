// How to start each supported agent CLI, pass it a model, and inject a Persona.
// Personas are injected, never installed as harness-native config (docs/SPEC.md).

import { claudeTrust, type Trust } from "./trust";

/**
 * "Whatever this harness picks on its own." No model flag is passed, so the harness
 * uses its own default rather than one this plugin has to keep in step with it.
 */
export const DEFAULT_MODEL = "default";

export interface HarnessAdapter {
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
  /** Present when the harness asks before it will work in a directory. */
  trust?(home: string, backupDir: string): Trust;
  /**
   * How this harness is asked for a skill. The skills themselves are shared —
   * `~/.agents/skills`, installed by skills.sh — so only the syntax differs, and a
   * harness with no slash form is asked for it in words.
   */
  skillRef(name: string): string;
  models: string[];
  modelPattern?: RegExp;
  efforts?: string[];
}

export const HARNESSES: Record<string, HarnessAdapter> = {
  claude: {
    id: "claude",
    kind: "claude",
    skillRef: (name) => `/${name}`,
    modelArgs: (model) => ["--model", model],
    personaArgs: (file) => ["--append-system-prompt-file", file],
    effortArgs: (effort) => ["--effort", effort],
    trust: claudeTrust,
    models: ["opus", "sonnet", "haiku", "opusplan"],
    modelPattern: /^claude-[a-z0-9.-]+$/,
    efforts: ["low", "medium", "high", "xhigh", "max"],
  },
  codex: {
    id: "codex",
    kind: "codex",
    skillRef: (name) => `the ${JSON.stringify(name)} skill`,
    modelArgs: (model) => ["-m", model],
    models: ["gpt-5-codex", "gpt-5", "gpt-5-mini"],
    modelPattern: /^(?:gpt|o)[0-9][a-z0-9.-]*$/,
  },
  pi: {
    id: "pi",
    kind: "pi",
    skillRef: (name) => `/skill:${name}`,
    modelArgs: (model) => ["--model", model],
    // pi reads a path here as file contents, so the persona file can be passed directly.
    personaArgs: (file) => ["--append-system-prompt", file],
    effortArgs: (effort) => ["--thinking", effort],
    // pi models are provider-qualified (`openai-codex/gpt-5.6-sol`), so the shape is the check.
    models: [],
    modelPattern: /^[a-z0-9-]+\/[A-Za-z0-9._:-]+$/,
    efforts: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  },
  opencode: {
    id: "opencode",
    kind: "opencode",
    skillRef: (name) => `the ${JSON.stringify(name)} skill`,
    modelArgs: (model) => ["--model", model],
    // opencode models are provider-qualified, so the shape is the check.
    models: [],
    modelPattern: /^[a-z0-9-]+\/[A-Za-z0-9._:-]+$/,
  },
};

export function harnessNames(): string[] {
  return Object.keys(HARNESSES).sort();
}

export function knownModel(harness: HarnessAdapter, model: string, extra: string[] = []): boolean {
  if (model === DEFAULT_MODEL) return true;
  if (harness.models.includes(model) || extra.includes(model)) return true;
  return harness.modelPattern?.test(model) ?? false;
}

export function modelHint(harness: HarnessAdapter, extra: string[] = []): string {
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
): string[] {
  return [
    // `default` is the absence of a model flag, which is how a harness is asked for its own.
    ...(model === DEFAULT_MODEL ? [] : harness.modelArgs(model)),
    ...(effort ? (harness.effortArgs?.(effort) ?? []) : []),
    ...(harness.personaArgs?.(personaFile) ?? []),
  ];
}

/** Persona text to prepend to the first prompt when the harness has no flag for it. */
export function personaPrefix(harness: HarnessAdapter, persona: string): string {
  return harness.personaArgs ? "" : persona;
}
