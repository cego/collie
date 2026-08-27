// User defaults from the plugin config dir. Optional; the baseline is neutral.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Defaults {
  harness: string;
  model: string;
  maxIterations: number;
  /** Extra models to accept per harness, for models the adapter table does not list. */
  models: Record<string, string[]>;
}

export const FALLBACK_DEFAULTS: Defaults = {
  harness: "claude",
  model: "sonnet",
  maxIterations: 5,
  models: {},
};

export function loadDefaults(configDir: string): Defaults {
  const path = join(configDir, "config.json");
  if (!existsSync(path)) return { ...FALLBACK_DEFAULTS };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`${path}: ${(e as Error).message}`);
  }
  return {
    harness: typeof raw.harness === "string" ? raw.harness : FALLBACK_DEFAULTS.harness,
    model: typeof raw.model === "string" ? raw.model : FALLBACK_DEFAULTS.model,
    maxIterations:
      typeof raw.max_iterations === "number" ? raw.max_iterations : FALLBACK_DEFAULTS.maxIterations,
    models: (raw.models ?? {}) as Record<string, string[]>,
  };
}
