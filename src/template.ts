// {{a.b}} substitution for prompt bodies. Unknown keys render empty and are reported, and
// the caller refuses a body that reported any.

import { Schema } from "effect";
import { isYamlMap, type YamlMap, type YamlValue } from "./yaml";

export interface Rendered {
  text: string;
  missing: string[];
}

export interface RenderOptions {
  /** How `{{skill:name}}` is rendered; `skillMention` is what the engine passes. */
  skill?: (name: string) => string;
}

/**
 * How a body mentions a skill: its name and the file to read. Nothing expands a
 * slash command inside a prompt or a system-prompt file, so a mention is a path —
 * which makes it the same for every harness. The map is `name → SKILL.md`.
 */
export function skillMention(skills: ReadonlyMap<string, string>): (name: string) => string {
  return (name) => {
    const file = skills.get(name);
    return file
      ? `the \`${name}\` skill (read \`${file}\` and follow it)`
      : `the \`${name}\` skill (not installed here)`;
  };
}

/** Every skill a body asks for, in the order it asks. */
export function skillsIn(text: string): string[] {
  const names: string[] = [];
  for (const [, name] of text.matchAll(SKILL)) if (name && !names.includes(name)) names.push(name);
  return names;
}

const SKILL = /\{\{\s*skill:\s*([A-Za-z0-9_-]+)\s*\}\}/g;
const EXPRESSION = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;
const BRACES = /\{\{[^}]*\}\}/g;

/** Every name a body looks up, skills aside, in the order it first names them. */
export function expressionsIn(text: string): string[] {
  const names: string[] = [];
  for (const [, name] of text.replace(SKILL, "").matchAll(EXPRESSION))
    if (name && !names.includes(name)) names.push(name);
  return names;
}

/** Every `{{…}}` that is neither a skill nor a name to look up: nothing would fill it. */
export function malformedIn(text: string): string[] {
  return [...text.replace(SKILL, "").replace(EXPRESSION, "").matchAll(BRACES)].map(([all]) => all);
}

export function renderTemplate(text: string, input: YamlMap, opts: RenderOptions = {}): Rendered {
  const missing: string[] = [];
  // Skills first, so `{{skill:x}}` is never mistaken for missing input.
  const withSkills = text.replace(SKILL, (all, name: string) =>
    opts.skill ? opts.skill(name) : all,
  );
  const out = withSkills.replace(EXPRESSION, (_all, path: string) => {
    const value = lookup(input, path.split("."));
    if (value === undefined || value === null) {
      if (!missing.includes(path)) missing.push(path);
      return "";
    }
    return isText(value) ? value : JSON.stringify(value, null, 2);
  });
  return { text: out, missing };
}

function lookup(input: YamlMap, path: string[]): YamlValue | undefined {
  let node: YamlValue = input;
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
  return slug(text, max).slug;
}

/**
 * A slug, and whether the length cap cut it short. A clipped slug is a label, never an
 * identity: two long texts that share a prefix — every plan directory under one
 * `tasks/` path — clip to the same slug, and anything keyed by it then collides.
 */
export function slug(text: string, max = 40) {
  const full = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const cut = full.slice(0, max).replace(/-+$/g, "");
  // The fallback name counts as clipped: it stands for the text rather than coming out
  // of it, so two texts with nothing alphanumeric between them would share it.
  return { slug: cut || "run", clipped: cut !== full || cut === "" };
}
