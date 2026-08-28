// User defaults from the plugin config dir. Optional; the baseline is neutral.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Defaults {
  harness: string;
  model: string;
  /** Reasoning effort for every step that does not name its own; unset means the harness decides. */
  effort?: string;
  maxIterations: number;
  /** How long a Step may wait for the human after the agent hands off. */
  handoffTimeoutMs: number;
  /** Extra models to accept per harness, for models the adapter table does not list. */
  models: Record<string, string[]>;
  /** What to do about a directory the harness has not been trusted with yet. */
  trust: "ask" | "auto" | "never";
}

export const FALLBACK_DEFAULTS: Defaults = {
  harness: "claude",
  model: "sonnet",
  maxIterations: 5,
  handoffTimeoutMs: 2 * 60 * 60 * 1000,
  models: {},
  trust: "ask",
};

/** The whole config file, for values only a prompt cares about (e.g. linear.team). */
export function readConfig(configDir: string): Record<string, unknown> {
  const path = join(configDir, "config.json");
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
}

export function configValue(raw: Record<string, unknown>, dotted: string): unknown {
  let node: unknown = raw;
  for (const key of dotted.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** Remembers an answer the human gave once, e.g. which Linear team is theirs. */
export function writeConfigValue(configDir: string, dotted: string, value: string): void {
  const raw = readConfig(configDir);
  const keys = dotted.split(".");
  let node = raw;
  for (const key of keys.slice(0, -1)) {
    const next = node[key];
    node[key] = next !== null && typeof next === "object" ? next : {};
    node = node[key] as Record<string, unknown>;
  }
  node[keys.at(-1)!] = value;
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), `${JSON.stringify(raw, null, 2)}\n`);
}

export function loadDefaults(configDir: string): Defaults {
  const path = join(configDir, "config.json");
  if (!existsSync(path)) return { ...FALLBACK_DEFAULTS };
  const raw = readConfig(configDir);
  return {
    harness: typeof raw.harness === "string" ? raw.harness : FALLBACK_DEFAULTS.harness,
    model: typeof raw.model === "string" ? raw.model : FALLBACK_DEFAULTS.model,
    ...(typeof raw.effort === "string" ? { effort: raw.effort } : {}),
    maxIterations:
      typeof raw.max_iterations === "number" ? raw.max_iterations : FALLBACK_DEFAULTS.maxIterations,
    handoffTimeoutMs:
      typeof raw.handoff_timeout_ms === "number"
        ? raw.handoff_timeout_ms
        : FALLBACK_DEFAULTS.handoffTimeoutMs,
    models: (raw.models ?? {}) as Record<string, string[]>,
    trust:
      raw.trust === "auto" || raw.trust === "never" ? raw.trust : FALLBACK_DEFAULTS.trust,
  };
}
