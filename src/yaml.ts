// Minimal YAML subset for definition frontmatter: nested maps, sequences,
// flow maps/sequences, block scalars, quoted and bare scalars. Not a general
// YAML parser — enough for the frontmatter documented in docs/SPEC.md.

import { Data, Schema } from "effect";

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

export class YamlError extends Data.TaggedError("YamlError")<{ message: string }> {}

function yamlError(message: string): YamlError {
  return new YamlError({ message });
}

const isStringMap = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

export function isYamlMap(value: YamlValue | undefined): value is YamlMap {
  return value !== undefined && value !== null && !Array.isArray(value) && isStringMap(value);
}

interface Line {
  indent: number;
  text: string;
  n: number;
}

const KEY = /^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_][A-Za-z0-9_./-]*)\s*:(?:[ \t]+(.*))?$/;

function stripComment(raw: string): string {
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "#" && (i === 0 || raw[i - 1] === " " || raw[i - 1] === "\t")) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

function toLines(src: string): Line[] {
  const out: Line[] = [];
  src.split(/\r?\n/).forEach((raw, i) => {
    const text = stripComment(raw).trimEnd();
    if (!text.trim()) return;
    out.push({ indent: raw.length - raw.trimStart().length, text: text.trim(), n: i + 1 });
  });
  return out;
}

function isSeqItem(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

export function parseYaml(src: string): YamlValue {
  const ls = toLines(src);
  if (ls.length === 0) return {};
  const [value] = parseNode(ls, 0, ls[0]!.indent);
  return value;
}

function parseNode(ls: Line[], i: number, indent: number): [YamlValue, number] {
  return isSeqItem(ls[i]!.text) ? parseSeq(ls, i, indent) : parseMap(ls, i, indent);
}

function parseSeq(ls: Line[], i: number, indent: number): [YamlValue[], number] {
  const out: YamlValue[] = [];
  while (i < ls.length && ls[i]!.indent === indent && isSeqItem(ls[i]!.text)) {
    const rest = ls[i]!.text === "-" ? "" : ls[i]!.text.slice(2).trim();
    if (rest === "") {
      if (i + 1 < ls.length && ls[i + 1]!.indent > indent) {
        const [v, ni] = parseNode(ls, i + 1, ls[i + 1]!.indent);
        out.push(v);
        i = ni;
      } else {
        out.push(null);
        i += 1;
      }
      continue;
    }
    if (KEY.test(rest)) {
      // An item that starts a map on the dash line: its keys sit two columns in.
      const tail = ls.slice(i + 1);
      const itemIndent = tail.length > 0 && tail[0]!.indent > indent ? tail[0]!.indent : indent + 2;
      const sub: Line[] = [{ indent: itemIndent, text: rest, n: ls[i]!.n }, ...tail];
      const [v, ni] = parseMap(sub, 0, itemIndent);
      out.push(v);
      i += ni;
      continue;
    }
    out.push(parseScalar(rest, ls[i]!.n));
    i += 1;
  }
  return [out, i];
}

function parseMap(ls: Line[], i: number, indent: number): [YamlMap, number] {
  const out: YamlMap = {};
  while (i < ls.length && ls[i]!.indent === indent) {
    const m = KEY.exec(ls[i]!.text);
    if (!m) throw yamlError(`line ${ls[i]!.n}: expected "key: value", got "${ls[i]!.text}"`);
    const key = unquote(m[1]!);
    const rest = (m[2] ?? "").trim();
    if (rest === "|" || rest === "|-" || rest === ">" || rest === ">-") {
      const [v, ni] = parseBlockScalar(ls, i + 1, indent, rest);
      out[key] = v;
      i = ni;
    } else if (rest === "") {
      if (i + 1 < ls.length && ls[i + 1]!.indent > indent) {
        const [v, ni] = parseNode(ls, i + 1, ls[i + 1]!.indent);
        out[key] = v;
        i = ni;
      } else if (i + 1 < ls.length && ls[i + 1]!.indent === indent && isSeqItem(ls[i + 1]!.text)) {
        const [v, ni] = parseSeq(ls, i + 1, indent);
        out[key] = v;
        i = ni;
      } else {
        out[key] = null;
        i += 1;
      }
    } else {
      out[key] = parseScalar(rest, ls[i]!.n);
      i += 1;
    }
  }
  return [out, i];
}

function parseBlockScalar(ls: Line[], i: number, indent: number, style: string): [string, number] {
  const parts: string[] = [];
  while (i < ls.length && ls[i]!.indent > indent) {
    parts.push(ls[i]!.text);
    i += 1;
  }
  const joined = style.startsWith(">") ? parts.join(" ") : parts.join("\n");
  return [style.endsWith("-") ? joined : `${joined}\n`, i];
}

function unquote(raw: string): string {
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length > 1) {
    return raw.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length > 1) return raw.slice(1, -1);
  return raw;
}

function parseScalar(raw: string, line: number): YamlValue {
  if (raw.startsWith("{") || raw.startsWith("[")) return parseFlow(raw, line);
  if (raw === "null" || raw === "~") return null;
  if (raw === "true" || raw === "yes") return true;
  if (raw === "false" || raw === "no") return false;
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10);
  if (/^-?\d*\.\d+$/.test(raw)) return Number.parseFloat(raw);
  return unquote(raw);
}

function parseFlow(raw: string, line: number): YamlValue {
  const s = { text: raw, i: 0, line };
  const value = readFlowValue(s);
  skipSpace(s);
  if (s.i < s.text.length) throw yamlError(`line ${line}: trailing text in "${raw}"`);
  return value;
}

interface Cursor {
  text: string;
  i: number;
  line: number;
}

function skipSpace(s: Cursor) {
  while (s.i < s.text.length && /\s/.test(s.text[s.i]!)) s.i += 1;
}

function readFlowValue(s: Cursor): YamlValue {
  skipSpace(s);
  const c = s.text[s.i];
  if (c === "{") return readFlowMap(s);
  if (c === "[") return readFlowSeq(s);
  return parseScalar(readFlowToken(s), s.line);
}

function readFlowToken(s: Cursor): string {
  skipSpace(s);
  const start = s.i;
  let quote: string | null = null;
  while (s.i < s.text.length) {
    const c = s.text[s.i]!;
    if (quote) {
      if (c === "\\") s.i += 1;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "," || c === "}" || c === "]") {
      break;
    }
    s.i += 1;
  }
  return s.text.slice(start, s.i).trim();
}

function readFlowMap(s: Cursor): YamlMap {
  s.i += 1;
  const out: YamlMap = {};
  for (;;) {
    skipSpace(s);
    if (s.text[s.i] === "}") {
      s.i += 1;
      return out;
    }
    const token = readFlowToken(s);
    const colon = token.indexOf(":");
    if (colon < 0) throw yamlError(`line ${s.line}: expected "key: value" in flow map`);
    out[unquote(token.slice(0, colon).trim())] = parseScalar(token.slice(colon + 1).trim(), s.line);
    skipSpace(s);
    if (s.text[s.i] === ",") s.i += 1;
    else if (s.text[s.i] !== "}") throw yamlError(`line ${s.line}: unterminated flow map`);
  }
}

function readFlowSeq(s: Cursor): YamlValue[] {
  s.i += 1;
  const out: YamlValue[] = [];
  for (;;) {
    skipSpace(s);
    if (s.text[s.i] === "]") {
      s.i += 1;
      return out;
    }
    out.push(readFlowValue(s));
    skipSpace(s);
    if (s.text[s.i] === ",") s.i += 1;
    else if (s.text[s.i] !== "]") throw yamlError(`line ${s.line}: unterminated flow sequence`);
  }
}

export interface Document {
  data: YamlMap;
  body: string;
}

/** Splits `---` frontmatter from the markdown body. */
export function parseDocument(text: string): Document {
  const normalised = text.replace(/^﻿/, "");
  const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(normalised);
  if (!m) return { data: {}, body: normalised.trim() };
  const data = parseYaml(m[1]!);
  if (!isYamlMap(data)) throw yamlError("frontmatter must be a mapping");
  return {
    data,
    body: normalised.slice(m[0].length).trim(),
  };
}
