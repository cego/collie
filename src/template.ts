// {{a.b}} substitution for prompt bodies. Unknown keys render empty and are
// reported so a typo in a definition is visible instead of silent.

import { Schema } from "effect";
import { isYamlMap, type YamlMap, type YamlValue } from "./yaml";

export interface Rendered {
  text: string;
  missing: string[];
}

export interface RenderOptions {
  /**
   * How this harness is asked for a skill. Bodies name skills by name — the syntax
   * is the harness's business, not the definition's.
   */
  skill?: (name: string) => string;
}

/** Every skill a body asks for, in the order it asks. */
export function skillsIn(text: string): string[] {
  const names: string[] = [];
  for (const [, name] of text.matchAll(SKILL)) if (name && !names.includes(name)) names.push(name);
  return names;
}

const SKILL = /\{\{\s*skill:\s*([A-Za-z0-9_-]+)\s*\}\}/g;

export function renderTemplate(text: string, vars: YamlMap, opts: RenderOptions = {}): Rendered {
  const missing: string[] = [];
  // Skills first, so `{{skill:x}}` is never mistaken for a missing variable.
  const withSkills = text.replace(SKILL, (all, name: string) =>
    opts.skill ? opts.skill(name) : all,
  );
  const out = withSkills.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_all, path: string) => {
    const value = lookup(vars, path.split("."));
    if (value === undefined || value === null) {
      if (!missing.includes(path)) missing.push(path);
      return "";
    }
    return isText(value) ? value : JSON.stringify(value, null, 2);
  });
  return { text: out, missing };
}

function lookup(vars: YamlMap, path: string[]): YamlValue | undefined {
  let node: YamlValue = vars;
  for (const key of path) {
    if (!isYamlMap(node)) return undefined;
    const next: YamlValue | undefined = node[key];
    if (next === undefined) return undefined;
    node = next;
  }
  return node;
}

const isText = Schema.is(Schema.String);

export function slugify(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "run";
}
