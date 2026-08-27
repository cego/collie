import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Layer } from "../../src/definitions";

export function writeDef(dir: string, kind: "workflows" | "personas", name: string, text: string): string {
  const path = join(dir, kind, `${name}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

export function layerSet(baseline: string, user: string, project: string): Layer[] {
  return [
    { name: "baseline", dir: baseline },
    { name: "user", dir: user },
    { name: "project", dir: project },
  ];
}
