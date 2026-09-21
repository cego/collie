// Frontmatter YAML for definition files. Parsing is Effect's YAML 1.2 config parser;
// what lives here is the frontmatter split, the value schemas, and the write-back used
// when forking a definition.

import { Data, Schema } from "effect";
import * as Yaml from "effect/unstable/encoding/Yaml";

export type YamlScalar = string | number | boolean | null;
export type YamlValue = YamlScalar | YamlMap | ReadonlyArray<YamlValue>;
export interface YamlMap {
  [key: string]: YamlValue;
}

export const YamlValueSchema: Schema.Codec<YamlValue> = Schema.suspend(() =>
  Schema.Union([
    Schema.String,
    Schema.Number,
    Schema.Boolean,
    Schema.Null,
    Schema.Array(YamlValueSchema),
    YamlMapSchema,
  ]),
);
export const YamlMapSchema: Schema.Codec<YamlMap> = Schema.Record(Schema.String, YamlValueSchema);
export const YamlValueJsonSchema = Schema.fromJsonString(YamlValueSchema);

export class YamlError extends Data.TaggedError("YamlError")<{ message: string }> {}

const isStringMap = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

export function isYamlMap(value: YamlValue | undefined): value is YamlMap {
  return value !== undefined && value !== null && !Array.isArray(value) && isStringMap(value);
}

const KEY = /^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_][A-Za-z0-9_./-]*)\s*:(?:[ \t]+(.*))?$/;

/**
 * Parses one YAML document. An empty document is null, as YAML defines it.
 *
 * Close to YAML 1.2's core schema rather than conformant to it: `.inf` and `.nan` come
 * back as null, and `1_000` as 1000, which core does not do. Frontmatter uses none of
 * those, and this is the parser's behaviour rather than a promise we make.
 */
export function parseYaml(src: string): YamlValue {
  let parsed: YamlValue;
  try {
    // SAFETY: the parser yields nulls, booleans, numbers and strings in maps and
    // sequences, which is exactly YamlValue.
    parsed = Yaml.parse(src) as YamlValue;
  } catch (cause) {
    throw new YamlError({ message: cause instanceof Error ? cause.message : String(cause) });
  }
  return parsed;
}

const BARE = /^[A-Za-z0-9_](?:[A-Za-z0-9_./ -]*[A-Za-z0-9_./-])?$/;

/**
 * A string written back into frontmatter: bare where it reads back unchanged, quoted
 * otherwise. BARE rules out the punctuation that changes the line's meaning; the round
 * trip through the parser rules out the words that are not strings (`true`, `5`, `~`).
 */
export function yamlScalar(value: string): string {
  return BARE.test(value) && parseYaml(value) === value ? value : JSON.stringify(value);
}

function unquote(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length > 1) {
    return raw.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length > 1) return raw.slice(1, -1);
  return raw;
}

/**
 * Writes `key: value` into the document's frontmatter: over the line that already sets that
 * key, or at the top of the block, or into a new block when the document has none. The
 * value goes in as a scalar the parser reads back unchanged — a definition edited this way
 * is one the loader still agrees with.
 *
 * It finds the block by scanning lines rather than by parsing, because a fork has to keep
 * the file's own formatting and comments. FENCE is what keeps that second reading honest:
 * a line only closes the block where `parseDocument` would also end it, so a `---` inside
 * a block scalar cannot hide an existing key and get a duplicate written above it.
 */
export function setFrontmatterKey(text: string, key: string, value: string): string {
  const lines = text.split("\n");
  const written = `${key}: ${yamlScalar(value)}`;
  if (!FENCE.test(withoutBom(lines[0] ?? ""))) return `---\n${written}\n---\n\n${text}`;
  const close = lines.findIndex((line, i) => i > 0 && FENCE.test(line));
  const end = close < 0 ? lines.length : close;
  const at = lines.findIndex((line, i) => i > 0 && i < end && topLevelKey(line) === key);
  if (at < 0) lines.splice(1, 0, written);
  else lines[at] = written;
  return lines.join("\n");
}

/** The key a frontmatter line sets, or null for anything nested or not a mapping. */
function topLevelKey(line: string): string | null {
  if (/^\s/.test(line)) return null;
  const m = KEY.exec(line.trim());
  return m ? unquote(m[1]!) : null;
}

export interface Document {
  data: YamlMap;
  body: string;
}

/**
 * The `---` fence, as `parseDocument` reads it: column 0, blanks allowed after it. Shared
 * with `setFrontmatterKey` so the two agree on where a document's frontmatter ends.
 */
const FENCE = /^---[ \t]*\r?$/;

function withoutBom(line: string): string {
  return line.replace(/^﻿/, "");
}

/** Splits `---` frontmatter from the markdown body. */
export function parseDocument(text: string): Document {
  const normalised = withoutBom(text);
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(normalised);
  if (!m) return { data: {}, body: normalised.trim() };
  const parsed = parseYaml(m[1]!);
  // A block that is empty or nothing but comments parses to null. For a document that is
  // frontmatter setting no keys, not frontmatter that failed to be a mapping.
  const data = parsed === null ? {} : parsed;
  if (!isYamlMap(data)) throw new YamlError({ message: "frontmatter must be a mapping" });
  return {
    data,
    body: normalised.slice(m[0].length).trim(),
  };
}
