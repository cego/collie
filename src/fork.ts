// Forking: copy a baseline definition into a later Layer so it can be edited
// without touching the team baseline.

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";

export type DefinitionKind = "workflows" | "personas";

export interface ForkResult {
  ok: boolean;
  path: string;
  message: string;
}

/** Never overwrites: an existing fork is the one you already edited. */
export function forkDefinition(source: string, kind: DefinitionKind, targetDir: string): ForkResult {
  const dir = join(targetDir, kind);
  const path = join(dir, basename(source));

  if (path === source) {
    return { ok: false, path, message: `${basename(source)} is already in that layer` };
  }
  if (existsSync(path)) {
    return { ok: false, path, message: `${path} already exists — edit it instead` };
  }

  mkdirSync(dir, { recursive: true });
  copyFileSync(source, path);
  return { ok: true, path, message: `copied to ${path}` };
}
