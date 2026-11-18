import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Option from "effect/Option";
import { Data, Schema } from "effect";
import * as Yaml from "effect/encoding/Yaml";

export type YamlScalar = string | number | boolean | null;
export type YamlValue = YamlScalar | YamlMap | ReadonlyArray<YamlValue>;
export interface YamlMap {
  [key: string]: YamlValue;
}

export const YamlValueSchema: Schema.Codec<YamlValue> = Schema.suspend(() =>
  Schema.Union([
    Schema.String,
    Schema.Finite,
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
  return value !== undefined && value !== null && !Arr.isArray(value) && isStringMap(value);
}

const KEY = /^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_][A-Za-z0-9_./-]*)\s*:(?:[ \t]+(.*))?$/;

export function parseYaml(src: string) {
  let parsed: YamlValue;
  try {
    // WARNING: the parser yields nulls, booleans, numbers and strings in maps and sequences, which is exactly YamlValue.
    parsed = Yaml.parse(src) as YamlValue;
  } catch (cause) {
    throw new YamlError({ message: cause instanceof Error ? cause.message : String(cause) });
  }
  return parsed;
}

const BARE = /^[A-Za-z0-9_](?:[A-Za-z0-9_./ -]*[A-Za-z0-9_./-])?$/;

export function yamlScalar(value: string) {
  return BARE.test(value) && parseYaml(value) === value ? value : JSON.stringify(value);
}

function unquote(raw: string) {
  if (pipe(raw, Str.startsWith('"')) && pipe(raw, Str.endsWith('"')) && raw.length > 1) {
    return pipe(raw, Str.slice(1, -1), Str.replace(/\\(.)/g, "$1"));
  }
  if (pipe(raw, Str.startsWith("'")) && pipe(raw, Str.endsWith("'")) && raw.length > 1)
    return pipe(raw, Str.slice(1, -1));
  return raw;
}

export function setFrontmatterKey(text: string, key: string, value: string) {
  const lines = Str.split(text, "\n");
  const written = `${key}: ${yamlScalar(value)}`;
  if (!FENCE.test(withoutBom(lines[0] ?? ""))) return `---\n${written}\n---\n\n${text}`;
  const close = Option.getOrElse(
    Arr.findFirstIndex(lines, (line, i) => i > 0 && FENCE.test(line)),
    () => -1,
  );
  const end = close < 0 ? lines.length : close;
  const at = Option.getOrElse(
    Arr.findFirstIndex(lines, (line, i) => i > 0 && i < end && topLevelKey(line) === key),
    () => -1,
  );
  if (at < 0) lines.splice(1, 0, written);
  else lines[at] = written;
  return Arr.join(lines, "\n");
}

function topLevelKey(line: string) {
  if (/^\s/.test(line)) return null;
  const m = KEY.exec(Str.trim(line));
  return m ? unquote(m[1]!) : null;
}

export interface Document {
  data: YamlMap;
  body: string;
}

const FENCE = /^---[ \t]*\r?$/;

function withoutBom(line: string) {
  return pipe(line, Str.replace(/^﻿/, ""));
}

export function parseDocument(text: string) {
  const normalised = withoutBom(text);
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(normalised);
  if (!m) return { data: {}, body: Str.trim(normalised) };
  const parsed = parseYaml(m[1]!);
  const data = parsed === null ? {} : parsed;
  if (!isYamlMap(data)) throw new YamlError({ message: "frontmatter must be a mapping" });
  return {
    data,
    body: Str.trim(pipe(normalised, Str.slice(m[0].length))),
  };
}
