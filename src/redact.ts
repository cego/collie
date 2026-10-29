// Credential-shaped values, replaced by what kind of credential they looked like before
// anything a human or an agent gave Collie is written or forwarded. One list, for every
// place that does it: chat, cards and the host's front doors.

import * as Struct from "effect/Struct";
import * as Str from "effect/String";
import { pipe } from "effect/Function";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import { isBoolean, isNumber, isString } from "./schema";

/**
 * Shapes that are almost certainly a secret, what to write instead, and what to call it.
 * The kind is kept because it is the useful half — "a GitLab token was in here" is worth
 * reading, and the token itself is worth nothing to anyone who should be reading this.
 *
 * Deliberately over-eager. Text given to Collie is a place people paste things, and a false
 * positive costs a human retyping a word; a false negative writes a live credential into a
 * file that outlives the session.
 */
const SECRETS: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, "<gitlab token>", "<gitlab token>"],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, "<github token>", "<github token>"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "<github token>", "<github token>"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "<api key>", "<api key>"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "<aws key id>", "<aws key id>"],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, "<slack token>", "<slack token>"],
  [/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "<jwt>", "<jwt>"],
  [/\b[Bb]earer\s+[A-Za-z0-9._~+/-]{20,}=*/g, "Bearer <token>", "<bearer token>"],
  // A named assignment whose value looks like a secret rather than like prose.
  [
    /\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY))\s*[=:]\s*\S+/g,
    "$1=<redacted>",
    "<named secret>",
  ],
];

/** Text as it will be written, and the kind of each value taken out of it, in order. */
export interface Scrubbed<A> {
  readonly value: A;
  readonly removed: ReadonlyArray<string>;
}

/** What a front door can be given: JSON, with the fields a caller left out. */
export type Given =
  | string
  | number
  | boolean
  | null
  | undefined
  | ReadonlyArray<Given>
  | { readonly [key: string]: Given };

/** One text as it will be written, and the kind of each value taken out of it. */
export interface ScrubbedText {
  readonly text: string;
  readonly removed: string[];
}

export function scrub(text: string): ScrubbedText {
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

/** The text as it will be written: same words, minus anything that looked like a key. */
export const redact = (text: string): string => scrub(text).text;

/** Every string in a value scrubbed, and the kinds taken out of all of them. */
export function scrubJson<A extends Given>(value: A): Scrubbed<A> {
  const removed: string[] = [];
  const walk = (one: Given): Given => {
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
  // SAFETY: `walk` keeps every key and element and replaces a string only with a string.
  return { value: walk(value) as A, removed };
}

export const CREDENTIALS_DOCS = "docs/using.md#credentials-never-go-in-a-goal-or-a-steer";

/** What a front door says about values it removed, or null where it removed none. */
export const removedNotice = (removed: ReadonlyArray<string>): string | null =>
  removed.length === 0
    ? null
    : `removed ${removed.length} credential-shaped value(s): ${Arr.join([...new Set(removed)], ", ")}. ` +
      `Give an agent a credential through its forge login instead: ${CREDENTIALS_DOCS}`;

/** A front door's words, followed by what was removed where anything was. */
export const withNotice = (
  said: string,
  removed: ReadonlyArray<string> | undefined,
  between = "\n",
): string => {
  const notice = removedNotice(removed ?? []);
  return notice === null ? said : Arr.join(Arr.filter([said, notice], Boolean), between);
};

/** The notice a result's note carries, where it carries one. */
export const removedIn = (note: string): string | null =>
  /removed \d+ credential-shaped value\(s\)[^;]*/.exec(note)?.[0] ?? null;

/** `redacted` for a `--json` envelope, present only where something was taken out. */
export const redactedField = (removed: ReadonlyArray<string> | undefined) =>
  removed === undefined || removed.length === 0 ? {} : { redacted: [...removed] };
