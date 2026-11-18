import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import { Schema } from "effect";
import { isYamlMap, type YamlMap, type YamlValue } from "./yaml";
import { stringifyJson } from "./json";

export interface Rendered {
  text: string;
  missing: string[];
}

export interface RenderOptions {
  skill?: (name: string) => string;
}

export function skillMention(skills: ReadonlyMap<string, string>) {
  const returned: (name: string) => string = (name) => {
    const file = skills.get(name);
    return file
      ? `the \`${name}\` skill (read \`${file}\` and follow it)`
      : `the \`${name}\` skill (not installed here)`;
  };
  return returned;
}

export function mentionedSkills(text: string) {
  return Arr.dedupe(Arr.map(Arr.fromIterable(Str.matchAll(MENTION)(text)), ([, name]) => name!));
}

const MENTION = /the `([A-Za-z0-9_-]+)` skill \((?:read|not installed)/g;

export function skillsIn(text: string) {
  const names: string[] = [];
  for (const [, name] of pipe(text, Str.matchAll(SKILL)))
    if (name && !names.includes(name)) names.push(name);
  return names;
}

const SKILL = /\{\{\s*skill:\s*([A-Za-z0-9_-]+)\s*\}\}/g;
const EXPRESSION = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;
const BRACES = /\{\{[^}]*\}\}/g;

export function expressionsIn(text: string) {
  const names: string[] = [];
  for (const [, name] of pipe(text, Str.replace(SKILL, ""), Str.matchAll(EXPRESSION)))
    if (name && !names.includes(name)) names.push(name);
  return names;
}

export function malformedIn(text: string) {
  return Arr.map(
    [...pipe(text, Str.replace(SKILL, ""), Str.replace(EXPRESSION, ""), Str.matchAll(BRACES))],
    ([all]) => all,
  );
}

const NOT_GIVEN = "not given";

export function renderTemplate(text: string, input: YamlMap, opts: RenderOptions = {}) {
  const missing: string[] = [];
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- This replacement depends on each match; Effect String accepts only string replacements.
  const withSkills = text.replace(SKILL, (all, name: string) =>
    opts.skill ? opts.skill(name) : all,
  );
  // oxlint-disable-next-line effecttsgo/prefer-effect-string -- This replacement depends on each match; Effect String accepts only string replacements.
  const out = withSkills.replace(EXPRESSION, (_all, path: string) => {
    const value = lookup(input, Str.split(path, "."));
    if (value === undefined || value === null) {
      if (!missing.includes(path)) missing.push(path);
      return "";
    }
    if (value === "" && pipe(path, Str.startsWith("inputs."))) return NOT_GIVEN;
    return isText(value) ? value : stringifyJson(value, 2);
  });
  return { text: out, missing };
}

function lookup(input: YamlMap, path: string[]) {
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

export function slugify(text: string, max = 40) {
  return slug(text, max).slug;
}

export function slug(text: string, max = 40) {
  const full = pipe(
    Str.toLowerCase(text),
    Str.replace(/[^a-z0-9]+/g, "-"),
    Str.replace(/^-+|-+$/g, ""),
  );
  const cut = pipe(full, Str.slice(0, max), Str.replace(/-+$/g, ""));
  return { slug: cut || "run", clipped: cut !== full || cut === "" };
}
