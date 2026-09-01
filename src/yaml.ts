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
export const YamlValueJsonSchema = Schema.fromJsonString(YamlValueSchema);

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

let sourceLines: string[] = [];

function isSeqItem(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

export function parseYaml(src: string): YamlValue {
  // Block scalars are the one construct that needs the source as written — blank lines,
  // inner indent and hashes and all — so the parse keeps it here rather than threading
  // it through every level. Parsing is synchronous, so there is only ever one.
  sourceLines = src.split(/\r?\n/);
  const ls = toLines(src);
  if (ls.length === 0) return {};
  const [value, end] = parseNode(ls, 0, ls[0]!.indent);
  // A line the parse stopped short of is a stray indent, and these files are hand
  // edited: truncating the definition silently is how a workflow loses its last steps.
  if (end < ls.length) {
    throw yamlError(`line ${ls[end]!.n}: unexpected indent, "${ls[end]!.text}" fits no block`);
  }
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
      const [v, ni] = parseBlockScalar(ls, i + 1, indent, rest, ls[i]!.n);
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

/**
 * The block runs from the line after the key to the first line indented no deeper than the
 * key, and it is read from the source: `ls` has already dropped the blank lines and the
 * `#` lines that inside a block scalar are content like any other.
 */
function parseBlockScalar(
  ls: Line[],
  i: number,
  indent: number,
  style: string,
  keyLine: number,
): [string, number] {
  const block: string[] = [];
  let source = keyLine;
  for (; source < sourceLines.length; source++) {
    const line = sourceLines[source]!;
    if (line.trim() !== "" && line.length - line.trimStart().length <= indent) break;
    block.push(line);
  }
  while (block.at(-1)?.trim() === "") block.pop();
  // YAML takes the block's own indent from its first non-empty line; everything deeper
  // than that is the content's own indentation and stays.
  const first = block.find((line) => line.trim() !== "") ?? "";
  const blockIndent = first.length - first.trimStart().length;
  const lines = block.map((line) => (line.trim() === "" ? "" : line.slice(blockIndent).trimEnd()));
  // Lines skip the blanks and comment lines the block just took, so step the cursor on by
  // source line number rather than by count.
  while (i < ls.length && ls[i]!.n <= source) i += 1;
  const joined = style.startsWith(">") ? folded(lines) : lines.join("\n");
  return [style.endsWith("-") ? joined : `${joined}\n`, i];
}

/** Folded style joins each paragraph onto one line and keeps the break between paragraphs. */
function folded(lines: ReadonlyArray<string>): string {
  const paragraphs: string[][] = [[]];
  for (const line of lines) {
    if (line === "") paragraphs.push([]);
    else paragraphs.at(-1)!.push(line);
  }
  return paragraphs
    .filter((p) => p.length > 0)
    .map((p) => p.join(" "))
    .join("\n");
}

const BARE = /^[A-Za-z0-9_](?:[A-Za-z0-9_./ -]*[A-Za-z0-9_./-])?$/;

/**
 * A string written back into frontmatter: bare where it reads back unchanged, quoted
 * otherwise. BARE rules out the punctuation that changes the line's meaning; the round
 * trip through parseScalar rules out the words that are not strings (`true`, `5`, `~`).
 */
export function yamlScalar(value: string): string {
  return BARE.test(value) && parseScalar(value, 0) === value ? value : JSON.stringify(value);
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

/**
 * Writes `key: value` into the document's frontmatter: over the line that already sets that
 * key, or at the top of the block, or into a new block when the document has none. The
 * value goes in as a scalar the parser reads back unchanged — a definition edited this way
 * is one the loader still agrees with.
 */
export function setFrontmatterKey(text: string, key: string, value: string): string {
  const lines = text.split("\n");
  const written = `${key}: ${yamlScalar(value)}`;
  if (lines[0]?.trim() !== "---") return `---\n${written}\n---\n\n${text}`;
  const close = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
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
