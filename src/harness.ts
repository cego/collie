// How to start each supported agent CLI, pass it a model, and inject a Persona.
// Personas are injected, never installed as harness-native config (docs/SPEC.md).

export interface HarnessAdapter {
  id: string;
  /** herdr agent kind, i.e. the canonical executable. */
  kind: string;
  modelArgs(model: string): string[];
  /** Present when the harness can take a persona as a flag instead of a prompt prefix. */
  personaArgs?(persona: string): string[];
  models: string[];
  modelPattern?: RegExp;
}

export const HARNESSES: Record<string, HarnessAdapter> = {
  claude: {
    id: "claude",
    kind: "claude",
    modelArgs: (model) => ["--model", model],
    personaArgs: (persona) => ["--append-system-prompt", persona],
    models: ["opus", "sonnet", "haiku", "opusplan"],
    modelPattern: /^claude-[a-z0-9.-]+$/,
  },
  codex: {
    id: "codex",
    kind: "codex",
    modelArgs: (model) => ["-m", model],
    models: ["gpt-5-codex", "gpt-5", "gpt-5-mini"],
    modelPattern: /^(?:gpt|o)[0-9][a-z0-9.-]*$/,
  },
  opencode: {
    id: "opencode",
    kind: "opencode",
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
  if (harness.models.includes(model) || extra.includes(model)) return true;
  return harness.modelPattern?.test(model) ?? false;
}

export function modelHint(harness: HarnessAdapter, extra: string[] = []): string {
  const known = [...harness.models, ...extra];
  const parts: string[] = [];
  if (known.length > 0) parts.push(known.join(", "));
  if (harness.modelPattern) parts.push(`or anything matching ${harness.modelPattern.source}`);
  return parts.join(" ");
}

/** Args for `herdr agent start ... -- <args>`. */
export function startArgs(harness: HarnessAdapter, model: string, persona: string): string[] {
  return [...harness.modelArgs(model), ...(harness.personaArgs?.(persona) ?? [])];
}

/** Persona text to prepend to the first prompt when the harness has no flag for it. */
export function personaPrefix(harness: HarnessAdapter, persona: string): string {
  return harness.personaArgs ? "" : persona;
}
