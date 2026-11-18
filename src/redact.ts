import * as Struct from "effect/Struct";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import { isBoolean, isNumber, isString } from "./schema";

const SECRETS: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, "<gitlab token>", "<gitlab token>"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "<github token>", "<github token>"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "<github token>", "<github token>"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "<api key>", "<api key>"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "<aws key id>", "<aws key id>"],
  [/\b(?:xoxe\.)?xox[abposre]-[A-Za-z0-9-]{10,}/g, "<slack token>", "<slack token>"],
  [/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "<jwt>", "<jwt>"],
  [/\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*/g, "Bearer <token>", "<bearer token>"],
  [
    /\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY))\s*[=:]\s*\S+/g,
    "$1=<redacted>",
    "<named secret>",
  ],
];

export interface Scrubbed<A> {
  readonly value: A;
  readonly removed: ReadonlyArray<string>;
}

export type Given =
  | string
  | number
  | boolean
  | null
  | undefined
  | ReadonlyArray<Given>
  | { readonly [key: string]: Given };

export interface ScrubbedText {
  readonly text: string;
  readonly removed: string[];
}

export function scrub(text: string) {
  const removed: string[] = [];
  let out = text;
  for (const [looksLike, replacement, kind] of SECRETS)
    // oxlint-disable-next-line effecttsgo/prefer-effect-string -- This replacement depends on each match; Effect String accepts only string replacements.
    out = out.replace(looksLike, (...match) => {
      removed.push(kind);
      return pipe(replacement, Str.replace("$1", String(match[1])));
    });
  return { text: out, removed };
}

export const redact = (text: string) => scrub(text).text;

export function scrubJson<A extends Given>(value: A) {
  const removed: string[] = [];
  const walk: (one: Given) => Given = (one) => {
    if (isString(one)) {
      const done = scrub(one);
      removed.push(...done.removed);
      return done.text;
    }
    if (one === null || one === undefined || isNumber(one) || isBoolean(one)) return one;
    if (Arr.isArray<typeof one>(one)) return Arr.map(one, walk);
    return Rec.fromEntries(
      Arr.map(
        Arr.map(Struct.keys(one), (key) => [key, one[key]] as const),
        ([key, inner]) => [key, walk(inner)] as const,
      ),
    );
  };
  // WARNING: `walk` keeps every key and element and replaces a string only with a string.
  return { value: walk(value) as A, removed };
}

export const CREDENTIALS_DOCS = "docs/using.md#credentials-never-go-in-a-goal-or-a-steer";

export const removedNotice = (removed: ReadonlyArray<string>) =>
  removed.length === 0
    ? null
    : `removed ${removed.length} credential-shaped value(s): ${Arr.join([...new Set(removed)], ", ")}. ` +
      `Give an agent a credential through its forge login instead: ${CREDENTIALS_DOCS}`;

export const withNotice = (
  said: string,
  removed: ReadonlyArray<string> | undefined,
  between = "\n",
) => {
  const notice = removedNotice(removed ?? []);
  return notice === null ? said : Arr.join(Arr.filter([said, notice], Boolean), between);
};

export const removedIn = (note: string) =>
  /removed \d+ credential-shaped value\(s\)[^;]*/.exec(note)?.[0] ?? null;

export const redactedField = (removed: ReadonlyArray<string> | undefined) =>
  removed === undefined || removed.length === 0 ? {} : { redacted: [...removed] };
